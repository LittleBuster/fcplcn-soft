import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connectionHistory, connectionHistoryRange } from '../server/connection-history.js';
import { engineOptions, loadConfig } from '../server/config.js';
import { createHubServer } from '../server/http.js';
import type {
  ConnectionFleetHistory,
  ConnectionHistory,
  DeviceOutage,
} from '../shared/activity.js';
import { createEngine } from '../src/engine.js';

const hour = 60 * 60_000;
const garage = 'fcplcn-demo-garage';
const iso = (time: number) => new Date(time).toISOString();
const outage = (
  id: string,
  start: number,
  end: number | null,
  deviceId = garage,
): DeviceOutage => ({
  id,
  deviceId,
  deviceName: 'Гараж',
  offlineAt: iso(start),
  onlineAt: end === null ? null : iso(end),
  reason: 'availability',
});

test('connection history preserves exact intervals at the edge of each window', () => {
  const now = Date.parse('2026-11-28T08:11:07.123Z');
  const day = connectionHistoryRange('day', now);
  const week = connectionHistoryRange('week', now);
  assert.equal(day.from, iso(now - 24 * hour));
  assert.equal(week.from, iso(now - 168 * hour));
  assert.equal(day.to, iso(now));
  assert.equal(week.to, day.to);

  const from = Date.parse(day.from);
  const old = outage('old', from - 5 * hour, from);
  const crossing = outage('crossing', from - 2 * hour, from + 10_019);
  const open = outage('open', now - 51_919, null);
  const future = outage('future', now + 1, null);
  const other = outage('other', now - 10_000, null, 'fcplcn-demo-living');
  const rows = [open, old, crossing, future, other, { ...crossing, onlineAt: null }];
  assert.deepEqual(connectionHistory(garage, day, rows).outages, [crossing, open]);
  assert.deepEqual(connectionHistory(garage, week, rows).outages, [old, crossing, open]);
});

test('connection history web route authenticates, validates period and uses demo observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fcplcn-connection-history-'));
  const product = { name: 'FCPLCn', id: 'fcplcn', fullName: 'Future City PLC Next' };
  const config = loadConfig(
    {
      FCPLCN_HUB_MODE: 'demo',
      FCPLCN_HUB_DATA_DIR: directory,
      FCPLCN_HUB_PASSWORD: 'connection-fixture',
    },
    [],
  );
  const now = Date.now();
  const recent = {
    ...outage('recent', now - 2 * hour, now - hour),
    deviceName: 'Прежнее имя гаража',
  };
  const earlier = outage('earlier', now - 35 * hour, now - 34 * hour);
  const archive = {
    ...outage('archive', now - 42 * hour, now - 39 * hour, 'fcplcn-retired'),
    deviceName: 'Теплица',
  };
  const open = {
    ...outage('open', now - 180 * hour, null, 'fcplcn-offline'),
    deviceName: 'Сад',
  };
  const engine = createEngine(
    engineOptions(config, product, {
      labels: {},
      onLabelsChanged() {},
      activity: { outages: [recent, earlier, archive, open] },
    }),
  );
  const server = createHubServer({ config, engine, product, webDir: directory });
  try {
    await engine.start();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/v1';
    const path = '/devices/' + garage + '/connection-history';
    const fleetPath = '/devices/connection-history';
    assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await fetch(base + fleetPath)).status, 401);
    const login = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: config.password }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const get = (path: string) => fetch(base + path, { headers: { cookie } });
    assert.equal((await get(path + '?period=month')).status, 400);
    assert.equal((await get(fleetPath + '?period=month')).status, 400);
    assert.equal((await get('/devices/fcplcn-not-found/connection-history')).status, 404);

    const today = await get(path);
    const sevenDays = await get(path + '?period=week');
    assert.equal(today.status, 200);
    assert.equal(sevenDays.status, 200);
    const day = (await today.json()) as ConnectionHistory;
    const week = (await sevenDays.json()) as ConnectionHistory;
    assert.equal(day.period, 'day');
    assert.equal(week.period, 'week');
    assert.equal(Date.parse(day.to) - Date.parse(day.from), 24 * hour);
    assert.equal(Date.parse(week.to) - Date.parse(week.from), 168 * hour);
    assert.deepEqual(day.outages, [recent]);
    assert.deepEqual(week.outages, [earlier, recent]);

    const fleetDayResponse = await get(fleetPath);
    const fleetWeekResponse = await get(fleetPath + '?period=week');
    assert.equal(fleetDayResponse.status, 200);
    assert.equal(fleetWeekResponse.status, 200);
    const fleetDay = (await fleetDayResponse.json()) as ConnectionFleetHistory;
    const fleetWeek = (await fleetWeekResponse.json()) as ConnectionFleetHistory;
    assert.equal(fleetDay.period, 'day');
    assert.equal(fleetWeek.period, 'week');
    assert.deepEqual(fleetDay.outages, [open, recent]);
    assert.deepEqual(fleetWeek.outages, [open, archive, earlier, recent]);
    const current = engine.snapshot().devices.map(({ id, name, online }) => ({ id, name, online }));
    assert.ok(current.some(({ id }) => id === garage));
    assert.ok(current.some(({ id }) => id === 'fcplcn-demo-living'));
    for (const device of current) {
      assert.deepEqual(
        fleetDay.devices.find(({ id }) => id === device.id),
        device,
      );
      assert.deepEqual(
        fleetWeek.devices.find(({ id }) => id === device.id),
        device,
      );
    }
    assert.deepEqual(
      fleetDay.devices.find(({ id }) => id === open.deviceId),
      {
        id: open.deviceId,
        name: open.deviceName,
        online: false,
      },
    );
    assert.equal(
      fleetDay.devices.some(({ id }) => id === archive.deviceId),
      false,
    );
    assert.deepEqual(
      fleetWeek.devices.find(({ id }) => id === archive.deviceId),
      {
        id: archive.deviceId,
        name: archive.deviceName,
        online: null,
      },
    );
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await engine.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
