/** @file Persistent scene plans, global modes, ordering and interruption safety. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandView,
  DeviceView,
  EngineSnapshot,
  HubEngine,
  SceneAction,
  SceneRun,
  WritableControllerKind,
} from '../shared/types.js';
import { Scenes } from '../server/scenes.js';

function device(id: string, enabled = true): DeviceView {
  const module = (kind: 'security' | 'sockets' | 'lights' | 'thermostats', itemId: string) => ({
    kind,
    fresh: true,
    receivedAt: new Date().toISOString(),
    data: {
      enabled: kind === 'security' ? enabled : true,
      readyToArm: true,
      items: [{ id: itemId, name: itemId, available: true }],
    },
  });
  return {
    id,
    name: id,
    room: '',
    boardId: 'fcplcn-161608-1v0',
    firmwareVersion: 'test',
    bootId: `boot-${id}`,
    status: 'online',
    online: true,
    lastSeenAt: new Date().toISOString(),
    uptimeSec: 100,
    controllers: {
      security: module('security', 'zone-1'),
      sockets: module('sockets', 'socket-1'),
      lights: module('lights', 'light-1'),
      thermostats: module('thermostats', 'thermo-1'),
    },
  };
}

interface Call {
  deviceId: string;
  controller: WritableControllerKind;
  itemId: string;
  value: boolean;
}
class FakeEngine implements HubEngine {
  readonly calls: Call[] = [];
  readonly state: EngineSnapshot = {
    broker: { connected: true, error: null },
    devices: [device('fcplcn-a'), device('fcplcn-b')],
    commands: [],
  };
  hook?: (call: Call) => Promise<'applied' | 'rejected' | 'unknown'>;
  async start() {}
  async stop() {}
  snapshot(): EngineSnapshot {
    return structuredClone(this.state);
  }
  rename() {}
  async command(
    deviceId: string,
    controller: WritableControllerKind,
    itemId: string,
    value: boolean,
  ): Promise<CommandView> {
    const call = { deviceId, controller, itemId, value };
    this.calls.push(call);
    const status = (await this.hook?.(call)) ?? 'applied';
    return {
      id: `command-${this.calls.length}`,
      ...call,
      sequence: this.calls.length,
      status,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error:
        status === 'applied'
          ? null
          : status === 'unknown'
            ? 'Результат неизвестен'
            : 'PLC отклонил действие',
    };
  }
}

const action = (
  id = 'contactor',
  deviceId = 'fcplcn-a',
  controller: WritableControllerKind = 'sockets',
  itemId = 'socket-1',
  value = true,
): SceneAction => ({ id, deviceId, controller, itemId, value });
const schedule = { enabled: true, days: [1, 3, 5], time: '18:30', timeZone: 'Asia/Novosibirsk' };
function directory() {
  return mkdtempSync(join(tmpdir(), 'fcplcn-scene-unit-'));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function idle(scenes: Scenes): Promise<SceneRun> {
  for (let attempt = 0; attempt < 200; ++attempt) {
    const snapshot = scenes.snapshot();
    if (!snapshot.activeRun) return snapshot.runs[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Scene did not complete');
}

test('exact legacy builtin descriptions migrate without changing actions or accepting arbitrary edits', async () => {
  const engine = new FakeEngine(),
    path = directory(),
    file = join(path, 'scenes.json');
  try {
    const scenes = new Scenes(engine, { directory: path });
    scenes.update('home', 1, [action()], { schedule });
    const expected = scenes.snapshot().definitions;
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.definitions.find((scene: { id: string }) => scene.id === 'home').description =
      'Снять охрану на всех PLC, затем выполнить назначенные действия.';
    stored.definitions.find((scene: { id: string }) => scene.id === 'away').description =
      'Поставить все PLC на охрану, затем выполнить назначенные действия.';
    writeFileSync(file, JSON.stringify(stored));
    const reloaded = new Scenes(engine, { directory: path });
    assert.deepEqual(reloaded.snapshot().definitions, expected);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).definitions, expected);
    assert.equal(engine.calls.length, 0, 'Description migration never runs a scene');
    stored.definitions.find((scene: { id: string }) => scene.id === 'home').description +=
      ' Изменено.';
    const invalid = JSON.stringify(stored);
    writeFileSync(file, invalid);
    assert.throws(() => new Scenes(engine, { directory: path }), /Основной режим повреждён/);
    assert.equal(readFileSync(file, 'utf8'), invalid);
    await reloaded.stop();
    await scenes.stop();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('the three modes are saved without running; real prepare remains empty', async () => {
  const engine = new FakeEngine(),
    path = directory();
  try {
    const scenes = new Scenes(engine, { directory: path });
    assert.deepEqual(
      scenes.snapshot().definitions.map((scene) => scene.name),
      ['Я дома', 'Ушел', 'Готовлюсь'],
    );
    assert.ok(
      scenes
        .snapshot()
        .definitions.every((scene) => scene.actions.length === 0 && scene.schedule === null),
    );
    assert.equal(engine.calls.length, 0);
    assert.equal(scenes.run('prepare').status, 'empty');
    assert.equal(engine.calls.length, 0);
    await scenes.stop();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('home and away include newly discovered guards, report offline targets and skip disabled modules', async () => {
  const engine = new FakeEngine();
  engine.state.devices[1].online = false;
  engine.state.devices[1].status = 'offline';
  engine.state.devices.push(device('fcplcn-disabled', false));
  const scenes = new Scenes(engine);
  assert.equal(scenes.run('home').status, 'running');
  const run = await idle(scenes);
  assert.equal(run.status, 'partial');
  assert.deepEqual(
    run.results.map((result) => result.status),
    ['applied', 'unavailable', 'skipped'],
  );
  assert.deepEqual(
    engine.calls.map((call) => call.value),
    [false],
  );
  engine.state.devices.push(device('fcplcn-new'));
  scenes.run('away');
  const away = await idle(scenes);
  assert.ok(
    away.results.some(
      (result) => result.deviceId === 'fcplcn-new' && result.value && result.status === 'applied',
    ),
  );
  assert.equal(
    engine.calls.some((call) => call.deviceId === 'fcplcn-disabled'),
    false,
  );
  await scenes.stop();
});

test('security phase precedes configured actions, preserving the saved cross-PLC order and serial dispatch', async () => {
  const engine = new FakeEngine(),
    scenes = new Scenes(engine);
  let active = 0,
    maximum = 0;
  engine.hook = async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return 'applied';
  };
  scenes.update('away', 1, [
    action('first-extra', 'fcplcn-b', 'lights', 'light-1', false),
    action('contactor', 'fcplcn-a', 'sockets', 'socket-1', false),
  ]);
  scenes.run('away');
  assert.equal((await idle(scenes)).status, 'completed');
  assert.deepEqual(
    engine.calls.map((call) => `${call.deviceId}/${call.controller}/${call.value}`),
    [
      'fcplcn-a/security/true',
      'fcplcn-b/security/true',
      'fcplcn-b/lights/false',
      'fcplcn-a/sockets/false',
    ],
  );
  assert.equal(maximum, 1);
  await scenes.stop();
});

test('custom scene CRUD is revision checked and can address security, while builtin guard targets are immutable', async () => {
  const engine = new FakeEngine(),
    scenes = new Scenes(engine);
  const custom = scenes.create('Ночной режим', 'Первый этаж', [
    action('alarm', 'fcplcn-a', 'security', 'alarm', true),
  ]);
  assert.match(custom.id, /^scene-/);
  assert.equal(custom.builtin, false);
  assert.throws(
    () => scenes.update('home', 1, [action('alarm', 'fcplcn-a', 'security', 'alarm', false)]),
    /охрана управляется/,
  );
  assert.throws(() => scenes.update('home', 1, [], { name: 'Иное' }), /фиксированы/);
  assert.throws(() => scenes.delete('home', 1), /удалить нельзя/);
  assert.throws(() => scenes.update(custom.id, custom.revision, [], { name: null }), /название/);
  const changed = scenes.update(custom.id, custom.revision, custom.actions, {
    name: 'Ночь',
    description: 'Поставить первый этаж',
  });
  assert.equal(changed.revision, 2);
  assert.throws(() => scenes.update(custom.id, 1, []), /изменился/);
  scenes.run(changed.id);
  assert.equal((await idle(scenes)).results[0].source, 'configured');
  scenes.delete(changed.id, changed.revision);
  assert.equal(scenes.snapshot().runs[0].name, 'Ночь');
  assert.throws(() => scenes.run(changed.id), /не найден/);
  await scenes.stop();
});

test('action validation rejects duplicate targets, unknown bindings, malformed states and excessive lists', async () => {
  const scenes = new Scenes(new FakeEngine());
  assert.throws(
    () => scenes.create('Bad', '', [action(), { ...action('another'), value: false }]),
    /только один раз/,
  );
  assert.throws(
    () => scenes.create('Bad', '', [action('same'), action('same', 'fcplcn-b')]),
    /только один раз/,
  );
  assert.throws(
    () => scenes.create('Bad', '', [action('missing', 'fcplcn-a', 'lights', 'missing')]),
    /существующий канал/,
  );
  assert.throws(() => scenes.create('Bad', '', [{ ...action(), value: 'toggle' }]), /состояние/);
  assert.throws(
    () => scenes.create('Bad', '', [{ ...action(), controller: 'meteo' }]),
    /состояние/,
  );
  assert.throws(
    () =>
      scenes.create(
        'Bad',
        '',
        Array.from({ length: 65 }, (_, index) => action(`a-${index}`)),
      ),
    /64/,
  );
  for (let index = 0; index < 29; ++index) scenes.create(`Scene ${index}`, '', []);
  assert.throws(() => scenes.create('Overflow', '', []), /32/);
  await scenes.stop();
});

test('schedules validate weekdays, time and IANA zone, persist and retain manual/scheduled trigger provenance', async () => {
  const engine = new FakeEngine(),
    path = directory();
  try {
    const scenes = new Scenes(engine, { directory: path });
    const custom = scenes.create('Вечер', '', [action()], schedule);
    for (const invalid of [
      { ...schedule, days: [0] },
      { ...schedule, days: [1, 1] },
      { ...schedule, days: [] },
      { ...schedule, time: '7:05' },
      { ...schedule, time: '24:00' },
      { ...schedule, timeZone: 'Missing/Zone' },
      { ...schedule, enabled: 'yes' },
    ])
      assert.throws(
        () => scenes.update(custom.id, 1, custom.actions, { schedule: invalid }),
        /расписания/,
      );
    const restored = new Scenes(engine, { directory: path });
    assert.deepEqual(
      restored.snapshot().definitions.find((scene) => scene.id === custom.id)?.schedule,
      schedule,
    );
    const scheduled = restored.run(custom.id, 'schedule');
    assert.equal(scheduled.trigger, 'schedule');
    await idle(restored);
    const clear = restored.update(custom.id, 1, custom.actions, { schedule: null });
    assert.equal(clear.schedule, null);
    await restored.stop();
    await scenes.stop();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('only one scene runs globally; stop marks in-flight unknown and never executes remaining commands', async () => {
  const engine = new FakeEngine(),
    waiting = deferred<'applied'>(),
    scenes = new Scenes(engine);
  engine.hook = async () => waiting.promise;
  const custom = scenes.create('Остановить', '', [
    action(),
    action('light', 'fcplcn-b', 'lights', 'light-1'),
  ]);
  scenes.run(custom.id);
  await Promise.resolve();
  assert.equal(engine.calls.length, 1);
  assert.throws(() => scenes.run('home'), /ещё выполняется/);
  assert.throws(() => scenes.update(custom.id, 1, []), /ещё выполняется/);
  assert.throws(() => scenes.delete(custom.id, 1), /ещё выполняется/);
  assert.throws(() => scenes.create('Busy', '', []), /ещё выполняется/);
  await scenes.stop();
  waiting.resolve('applied');
  await Promise.resolve();
  const stopped = scenes.snapshot().runs[0];
  assert.equal(stopped.status, 'interrupted');
  assert.deepEqual(
    stopped.results.map((result) => result.status),
    ['unknown', 'unavailable'],
  );
  assert.equal(engine.calls.length, 1);
});

test('a PLC reboot mid-scene rejects that captured boot without blocking other healthy devices', async () => {
  const engine = new FakeEngine(),
    scenes = new Scenes(engine);
  engine.hook = async () => {
    engine.state.devices[0].bootId = 'new-boot';
    return 'applied';
  };
  const custom = scenes.create('Reboot', '', [
    action(),
    action('light', 'fcplcn-a', 'lights', 'light-1'),
    action('other', 'fcplcn-b', 'lights', 'light-1'),
  ]);
  scenes.run(custom.id);
  const run = await idle(scenes);
  assert.equal(run.status, 'partial');
  assert.deepEqual(
    run.results.map((result) => result.status),
    ['applied', 'unavailable', 'applied'],
  );
  assert.match(run.results[1].error!, /перезапущен/);
  assert.equal(engine.calls.length, 2);
  await scenes.stop();
});

test('an uncertain command cancels remaining old-scene work even after an immediate reconnect', async () => {
  const engine = new FakeEngine(),
    scenes = new Scenes(engine);
  engine.hook = async () => {
    engine.state.broker.connected = false;
    engine.state.broker.connected = true;
    return 'unknown';
  };
  const custom = scenes.create('No replay', '', [
    action(),
    action('other', 'fcplcn-b', 'lights', 'light-1'),
  ]);
  scenes.run(custom.id);
  const run = await idle(scenes);
  assert.deepEqual(
    run.results.map((result) => result.status),
    ['unknown', 'unavailable'],
  );
  assert.equal(engine.calls.length, 1);
  await scenes.stop();
});

test('known guard refusal is visible and still permits explicitly configured later actions', async () => {
  const engine = new FakeEngine(),
    scenes = new Scenes(engine);
  engine.hook = async (call) => (call.controller === 'security' ? 'rejected' : 'applied');
  scenes.update('away', 1, [action('contactor', 'fcplcn-a', 'sockets', 'socket-1', false)]);
  scenes.run('away');
  const run = await idle(scenes);
  assert.equal(run.status, 'partial');
  assert.deepEqual(
    run.results.map((result) => result.status),
    ['rejected', 'rejected', 'applied'],
  );
  await scenes.stop();
});

test('plans are committed before dispatch and corrupt files are never replaced by defaults', async () => {
  const engine = new FakeEngine(),
    path = directory(),
    file = join(path, 'scenes.json');
  try {
    const scenes = new Scenes(engine, { directory: path });
    const custom = scenes.create('Stored', '', [action()]);
    engine.hook = async () => {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(saved.runs[0].status, 'running');
      assert.equal(saved.runs[0].results[0].status, 'pending');
      return 'applied';
    };
    scenes.run(custom.id);
    await idle(scenes);
    await scenes.stop();
    writeFileSync(file, '{broken');
    assert.throws(() => new Scenes(engine, { directory: path }), /без замены/);
    assert.equal(readFileSync(file, 'utf8'), '{broken');
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('a plan save failure refuses execution and a result save failure interrupts remaining actions', async () => {
  const engine = new FakeEngine(),
    path = directory(),
    file = join(path, 'scenes.json'),
    backup = join(path, 'saved.json');
  try {
    const scenes = new Scenes(engine, { directory: path });
    const custom = scenes.create('Storage', '', [
      action(),
      action('light', 'fcplcn-b', 'lights', 'light-1'),
    ]);
    renameSync(file, backup);
    mkdirSync(file);
    assert.throws(() => scenes.run(custom.id), /сохранить/);
    assert.equal(engine.calls.length, 0);
    assert.equal(scenes.snapshot().runs.length, 0);
    rmSync(file, { recursive: true });
    renameSync(backup, file);
    engine.hook = async () => {
      renameSync(file, backup);
      mkdirSync(file);
      return 'applied';
    };
    scenes.run(custom.id);
    const run = await idle(scenes);
    assert.equal(run.status, 'interrupted');
    assert.deepEqual(
      run.results.map((result) => result.status),
      ['applied', 'unavailable'],
    );
    assert.ok(scenes.snapshot().storageError);
    assert.equal(engine.calls.length, 1);
    rmSync(file, { recursive: true });
    renameSync(backup, file);
    const reconstructed = new Scenes(engine, { directory: path });
    assert.equal(reconstructed.snapshot().runs[0].status, 'interrupted');
    assert.equal(engine.calls.length, 1, 'Startup must not replay persisted pending actions');
    await reconstructed.stop();
    await scenes.stop();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('restoring a running journal marks pending results unknown without dispatching, with bounded history', async () => {
  const engine = new FakeEngine(),
    waiting = deferred<'applied'>(),
    path = directory();
  try {
    const scenes = new Scenes(engine, { directory: path });
    const custom = scenes.create('Interrupted', '', [
      action(),
      action('light', 'fcplcn-b', 'lights', 'light-1'),
    ]);
    engine.hook = async () => waiting.promise;
    scenes.run(custom.id);
    await Promise.resolve();
    const recovered = new Scenes(engine, { directory: path });
    assert.equal(recovered.snapshot().activeRun, null);
    assert.equal(recovered.snapshot().runs[0].status, 'interrupted');
    assert.deepEqual(
      recovered.snapshot().runs[0].results.map((result) => result.status),
      ['unknown', 'unknown'],
    );
    assert.equal(engine.calls.length, 1);
    for (let index = 0; index < 25; ++index) recovered.run('prepare');
    assert.equal(recovered.snapshot().runs.length, 20);
    await scenes.stop();
    waiting.resolve('applied');
    await recovered.stop();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test('saved schedules are optional for version-one compatibility and deleted bindings fail visibly', async () => {
  const engine = new FakeEngine(),
    path = directory(),
    file = join(path, 'scenes.json');
  try {
    const scenes = new Scenes(engine, { directory: path });
    const custom = scenes.create('Old schema', '', [action()]);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    for (const definition of stored.definitions) delete definition.schedule;
    writeFileSync(file, JSON.stringify(stored));
    const restored = new Scenes(engine, { directory: path });
    assert.ok(restored.snapshot().definitions.every((definition) => definition.schedule === null));
    delete engine.state.devices[0].controllers.sockets;
    const run = restored.run(custom.id);
    assert.equal(run.status, 'failed');
    assert.equal(run.results[0].status, 'unavailable');
    assert.equal(engine.calls.length, 0);
    await restored.stop();
    await scenes.stop();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
