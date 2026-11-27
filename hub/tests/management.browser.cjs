/** @file Verify the complete canonical PLC editor through the authenticated hub management path. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { expect } = require('@playwright/test');

/** @brief Create, bind, operate and remove all controller types without direct PLC HTTP access. */
async function checkManagement({ page, context, base, artifacts }) {
  const deviceId = 'fcplcn-demo-living';
  const service = `${base}/api/v1/devices/${deviceId}/service`;
  await page.locator('[data-nav="devices"]').click();
  await page.locator(`[data-device-id="${deviceId}"]`).click();
  await page.locator(`[data-plc-configure="${deviceId}"]`).click();
  assert.equal(
    await page.locator('.scene-cards .scene-card').count(),
    0,
    'PLC settings do not repeat overview quick scenes',
  );
  const frame = page.frameLocator('[data-plc-settings-frame]');
  await frame.locator('#app-view').waitFor({ state: 'visible' });
  assert.equal(
    await frame.locator('#logout').isVisible(),
    false,
    'Only the hub owns the login session',
  );
  const read = async (route) => {
    const response = await context.request.get(service + route);
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  const response = (route, method = 'POST') =>
    page.waitForResponse(
      (reply) => reply.url() === service + route && reply.request().method() === method,
    );
  const kinds = ['sockets', 'lights', 'meteo', 'thermostats', 'security', 'tanks'];
  async function open(kind) {
    await frame.locator('#tab-controllers').click();
    for (const previous of kinds)
      if (await frame.locator(`#${previous}-back`).isVisible()) {
        await frame.locator(`#${previous}-back`).click();
        break;
      }
    await frame.locator(`#${kind}-open`).click();
    await expect(frame.locator(`#${kind}-enabled`)).toBeEnabled();
  }
  async function enable(kind) {
    const button = frame.locator(`#${kind}-enabled`);
    if ((await button.getAttribute('aria-pressed')) === 'false') {
      const pending = response(`/controllers/${kind}`);
      await button.click();
      assert.equal((await pending).status(), 200);
      await expect(button).toHaveAttribute('aria-pressed', 'true');
    }
  }
  async function save(kind) {
    const pending = response(`/controllers/${kind}`);
    await frame.locator(`#${kind}-save`).click();
    const reply = await pending;
    assert.equal(reply.status(), 200, await reply.text());
  }
  const prefix = (kind) =>
    ({
      sockets: 'socket',
      lights: 'light',
      meteo: 'meteo',
      thermostats: 'thermostat',
      security: 'security',
      tanks: 'tank',
    })[kind];
  const row = (kind, id) => frame.locator(`[data-${prefix(kind)}-id="${id}"]`);
  const field = (kind, id, name) => row(kind, id).locator(`[data-${prefix(kind)}-field="${name}"]`);
  async function add(kind, name) {
    await frame.locator(`#${kind}-add`).click();
    const card = frame.locator(`[data-${prefix(kind)}-id]`).last();
    const id = await card.getAttribute(`data-${prefix(kind)}-id`);
    await field(kind, id, 'name').fill(name);
    return id;
  }

  await open('sockets');
  await enable('sockets');
  const socket = await add('sockets', 'Контактор через хаб');
  await field('sockets', socket, 'relayId').selectOption('rly-0/13');
  await field('sockets', socket, 'inputId').selectOption('in-0/10');
  await save('sockets');
  const toggle = row('sockets', socket).locator('[data-socket-toggle]');
  const set = response('/controllers/sockets/state');
  await toggle.click();
  assert.equal((await set).status(), 200);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  assert.equal(
    (await read('/controllers/sockets')).items.find((item) => item.id === socket).state,
    true,
  );
  await field('sockets', socket, 'name').fill('Контактор · изменён');
  await save('sockets');
  assert.equal(
    (await read('/controllers/sockets')).items.find((item) => item.id === socket).name,
    'Контактор · изменён',
  );

  await open('lights');
  await enable('lights');
  const light = await add('lights', 'Свет через хаб');
  await expect(
    field('lights', light, 'relayId').locator('option[value="rly-0/13"]'),
  ).toBeDisabled();
  await field('lights', light, 'relayId').selectOption('rly-0/14');
  await field('lights', light, 'inputId').selectOption('in-0/11');
  await save('lights');
  assert.equal(
    (await read('/controllers/lights')).items.find((item) => item.id === light).relayId,
    'rly-0/14',
  );

  await open('meteo');
  await enable('meteo');
  const sensor = await add('meteo', 'Метео через хаб');
  await field('meteo', sensor, 'sensorType').selectOption('dht22');
  await field('meteo', sensor, 'portId').selectOption('sens-0/7');
  await save('meteo');
  const oneWire = await add('meteo', 'OneWire через хаб');
  await field('meteo', oneWire, 'sensorType').selectOption('onewire');
  await field('meteo', oneWire, 'portId').selectOption('sens-0/8');
  await row('meteo', oneWire).locator('[data-meteo-scan]').click();
  await expect
    .poll(() => field('meteo', oneWire, 'address').locator('option[value^="28"]').count())
    .toBeGreaterThan(0);
  const serial = await field('meteo', oneWire, 'address')
    .locator('option[value^="28"]')
    .first()
    .getAttribute('value');
  await field('meteo', oneWire, 'address').selectOption(serial);
  await save('meteo');
  assert.equal(
    (await read('/controllers/meteo')).items.find((item) => item.id === oneWire).address,
    serial,
  );

  await open('thermostats');
  await enable('thermostats');
  const thermostat = await add('thermostats', 'Термостат через хаб');
  await field('thermostats', thermostat, 'meteoId').selectOption(sensor);
  await field('thermostats', thermostat, 'relayId').selectOption('rly-0/15');
  await field('thermostats', thermostat, 'inputId').selectOption('in-0/12');
  await field('thermostats', thermostat, 'mode').selectOption('cooling');
  await field('thermostats', thermostat, 'setpointC').fill('24');
  await field('thermostats', thermostat, 'hysteresisC').selectOption('2');
  await save('thermostats');
  const thermo = (await read('/controllers/thermostats')).items.find(
    (item) => item.id === thermostat,
  );
  assert.equal(thermo.mode, 'cooling');
  assert.equal(thermo.setpointC, 24);
  assert.equal(thermo.hysteresisC, 2);
  assert.equal(thermo.meteoId, sensor);

  await open('tanks');
  await enable('tanks');
  const tank = await add('tanks', 'Бак через хаб');
  await expect(field('tanks', tank, 'levelCount')).toHaveValue('2');
  await field('tanks', tank, 'pumpRelayId').selectOption('rly-0/11');
  await field('tanks', tank, 'valveRelayId').selectOption('rly-0/12');
  await row('tanks', tank).locator('[data-tank-level-index="0"]').selectOption('in-0/14');
  await row('tanks', tank).locator('[data-tank-level-index="1"]').selectOption('in-0/15');
  await field('tanks', tank, 'fillLevel').selectOption('2');
  await save('tanks');
  assert.equal(
    (await read('/controllers/tanks')).items.find((item) => item.id === tank).enabled,
    false,
  );
  const tankToggle = row('tanks', tank).locator('[data-tank-enabled]');
  const tankEnabled = response('/controllers/tanks/enabled');
  await tankToggle.click();
  assert.equal((await tankEnabled).status(), 200);
  await expect
    .poll(async () => {
      const item = (await read('/controllers/tanks')).items.find((item) => item.id === tank);
      return [item.enabled, item.levelPct, item.pumpActual, item.valveActual];
    })
    .toEqual([true, 0, false, true]);

  await require('./plc-notices.browser.cjs').checkPLCNotices({
    page,
    service,
    tankId: tank,
    artifacts,
  });

  await open('security');
  const shield = frame.locator('[data-security-armed]');
  if ((await shield.getAttribute('aria-pressed')) === 'true') {
    const pending = response('/controllers/security/armed');
    await shield.click();
    assert.equal((await pending).status(), 200);
    await expect(shield).toHaveAttribute('aria-pressed', 'false');
  }
  await enable('security');
  await frame.locator('#security-siren').selectOption('rly-0/16');
  await frame.locator('#security-reader').selectOption('sens-0/6');
  await frame.locator('#security-exit-delay').fill('12');
  await frame.locator('#security-exit-delay').dispatchEvent('change');
  await frame.locator('#security-entry-delay').fill('7');
  await frame.locator('#security-entry-delay').dispatchEvent('change');
  const zone = await add('security', 'Вход через хаб');
  await field('security', zone, 'inputId').selectOption('in-0/13');
  await field('security', zone, 'sensorType').selectOption('reed');
  await field('security', zone, 'entryDelay').check();
  await frame.locator('#security-key-scan').click();
  await expect
    .poll(() => frame.locator('#security-key-address option[value^="01"]').count())
    .toBeGreaterThan(0);
  const key = await frame
    .locator('#security-key-address option[value^="01"]')
    .first()
    .getAttribute('value');
  await frame.locator('#security-key-name').fill('Ключ через хаб');
  await frame.locator('#security-key-address').selectOption(key);
  await frame.locator('#security-key-add').click();
  await save('security');
  const guard = await read('/controllers/security');
  assert.equal(guard.readerPortId, 'sens-0/6');
  assert.equal(guard.exitDelaySeconds, 12);
  assert.equal(guard.entryDelaySeconds, 7);
  assert.ok(guard.keys.some((entry) => entry.address === key));

  await frame.locator('#tab-system').click();
  await expect(frame.locator('#hardware-board-id')).toBeEnabled();
  assert.equal(await frame.locator('#hardware-board-id').inputValue(), 'fcplcn-161608-1v0');
  await frame.locator('#device-name').fill('PLC · настроен через хаб');
  await frame.locator('#time-timezone').fill('UTC-7');
  await frame.locator('#time-ntp-enabled').check();
  await frame.locator('#time-ntp-server').fill('time.local');
  const systemSaved = response('/config');
  await frame.locator('#system-form button[type="submit"]').click();
  assert.equal((await systemSaved).status(), 200);
  const configuration = await read('/config');
  assert.equal(configuration.device.name, 'PLC · настроен через хаб');
  assert.equal(configuration.time.ntpServer, 'time.local');
  const downloadPromise = page.waitForEvent('download');
  await frame.locator('#config-backup-download').click();
  const download = await downloadPromise;
  const backupFile = path.join(artifacts, 'hub-plc-backup.json');
  await download.saveAs(backupFile);
  const backup = JSON.parse(await fs.readFile(backupFile, 'utf8'));
  assert.equal(backup.version, 10);
  assert.equal(backup.config.device.name, 'PLC · настроен через хаб');
  assert.ok(backup.controllers.sockets.items.some((item) => item.id === socket));
  assert.ok(backup.controllers.tanks.items.some((item) => item.id === tank));
  await frame.locator('#config-backup-file').setInputFiles(backupFile);
  await frame.locator('#config-backup-preview').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#config-backup-profile-warning').isVisible(), false);
  await frame.locator('#config-backup-clear').click();

  await page.setViewportSize({ width: 390, height: 1000 });
  await page.screenshot({
    path: path.join(artifacts, 'hub-plc-settings-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const childFrame = page.frames().find((entry) => entry.url().endsWith(`/plc/${deviceId}/`));
  assert.ok(childFrame);
  assert.equal(
    await childFrame.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Embedded service UI has no horizontal scrolling',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });

  // A hub status refresh must preserve the iframe and unsaved PLC form fields.
  await frame.locator('#device-name').fill('Черновик остаётся в PLC-редакторе');
  const before = childFrame;
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(frame.locator('#device-name')).toHaveValue('Черновик остаётся в PLC-редакторе');
  assert.ok(page.frames().includes(before), 'Polling preserves the same editor frame');
  await frame.locator('#device-name').fill('PLC · настроен через хаб');

  // Delete in dependency order; saved removal releases its ports for other controllers.
  for (const [kind, id] of [
    ['tanks', tank],
    ['security', zone],
    ['thermostats', thermostat],
    ['meteo', oneWire],
    ['meteo', sensor],
    ['lights', light],
    ['sockets', socket],
  ]) {
    await open(kind);
    if (kind === 'tanks') {
      const toggle = row(kind, id).locator('[data-tank-enabled]');
      if ((await toggle.getAttribute('aria-pressed')) === 'true') {
        const pending = response('/controllers/tanks/enabled');
        await toggle.click();
        assert.equal((await pending).status(), 200);
      }
    }
    if (kind === 'security') {
      // Earlier scene checks can leave asynchronous whole-house security work.
      // Wait only for in-flight work, not for matching the whole-house intent:
      // configuring an already-online module never implicitly arms it. A legitimate
      // unknown/local-override status must still permit this explicit disarm.
      await expect
        .poll(
          async () => {
            const reply = await context.request.get(`${base}/api/v1/overview`);
            assert.equal(reply.status(), 200, await reply.text());
            const snapshot = await reply.json();
            const house = snapshot.houseSecurity;
            const guard = house?.devices.find((entry) => entry.deviceId === deviceId);
            const device = snapshot.devices.find((entry) => entry.id === deviceId);
            return {
              sceneIdle: !snapshot.scenes.activeRun,
              houseIdle: house?.busy === false,
              guardOnline: guard?.online === true,
              configured: guard?.configured === true && guard?.enabled === true,
              moduleFresh: device?.controllers.security?.fresh === true,
              commandSettled: Boolean(guard && guard.status !== 'pending'),
            };
          },
          {
            message: 'Security work is idle and PLC data is fresh before local disarming',
            timeout: 10000,
          },
        )
        .toEqual({
          sceneIdle: true,
          houseIdle: true,
          guardOnline: true,
          configured: true,
          moduleFresh: true,
          commandSettled: true,
        });
      // Explicitly disarm through the common coordinator before removing its zones.
      const disarm = await context.request.post(`${base}/api/v1/devices/${deviceId}/commands`, {
        data: { controller: 'security', itemId: 'alarm', value: false },
      });
      assert.equal(disarm.status(), 200, await disarm.text());
      assert.equal((await disarm.json()).status, 'applied');
      await expect.poll(async () => (await read('/controllers/security')).armed).toBe(false);
    }
    await row(kind, id)
      .locator(`[data-${prefix(kind)}-remove]`)
      .click();
    await save(kind);
    assert.equal(
      (await read(`/controllers/${kind}`)).items.some((item) => item.id === id),
      false,
    );
  }
  await frame.locator('#tab-users').click();
  await frame.locator('#user-username').fill('hub-owner');
  await frame.locator('#user-current-password').fill('');
  const userSaved = response('/user');
  await frame.locator('#user-form button[type="submit"]').click();
  assert.equal((await userSaved).status(), 200);
  await frame.locator('#app-view').waitFor({ state: 'visible' });
  await expect.poll(async () => (await read('/config')).user.username).toBe('hub-owner');
  await expect(frame.locator('#login-form')).not.toBeVisible();
  await page.locator('[data-plc-settings-back]').click();
  console.log(
    'FCPLCn hub PLC settings checks passed: complete embedded service UI, controller CRUD/port ownership, OneWire/iButton scans, thermostat parameters, security, system/profile, private backup, account change, preserved drafts and mobile layout.',
  );
}

module.exports = { checkManagement };
