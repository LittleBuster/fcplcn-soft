import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ActivityJournal } from '../server/activity-journal.js';
import { connectionHistory, connectionHistoryRange } from '../server/connection-history.js';
import { HubDatabase } from '../server/database.js';
import type { DeviceOutage } from '../shared/activity.js';
import type { CommandView } from '../shared/types.js';

const url = process.env.FCPLCN_HUB_TEST_DATABASE_URL;

test(
  'PostgreSQL preserves PLC confirmations and closes a pre-restart outage',
  { skip: !url },
  async () => {
    if (!url) return;
    const schema = 'activity_test_' + randomBytes(8).toString('hex');
    const admin = new HubDatabase(url);
    const database = new HubDatabase(url, { schema });
    let journal: ActivityJournal | undefined;
    const command: CommandView = {
      id: randomUUID(),
      deviceId: 'fcplcn-garage',
      deviceName: 'Гараж',
      controller: 'lights',
      itemId: 'entrance',
      value: true,
      sequence: 1,
      status: 'pending',
      actor: { source: 'telegram', name: 'Алексей', id: '12345' },
      sceneRunId: randomUUID(),
      createdAt: '2026-11-27T17:00:00.000Z',
      completedAt: null,
      error: null,
    };
    const pending = { ...command, id: randomUUID(), sequence: 2 };
    const applied = {
      ...command,
      status: 'applied' as const,
      completedAt: '2026-11-27T17:00:01.000Z',
    };
    const outage: DeviceOutage = {
      id: randomUUID(),
      deviceId: command.deviceId,
      deviceName: 'Гараж',
      offlineAt: '2026-11-27T17:05:00.000Z',
      onlineAt: null,
      reason: 'timeout',
    };
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      journal = await ActivityJournal.open(database);
      await journal.commandStarted(command);
      await journal.commandStarted(pending);
      await journal.commandFinished(applied);
      journal.outageChanged(outage);
      await journal.close();
      journal = await ActivityJournal.open(database);

      assert.deepEqual(
        journal.commands.find(({ id }) => id === command.id),
        applied,
      );
      const interrupted = journal.commands.find(({ id }) => id === pending.id);
      assert.equal(interrupted?.status, 'unknown');
      assert.ok(interrupted.completedAt);
      assert.deepEqual(interrupted.actor, pending.actor);
      assert.deepEqual(journal.outages, [outage]);

      const recovered = { ...outage, onlineAt: '2026-11-27T17:15:00.000Z' };
      journal.outageChanged(recovered);
      await journal.close();
      // Delayed duplicate notifications cannot reopen a completed episode.
      journal.outageChanged(outage);
      await journal.close();
      journal = await ActivityJournal.open(database);
      assert.deepEqual(journal.outages, [recovered]);
      assert.equal(journal.commands.length, 2);
    } finally {
      await journal?.close();
      await database.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.close();
    }
  },
);

test(
  'PostgreSQL connection history reads past the journal limit and across the time boundary',
  {
    skip: !url,
  },
  async () => {
    if (!url) return;
    const schema = 'activity_test_' + randomBytes(8).toString('hex');
    const admin = new HubDatabase(url);
    const database = new HubDatabase(url, { schema });
    const now = Date.parse('2026-11-28T08:11:07.123Z');
    const range = connectionHistoryRange('day', now);
    const from = Date.parse(range.from);
    const deviceId = 'fcplcn-garage';
    const record = (start: number, end: number | null, id = deviceId): DeviceOutage => ({
      id: randomUUID(),
      deviceId: id,
      deviceName: id,
      offlineAt: new Date(start).toISOString(),
      onlineAt: end === null ? null : new Date(end).toISOString(),
      reason: 'timeout',
    });
    const crossing = record(from - 600, from + 100);
    const atBoundary = record(from - 1000, from);
    const oldOpen = record(from - 800_000_000, null, 'fcplcn-open');
    const retired = record(from + 1000, from + 1500, 'fcplcn-retired');
    const distant = record(now + 60_000, null);
    const recent = Array.from({ length: 105 }, (_, i) =>
      record(now - 200_000 + i * 1000, now - 199_900 + i * 1000),
    );
    let journal: ActivityJournal | undefined;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      journal = await ActivityJournal.open(database);
      for (const outage of [atBoundary, crossing, oldOpen, retired, distant, ...recent]) {
        journal.outageChanged(outage);
      }
      await journal.close();
      journal = await ActivityJournal.open(database);
      assert.equal(
        journal.outages.some(({ id }) => id === crossing.id),
        false,
      );
      assert.equal(
        journal.outages.some(({ id }) => id === retired.id),
        false,
      );
      const read = async (id: string | null) =>
        connectionHistory(id, range, await journal!.readConnectionOutages(id, range.from, range.to))
          .outages;
      assert.deepEqual(await read(deviceId), [crossing, ...recent]);
      assert.deepEqual(await read(oldOpen.deviceId), [oldOpen]);
      assert.deepEqual(await read(null), [oldOpen, crossing, retired, ...recent]);

      const restored = { ...oldOpen, onlineAt: new Date(now - 50).toISOString() };
      journal.outageChanged(restored);
      assert.deepEqual(await read(oldOpen.deviceId), [restored]);
      assert.deepEqual(await read(null), [restored, crossing, retired, ...recent]);
    } finally {
      await journal?.close();
      await database.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.close();
    }
  },
);
