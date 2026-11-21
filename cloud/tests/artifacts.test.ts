/** @file Real HTTP firmware staging: image validation, private files, quotas and one-use downloads. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { CloudArtifacts, type ArtifactView } from '../server/artifacts.js';
import { cloudAppImage } from '../../hub/tests/cloud-fixtures.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-cloud-artifacts-'));
  let now = Date.now();
  const artifacts = new CloudArtifacts(directory, 'FCPLCn', () => now);
  const homeId = randomUUID();
  const server = createServer(async (request, response) => {
    try {
      const result = await artifacts.upload(request, homeId);
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead((error as { statusCode?: number }).statusCode || 500);
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  const upload = (bytes: Buffer, type = 'application/octet-stream') =>
    fetch('http://127.0.0.1:' + (server.address() as AddressInfo).port, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body: Uint8Array.from(bytes),
    });
  return {
    directory,
    artifacts,
    homeId,
    upload,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

test('Uploaded app identity, private files, one-use ticket and home/hub scope survive staging', async (t) => {
  const f = await fixture(t),
    bytes = cloudAppImage();
  const response = await f.upload(bytes);
  assert.equal(response.status, 201);
  const view = (await response.json()) as ArtifactView;
  assert.equal(view.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(view.imageId, bytes.subarray(176, 208).toString('hex'));
  assert.equal(statSync(join(f.directory, 'firmware', view.id + '.bin')).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.directory, 'firmware')).mode & 0o777, 0o700);
  assert.throws(() => f.artifacts.issue(view.id, randomUUID(), 'hub-a'), /не найден/);
  const { ticket } = f.artifacts.issue(view.id, f.homeId, 'hub-a');
  assert.throws(() => f.artifacts.download(view.id, ticket, 'hub-b'), /не разрешена/);
  const body: Buffer[] = [];
  for await (const chunk of f.artifacts.download(view.id, ticket, 'hub-a').stream)
    body.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(body), bytes);
  assert.throws(() => f.artifacts.download(view.id, ticket, 'hub-a'), /не разрешена/);
  const recovered = new CloudArtifacts(f.directory);
  assert.equal(recovered.issue(view.id, f.homeId, 'hub-a').artifact.sha256, view.sha256);
});

test('Restart validates every manifest before deleting orphans regardless of directory entry count', async (t) => {
  const f = await fixture(t);
  const response = await f.upload(cloudAppImage());
  const view = (await response.json()) as ArtifactView;
  for (let index = 0; index < 2050; index++)
    writeFileSync(join(f.directory, 'firmware', '000-' + index + '.keep'), '');
  const recovered = new CloudArtifacts(f.directory);
  assert.equal(recovered.issue(view.id, f.homeId, 'hub-a').artifact.sha256, view.sha256);
  assert.ok(existsSync(join(f.directory, 'firmware', view.id + '.bin')));
});

test('Wrong project/chip, merged-like bytes and corrupted app hashes are rejected before installation', async (t) => {
  const f = await fixture(t);
  for (const variant of ['project', 'chip', 'hash', 'magic']) {
    const bytes = cloudAppImage();
    if (variant === 'project') bytes.write('Other!', 80);
    if (variant === 'chip') bytes.writeUInt16LE(0, 12);
    if (variant === 'hash') bytes[bytes.length - 1] ^= 1;
    if (variant === 'magic') bytes[0] = 0;
    assert.equal((await f.upload(bytes)).status, 400, variant);
  }
  assert.equal((await f.upload(cloudAppImage(), 'text/plain')).status, 413);
});

test('Tickets expire and per-home staging limits recover after file expiration', async (t) => {
  const f = await fixture(t),
    bytes = cloudAppImage();
  const first = (await f.upload(bytes).then((response) => response.json())) as ArtifactView;
  const stale = f.artifacts.issue(first.id, f.homeId, 'hub-a');
  f.advance(120001);
  assert.throws(() => f.artifacts.download(first.id, stale.ticket, 'hub-a'), /не разрешена/);
  for (let index = 0; index < 4; index++) assert.equal((await f.upload(bytes)).status, 201);
  assert.equal((await f.upload(bytes)).status, 429);
  f.advance(3600001);
  assert.equal((await f.upload(bytes)).status, 201);
});

test('Failed staging releases reservations and the download path never follows a symlink', async (t) => {
  const f = await fixture(t),
    bytes = cloudAppImage(),
    folder = join(f.directory, 'firmware');
  chmodSync(folder, 0o500);
  try {
    for (let index = 0; index < 3; index++) assert.equal((await f.upload(bytes)).status, 500);
  } finally {
    chmodSync(folder, 0o700);
  }
  const response = await f.upload(bytes);
  assert.equal(response.status, 201);
  const file = (await response.json()) as ArtifactView;
  const secret = join(f.directory, 'private.txt');
  writeFileSync(secret, 'never served', { mode: 0o600 });
  unlinkSync(join(folder, file.id + '.bin'));
  symlinkSync(secret, join(folder, file.id + '.bin'));
  const { ticket } = f.artifacts.issue(file.id, f.homeId, 'hub-a');
  assert.throws(() => f.artifacts.download(file.id, ticket, 'hub-a'));
});

test('Restart discards only generated crash remnants and public manifests use an explicit field whitelist', async (t) => {
  const f = await fixture(t),
    image = cloudAppImage();
  const view = (await f.upload(image).then((response) => response.json())) as ArtifactView;
  const folder = join(f.directory, 'firmware');
  const manifest = join(folder, view.id + '.json');
  writeFileSync(
    manifest,
    JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), token: 'never public' }),
  );
  const orphan = randomUUID();
  for (const extension of ['.part', '.bin', '.json.tmp'])
    writeFileSync(join(folder, orphan + extension), 'partial');
  writeFileSync(join(folder, 'notes.txt'), 'keep');
  const recovered = new CloudArtifacts(f.directory);
  for (const extension of ['.part', '.bin', '.json.tmp'])
    assert.equal(existsSync(join(folder, orphan + extension)), false);
  assert.equal(existsSync(join(folder, 'notes.txt')), true);
  assert.equal('token' in recovered.issue(view.id, f.homeId, 'hub-a').artifact, false);
});
