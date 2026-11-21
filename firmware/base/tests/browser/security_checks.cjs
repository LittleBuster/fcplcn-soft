/** @file security_checks.cjs @brief Exercise autonomous alarm configuration, contacts, timing and persistence. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { demoKeys } = require('./security_mock.cjs');

/** @brief Drive the shipped alarm UI and verify outputs through an isolated virtual PLC. */
async function checkSecurity({ browser, createMock, artifacts }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcplcn-security-'));
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
  const post = (route, data) =>
    context.request.post(`${url}${route.startsWith('/__') ? route : '/api/v1' + route}`, { data });
  const alarm = () => mock.security.snapshot();
  const row = (id) => page.locator(`[data-security-id="${id}"]`);
  const field = (id, name) => row(id).locator(`[data-security-field="${name}"]`);
  const visual = () => page.locator('[data-security-armed]');
  async function save() {
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith('/controllers/security') && response.request().method() === 'POST',
    );
    await page.locator('#security-save').click();
    assert.equal((await response).status(), 200);
  }
  async function settled(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail('Alarm condition did not settle');
  }
  async function arm(value) {
    await page.waitForFunction(
      (value) =>
        document.querySelector('[data-security-armed]')?.getAttribute('aria-pressed') ===
        String(!value),
      value,
    );
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith('/security/armed') && response.request().method() === 'POST',
    );
    await visual().click();
    assert.equal((await response).status(), 200);
    await settled(() => alarm().armed === value);
  }
  /** @brief Enable the module without issuing an arming command. */
  async function toggleModule(selector) {
    const target = !alarm().enabled;
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith('/controllers/security') && response.request().method() === 'POST',
    );
    await page.locator(selector).click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(
      ({ selector, target }) =>
        document.querySelector(selector)?.getAttribute('aria-pressed') === String(target),
      { selector, target },
    );
    assert.equal(alarm().enabled, target);
    assert.equal(alarm().armed, false, 'Module enable never arms the alarm');
    assert.equal(alarm().triggered, false);
  }
  async function add(name, inputId, type, entryDelay = false) {
    await page.locator('#security-add').click();
    const id = await page.locator('[data-security-id]').last().getAttribute('data-security-id');
    await field(id, 'name').fill(name);
    await field(id, 'inputId').selectOption(inputId);
    await field(id, 'sensorType').selectOption(type);
    if (entryDelay) await field(id, 'entryDelay').check();
    return id;
  }
  try {
    await page.goto(url);
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-controllers').click();
    assert.equal(await page.locator('[data-controller-id]').count(), 5);
    await toggleModule('#security-tile-enabled');
    assert.equal(alarm().phase, 'disarmed');
    assert.equal(alarm().readyToArm, false);
    assert.equal(alarm().error, '');
    assert.equal(
      (await post('/controllers/security/armed', { value: true })).status(),
      409,
      'Unconfigured module can be enabled, but cannot be armed',
    );
    const emptyBackup = await (await context.request.get(url + '/api/v1/config/backup')).json();
    assert.equal(mock.controllers.validateRestore(emptyBackup.controllers), '');
    const invalidArmed = JSON.parse(JSON.stringify(emptyBackup.controllers));
    invalidArmed.security.armed = true;
    assert.ok(mock.controllers.validateRestore(invalidArmed));
    const enabledRestart = createMock({ statePath });
    try {
      assert.equal(enabledRestart.security.snapshot().enabled, true);
      assert.equal(enabledRestart.security.snapshot().phase, 'disarmed');
      assert.equal(enabledRestart.security.snapshot().triggered, false);
    } finally {
      enabledRestart.controllers.close();
    }
    await page.locator('#security-open').click();
    await toggleModule('#security-enabled');
    await toggleModule('#security-enabled');
    assert.equal(await page.locator('#security-arm-error').isVisible(), false);
    await toggleModule('#security-enabled');
    await page.locator('#security-siren').selectOption('rly-0/16');
    await page.locator('#security-exit-delay').fill('0');
    await page.locator('#security-exit-delay').dispatchEvent('change');
    const webOnlyZone = await add('Дверь без считывателя', 'in-0/16', 'reed');
    await save();
    await toggleModule('#security-enabled');
    await settled(() => alarm().readyToArm);
    await arm(true);
    assert.equal(alarm().readerPortId, '', 'Web arming does not require an iButton reader');
    await post('/__simulator/security-zone', { id: webOnlyZone, active: true });
    await settled(() => alarm().phase === 'alarm');
    await page.waitForFunction(
      () => document.querySelector('[data-security-armed]')?.dataset.phase === 'alarm',
    );
    assert.equal(await visual().locator('use').getAttribute('href'), '#visual-security-alarm');
    assert.equal(await visual().locator('.controller-visual-caption').textContent(), 'Тревога');
    assert.equal(
      await row(webOnlyZone).locator('[data-security-visual] use').getAttribute('href'),
      '#visual-door',
    );
    assert.equal(
      await row(webOnlyZone).locator('.controller-visual-caption').textContent(),
      'Тревога',
    );
    const alarmColors = await visual().evaluate((node) => ({
      icon: getComputedStyle(node.querySelector('.controller-visual-icon')).color,
      caption: getComputedStyle(node.querySelector('.controller-visual-caption')).color,
    }));
    assert.equal(alarmColors.icon, alarmColors.caption, 'Alarm icon and text share the red tone');
    const channels = alarmColors.icon.match(/[\d.]+/g).map(Number);
    assert.ok(channels[0] > channels[1] && channels[0] > channels[2], 'Alarm tone is red');
    const reedAlarmColor = await row(webOnlyZone)
      .locator('.controller-visual-icon')
      .evaluate((node) => getComputedStyle(node).color);
    assert.equal(reedAlarmColor, alarmColors.icon, 'Active reed keeps its door icon in red');
    for (const [width, name] of [
      [1280, 'desktop'],
      [390, 'mobile'],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({
        path: path.join(artifacts, `security-alarm-${name}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    await arm(false);
    await post('/__simulator/security-zone', { id: webOnlyZone, active: false });
    await settled(() => alarm().items.every((item) => item.available && !item.active));
    await page.locator('#security-siren').selectOption('');
    await save();
    await settled(() => alarm().readyToArm);
    await arm(true);
    await post('/__simulator/security-zone', { id: webOnlyZone, active: true });
    await settled(() => alarm().phase === 'alarm');
    assert.equal(alarm().sirenActual, null, 'Visual-only alarm does not invent a siren output');
    await arm(false);
    await post('/__simulator/security-zone', { id: webOnlyZone, active: false });
    await page.locator(`[data-security-remove="${webOnlyZone}"]`).click();
    await save();
    await toggleModule('#security-enabled');
    await page.locator('#security-reader').selectOption('sens-0/8');
    await page.locator('#security-siren').selectOption('rly-0/16');
    await page.locator('#security-exit-delay').fill('0');
    await page.locator('#security-exit-delay').dispatchEvent('change');
    await page.locator('#security-entry-delay').fill('3');
    await page.locator('#security-entry-delay').dispatchEvent('change');
    const reed = await add('Входная дверь', 'in-0/16', 'reed', true);
    const motion = await add('Движение', 'in-0/15', 'motion');
    assert.equal(
      await row(reed).evaluate((node) =>
        node.firstElementChild.hasAttribute('data-security-visual'),
      ),
      true,
    );
    assert.equal(await row(reed).locator('use').first().getAttribute('href'), '#visual-door');
    assert.equal(await row(motion).locator('use').first().getAttribute('href'), '#visual-motion');
    await post('/__simulator/ibutton', { address: demoKeys[0], present: true });
    await page.locator('#security-key-scan').click();
    await page
      .locator(`#security-key-address option[value="${demoKeys[0]}"]`)
      .waitFor({ state: 'attached' });
    await page.locator('#security-key-name').fill('Семья');
    await page.locator('#security-key-address').selectOption(demoKeys[0]);
    await page.locator('#security-key-add').click();
    assert.equal(await page.locator('[data-security-key-remove]').count(), 1);
    await save();
    const enabled = page.waitForResponse(
      (response) =>
        response.url().endsWith('/controllers/security') && response.request().method() === 'POST',
    );
    await page.locator('#security-enabled').click();
    assert.equal((await enabled).status(), 200);
    await settled(() => alarm().readyToArm);
    await page.waitForFunction(() => !document.querySelector('[data-security-armed]').disabled);
    mock.controllers.setSecurityReaderFault('Считыватель недоступен');
    await arm(true);
    assert.equal(alarm().phase, 'armed', 'Reader failure does not block web arming');
    await arm(false);
    mock.controllers.setSecurityReaderFault('');
    assert.equal(
      alarm().items.find((item) => item.id === reed).inputLevel,
      false,
      'Closed reed is LOW and normal',
    );
    assert.equal(
      alarm().items.find((item) => item.id === motion).inputLevel,
      true,
      'Open motion contact is HIGH and normal',
    );
    await arm(true);
    assert.equal(alarm().phase, 'armed');
    assert.equal(
      (await post('/controllers/security/scan', { portId: 'sens-0/8', refresh: true })).status(),
      409,
      'Enrollment rejected while armed',
    );
    await post('/__simulator/security-zone', { id: reed, active: true });
    await settled(() => alarm().phase === 'entry_delay');
    assert.equal(alarm().sirenActual, false);
    await post('/__simulator/security-zone', { id: reed, active: false });
    mock.controllers.advanceSecurityTime(3500);
    await settled(() => alarm().phase === 'alarm');
    assert.equal(
      alarm().sirenActual,
      true,
      'Closing delayed entry does not cancel alarm countdown',
    );
    mock.controllers.reboot();
    assert.equal(alarm().armed, true);
    assert.equal(alarm().triggered, true);
    assert.equal(alarm().sirenActual, true, 'Latched alarm is restored at reboot');
    const diskRestart = createMock({ statePath });
    try {
      assert.equal(diskRestart.security.snapshot().armed, true);
      assert.equal(diskRestart.security.snapshot().triggered, true);
      assert.equal(
        diskRestart.security.snapshot().sirenActual,
        true,
        'A new simulator process restores the durable alarm',
      );
    } finally {
      diskRestart.controllers.close();
    }
    await post('/__simulator/ibutton', { present: false });
    mock.controllers.advanceSecurityTime(31000);
    mock.controllers.advanceSecurityTime(200);
    await post('/__simulator/ibutton', { address: demoKeys[0], present: true });
    mock.controllers.advanceSecurityTime(200);
    await settled(() => !alarm().armed);
    assert.equal(alarm().sirenActual, false);
    mock.controllers.advanceSecurityTime(10000);
    assert.equal(alarm().armed, false, 'Held authorized key never toggles repeatedly');
    await post('/__simulator/ibutton', { present: false });
    mock.controllers.advanceSecurityTime(200);
    mock.controllers.advanceSecurityTime(200);
    await post('/__simulator/ibutton', { address: demoKeys[1], present: true });
    mock.controllers.advanceSecurityTime(200);
    assert.equal(alarm().armed, false, 'Unknown key ignored');
    await post('/__simulator/ibutton', { present: false });
    mock.controllers.advanceSecurityTime(200);
    mock.controllers.advanceSecurityTime(200);
    await post('/__simulator/ibutton', { address: demoKeys[0], present: true });
    mock.controllers.advanceSecurityTime(200);
    await settled(() => alarm().armed);
    assert.equal(alarm().phase, 'armed', 'Known key arms after a released contact');
    await post('/__simulator/security-zone', { id: reed, active: true });
    await settled(() => alarm().phase === 'entry_delay');
    assert.equal(alarm().triggered, true, 'Intrusion is durable before the entry grace expires');
    assert.equal(alarm().sirenActual, false, 'Entry grace holds the siren OFF');
    await post('/__simulator/security-zone', { id: reed, active: false });
    await settled(() => alarm().items.every((item) => item.available && !item.active));
    mock.controllers.reboot();
    assert.equal(alarm().phase, 'alarm', 'A reboot cannot grant a new entry grace after intrusion');
    assert.equal(alarm().sirenActual, true);
    await arm(false);
    await arm(true);
    await post('/__simulator/security-zone', { id: motion, active: true });
    await settled(() => alarm().triggered);
    assert.equal(alarm().sirenActual, true, 'Motion contact closing causes immediate alarm');
    await page.waitForFunction(
      (id) =>
        document.querySelector(`[data-security-id="${id}"] [data-security-visual]`)?.dataset
          .state === 'error',
      motion,
    );
    assert.equal(
      await row(motion).locator('[data-security-visual] use').getAttribute('href'),
      '#visual-motion',
    );
    assert.equal(await row(motion).locator('.controller-visual-caption').textContent(), 'Тревога');
    const motionAlarmColor = await row(motion)
      .locator('.controller-visual-icon')
      .evaluate((node) => getComputedStyle(node).color);
    assert.equal(motionAlarmColor, alarmColors.icon, 'Active motion keeps its motion icon in red');
    await arm(false);
    await post('/__simulator/security-zone', { id: motion, active: false });
    await settled(() => alarm().items.every((item) => item.available && !item.active));
    await page.locator('#security-exit-delay').fill('2');
    await page.locator('#security-exit-delay').dispatchEvent('change');
    await save();
    await arm(true);
    assert.equal(alarm().phase, 'exit_delay');
    await post('/__simulator/security-zone', { id: reed, active: true });
    await settled(() => alarm().items.find((item) => item.id === reed).active);
    assert.equal(alarm().triggered, false, 'Exit grace tolerates active healthy zones');
    await post('/__simulator/security-zone', { id: reed, active: false });
    await settled(() => alarm().items.every((item) => item.available && !item.active));
    mock.controllers.advanceSecurityTime(2500);
    assert.equal(alarm().phase, 'armed');
    mock.controllers.reboot();
    assert.equal(alarm().phase, 'armed', 'Armed reboot does not create another free exit period');
    await arm(false);
    await page.locator('#security-back').click();
    await page.locator('#sockets-open').click();
    await page.locator('#sockets-add').click();
    const socket = await page.locator('[data-socket-id]').last().getAttribute('data-socket-id');
    assert.equal(
      await page
        .locator(
          `[data-socket-id="${socket}"] [data-socket-field="relayId"] option[value="rly-0/16"]`,
        )
        .isDisabled(),
      true,
      'Siren relay is reserved',
    );
    assert.equal(
      await page
        .locator(
          `[data-socket-id="${socket}"] [data-socket-field="inputId"] option[value="in-0/16"]`,
        )
        .isDisabled(),
      true,
      'Alarm input is reserved',
    );
    await page.locator(`[data-socket-remove="${socket}"]`).click();
    await page.locator('#sockets-back').click();
    await page.locator('#meteo-open').click();
    await page.locator('#meteo-add').click();
    const meteo = await page.locator('[data-meteo-id]').last().getAttribute('data-meteo-id');
    assert.equal(
      await page
        .locator(`[data-meteo-id="${meteo}"] [data-meteo-field="portId"] option[value="sens-0/8"]`)
        .isDisabled(),
      true,
      'iButton port is exclusive',
    );
    assert.equal(
      (await post('/controllers/meteo/scan', { portId: 'sens-0/8', refresh: true })).status(),
      409,
      'Direct OneWire scan cannot use the saved reader port',
    );
    await page.locator(`[data-meteo-remove="${meteo}"]`).click();
    await page.locator('#meteo-back').click();
    await page.locator('#security-open').click();
    for (const [width, name] of [
      [1280, 'desktop'],
      [390, 'mobile'],
      [320, 'narrow'],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({
        path: path.join(artifacts, `security-${name}.png`),
        fullPage: true,
        animations: 'disabled',
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `No overflow at ${width}`,
      );
    }
    const exported = await (await context.request.get(url + '/api/v1/config/backup')).json();
    assert.equal(exported.version, 8);
    const invalidRestore = JSON.parse(JSON.stringify(exported.controllers));
    invalidRestore.security = {
      ...invalidRestore.security,
      enabled: false,
      armed: true,
      triggered: true,
    };
    assert.ok(
      mock.controllers.validateRestore(invalidRestore),
      'A disabled module cannot restore armed/alarm flags',
    );
    assert.equal(exported.controllers.security.keys[0].address, demoKeys[0]);
    assert.equal(exported.controllers.security.items.length, 2);
    const disk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(disk.version, 8);
    assert.equal(disk.controllers.security.keys.length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    mock.controllers.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log(
    'FCPLCn security checks passed: independent module enable/arming, key discovery/allowlist/one-touch, NC/NO zone polarity, entry/exit timing, latched alarm/reboot, resource exclusivity, JSON v8 and responsive layout.',
  );
}
module.exports = { checkSecurity };
