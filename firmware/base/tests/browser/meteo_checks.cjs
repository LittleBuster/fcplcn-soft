/**
 * @file meteo_checks.cjs
 * @brief Exercise sensor discovery, OneWire sharing, readings, drafts, and failure recovery.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { demoRoms, validRom } = require('./meteo_mock.cjs');
const { legacyBoardId } = require('./board_profiles_mock.cjs');

async function checkMeteo({ browser, createMock, artifacts }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcplcn-meteo-ui-'));
  const statePath = path.join(directory, 'state.json');
  const mock = createMock({ interactive: true, statePath });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('dialog', (dialog) => dialog.accept());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${mock.server.address().port}`;
  const row = (id) => page.locator(`#meteo-items [data-meteo-id="${id}"]`);
  const field = (id, name) => row(id).locator(`[data-meteo-field="${name}"]`);
  const visual = (id) => row(id).locator('[data-meteo-visual]');
  const response = (suffix = '') =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/controllers/meteo${suffix}`) &&
        response.request().method() === 'POST',
    );
  const post = (route, data) =>
    context.request.post(`${url}/api/v1/controllers/${route}`, { data });
  async function login() {
    await page.goto(url);
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-controllers').click();
  }
  async function save() {
    const request = response();
    await page.locator('#meteo-save').click();
    assert.equal((await request).status(), 200);
  }
  async function add(name, port, type) {
    await page.locator('#meteo-add').click();
    const node = page.locator('#meteo-items [data-meteo-id]').last();
    const id = await node.getAttribute('data-meteo-id');
    await field(id, 'name').fill(name);
    await field(id, 'sensorType').selectOption(type);
    await field(id, 'portId').selectOption(port);
    return id;
  }
  async function scan(id) {
    const pending = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/controllers/meteo/scan') &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON().refresh === true &&
        response.request().postDataJSON().itemId === id,
    );
    await row(id).locator('[data-meteo-scan]').click();
    const reply = await pending;
    assert.equal(reply.status(), 200);
    const data = await reply.json();
    assert.equal(data.busy, true, 'Scan queues work instead of blocking HTTP');
    await page.waitForFunction(
      (id) =>
        [
          ...document.querySelectorAll(
            `[data-meteo-id="${id}"] [data-meteo-field="address"] option`,
          ),
        ].filter((option) => /^28[0-9a-f]{14}$/.test(option.value)).length >= 2,
      id,
    );
    return reply.request().postDataJSON();
  }
  async function portDisabled(id, port, disabled) {
    await page.waitForFunction(
      ({ id, port, disabled }) =>
        document.querySelector(
          `[data-meteo-id="${id}"] [data-meteo-field="portId"] option[value="${port}"]`,
        )?.disabled === disabled,
      { id, port, disabled },
    );
    assert.equal(
      await field(id, 'portId')
        .locator(`option[value="${port}"]`)
        .evaluate((option) => option.hidden),
      false,
    );
  }
  const editItems = () => mock.meteo.exportSettings().items;
  try {
    await login();
    assert.equal(await page.locator('[data-controller-id]').count(), 7);
    assert.deepEqual(mock.meteo.exportSettings(), { enabled: false, items: [] });
    const enable = response();
    await page.locator('#meteo-tile-enabled').click();
    assert.equal((await enable).status(), 200);
    assert.equal(
      await page.locator('#controllers-list-view').isVisible(),
      true,
      'Meteo module switch does not navigate',
    );
    for (const [module, relay] of [
      ['sockets', 1],
      ['lights', 2],
    ]) {
      assert.equal(
        (
          await post(module, {
            baseRevision: 1,
            enabled: true,
            items: [{ id: `keep-${module}`, name: module, relayId: `rly-0/${relay}`, inputId: '' }],
          })
        ).status(),
        200,
      );
      assert.equal(
        (await post(`${module}/state`, { id: `keep-${module}`, value: true })).status(),
        200,
      );
    }
    await page.locator('#meteo-open').click();
    const dht = await add('Комната', 'sens-0/1', 'dht22');
    await save();
    assert.equal(await row(dht).locator('[data-meteo-address-field]').isVisible(), false);
    assert.equal(mock.meteo.snapshot().items[0].humidityPct, 45.5);
    assert.match(await row(dht).locator('[data-meteo-temperature]').textContent(), /22[.,]1/);
    assert.equal(
      await visual(dht).evaluate((node) => node === node.parentElement.firstElementChild),
      true,
    );
    assert.equal(
      await visual(dht).evaluate((node) => node.tagName),
      'DIV',
      'Sensor visual is read-only',
    );
    assert.equal(await visual(dht).getAttribute('role'), 'group');
    assert.equal(
      await visual(dht).locator('button').count(),
      0,
      'Readings do not pretend to switch a sensor',
    );
    assert.equal(await visual(dht).locator('use').getAttribute('href'), '#visual-dht22');
    assert.equal(await visual(dht).getAttribute('data-state'), 'on');
    assert.equal(await visual(dht).locator('[data-meteo-temperature]').count(), 1);
    assert.equal(await visual(dht).locator('[data-meteo-humidity]').count(), 1);
    fs.mkdirSync(artifacts, { recursive: true });
    for (const [width, suffix] of [
      [1280, 'desktop'],
      [390, 'mobile'],
      [320, 'narrow'],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      await visual(dht).screenshot({
        path: path.join(artifacts, `meteo-dht-visual-${suffix}.png`),
      });
      const visualBounds = await visual(dht).boundingBox();
      for (const reading of ['temperature', 'humidity']) {
        const bounds = await visual(dht).locator(`[data-meteo-${reading}]`).boundingBox();
        assert.ok(bounds && visualBounds);
        assert.ok(
          bounds.x >= visualBounds.x &&
            bounds.x + bounds.width <= visualBounds.x + visualBounds.width,
          `DHT22 ${reading} fits the ${width}px visual`,
        );
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `DHT22 ${width}px overflow`,
      );
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    assert.equal((await post('meteo/scan', { portId: 'sens-0/1', refresh: true })).status(), 409);
    assert.equal(
      (
        await post('meteo/scan', {
          portId: 'sens-0/1',
          itemId: dht,
          baseRevision: 1,
          refresh: true,
        })
      ).status(),
      409,
    );
    assert.equal(
      (
        await post('meteo/scan', {
          portId: 'sens-0/1',
          itemId: 'not-the-owner',
          baseRevision: mock.meteo.snapshot().revision,
          refresh: true,
        })
      ).status(),
      409,
    );

    const firstDs = await add('Бак', 'sens-0/2', 'onewire');
    assert.equal(await visual(firstDs).locator('use').getAttribute('href'), '#visual-onewire');
    assert.equal(await visual(firstDs).getAttribute('data-state'), 'unknown');
    assert.equal(
      await visual(firstDs).locator('[data-meteo-temperature]').textContent(),
      'Нет данных',
    );
    assert.equal(await field(firstDs, 'portId').locator('option[value^="sens-"]').count(), 8);
    await portDisabled(firstDs, 'sens-0/1', true);
    await scan(firstDs);
    assert.equal(
      await field(firstDs, 'address').inputValue(),
      '',
      'Discovery never silently chooses a thermometer',
    );
    const roms = demoRoms('sens-0/2');
    assert.equal(roms.every(validRom), true);
    await field(firstDs, 'address').selectOption(roms[0]);
    await save();
    const secondDs = await add('Труба', 'sens-0/3', 'onewire');
    await portDisabled(secondDs, 'sens-0/2', false, 'OneWire bus stays selectable');
    await field(secondDs, 'portId').selectOption('sens-0/2');
    await scan(secondDs);
    const usedRom = field(secondDs, 'address').locator(`option[value="${roms[0]}"]`);
    assert.equal(await usedRom.isDisabled(), true);
    assert.match(await usedRom.textContent(), /Бак/);
    await field(secondDs, 'address').selectOption(roms[1]);
    await save();
    assert.equal(
      mock.controllers.resources().find((resource) => resource.id === 'sens-0/2').conflict,
      false,
    );
    assert.deepEqual(
      mock.meteo
        .snapshot()
        .items.slice(1)
        .map((item) => item.humidityPct),
      [null, null],
    );
    const beforeInvalid = mock.meteo.exportSettings(),
      revision = mock.meteo.snapshot().revision;
    for (const conflict of ['rom', 'dht']) {
      const items = JSON.parse(JSON.stringify(editItems()));
      if (conflict === 'rom') items[2].address = items[1].address;
      else {
        items[2].sensorType = 'dht22';
        items[2].address = '';
      }
      assert.equal(
        (await post('meteo', { baseRevision: revision, enabled: true, items })).status(),
        409,
      );
      assert.deepEqual(mock.meteo.exportSettings(), beforeInvalid);
    }
    const invalidCrc = JSON.parse(JSON.stringify(editItems()));
    invalidCrc[1].address = '2800000000000001';
    assert.equal(
      (await post('meteo', { baseRevision: revision, enabled: true, items: invalidCrc })).status(),
      400,
    );

    // In-place DHT -> OneWire requires an explicit owner/revision probe. It
    // discovers ROMs without changing the currently saved DHT configuration.
    await field(dht, 'sensorType').selectOption('onewire');
    assert.equal(await visual(dht).locator('use').getAttribute('href'), '#visual-onewire');
    assert.equal(
      await visual(dht).getAttribute('data-state'),
      'unknown',
      'Draft type cannot display a saved DHT reading as OneWire',
    );
    assert.equal(await visual(dht).locator('[data-meteo-temperature]').textContent(), 'Нет данных');
    const probe = await scan(dht);
    assert.equal(probe.itemId, dht);
    assert.equal(probe.baseRevision, revision);
    assert.equal(mock.meteo.exportSettings().items[0].sensorType, 'dht22');
    await field(dht, 'address').selectOption(demoRoms('sens-0/1')[0]);
    await save();
    assert.equal(mock.meteo.exportSettings().items[0].sensorType, 'onewire');
    await field(firstDs, 'name').fill('Черновик температуры');
    await page.waitForTimeout(1200);
    assert.equal(await field(firstDs, 'name').inputValue(), 'Черновик температуры');
    await save();
    mock.setMeteoFault('sens-0/2', 'Test sensor unavailable');
    await row(firstDs)
      .getByText(/Test sensor unavailable/)
      .waitFor();
    const faulty = mock.meteo.snapshot().items[1];
    assert.equal(faulty.available, false);
    assert.equal(faulty.temperatureC, null);
    assert.equal(faulty.ageMs, null);
    assert.equal(await visual(firstDs).getAttribute('data-state'), 'error');
    assert.equal(
      await visual(firstDs).locator('[data-meteo-temperature]').textContent(),
      'Нет данных',
    );
    mock.setMeteoFault('sens-0/2', '');
    await page.waitForTimeout(1150);
    mock.setMeteoTemperature(firstDs, 25.5, { ageMs: 16000 });
    await page.waitForFunction(
      (id) =>
        document.querySelector(`[data-meteo-id="${id}"] [data-meteo-temperature]`)?.textContent ===
        'Нет данных',
      firstDs,
    );
    assert.equal(
      await visual(firstDs).getAttribute('data-state'),
      'unknown',
      'Stale measurements never keep the active visual',
    );
    mock.setMeteoTemperature(firstDs, 25.5, { ageMs: 0 });
    await page.waitForFunction(
      (id) =>
        document.querySelector(`[data-meteo-id="${id}"] [data-meteo-visual]`)?.dataset.state ===
        'on',
      firstDs,
    );
    const disable = response();
    await page.locator('#meteo-enabled').click();
    assert.equal((await disable).status(), 200);
    assert.equal(
      mock.meteo.snapshot().items.every((item) => !item.available && item.temperatureC === null),
      true,
    );
    const draft = await add('Новый', 'sens-0/4', 'dht22');
    await portDisabled(draft, 'sens-0/2', true);
    await field(draft, 'sensorType').selectOption('onewire');
    await portDisabled(draft, 'sens-0/1', false);
    await portDisabled(draft, 'sens-0/2', false);
    await row(draft).locator('[data-meteo-remove]').click();
    const reenable = response();
    await page.locator('#meteo-enabled').click();
    assert.equal((await reenable).status(), 200);
    await page.waitForTimeout(1150);
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'meteo-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: path.join(artifacts, 'meteo-mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'Meteo mobile overflow',
    );
    const saved = mock.controllers.exportSettings();
    await context.request.post(`${url}/api/v1/reboot`, { data: {} });
    await page.waitForTimeout(1150);
    assert.deepEqual(mock.controllers.exportSettings(), saved);
    assert.equal(mock.hardware.snapshot().relays[0].value, true);
    assert.equal(mock.hardware.snapshot().relays[1].value, true);
    // Open the page before its first controller snapshot arrives. Saved OW
    // rows must enqueue discovery once they arrive, without a manual click.
    const refreshes = [];
    const observeScan = (request) => {
      if (
        request.url().endsWith('/api/v1/controllers/meteo/scan') &&
        request.method() === 'POST' &&
        request.postDataJSON().refresh
      )
        refreshes.push(request.postDataJSON().portId);
    };
    page.on('request', observeScan);
    await page.route('**/api/v1/controllers', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    const initialAggregate = page.waitForRequest((request) =>
      request.url().endsWith('/api/v1/controllers'),
    );
    await login();
    await initialAggregate;
    const automaticScan = page.waitForRequest(
      (request) =>
        request.url().endsWith('/api/v1/controllers/meteo/scan') &&
        request.method() === 'POST' &&
        request.postDataJSON().refresh === true,
    );
    await page.locator('#meteo-open').click();
    await automaticScan;
    await page.unroute('**/api/v1/controllers');
    await page.waitForTimeout(2200);
    assert.deepEqual([...new Set(refreshes)].sort(), ['sens-0/1', 'sens-0/2']);
    assert.equal(refreshes.length, 2, 'Ordinary aggregate polling never restarts completed scans');
    page.removeListener('request', observeScan);

    const disk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(disk.version, 10);
    const oldPath = path.join(directory, 'old-v2.json');
    const v2 = {
      version: 2,
      boardId: legacyBoardId,
      controllers: { sockets: disk.controllers.sockets, lights: disk.controllers.lights },
    };
    const oldBytes = JSON.stringify(v2);
    fs.writeFileSync(oldPath, oldBytes);
    const old = createMock({ statePath: oldPath });
    try {
      assert.equal(
        fs.readFileSync(oldPath, 'utf8'),
        oldBytes,
        'v2 migration adds no boot-time write',
      );
      assert.deepEqual(old.meteo.exportSettings(), { enabled: false, items: [] });
      assert.equal(old.sockets.snapshot().items[0].state, true);
      assert.equal(old.lights.snapshot().items[0].state, true);
      await old.sockets.state({ id: 'keep-sockets', value: false });
      assert.equal(JSON.parse(fs.readFileSync(oldPath, 'utf8')).version, 10);
    } finally {
      old.controllers.close();
    }
    assert.deepEqual(errors, []);
    console.log(
      'FCPLCn meteo browser checks passed: leading read-only SVG/readings, DHT22/OneWire visual changes, stale/draft/fault readings, queued CRC-valid multi-ROM scan, selectable shared OneWire bus/exclusive serial, owner DHT probe, conflicts, v3 persistence/v2 migration and mobile.',
    );
  } finally {
    await context.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { checkMeteo };
