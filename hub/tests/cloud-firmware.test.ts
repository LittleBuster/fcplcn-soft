/** @file Cloud artifact jobs use bounded downloads and the existing LAN OTA without replay. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CloudFirmwareInstaller,
  type CloudFirmwareOptions,
  type FirmwareJob,
} from '../server/cloud/firmware.js';
import { cloudAppImage } from './cloud-fixtures.js';
import type { DispatchResult } from '../server/control.js';
import type { HubSnapshot } from '../shared/types.js';

function fixture(t: TestContext, finish: 'ok' | 'unknown' | 'reject' = 'ok') {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-cloud-ota-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const image = cloudAppImage(32768),
    imageId = image.subarray(176, 208).toString('hex');
  let epoch = 'epoch-one',
    boot = 'boot-one',
    received = 0,
    open = false,
    booted = false,
    held = 0;
  let fetchImage = image,
    changeEpochOnChunk = false;
  const calls: string[] = [];
  const control = {
    snapshot: () =>
      ({
        devices: [
          { id: 'fcplcn-test', online: true, bootId: boot, management: { supported: true } },
        ],
      }) as HubSnapshot,
    overview: () => ({ product: { name: 'FCPLCn' } }) as HubSnapshot,
    holdMaintenance: () => {
      held++;
      let done = false;
      return () => {
        if (!done) {
          held--;
          done = true;
        }
      };
    },
    async service(
      _id: string,
      method: 'GET' | 'POST',
      path: string,
      body?: Record<string, unknown>,
      options?: { maintenance?: boolean },
    ): Promise<DispatchResult> {
      assert.equal(
        options?.maintenance,
        true,
        'Only the reserved installer may write while maintenance is held',
      );
      calls.push(method + ' ' + path);
      if (path === '/firmware' && method === 'GET')
        return {
          status: 200,
          data: booted
            ? { state: 'idle', pendingReboot: false, imageId, runningPartition: 'ota_1' }
            : {
                state: open ? 'receiving' : 'idle',
                targetImageId: imageId,
                targetPartition: 'ota_1',
                received,
              },
        };
      if (path === '/firmware/begin') {
        open = true;
        received = 0;
        return { status: 200, data: { ok: true, uploadId: 'upload-one', chunkSize: 12288 } };
      }
      if (path === '/firmware/chunk') {
        assert.equal(body?.offset, received);
        assert.equal(body?.uploadId, 'upload-one');
        received += Buffer.from(body?.data as string, 'base64').length;
        if (changeEpochOnChunk) epoch = 'epoch-two';
        return { status: 200, data: { ok: true, received } };
      }
      if (path === '/firmware/finish') {
        if (finish === 'reject') return { status: 400, data: { error: 'Бинарник отклонён PLC' } };
        booted = true;
        boot = 'boot-two';
        if (finish === 'unknown')
          return { status: 504, data: { error: 'Ответ потерян', unknown: true } };
        return {
          status: 200,
          data: { ok: true, rebootRequired: true, imageId, targetPartition: 'ota_1' },
        };
      }
      if (path === '/firmware/abort') {
        open = false;
        return { status: 200, data: { ok: true } };
      }
      throw new Error('Unexpected route');
    },
  };
  const options: CloudFirmwareOptions = {
    control,
    origin: () => 'https://cloud.example',
    hubId: () => 'hub-one',
    isActive: () => true,
    connection: () => epoch,
    dataDir: directory,
    request: (async (input, init) => {
      assert.equal(String(input), 'https://cloud.example/api/v1/hub/firmware/' + artifactId);
      assert.equal(init?.redirect, 'error');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer ' + ticket);
      assert.equal((init?.headers as Record<string, string>)['X-FCPLCN-Hub'], 'hub-one');
      return new Response(Uint8Array.from(fetchImage), {
        headers: { 'Content-Length': String(fetchImage.length) },
      });
    }) as typeof fetch,
  };
  const artifactId = randomUUID(),
    ticket = 'T'.repeat(43);
  const body = {
    artifactId,
    ticket,
    size: image.length,
    sha256: createHash('sha256').update(image).digest('hex'),
  };
  return {
    directory,
    options,
    body,
    calls,
    held: () => held,
    corrupt() {
      fetchImage = Buffer.from(image);
      fetchImage[500] ^= 1;
    },
    disconnect() {
      changeEpochOnChunk = true;
    },
  };
}
async function settled(installer: CloudFirmwareInstaller, id: string): Promise<FirmwareJob> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const result = installer.status(id).data as { job: FirmwareJob };
    if (result.job && ['completed', 'failed', 'unknown'].includes(result.job.state)) {
      await installer.stop();
      return result.job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Firmware job did not finish');
}

test('Cloud firmware downloads via the paired origin, installs sequentially and confirms image plus slot', async (t) => {
  const f = fixture(t),
    installer = new CloudFirmwareInstaller(f.options);
  const admitted = installer.start('fcplcn-test', f.body);
  assert.equal(admitted.status, 202);
  assert.equal(f.held(), 1);
  assert.throws(() => installer.start('fcplcn-test', f.body), /уже выполняется/);
  const job = await settled(installer, (admitted.data as { jobId: string }).jobId);
  assert.equal(job.state, 'completed');
  assert.equal(job.progress, 100);
  assert.equal(f.held(), 0);
  assert.equal(f.calls.filter((call) => call.endsWith('/finish')).length, 1);
  assert.ok(f.calls.filter((call) => call.endsWith('/chunk')).length > 1);
  assert.equal(existsSync(join(f.directory, 'cloud-ota', job.id + '.bin')), false);
});

test('A corrupted cached binary never opens a PLC OTA session', async (t) => {
  const f = fixture(t);
  f.corrupt();
  const installer = new CloudFirmwareInstaller(f.options);
  const job = await settled(
    installer,
    (installer.start('fcplcn-test', f.body).data as { jobId: string }).jobId,
  );
  assert.equal(job.state, 'failed');
  assert.match(job.error || '', /SHA-256/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.held(), 0);
});

test('A changed uplink epoch aborts a partial inactive-slot upload without retry or activation', async (t) => {
  const f = fixture(t);
  f.disconnect();
  const installer = new CloudFirmwareInstaller(f.options);
  const job = await settled(
    installer,
    (installer.start('fcplcn-test', f.body).data as { jobId: string }).jobId,
  );
  assert.equal(job.state, 'failed');
  assert.equal(f.calls.filter((call) => call.endsWith('/chunk')).length, 1);
  assert.equal(f.calls.filter((call) => call.endsWith('/finish')).length, 0);
  assert.equal(f.calls.filter((call) => call.endsWith('/abort')).length, 1);
  assert.equal(f.held(), 0);
});

test('A lost activation reply is resolved by read-only boot confirmation, never a second finish', async (t) => {
  const f = fixture(t, 'unknown'),
    installer = new CloudFirmwareInstaller(f.options);
  const job = await settled(
    installer,
    (installer.start('fcplcn-test', f.body).data as { jobId: string }).jobId,
  );
  assert.equal(job.state, 'completed');
  assert.equal(f.calls.filter((call) => call.endsWith('/finish')).length, 1);
});

test('A known PLC rejection stays a failed installation and releases maintenance', async (t) => {
  const f = fixture(t, 'reject'),
    installer = new CloudFirmwareInstaller(f.options);
  const job = await settled(
    installer,
    (installer.start('fcplcn-test', f.body).data as { jobId: string }).jobId,
  );
  assert.equal(job.state, 'failed');
  assert.match(job.error || '', /отклонён/);
  assert.equal(f.held(), 0);
});

test('A restart cleans only generated orphan cache files and exposes no executable old job', (t) => {
  const f = fixture(t),
    folder = join(f.directory, 'cloud-ota'),
    id = randomUUID();
  mkdirSync(folder);
  writeFileSync(join(folder, id + '.bin'), 'partial');
  writeFileSync(join(folder, 'notes.txt'), 'keep');
  const installer = new CloudFirmwareInstaller(f.options);
  assert.equal(existsSync(join(folder, id + '.bin')), false);
  assert.equal(existsSync(join(folder, 'notes.txt')), true);
  assert.equal(installer.status(id).status, 404);
  assert.deepEqual((installer.status('active').data as { job: unknown }).job, null);
});
