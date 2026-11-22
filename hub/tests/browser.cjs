/** @file Verify the built hub web panel against its real server and isolated virtual PLCs. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { chromium } = require('@playwright/test');

async function run() {
  if (process.env.FCPLCN_HUB_BROWSER_SECURITY_ONLY === '1')
    return require('./house-security.browser.cjs').checkLocalHouseSecurity();
  const root = path.resolve(__dirname, '..');
  const { createEngine } = await import(pathToFileURL(path.join(root, 'dist/src/engine.js')));
  const { createHubServer } = await import(pathToFileURL(path.join(root, 'dist/server/http.js')));
  const { loadConfig, engineOptions } = await import(
    pathToFileURL(path.join(root, 'dist/server/config.js'))
  );
  const { LabelStore } = await import(pathToFileURL(path.join(root, 'dist/server/storage.js')));
  const { Scenes } = await import(pathToFileURL(path.join(root, 'dist/server/scenes.js')));
  const { SceneScheduler } = await import(
    pathToFileURL(path.join(root, 'dist/server/scheduler.js'))
  );
  const product = JSON.parse(await fs.readFile(path.join(root, '../config/product.json'), 'utf8'));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fcplcn-hub-browser-'));
  const artifacts = path.join(root, '.artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const config = loadConfig(
    {
      FCPLCN_HUB_MODE: 'demo',
      FCPLCN_HUB_PASSWORD: '',
      FCPLCN_HUB_DATA_DIR: directory,
    },
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
  scheduler.start();
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [],
    external = [],
    expectedHttpErrors = new Set();
  const expectHttpError = (url, status) => {
    const expected = { url, status, remaining: 1 };
    expectedHttpErrors.add(expected);
    return () => expectedHttpErrors.delete(expected);
  };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    for (const expected of expectedHttpErrors) {
      if (
        expected.remaining &&
        message.location().url === expected.url &&
        message
          .text()
          .startsWith(
            `Failed to load resource: the server responded with a status of ${expected.status} (`,
          )
      ) {
        expected.remaining--;
        return;
      }
    }
    errors.push(message.text());
  });
  page.on('request', (request) => {
    if (!request.url().startsWith(base)) external.push(request.url());
  });
  const overview = () => context.request.get(base + '/api/v1/overview').then((r) => r.json());
  async function screenshot(name) {
    await page.screenshot({
      path: path.join(artifacts, name + '.png'),
      fullPage: true,
      animations: 'disabled',
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      name + ': no horizontal scrolling',
    );
  }
  async function command(button, target) {
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/commands') && r.request().method() === 'POST',
    );
    await button.click();
    const result = await response;
    assert.equal(result.status(), 200);
    assert.equal((await result.json()).status, 'applied');
    await page.waitForFunction(
      ({ itemId, target }) =>
        document
          .querySelector(`[data-item-id="${itemId}"] button`)
          ?.getAttribute('aria-pressed') === String(target),
      { itemId: await button.locator('..').getAttribute('data-item-id'), target },
    );
  }
  try {
    await page.goto(base);
    await page.getByLabel('Логин', { exact: true }).fill('admin');
    await page.getByLabel('Пароль', { exact: true }).fill(config.password);
    await page.getByRole('button', { name: 'Войти в хаб' }).click();
    await page.waitForSelector('[data-device-id="fcplcn-demo-living"]');
    assert.equal(await page.locator('[data-device-id]').count(), 3);
    assert.equal(await page.locator('.board-art').count(), 3);
    await require('./illustration.browser.cjs').checkIllustration({
      page,
      artifacts,
      persisted: () => new LabelStore(directory).load(),
      request: (route, body, method = body === undefined ? 'GET' : 'PATCH') =>
        context.request.fetch(base + '/api/v1' + route, {
          method,
          headers: {
            Origin: base,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { data: body }),
        }),
    });
    if (process.env.FCPLCN_HUB_BROWSER_ILLUSTRATION_ONLY === '1') {
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      return;
    }
    await screenshot('hub-overview-desktop');
    await page.getByRole('textbox', { name: 'Найти контроллер' }).fill('Гараж');
    assert.equal(await page.locator('[data-device-id]').count(), 1);
    await page.getByRole('textbox', { name: 'Найти контроллер' }).fill('');
    await page.locator('[data-device-id="fcplcn-demo-living"]').click();
    const light = page.locator('[data-item-id="light-main"] button');
    await command(light, false);
    await command(light, true);
    await command(page.locator('[data-item-id="socket-window"] button'), true);
    await command(page.locator('[data-item-id="thermo-floor"] button'), false);
    assert.ok((await page.locator('[data-controller-kind="meteo"] .reading').count()) >= 2);
    await screenshot('hub-controller-desktop');
    await page.getByRole('button', { name: 'Имя и помещение' }).click();
    await page.getByLabel('Название', { exact: true }).fill('Гостиная · проверено');
    await page.getByLabel('Помещение', { exact: true }).fill('Первый этаж');
    const saved = page.waitForResponse((r) => r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    assert.equal((await saved).status(), 200);
    assert.equal(labels.load()['fcplcn-demo-living'].name, 'Гостиная · проверено');
    await page.locator('[data-nav="overview"]').click();
    await page.locator('[data-device-id="fcplcn-demo-garage"]').click();
    const shield = page.locator('[data-security-action]');
    assert.equal(await shield.locator('[data-icon="alarm"]').count(), 1);
    const door = page.locator('[data-item-id="zone-door"]');
    assert.equal(await door.locator('[data-icon="door"]').count(), 1);
    assert.match(await door.getAttribute('class'), /state-alarm/);
    await screenshot('hub-security-desktop');
    await page.setViewportSize({ width: 390, height: 900 });
    await screenshot('hub-security-mobile');
    await shield.click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-security-action]')?.getAttribute('aria-pressed') === 'false',
    );
    assert.equal(
      (await overview()).devices.find((d) => d.id === 'fcplcn-demo-garage').controllers.security
        .data.triggered,
      false,
    );
    await page.locator('[data-nav="activity"]').click();
    assert.ok((await page.locator('.command-row').count()) >= 5);
    await screenshot('hub-journal-mobile');
    await page.setViewportSize({ width: 360, height: 800 });
    await page.locator('[data-nav="overview"]').click();
    await screenshot('hub-overview-narrow');
    await require('./scenes.browser.cjs').checkScenes({ page, context, base, engine, artifacts });
    const restoredScenes = new Scenes(engine, { directory, demo: true });
    assert.deepEqual(restoredScenes.snapshot().definitions, scenes.snapshot().definitions);
    await require('./telegram.browser.cjs').checkTelegram({
      page,
      base,
      artifacts,
      expectHttpError,
    });
    await require('./cloud.browser.cjs').checkCloudSettings({ page, base, artifacts });
    await require('./management.browser.cjs').checkManagement({ page, context, base, artifacts });
    await require('./firmware.browser.cjs').checkHubFirmware({
      page,
      context,
      base,
      artifacts,
      expectHttpError,
    });
    await page.locator('[data-nav="overview"]').click();
    await page.locator('[data-device-id="fcplcn-demo-living"]').click();
    await engine.stop();
    await page.waitForFunction(
      () => document.querySelector('[data-item-id="light-main"] button')?.disabled === true,
    );
    await screenshot('hub-connection-lost-mobile');
    await require('./scenes.browser.cjs').checkOfflineScene({
      page,
      context,
      base,
      engine,
      artifacts,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-nav="account"]').click();
    await page.locator('[data-account-settings]').waitFor();
    const account = page.locator('[data-account-settings]');
    await account.getByLabel('Логин', { exact: true }).fill('owner');
    await account.getByLabel('Текущий пароль', { exact: true }).fill('');
    await account.getByLabel('Изменить пароль', { exact: true }).check();
    await account.getByLabel('Новый пароль', { exact: true }).fill('fcplcn-owner-check');
    await account.getByLabel('Повторите новый пароль', { exact: true }).fill('fcplcn-owner-check');
    await screenshot('hub-account-mobile');
    await account.getByRole('button', { name: 'Сохранить учётную запись' }).click();
    await page.getByRole('button', { name: 'Войти в хаб' }).waitFor();
    assert.equal(await page.getByLabel('Логин', { exact: true }).inputValue(), 'owner');
    assert.equal((await context.request.get(base + '/api/v1/overview')).status(), 401);
    await page.getByLabel('Пароль', { exact: true }).fill('fcplcn-owner-check');
    await page.getByRole('button', { name: 'Войти в хаб' }).click();
    await page.locator('[data-nav="account"]').click();
    await account.getByLabel('Логин', { exact: true }).waitFor();
    await account.getByLabel('Текущий пароль', { exact: true }).fill('fcplcn-owner-check');
    await account.getByLabel('Изменить пароль', { exact: true }).check();
    await account.getByRole('button', { name: 'Сохранить учётную запись' }).click();
    await page.getByRole('button', { name: 'Войти в хаб' }).waitFor();
    await page.getByRole('button', { name: 'Войти в хаб' }).click();
    await page.getByRole('button', { name: 'Выйти', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await page.getByRole('button', { name: 'Войти в хаб' }).waitFor();
    assert.equal(
      (await context.request.get(base + '/api/v1/overview')).status(),
      401,
      'Logout revokes the server session',
    );
    assert.deepEqual(external, [], 'No fonts, images, scripts or telemetry from outside the hub');
    assert.deepEqual(errors, []);
    await require('./house-security.browser.cjs').checkLocalHouseSecurity();
    await require('./pult.browser.cjs').checkPult();
    console.log(
      'FCPLCn hub browser checks passed: default admin/empty login, account editing and empty-password restore, login/logout, PLC discovery, confirmed control, native SVGs, persisted names, journal, loss of connection and responsive layout.',
    );
    console.log(`Screenshots: ${artifacts}`);
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
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
