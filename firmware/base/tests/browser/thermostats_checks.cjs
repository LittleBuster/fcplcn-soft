/**
 * @file thermostats_checks.cjs
 * @brief Exercise autonomous thermostat thresholds, enabled flags, inputs, and fault policies.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function checkThermostats({ browser, createMock, artifacts }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcplcn-thermostats-ui-'));
  const statePath = path.join(directory, 'controllers.json');
  const mock = createMock({ interactive: true, statePath });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('dialog', (dialog) => dialog.accept());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${mock.server.address().port}`;
  const post = (route, data) => context.request.post(`${url}/api/v1${route}`, { data });
  const row = (id) => page.locator(`[data-thermostat-id="${id}"]`);
  const field = (id, name) => row(id).locator(`[data-thermostat-field="${name}"]`);
  const state = (id) => mock.thermostats.snapshot().items.find((item) => item.id === id);
  const settings = () => mock.thermostats.exportSettings();
  const editItems = () => settings().items.map(({ enabled, ...item }) => item);
  const modeButton = (id) => row(id).locator('[data-thermostat-enabled]');
  async function setEnabled(id, value) {
    assert.equal((await post('/controllers/thermostats/enabled', { id, value })).status(), 200);
    if (value) mock.controllers.advanceThermostatTime(60001);
  }
  async function uiEnabled(id, value) {
    await page.waitForFunction(
      ({ id, value }) =>
        document
          .querySelector(`[data-thermostat-id="${id}"] [data-thermostat-enabled]`)
          ?.getAttribute('aria-pressed') === String(!value),
      { id, value },
    );
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith('/controllers/thermostats/enabled') &&
        response.request().method() === 'POST',
    );
    await modeButton(id).click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(
      ({ id, value }) =>
        document
          .querySelector(`[data-thermostat-id="${id}"] [data-thermostat-enabled]`)
          ?.getAttribute('aria-pressed') === String(value),
      { id, value },
    );
    if (value) mock.controllers.advanceThermostatTime(60001);
  }
  async function keyboardEnabled(id, key, value) {
    const response = page.waitForResponse(
      (reply) =>
        reply.url().endsWith('/controllers/thermostats/enabled') &&
        reply.request().method() === 'POST',
    );
    await modeButton(id).focus();
    await modeButton(id).press(key);
    assert.equal((await response).status(), 200);
    await page.waitForFunction(
      ({ id, value }) =>
        document
          .querySelector(`[data-thermostat-id="${id}"] [data-thermostat-enabled]`)
          ?.getAttribute('aria-pressed') === String(value),
      { id, value },
    );
    if (value) mock.controllers.advanceThermostatTime(60001);
  }
  async function login() {
    await page.goto(url);
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-controllers').click();
  }
  async function save() {
    const reply = page.waitForResponse(
      (response) =>
        response.url().endsWith('/controllers/thermostats') &&
        response.request().method() === 'POST',
    );
    await page.locator('#thermostats-save').click();
    const response = await reply;
    assert.equal(response.status(), 200);
    assert.equal(
      response
        .request()
        .postDataJSON()
        .items.some((item) => 'enabled' in item),
      false,
      'Config save omits the independently confirmed mode flag',
    );
  }
  async function add(name, relay, mode, target, gap) {
    await page.locator('#thermostats-add').click();
    const id = await page.locator('[data-thermostat-id]').last().getAttribute('data-thermostat-id');
    await field(id, 'name').fill(name);
    await field(id, 'meteoId').selectOption('room');
    await field(id, 'relayId').selectOption(relay);
    await field(id, 'mode').selectOption(mode);
    await field(id, 'setpointC').fill(String(target));
    await field(id, 'hysteresisC').selectOption(String(gap));
    assert.equal(await field(id, 'minOnSeconds').count(), 0);
    assert.equal(await field(id, 'minOffSeconds').count(), 0);
    assert.equal(
      await row(id).evaluate((card) => card.firstElementChild.matches('button.controller-visual')),
      true,
      'The large SVG control comes before the heading and settings',
    );
    assert.equal(await modeButton(id).isDisabled(), true, 'Unsaved thermostat cannot be toggled');
    assert.equal(
      await modeButton(id).locator('.controller-visual-icon').getAttribute('data-icon'),
      mode,
    );
    assert.equal(await row(id).locator('button[data-thermostat-enabled]').count(), 1);
    assert.equal(
      await modeButton(id).locator('[data-thermostat-temperature]').count(),
      1,
      'Current temperature appears in the main visual',
    );
    assert.equal(await modeButton(id).locator('[data-thermostat-target]').count(), 1);
    await assertParameterRow(id);
    return id;
  }
  async function assertParameterRow(id) {
    const setpoint = await field(id, 'setpointC').boundingBox();
    const hysteresis = await field(id, 'hysteresisC').boundingBox();
    assert.ok(setpoint && hysteresis);
    assert.ok(Math.abs(setpoint.y - hysteresis.y) < 2, 'Setpoint and hysteresis share one row');
    assert.ok(setpoint.x + setpoint.width <= hysteresis.x + 1, 'Parameter controls do not overlap');
  }
  async function configureMeteo(items, enabled = true) {
    assert.equal(
      (
        await post('/controllers/meteo', {
          baseRevision: mock.meteo.snapshot().revision,
          enabled,
          items,
        })
      ).status(),
      200,
    );
  }
  function temperature(value, options) {
    mock.setMeteoTemperature('room', value, options);
    mock.controllers.advanceThermostatTime(60001);
  }
  try {
    await login();
    assert.equal(await page.locator('[data-controller-id]').count(), 7);
    assert.deepEqual(settings(), { enabled: false, items: [] });
    assert.equal(
      (
        await post('/controllers/sockets', {
          baseRevision: 1,
          enabled: false,
          items: [
            { id: 'reserved', name: 'Розетка резерв', relayId: 'rly-0/1', inputId: 'in-0/1' },
          ],
        })
      ).status(),
      200,
    );
    const sources = [
      { id: 'room', name: 'Комната', portId: 'sens-0/1', sensorType: 'dht22', address: '' },
      { id: 'outside', name: 'Улица', portId: 'sens-0/2', sensorType: 'dht22', address: '' },
    ];
    await configureMeteo(sources);
    const enabled = page.waitForResponse(
      (response) =>
        response.url().endsWith('/controllers/thermostats') &&
        response.request().method() === 'POST',
    );
    await page.locator('#thermostats-tile-enabled').click();
    assert.equal((await enabled).status(), 200);
    assert.equal(
      await page.locator('#controllers-list-view').isVisible(),
      true,
      'Tile switch must not navigate',
    );
    await page.locator('#thermostats-open').click();
    const heat = await add('Отопление', 'rly-0/2', 'heating', 22, 2);
    assert.equal(await field(heat, 'hysteresisC').evaluate((node) => node.tagName), 'SELECT');
    assert.deepEqual(
      await field(heat, 'hysteresisC')
        .locator('option')
        .evaluateAll((nodes) => nodes.map((node) => Number(node.value))),
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    assert.equal(
      await field(heat, 'relayId').locator('option[value="rly-0/1"]').isDisabled(),
      true,
      'Disabled modules reserve outputs',
    );
    assert.match(
      await field(heat, 'relayId').locator('option[value="rly-0/1"]').textContent(),
      /Розетк|резерв/i,
    );
    await field(heat, 'inputId').selectOption('in-0/3');
    const cool = await add('Охлаждение', 'rly-0/3', 'cooling', 24, 2);
    assert.equal(
      await field(cool, 'meteoId').locator('option[value="room"]').isDisabled(),
      false,
      'Temperature references are shared',
    );
    assert.equal(
      await field(cool, 'relayId').locator('option[value="rly-0/2"]').isDisabled(),
      true,
      'Unsaved relay claims are exclusive',
    );
    assert.equal(
      await field(heat, 'relayId').locator('option[value="rly-0/2"]').isDisabled(),
      false,
      'Own selected output stays selectable',
    );
    assert.equal(
      await field(cool, 'inputId').locator('option[value="in-0/1"]').isDisabled(),
      true,
      'Other disabled modules reserve inputs',
    );
    assert.equal(
      await field(cool, 'inputId').locator('option[value="in-0/3"]').isDisabled(),
      true,
      'Draft thermostat input claims are exclusive',
    );
    await save();
    assert.deepEqual(
      mock.thermostats.snapshot().items.map((item) => item.enabled),
      [false, false],
      'New thermostat modes default OFF',
    );
    temperature(20);
    assert.equal(state(heat).actual, false);
    const modeRevision = mock.thermostats.snapshot().revision;
    mock.controllers.simulateInput({ id: 'in-0/3', pressed: true });
    await page.waitForTimeout(70);
    assert.equal(state(heat).enabled, true, 'An arrival button enables an OFF thermostat');
    mock.controllers.advanceThermostatTime(60001);
    assert.equal(state(heat).actual, true);
    mock.controllers.tick(Date.now() + 10000);
    assert.equal(state(heat).enabled, true, 'A held LOW never toggles twice');
    mock.controllers.simulateInput({ id: 'in-0/3', pressed: false });
    await page.waitForTimeout(380);
    assert.equal(state(heat).enabled, true, 'Release never toggles mode');
    mock.controllers.simulateInput({ id: 'in-0/3', pressed: true });
    await page.waitForTimeout(70);
    assert.equal(state(heat).enabled, false);
    assert.equal(state(heat).actual, false);
    mock.controllers.simulateInput({ id: 'in-0/3', pressed: false });
    await page.waitForTimeout(380);
    mock.thermostats.setFaults({ enabledDelayMs: 250 });
    const enableReply = page.waitForResponse(
      (response) =>
        response.url().endsWith('/controllers/thermostats/enabled') &&
        response.request().method() === 'POST',
    );
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`[data-thermostat-id="${id}"] [data-thermostat-enabled]`)
          ?.getAttribute('aria-pressed') === 'false',
      heat,
    );
    await modeButton(heat).locator('.controller-visual-icon').click();
    assert.equal(await modeButton(heat).getAttribute('aria-busy'), 'true');
    assert.equal(
      await modeButton(heat).isDisabled(),
      true,
      'One pending command disables the visual',
    );
    assert.equal(await modeButton(heat).getAttribute('data-state'), 'off');
    assert.equal(
      await modeButton(heat).getAttribute('aria-pressed'),
      'false',
      'No optimistic mode confirmation',
    );
    assert.equal((await enableReply).status(), 200);
    mock.thermostats.setFaults({ enabledDelayMs: 0 });
    await uiEnabled(cool, true);
    await keyboardEnabled(heat, 'Space', false);
    await keyboardEnabled(heat, 'Enter', true);
    assert.equal(
      mock.thermostats.snapshot().revision,
      modeRevision,
      'Mode commands and physical buttons do not change config revision',
    );
    assert.match(
      await row(heat).locator('[data-thermostat-thresholds]').textContent(),
      /T ≤ 20\.0.*T ≥ 22\.0/,
    );
    assert.match(
      await row(cool).locator('[data-thermostat-thresholds]').textContent(),
      /T ≥ 26\.0.*T ≤ 24\.0/,
    );
    assert.equal(
      (
        await post('/controllers/thermostats', {
          baseRevision: modeRevision,
          enabled: true,
          items: settings().items,
        })
      ).status(),
      400,
      'Config endpoint rejects runtime enabled flags',
    );
    const diskBefore = fs.readFileSync(statePath, 'utf8');
    for (const [value, heatOn, coolOn] of [
      [20, true, false],
      [21, true, false],
      [22, false, false],
      [26, false, true],
      [25, false, true],
      [24, false, false],
    ]) {
      temperature(value);
      assert.equal(state(heat).state, heatOn, `Heating at ${value}`);
      assert.equal(state(cool).state, coolOn, `Cooling at ${value}`);
    }
    assert.equal(
      fs.readFileSync(statePath, 'utf8'),
      diskBefore,
      'Automatic demand changes never write durable state',
    );
    assert.equal('state' in JSON.parse(diskBefore).controllers.thermostats.items[0], false);
    assert.equal(
      (await post('/controllers/thermostats/state', { id: heat, value: true })).status(),
      404,
    );
    assert.equal((await post('/hardware/relay', { id: 'rly-0/2', value: true })).status(), 409);
    for (const gap of [0, 0.5, 21])
      assert.equal(
        (
          await post('/controllers/thermostats', {
            baseRevision: mock.thermostats.snapshot().revision,
            enabled: true,
            items: editItems().map((item) => ({ ...item, hysteresisC: gap })),
          })
        ).status(),
        400,
      );
    assert.equal(
      (
        await post('/controllers/thermostats', {
          baseRevision: mock.thermostats.snapshot().revision,
          enabled: true,
          items: [{ ...editItems()[0], meteoId: 'not-saved' }],
        })
      ).status(),
      400,
    );
    assert.equal(
      (
        await post('/controllers/lights', {
          baseRevision: 1,
          enabled: false,
          items: [{ id: 'collision', name: 'Коллизия', relayId: 'rly-0/2', inputId: '' }],
        })
      ).status(),
      409,
    );
    assert.equal(
      (
        await post('/controllers/lights', {
          baseRevision: 1,
          enabled: false,
          items: [
            { id: 'collision', name: 'Коллизия входа', relayId: 'rly-0/4', inputId: 'in-0/3' },
          ],
        })
      ).status(),
      409,
    );
    temperature(20);
    await field(heat, 'setpointC').fill('23');
    await save();
    temperature(21.5);
    assert.equal(state(heat).state, true, 'Setpoint-only edit retains demand inside the new band');
    await field(heat, 'setpointC').fill('24.5');
    assert.equal(
      await modeButton(heat).isDisabled(),
      true,
      'A dirty row cannot apply its mode to a different pending binding',
    );
    await uiEnabled(cool, false);
    await uiEnabled(cool, true);
    assert.equal(
      await field(heat, 'setpointC').inputValue(),
      '24.5',
      'Changing another row mode preserves this row draft',
    );
    await setEnabled(heat, false);
    await page.waitForTimeout(1100);
    assert.equal(
      await field(heat, 'setpointC').inputValue(),
      '24.5',
      'Polling retains unsaved thermostat draft',
    );
    await field(heat, 'setpointC').fill('23');
    await save();
    assert.equal(
      state(heat).enabled,
      false,
      'Saving an older config draft preserves an external mode change',
    );
    await setEnabled(heat, true);
    temperature(20);
    mock.setHardwareFaults({ inputs: 'Симулированный отказ входов' });
    mock.controllers.tick();
    assert.equal(state(heat).inputAvailable, false);
    assert.equal(state(heat).inputLevel, null);
    assert.ok(state(heat).inputError);
    assert.equal(state(heat).actual, true, 'An input fault does not stop healthy thermoregulation');
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`[data-thermostat-id="${id}"] [data-thermostat-input-status]`)
          .textContent.includes('Симулированный отказ'),
      heat,
    );
    assert.equal(
      await modeButton(heat).isDisabled(),
      false,
      'An input fault does not block manual mode changes',
    );
    mock.setHardwareFaults({ inputs: '' });
    mock.controllers.tick();
    mock.setMeteoFault('sens-0/1', 'Симулированный обрыв');
    mock.controllers.tick();
    assert.equal(state(heat).state, false);
    assert.equal(state(heat).actual, false);
    assert.equal(state(heat).temperatureC, null);
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(`[data-thermostat-id="${id}"] [data-thermostat-status]`)
          .textContent.includes('Датчик недоступен'),
      heat,
    );
    assert.equal(
      await modeButton(heat).getAttribute('data-state'),
      'unknown',
      'A sensor fault removes the active illustration without changing the saved permission',
    );
    assert.equal(await modeButton(heat).getAttribute('aria-pressed'), 'true');
    mock.setMeteoFault('sens-0/1', '');
    temperature(22);
    assert.equal(state(heat).state, false, 'Recovery inside band starts OFF');
    temperature(20);
    assert.equal(state(heat).state, true);
    temperature(20, { ageMs: 15001 });
    assert.equal(state(heat).state, false, 'Stale local measurements force OFF');
    temperature(22);
    assert.equal(state(heat).state, false);
    temperature(20);
    assert.equal(state(heat).state, true);
    await configureMeteo(sources, false);
    assert.equal(state(heat).state, false);
    await configureMeteo(sources);
    temperature(20);
    assert.equal(state(heat).state, true);
    await configureMeteo(
      sources.map((source) => ({ ...source, name: `${source.name} переименована` })),
    );
    assert.equal(state(heat).state, true, 'Meteo name-only edit preserves demand');
    const reboundSources = sources.map((source) =>
      source.id === 'room' ? { ...source, portId: 'sens-0/3' } : source,
    );
    await configureMeteo(reboundSources);
    assert.equal(state(heat).state, false, 'New physical source waits for post-change sample');
    temperature(20);
    assert.equal(state(heat).state, true);
    await field(heat, 'mode').selectOption('cooling');
    await save();
    temperature(24);
    assert.equal(state(heat).state, false, 'Mode change starts OFF in its hysteresis band');
    temperature(25);
    assert.equal(state(heat).state, true);
    temperature(23);
    assert.equal(state(heat).state, false);
    await field(heat, 'mode').selectOption('heating');
    await save();
    temperature(20);
    await page.waitForFunction(
      (id) =>
        document.querySelector(`[data-thermostat-id="${id}"] [data-thermostat-status]`)
          .textContent === 'Нагрев',
      heat,
    );
    const beforeFailure = settings();
    mock.thermostats.setFaults({ save: 'Симулированная ошибка NVS' });
    assert.equal(
      (
        await mock.thermostats.save({
          baseRevision: mock.thermostats.snapshot().revision,
          enabled: true,
          items: editItems().map((item) => ({ ...item, name: `${item.name} новая` })),
        })
      ).status,
      503,
    );
    assert.deepEqual(settings(), beforeFailure);
    assert.equal(state(heat).actual, false);
    assert.equal(
      state(heat).state,
      false,
      'Failed settings commit never restores an old ON command',
    );
    assert.equal(state(heat).sensorAvailable, false);
    mock.thermostats.setFaults({ save: '' });
    mock.controllers.tick();
    mock.controllers.advanceThermostatTime(60001);
    assert.equal(
      state(heat).state,
      true,
      'Next control step recomputes demand from the still-fresh cache',
    );
    await page.route('**/api/v1/controllers', async (route) => {
      const response = await route.fetch(),
        body = await response.json();
      assert.equal(
        Number.isFinite(body.meteo.items.find((item) => item.id === 'room').temperatureC),
        true,
      );
      const item = body.thermostats.items.find((item) => item.id === heat);
      Object.assign(item, {
        temperatureC: null,
        sensorAvailable: false,
        available: false,
        state: false,
        actual: false,
        error: 'Ожидается новое измерение',
      });
      await route.fulfill({ response, json: body });
    });
    await page.waitForFunction(
      (id) =>
        document.querySelector(`[data-thermostat-id="${id}"] [data-thermostat-temperature]`)
          .textContent === 'Нет данных',
      heat,
    );
    assert.match(
      await row(heat).locator('[data-thermostat-status]').textContent(),
      /Датчик недоступен/,
    );
    await page.unroute('**/api/v1/controllers');
    await page.waitForFunction(
      (id) =>
        document.querySelector(`[data-thermostat-id="${id}"] [data-thermostat-temperature]`)
          .textContent === '20.0 °C',
      heat,
    );
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({
      path: path.join(artifacts, 'thermostats-desktop.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 390, height: 900 });
    await assertParameterRow(heat);
    await page.setViewportSize({ width: 320, height: 900 });
    await assertParameterRow(heat);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({
      path: path.join(artifacts, 'thermostats-narrow.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({
      path: path.join(artifacts, 'thermostats-mobile.png'),
      fullPage: true,
      animations: 'disabled',
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    assert.equal((await post('/__unused', {})).status(), 404);
    const demo = await context.request.post(`${url}/__simulator/temperature`, {
      data: { id: 'room', temperatureC: 20.1 },
    });
    assert.equal(demo.status(), 200);
    await configureMeteo([sources[1]]);
    assert.equal(state(heat).state, false);
    assert.equal(state(heat).sensorAvailable, false);
    const dangling = (await (await context.request.get(`${url}/api/v1/config/backup`)).json())
      .controllers;
    assert.equal(
      mock.controllers.validateRestore(dangling),
      '',
      'A dangling reference is a durable fault, not lost configuration',
    );
    await page.waitForFunction(
      (id) =>
        document.querySelector(
          `[data-thermostat-id="${id}"] [data-thermostat-field="meteoId"] option[value="room"]`,
        )?.disabled === true,
      heat,
    );
    assert.equal(await field(heat, 'meteoId').inputValue(), 'room');
    await field(heat, 'name').fill('Ожидает датчик');
    await save();
    await field(heat, 'meteoId').selectOption('outside');
    await save();
    mock.setMeteoTemperature('outside', 20);
    mock.controllers.advanceThermostatTime(60001);
    assert.equal(state(heat).state, true, 'Choosing an existing saved source restores regulation');
    const perFlags = mock.thermostats.snapshot().items.map((item) => item.enabled);
    const masterOff = page.waitForResponse(
      (response) =>
        response.url().endsWith('/controllers/thermostats') &&
        response.request().method() === 'POST',
    );
    await page.locator('#thermostats-enabled').click();
    assert.equal((await masterOff).status(), 200);
    assert.deepEqual(
      mock.thermostats.snapshot().items.map((item) => item.enabled),
      perFlags,
      'Master OFF preserves per-thermostat modes',
    );
    assert.equal(state(heat).actual, false);
    await uiEnabled(heat, false);
    assert.equal(
      state(heat).enabled,
      false,
      'The row mode is configurable while the master is OFF',
    );
    mock.controllers.simulateInput({ id: 'in-0/3', pressed: true });
    await page.waitForTimeout(70);
    assert.equal(state(heat).enabled, false, 'Master OFF ignores button presses');
    const masterOn = page.waitForResponse(
      (response) =>
        response.url().endsWith('/controllers/thermostats') &&
        response.request().method() === 'POST',
    );
    await page.locator('#thermostats-enabled').click();
    assert.equal((await masterOn).status(), 200);
    assert.equal(state(heat).enabled, false, 'LOW at activation is a baseline, not a press');
    mock.controllers.simulateInput({ id: 'in-0/3', pressed: false });
    await page.waitForTimeout(100);
    mock.controllers.simulateInput({ id: 'in-0/3', pressed: true });
    await page.waitForTimeout(70);
    assert.equal(state(heat).enabled, true);
    mock.controllers.simulateInput({ id: 'in-0/3', pressed: false });
    await page.waitForTimeout(380);
    mock.thermostats.setFaults({ enabled: 'Симулированная ошибка режима NVS' });
    assert.equal(
      (await post('/controllers/thermostats/enabled', { id: heat, value: false })).status(),
      503,
    );
    assert.equal(state(heat).enabled, true);
    assert.equal(state(heat).inhibited, true);
    assert.equal(state(heat).actual, false);
    mock.controllers.tick();
    assert.equal(state(heat).actual, false, 'Failed mode persistence inhibits future automatic ON');
    const inhibitedEdit = await mock.thermostats.save({
      baseRevision: mock.thermostats.snapshot().revision,
      enabled: true,
      items: editItems(),
    });
    assert.equal(inhibitedEdit.status, 200);
    assert.equal(
      state(heat).inhibited,
      true,
      'Ordinary config edits do not clear the safety inhibit',
    );
    mock.controllers.simulateInput({ id: 'in-0/3', pressed: true });
    await page.waitForTimeout(70);
    assert.equal(state(heat).inhibited, true);
    mock.thermostats.setFaults({ enabled: '' });
    mock.controllers.tick(Date.now() + 10000);
    assert.equal(
      state(heat).inhibited,
      true,
      'The same held LOW does not retry a failed mode save',
    );
    mock.controllers.simulateInput({ id: 'in-0/3', pressed: false });
    await page.waitForTimeout(380);
    mock.controllers.simulateInput({ id: 'in-0/3', pressed: true });
    await page.waitForTimeout(70);
    assert.equal(state(heat).inhibited, false);
    assert.equal(state(heat).enabled, false, 'A new successful button command clears inhibit');
    mock.controllers.simulateInput({ id: 'in-0/3', pressed: false });
    await page.waitForTimeout(380);
    await setEnabled(heat, true);
    assert.equal(state(heat).inhibited, false);
    assert.equal(
      state(heat).actual,
      true,
      'An explicit successful same-value command clears inhibit',
    );
    await setEnabled(cool, false);
    await setEnabled(heat, false);
    mock.thermostats.setFaults({ enabled: 'Ошибка записи включения' });
    assert.equal(
      (await post('/controllers/thermostats/enabled', { id: heat, value: true })).status(),
      503,
    );
    assert.equal(state(heat).enabled, false);
    assert.equal(state(heat).inhibited, true);
    assert.equal(state(heat).actual, false, 'An uncommitted enable never energizes the output');
    mock.thermostats.setFaults({ enabled: '' });
    await setEnabled(heat, true);
    mock.hardware.setInputLevel('in-0/3', false);
    mock.controllers.reboot();
    assert.equal(state(heat).enabled, true);
    mock.controllers.tick(Date.now() + 10000);
    assert.equal(state(heat).enabled, true, 'A held LOW at boot does not toggle the saved mode');
    mock.controllers.simulateInput({ id: 'in-0/3', pressed: false });
    await page.waitForTimeout(100);
    assert.equal(state(heat).enabled, true, 'The first release after boot is only a baseline');
    const beforeBoot = fs.readFileSync(statePath, 'utf8');
    const reboot = await post('/reboot', {});
    assert.equal(reboot.status(), 200);
    await page.waitForTimeout(1150);
    assert.equal(state(heat).state, false, 'Boot never restores automatic ON demand');
    await login();
    await page.locator('#thermostats-open').click();
    assert.equal(await field(heat, 'meteoId').inputValue(), 'outside');
    assert.equal(
      fs.readFileSync(statePath, 'utf8'),
      beforeBoot,
      'Boot does not rewrite controller storage',
    );
    mock.setMeteoTemperature('outside', 20);
    mock.controllers.advanceThermostatTime(60001);
    assert.equal(state(heat).state, true);
    const restarted = createMock({ statePath });
    try {
      assert.equal(restarted.thermostats.snapshot().items[0].state, false);
      assert.deepEqual(restarted.thermostats.exportSettings(), settings());
      assert.equal(fs.readFileSync(statePath, 'utf8'), beforeBoot);
    } finally {
      restarted.controllers.close();
    }
    const v6Path = path.join(directory, 'v6.json');
    const v6 = JSON.parse(beforeBoot);
    v6.version = 6;
    delete v6.controllers.security;
    delete v6.controllers.irrigation;
    delete v6.controllers.tanks;
    for (const item of v6.controllers.thermostats.items) {
      item.minOnSeconds = 2;
      item.minOffSeconds = 180;
    }
    const v6Bytes = JSON.stringify(v6);
    fs.writeFileSync(v6Path, v6Bytes);
    const oldV6 = createMock({ statePath: v6Path });
    try {
      assert.deepEqual(oldV6.thermostats.exportSettings(), settings());
      assert.equal(
        oldV6.thermostats
          .snapshot()
          .items.some((item) => 'minOnSeconds' in item || 'minOffSeconds' in item),
        false,
      );
      assert.equal(
        fs.readFileSync(v6Path, 'utf8'),
        v6Bytes,
        'Boot preserves legacy bytes until an edit',
      );
    } finally {
      oldV6.controllers.close();
    }
    const v4Path = path.join(directory, 'v4.json'),
      v4 = JSON.parse(beforeBoot);
    v4.version = 4;
    delete v4.controllers.security;
    delete v4.controllers.irrigation;
    delete v4.controllers.tanks;
    for (const item of v4.controllers.thermostats.items) {
      delete item.enabled;
      delete item.inputId;
      delete item.minOnSeconds;
      delete item.minOffSeconds;
    }
    const v4Bytes = JSON.stringify(v4);
    fs.writeFileSync(v4Path, v4Bytes);
    const oldV4 = createMock({ statePath: v4Path });
    try {
      assert.equal(
        oldV4.thermostats.snapshot().items.every((item) => item.enabled && item.inputId === ''),
        true,
      );
      assert.equal(fs.readFileSync(v4Path, 'utf8'), v4Bytes);
    } finally {
      oldV4.controllers.close();
    }
    const oldPath = path.join(directory, 'v3.json'),
      old = JSON.parse(beforeBoot);
    old.version = 3;
    delete old.controllers.security;
    delete old.controllers.irrigation;
    delete old.controllers.tanks;
    delete old.controllers.thermostats;
    old.controllers.sockets.enabled = true;
    old.controllers.sockets.items[0].state = true;
    const oldBytes = JSON.stringify(old);
    fs.writeFileSync(oldPath, oldBytes);
    const legacy = createMock({ statePath: oldPath });
    try {
      assert.deepEqual(legacy.thermostats.exportSettings(), { enabled: false, items: [] });
      assert.equal(legacy.sockets.snapshot().items[0].state, true);
      assert.equal(fs.readFileSync(oldPath, 'utf8'), oldBytes);
    } finally {
      legacy.controllers.close();
    }
    assert.deepEqual(errors, []);
    console.log(
      'FCPLCn thermostat browser checks passed: large SVG controls before settings, keyboard and confirmed pending state, heating/cooling illustrations and readings, shared saved sources/exclusive outputs, integer H1..20, heating/cooling boundaries and band hold, fresh/fault/source-change OFF, drafts, dangling repair, demand without writes, v5 flags/input persistence, v4/v3 migration and mobile.',
    );
  } finally {
    await context.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { checkThermostats };
