/** @file Reply keyboards preserve identity, honest freshness and explicit no-retry PLC actions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CommandView, EngineSnapshot, SceneRun } from '../shared/types.js';
import { TelegramMenu, type TelegramActions } from '../server/telegram/menu.js';
import type { TelegramReply } from '../server/telegram/client.js';

const buttons = (reply: TelegramReply) => reply.reply_markup.keyboard!.flat();
function fixture() {
  const snapshot: EngineSnapshot = {
    broker: { connected: true, error: null },
    commands: [],
    devices: [
      {
        id: 'fcplcn-one',
        name: 'Дом',
        room: '',
        boardId: 'board',
        firmwareVersion: 'test',
        online: true,
        status: 'online',
        bootId: 'boot-1',
        lastSeenAt: null,
        uptimeSec: 100,
        controllers: {
          sockets: {
            kind: 'sockets',
            fresh: true,
            receivedAt: '',
            data: {
              enabled: true,
              items: [
                { id: 'one', name: 'Розетка', actual: false, available: true },
                { id: 'two', name: 'Розетка', actual: false, available: true },
                { id: 'three', name: 'Контактор', actual: false, available: true },
              ],
            },
          },
          thermostats: {
            kind: 'thermostats',
            fresh: true,
            receivedAt: '',
            data: {
              enabled: true,
              items: [
                {
                  id: 'heat',
                  name: 'Котёл',
                  enabled: false,
                  actual: false,
                  available: false,
                  temperatureC: 99,
                  setpointC: 22,
                  hysteresisC: 1,
                  mode: 'heating',
                },
              ],
            },
          },
          security: {
            kind: 'security',
            fresh: true,
            receivedAt: '',
            data: {
              enabled: true,
              armed: false,
              readyToArm: true,
              phase: 'disarmed',
              items: [
                { id: 'door', name: 'Дверь', active: false, available: false, sensorType: 'reed' },
              ],
            },
          },
        },
      },
    ],
  };
  const calls: unknown[][] = [],
    runs: SceneRun[] = [];
  let result: CommandView['status'] = 'applied';
  const actions: TelegramActions = {
    snapshot: () => structuredClone(snapshot),
    scenes: () => ({ definitions: [], activeRun: null, runs }),
    async command(deviceId, kind, itemId, value) {
      calls.push([deviceId, kind, itemId, value]);
      if (result === 'applied' && kind === 'sockets') {
        const items = snapshot.devices[0].controllers.sockets!.data.items as Record<
          string,
          unknown
        >[];
        items.find((item) => item.id === itemId)!.actual = value;
      }
      return {
        id: 'command',
        deviceId,
        controller: kind,
        itemId,
        value,
        sequence: calls.length,
        status: result,
        createdAt: '',
        completedAt: '',
        error: null,
      };
    },
    runScene(id) {
      const run: SceneRun = {
        id,
        sceneId: id,
        name: id,
        status: 'completed',
        startedAt: '',
        completedAt: '',
        results: [],
      };
      runs.unshift(run);
      return run;
    },
  };
  return {
    snapshot,
    actions,
    calls,
    runs,
    setResult: (value: CommandView['status']) => {
      result = value;
    },
    menu: new TelegramMenu(actions, 0),
  };
}

async function sockets(menu: TelegramMenu, chat = '42') {
  const root = await menu.handle(chat, '/start', () => true);
  const device = await menu.handle(
    chat,
    buttons(root).find((label) => label.startsWith('🏡'))!,
    () => true,
  );
  return menu.handle(
    chat,
    buttons(device).find((label) => label.includes('Розетки'))!,
    () => true,
  );
}

test('native reply keyboard starts with three hot scenes and navigates unique duplicate-name channels', async () => {
  const f = fixture();
  const root = await f.menu.handle('42', '/start', () => true);
  assert.deepEqual(root.reply_markup.keyboard![0], ['🏠 Я дома', '🚪 Ушел', '🌅 Готовлюсь']);
  assert.equal('inline_keyboard' in root.reply_markup, false);
  assert.equal(root.reply_markup.is_persistent, true);
  const list = await sockets(f.menu);
  const candidates = buttons(list).filter((label) => label.includes('Розетка'));
  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0], candidates[1]);
  const changed = await f.menu.handle('42', candidates[0], () => true);
  assert.deepEqual(f.calls, [['fcplcn-one', 'sockets', 'one', true]]);
  assert.match(changed.text, /PLC подтвердил/);
  await f.menu.handle('42', candidates[0], () => true);
  assert.equal(f.calls.length, 1, 'An old OFF keyboard label cannot toggle the confirmed ON again');
  assert.ok(changed.text.length < 4096);
});

test('stale boot, revoked authorization and unknown text never actuate', async () => {
  const f = fixture();
  const list = await sockets(f.menu);
  const label = buttons(list).find((value) => value.includes('Розетка'))!;
  f.snapshot.devices[0].bootId = 'boot-2';
  assert.match((await f.menu.handle('42', label, () => true)).text, /Нет свежей связи/);
  assert.equal(f.calls.length, 0);
  const refreshed = await f.menu.handle('42', '🔄 Обновить', () => true);
  await f.menu.handle(
    '42',
    buttons(refreshed).find((value) => value.includes('Розетка'))!,
    () => false,
  );
  await f.menu.handle('42', 'включить реле 1', () => true);
  assert.equal(f.calls.length, 0);
});

test('unknown batch outcome stops later channels and reports unprocessed targets', async () => {
  const f = fixture();
  const list = await sockets(f.menu);
  f.setResult('unknown');
  const result = await f.menu.handle(
    '42',
    buttons(list).find((label) => label.startsWith('🟢 Вкл все'))!,
    () => true,
  );
  assert.equal(f.calls.length, 1);
  assert.match(result.text, /неподтверждённая команда/);
  assert.match(result.text, /Не отправлено: 2/);
});

test('removing or reordering equally named channels cannot retarget an old reply button', async () => {
  const f = fixture();
  const list = await sockets(f.menu);
  const old = buttons(list).filter((label) => label.includes('Розетка'))[0];
  const module = f.snapshot.devices[0].controllers.sockets!.data;
  module.items = (module.items as Record<string, unknown>[])
    .filter((item) => item.id !== 'one')
    .reverse();
  const current = await f.menu.handle('42', '🔄 Обновить', () => true);
  assert.equal(buttons(current).includes(old), false);
  await f.menu.handle('42', old, () => true);
  assert.equal(f.calls.length, 0);
  await f.menu.handle(
    '42',
    buttons(current).find((label) => label.includes('Розетка'))!,
    () => true,
  );
  assert.deepEqual(f.calls, [['fcplcn-one', 'sockets', 'two', true]]);
});

test('unavailable security zones and stale thermostat temperatures never appear healthy', async () => {
  const f = fixture();
  let root = await f.menu.handle('42', '/start', () => true);
  const enter = buttons(root).find((value) => value.startsWith('🏡'))!;
  let device = await f.menu.handle('42', enter, () => true);
  const zones = await f.menu.handle(
    '42',
    buttons(device).find((value) => value.includes('Охрана'))!,
    () => true,
  );
  assert.match(zones.text, /⚫ Дверь — недоступно/);
  assert.doesNotMatch(zones.text, /Дверь — норма/);
  root = await f.menu.handle('42', '/start', () => true);
  device = await f.menu.handle(
    '42',
    buttons(root).find((value) => value.startsWith('🏡'))!,
    () => true,
  );
  const thermostats = await f.menu.handle(
    '42',
    buttons(device).find((value) => value.includes('Термостаты'))!,
    () => true,
  );
  assert.match(thermostats.text, /нет показаний/);
  assert.doesNotMatch(thermostats.text, /99/);
  const detail = await f.menu.handle(
    '42',
    buttons(thermostats).find((value) => value.includes('Котёл'))!,
    () => true,
  );
  assert.match(detail.text, /22/);
  await f.menu.handle(
    '42',
    buttons(detail).find((label) => label.startsWith('🟢 Включить'))!,
    () => true,
  );
  assert.deepEqual(
    f.calls,
    [['fcplcn-one', 'thermostats', 'heat', true]],
    'A configured but disabled thermostat can be enabled without a fabricated fresh reading',
  );
});

test('keyboards are chat scoped and pagination keeps large fleets bounded', async () => {
  const f = fixture();
  const template = f.snapshot.devices[0];
  f.snapshot.devices = Array.from({ length: 100 }, (_, index) => ({
    ...structuredClone(template),
    id: 'fcplcn-' + index,
    name: 'Дом ' + index,
  }));
  const root = await f.menu.handle('42', '/start', () => true);
  assert.equal(buttons(root).filter((label) => label.startsWith('🏡')).length, 12);
  assert.ok(root.text.length < 4096);
  const next = await f.menu.handle('42', 'Следующие ▶️', () => true);
  assert.match(next.text, /Страница 2/);
  const other = await f.menu.handle('99', 'Следующие ▶️', () => true);
  assert.match(other.text, /актуальные кнопки/);
});
