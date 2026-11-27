/** @file Reply keyboards preserve identity, honest freshness and explicit no-retry PLC actions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTelegramMessage } from '../shared/telegram-format.js';
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

test('menu formats Telegram headings and escapes configured device names', async () => {
  const f = fixture();
  f.snapshot.devices[0].name = '<b>Гараж & сад</b>';
  const home = await f.menu.handle('42', '/start', () => true);
  assert.equal(home.parse_mode, 'HTML');
  assert.match(home.text, /^<b>🏡 FCPLCn · Умный дом<\/b>/);
  assert.match(home.text, /<b>Устройства:<\/b>/);
  assert.match(home.text, /&lt;b&gt;Гараж &amp; сад&lt;\/b&gt;/);

  const deviceButton = buttons(home).find((label) => label.startsWith('🏡'))!;
  assert.match(deviceButton, /<b>Гараж & сад<\/b>/);
  const device = await f.menu.handle('42', deviceButton, () => true);
  assert.match(device.text, /<b>🏡 &lt;b&gt;Гараж &amp; сад&lt;\/b&gt;<\/b>/);
});

test('Telegram details and notices format independently of escaped content', () => {
  const result = formatTelegramMessage(
    ['🌤 Метео', 'Порт: a<&>', '⚠️ Датчик <1> не отвечает.', 'Страница 1/2'],
    '✅ Сохранено <b> &',
  );
  assert.equal(
    result,
    [
      '<blockquote>✅ Сохранено &lt;b&gt; &amp;</blockquote>',
      '<b>🌤 Метео</b>',
      '<b>Порт:</b> <code>a&lt;&amp;&gt;</code>',
      '<blockquote>⚠️ Датчик &lt;1&gt; не отвечает.</blockquote>',
      '<i>Страница 1/2</i>',
    ].join('\n'),
  );
});

test('Telegram HTML limits visible content without breaking entities, tags or emoji', () => {
  const longName = '&'.repeat(3998) + '🌡abc';
  const result = formatTelegramMessage([longName, 'Следующая строка']);
  assert.equal(result, `<b>${'&amp;'.repeat(3998)}…</b>`);
});

test('meteo history opens both periods for the selected sensor even with stale telemetry', async () => {
  const f = fixture();
  const plc = f.snapshot.devices[0];
  plc.controllers.meteo = {
    kind: 'meteo',
    receivedAt: '',
    fresh: false,
    data: { enabled: true, items: [{ id: 'air', name: 'Воздух' }] },
  };
  const chart = { photo: Buffer.from([137, 80, 78, 71]), caption: 'Показания за 24 часа' };
  const requests: string[][] = [];
  let granted = true;
  const permitted = () => granted;
  f.actions.meteoChart = async (...args) => {
    requests.push(args);
    if (requests.length > 2) granted = false;
    return args[2] === 'day' ? chart : null;
  };

  let reply = await f.menu.handle('42', '/start', permitted);
  for (const label of ['🏡', 'Метео', 'Воздух']) {
    reply = await f.menu.handle(
      '42',
      buttons(reply).find((button) => button.includes(label))!,
      permitted,
    );
  }
  const day = buttons(reply).find((button) => button.startsWith('📈 24 часа'))!;
  const week = buttons(reply).find((button) => button.startsWith('📈 7 дней'))!;
  assert.ok(day && week);
  const unauthorized = await f.menu.handle('42', day, () => false);
  assert.equal(unauthorized.chart, undefined);
  assert.deepEqual(requests, []);

  const dayResult = await f.menu.handle('42', day, permitted);
  assert.deepEqual(dayResult.chart, chart);
  assert.deepEqual(dayResult.reply_markup, reply.reply_markup);
  const weekResult = await f.menu.handle('42', week, permitted);
  assert.match(weekResult.text, /За этот период ещё нет показаний/);
  assert.equal(weekResult.chart, undefined);
  assert.deepEqual(requests, [
    [plc.id, 'air', 'day'],
    [plc.id, 'air', 'week'],
  ]);
  const revoked = await f.menu.handle('42', day, permitted);
  assert.equal(revoked.chart, undefined);
  assert.match(revoked.text, /доступ отозван/);
});

test('tank reply menu reports discrete level and toggles monitoring rather than either automatic output', async () => {
  const f = fixture();
  f.snapshot.devices[0].controllers.tanks = {
    kind: 'tanks',
    fresh: true,
    receivedAt: '',
    data: {
      enabled: true,
      items: [
        {
          id: 'water',
          name: 'Бак с водой',
          enabled: true,
          available: true,
          levelPct: 0,
          levelsWet: [false, false],
          fillLevel: 2,
          pumpActual: false,
          valveActual: true,
        },
        {
          id: 'reserve',
          name: 'Запасной бак',
          enabled: false,
          available: true,
          levelPct: 100,
          pumpActual: false,
          valveActual: false,
        },
      ],
    },
  };
  let reply = await f.menu.handle('42', '/start', () => true);
  reply = await f.menu.handle(
    '42',
    buttons(reply).find((label) => label.startsWith('🏡'))!,
    () => true,
  );
  reply = await f.menu.handle(
    '42',
    buttons(reply).find((label) => label.includes('Баки'))!,
    () => true,
  );
  assert.ok(
    reply.text.includes(
      [
        '<b>🛢 Бак с водой</b>',
        '<b>Мониторинг:</b> включён',
        '<b>Уровень:</b> 0 %',
        '<b>Насос:</b> выключен',
        '<b>Кран:</b> открыт',
        '',
        '<b>🛢 Запасной бак</b>',
        '<b>Мониторинг:</b> выключен',
        '<b>Уровень:</b> нет данных',
      ].join('\n'),
    ),
  );
  assert.doesNotMatch(reply.text, /100 %/);
  reply = await f.menu.handle(
    '42',
    buttons(reply).find((label) => label.includes('Бак с водой'))!,
    () => true,
  );
  const enable = buttons(reply).find((label) => label.startsWith('⚪ Выключить мониторинг'));
  assert.ok(enable);
  await f.menu.handle('42', enable, () => true);
  assert.deepEqual(f.calls, [['fcplcn-one', 'tanks', 'water', false]]);
  assert.equal(f.snapshot.devices[0].controllers.tanks.data.items instanceof Array, true);
});

test('irrigation reply buttons toggle tankless schedules even when a shared valve is already open', async () => {
  const f = fixture();
  f.snapshot.devices[0].controllers.irrigation = {
    kind: 'irrigation',
    fresh: true,
    receivedAt: '',
    data: {
      enabled: true,
      items: [
        {
          id: 'garden',
          name: 'Газон',
          enabled: true,
          actual: false,
          valveActual: true,
          tankId: '',
          waterAvailable: null,
          days: [1, 5],
          startTime: '06:30',
          durationMinutes: 12,
        },
      ],
    },
  };
  let reply = await f.menu.handle('42', '/start', () => true);
  for (const label of ['🏡', 'Полив', 'Газон']) {
    reply = await f.menu.handle(
      '42',
      buttons(reply).find((button) => button.includes(label))!,
      () => true,
    );
  }
  assert.match(reply.text, /Ожидает старта/);
  assert.match(
    reply.text,
    /Дни полива:<\/b> Пн, Пт\n<b>Время старта:<\/b> 06:30\n<b>Длительность:<\/b> 12 мин/,
  );
  await f.menu.handle(
    '42',
    buttons(reply).find((label) => label.startsWith('⚪ Выключить правило'))!,
    () => true,
  );
  assert.deepEqual(f.calls, [['fcplcn-one', 'irrigation', 'garden', false]]);
});

test('native reply keyboard starts with three hot scenes and navigates unique duplicate-name channels', async () => {
  const f = fixture();
  const root = await f.menu.handle('42', '/start', () => true);
  assert.deepEqual(root.reply_markup.keyboard![0], ['🏠 Я дома', '🚪 Ушел', '🚗 Готовлюсь']);
  assert.equal('inline_keyboard' in root.reply_markup, false);
  assert.equal(root.reply_markup.is_persistent, true);
  const list = await sockets(f.menu);
  const keyboard = list.reply_markup.keyboard!;
  assert.deepEqual(keyboard.at(-3), ['ℹ️ Подробности каналов']);
  assert.ok(keyboard.at(-4)?.some((label) => label.includes('Контактор')));
  assert.ok(keyboard.at(-2)?.[0].startsWith('⬅️ Назад'));
  const details = await f.menu.handle('42', 'ℹ️ Подробности каналов', () => true);
  assert.deepEqual(details.reply_markup.keyboard!.at(-3), ['⚡ Быстрое управление']);
  await f.menu.handle('42', '⚡ Быстрое управление', () => true);
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
  assert.match(zones.text, /<b>⚫ Дверь<\/b>\n<b>Состояние:<\/b> недоступно/);
  assert.doesNotMatch(zones.text, /Состояние:<\/b> норма/);
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
  const deviceRows = root.reply_markup.keyboard!.filter((row) =>
    row.some((label) => label.startsWith('🏡')),
  );
  assert.equal(deviceRows.length, 12);
  deviceRows.forEach((row, index) => {
    assert.equal(row.length, 1);
    assert.match(row[0], new RegExp(`^🏡 Дом ${index} · `));
  });
  assert.ok(root.text.length < 4096);
  const next = await f.menu.handle('42', 'Следующие ▶️', () => true);
  assert.match(next.text, /Страница 2/);
  const other = await f.menu.handle('99', 'Следующие ▶️', () => true);
  assert.match(other.text, /актуальные кнопки/);
});
