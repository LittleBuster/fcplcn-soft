/**
 * @file sockets_checks.cjs
 * @brief Exercise socket configuration, momentary input semantics, persistence, and failures.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalBoardId, legacyBoardId } = require('./board_profiles_mock.cjs');

async function checkSockets({ browser, createMock, artifacts }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcplcn-sockets-ui-'));
  const statePath = path.join(directory, 'sockets.json');
  let mock = createMock({ interactive: true, statePath });
  mock.setHardwareInputs(Array(16).fill(true));
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('dialog', (dialog) => dialog.accept());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let url;
  const row = (id) => page.locator(`#sockets-items [data-socket-id="${id}"]`);
  const toggle = (id) => row(id).locator('[data-socket-toggle]');
  const apiResponse = (suffix = '') =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/controllers/sockets${suffix}`) &&
        response.request().method() === 'POST',
    );
  async function listen() {
    await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${mock.server.address().port}`;
  }
  async function login() {
    await page.goto(url);
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-controllers').click();
  }
  async function waitState(id, value) {
    await page.waitForFunction(
      ({ id, value }) =>
        document.querySelector(`[data-socket-toggle="${id}"]`)?.getAttribute('aria-pressed') ===
        String(value),
      { id, value },
    );
  }
  async function save() {
    const response = apiResponse();
    await page.locator('#sockets-save').click();
    assert.equal((await response).status(), 200);
  }
  async function add(name, relayId, inputId = '') {
    await page.locator('#sockets-add').click();
    const item = page.locator('#sockets-items [data-socket-id]').last();
    const id = await item.getAttribute('data-socket-id');
    await item.locator('[data-socket-name]').fill(name);
    await item.locator('[data-socket-relay]').selectOption(relayId);
    assert.equal(await item.locator('[data-socket-input]').inputValue(), '');
    if (inputId) await item.locator('[data-socket-input]').selectOption(inputId);
    return id;
  }
  async function command(id, value) {
    const response = apiResponse('/state');
    await toggle(id).click();
    assert.equal((await response).status(), 200);
    await waitState(id, value);
  }
  function rawInput(value) {
    mock.setHardwareInputs(Array(16).fill(value));
  }
  async function closeMock() {
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
  }
  try {
    await listen();
    assert.equal((await context.request.get(`${url}/api/v1/controllers/sockets`)).status(), 401);
    await login();
    await page.locator('#sockets-tile-enabled').waitFor();
    assert.equal(await page.locator('#sockets-view').isVisible(), false);
    assert.equal(mock.sockets.snapshot().enabled, false);
    assert.deepEqual(mock.sockets.snapshot().items, []);
    const enable = apiResponse();
    await page.locator('#sockets-tile-enabled').click();
    assert.equal((await enable).status(), 200);
    assert.equal(mock.sockets.snapshot().enabled, true);
    assert.equal(
      await page.locator('#controllers-list-view').isVisible(),
      true,
      'Tile switch does not navigate',
    );
    await page.locator('#sockets-open').click();
    await page.locator('#sockets-view').waitFor({ state: 'visible' });

    const first = await add('Рабочий стол', 'rly-0/1');
    await save();
    assert.equal(await toggle(first).evaluate((node) => node.tagName), 'BUTTON');
    assert.equal(
      await row(first).evaluate((node) => node.firstElementChild.matches('[data-socket-toggle]')),
      true,
      'The large clickable SVG precedes the card heading and settings',
    );
    assert.equal(await toggle(first).locator('svg.controller-visual-icon').count(), 1);
    assert.equal(await toggle(first).locator('use').getAttribute('href'), '#visual-plug');
    assert.equal(mock.sockets.snapshot().items[0].inputId, '', 'Input is optional');
    assert.equal(mock.sockets.snapshot().items[0].state, false);
    const configRevision = mock.sockets.snapshot().revision;
    mock.setSocketsFaults({ stateDelayMs: 250 });
    const turnOn = apiResponse('/state');
    await toggle(first).locator('svg').click();
    assert.equal(
      await toggle(first).getAttribute('aria-pressed'),
      'false',
      'Socket waits for confirmed response',
    );
    assert.equal(await toggle(first).getAttribute('aria-busy'), 'true');
    assert.equal(await toggle(first).getAttribute('data-state'), 'off');
    assert.equal(await toggle(first).isDisabled(), true, 'Pending SVG cannot submit twice');
    assert.equal((await turnOn).status(), 200);
    await waitState(first, true);
    assert.equal(
      mock.sockets.snapshot().revision,
      configRevision,
      'State changes do not advance configuration revision',
    );
    mock.setSocketsFaults({ stateDelayMs: 0 });
    assert.equal(await toggle(first).getAttribute('data-state'), 'on');
    for (const [key, value] of [
      ['Space', false],
      ['Enter', true],
    ]) {
      const reply = apiResponse('/state');
      await toggle(first).focus();
      await page.keyboard.press(key);
      assert.equal((await reply).status(), 200);
      await waitState(first, value);
      assert.equal(await toggle(first).getAttribute('data-state'), value ? 'on' : 'off');
    }
    mock.setSocketsFaults({ state: 'Test rejected state command' });
    const rejectedState = apiResponse('/state');
    await toggle(first).locator('svg').click();
    assert.equal((await rejectedState).status(), 503);
    assert.equal(mock.sockets.snapshot().items[0].state, true);
    assert.notEqual(
      await toggle(first).getAttribute('aria-pressed'),
      'false',
      'A rejected SVG command cannot display an unconfirmed OFF',
    );
    mock.setSocketsFaults({ state: '', get: 'Test unavailable controller poll' });
    await page.waitForFunction(
      (id) =>
        document.querySelector(`[data-socket-toggle="${id}"]`)?.disabled === true &&
        document.querySelector(`[data-socket-toggle="${id}"]`)?.getAttribute('aria-pressed') ===
          'mixed',
      first,
    );
    mock.setSocketsFaults({ get: '' });
    await waitState(first, true);
    await row(first).locator('[data-socket-relay]').selectOption('rly-0/16');
    assert.equal(await toggle(first).isDisabled(), true, 'Unsaved relay binding blocks the SVG');
    assert.equal(await toggle(first).getAttribute('aria-pressed'), 'mixed');
    await row(first).locator('[data-socket-relay]').selectOption('rly-0/1');
    await waitState(first, true);

    const second = await add('Торшер', 'rly-0/2', 'in-0/1');
    const third = await add('Вентилятор', 'rly-0/3', 'in-0/2');
    await save();
    assert.equal(mock.sockets.snapshot().items[0].state, true, 'Unchanged binding keeps its state');
    assert.equal(mock.sockets.snapshot().items[1].state, false);
    assert.equal(mock.sockets.snapshot().items[2].state, false);
    const now = Date.now() + 1000;
    rawInput(false);
    mock.sockets.tick(now);
    await waitState(second, true);
    await waitState(third, true);
    rawInput(true);
    mock.sockets.tick(now + 20);
    rawInput(false);
    mock.sockets.tick(now + 30);
    mock.sockets.tick(now + 10000);
    assert.deepEqual(
      mock.sockets.snapshot().items.map((item) => item.state),
      [true, true, true],
      'Bounce and a ten-second hold never repeat the press',
    );
    rawInput(true);
    mock.sockets.tick(now + 10001);
    mock.sockets.tick(now + 10050);
    assert.deepEqual(
      mock.sockets.snapshot().items.map((item) => item.state),
      [true, true, true],
      'Release never toggles',
    );
    mock.sockets.tick(now + 10051);
    rawInput(false);
    mock.sockets.tick(now + 10052);
    await waitState(second, false);
    await waitState(third, false);
    rawInput(true);
    mock.sockets.tick(now + 10053);
    mock.sockets.tick(now + 10352);
    mock.sockets.tick(now + 10402);
    assert.deepEqual(
      mock.sockets.snapshot().items.map((item) => item.state),
      [true, false, false],
      'Next complete press/release produces exactly one more toggle',
    );

    const saved = mock.sockets.snapshot();
    const editableItems = saved.items.map(({ id, name, relayId, inputId }) => ({
      id,
      name,
      relayId,
      inputId,
    }));
    const duplicate = await context.request.post(`${url}/api/v1/controllers/sockets`, {
      data: {
        baseRevision: saved.revision,
        enabled: true,
        items: editableItems.map((item) => ({ ...item, relayId: 'rly-0/1' })),
      },
    });
    assert.equal(duplicate.status(), 409);
    assert.equal(
      (
        await context.request.post(`${url}/api/v1/controllers/sockets`, {
          data: {
            baseRevision: saved.revision,
            enabled: true,
            items: editableItems.map((item) => ({ ...item, inputId: 'in-0/1' })),
          },
        })
      ).status(),
      409,
      'Inputs are now exclusive too',
    );
    assert.equal(mock.sockets.snapshot().revision, saved.revision);
    assert.equal(
      (
        await context.request.post(`${url}/api/v1/controllers/sockets/state`, {
          data: { id: first, value: 'true' },
        })
      ).status(),
      400,
    );
    assert.equal(
      (
        await context.request.post(`${url}/api/v1/controllers/sockets`, {
          data: {
            baseRevision: saved.revision,
            enabled: true,
            items: Array.from({ length: 17 }, (_, i) => ({
              id: `too-many-${i}`,
              name: 'Item',
              relayId: `rly-0/${i + 1}`,
              inputId: '',
            })),
          },
        })
      ).status(),
      400,
    );

    await row(first).locator('[data-socket-name]').fill('Несохранённый черновик');
    await page.waitForTimeout(1250);
    assert.equal(
      await row(first).locator('[data-socket-name]').inputValue(),
      'Несохранённый черновик',
      'Polling preserves draft',
    );
    const competing = await context.request.post(`${url}/api/v1/controllers/sockets`, {
      data: {
        baseRevision: saved.revision,
        enabled: true,
        items: editableItems.map((item) =>
          item.id === first ? { ...item, name: 'Другой клиент' } : item,
        ),
      },
    });
    assert.equal(competing.status(), 200);
    const conflict = apiResponse();
    await page.locator('#sockets-save').click();
    assert.equal((await conflict).status(), 409);
    await page.locator('#sockets-conflict').waitFor({ state: 'visible' });
    assert.equal(
      await row(first).locator('[data-socket-name]').inputValue(),
      'Несохранённый черновик',
    );
    await page.locator('#sockets-reload').click();
    await page.waitForFunction(
      (id) =>
        document.querySelector(`[data-socket-id="${id}"] [data-socket-name]`)?.value ===
        'Другой клиент',
      first,
    );
    await row(first).locator('[data-socket-relay]').selectOption('rly-0/4');
    await save();
    await waitState(first, false);
    assert.equal(mock.hardware.snapshot().relays[0].value, false, 'Reassigned old relay is OFF');
    assert.equal(mock.hardware.snapshot().relays[3].value, false, 'New relay starts OFF');
    await command(second, true);
    await row(second).locator('[data-socket-remove]').click();
    await save();
    assert.equal(mock.hardware.snapshot().relays[1].value, false, 'Removed socket output is OFF');

    // A lost input discards its old edge baseline. Reconnecting at a different
    // level must not replay an edge or turn the socket on.
    mock.setHardwareFaults({ inputs: 'Test input unavailable' });
    mock.sockets.tick();
    assert.equal(mock.sockets.snapshot().items.find((item) => item.id === third).inputLevel, null);
    assert.equal(
      mock.sockets.snapshot().items.find((item) => item.id === third).available,
      true,
      'Input fault does not block manual relay control',
    );
    await page.waitForTimeout(1150);
    await command(third, true);
    await command(third, false);
    rawInput(false);
    mock.setHardwareFaults({ inputs: '' });
    mock.sockets.tick();
    mock.sockets.tick(Date.now() + 100);
    assert.equal(mock.sockets.snapshot().items.find((item) => item.id === third).state, false);
    mock.sockets.reboot();
    mock.sockets.tick(Date.now() + 10000);
    assert.equal(
      mock.sockets.snapshot().items.find((item) => item.id === third).state,
      false,
      'A LOW held across startup/recovery never triggers',
    );
    rawInput(true);
    mock.sockets.tick(Date.now() + 200);
    mock.sockets.tick(Date.now() + 250);

    await command(first, true);
    await row(first).locator('[data-socket-name]').fill('Черновик при выключении');
    await page.locator('#sockets-back').click();
    const disable = apiResponse();
    await page.locator('#sockets-tile-enabled').click();
    assert.equal((await disable).status(), 200);
    assert.equal(await page.locator('#controllers-list-view').isVisible(), true);
    assert.equal(
      mock.sockets.snapshot().items.every((item) => item.state === false),
      true,
    );
    assert.notEqual(
      mock.sockets.snapshot().items[0].name,
      'Черновик при выключении',
      'Tile switch submits saved items',
    );
    await page.locator('#sockets-open').click();
    assert.equal(
      await row(first).locator('[data-socket-name]').inputValue(),
      'Черновик при выключении',
    );
    await page.locator('#sockets-reload').click();
    const reenable = apiResponse();
    await page.locator('#sockets-enabled').click();
    assert.equal((await reenable).status(), 200);
    assert.equal(
      mock.sockets.snapshot().items.every((item) => item.state === false),
      true,
      'Re-enabling never resumes old ON states',
    );
    await command(first, true);

    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'sockets-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: path.join(artifacts, 'sockets-mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
      'Socket editor mobile overflow',
    );
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(statePath, 'utf8'))).sort(), [
      'boardId',
      'controllers',
      'version',
    ]);
    assert.equal((await context.request.post(`${url}/api/v1/reboot`, { data: {} })).status(), 200);
    await page.waitForTimeout(1150);
    await login();
    await page.locator('#sockets-open').click();
    await waitState(first, true);
    assert.equal(mock.hardware.snapshot().relays[3].value, true);

    await closeMock();
    const durable = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const storedLegacy = {
      version: 1,
      sockets: { ...durable.controllers.sockets, boardId: legacyBoardId },
    };
    const savedItems = storedLegacy.sockets.items;
    storedLegacy.sockets.boardId = legacyBoardId;
    fs.writeFileSync(statePath, JSON.stringify(storedLegacy), { mode: 0o600 });
    mock = createMock({ interactive: true, statePath });
    assert.equal(mock.sockets.boardId, canonicalBoardId);
    assert.equal(
      JSON.parse(fs.readFileSync(statePath, 'utf8')).sockets.boardId,
      legacyBoardId,
      'Loading legacy state must not add a boot-time write',
    );
    assert.deepEqual(
      mock.sockets.exportSettings().items,
      savedItems,
      'Legacy disk profile migration preserves bindings and ON/OFF states',
    );
    const noProfilePath = path.join(directory, 'pre-profile-state.json');
    const preProfile = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete preProfile.sockets.boardId;
    fs.writeFileSync(noProfilePath, JSON.stringify(preProfile), { mode: 0o600 });
    const preProfileMock = createMock({ statePath: noProfilePath });
    try {
      assert.equal(preProfileMock.sockets.boardId, canonicalBoardId);
      assert.deepEqual(
        preProfileMock.sockets.exportSettings().items,
        savedItems,
        'Original simulator files without boardId remain readable',
      );
      assert.equal(
        'boardId' in JSON.parse(fs.readFileSync(noProfilePath, 'utf8')).sockets,
        false,
        'Reading an original simulator file adds no boot-time write',
      );
    } finally {
      preProfileMock.sockets.close();
    }
    const foreignPath = path.join(directory, 'foreign-state.json');
    preProfile.sockets.boardId = 'unknown-foreign-board';
    const foreignBytes = JSON.stringify(preProfile);
    fs.writeFileSync(foreignPath, foreignBytes, { mode: 0o600 });
    assert.throws(() => createMock({ statePath: foreignPath }), /другой плате/);
    assert.equal(
      fs.readFileSync(foreignPath, 'utf8'),
      foreignBytes,
      'Unknown disk profile is rejected without rewriting saved states',
    );
    await listen();
    await login();
    await page.locator('#sockets-open').click();
    await waitState(first, true);
    assert.equal(
      mock.sockets.snapshot().items.length,
      2,
      'Disk restoration keeps settings and confirmed states',
    );
    const assigned = mock.sockets.simulatedInputs();
    assert.equal(assigned.length, 1);
    assert.equal(assigned[0].level, true, 'Assigned simulator button starts released HIGH');
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 6000;
      assert.equal(
        mock.sockets.simulatedInputs()[0].level,
        true,
        'Assigned input ignores automatic demo animation',
      );
    } finally {
      Date.now = realNow;
    }
    const simulatedButton = page.locator('[data-simulator-input="in-0/2"]');
    await simulatedButton.waitFor();
    await simulatedButton.click();
    await waitState(third, true);
    await page.waitForFunction(
      () =>
        document.querySelector('[data-simulator-input="in-0/2"]')?.getAttribute('aria-pressed') ===
        'true',
    );
    await simulatedButton.click();
    await page.waitForTimeout(1150);
    assert.equal(
      mock.sockets.snapshot().items.find((item) => item.id === third).state,
      true,
      'Simulator release does not toggle',
    );
    await simulatedButton.click();
    await waitState(third, false);
    assert.equal(
      JSON.parse(fs.readFileSync(statePath, 'utf8')).boardId,
      canonicalBoardId,
      'The next ordinary state write persists the canonical ID',
    );
    assert.deepEqual(errors, []);
    console.log(
      'FCPLCn sockets browser checks passed: SVG hero click/keyboard/confirmed pending and failures, tile switch, optional/exclusive buttons, one press/one toggle, bounce lockout/long hold/release, API validation, drafts/CAS, reassign/remove OFF, module OFF, reboot/disk restore, mobile.',
    );
  } finally {
    await context.close();
    await closeMock();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { checkSockets };
