/**
 * @file controller_notices_checks.cjs
 * @brief Check replacement, expiry and session isolation of controller action notifications.
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

/** @brief Exercise visible acknowledgements across modules using a controlled browser clock. */
async function checkControllerNotices({ browser, createMock, artifacts }) {
  const mock = createMock();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${mock.server.address().port}`;
  const notices = page.locator(
    ':is(#sockets-notice, #lights-notice, #meteo-notice, #thermostats-notice):visible',
  );
  async function login() {
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-controllers').click();
    await page.locator('#lights-tile-enabled').waitFor({ state: 'visible' });
  }
  async function toggleModule(id, status = 200) {
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/controllers/${id}`) &&
        response.request().method() === 'POST',
    );
    await page.locator(`#${id}-tile-enabled`).click();
    assert.equal((await response).status(), status);
    await page.locator(`#${id}-notice`).waitFor({ state: 'visible' });
    assert.equal(await notices.count(), 1, 'Only the latest controller action is visible');
    return page.locator(`#${id}-notice`).textContent();
  }
  async function advance(milliseconds) {
    await page.clock.fastForward(milliseconds);
    // Let a real aggregate response complete, so polling also exercises notification rendering.
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/controllers') && response.request().method() === 'GET',
    );
    await page.clock.fastForward(1000);
    await response;
  }
  try {
    await page.goto(url);
    await login();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);

    assert.match(await toggleModule('sockets'), /Розетки/);
    await page.clock.fastForward(2500);
    assert.match(await toggleModule('lights'), /Свет/);
    assert.equal(await page.locator('#sockets-notice').isVisible(), false);
    await page.clock.fastForward(1600);
    assert.equal(
      await page.locator('#lights-notice').isVisible(),
      true,
      'An older notification timer cannot dismiss the newer acknowledgement',
    );
    await page.clock.fastForward(2500);
    assert.equal(await notices.count(), 0, 'Successful acknowledgements expire after four seconds');

    assert.match(await toggleModule('thermostats'), /Термостат/);
    await page.locator('#thermostats-open').click();
    assert.equal(await notices.count(), 1);
    await page.locator('#thermostats-back').click();
    assert.equal(
      await notices.count(),
      1,
      'Returning to the module list cannot reveal older banners',
    );
    await advance(4500);
    assert.equal(await notices.count(), 0, 'Polling cannot resurrect an expired acknowledgement');

    mock.setLightsFaults({ save: 'Test controller save failed' });
    assert.match(await toggleModule('lights', 503), /Test controller save failed/);
    await advance(5000);
    assert.equal(
      await notices.count(),
      1,
      'Action errors remain visible until a subsequent action',
    );
    assert.equal(await page.locator('#lights-notice').isVisible(), true);
    mock.setLightsFaults({ save: '' });
    assert.match(await toggleModule('sockets'), /Розетки/);
    assert.equal(await page.locator('#lights-notice').isVisible(), false);
    if (artifacts)
      await page.screenshot({
        path: path.join(artifacts, 'controller-notices.png'),
        animations: 'disabled',
        fullPage: true,
      });

    await page.clock.fastForward(2500);
    await page.locator('#logout').click();
    await page.locator('#login-view').waitFor({ state: 'visible' });
    await login();
    assert.equal(await notices.count(), 0, 'A new session starts without previous action messages');
    assert.match(await toggleModule('lights'), /Свет/);
    await page.clock.fastForward(1600);
    assert.equal(
      await page.locator('#lights-notice').isVisible(),
      true,
      'A timer from the prior session cannot clear a new acknowledgement',
    );
    await advance(2500);
    assert.equal(await notices.count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'FCPLCn controller notice checks passed: one current banner across modules, four-second success expiry, replacement timer isolation, persistent errors, polling/navigation and logout/login isolation.',
    );
  } finally {
    await context.close();
    mock.controllers.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  }
}

module.exports = { checkControllerNotices };
