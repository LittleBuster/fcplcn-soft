/** @file Firmware transfer validates actual ESP app bytes and keeps settings across virtual boot. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceRoute } from '../src/protocol/management.js';
import { createEngine } from '../src/engine.js';
import type { ManagementReply } from '../shared/types.js';

type Data = Record<string, unknown>;
type Result = { status: number; data: Data };
interface Model {
  snapshot(): Data;
  route(method: string, path: string, data?: Data): Result;
  reboot(): void;
  completed: number;
  aborted: number;
}
const require = createRequire(import.meta.url);
const { createFirmwareMock, inspectImage } = require(
  fileURLToPath(new URL('../firmware/base/tests/browser/firmware_mock.cjs', import.meta.url)),
) as { createFirmwareMock(options?: Data): Model; inspectImage(bytes: Buffer): Data };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Build an actual one-segment ESP32-S3 app with descriptor/checksum/appended image hash. */
function image(project = 'FCPLCn'): Buffer {
  const bytes = Buffer.alloc(16_032);
  bytes[0] = 0xe9;
  bytes[1] = 1;
  bytes.writeUInt16LE(9, 12);
  bytes[23] = 1;
  bytes.writeUInt32LE(0x3c000020, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.fill(0x19, 288);
  bytes.writeUInt32LE(0xabcd5432, 32);
  bytes.write('ota-test-v2', 48);
  bytes.write(project, 80);
  createHash('sha256').update('firmware-test-elf').digest().copy(bytes, 176);
  let checksum = 0xef;
  for (const byte of bytes.subarray(32)) checksum ^= byte;
  const padding = Buffer.alloc(16);
  padding[15] = checksum;
  const body = Buffer.concat([bytes, padding]);
  return Buffer.concat([body, createHash('sha256').update(body).digest()]);
}

test('only explicit firmware service routes enter the private management transport', () => {
  assert.equal(serviceRoute('GET', '/firmware'), true);
  for (const action of ['begin', 'chunk', 'finish', 'abort']) {
    assert.equal(serviceRoute('POST', '/firmware/' + action), true);
    assert.equal(serviceRoute('GET', '/firmware/' + action), false);
  }
  assert.equal(serviceRoute('POST', '/firmware'), false);
  assert.equal(serviceRoute('POST', '/firmware/anything'), false);
});

test('virtual OTA accepts a real app layout, rejects merged/wrong-chip/project images and confirms boot identity', () => {
  const model = createFirmwareMock();
  const bytes = image();
  const description = inspectImage(bytes);
  const start = model.route('POST', '/firmware/begin', { size: bytes.length, sha256: sha(bytes) });
  assert.equal(start.status, 200);
  assert.equal(
    model.route('POST', '/firmware/begin', { size: bytes.length, sha256: sha(bytes) }).status,
    409,
  );
  const uploadId = start.data.uploadId;
  for (let offset = 0; offset < bytes.length; offset += 12288) {
    const result = model.route('POST', '/firmware/chunk', {
      uploadId,
      offset,
      data: bytes.subarray(offset, offset + 12288).toString('base64'),
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.received, Math.min(offset + 12288, bytes.length));
  }
  assert.equal(
    model.snapshot().targetImageId,
    description.imageId,
    'Metadata is available before finish, as on the PLC',
  );
  const finish = model.route('POST', '/firmware/finish', { uploadId });
  assert.equal(finish.status, 200);
  assert.equal(finish.data.imageId, description.imageId);
  assert.equal(finish.data.targetPartition, 'ota_1');
  assert.equal(model.snapshot().pendingReboot, true);
  assert.equal(model.route('POST', '/firmware/abort', { uploadId }).status, 409);
  model.reboot();
  assert.equal(model.snapshot().state, 'idle');
  assert.equal(model.snapshot().imageId, finish.data.imageId);
  assert.equal(model.snapshot().runningPartition, finish.data.targetPartition);
  assert.equal(model.completed, 1);
  for (const bad of [
    image('OtherProject'),
    Buffer.alloc(bytes.length),
    (() => {
      const copy = image();
      copy.writeUInt16LE(0, 12);
      return copy;
    })(),
  ]) {
    const trial = createFirmwareMock();
    const accepted = trial.route('POST', '/firmware/begin', { size: bad.length, sha256: sha(bad) });
    assert.equal(
      trial.route('POST', '/firmware/chunk', {
        uploadId: accepted.data.uploadId,
        offset: 0,
        data: bad.subarray(0, 12288).toString('base64'),
      }).status,
      400,
    );
    assert.equal(trial.completed, 0);
    assert.equal(trial.snapshot().runningPartition, 'ota_0');
  }
});

test('damaged images, incomplete/out-of-order blocks, cancellation and abandoned sessions never select the new app', () => {
  let now = 0;
  const model = createFirmwareMock({ now: () => now });
  const bytes = image();
  const begin = () =>
    model.route('POST', '/firmware/begin', { size: bytes.length, sha256: sha(bytes) }).data
      .uploadId;
  let uploadId = begin();
  assert.equal(model.route('POST', '/firmware/finish', { uploadId }).status, 409);
  assert.equal(
    model.route('POST', '/firmware/chunk', {
      uploadId,
      offset: 1,
      data: bytes.subarray(0, 12288).toString('base64'),
    }).status,
    409,
  );
  assert.equal(model.route('POST', '/firmware/abort', { uploadId }).status, 200);
  assert.equal(model.aborted, 1);
  assert.equal(model.snapshot().targetImageId, '');
  uploadId = begin();
  model.route('POST', '/firmware/chunk', {
    uploadId,
    offset: 0,
    data: bytes.subarray(0, 12288).toString('base64'),
  });
  assert.notEqual(model.snapshot().targetImageId, '');
  const originalImage = model.snapshot().imageId;
  model.reboot();
  assert.equal(
    model.snapshot().imageId,
    originalImage,
    'A reboot during a partial upload never installs its descriptor',
  );
  assert.equal(model.snapshot().runningPartition, 'ota_0');
  assert.equal(model.snapshot().targetImageId, '');
  uploadId = begin();
  now = 60001;
  assert.equal(
    model.route('POST', '/firmware/chunk', {
      uploadId,
      offset: 0,
      data: bytes.subarray(0, 12288).toString('base64'),
    }).status,
    409,
  );
  assert.equal(model.snapshot().state, 'error');
  const corrupt = image();
  corrupt[900] ^= 1;
  uploadId = model.route('POST', '/firmware/begin', { size: corrupt.length, sha256: sha(corrupt) })
    .data.uploadId;
  for (let offset = 0; offset < corrupt.length; offset += 12288)
    assert.equal(
      model.route('POST', '/firmware/chunk', {
        uploadId,
        offset,
        data: corrupt.subarray(offset, offset + 12288).toString('base64'),
      }).status,
      200,
    );
  assert.equal(model.route('POST', '/firmware/finish', { uploadId }).status, 400);
  assert.equal(model.completed, 0);
  assert.equal(model.snapshot().runningPartition, 'ota_0');
});

test('hub demonstration uploads the app through private RPC and retains configuration, account and image identity', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-ota-hub-'));
  const engine = createEngine({
    mode: 'demo',
    product: { name: 'FCPLCn', id: 'fcplcn', fullName: 'Future City PLC Next' },
    demoDataDir: directory,
    brokerUrl: 'mqtt://127.0.0.1:1883',
    clientId: 'ota-hub-demo',
    staleAfterMs: 45000,
    commandTimeoutMs: 8000,
    labels: {},
    onLabelsChanged() {},
  });
  await engine.start();
  t.after(async () => {
    await engine.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const id = 'fcplcn-demo-living';
  const service = (path: string, body?: Data) =>
    engine.service!(id, body ? 'POST' : 'GET', path, body);
  const data = (reply: ManagementReply) => reply.data as Data;
  let configuration = data(await service('/config'));
  assert.equal(
    (
      await service('/config', {
        baseRevision: configuration.revision,
        device: { name: 'После OTA' },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await service('/user', {
        username: 'ota-owner',
        currentPassword: '',
        newPassword: 'kept-password',
      })
    ).status,
    200,
  );
  const before = engine.snapshot().devices.find((device) => device.id === id)!.bootId;
  const bytes = image();
  const uploadId = data(
    await service('/firmware/begin', { size: bytes.length, sha256: sha(bytes) }),
  ).uploadId;
  for (let offset = 0; offset < bytes.length; offset += 12288)
    assert.equal(
      (
        await service('/firmware/chunk', {
          uploadId,
          offset,
          data: bytes.subarray(offset, offset + 12288).toString('base64'),
        })
      ).status,
      200,
    );
  const finished = data(await service('/firmware/finish', { uploadId }));
  const deadline = Date.now() + 4000;
  while (engine.snapshot().devices.find((device) => device.id === id)!.bootId === before) {
    assert.ok(Date.now() < deadline, 'Virtual PLC should reboot after the acknowledged finish');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(data(await service('/firmware')).imageId, finished.imageId);
  assert.equal(data(await service('/firmware')).runningPartition, finished.targetPartition);
  configuration = data(await service('/config'));
  assert.equal((configuration.device as Data).name, 'После OTA');
  assert.equal((configuration.user as Data).username, 'ota-owner');
  await engine.stop();
  await engine.start();
  assert.equal(data(await service('/firmware')).imageId, finished.imageId);
  assert.equal(
    (
      await service('/user', {
        username: 'ota-owner',
        currentPassword: 'kept-password',
        newPassword: 'kept-password',
      })
    ).status,
    200,
  );
  assert.equal(
    engine.snapshot().commands.length,
    0,
    'Binary fragments must not enter public history',
  );
});
