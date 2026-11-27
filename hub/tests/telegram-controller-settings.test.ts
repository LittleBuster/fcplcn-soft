import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HubControl } from '../server/control.js';
import { Scenes } from '../server/scenes.js';
import {
  readTelegramIrrigationTanks,
  updateTelegramControllerSetting,
  updateTelegramModuleEnabled,
  type TelegramControllerSettingsActions,
} from '../server/telegram/controller-settings.js';
import { createEngine } from '../src/engine.js';
import type { ControllerKind, DeviceView } from '../shared/types.js';

const permit = () => true;
const target = { deviceId: 'fcplcn-test', bootId: 'boot-test', itemId: 'heating', revision: 10 };
const thermostat = {
  id: 'heating',
  name: 'Термостат',
  relayId: 'rly-0/1',
  inputId: '',
  meteoId: 'inside',
  mode: 'heating',
  setpointC: 21,
  hysteresisC: 2,
};
const tank = {
  id: 'tank',
  name: 'Местный бак',
  pumpRelayId: '',
  valveRelayId: 'rly-0/2',
  levelInputs: ['in-0/1', 'in-0/2'],
  fillLevel: 1,
};
const irrigation = {
  id: 'lawn',
  name: 'Газон',
  relayId: 'rly-0/3',
  tankId: '',
  days: [1, 5],
  startTime: '06:00',
  durationMinutes: 15,
};
const remote = 'fcplcn-garage/tank';

function fixture() {
  const settings = new Map<string, Record<string, unknown>>([
    [
      'thermostats',
      {
        enabled: true,
        revision: 10,
        items: [
          { ...thermostat, actual: true, enabled: true, temperatureC: 20 },
          { ...thermostat, id: 'spare', name: 'Другой контур', relayId: 'rly-0/8', enabled: false },
        ],
      },
    ],
    ['tanks', { enabled: true, revision: 10, items: [{ ...tank, levelPct: 50 }] }],
    [
      'irrigation',
      {
        enabled: true,
        revision: 10,
        items: [irrigation],
        remoteTanks: [{ id: remote, name: 'Ёмкость', deviceName: 'Гараж', waterAvailable: true }],
      },
    ],
  ]);
  const device: DeviceView = {
    id: target.deviceId,
    name: 'Дом',
    room: '',
    firmwareVersion: 'integration',
    boardId: 'test',
    status: 'online',
    online: true,
    bootId: target.bootId,
    connectionGeneration: 1,
    lastSeenAt: null,
    uptimeSec: 120,
    management: { version: 1, supported: true, busy: false, sequence: 0 },
    controllers: Object.fromEntries(
      [...settings].map(([kind, data]) => [
        kind,
        {
          kind: kind as ControllerKind,
          receivedAt: '',
          fresh: true,
          data,
        },
      ]),
    ),
  };
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let afterRead = () => {};
  let confirmation: { status: number; data: unknown } = { status: 200, data: { ok: true } };
  const actions: TelegramControllerSettingsActions = {
    snapshot: () => ({ devices: [device], broker: { connected: true, error: null }, commands: [] }),
    async service(id, method, path, body) {
      assert.equal(id, device.id);
      calls.push({ method, path, body });
      if (method === 'POST') return confirmation;
      const data = structuredClone(settings.get(path.slice('/controllers/'.length)));
      afterRead();
      return { status: 200, data };
    },
  };
  return {
    actions,
    calls,
    settings,
    device,
    afterRead(callback: () => void) {
      afterRead = callback;
    },
    reply(reply: typeof confirmation) {
      confirmation = reply;
    },
  };
}

test('Telegram writes only editable module fields and preserves the neighboring thermostat settings', async () => {
  const { actions, calls } = fixture();
  await updateTelegramControllerSetting(
    actions,
    target,
    { kind: 'thermostats', field: 'setpointC', value: 23.5 },
    permit,
  );
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(calls[1], {
    method: 'POST',
    path: '/controllers/thermostats',
    body: {
      baseRevision: 10,
      enabled: true,
      items: [
        { ...thermostat, setpointC: 23.5 },
        { ...thermostat, id: 'spare', name: 'Другой контур', relayId: 'rly-0/8' },
      ],
    },
  });
  await updateTelegramControllerSetting(
    actions,
    target,
    { kind: 'thermostats', field: 'mode', value: 'cooling' },
    permit,
  );
  assert.equal((calls.at(-1)!.body!.items as Record<string, unknown>[])[0].mode, 'cooling');
});

test('Invalid input, lost access, a refreshed connection and stale revisions prevent writes', async () => {
  const invalid = fixture();
  await assert.rejects(
    updateTelegramControllerSetting(
      invalid.actions,
      target,
      { kind: 'thermostats', field: 'setpointC', value: 20.55 },
      permit,
    ),
    /уставка/i,
  );
  await assert.rejects(
    updateTelegramControllerSetting(
      invalid.actions,
      { ...target, itemId: tank.id },
      { kind: 'tanks', field: 'fillLevel', value: 3 },
      permit,
    ),
    /настроенных уровней/,
  );
  assert.ok(invalid.calls.every(({ method }) => method === 'GET'));

  const scenarios = [
    {
      apply(f: ReturnType<typeof fixture>) {
        f.device.connectionGeneration!++;
      },
      error: /связи/,
    },
    {
      apply(f: ReturnType<typeof fixture>) {
        f.device.bootId = 'new-boot';
      },
      error: /связи/,
    },
    {
      apply(f: ReturnType<typeof fixture>) {
        f.device.management!.busy = true;
      },
      error: /занят/,
    },
  ];
  for (const scenario of scenarios) {
    const f = fixture();
    f.afterRead(() => scenario.apply(f));
    await assert.rejects(
      updateTelegramModuleEnabled(f.actions, target, 'thermostats', false, permit),
      scenario.error,
    );
    assert.equal(f.calls.length, 1);
  }
  const stale = fixture();
  await assert.rejects(
    updateTelegramModuleEnabled(
      stale.actions,
      { ...target, revision: 9 },
      'thermostats',
      false,
      permit,
    ),
    /изменились/,
  );
  assert.equal(stale.calls.length, 1);
  const revoked = fixture();
  let permitted = true;
  revoked.afterRead(() => {
    permitted = false;
  });
  await assert.rejects(
    updateTelegramModuleEnabled(revoked.actions, target, 'thermostats', false, () => permitted),
    /доступ отозван/,
  );
  assert.equal(revoked.calls.length, 1);
});

test('Telegram chooses local and remote tanks from the live catalogue and never retries a write', async () => {
  const f = fixture();
  const watering = { ...target, itemId: irrigation.id };
  delete f.device.controllers.tanks; // A device can expose only its irrigation in general telemetry.
  assert.deepEqual(await readTelegramIrrigationTanks(f.actions, watering, permit), [
    { id: '', label: 'Без бака' },
    { id: tank.id, label: tank.name },
    { id: remote, label: 'Ёмкость · Гараж' },
  ]);
  await assert.rejects(
    updateTelegramControllerSetting(
      f.actions,
      watering,
      { kind: 'irrigation', field: 'tankId', value: 'fcplcn-other/tank' },
      permit,
    ),
    /нет в каталоге/,
  );
  assert.ok(f.calls.every(({ method }) => method === 'GET'));
  f.reply({ status: 504, data: { unknown: true, error: 'PLC не подтвердил операцию' } });
  await assert.rejects(
    updateTelegramControllerSetting(
      f.actions,
      watering,
      { kind: 'irrigation', field: 'tankId', value: remote },
      permit,
    ),
    /не подтвердил/,
  );
  assert.deepEqual(
    f.calls.filter(({ method }) => method === 'POST'),
    [
      {
        method: 'POST',
        path: '/controllers/irrigation',
        body: {
          baseRevision: 10,
          enabled: true,
          items: [{ ...irrigation, tankId: remote }],
        },
      },
    ],
  );
});

test('Settings and module permissions use the same private service as the web on a virtual PLC', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-telegram-config-'));
  const product = { name: 'FCPLCn', id: 'fcplcn', fullName: 'Future City PLC Next' };
  const engine = createEngine({
    product,
    mode: 'demo',
    demoDataDir: directory,
    brokerUrl: 'mqtt://127.0.0.1:1883',
    clientId: 'telegram-config-fixture',
    staleAfterMs: 45_000,
    commandTimeoutMs: 5000,
    labels: {},
    onLabelsChanged() {},
  });
  const scenes = new Scenes(engine, { directory, demo: true });
  const control = new HubControl({ engine, scenes, product, mode: 'demo', dataDir: directory });
  t.after(async () => {
    control.close();
    await scenes.stop();
    await engine.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  await engine.start();

  const device = engine.snapshot().devices.find(({ id }) => id === 'fcplcn-demo-utility')!;
  const moduleRows = async (kind: ControllerKind) => {
    const reply = await control.service(device.id, 'GET', `/controllers/${kind}`);
    assert.equal(reply.status, 200);
    return (reply.data as { items: Record<string, unknown>[] }).items;
  };
  const rowTarget = (itemId: string) => ({ deviceId: device.id, itemId, bootId: device.bootId });
  const [initialThermostat] = await moduleRows('thermostats');
  await updateTelegramControllerSetting(
    control,
    rowTarget(String(initialThermostat.id)),
    { kind: 'thermostats', field: 'setpointC', value: 23.5 },
    permit,
  );
  const [updatedThermostat] = await moduleRows('thermostats');
  assert.equal(updatedThermostat.setpointC, 23.5);
  assert.equal(updatedThermostat.meteoId, initialThermostat.meteoId);
  assert.equal(updatedThermostat.enabled, initialThermostat.enabled);
  const [initialTank] = await moduleRows('tanks');
  await updateTelegramControllerSetting(
    control,
    rowTarget(String(initialTank.id)),
    { kind: 'tanks', field: 'fillLevel', value: 1 },
    permit,
  );
  const [updatedTank] = await moduleRows('tanks');
  assert.equal(updatedTank.fillLevel, 1);
  assert.deepEqual(updatedTank.levelInputs, initialTank.levelInputs);
  assert.equal(updatedTank.enabled, initialTank.enabled);

  const module = await control.service(device.id, 'GET', '/controllers/irrigation');
  assert.equal(module.status, 200);
  const settings = module.data as { revision: number; items: { id: string }[] };
  const watering = { deviceId: device.id, itemId: settings.items[0].id, bootId: device.bootId };
  await updateTelegramControllerSetting(
    control,
    { ...watering, revision: settings.revision },
    { kind: 'irrigation', field: 'days', value: [7, 2] },
    permit,
  );
  const changed = await control.service(device.id, 'GET', '/controllers/irrigation');
  assert.equal(changed.status, 200);
  assert.deepEqual((changed.data as { items: { days: number[] }[] }).items[0].days, [2, 7]);
  await updateTelegramModuleEnabled(control, watering, 'irrigation', false, permit);
  const disabled = await control.service(device.id, 'GET', '/controllers/irrigation');
  assert.equal(disabled.status, 200);
  assert.equal((disabled.data as { enabled: boolean }).enabled, false);
});
