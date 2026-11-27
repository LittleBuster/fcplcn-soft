/**
 * @file controllers_checks.cjs
 * @brief Exercise controller drafts, exclusive port ownership, conflicts, and confirmed state.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { legacyBoardId } = require('./board_profiles_mock.cjs');

async function checkControllers({ browser, createMock, artifacts }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcplcn-controllers-ui-'));
  const mock = createMock({ interactive: true, statePath: path.join(directory, 'state.json') });
  mock.setHardwareInputs(Array(16).fill(true));
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('dialog', (dialog) => dialog.accept());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${mock.server.address().port}`;
  const singular = (module) => (module === 'sockets' ? 'socket' : 'light');
  const card = (module, id) =>
    page.locator(`#${module}-items [data-${singular(module)}-id="${id}"]`);
  const field = (module, id, name) =>
    card(module, id).locator(`[data-${singular(module)}-field="${name}"]`);
  const waitPost = (module, state = false) =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/controllers/${module}${state ? '/state' : ''}`) &&
        response.request().method() === 'POST',
    );
  async function open(module) {
    for (const id of ['sockets', 'lights'])
      if (await page.locator(`#${id}-view`).isVisible()) await page.locator(`#${id}-back`).click();
    await page.locator(`#${module}-open`).click();
    await page.locator(`#${module}-view`).waitFor({ state: 'visible' });
  }
  async function add(module, name, relayId, inputId = '') {
    await page.locator(`#${module}-add`).click();
    const node = page.locator(`#${module}-items [data-${singular(module)}-id]`).last();
    const id = await node.getAttribute(`data-${singular(module)}-id`);
    await field(module, id, 'name').fill(name);
    await field(module, id, 'relayId').selectOption(relayId);
    if (inputId) await field(module, id, 'inputId').selectOption(inputId);
    return id;
  }
  async function save(module, status = 200) {
    const response = waitPost(module);
    await page.locator(`#${module}-save`).click();
    assert.equal((await response).status(), status);
  }
  async function state(module, id, value) {
    const response = waitPost(module, true);
    await card(module, id)
      .locator(`[data-${singular(module)}-toggle]`)
      .click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(
      ({ module, selector, id, value }) =>
        document
          .querySelector(`#${module}-items [data-${selector}-toggle="${id}"]`)
          ?.getAttribute('aria-pressed') === String(value),
      { module, selector: singular(module), id, value },
    );
  }
  async function blocked(module, id, name, port, expected, owner = '') {
    const option = field(module, id, name).locator(`option[value="${port}"]`);
    await page.waitForFunction(
      ({ module, selector, id, name, port, expected }) =>
        document.querySelector(
          `#${module}-items [data-${selector}-id="${id}"] [data-${selector}-field="${name}"] option[value="${port}"]`,
        )?.disabled === expected,
      { module, selector: singular(module), id, name, port, expected },
    );
    assert.equal(
      await option.evaluate((node) => node.hidden),
      false,
      'Occupied options remain visible',
    );
    if (owner) assert.match(await option.textContent(), new RegExp(owner));
  }
  try {
    await page.goto(url);
    await page.locator('#login-form button').click();
    await page.locator('#app-view').waitFor({ state: 'visible' });
    await page.locator('#tab-controllers').click();
    await page.locator('#lights-tile-enabled').waitFor();
    assert.equal(await page.locator('[data-controller-id]').count(), 7);
    const initial = await (await context.request.get(`${url}/api/v1/controllers`)).json();
    assert.equal(initial.resources.length, 40);
    assert.equal(
      initial.resources.every(
        (resource) => resource.ownerController === null && !resource.conflict,
      ),
      true,
    );
    const enableLight = waitPost('lights');
    await page.locator('#lights-tile-enabled').click();
    assert.equal((await enableLight).status(), 200);
    assert.equal(
      await page.locator('#controllers-list-view').isVisible(),
      true,
      'Light module switch does not navigate',
    );
    await open('lights');
    const light = await add('lights', 'Основной свет', 'rly-0/5', 'in-0/5');
    await save('lights');
    const lightVisual = card('lights', light).locator('[data-light-toggle]');
    assert.equal(
      await card('lights', light).evaluate((node) =>
        node.firstElementChild.matches('[data-light-toggle]'),
      ),
      true,
      'Light SVG control precedes all settings',
    );
    assert.equal(await lightVisual.locator('use').getAttribute('href'), '#visual-light');
    assert.equal(await lightVisual.getAttribute('data-tone'), 'light');
    const lightRevision = mock.lights.snapshot().revision;
    const lightOn = waitPost('lights', true);
    await lightVisual.locator('svg').click();
    assert.equal((await lightOn).status(), 200);
    await page.waitForFunction(
      (id) =>
        document.querySelector(`[data-light-toggle="${id}"]`)?.getAttribute('aria-pressed') ===
        'true',
      light,
    );
    assert.equal(await lightVisual.getAttribute('data-state'), 'on');
    assert.equal(mock.lights.snapshot().revision, lightRevision);
    const now = Date.now() + 1000,
      levels = Array(16).fill(true);
    levels[4] = false;
    mock.setHardwareInputs(levels);
    mock.controllers.tick(now);
    assert.equal(mock.lights.snapshot().items[0].state, true, 'One LOW sample is rejected');
    mock.controllers.tick(now + 20);
    assert.equal(mock.lights.snapshot().items[0].state, true, 'Two LOW samples are not enough');
    mock.controllers.tick(now + 40);
    assert.equal(
      mock.lights.snapshot().items[0].state,
      false,
      'Three LOW samples confirm one press',
    );
    mock.controllers.tick(now + 10000);
    assert.equal(mock.lights.snapshot().items[0].state, false, 'Held LOW never repeats');
    levels[4] = true;
    mock.setHardwareInputs(levels);
    mock.controllers.tick(now + 10001);
    mock.controllers.tick(now + 10051);
    assert.equal(
      mock.lights.snapshot().items[0].state,
      false,
      'Light button release does not toggle',
    );
    levels[4] = false;
    mock.setHardwareInputs(levels);
    mock.controllers.tick(now + 10052);
    mock.controllers.tick(now + 10072);
    mock.controllers.tick(now + 10092);
    assert.equal(mock.lights.snapshot().items[0].state, true);
    mock.setHardwareInputs(Array(16).fill(true));
    mock.controllers.reboot();
    await blocked('lights', light, 'relayId', 'rly-0/5', false);
    await blocked('lights', light, 'inputId', 'in-0/5', false);

    await open('sockets');
    const socket = await add('sockets', 'Розетка A', 'rly-0/1', 'in-0/1');
    assert.equal(
      await field('sockets', socket, 'relayId').locator('option[value^="rly-"]').count(),
      16,
    );
    assert.equal(await field('sockets', socket, 'inputId').locator('option').count(), 17);
    await blocked('sockets', socket, 'relayId', 'rly-0/5', true, 'Основной свет');
    await blocked('sockets', socket, 'inputId', 'in-0/5', true, 'Основной свет');
    await save('sockets'); // Disabled sockets still reserve both ports.
    await open('lights');
    const temporary = await add('lights', 'Второй свет', 'rly-0/6', 'in-0/6');
    await blocked('lights', temporary, 'relayId', 'rly-0/1', true, 'Розетка A');
    await blocked('lights', temporary, 'inputId', 'in-0/1', true, 'Розетка A');
    await blocked('lights', temporary, 'inputId', 'in-0/5', true, 'Основной свет');
    // A saved external claim can overtake an unsaved selection. Keep that
    // selection/draft visible, but gray it and allow choosing another port.
    const socketBeforeExternal = mock.sockets.snapshot();
    const savedSocketItems = socketBeforeExternal.items.map(({ id, name, relayId, inputId }) => ({
      id,
      name,
      relayId,
      inputId,
    }));
    const externalClaim = await context.request.post(`${url}/api/v1/controllers/sockets`, {
      data: {
        baseRevision: socketBeforeExternal.revision,
        enabled: socketBeforeExternal.enabled,
        items: [
          ...savedSocketItems,
          { id: 'external-owner', name: 'Другой редактор', relayId: 'rly-0/6', inputId: 'in-0/6' },
        ],
      },
    });
    assert.equal(externalClaim.status(), 200);
    await blocked('lights', temporary, 'relayId', 'rly-0/6', true, 'Другой редактор');
    await blocked('lights', temporary, 'inputId', 'in-0/6', true, 'Другой редактор');
    assert.equal(await field('lights', temporary, 'relayId').inputValue(), 'rly-0/6');
    assert.equal(await field('lights', temporary, 'inputId').inputValue(), 'in-0/6');
    assert.equal(await field('lights', temporary, 'name').inputValue(), 'Второй свет');
    assert.equal(await field('lights', temporary, 'relayId').isEnabled(), true);
    assert.equal(await field('lights', temporary, 'inputId').isEnabled(), true);
    const beforeRejectedDraft = mock.lights.exportSettings();
    await page.locator('#lights-save').click();
    await page
      .locator('#lights-notice')
      .getByText(/Порт.*(?:занят|назначен)/)
      .waitFor();
    assert.deepEqual(
      mock.lights.exportSettings(),
      beforeRejectedDraft,
      'A stale draft never steals the newly saved owner',
    );
    await blocked('lights', light, 'relayId', 'rly-0/5', false);
    await field('lights', temporary, 'relayId').selectOption('rly-0/4');
    await field('lights', temporary, 'inputId').selectOption('in-0/4');
    assert.equal(
      (
        await context.request.post(`${url}/api/v1/controllers/sockets`, {
          data: {
            baseRevision: mock.sockets.snapshot().revision,
            enabled: socketBeforeExternal.enabled,
            items: savedSocketItems,
          },
        })
      ).status(),
      200,
    );
    await blocked('lights', temporary, 'relayId', 'rly-0/6', false);
    await open('sockets');
    const draft = await add('sockets', 'Черновик B', 'rly-0/2', 'in-0/2');
    await field('sockets', socket, 'relayId').selectOption('rly-0/3');
    await field('sockets', socket, 'inputId').selectOption('in-0/3');
    await open('lights');
    for (const [port, owner] of [
      ['rly-0/1', 'Розетка A'],
      ['rly-0/2', 'Черновик B'],
      ['rly-0/3', 'Розетка A'],
    ])
      await blocked('lights', temporary, 'relayId', port, true, owner);
    await blocked('lights', temporary, 'inputId', 'in-0/2', true, 'Черновик B');
    await open('sockets');
    await save('sockets');
    await open('lights');
    await blocked('lights', temporary, 'relayId', 'rly-0/1', false);
    await blocked('lights', temporary, 'inputId', 'in-0/1', false);
    await field('lights', temporary, 'relayId').selectOption('rly-0/1');
    await field('lights', temporary, 'inputId').selectOption('in-0/1');
    await save('lights');
    await card('lights', temporary).locator('[data-light-remove]').click();
    await open('sockets');
    await blocked('sockets', draft, 'relayId', 'rly-0/1', true, 'Второй свет');
    await open('lights');
    mock.setLightsFaults({ save: 'Test light save failure' });
    await save('lights', 503);
    mock.setLightsFaults({ save: '' });
    assert.equal(
      mock.controllers.resources().find((resource) => resource.id === 'rly-0/1').ownerController,
      'lights',
    );
    await save('lights');
    await open('sockets');
    await blocked('sockets', draft, 'relayId', 'rly-0/1', false);
    await open('lights');
    await field('lights', light, 'relayId').selectOption('rly-0/7');
    await field('lights', light, 'inputId').selectOption('in-0/7');
    await save('lights');
    assert.equal(mock.hardware.snapshot().relays[4].value, false);
    assert.equal(mock.hardware.snapshot().relays[6].value, false, 'Retarget starts OFF');
    await state('lights', light, true);
    await page.locator('#lights-back').click();
    const disable = waitPost('lights');
    await page.locator('#lights-tile-enabled').click();
    assert.equal((await disable).status(), 200);
    assert.equal(mock.lights.snapshot().items[0].state, false);
    await open('sockets');
    await blocked('sockets', draft, 'relayId', 'rly-0/7', true, 'Основной свет');
    await blocked('sockets', draft, 'inputId', 'in-0/7', true, 'Основной свет');
    await open('lights');
    const reenable = waitPost('lights');
    await page.locator('#lights-enabled').click();
    assert.equal((await reenable).status(), 200);
    assert.equal(mock.lights.snapshot().items[0].state, false);
    await state('lights', light, true);
    await page.waitForTimeout(300); // Capture the confirmed switch after its CSS transition.
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'lights-desktop.png'), fullPage: true });
    await page.locator('#lights-back').click();
    await page.screenshot({
      path: path.join(artifacts, 'controllers-desktop.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: path.join(artifacts, 'controllers-mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'Controller tiles mobile overflow',
    );
    await page.locator('#lights-open').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(artifacts, 'lights-mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'Lights mobile overflow',
    );

    const beforeRace = mock.controllers.snapshot();
    const editable = (items) =>
      items.map(({ id, name, relayId, inputId }) => ({ id, name, relayId, inputId }));
    const results = await Promise.all(
      ['sockets', 'lights'].map((id) =>
        context.request.post(`${url}/api/v1/controllers/${id}`, {
          data: {
            baseRevision: beforeRace[id].revision,
            enabled: beforeRace[id].enabled,
            items: [
              ...editable(beforeRace[id].items),
              { id: `race-${id}`, name: `Race ${id}`, relayId: 'rly-0/8', inputId: 'in-0/8' },
            ],
          },
        }),
      ),
    );
    assert.deepEqual(results.map((response) => response.status()).sort(), [200, 409]);
    const afterRace = await (await context.request.get(`${url}/api/v1/controllers`)).json();
    assert.equal(
      afterRace.resources.some((resource) => resource.conflict),
      false,
      'Concurrent claims are serialized',
    );
    assert.equal(
      afterRace.resources.find((resource) => resource.id === 'sens-0/1').ownerController,
      null,
    );
    await context.request.post(`${url}/api/v1/reboot`, { data: {} });
    await page.waitForTimeout(1150);
    assert.equal(mock.lights.snapshot().items.find((item) => item.id === light).state, true);
    assert.equal(mock.hardware.snapshot().relays[6].value, true, 'Light ON restores across reboot');

    const legacyPath = path.join(directory, 'legacy-shared.json');
    const legacyData = {
      version: 1,
      sockets: {
        boardId: legacyBoardId,
        revision: 3,
        enabled: true,
        items: [
          { id: 'old-a', name: 'Legacy A', relayId: 'rly-0/10', inputId: 'in-0/10', state: true },
          { id: 'old-b', name: 'Legacy B', relayId: 'rly-0/11', inputId: 'in-0/10', state: false },
        ],
      },
    };
    fs.writeFileSync(legacyPath, JSON.stringify(legacyData));
    const legacy = createMock({ statePath: legacyPath });
    try {
      assert.deepEqual(legacy.sockets.exportSettings().items, legacyData.sockets.items);
      assert.deepEqual(legacy.lights.exportSettings(), { enabled: false, items: [] });
      assert.equal(
        legacy.controllers.resources().find((resource) => resource.id === 'in-0/10').conflict,
        true,
      );
      assert.ok(legacy.sockets.snapshot().error);
      legacy.setHardwareInputs(Array(16).fill(false));
      legacy.controllers.tick(Date.now() + 10000);
      assert.deepEqual(
        legacy.sockets.exportSettings().items.map((item) => item.state),
        [true, false],
        'Legacy duplicate button is paused',
      );
      assert.equal(
        (await legacy.lights.save({ baseRevision: 1, enabled: true, items: [] })).status,
        409,
      );
      await new Promise((resolve) => legacy.server.listen(0, '127.0.0.1', resolve));
      await page.goto(`http://127.0.0.1:${legacy.server.address().port}`);
      await page.locator('#login-form button').click();
      await page.locator('#app-view').waitFor({ state: 'visible' });
      await page.locator('#tab-controllers').click();
      await open('sockets');
      await page.locator('#sockets-resource-warning').waitFor({ state: 'visible' });
      await blocked('sockets', 'old-a', 'inputId', 'in-0/10', true, 'Legacy B');
      await blocked('sockets', 'old-b', 'inputId', 'in-0/10', true, 'Legacy A');
      assert.equal(await field('sockets', 'old-a', 'inputId').inputValue(), 'in-0/10');
      assert.equal(await field('sockets', 'old-b', 'inputId').inputValue(), 'in-0/10');
      assert.equal(
        await field('sockets', 'old-b', 'inputId').isEnabled(),
        true,
        'Conflicting legacy selection can be repaired',
      );
      await field('sockets', 'old-b', 'inputId').selectOption('in-0/11');
      await save('sockets');
      assert.equal(
        legacy.controllers.resources().some((resource) => resource.conflict),
        false,
      );
      assert.equal(legacy.sockets.snapshot().items[0].state, true);
      await blocked('sockets', 'old-a', 'inputId', 'in-0/10', false);
    } finally {
      legacy.server.closeAllConnections();
      await new Promise((resolve) => legacy.server.close(resolve));
      legacy.controllers.close();
    }
    assert.deepEqual(errors, []);
    console.log(
      'FCPLCn controllers browser checks passed: Light controls/buttons/restore, 40 exclusive resources, visible owner options, saved/draft/disabled claims, release after commit, failed saves, editor race409, legacy shared-input preservation.',
    );
  } finally {
    await context.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { checkControllers };
