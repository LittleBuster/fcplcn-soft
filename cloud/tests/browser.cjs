/** @file Real PostgreSQL/auth/cloud HTTP + shared HubControl and virtual PLC browser integration. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium, expect } = require('@playwright/test');

async function run() {
  const root = path.resolve(__dirname, '../..');
  if (!process.env.FCPLCN_CLOUD_TEST_DATABASE_URL) {
    const env =
      process.env.FCPLCN_CLOUD_TEST_ENV || '/Users/sergey/esp/build/fcplcn/cloud-dev/test.env';
    try {
      process.loadEnvFile(env);
    } catch {
      /* The explicit database variable remains required below. */
    }
  }
  const databaseURL = process.env.FCPLCN_CLOUD_TEST_DATABASE_URL;
  assert.ok(
    databaseURL,
    'Set FCPLCN_CLOUD_TEST_DATABASE_URL to the isolated PostgreSQL test service',
  );
  const module = async (file) => import(pathToFileURL(path.join(root, file)));
  const { CloudDatabase } = await module('cloud/dist/cloud/server/db.js');
  const { createCloudServer } = await module('cloud/dist/cloud/server/http.js');
  const { totp } = await module('cloud/dist/cloud/server/totp.js');
  const { CloudArtifacts } = await module('cloud/dist/cloud/server/artifacts.js');
  const { CloudFirmwareInstaller } = await module('hub/dist/server/cloud/firmware.js');
  const { cloudAppImage } = await module('cloud/dist/hub/tests/cloud-fixtures.js');
  const { createEngine } = await module('hub/dist/src/engine.js');
  const { Scenes } = await module('hub/dist/server/scenes.js');
  const { HubControl } = await module('hub/dist/server/control.js');
  const { LabelStore } = await module('hub/dist/server/storage.js');
  const product = JSON.parse(await fs.readFile(path.join(root, 'config/product.json'), 'utf8'));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fcplcn-cloud-browser-'));
  const artifacts = path.join(root, 'cloud/.artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const admin = new CloudDatabase(databaseURL);
  const schema = 'browser_' + randomBytes(8).toString('hex');
  await admin.query('CREATE SCHEMA ' + schema);
  const db = new CloudDatabase(databaseURL, { schema });
  const illustrationOnly = process.env.FCPLCN_CLOUD_BROWSER_ILLUSTRATION_ONLY === '1';
  const securityOnly = process.env.FCPLCN_CLOUD_BROWSER_SECURITY_ONLY === '1';
  let server, engine, scenes, control, installer, browser, page, securityHarness;
  try {
    await db.migrate();
    const labels = new LabelStore(path.join(directory, 'hub'));
    engine = createEngine({
      mode: 'demo',
      product,
      brokerUrl: 'mqtt://127.0.0.1:1883',
      clientId: 'cloud-browser-' + schema,
      staleAfterMs: 45000,
      commandTimeoutMs: 8000,
      labels: labels.load(),
      onLabelsChanged(value) {
        labels.save(value);
      },
      demoDataDir: path.join(directory, 'hub'),
    });
    {
      securityHarness =
        require('../../hub/tests/house-security.browser.cjs').instrumentSecurityEngine(engine);
      engine = securityHarness.engine;
    }
    await engine.start();
    scenes = new Scenes(engine, { directory: path.join(directory, 'hub'), demo: true });
    control = new HubControl({
      engine,
      scenes,
      product,
      mode: 'demo',
      dataDir: path.join(directory, 'hub'),
    });
    let linkedId = '',
      online = true;
    const revoked = new Set();
    const bridge = {
      snapshot(id) {
        return {
          online: id === linkedId && online && !revoked.has(id),
          sessionId: 'browser-session',
          lastSeenAt: new Date().toISOString(),
          snapshot: id === linkedId ? control.overview() : null,
        };
      },
      async request(id, method, route, body, actor) {
        assert.equal(id, linkedId);
        try {
          return await control.dispatch(method, route, body, { actor });
        } catch (error) {
          return { status: error.statusCode || 503, data: { error: error.message } };
        }
      },
      revoke(id) {
        revoked.add(id);
      },
    };
    const broker = {
      async provision(id) {
        linkedId = id;
        return {
          username: id,
          password: randomBytes(32).toString('base64url'),
          brokerUrl: 'mqtts://localhost:8883',
        };
      },
      async revoke(id) {
        revoked.add(id);
      },
    };
    const config = {
      host: '127.0.0.1',
      port: 4100,
      publicOrigin: 'http://127.0.0.1:4100',
      secureCookies: false,
      databaseUrl: databaseURL,
      setupKey: randomBytes(24).toString('hex'),
      masterKey: randomBytes(32),
      dataDir: directory,
      brokerUrl: 'mqtts://localhost:8883',
      mqttUsername: 'browser-service',
      mqttPassword: 'unused-browser-test',
      publicBrokerUrl: 'mqtts://localhost:8883',
      allowInsecureLoopback: false,
    };
    installer = new CloudFirmwareInstaller({
      control,
      origin: () => config.publicOrigin,
      hubId: () => linkedId,
      isActive: () => online && Boolean(linkedId) && !revoked.has(linkedId),
      connection: () => (online ? 'browser-session' : null),
      dataDir: path.join(directory, 'hub'),
    });
    control.setFirmware(installer);
    const serverOptions = {
      config,
      db,
      product,
      bridge,
      broker,
      artifacts: new CloudArtifacts(directory, product.name),
      webDir: path.join(root, 'cloud/dist/web'),
      portalDir: path.join(root, 'cloud/dist/portal'),
      plcDir: path.join(root, 'cloud/dist/plc'),
    };
    server = createCloudServer(serverOptions);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    config.publicOrigin = base;
    browser = await chromium.launch({ headless: true });
    const owner = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    page = await owner.newPage();
    page.setDefaultTimeout(15000);
    const errors = [],
      external = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('request', (request) => {
      if (!request.url().startsWith(base)) external.push(request.url());
    });
    async function shot(name) {
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
    const session = async (context = owner) =>
      context.request.get(base + '/api/v1/session').then((reply) => reply.json());
    const request = async (
      route,
      body,
      method = body === undefined ? 'GET' : 'POST',
      context = owner,
    ) =>
      context.request.fetch(base + '/api/v1' + route, {
        method,
        headers: {
          Origin: base,
          'Content-Type': 'application/json',
          'X-FCPLCN-CSRF': (await session(context)).csrfToken || '',
        },
        ...(body === undefined ? {} : { data: body }),
      });
    await page.goto(base);
    await expect(page.getByLabel('Логин', { exact: true })).toHaveValue('admin');
    await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue('');
    assert.equal((await session()).setupRequired, false);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ваш первый дом' })).toBeVisible();
    await page.locator('.account-button').click();
    await page.getByLabel('Логин', { exact: true }).fill('sergey');
    await expect(page.getByLabel('Текущий пароль', { exact: true })).toHaveValue('');
    await page.getByRole('checkbox', { name: 'Изменить пароль', exact: true }).check();
    await page.getByLabel('Новый пароль', { exact: true }).fill('FCPLCn-owner-password-123');
    await expect(page.getByLabel('Логин', { exact: true })).toHaveValue('sergey');
    const credentialsSaved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/auth/account') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Сохранить учётные данные', exact: true }).click();
    const accountReply = await credentialsSaved;
    assert.equal(accountReply.request().postDataJSON().username, 'sergey');
    assert.equal(accountReply.status(), 200);
    assert.equal((await accountReply.json()).user.username, 'sergey');
    await expect.poll(async () => (await session()).user?.username).toBe('sergey');
    const defaultId = (await session()).user.id;
    await shot('cloud-account-desktop');
    const oldLogin = await browser.newContext();
    assert.equal(
      (
        await request('/auth/login', { username: 'admin', password: '' }, 'POST', oldLogin)
      ).status(),
      401,
      'Changing the default credentials removes access through admin with an empty password',
    );
    await oldLogin.close();
    const port = server.address().port;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    server = createCloudServer(serverOptions);
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    await page.reload();
    assert.equal((await session()).user.username, 'sergey');
    assert.equal((await session()).user.id, defaultId);
    assert.equal(
      Number((await db.query('SELECT count(*) AS count FROM cloud_users')).rows[0].count),
      1,
      'A restart preserves the renamed account and never recreates the default administrator',
    );
    await page.getByRole('button', { name: 'Выйти из облака' }).click();
    await expect(page.getByRole('heading', { name: 'Войти в свой дом' })).toBeVisible();
    await page.getByLabel('Логин', { exact: true }).fill('sergey');
    await page.getByLabel('Пароль', { exact: true }).fill('FCPLCn-owner-password-123');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ваш первый дом' })).toBeVisible();
    await page.getByRole('button', { name: 'Добавить дом', exact: true }).last().click();
    await page.getByLabel('Название', { exact: true }).fill('Дом FCPLCn');
    await page.getByRole('button', { name: 'Создать дом', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Дом FCPLCn.' })).toBeVisible();
    const homeId = (await request('/homes').then((reply) => reply.json())).homes[0].id;
    await page.getByRole('button', { name: 'Получить код привязки' }).click();
    await expect(page.locator('.pair-code code')).toHaveText(/[0-9A-F]{4}-/);
    const pairCode = await page.locator('.pair-code code').innerText();
    const claim = await request('/hubs/claim', {
      code: pairCode,
      installationId: randomUUID(),
      name: 'Домашний Linux-хаб',
    });
    assert.equal(claim.status(), 200, await claim.text());
    await expect(page.locator('.connection-badge')).toContainText('Дом на связи');
    await shot('cloud-connection-desktop');
    await page.locator('[data-cloud-nav="control"]').click();
    const portal = page.frameLocator('[data-hub-portal]');
    await portal.locator('[data-device-id="fcplcn-demo-living"]').waitFor();
    if (!illustrationOnly && !securityOnly)
      await require('./portal-resize.cjs').checkPortalResize({
        page,
        artifacts,
        deviceId: 'fcplcn-demo-living',
      });
    if (process.env.FCPLCN_CLOUD_BROWSER_RESIZE_ONLY === '1') {
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      return;
    }
    if (!securityOnly)
      await require('../../hub/tests/illustration.browser.cjs').checkIllustration({
        page,
        scope: portal,
        expect,
        artifacts,
        label: 'cloud',
        persisted: () => new LabelStore(path.join(directory, 'hub')).load(),
        request: (route, body, method = body === undefined ? 'GET' : 'PATCH') =>
          request('/homes/' + homeId + '/hub' + route, body, method),
      });
    if (securityOnly)
      await require('../../hub/tests/house-security.browser.cjs').checkHouseSecurity({
        page,
        scope: portal,
        request: (route, body, method = body === undefined ? 'GET' : 'POST') =>
          request('/homes/' + homeId + '/hub' + route, body, method),
        harness: securityHarness,
        control,
        artifacts,
        label: 'cloud',
        expect,
      });
    if (!illustrationOnly && !securityOnly) {
      assert.equal(await portal.locator('.scene-cards .scene-card').count(), 3);
      await portal.locator('[data-device-id="fcplcn-demo-living"]').click();
      assert.equal(await portal.locator('.scene-cards .scene-card').count(), 0);
      const light = portal.locator('[data-item-id="light-main"] button');
      const pending = page.waitForResponse(
        (reply) =>
          reply.url().endsWith('/hub/devices/fcplcn-demo-living/commands') &&
          reply.request().method() === 'POST',
      );
      await light.click();
      assert.equal((await (await pending).json()).status, 'applied');
      await portal.locator('[data-plc-configure="fcplcn-demo-living"]').click();
      const plc = portal.frameLocator('[data-plc-settings-frame]');
      await plc.locator('#app-view').waitFor({ state: 'visible' });
      assert.equal(await portal.locator('.scene-cards .scene-card').count(), 0);
      await plc.locator('#tab-system').click();
      await plc.locator('#device-name').fill('PLC через облако');
      const savedConfig = page.waitForResponse(
        (reply) => reply.url().endsWith('/service/config') && reply.request().method() === 'POST',
      );
      await plc.locator('#system-form button[type="submit"]').click();
      assert.equal((await savedConfig).status(), 200);
      const saved = await request(
        '/homes/' + homeId + '/hub/devices/fcplcn-demo-living/service/config',
      ).then((reply) => reply.json());
      assert.equal(saved.device.name, 'PLC через облако');
      await shot('cloud-plc-settings-desktop');
      await page.locator('[data-cloud-nav="firmware"]').click();
      const firmware = page.locator('[data-cloud-firmware]');
      await expect(firmware.getByRole('heading', { name: 'Прошивка PLC' })).toBeVisible();
      await expect(
        firmware.getByRole('combobox', { name: 'Контроллер', exact: true }),
      ).toContainText('Гостиная');
      await firmware
        .getByRole('combobox', { name: 'Контроллер', exact: true })
        .selectOption('fcplcn-demo-living');
      const uploads = [];
      const recordUpload = (request) => {
        if (request.method() === 'POST' && request.url().endsWith('/firmware'))
          uploads.push(request.url());
      };
      page.on('request', recordUpload);
      await firmware.getByLabel('Файл приложения').setInputFiles({
        name: 'not-firmware.txt',
        mimeType: 'text/plain',
        buffer: Buffer.alloc(300),
      });
      await firmware.getByRole('button', { name: 'Загрузить и обновить' }).click();
      await expect(firmware.getByRole('alert')).toContainText('Выберите бинарник приложения');
      assert.equal(uploads.length, 0, 'Invalid files are rejected before upload');
      const image = cloudAppImage(32768);
      await firmware.getByLabel('Файл приложения').setInputFiles({
        name: 'FCPLCn.bin',
        mimeType: 'application/octet-stream',
        buffer: image,
      });
      const uploaded = page.waitForResponse(
        (reply) => reply.request().method() === 'POST' && reply.url().endsWith('/firmware'),
      );
      const installed = page.waitForResponse(
        (reply) =>
          reply.request().method() === 'POST' && /\/firmware\/[^/]+\/install$/.test(reply.url()),
      );
      page.once('dialog', (dialog) => dialog.accept());
      await firmware.getByRole('button', { name: 'Загрузить и обновить' }).click();
      assert.equal((await uploaded).status(), 201);
      const installation = await installed;
      assert.equal(installation.status(), 202, await installation.text());
      await expect(firmware.getByRole('status')).toContainText('Новая прошивка запущена', {
        timeout: 30000,
      });
      await expect(firmware.locator('.notice.success')).toContainText(
        'новый образ и загрузочный раздел',
      );
      assert.equal(uploads.length, 1, 'A GUI installation uploads its artifact exactly once');
      const runningFirmware = await request(
        '/homes/' + homeId + '/hub/devices/fcplcn-demo-living/service/firmware',
      ).then((reply) => reply.json());
      assert.equal(runningFirmware.imageId, image.subarray(176, 208).toString('hex'));
      assert.equal(runningFirmware.version, '1.0.0-cloud-test');
      const afterFirmware = await request(
        '/homes/' + homeId + '/hub/devices/fcplcn-demo-living/service/config',
      ).then((reply) => reply.json());
      assert.deepEqual(afterFirmware, saved, 'Cloud OTA preserves the complete PLC configuration');
      await shot('cloud-firmware-desktop');
      await page.setViewportSize({ width: 390, height: 900 });
      await shot('cloud-firmware-mobile');
      await page.setViewportSize({ width: 1440, height: 1050 });
      page.off('request', recordUpload);
    }
    await page.locator('[data-cloud-nav="access"]').click();
    await page.getByLabel('Электронная почта', { exact: false }).fill('viewer@example.test');
    await page.getByLabel('Права доступа').selectOption('viewer');
    await page.getByRole('button', { name: 'Создать приглашение' }).click();
    const inviteURL = page.locator('.secret-card input[readonly]');
    await expect(inviteURL).toHaveValue(/(?:\/invite\/|\?invite=)/);
    const url = await inviteURL.inputValue();
    const viewer = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const visitor = await viewer.newPage();
    await visitor.goto(url);
    await visitor.getByLabel('Ваше имя').fill('Анна · наблюдатель');
    await visitor.getByLabel('Электронная почта', { exact: true }).fill('viewer@example.test');
    await visitor.getByLabel('Пароль', { exact: true }).fill('FCPLCn-viewer-password-123');
    await visitor.getByRole('button', { name: 'Создать учётную запись' }).click();
    await expect(visitor.getByRole('heading', { name: 'Дом FCPLCn.' })).toBeVisible();
    const legacy = await browser.newContext();
    assert.equal(
      (
        await request(
          '/auth/login',
          { email: 'viewer@example.test', password: 'FCPLCn-viewer-password-123' },
          'POST',
          legacy,
        )
      ).status(),
      200,
      'Existing email-based account clients remain compatible with the username login API',
    );
    assert.equal((await session(legacy)).user.username, 'viewer@example.test');
    await legacy.close();
    const readPortal = visitor.frameLocator('[data-hub-portal]');
    await readPortal.locator('[data-device-id="fcplcn-demo-living"]').click();
    await expect(readPortal.locator('[data-item-id="light-main"] button')).toBeDisabled();
    assert.equal(await readPortal.locator('[data-security-demo-touch]').count(), 0);
    assert.equal(
      (
        await request(
          '/homes/' + homeId + '/hub/devices/fcplcn-demo-garage/security/key',
          {},
          'POST',
          viewer,
        )
      ).status(),
      403,
    );
    await expect(readPortal.locator('[data-edit-illustration]')).not.toBeVisible();
    assert.equal(await readPortal.locator('[data-illustration-picker]').count(), 0);
    assert.equal(
      (
        await request(
          '/homes/' + homeId + '/hub/devices/fcplcn-demo-garage',
          { name: 'Гараж', room: '', illustrationId: 'house' },
          'PATCH',
          viewer,
        )
      ).status(),
      403,
    );
    assert.equal(await readPortal.locator('[data-plc-configure]').count(), 0);
    assert.equal(await visitor.locator('[data-cloud-nav="access"]').count(), 0);
    assert.equal(await visitor.locator('[data-cloud-nav="firmware"]').count(), 0);
    assert.equal(
      (
        await request('/homes/' + homeId + '/firmware/jobs/active', undefined, 'GET', viewer)
      ).status(),
      403,
    );
    const denied = await request(
      '/homes/' + homeId + '/hub/devices/fcplcn-demo-living/commands',
      { controller: 'lights', itemId: 'light-main', value: true },
      'POST',
      viewer,
    );
    assert.equal(denied.status(), 403);
    const second = await request('/homes', { name: 'Другой дом' }).then((reply) => reply.json());
    assert.ok(
      [403, 404].includes(
        (await request('/homes/' + second.id, undefined, 'GET', viewer)).status(),
      ),
      'Another home is not disclosed to the observer',
    );
    await visitor.screenshot({
      path: path.join(artifacts, 'cloud-viewer-mobile.png'),
      fullPage: true,
    });
    assert.equal(
      await visitor.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    const membership = (
      await request('/homes/' + homeId + '/members').then((reply) => reply.json())
    ).members.find((member) => member.email === 'viewer@example.test');
    assert.ok(membership);
    assert.equal(
      (
        await request(
          '/homes/' + homeId + '/members/' + membership.userId,
          { role: 'operator', securityControl: false },
          'PATCH',
        )
      ).status(),
      200,
    );
    await expect(visitor.locator('.eyebrow').first()).toContainText('Пользователь');
    assert.equal(await visitor.locator('[data-cloud-nav="firmware"]').count(), 0);
    await readPortal.locator('[data-device-id="fcplcn-demo-living"]').click();
    await expect(readPortal.locator('[data-item-id="light-main"] button')).toBeEnabled();
    assert.equal(await readPortal.locator('[data-security-demo-touch]').count(), 0);
    assert.equal(
      (
        await request(
          '/homes/' + homeId + '/hub/devices/fcplcn-demo-garage/security/key',
          {},
          'POST',
          viewer,
        )
      ).status(),
      403,
    );
    await expect(readPortal.locator('[data-edit-illustration]')).not.toBeVisible();
    assert.equal(await readPortal.locator('[data-illustration-picker]').count(), 0);
    assert.equal(
      (
        await request(
          '/homes/' + homeId + '/hub/devices/fcplcn-demo-garage',
          { name: 'Гараж', room: '', illustrationId: 'house' },
          'PATCH',
          viewer,
        )
      ).status(),
      403,
    );
    assert.equal(
      (
        await request('/homes/' + homeId + '/hub/overview').then((reply) => reply.json())
      ).devices.find((device) => device.id === 'fcplcn-demo-garage').illustrationId,
      securityOnly ? 'board' : 'garage',
    );
    if (securityOnly) {
      assert.equal(
        (
          await request(
            '/homes/' + homeId + '/members/' + membership.userId,
            { role: 'operator', securityControl: true },
            'PATCH',
          )
        ).status(),
        200,
      );
      await expect(readPortal.locator('[data-device-id="fcplcn-demo-living"]')).toBeVisible();
      await readPortal.locator('[data-device-id="fcplcn-demo-living"]').click();
      await expect(readPortal.locator('[data-security-demo-touch]')).toBeEnabled();
      const touchReply = visitor.waitForResponse(
        (reply) =>
          reply.url().endsWith('/devices/fcplcn-demo-living/security/key') &&
          reply.request().method() === 'POST',
      );
      const before = (
        await request('/homes/' + homeId + '/hub/overview').then((reply) => reply.json())
      ).scenes.runs.length;
      await readPortal.locator('[data-security-demo-touch]').click();
      assert.equal((await touchReply).status(), 200);
      await expect
        .poll(
          async () => {
            const state = await request('/homes/' + homeId + '/hub/overview').then((reply) =>
              reply.json(),
            );
            return (
              state.houseSecurity?.desiredArmed === false && state.scenes.runs.length === before + 1
            );
          },
          { timeout: 15000 },
        )
        .toBe(true);
      online = false;
      await expect(visitor.locator('.connection-badge')).toContainText('Хаб недоступен');
      await expect(readPortal.locator('[data-house-security]')).toHaveAttribute(
        'data-house-stale',
        'true',
      );
      await expect(readPortal.locator('[data-house-security-count]')).toContainText(
        'Нет свежих подтверждений',
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      await viewer.close();
      console.log(
        'FCPLCn cloud key permissions passed: owner and explicitly allowed operator touch; observer and ordinary operator denied.',
      );
      return;
    }
    if (illustrationOnly) {
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      await viewer.close();
      console.log(
        'FCPLCn cloud illustration permissions passed: owner edit, viewer/operator read-only UI and API denial.',
      );
      return;
    }
    await readPortal.locator('[data-nav="overview"]').click();
    await expect(readPortal.locator('[data-scene-run="home"]')).toBeDisabled();
    await expect(readPortal.locator('[data-scene-run="away"]')).toBeDisabled();
    await expect(readPortal.locator('[data-scene-run="prepare"]')).toBeEnabled();
    await readPortal.locator('[data-device-id="fcplcn-demo-living"]').click();
    const guard = readPortal.locator('[data-security-action]');
    if (await guard.count()) await expect(guard).toBeDisabled();
    await page.locator('[data-cloud-nav="connection"]').click();
    await page.setViewportSize({ width: 390, height: 900 });
    await shot('cloud-owner-mobile');
    await page.locator('.account-button').click();
    await page.getByLabel('Текущий пароль', { exact: true }).fill('FCPLCn-owner-password-123');
    await page.getByRole('button', { name: 'Настроить двухфакторную защиту' }).click();
    const secret = await page.locator('.secret-card>code').innerText();
    await page.getByLabel('Код подтверждения', { exact: true }).fill(totp(secret));
    await page.getByRole('button', { name: 'Подтвердить включение' }).click();
    await expect(page.getByText('Сохраните коды восстановления')).toBeVisible();
    await expect(page.locator('.facts')).toContainText('Включена');
    await page.getByRole('button', { name: 'Выйти из облака' }).click();
    await expect(page.getByRole('heading', { name: 'Войти в свой дом' })).toBeVisible();
    await page.getByLabel('Логин', { exact: true }).fill('sergey');
    await page.getByLabel('Пароль', { exact: true }).fill('FCPLCn-owner-password-123');
    await page.getByLabel('Код двухфакторной защиты', { exact: false }).fill(totp(secret));
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.locator('#selected-home')).toBeVisible();
    assert.equal((await session()).user.totpEnabled, true);
    await page.locator('.cloud-topbar .brand').click();
    await page.locator('[data-cloud-nav="control"]').click();
    await portal.locator('[data-device-id="fcplcn-demo-living"]').waitFor();
    await require('../../hub/tests/house-security.browser.cjs').checkHouseSecurity({
      page,
      scope: portal,
      request: (route, body, method = body === undefined ? 'GET' : 'POST') =>
        request('/homes/' + homeId + '/hub' + route, body, method),
      harness: securityHarness,
      control,
      artifacts,
      label: 'cloud',
      expect,
    });
    const beforeOffline = engine.snapshot().commands.length;
    online = false;
    await expect(visitor.locator('.connection-badge')).toContainText('Хаб недоступен');
    await expect(readPortal.locator('[data-house-security]')).toHaveAttribute(
      'data-house-stale',
      'true',
    );
    await expect(readPortal.locator('[data-house-security-count]')).toContainText(
      'Нет свежих подтверждений',
    );
    await expect(readPortal.locator('[data-item-id="light-main"] button')).toBeDisabled();
    assert.equal(
      (
        await request(
          '/homes/' + homeId + '/hub/devices/fcplcn-demo-living/commands',
          { controller: 'lights', itemId: 'light-main', value: true },
          'POST',
          viewer,
        )
      ).status(),
      503,
    );
    assert.equal(
      engine.snapshot().commands.length,
      beforeOffline,
      'An offline cloud command is never queued locally',
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    await viewer.close();
    console.log(
      'FCPLCn cloud browser passed: real PostgreSQL/auth, admin with empty password, editable persisted credentials and restart, legacy email login, home pairing, shared hub and PLC editor, confirmed command, real HTTP artifact upload and verified virtual PLC update, named invitations, observer/operator restrictions, cross-home isolation, TOTP and mobile layout.',
    );
    console.log(
      'Browser bridge uses real HubControl with virtual PLCs; TLS MQTT transport is covered independently.',
    );
  } catch (error) {
    if (page)
      await page
        .screenshot({ path: path.join(artifacts, 'cloud-browser-failure.png'), fullPage: true })
        .catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await installer?.stop();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    control?.close();
    await scenes?.stop();
    await engine?.stop();
    await db.close();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
