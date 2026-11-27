/** @file Exercise real tank forms and the simulator's autonomous water/output policy. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

async function checkTanks({ browser, createMock, artifacts }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcplcn-tanks-ui-'));
  const statePath = path.join(directory, 'controllers.json');
  const mock = createMock({ interactive: true, statePath });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('dialog', (dialog) => dialog.accept());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${mock.server.address().port}`;
  const module = mock.controllers.modules.tanks;
  const post = (route, data) => context.request.post(base + '/api/v1' + route, { data });
  let id;
  const card = () => page.locator(`[data-tank-id="${id}"]`);
  const field = (name) => card().locator(`[data-tank-field="${name}"]`);
  const runtime = () => module.snapshot().items.find((item) => item.id === id);
  async function until(check) {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (Date.now() >= deadline) assert.fail(JSON.stringify(runtime()));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  async function save() {
    const pending = page.waitForResponse(
      (reply) => reply.url().endsWith('/controllers/tanks') && reply.request().method() === 'POST',
    );
    await page.locator('#tanks-save').click();
    const reply = await pending;
    assert.equal(reply.status(), 200, await reply.text());
  }
  async function saveWithBusyCheck() {
    let release;
    let intercepted;
    const released = new Promise((resolve) => (release = resolve));
    const requestStarted = new Promise((resolve) => (intercepted = resolve));
    const routePattern = '**/api/v1/controllers/tanks';
    const delayPost = async (route) => {
      if (route.request().method() === 'POST') {
        intercepted();
        await released;
      }
      await route.continue();
    };
    await page.route(routePattern, delayPost);
    const response = page.waitForResponse(
      (reply) => reply.url().endsWith('/controllers/tanks') && reply.request().method() === 'POST',
    );
    const button = page.locator('#tanks-save');
    try {
      await button.click();
      await requestStarted;
      assert.equal(await button.getAttribute('aria-busy'), 'true');
      assert.equal(await button.isDisabled(), true);
      assert.equal(await button.evaluate((node) => getComputedStyle(node).cursor), 'progress');
      release();
      const reply = await response;
      assert.equal(reply.status(), 200, await reply.text());
      await page.waitForFunction(() => {
        const save = document.querySelector('#tanks-save');
        const status = document.querySelector('[data-save-state="tanks"]');
        return (
          save.getAttribute('aria-busy') === 'false' &&
          status.textContent === 'Все изменения сохранены'
        );
      });
      assert.equal(await button.isDisabled(), true, 'A saved form has no pending changes');
      assert.ok(
        !['wait', 'progress'].includes(
          await button.evaluate((node) => getComputedStyle(node).cursor),
        ),
        'The completed save must stop displaying a waiting cursor',
      );
    } finally {
      release();
      await page.unroute(routePattern, delayPost);
    }
  }
  async function level(wet, pct, pump, valve) {
    assert.equal(mock.controllers.simulateTankLevel({ id, wet }).status, 200);
    await until(() => {
      const current = runtime();
      return (
        current.levelPct === pct && current.pumpActual === pump && current.valveActual === valve
      );
    });
    await page.locator('#tanks-reload').click();
    await page.waitForFunction(
      ({ id, pct }) =>
        document.querySelector(`[data-tank-id="${id}"] [data-tank-percentage]`)?.textContent ===
        (pct === null ? '—' : `${pct} %`),
      { id, pct },
    );
    if (pct !== null && pct > 0) {
      const y = Number(await card().locator('[data-tank-water]').getAttribute('y'));
      assert.equal(y, 185 - pct * 1.5, 'SVG water follows the confirmed discrete percentage');
    }
  }
  try {
    await page.goto(base);
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-controllers').click();
    await page.locator('#tanks-open').click();
    await page.locator('#tanks-enabled').click();
    await page.waitForFunction(
      () => document.querySelector('#tanks-enabled').getAttribute('aria-pressed') === 'true',
    );
    await page.locator('#tanks-add').click();
    id = await page.locator('[data-tank-id]').last().getAttribute('data-tank-id');
    assert.equal(await field('levelCount').inputValue(), '2');
    assert.equal(await card().locator('[data-tank-level-index]').count(), 2);
    await field('name').fill('Бак водоснабжения');
    await field('pumpRelayId').selectOption('rly-0/1');
    await field('valveRelayId').selectOption('rly-0/2');
    await saveWithBusyCheck();
    await field('name').fill('Бак водоснабжения — резерв');
    assert.equal(await page.locator('#tanks-save').isDisabled(), false);
    assert.equal(await page.locator('#tanks-save').getAttribute('aria-busy'), 'false');
    assert.equal(
      await page.locator('[data-save-state="tanks"]').textContent(),
      'Есть несохранённые изменения',
    );
    await field('name').fill('Бак водоснабжения');
    await save();
    assert.equal(
      runtime().enabled,
      false,
      'A newly configured tank starts with monitoring disabled',
    );
    await card().locator('[data-tank-enabled]').click();
    await until(() => runtime().enabled && runtime().available);
    await level([false, false], 0, false, true);
    await level([true, false], 50, true, true);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.tank-water')].some(
        (water) => getComputedStyle(water).opacity === '1',
      ),
    );
    assert.equal(await card().locator('[data-tank-error]').isVisible(), false);
    await page.screenshot({ path: path.join(artifacts, 'tanks-half-full.png'), fullPage: true });
    mock.controllers.simulateTankLevel({ id, wet: [true, true] });
    let pending = runtime();
    assert.equal(pending.available, false);
    assert.equal(pending.pumpActual, true, 'An unchanged wet bottom keeps the draining pump ON');
    assert.equal(
      pending.valveActual,
      false,
      'Wet selected level closes the fill valve immediately',
    );
    await level([true, false], 50, true, true);
    const upperContact = page.locator(
      `[data-simulator-tank="${id}"][data-simulator-tank-level="1"]`,
    );
    await upperContact.waitFor({ state: 'visible' });
    await upperContact.click();
    await until(() => runtime().levelPct === 100 && runtime().valveActual === false);
    await level([true, true], 100, true, false);
    await level([false, true], null, false, false);
    assert.match(runtime().error, /последовательность/);
    assert.deepEqual(runtime().levelsWet, [null, null]);
    await level([true, false], 50, true, true);

    const ownership = await post('/controllers/sockets', {
      baseRevision: mock.sockets.snapshot().revision,
      enabled: true,
      items: [{ id: 'occupied', name: 'Занято баком', relayId: 'rly-0/1', inputId: '' }],
    });
    assert.equal(ownership.status(), 409);
    assert.equal((await post('/hardware/relay', { id: 'rly-0/1', value: false })).status(), 409);
    const bad = { ...module.exportSettings(), baseRevision: module.snapshot().revision };
    delete bad.items[0].enabled;
    bad.items[0].levelInputs = ['in-0/1', 'in-0/1'];
    assert.equal((await post('/controllers/tanks', bad)).status(), 400);

    // Exercise handlers after reload/reconciliation has replaced draft objects.
    await field('levelCount').selectOption('3');
    await card().locator('[data-tank-level-index="2"]').selectOption('in-0/3');
    await field('fillLevel').selectOption('3');
    await save();
    assert.equal(
      runtime().enabled,
      true,
      'Configuration edits preserve the confirmed monitoring permission',
    );
    assert.deepEqual(runtime().levelInputs, ['in-0/1', 'in-0/2', 'in-0/3']);
    await level([false, false, false], 0, false, true);
    await level([true, false, false], 33, true, true);
    mock.controllers.simulateTankLevel({ id, wet: [true, true, false] });
    pending = runtime();
    assert.equal(pending.available, false);
    assert.equal(pending.pumpActual, true, 'An upper contact cannot interrupt the confirmed pump');
    assert.equal(pending.valveActual, true, 'An unchanged dry selected contact keeps filling ON');
    await level([true, true, false], 67, true, true);
    await level([true, true, true], 100, true, false);
    await field('fillLevel').selectOption('2');
    await save();
    await level([true, true, false], 67, true, false);

    mock.setHardwareFaults({ inputs: 'I/O read failed' });
    await until(
      () =>
        runtime().available === false &&
        runtime().pumpActual === false &&
        runtime().valveActual === false,
    );
    assert.equal(runtime().levelPct, null);
    assert.deepEqual(runtime().levelsWet, [null, null, null]);
    mock.setHardwareFaults({ inputs: '' });
    pending = runtime();
    assert.equal(pending.available, false, 'Fault recovery requires a new stable input baseline');
    assert.equal(pending.pumpActual, false);
    assert.equal(pending.valveActual, false);
    await until(() => runtime().available);
    await card().locator('[data-tank-enabled]').click();
    await until(
      () => !runtime().enabled && runtime().pumpActual === false && runtime().valveActual === false,
    );
    assert.equal(runtime().levelPct, null);
    await card().locator('[data-tank-enabled]').click();
    await until(() => runtime().enabled && runtime().available);

    // One PLC owns multiple independent tanks; adding a row must preserve the first.
    const firstId = id;
    const firstRuntime = () => module.snapshot().items.find((item) => item.id === firstId);
    await page.locator('#tanks-add').click();
    id = await page.locator('[data-tank-id]').last().getAttribute('data-tank-id');
    const secondId = id;
    assert.notEqual(secondId, firstId);
    assert.equal(await page.locator('[data-tank-id]').count(), 2);
    assert.deepEqual(
      await card()
        .locator('[data-tank-level-index]')
        .evaluateAll((inputs) => inputs.map((input) => input.value)),
      ['in-0/4', 'in-0/5'],
      'A second tank defaults to distinct free inputs after the first tank’s three levels',
    );
    assert.equal(
      await field('pumpRelayId').locator('option[value="rly-0/1"]').isDisabled(),
      true,
      'The first tank’s pump remains reserved while configuring the second tank',
    );
    assert.equal(
      await card().locator('[data-tank-level-index="0"] option[value="in-0/1"]').isDisabled(),
      true,
      'A second tank cannot reuse the first tank’s level contact',
    );
    await field('name').fill('Бак полива');
    await field('pumpRelayId').selectOption('rly-0/3');
    await field('valveRelayId').selectOption('rly-0/4');
    await save();
    assert.equal(module.snapshot().items.length, 2);
    assert.equal(firstRuntime().enabled, true);
    assert.equal(runtime().enabled, false);
    await card().locator('[data-tank-enabled]').click();
    await level([false, false], 0, false, true);
    assert.equal(firstRuntime().levelPct, 67);
    assert.equal(firstRuntime().pumpActual, true);
    assert.equal(firstRuntime().valveActual, false);
    await level([true, false], 50, true, true);
    id = firstId;
    await level([false, false, false], 0, false, true);
    id = secondId;
    assert.equal(runtime().levelPct, 50, 'Changing the first tank cannot alter the second level');
    assert.equal(runtime().pumpActual, true, 'The second draining pump remains independent');
    assert.equal(runtime().valveActual, true, 'The second fill valve remains independent');

    const savedTanks = module.exportSettings();
    const storedTanks = JSON.parse(fs.readFileSync(statePath, 'utf8')).controllers.tanks;
    assert.deepEqual(storedTanks.items, savedTanks.items);
    const beforeReboot = fs.readFileSync(statePath, 'utf8');
    assert.equal((await post('/reboot', {})).status(), 200);
    await page.waitForFunction(async () => {
      const reply = await fetch('/api/v1/controllers/tanks');
      return reply.status === 401;
    });
    await page.reload();
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-controllers').click();
    await page.locator('#tanks-open').click();
    await page.locator(`[data-tank-id="${secondId}"]`).waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-tank-id]').count(), 2);
    assert.equal(
      await page.locator(`[data-tank-id="${firstId}"] [data-tank-field="name"]`).inputValue(),
      'Бак водоснабжения',
    );
    assert.equal(await field('name').inputValue(), 'Бак полива');
    assert.deepEqual(module.exportSettings(), savedTanks);
    assert.equal(fs.readFileSync(statePath, 'utf8'), beforeReboot);
    const restarted = createMock({ interactive: true, statePath });
    try {
      assert.deepEqual(
        restarted.controllers.modules.tanks.exportSettings(),
        savedTanks,
        'Both tanks, independent port bindings and monitoring permissions survive process restart',
      );
    } finally {
      restarted.controllers.close();
    }
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).version, 10);
    const backup = await context.request.get(base + '/api/v1/config/backup');
    const document = await backup.json();
    assert.equal(document.version, 10);
    assert.equal(document.controllers.tanks.items.length, 2);
    assert.equal(
      document.controllers.tanks.items.every((item) => item.enabled),
      true,
    );
    assert.equal('levelPct' in document.controllers.tanks.items[0], false);
    await page.locator('#tab-system').click();
    await page.locator('#tab-controllers').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(artifacts, 'tanks-mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(
      'Tank local UI passed: confirmed save busy/cursor/footer, editing re-enables save, default2/3levels, blue SVG0/33/50/67/100, pump/valve autonomy, fault/disabledOFF, ownerclaims, two independent tanks with durable ports/monitoring across reboot/process restart, draft reload, backup and mobile.',
    );
  } finally {
    await context.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { checkTanks };
