/** @file Verify tablet controls against an isolated real demo hub. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium, expect } = require('@playwright/test');

/** View the same rolling connection history without leaving the current Pult filter. */
async function checkConnectionHistory(page) {
  const trigger = page.getByRole('button', { name: 'Графики связи', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Графики связи', exact: true });
  const controller = dialog.getByLabel('Контроллер', { exact: true });
  const fleet = dialog.locator('.fleet-connection-history');
  const chartHours = (chart) =>
    chart.evaluate(
      ({ dataset }) => (Date.parse(dataset.to) - Date.parse(dataset.from)) / 3_600_000,
    );
  const route = page.url();
  const viewport = page.viewportSize();

  await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  await trigger.tap();
  await expect(dialog).toBeVisible();
  await expect(controller.locator('option:checked')).toHaveText('Все контроллеры');
  await expect(fleet.locator('[data-fleet-device="fcplcn-demo-garage"]')).toBeVisible();
  await expect.poll(() => chartHours(fleet)).toBe(24);
  await dialog.getByRole('button', { name: '7 дней', exact: true }).tap();
  await expect.poll(() => chartHours(fleet)).toBe(168);
  await controller.selectOption('fcplcn-demo-garage');
  const individual = dialog.getByRole('img', { name: 'График связи с PLC', exact: true });
  await expect(individual).toBeVisible();
  await expect.poll(() => chartHours(individual)).toBe(168);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await trigger.tap();
    await controller.selectOption({ label: 'Все контроллеры' });
    await expect(fleet).toBeVisible();
    assert.equal(
      await dialog.evaluate((element) => element.scrollWidth > element.clientWidth),
      false,
      'Connection history modal has no horizontal overflow on mobile',
    );
    await dialog.getByRole('button', { name: 'Закрыть', exact: true }).tap();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  } finally {
    await page.setViewportSize(viewport);
  }

  assert.equal(page.url(), route);
  await expect(page.locator('[data-pult-filter="lights"]')).toHaveAttribute('aria-pressed', 'true');
}

/** Render authoritative thermostat snapshots without moving its autonomous loop into the browser. */
async function checkThermostat({ page, base, artifacts }) {
  const endpoint = base + '/api/v1/overview';
  const tile = page.locator('[data-controller-kind="thermostats"][data-item-id="thermo-room"]');
  const caption = tile.locator('.pult-tile-state');
  const dot = caption.locator('.pult-state-dot');
  const reading = tile.locator('[data-pult-reading]');
  const setpoint = tile.locator('[data-pult-setpoint]');
  const cases = [
    { state: 'heating', caption: 'Нагрев', values: { actual: true } },
    {
      state: 'cooling',
      caption: 'Охлаждение',
      values: { mode: 'cooling', actual: true, temperatureC: 25.6 },
    },
    { state: 'holding', caption: 'Поддержание', values: { actual: false, temperatureC: 21 } },
    {
      state: 'waiting',
      caption: 'Ожидаем датчик',
      values: {
        sensorAvailable: false,
        available: false,
        actual: false,
        temperatureC: null,
        error: 'Температура Метео недоступна',
      },
    },
    { state: 'off', caption: 'Выключен', values: { enabled: false, actual: false } },
    {
      state: 'error',
      caption: 'Ошибка термостата',
      values: {
        available: false,
        actual: false,
        inhibited: true,
        error: 'Реле не подтвердило состояние; задан безопасный OFF',
      },
    },
    { state: 'unknown', caption: 'Нет свежих данных', values: {} },
  ];
  let current = cases[0];
  const projection = async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const module = data.devices.find((device) => device.id === 'fcplcn-demo-utility').controllers
      .thermostats;
    module.data.enabled = true;
    module.fresh = current.state !== 'unknown';
    Object.assign(
      module.data.items.find((item) => item.id === 'thermo-room'),
      {
        enabled: true,
        mode: 'heating',
        sensorAvailable: true,
        available: true,
        actual: true,
        temperatureC: 19.4,
        setpointC: 21,
        error: null,
        inhibited: false,
        ...current.values,
      },
    );
    await route.fulfill({ response, json: data });
  };
  await page.locator('[data-pult-filter="thermostats"]').click();
  await page.route(endpoint, projection);
  try {
    const colors = new Map();
    for (const entry of cases) {
      current = entry;
      await page.getByRole('button', { name: 'Обновить состояния', exact: true }).click();
      await expect(dot).toHaveAttribute('data-thermostat-state', entry.state);
      await expect(caption).toHaveText(entry.caption);
      colors.set(
        entry.state,
        await dot.evaluate((element) => getComputedStyle(element).backgroundColor),
      );
      if (entry.state === 'heating') {
        await expect(reading).toContainText('19,4');
        await expect(setpoint).toContainText('21');
        await expect(tile).toContainText('Задано');
        const primary = await reading.boundingBox();
        const target = await setpoint.boundingBox();
        assert.ok(
          primary && target && target.y >= primary.y + primary.height - 1,
          'Setpoint sits below the current temperature',
        );
        const styles = await tile.evaluate((element) => {
          const current = getComputedStyle(element.querySelector('[data-pult-reading]'));
          const target = getComputedStyle(element.querySelector('[data-pult-setpoint]'));
          return {
            currentSize: parseFloat(current.fontSize),
            targetSize: parseFloat(target.fontSize),
            currentColor: current.color,
            targetColor: target.color,
          };
        });
        assert.ok(
          styles.targetSize < styles.currentSize,
          'Setpoint is smaller than the current reading',
        );
        assert.notEqual(
          styles.currentColor,
          styles.targetColor,
          'Target and current temperatures use distinct colors',
        );
      }
      if (entry.state === 'waiting') {
        await expect(reading).toContainText('—');
        await expect(tile).not.toHaveClass(/pult-state-error/);
      }
      if (entry.state === 'error') await expect(tile).toContainText(entry.values.error);
      if (entry.state === 'unknown') {
        await expect(tile.locator('[data-pult-command]')).toBeDisabled();
        await expect(reading).toContainText('—');
        await expect(setpoint).toContainText('—');
      }
      if (artifacts)
        await tile.screenshot({
          path: path.join(artifacts, `hub-pult-thermostat-${entry.state}.png`),
          animations: 'disabled',
        });
    }
    const meanings = ['heating', 'cooling', 'holding', 'waiting', 'off', 'error'];
    assert.equal(
      new Set(meanings.map((state) => colors.get(state))).size,
      meanings.length,
      `Thermostat dots distinguish heating, cooling, holding, waiting, off and faults: ${JSON.stringify(Object.fromEntries(colors))}`,
    );
    console.log(
      'Pult thermostat passed: smaller stacked setpoint, semantic captions and distinct heating/cooling/holding/waiting/off/error dots, stale blocking.',
    );
  } finally {
    await page.unroute(endpoint, projection);
    await page.getByRole('button', { name: 'Обновить состояния', exact: true }).click();
    await page.locator('[data-pult-filter="all"]').click();
  }
}

async function checkPult() {
  const root = path.resolve(__dirname, '..');
  const moduleAt = (file) => import(pathToFileURL(path.join(root, 'dist', file)));
  const { createEngine } = await moduleAt('src/engine.js');
  const { createHubServer } = await moduleAt('server/http.js');
  const { loadConfig, engineOptions } = await moduleAt('server/config.js');
  const { Scenes } = await moduleAt('server/scenes.js');
  const { SceneScheduler } = await moduleAt('server/scheduler.js');
  const { LabelStore } = await moduleAt('server/storage.js');
  const product = JSON.parse(await fs.readFile(path.join(root, '../config/product.json'), 'utf8'));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fcplcn-pult-'));
  const artifacts = path.join(root, '.artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const config = loadConfig(
    { FCPLCN_HUB_MODE: 'demo', FCPLCN_HUB_PASSWORD: '', FCPLCN_HUB_DATA_DIR: directory },
    [],
  );
  const labels = new LabelStore(directory);
  const engine = createEngine(
    engineOptions(config, product, {
      labels: labels.load(),
      onLabelsChanged: (value) => labels.save(value),
    }),
  );
  await engine.start();
  const scenes = new Scenes(engine, { directory, demo: true });
  const scheduler = new SceneScheduler(scenes, { directory });
  const server = createHubServer({
    config,
    engine,
    scenes,
    scheduler,
    product,
    webDir: path.join(root, 'dist/web'),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1194, height: 834 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(base + '/#pult');
    await page.getByRole('button', { name: 'Войти в хаб' }).click();
    await page.locator('[data-pult]').waitFor();
    await page.locator('[data-pult-command]:not([disabled])').first().waitFor();
    assert.equal(
      await page.locator('.scene-run-button').count(),
      0,
      'No home/away/prepare scenarios on the pult',
    );
    assert.equal(
      await page.locator('.sidebar').isVisible(),
      false,
      'Tablet page has its own compact navigation',
    );
    assert.equal(await page.getByRole('heading', { name: 'Пульт.', exact: true }).count(), 1);

    const tiles = page.locator('[data-pult-tile]');
    const total = await tiles.count();
    assert.ok(total > 3, 'All real demo equipment is discoverable without configuring the pult');
    const room = page.locator('[data-pult-room]:not([data-pult-room="all"])').first();
    await room.click();
    assert.ok((await tiles.count()) < total, 'Room filter narrows the equipment list');
    await page.locator('[data-pult-room="all"]').click();
    await page.locator('[data-pult-filter="lights"]').click();
    assert.ok((await tiles.count()) > 0);
    assert.deepEqual(
      await tiles.evaluateAll((nodes) => [
        ...new Set(nodes.map((node) => node.dataset.controllerKind)),
      ]),
      ['lights'],
    );
    await checkConnectionHistory(page);

    const tile = tiles.first();
    const key = await tile.getAttribute('data-pult-tile');
    const button = tile.locator('[data-pult-command]');
    const original = await button.getAttribute('aria-pressed');
    assert.ok(['true', 'false'].includes(original));
    const beforeNotice = await tile.boundingBox();
    const beforeNoticeHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    let unblock;
    const gate = new Promise((resolve) => {
      unblock = resolve;
    });
    let intercepted;
    const submitted = new Promise((resolve) => {
      intercepted = resolve;
    });
    let payload;
    const commandRoute = `${base}/api/v1/devices/*/commands`;
    await page.route(commandRoute, async (route) => {
      payload = route.request().postDataJSON();
      intercepted();
      await gate;
      await route.continue();
    });
    await button.tap();
    await submitted;
    await page.waitForFunction(
      (key) =>
        document
          .querySelector(`[data-pult-tile="${key}"] [data-pult-command]`)
          ?.getAttribute('aria-busy') === 'true',
      key,
    );
    assert.equal(
      await button.getAttribute('aria-pressed'),
      original,
      'Pending command does not invent the actual state',
    );
    assert.equal(await button.isDisabled(), true);
    assert.equal(payload.value, original !== 'true', 'Pult submits an explicit new boolean state');
    unblock();
    await page.waitForFunction(
      ({ key, original }) =>
        document
          .querySelector(`[data-pult-tile="${key}"] [data-pult-command]`)
          ?.getAttribute('aria-pressed') !== original,
      { key, original },
    );
    await page.locator('[data-action-notice]').waitFor();
    assert.deepEqual(await tile.boundingBox(), beforeNotice, 'Confirmation never shifts a tile');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollHeight),
      beforeNoticeHeight,
      'Confirmation never changes the page height',
    );
    await page.getByRole('button', { name: 'Закрыть уведомление' }).click();
    assert.deepEqual(await tile.boundingBox(), beforeNotice, 'Dismissing never shifts a tile');
    await page.unroute(commandRoute);

    // Old telemetry must remain visibly unknown and must never permit a click.
    const deviceId = await tile.getAttribute('data-device-id');
    await page.route(`${base}/api/v1/overview`, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      const device = data.devices.find((entry) => entry.id === deviceId);
      device.controllers.lights.fresh = false;
      await route.fulfill({ response, json: data });
    });
    await page.getByRole('button', { name: 'Обновить состояния', exact: true }).click();
    await page.waitForFunction(
      (key) =>
        document.querySelector(`[data-pult-tile="${key}"]`)?.getAttribute('data-pult-state') ===
        'unknown',
      key,
    );
    assert.equal(await button.isDisabled(), true);
    assert.equal(await button.getAttribute('aria-pressed'), 'mixed');
    await page.unroute(`${base}/api/v1/overview`);
    await page.getByRole('button', { name: 'Обновить состояния', exact: true }).click();
    await page.locator(`[data-pult-tile="${key}"] [data-pult-command]:not([disabled])`).waitFor();
    await page.locator('[data-pult-filter="all"]').click();

    await checkThermostat({ page, base, artifacts });

    for (const [name, width, height] of [
      ['landscape', 1194, 834],
      ['small-landscape', 1024, 768],
      ['portrait', 820, 1180],
      ['mobile', 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.screenshot({
        path: path.join(artifacts, `hub-pult-${name}.png`),
        fullPage: true,
        animations: 'disabled',
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `${name}: no page overflow`,
      );
      const small = await page
        .locator('.pult-page button, .pult-header-button')
        .evaluateAll((nodes) =>
          nodes
            .filter(
              (node) =>
                node.getBoundingClientRect().width > 0 &&
                node.getBoundingClientRect().height < 47.9,
            )
            .map((node) => node.textContent),
        );
      assert.deepEqual(small, [], `${name}: touch controls are at least 48px high`);
    }
    await page.getByRole('button', { name: 'Панель хаба', exact: true }).click();
    await page.locator('[data-nav="overview"].active').waitFor();
    assert.equal(
      await page.locator('.scene-run-button').count(),
      3,
      'Original overview retains its quick scenarios',
    );
    await page.locator('[data-nav="pult"]').click();
    assert.equal(new URL(page.url()).hash, '#pult');
    await page.reload();
    await page.locator('[data-pult]').waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Войти в хаб' }).count(),
      0,
      'Reload retains login and pult route',
    );
    assert.deepEqual(errors, []);
    await require('./tanks.browser.cjs').checkTanks({ page, context, base, artifacts });
    await require('./irrigation.browser.cjs').checkIrrigation({ page, base });
    await require('./pult-settings.browser.cjs').checkPultSettings({ page, context, base });
    await require('./pult-scenes.browser.cjs').checkPultScenes({ page, context, base });
    await require('./pult-wake.browser.cjs').checkPultWake({ browser, base });
    console.log(
      'FCPLCn pult checks passed: deep link, room/type filters, connection charts, confirmed commands, stale blocking, tablet layouts, wake recovery.',
    );
  } finally {
    scheduler.stop();
    await context.close();
    await browser.close();
    await scenes.stop();
    await engine.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { checkPult };
if (require.main === module)
  checkPult().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
