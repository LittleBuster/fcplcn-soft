/** @file Verify overview timeouts, wake recovery and rejection of late suspended reads. */
'use strict';
const assert = require('node:assert/strict');

/** Uses an isolated browser context against an already-running demo hub. */
async function checkPultWake({ browser, base, username = 'admin', password = '' }) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const errors = [];
  const held = [];
  let holdNext = false;
  let holdUntilRecovery = false;
  let marker = 'Проверка связи · исходный снимок';
  let waitingForHold;
  let closing = false;
  let stage = 'initial fresh snapshot';
  page.on('pageerror', (error) => errors.push(error.message));
  // Exercise the explicit cancellation race even if a sleeping browser ignores AbortSignal.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) =>
      String(input).endsWith('/api/v1/overview')
        ? originalFetch(input, { ...options, signal: undefined })
        : originalFetch(input, options);
    window.__wakeHidden = false;
    window.__wakeOnline = true;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => window.__wakeHidden,
    });
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => window.__wakeOnline,
    });
  });
  await page.route(`${base}/api/v1/overview`, async (route) => {
    try {
      const shouldHold = holdNext || holdUntilRecovery;
      holdNext = false;
      const response = await route.fetch();
      const data = await response.json();
      data.devices[0].name = marker;
      if (shouldHold) {
        held.push({ route, response, data });
        waitingForHold?.();
        return;
      }
      await route.fulfill({ response, json: data });
    } catch (error) {
      if (!closing) errors.push(String(error));
      await route.abort().catch(() => {});
    }
  });
  const nextHold = () => {
    holdNext = true;
    return new Promise((resolve) => {
      waitingForHold = resolve;
    });
  };
  const fresh = async (expectedName) => {
    await page.getByRole('heading', { name: expectedName, exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-house-security]')?.getAttribute('data-house-stale') ===
        'false',
    );
  };
  const stale = () =>
    page.waitForFunction(
      () =>
        document.querySelector('[data-house-security]')?.getAttribute('data-house-stale') ===
        'true',
    );
  const online = () => page.evaluate(() => window.dispatchEvent(new Event('online')));
  const completeOld = async (request) => {
    await request.route.fulfill({ response: request.response, json: request.data });
  };

  try {
    await page.clock.install();
    await page.goto(base);
    await page.getByLabel('Логин', { exact: true }).fill(username);
    await page.getByLabel('Пароль', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Войти в хаб' }).click();
    await fresh(marker);

    // A read that never settles must stop blocking refresh after the eight-second deadline.
    stage = 'overview timeout';
    holdUntilRecovery = true;
    const timeoutHeld = nextHold();
    await online();
    await timeoutHeld;
    await stale();
    await page.clock.fastForward(8100);
    await page.getByText(/Хаб не ответил вовремя/).waitFor();
    stage = 'online recovery after timeout';
    holdUntilRecovery = false;
    marker = 'Проверка связи · после таймаута';
    await online();
    await fresh(marker);
    while (held.length) await completeOld(held.shift());
    assert.equal(await page.getByRole('heading', { name: marker, exact: true }).count(), 1);

    // Hiding the page releases the request without an error; visible starts a new read now.
    stage = 'hidden cancellation';
    marker = 'Проверка связи · старый запрос до сна';
    const hiddenHeld = nextHold();
    await online();
    await hiddenHeld;
    await page.evaluate(() => {
      window.__wakeHidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await stale();
    assert.equal(await page.getByText(/Хаб не ответил вовремя/).count(), 0);
    stage = 'visibility recovery';
    marker = 'Проверка связи · после сна';
    await page.evaluate(() => {
      window.__wakeHidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await fresh(marker);
    while (held.length) await completeOld(held.shift());
    assert.equal(await page.getByRole('heading', { name: marker, exact: true }).count(), 1);

    stage = 'offline and online recovery';
    // The offline event immediately makes the last snapshot non-authoritative.
    await page.evaluate(() => {
      window.__wakeOnline = false;
      window.dispatchEvent(new Event('offline'));
    });
    await stale();
    marker = 'Проверка связи · сеть восстановлена';
    await page.evaluate(() => {
      window.__wakeOnline = true;
      window.dispatchEvent(new Event('online'));
    });
    await fresh(marker);
    assert.deepEqual(errors, []);
    console.log('Pult wake: timeout, hidden abort, online recovery and late reply checks passed');
  } catch (error) {
    console.error('Pult wake failed at:', stage);
    console.error(
      (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(0, 2400),
    );
    throw error;
  } finally {
    closing = true;
    for (const request of held) await request.route.abort().catch(() => {});
    await page.unrouteAll({ behavior: 'wait' });
    await context.close();
  }
}

module.exports = { checkPultWake };
