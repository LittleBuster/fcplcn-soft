/**
 * @file state_memory_checks.cjs
 * @brief Verify profile activation and EEPROM-specific memory diagnostics in the shipped UI.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalBoardId, eepromBoardId } = require('./board_profiles_mock.cjs');

/** @brief Select the physical EEPROM profile, reboot, and inspect its real UI contract. */
async function checkStateMemory({ browser, createMock, artifacts }) {
  const mock = createMock({ interactive: true });
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${mock.server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const waitText = (id, text) => page.locator(`#${id}`).getByText(text, { exact: true }).waitFor();
  const save = () =>
    page.waitForResponse((r) => r.url().endsWith('/config') && r.request().method() === 'POST');
  const reboot = () => page.waitForResponse((r) => r.url().endsWith('/reboot'));
  try {
    await page.goto(url);
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-system').click();
    await page.waitForFunction(() => !document.getElementById('hardware-board-id').disabled);
    assert.deepEqual(
      await page
        .locator('#hardware-board-id option')
        .evaluateAll((options) => options.map((o) => o.value)),
      [canonicalBoardId, eepromBoardId],
    );
    const profiles = await (await page.request.get(`${url}/api/v1/board-profiles`)).json();
    const eeprom = profiles.find((profile) => profile.boardId === eepromBoardId);
    assert.equal(eeprom.stateMemory.type, 'eeprom');
    assert.equal(eeprom.stateMemory.capacityBytes, 65536);
    assert.equal(eeprom.stateMemory.pageSizeBytes, 128);
    assert.equal(eeprom.capabilities.fram, false);
    assert.equal(eeprom.capabilities.eeprom, true);
    assert.equal(Object.hasOwn(eeprom, 'fram'), false);

    await page.locator('#hardware-board-id').selectOption(eepromBoardId);
    mock.setFaults({ reboot: 'Reboot held to inspect the active board' });
    const pendingSave = save();
    const pendingReboot = reboot();
    await page.locator('#hardware-save').click();
    assert.equal((await pendingSave).status(), 200);
    assert.equal((await pendingReboot).status(), 500);
    assert.equal(mock.activeBoardId, canonicalBoardId);
    await page.locator('#tab-hardware').click();
    await waitText('hardware-fram-title', 'Память FRAM');
    assert.equal(await page.locator('#hardware-fram-model').textContent(), 'FM24CL64B-GTR');

    await page.locator('#tab-system').click();
    mock.setFaults({ reboot: '' });
    const finalSave = save();
    const acceptedReboot = reboot();
    await page.locator('#hardware-save').click();
    assert.equal((await finalSave).status(), 200);
    assert.equal((await acceptedReboot).status(), 200);
    await page.locator('#login-view').waitFor({ state: 'visible' });
    assert.equal(mock.activeBoardId, eepromBoardId);
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-hardware').click();
    await waitText('hardware-fram-title', 'Память EEPROM');
    await waitText('hardware-fram-status', 'Исправна');
    assert.equal(await page.locator('#hardware-fram-model').textContent(), '24LC512-I/SM');
    assert.match(await page.locator('#hardware-fram-binding').textContent(), /io-expanders.*0x50/);
    assert.match(await page.locator('#hardware-fram-used').textContent(), /64\s*КиБ/);
    assert.equal(await page.locator('#hardware-fram-progress').evaluate((e) => e.max), 65536);
    assert.equal(await page.locator('#hardware-relays [data-channel-id]').count(), 8);
    assert.equal(await page.locator('#hardware-inputs [data-channel-id]').count(), 8);
    assert.equal(await page.locator('#hardware-sensors strong').count(), 8);
    const snapshot = mock.hardware.snapshot();
    assert.deepEqual(
      snapshot.sensors.map((sensor) => sensor.gpio),
      [15, 16, 17, 18, 8, 9, 47, 48],
    );
    assert.deepEqual(
      snapshot.relays.map((relay) => relay.pin),
      [7, 6, 5, 4, 3, 2, 1, 15],
    );
    assert.equal(snapshot.inputs[0].activeHigh, true);
    assert.equal(snapshot.i2c[0].sdaGpio, 2);
    assert.equal(snapshot.i2c[0].sclGpio, 1);
    assert.match(await page.locator('#hardware-pin-map').textContent(), /onewire-security/);

    mock.setHardwareFaults({ fram: 'missing' });
    await waitText('hardware-fram-status', 'Нет связи');
    assert.match(await page.locator('#hardware-fram-error').textContent(), /EEPROM/);
    assert.doesNotMatch(await page.locator('#hardware-fram-error').textContent(), /FRAM/);
    assert.equal(await page.locator('#hardware-fram-progress').isVisible(), false);
    mock.setHardwareFaults({ fram: 'corrupt' });
    await waitText('hardware-fram-status', 'Ошибка данных');
    assert.match(await page.locator('#hardware-fram-error').textContent(), /EEPROM/);
    mock.setHardwareFaults({ fram: '' });
    await waitText('hardware-fram-status', 'Исправна');
    assert.equal(await page.locator('#hardware-fram-error').isVisible(), false);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.locator('#hardware-fram-title').scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    fs.mkdirSync(artifacts, { recursive: true });
    await page
      .locator('.fram-card')
      .screenshot({ path: path.join(artifacts, 'eeprom-narrow.png') });
    assert.deepEqual(errors, []);
    console.log(
      'FCPLCn EEPROM UI checks passed: API registry, reboot-only activation, memory type/model/64KiB, legacy pin maps, faults and narrow layout.',
    );
  } finally {
    await context.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  }
}
module.exports = { checkStateMemory };
