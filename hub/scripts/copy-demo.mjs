/** @file Package only the deterministic PLC service models needed by the isolated hub demo. */
import { copyFile, cp, mkdir } from 'node:fs/promises';

const source = new URL('../../firmware/base/tests/browser/', import.meta.url);
const destination = new URL('../dist/firmware/base/tests/browser/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const file of [
  'ui_test.cjs',
  'hardware_mock.cjs',
  'controllers_mock.cjs',
  'static_assets.cjs',
  'backup_mock.cjs',
  'board_profiles_mock.cjs',
  'meteo_mock.cjs',
  'thermostats_mock.cjs',
  'tanks_mock.cjs',
  'irrigation_mock.cjs',
  'thermostat_policy.cjs',
  'security_mock.cjs',
  'firmware_mock.cjs',
  'simulator-inputs.js',
])
  await copyFile(new URL(file, source), new URL(file, destination));
await cp(
  new URL('../../firmware/base/web/', import.meta.url),
  new URL('../dist/firmware/base/web/', import.meta.url),
  { recursive: true },
);
