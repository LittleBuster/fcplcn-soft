/** @file Exercise private configuration RPC correlation, queue expiry and cancellation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineSnapshot, ManagementRequest, ManagementReply } from '../shared/types.js';
import { ManagementClient, ManagementError } from '../src/protocol/management.js';

function fixture(timeout = 1000) {
  const snapshot: EngineSnapshot = {
    broker: { connected: true, error: null },
    commands: [],
    devices: [
      {
        id: 'fcplcn-unit',
        name: 'PLC',
        room: '',
        boardId: 'fcplcn-161608-1v0',
        firmwareVersion: 'test',
        bootId: 'boot-one',
        status: 'online',
        online: true,
        lastSeenAt: new Date().toISOString(),
        uptimeSec: 100,
        controllers: {},
        management: { supported: true, version: 1, sequence: 7, busy: false },
      },
    ],
  };
  const sent: ManagementRequest[] = [];
  let client: ManagementClient;
  client = new ManagementClient(
    () => snapshot,
    async (_device, request, expiry) => {
      assert.ok(expiry > 0);
      sent.push(request);
    },
    timeout,
  );
  const reply = (
    request = sent.at(-1)!,
    data: ManagementReply['data'] = { ok: true },
    status = 200,
  ) =>
    client.receive(
      'fcplcn-unit',
      JSON.stringify({
        schemaVersion: 1,
        requestId: request.requestId,
        bootId: request.bootId,
        sequence: request.sequence,
        status,
        data,
      }),
    );
  return { client, snapshot, sent, reply };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('management rejects unsupported/offline devices and non-service paths without publishing', async () => {
  const f = fixture();
  await assert.rejects(
    f.client.request('fcplcn-unit', 'POST', '/arbitrary', {}),
    /не поддерживается/,
  );
  f.snapshot.devices[0].management!.supported = false;
  await assert.rejects(
    f.client.request('fcplcn-unit', 'GET', '/config'),
    (error: unknown) => error instanceof ManagementError && error.statusCode === 426,
  );
  f.snapshot.devices[0].management!.supported = true;
  f.snapshot.devices[0].online = false;
  await assert.rejects(f.client.request('fcplcn-unit', 'GET', '/config'), /свежей связи/);
  assert.equal(f.sent.length, 0);
});

test('private replies match boot/id/sequence and never accept retained state or leak to telemetry', async () => {
  const f = fixture();
  const promise = f.client.request('fcplcn-unit', 'GET', '/config/backup');
  const packet = f.sent[0];
  assert.equal(packet.sequence, 8);
  assert.equal(packet.bootId, 'boot-one');
  assert.ok(packet.expiresAtUptimeMs > 100_000 && packet.expiresAtUptimeMs <= 160_000);
  const envelope = { ...packet, status: 200, data: { password: 'private-only' } };
  f.client.receive('fcplcn-unit', JSON.stringify(envelope), true);
  f.client.receive('fcplcn-unit', JSON.stringify({ ...envelope, bootId: 'old-boot' }));
  f.client.receive('fcplcn-unit', JSON.stringify({ ...envelope, requestId: 'other' }));
  assert.equal(f.client.busy('fcplcn-unit'), true);
  f.reply(packet, { password: 'private-only' });
  assert.equal(
    (await promise).data && ((await promise).data as Record<string, unknown>).password,
    'private-only',
  );
  assert.equal(JSON.stringify(f.snapshot).includes('private-only'), false);
});

test('board-profile arrays cross the RPC boundary without being wrapped as objects', async () => {
  const f = fixture();
  const promise = f.client.request('fcplcn-unit', 'GET', '/board-profiles');
  f.reply(undefined, [{ boardId: 'fcplcn-161608-1v0' }]);
  assert.deepEqual((await promise).data, [{ boardId: 'fcplcn-161608-1v0' }]);
});

test('FIFO uses one in-flight request and aborting a queued write prevents late actuation', async () => {
  const f = fixture();
  const first = f.client.request('fcplcn-unit', 'GET', '/config');
  const abort = new AbortController();
  const cancelled = f.client.request(
    'fcplcn-unit',
    'POST',
    '/config',
    { baseRevision: 1, device: { name: 'Do not apply' } },
    abort.signal,
  );
  const cancelledCheck = assert.rejects(cancelled, /отменён до отправки/);
  const last = f.client.request('fcplcn-unit', 'GET', '/controllers');
  assert.equal(f.sent.length, 1);
  abort.abort();
  await cancelledCheck;
  f.reply(f.sent[0]);
  await first;
  await tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].path, '/controllers');
  assert.equal(f.sent[1].sequence, 9);
  f.reply(f.sent[1]);
  await last;
});

test('disconnect or reboot cancels active and queued work with no replay on a new connection', async () => {
  const f = fixture();
  const first = f.client.request('fcplcn-unit', 'POST', '/config', { baseRevision: 1 });
  const second = f.client.request('fcplcn-unit', 'POST', '/user', { username: 'next' });
  const pending = Promise.allSettled([first, second]);
  f.client.disconnect();
  const replies = await pending;
  assert.ok(replies.every((reply) => reply.status === 'rejected'));
  await tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.client.busy('fcplcn-unit'), false);
  const third = f.client.request('fcplcn-unit', 'GET', '/config');
  const rejected = assert.rejects(third, /перезапущен/);
  f.snapshot.devices[0].bootId = 'boot-two';
  f.client.observe();
  await rejected;
  assert.equal(f.sent.length, 2);
});

test('an unconfirmed write times out even if the transport never completes; no implicit retry', async () => {
  const f = fixture(300);
  const client = new ManagementClient(
    () => f.snapshot,
    () => new Promise(() => {}),
    300,
  );
  await assert.rejects(
    client.request('fcplcn-unit', 'POST', '/config', { baseRevision: 1 }),
    (error: unknown) =>
      error instanceof ManagementError && error.statusCode === 504 && error.unknown,
  );
  assert.equal(client.busy('fcplcn-unit'), false);
});

test('oversized or malformed private requests are rejected before transport work', async () => {
  const f = fixture();
  await assert.rejects(
    f.client.request('fcplcn-unit', 'POST', '/config', { name: 'x'.repeat(42 * 1024) }),
    /слишком велики/,
  );
  await assert.rejects(f.client.request('fcplcn-unit', 'GET', '/config', {}), /не принимает/);
  assert.equal(f.sent.length, 0);
});
