/** @file Linux hub entrypoint: local web/API service and independent MQTT transport. */
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engine.js';
import type { Product } from '../shared/types.js';
import { engineOptions, loadConfig } from './config.js';
import { LabelStore } from './storage.js';
import { createHubServer } from './http.js';
import { Scenes } from './scenes.js';
import { SceneScheduler } from './scheduler.js';
import { TelegramStore } from './telegram/store.js';
import { TelegramBot } from './telegram/bot.js';
import { HubControl } from './control.js';
import { HubCloudStore } from './cloud/store.js';
import { HubCloud } from './cloud/uplink.js';
import { CloudFirmwareInstaller } from './cloud/firmware.js';
import { CredentialStore } from './credentials.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const product = JSON.parse(
    await readFile(new URL('../config/product.json', import.meta.url), 'utf8'),
  ) as Product;
  const webDir = fileURLToPath(new URL('../web/', import.meta.url));
  await stat(`${webDir}/index.html`);
  const credentials = new CredentialStore(config.dataDir, config.password);
  const store = new LabelStore(config.dataDir);
  const engine = createEngine(
    engineOptions(config, product, {
      labels: store.load(),
      onLabelsChanged: (labels) => store.save(labels),
    }),
  );
  await engine.start();
  let manualBusy = false;
  let scenes: Scenes;
  let scheduler: SceneScheduler;
  try {
    scenes = new Scenes(engine, { directory: config.dataDir, demo: config.mode === 'demo' });
    scheduler = new SceneScheduler(scenes, {
      directory: config.dataDir,
      canRun: () => !manualBusy,
    });
  } catch (error) {
    await engine.stop();
    throw error;
  }
  const telegramStore = new TelegramStore(config.dataDir);
  let controls!: HubControl;
  const telegramBot = new TelegramBot(
    telegramStore,
    {
      snapshot: () => engine.snapshot(),
      scenes: () => scenes.snapshot(),
      command: (deviceId, kind, itemId, value) => controls.command(deviceId, kind, itemId, value),
      runScene: (id) => controls.runScene(id),
    },
    { productName: product.name },
  );
  const telegramView = () => ({ ...telegramStore.snapshot(), status: telegramBot.snapshot() });
  const telegram = {
    snapshot: telegramView,
    update(patch: unknown) {
      telegramStore.update(patch);
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
    clearTimeout(timer);
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
