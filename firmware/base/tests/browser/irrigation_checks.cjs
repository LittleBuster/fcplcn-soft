/** @file Exercise a saved PLC schedule through its real editor and the virtual clock. */
'use strict';

const assert = require('node:assert/strict');
const { fixedUtcOffsetMinutes } = require('./irrigation_mock.cjs');

async function checkIrrigation({ browser, createMock }) {
  assert.equal(fixedUtcOffsetMinutes('UTC-7'), 420);
  assert.equal(fixedUtcOffsetMinutes('MSK-3'), 180);
  assert.equal(fixedUtcOffsetMinutes('UTC+03:30'), -210);
  assert.equal(fixedUtcOffsetMinutes('GMT'), 0);
  assert.equal(fixedUtcOffsetMinutes('GMT0'), 0);
  assert.equal(fixedUtcOffsetMinutes('<+05>-05'), 300);
  for (const zone of ['UTC-99', 'UTC-4:85', 'EST5EDT,M3.2.0,M11.1.0', ''])
    assert.ok(Number.isNaN(fixedUtcOffsetMinutes(zone)), zone);
  const mock = createMock({ interactive: true });
  const { controllers } = mock;
  const { irrigation, tanks } = controllers.modules;
  const tankId = 'tank-source';
  const relayId = 'rly-0/1';
  const minutes = (time) => Date.parse('2026-11-23T' + time + ':00Z'); // Monday in the PLC calendar.
  const clock = (time) =>
    controllers.setIrrigationTime(minutes(time), minutes(time) - minutes('05:59'));
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + mock.server.address().port;
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const readings = () => irrigation.snapshot().items;
  async function waitForWater(expected) {
    const deadline = Date.now() + 2000;
    while (readings().some((row) => row.waterAvailable !== expected)) {
      if (Date.now() > deadline) assert.fail(JSON.stringify(readings()));
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  function expectOk(reply) {
    assert.equal(reply.status, 200, JSON.stringify(reply.data));
  }
  async function save() {
    const request = page.waitForResponse(
      (reply) =>
        reply.url().endsWith('/controllers/irrigation') && reply.request().method() === 'POST',
    );
    await page.locator('#irrigation-save').click();
    const reply = await request;
    assert.equal(reply.status(), 200, await reply.text());
    await page.waitForFunction(
      () => document.querySelector('#irrigation-save').getAttribute('aria-busy') === 'false',
    );
  }
  try {
    clock('05:59');
    await page.goto(base + '/#irrigation');
    await page.locator('#login-form button').click();
    await page.locator('#irrigation-enabled').click();
    await page.waitForFunction(
      () => document.querySelector('#irrigation-enabled').getAttribute('aria-pressed') === 'true',
    );
    async function addRule(name, time, duration, source = tankId) {
      await page.locator('#irrigation-add').click();
      const card = page.locator('[data-irrigation-id]').last();
      const field = (name) => card.locator('[data-irrigation-field="' + name + '"]');
      await field('name').fill(name);
      assert.equal(await field('tankId').inputValue(), '', 'A new rule uses no tank by default');
      assert.equal(await field('tankId').locator('option:checked').textContent(), 'Без бака');
      if (source) await field('tankId').selectOption(source);
      await field('relayId').selectOption(relayId);
      await field('startTime').fill(time);
      await field('durationMinutes').fill(String(duration));
      for (let day = 2; day <= 7; day++)
        await card.locator('[data-irrigation-day="' + day + '"]').uncheck();
      const id = await card.getAttribute('data-irrigation-id');
      await save();
      await card.locator('[data-irrigation-enabled]').click();
      await page.waitForFunction(
        (id) =>
          document
            .querySelector('[data-irrigation-enabled="' + id + '"]')
            .getAttribute('aria-pressed') === 'true',
        id,
      );
      return id;
    }
    const direct = await addRule('Водопровод', '06:00', 2, '');
    const directCard = page.locator('[data-irrigation-id="' + direct + '"]');
    const sourceField = directCard.locator('[data-irrigation-field="tankId"]');
    assert.equal(await sourceField.locator('option').count(), 1);
    assert.equal(await sourceField.getAttribute('required'), null);
    assert.equal(readings()[0].waterAvailable, null);
    assert.equal(readings()[0].error, null);
    await directCard.getByText('По расписанию', { exact: true }).waitFor();
    clock('06:00');
    assert.equal(readings()[0].actual, true, 'A rule opens its valve without any configured tanks');
    clock('06:02');
    assert.equal(readings()[0].valveActual, false);
    const directSettings = irrigation.exportSettings();
    delete directSettings.items[0].tankId;
    expectOk(
      await irrigation.save({ ...directSettings, baseRevision: irrigation.snapshot().revision }),
    );
    assert.equal(readings()[0].tankId, '', 'POST canonicalizes an omitted tank');
    const saved = controllers.exportSettings();
    delete saved.irrigation.items[0].tankId;
    saved.irrigation.items.push({ ...saved.irrigation.items[0], id: 'same-valve', tankId: '' });
    assert.equal(controllers.validateRestore(saved), '', 'Unguarded rules may share an output');
    saved.irrigation.items[0].tankId = null;
    assert.notEqual(
      controllers.validateRestore(saved),
      '',
      'Only a missing field or empty string skips the tank',
    );
    expectOk(
      await tanks.save({
        baseRevision: 1,
        enabled: true,
        items: [
          {
            id: tankId,
            name: 'Накопительный бак',
            pumpRelayId: '',
            valveRelayId: '',
            levelInputs: ['in-0/1', 'in-0/2'],
            fillLevel: 1,
          },
        ],
      }),
    );
    expectOk(await tanks.enabled({ id: tankId, value: true }));
    expectOk(controllers.simulateTankLevel({ id: tankId, wet: [true, false] }));
    // Rebind an open valve to the newly configured tank. Neither binding change
    // replays the active schedule minute, including when the water guard is removed.
    const nextRun = Date.parse('2026-11-30T05:59:00Z');
    controllers.setIrrigationTime(nextRun, 1_000_000);
    controllers.setIrrigationTime(nextRun + 60_000, 1_060_000);
    assert.equal(readings()[0].actual, true);
    await page.locator('#irrigation-reload').click();
    await sourceField.locator('option[value="' + tankId + '"]').waitFor({ state: 'attached' });
    await sourceField.selectOption(tankId);
    await save();
    assert.equal(readings()[0].valveActual, false);
    await waitForWater(true);
    const protectedSettings = controllers.exportSettings();
    protectedSettings.irrigation.items.push({
      ...protectedSettings.irrigation.items[0],
      id: 'unsafe-mix',
      tankId: '',
    });
    assert.notEqual(
      controllers.validateRestore(protectedSettings),
      '',
      'A shared valve cannot bypass its tank guard',
    );
    expectOk(controllers.simulateTankLevel({ id: tankId, wet: [false, false] }));
    await waitForWater(false);
    await sourceField.selectOption('');
    await save();
    assert.equal(readings()[0].valveActual, false);
    assert.equal(readings()[0].error, null);
    assert.equal(readings()[0].waterAvailable, null);
    const afterDetach = await (await context.request.get(base + '/api/v1/config/backup')).json();
    assert.equal(afterDetach.controllers.irrigation.items[0].tankId, '');
    const followingRun = nextRun + 7 * 86400000;
    controllers.setIrrigationTime(followingRun, 2_000_000);
    controllers.setIrrigationTime(followingRun + 60_000, 2_060_000);
    assert.equal(
      readings()[0].actual,
      true,
      'An unrelated dry tank does not interrupt the direct supply',
    );
    await directCard.locator('[data-irrigation-remove]').click();
    await save();
    assert.equal(
      mock.hardware.snapshot().relays.find((relay) => relay.id === relayId).value,
      false,
    );
    expectOk(controllers.simulateTankLevel({ id: tankId, wet: [true, false] }));
    const remoteId = 'fcplcn-demo-utility/tank-stock';
    const remote = {
      id: remoteId,
      name: 'Запас воды',
      deviceName: 'Котельная',
      waterAvailable: true,
    };
    clock('05:59');
    controllers.setRemoteIrrigationTanks([remote]);
    await page.locator('#irrigation-reload').click();
    const remoteRule = await addRule('Полив из котельной', '06:00', 5, remoteId);
    const remoteCard = page.locator('[data-irrigation-id="' + remoteRule + '"]');
    const remoteField = remoteCard.locator('[data-irrigation-field="tankId"]');
    assert.equal(
      await remoteField.locator('option:checked').textContent(),
      'Запас воды · Котельная',
    );
    assert.equal(
      await remoteField
        .locator('optgroup[label="На этом контроллере"] option[value="' + tankId + '"]')
        .count(),
      1,
    );
    assert.equal(
      await remoteField.locator('optgroup[label="На других контроллерах"] option:checked').count(),
      1,
    );
    controllers.setIrrigationTime(minutes('06:00') - 1000, 59_000);
    controllers.setRemoteIrrigationTanks([
      remote,
      { ...remote, id: 'fcplcn-demo-garage/tank-stock' },
    ]);
    clock('06:00');
    assert.equal(readings()[0].actual, true, 'Water reported by the selected PLC enables the run');
    controllers.setRemoteIrrigationTanks([
      { ...remote, waterAvailable: false },
      { ...remote, id: 'fcplcn-demo-garage/tank-stock' },
    ]);
    assert.equal(
      readings()[0].valveActual,
      false,
      'A wet tank with the same ID on another PLC cannot keep the valve open',
    );
    assert.equal(readings()[0].error, 'В баке нет воды');
    controllers.setRemoteIrrigationTanks([remote]);
    assert.equal(readings()[0].actual, false, 'A remote refill does not restart a cancelled run');
    controllers.setIrrigationTime(nextRun + 59_000, 1_059_000);
    controllers.setRemoteIrrigationTanks([remote], 2000);
    controllers.setIrrigationTime(nextRun + 60_000, 1_060_000);
    assert.equal(readings()[0].actual, true);
    controllers.setIrrigationTime(nextRun + 61_000, 1_061_000);
    assert.equal(
      readings()[0].valveActual,
      false,
      'The valve closes when the remote observation expires',
    );
    assert.equal(readings()[0].waterAvailable, null);
    assert.deepEqual(irrigation.snapshot().remoteTanks, [{ ...remote, waterAvailable: null }]);
    controllers.setRemoteIrrigationTanks([]);
    const remoteBackup = controllers.exportSettings();
    assert.equal(
      controllers.validateRestore(remoteBackup),
      '',
      'An offline source remains a valid backup reference',
    );
    await controllers.stageRestore(remoteBackup);
    controllers.applyRestore();
    assert.equal(readings()[0].tankId, remoteId, 'Restoring keeps the source PLC and tank IDs');
    assert.equal(readings()[0].valveActual, false);
    await page.locator('#irrigation-reload').click();
    await remoteField
      .locator('option:checked')
      .filter({ hasText: 'недоступен' })
      .waitFor({ state: 'attached' });
    assert.equal(await remoteField.inputValue(), remoteId);
    await remoteCard.locator('[data-irrigation-field="durationMinutes"]').fill('7');
    await save();
    assert.equal(readings()[0].tankId, remoteId);
    assert.equal(readings()[0].actual, false);
    await remoteCard.locator('[data-irrigation-remove]').click();
    await save();
    clock('05:59');
    const first = await addRule('Утренний полив', '06:00', 2);
    const second = await addRule('Второй полив', '06:01', 3);
    await waitForWater(true);
    assert.deepEqual(
      readings().map((row) => row.days),
      [[1], [1]],
    );
    assert.equal((await controllers.relay({ id: relayId, value: true })).status, 409);
    clock('06:00');
    assert.deepEqual(
      readings().map((row) => row.actual),
      [true, false],
    );
    assert.equal(readings()[1].valveActual, true, 'Shared valve is open for the first rule');
    expectOk(controllers.simulateTankLevel({ id: tankId, wet: [true, true] }));
    assert.equal(
      readings()[0].actual,
      true,
      'An upper contact changing cannot interrupt watering while the bottom is confirmed wet',
    );
    clock('06:01');
    assert.deepEqual(
      readings().map((row) => row.remainingSeconds),
      [60, 180],
    );
    clock('06:02');
    assert.deepEqual(
      readings().map((row) => row.actual),
      [false, true],
    );
    expectOk(controllers.simulateTankLevel({ id: tankId, wet: [false, false] }));
    await waitForWater(false);
    assert.equal(readings()[0].error, 'В баке нет воды');
    assert.deepEqual(
      readings().map((row) => row.valveActual),
      [false, false],
    );
    expectOk(controllers.simulateTankLevel({ id: tankId, wet: [true, false] }));
    await waitForWater(true);
    assert.deepEqual(
      readings().map((row) => row.actual),
      [false, false],
      'Refilling must not restart an interrupted run',
    );
    const nextMonday = Date.parse('2026-11-30T05:59:00Z');
    const advance = (wall, elapsed) =>
      controllers.setIrrigationTime(nextMonday + wall, 3_600_000 + elapsed);
    advance(0, 0);
    advance(63_000, 63_000);
    assert.equal(readings()[0].actual, false, 'A late tick does not start an elapsed minute');
    advance(120_000, 120_000);
    assert.equal(readings()[1].actual, true);
    advance(-7 * 60_000, 125_000);
    assert.equal(
      readings()[1].remainingSeconds,
      175,
      'A wall-clock correction cannot extend or abort an accepted run',
    );
    controllers.setIrrigationTime(NaN, 3_730_000);
    assert.equal(readings()[1].actual, false);
    assert.equal(readings()[1].error, 'Не установлено время PLC');
    const scheduledDay = Date.parse('2026-12-07T05:59:00Z');
    for (let minute = 0; minute <= 5; minute++)
      controllers.setIrrigationTime(scheduledDay + minute * 60_000, 8_000_000 + minute * 60_000);
    assert.deepEqual(
      readings().map((row) => row.valveActual),
      [false, false],
      'The shared valve closes when the last scheduled duration elapses',
    );
    const tuesday = Date.parse('2026-12-08T05:59:00Z');
    controllers.setIrrigationTime(tuesday, 255_000_000);
    controllers.setIrrigationTime(tuesday + 60_000, 255_060_000);
    assert.deepEqual(
      readings().map((row) => row.actual),
      [false, false],
      'A Monday rule does not open on Tuesday',
    );
    const followingMonday = Date.parse('2026-12-14T05:59:00Z');
    controllers.setIrrigationTime(followingMonday, 300_000_000);
    controllers.setIrrigationTime(followingMonday + 60_000, 300_060_000);
    assert.equal(readings()[0].actual, true);
    mock.hardware.setFaults({ relayWrite: 'Кран недоступен' });
    assert.equal(
      (await irrigation.enabled({ id: first, value: false })).status,
      503,
      'Cannot acknowledge disable until the physical valve is closed',
    );
    mock.hardware.setFaults({ relayWrite: '' });
    assert.equal(readings()[0].valveActual, false);
    expectOk(await irrigation.enabled({ id: first, value: true }));
    assert.equal(readings()[0].actual, false);
    await page.goto(base + '/?open=rule#irrigation/' + second);
    await page.locator('[data-irrigation-id="' + second + '"]').waitFor({ state: 'visible' });
    await page.waitForFunction(
      (id) => document.activeElement.id === 'irrigation-' + id + '-name',
      second,
    );
    const backup = await (await context.request.get(base + '/api/v1/config/backup')).json();
    assert.equal(backup.version, 10);
    assert.equal(backup.controllers.irrigation.items[0].id, first);
    assert.equal(
      backup.controllers.irrigation.items.some((row) => Object.hasOwn(row, 'actual')),
      false,
    );
    assert.equal(controllers.validateRestore(backup.controllers), '');
    const dangling = structuredClone(backup.controllers);
    dangling.irrigation.items[0].tankId = 'missing-tank';
    assert.notEqual(controllers.validateRestore(dangling), '');
    const legacy = structuredClone(backup);
    legacy.version = 9;
    delete legacy.controllers.irrigation;
    const restored = await context.request.post(base + '/api/v1/config/restore', {
      data: { baseRevision: mock.config.revision, document: legacy },
    });
    assert.equal(restored.status(), 200, await restored.text());
    controllers.applyRestore();
    assert.deepEqual(
      irrigation.exportSettings(),
      { enabled: false, items: [] },
      'Old backups retain tanks and safely start with no irrigation rules',
    );
    assert.equal(tanks.exportSettings().items[0].id, tankId);
    delete saved.irrigation.items[0].tankId;
    await controllers.stageRestore(saved);
    controllers.applyRestore();
    assert.deepEqual(
      irrigation.exportSettings().items.map((rule) => rule.tankId),
      ['', ''],
    );
    assert.ok(
      readings().every((row) => !row.actual && row.waterAvailable === null && row.error === null),
    );
    assert.deepEqual(errors, []);
    console.log(
      'Irrigation editor passed: optional and remote tanks, qualified IDs, freshness expiry, offline edits, safe rebinding, shared rules, weekly calendar, dry stop, no refill restart, direct link and backup.',
    );
  } finally {
    await context.close();
    controllers.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  }
}
module.exports = { checkIrrigation };
