/** @file Exercise timezone scheduling, durable claims and failure policies with an injected clock. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SceneScheduler } from '../server/scheduler.js';
import type { Scenes } from '../server/scenes.js';
import type { SceneDefinition, SceneRun, SceneSchedule, ScenesSnapshot } from '../shared/types.js';

const schedule = (time = '15:00', timeZone = 'UTC', days = [5]): SceneSchedule => ({
  enabled: true,
  time,
  timeZone,
  days,
});
const definition = (id = 'custom-test', config = schedule()): SceneDefinition => ({
  id,
  name: id,
  description: 'Проверка расписания',
  revision: 1,
  actions: [],
  schedule: config,
});
class FakeScenes {
  definitions: SceneDefinition[] = [definition()];
  activeRun: SceneRun | null = null;
  calls: { id: string; trigger: string }[] = [];
  fail: Error | null = null;
  snapshot(): ScenesSnapshot {
    return { definitions: this.definitions, activeRun: this.activeRun, runs: [] };
  }
  run(id: string, trigger = 'manual'): SceneRun {
    if (this.fail) throw this.fail;
    this.calls.push({ id, trigger });
    return {
      id: 'run-' + this.calls.length,
      sceneId: id,
      name: id,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      results: [],
      trigger: 'schedule',
    };
  }
}

/** @brief Keep the actual scheduler state machine and replace only the executor and wall clock. */
function fixture(
  t: TestContext,
  options: { directory?: string; canRun?: () => boolean; start?: string } = {},
) {
  const scenes = new FakeScenes();
  let current = new Date(options.start || '2026-11-20T14:59:00Z');
  const scheduler = new SceneScheduler(scenes as unknown as Scenes, {
    directory: options.directory,
    canRun: options.canRun,
    now: () => current,
  });
  t.after(() => scheduler.stop());
  return {
    scenes,
    scheduler,
    at(iso: string) {
      current = new Date(iso);
      scheduler.tick();
    },
  };
}

test('scheduler uses explicit Novosibirsk timezone and ISO weekday, never the host timezone', (t) => {
  const f = fixture(t);
  f.scenes.definitions = [definition('evening', schedule('22:00', 'Asia/Novosibirsk', [5]))];
  f.scheduler.start();
  f.at('2026-11-20T15:00:00Z');
  assert.deepEqual(f.scenes.calls, [{ id: 'evening', trigger: 'schedule' }]);
  assert.equal(f.scheduler.snapshot().events[0].dueAt, '2026-11-20T15:00:00.000Z');
  f.at('2026-11-20T15:00:04Z');
  assert.equal(f.scenes.calls.length, 1);
});

test('scheduler skips startup minute, nonselected weekdays and disabled schedules', (t) => {
  const f = fixture(t, { start: '2026-11-20T15:00:00Z' });
  f.scheduler.start();
  assert.equal(f.scenes.calls.length, 0);
  assert.equal(f.scheduler.snapshot().events[0].status, 'skipped');
  f.at('2026-11-20T15:00:02Z');
  f.scenes.definitions[0].schedule = schedule('15:01', 'UTC', [1]);
  f.at('2026-11-20T15:01:00Z');
  f.scenes.definitions[0].schedule = { ...schedule('15:02'), enabled: false };
  f.at('2026-11-20T15:02:00Z');
  assert.equal(f.scenes.calls.length, 0);
});

test('scheduler never catches up after a paused hub, clock jump or late first sample', (t) => {
  const f = fixture(t);
  f.scenes.definitions[0].schedule = schedule('15:03');
  f.scheduler.start();
  f.at('2026-11-20T15:03:00Z');
  assert.equal(f.scenes.calls.length, 0);
  assert.match(f.scheduler.snapshot().events[0].reason || '', /догоняющий/);
  f.scenes.definitions[0].schedule = schedule('15:04');
  f.at('2026-11-20T15:04:11Z');
  f.at('2026-11-20T15:04:12Z');
  assert.equal(f.scenes.calls.length, 0);
  assert.match(f.scheduler.snapshot().events[0].reason || '', /Поздний/);
});

test('scheduler consumes a busy minute without waiting for manual work or reconnect', (t) => {
  let available = false;
  const f = fixture(t, { canRun: () => available });
  f.scheduler.start();
  f.at('2026-11-20T15:00:00Z');
  assert.equal(f.scheduler.snapshot().events[0].status, 'skipped');
  available = true;
  f.at('2026-11-20T15:00:04Z');
  assert.equal(f.scenes.calls.length, 0);
  f.scenes.definitions[0].schedule = schedule('15:01');
  f.scenes.activeRun = {
    id: 'manual',
    sceneId: 'home',
    name: 'Я дома',
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
    results: [],
  };
  f.at('2026-11-20T15:01:00Z');
  assert.match(f.scheduler.snapshot().events[0].reason || '', /Другой сценарий/);
  f.scenes.activeRun = null;
  f.at('2026-11-20T15:01:03Z');
  assert.equal(f.scenes.calls.length, 0);
});

test('simultaneous schedules never overlap and report the skipped alternative', (t) => {
  const f = fixture(t);
  f.scenes.definitions = [definition('one'), definition('two')];
  f.scheduler.start();
  f.at('2026-11-20T15:00:00Z');
  assert.deepEqual(
    f.scenes.calls.map((call) => call.id),
    ['one'],
  );
  assert.equal(
    f.scheduler.snapshot().events.find((event) => event.sceneId === 'two')?.status,
    'skipped',
  );
});

test('durable claims are committed before dispatch and survive restart plus backward clock', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-scheduler-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = fixture(t, { directory });
  const original = f.scenes.run.bind(f.scenes);
  f.scenes.run = (id, trigger) => {
    const stored = JSON.parse(readFileSync(join(directory, 'scheduler.json'), 'utf8'));
    assert.equal(stored.claims.length, 1, 'The duplicate barrier exists before actuation');
    return original(id, trigger);
  };
  f.scheduler.start();
  f.at('2026-11-20T15:00:00Z');
  assert.equal(f.scenes.calls.length, 1);
  f.scheduler.stop();
  const restarted = fixture(t, { directory, start: '2026-11-20T15:00:03Z' });
  restarted.scheduler.start();
  restarted.at('2026-11-20T14:59:00Z');
  restarted.at('2026-11-20T15:00:00Z');
  assert.equal(restarted.scenes.calls.length, 0);
  assert.equal(
    restarted.scheduler.snapshot().events.filter((event) => event.status === 'started').length,
    1,
  );
});

test('DST backward hour does not repeat the same local date and time', (t) => {
  const f = fixture(t, { start: '2026-11-01T05:29:00Z' });
  f.scenes.definitions[0].schedule = schedule('01:30', 'America/New_York', [7]);
  f.scheduler.start();
  f.at('2026-11-01T05:30:00Z');
  assert.equal(f.scenes.calls.length, 1);
  for (let minute = 31; minute <= 90; minute++)
    f.at(new Date(Date.UTC(2026, 10, 1, 5, minute)).toISOString());
  assert.equal(f.scenes.calls.length, 1);
});

test('claim storage failure forbids all actuation, stays visible and never retries late', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'fcplcn-scheduler-fault-'));
  const directory = join(parent, 'state');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const f = fixture(t, { directory });
  f.scheduler.start();
  writeFileSync(directory, 'blocked');
  f.at('2026-11-20T15:00:00Z');
  assert.equal(f.scenes.calls.length, 0);
  assert.match(f.scheduler.snapshot().error || '', /сохранить/);
  assert.equal(f.scheduler.snapshot().events[0].status, 'error');
  rmSync(directory);
  mkdirSync(directory);
  f.at('2026-11-20T15:00:04Z');
  assert.equal(f.scenes.calls.length, 0);
  f.scenes.definitions[0].schedule = schedule('15:01');
  f.at('2026-11-20T15:01:00Z');
  assert.equal(f.scenes.calls.length, 1);
  assert.equal(f.scheduler.snapshot().error, null);
});

test('corrupt stored claims fail closed until repaired, without stale execution', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fcplcn-scheduler-corrupt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'scheduler.json'), '{broken');
  const f = fixture(t, { directory });
  f.scheduler.start();
  f.at('2026-11-20T15:00:00Z');
  assert.equal(f.scenes.calls.length, 0);
  assert.match(f.scheduler.snapshot().error || '', /прочитать/);
  writeFileSync(
    join(directory, 'scheduler.json'),
    JSON.stringify({ version: 1, claims: [], events: [] }),
  );
  f.at('2026-11-20T15:00:03Z');
  assert.equal(f.scenes.calls.length, 0);
  f.scenes.definitions[0].schedule = schedule('15:01');
  f.at('2026-11-20T15:01:00Z');
  assert.equal(f.scenes.calls.length, 1);
});

test('a rejected dispatch is recorded once and stop cancels future scheduling', (t) => {
  const f = fixture(t);
  f.scenes.fail = new Error('Сценарий занят');
  f.scheduler.start();
  f.at('2026-11-20T15:00:00Z');
  assert.equal(f.scheduler.snapshot().events[0].status, 'error');
  assert.match(f.scheduler.snapshot().events[0].reason || '', /занят/);
  f.scenes.fail = null;
  f.at('2026-11-20T15:00:01Z');
  assert.equal(f.scenes.calls.length, 0);
  f.scheduler.stop();
  f.scenes.definitions[0].schedule = schedule('15:01');
  f.at('2026-11-20T15:01:00Z');
  assert.equal(f.scenes.calls.length, 0);
  assert.equal(f.scheduler.snapshot().running, false);
});
