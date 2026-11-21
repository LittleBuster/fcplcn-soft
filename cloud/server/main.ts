/** @file FCPLCn own-VPS entry point: PostgreSQL identities and a private hub MQTT uplink. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Product } from '../../hub/shared/types.js';
import { CloudBridge } from './bridge.js';
import { BrokerAdmin } from './broker.js';
import { CloudDatabase } from './db.js';
import { loadCloudConfig } from './config.js';
import { createCloudServer } from './http.js';
import { CloudArtifacts } from './artifacts.js';
import { CloudAuth } from './auth.js';
import { CloudHomes } from './users.js';

async function main(): Promise<void> {
  const config = loadCloudConfig();
  const product = JSON.parse(
    await readFile(new URL('../../config/product.json', import.meta.url), 'utf8'),
  ) as Product;
  const db = new CloudDatabase(config.databaseUrl);
  try {
    await db.migrate();
    const initialAuth = new CloudAuth(db, config.secureCookies, config.setupKey, config.masterKey);
    await initialAuth.initializeDefaultAdmin();
    // Single cloud instance: an unfinished pre-dispatch intent must never be replayed on restart.
    await new CloudHomes(db, initialAuth).recoverPendingAudit();
  } catch (error) {
    await db.close();
    throw error;
  }
  const common = {
    brokerUrl: config.brokerUrl,
    username: config.mqttUsername,
    password: config.mqttPassword,
    ca: config.mqttCa,
    allowInsecureLoopback: config.allowInsecureLoopback,
  };
  const broker = new BrokerAdmin({
    ...common,
    publicBrokerUrl: config.publicBrokerUrl,
    publicCa: config.publicMqttCa,
  });
  const lastStored = new Map<string, number>();
  const bridge = new CloudBridge({
    ...common,
    authorizeHub: async (id) =>
      Boolean(
        (await db.query('SELECT 1 FROM cloud_hubs WHERE id=$1 AND revoked_at IS NULL', [id]))
          .rowCount,
      ),
    onSnapshot: async (id, view) => {
      if (view.snapshot && Date.now() - (lastStored.get(id) || 0) >= 15000) {
        lastStored.set(id, Date.now());
        try {
          await db.query(
            'UPDATE cloud_hubs SET snapshot=$2,snapshot_at=now(),last_seen_at=now() WHERE id=$1 AND revoked_at IS NULL',
            [id, JSON.stringify(view.snapshot)],
          );
        } catch (error) {
          lastStored.delete(id);
          throw error;
        }
      }
    },
  });
  const results = await Promise.allSettled([broker.start(), bridge.start()]);
  if (results.some((result) => result.status === 'rejected'))
    console.error(
      'FCPLCn: облачный MQTT пока недоступен; локальный интерфейс пользователей остаётся доступным.',
    );
  const server = createCloudServer({
    config,
    db,
    product,
    bridge,
    broker,
    artifacts: new CloudArtifacts(config.dataDir, product.name),
    webDir: fileURLToPath(new URL('../../web/', import.meta.url)),
    portalDir: fileURLToPath(new URL('../../portal/', import.meta.url)),
    plcDir: fileURLToPath(new URL('../../plc/', import.meta.url)),
  });
  await (async () => {
    await server.ready;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  })().catch(async (error) => {
    await Promise.all([bridge.stop(), broker.stop()]);
    await db.close();
    throw error;
  });
  console.log(`${product.name} · ${product.fullName} · Облако`);
  console.log(config.publicOrigin);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 12000).unref();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([bridge.stop(), broker.stop()]);
    await db.close();
    clearTimeout(deadline);
  };
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
}
void main().catch(() => {
  console.error(
    'FCPLCn: не удалось запустить облачный сервис. Проверьте настройки и доступность PostgreSQL.',
  );
  process.exitCode = 1;
});
