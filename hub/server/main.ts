/** @file Linux hub entrypoint: local web/API service and independent MQTT transport. */
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engine.js';
import type { Product } from '../shared/types.js';
import { engineOptions, loadConfig, type HubConfig } from './config.js';
import { LabelStore } from './storage.js';
import { createHubServer } from './http.js';
import { Scenes } from './scenes.js';
import { SceneScheduler } from './scheduler.js';
import { TelegramStore } from './telegram/store.js';
import { PostgresTelegramStore } from './telegram/postgres-store.js';
import { TelegramBot } from './telegram/bot.js';
import { HubControl } from './control.js';
import { HubCloudStore } from './cloud/store.js';
import { HubCloud } from './cloud/uplink.js';
import { CloudFirmwareInstaller } from './cloud/firmware.js';
import { CredentialStore, PostgresCredentialStore } from './credentials.js';
import { HubDatabase } from './database.js';
import { ActivityJournal } from './activity-journal.js';
import { currentActivity } from './activity-context.js';
import {
  MeteoHistoryStore,
  type MeteoHistoryBackend,
  type ReadMeteoHistory,
} from './meteo-history.js';
import { PostgresMeteoHistoryStore } from './meteo-postgres.js';
import { itemName, rows } from '../shared/telegram-controller-status.js';
import { renderMeteoChart } from './meteo-chart.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const product = JSON.parse(
    await readFile(new URL('../config/product.json', import.meta.url), 'utf8'),
  ) as Product;
  const webDir = fileURLToPath(new URL('../web/', import.meta.url));
  await stat(`${webDir}/index.html`);
  if (config.mode === 'mqtt' && !config.databaseUrl)
    throw new Error('Задайте подключение к PostgreSQL хаба через FCPLCN_HUB_DATABASE_URL');
  const database = config.databaseUrl ? new HubDatabase(config.databaseUrl) : undefined;
  let history: MeteoHistoryBackend | undefined;
  let journal: ActivityJournal | undefined;
  try {
    const credentials = database
      ? await PostgresCredentialStore.open(database, config.dataDir, config.password)
      : new CredentialStore(config.dataDir, config.password);
    const telegramStore = database
      ? await PostgresTelegramStore.open(database, config.dataDir)
      : new TelegramStore(config.dataDir);
    if (database) {
      history = await PostgresMeteoHistoryStore.open(database, config.dataDir);
      journal = await ActivityJournal.open(database);
    } else {
      try {
        history = new MeteoHistoryStore(config.dataDir, true);
      } catch {
        console.error('Не удалось открыть демонстрационную историю метеодатчиков.');
      }
    }
    await startHub(config, product, webDir, credentials, telegramStore, history, database, journal);
  } catch (error) {
    try {
      await Promise.all([history?.close(), journal?.close()]);
    } finally {
      await database?.close();
    }
    throw error;
  }
}

async function startHub(
  config: HubConfig,
  product: Product,
  webDir: string,
  credentials: CredentialStore | PostgresCredentialStore,
  telegramStore: TelegramStore | PostgresTelegramStore,
  history?: MeteoHistoryBackend,
  database?: HubDatabase,
  journal?: ActivityJournal,
): Promise<void> {
  const store = new LabelStore(config.dataDir);
  let meteoWriteError = false;
  const engine = createEngine(
    engineOptions(config, product, {
      labels: store.load(),
      onLabelsChanged: (labels) => store.save(labels),
      activity: {
        context: currentActivity,
        ...(journal && {
          commands: journal.commands,
          outages: journal.outages,
          commandStarted: (command) => journal.commandStarted(command),
          commandFinished: (command) => journal.commandFinished(command),
          outageChanged: (outage) => journal.outageChanged(outage),
        }),
      },
      onMeteo: async (id, data, receivedAt) => {
        try {
          await history?.record(id, data, receivedAt);
          meteoWriteError = false;
        } catch {
          if (!meteoWriteError) console.error('Не удалось сохранить показания метеодатчика.');
          meteoWriteError = true;
        }
      },
    }),
  );
  await engine.start();
  if (history instanceof MeteoHistoryStore) {
    try {
      history.seedDemo(engine.snapshot().devices);
    } catch {
      console.error('Не удалось создать демонстрационную историю метеодатчиков.');
    }
  }
  const readMeteoHistory: ReadMeteoHistory = async (deviceId, sensorId, period) => {
    if (!history)
      throw Object.assign(new Error('История метеодатчиков недоступна'), { statusCode: 503 });
    const device = engine.snapshot().devices.find(({ id }) => id === deviceId);
    const sensor = rows(device?.controllers.meteo?.data.items).find(({ id }) => id === sensorId);
    if (!device || !sensor)
      throw Object.assign(new Error('Метеодатчик не найден'), { statusCode: 404 });
    try {
      return {
        deviceName: device.name || device.id,
        sensorName: itemName(sensor),
        period,
        points: await history.read(deviceId, sensorId, period),
      };
    } catch {
      throw Object.assign(new Error('История метеодатчиков недоступна'), { statusCode: 503 });
    }
  };
  let manualBusy = false;
  let scenes: Scenes;
  let scheduler: SceneScheduler;
  try {
    scenes = await Scenes.open(engine, {
      directory: config.dataDir,
      demo: config.mode === 'demo',
      database,
    });
    scheduler = new SceneScheduler(scenes, {
      directory: config.dataDir,
      canRun: () => !manualBusy,
    });
  } catch (error) {
    await engine.stop();
    throw error;
  }
  let controls!: HubControl;
  const telegramBot = new TelegramBot(
    telegramStore,
    {
      snapshot: () => engine.snapshot(),
      scenes: () => scenes.snapshot(),
      command: (deviceId, kind, itemId, value) => controls.command(deviceId, kind, itemId, value),
      runScene: (id, signal) => controls.startScene(id, undefined, signal),
      houseStatus: () => controls.houseSecurity?.snapshot(),
      service: (deviceId, method, path, body) => controls.service(deviceId, method, path, body),
      ...(history && {
        async meteoChart(deviceId, sensorId, period) {
          const data = await readMeteoHistory(deviceId, sensorId, period);
          if (
            !data.points.some((point) => point.temperatureC !== null || point.humidityPct !== null)
          )
            return null;
          return {
            photo: await renderMeteoChart(data),
            caption: `📈 ${data.sensorName} · ${period === 'day' ? '24 часа' : '7 дней'}\nПочасовые средние · ${data.deviceName}`,
          };
        },
      }),
      async setSceneSchedule(id, revision, enabled) {
        await controls.dispatch('PUT', `/scenes/${id}/schedule`, {
          baseRevision: revision,
          enabled,
        });
      },
    },
    { productName: product.name },
  );
  const telegramView = () => ({ ...telegramStore.snapshot(), status: telegramBot.snapshot() });
  const telegram = {
    snapshot: telegramView,
    async update(patch: unknown) {
      await telegramStore.update(patch);
      telegramBot.reload();
      return telegramView();
    },
    test: () => telegramBot.test(),
  };
  controls = new HubControl({
    engine,
    scenes,
    scheduler,
    product,
    mode: config.mode,
    dataDir: config.dataDir,
    telegram,
    onBusy: (busy) => {
      manualBusy = busy;
    },
  });
  const allowInsecureLoopback = process.env.FCPLCN_CLOUD_ALLOW_INSECURE_LOOPBACK === '1';
  const cloudStore = new HubCloudStore(config.dataDir, allowInsecureLoopback);
  const cloud = new HubCloud(cloudStore, controls, { allowInsecureLoopback });
  const firmware = new CloudFirmwareInstaller({
    control: controls,
    origin: () => cloudStore.publicConfig().url,
    hubId: () => cloudStore.publicConfig().hubId,
    isActive: () => cloud.snapshot().status.state === 'online',
    connection: () => cloud.sessionId(),
    dataDir: config.dataDir,
  });
  controls.setFirmware(firmware);
  const server = createHubServer({
    config,
    credentials,
    product,
    engine,
    webDir,
    scenes,
    scheduler,
    control: controls,
    cloud,
    telegram,
    meteoHistory: history ? readMeteoHistory : undefined,
    connectionOutages: journal?.readConnectionOutages.bind(journal),
    onControlReady: (value) => {
      controls = value;
    },
    onManualCommandBusy: (busy) => {
      manualBusy = busy;
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  }).catch(async (error) => {
    await scenes.stop();
    await engine.stop();
    throw error;
  });
  scheduler.start();
  telegramBot.start();
  cloud.start();
  console.log(`${product.name} · ${product.fullName} · Хаб`);
  console.log(
    `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`,
  );
  console.log(
    config.mode === 'demo'
      ? 'Демонстрация: виртуальные PLC, оборудование не подключается.'
      : 'Локальный MQTT. Автономная логика остаётся на PLC.',
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    scheduler.stop();
    controls.close();
    const timer = setTimeout(() => process.exit(1), 10_000).unref();
    await firmware.stop();
    await cloud.stop();
    await telegramBot.stop();
    server.closeAllConnections();
    await Promise.all([
      engine.stop(),
      scenes.stop(),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
    try {
      await Promise.all([history?.close(), journal?.close()]);
    } finally {
      await database?.close();
      clearTimeout(timer);
    }
  };
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Не удалось запустить хаб');
  process.exitCode = 1;
});
