/** @file Verify manual scenes through the built hub UI and its authenticated API. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

/** @brief Wait for a bounded scene run to finish without confusing HTTP acceptance with success. */
async function completedRun(context, base, id) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const response = await context.request.get(base + '/api/v1/overview');
    assert.equal(response.status(), 200);
    const overview = await response.json();
    const run = overview.scenes.runs.find((entry) => entry.id === id);
    if (run && run.status !== 'running') return { overview, run };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('Scene run did not finish within its bounded command deadlines');
}

/** @brief Scope transient results separately from the deliberately duplicated journal entries. */
async function currentResult(page, id, status) {
  const current = page.locator('[data-scene-current]');
  await current.locator(`[data-scene-run-id="${id}"][data-run-status="${status}"]`).waitFor();
  assert.equal(await current.count(), 1, 'Only one current scene result can be shown');
  const details = current.locator('details.scene-result-details');
  if (await details.count())
    assert.equal(
      await details.evaluate((node) => node.open),
      false,
      'Per-device results start collapsed',
    );
  return current;
}

/** @brief Exercise all three scene tiles and their versioned additional-action editors. */
async function checkScenes({ page, context, base, engine, artifacts }) {
  const overview = () => context.request.get(base + '/api/v1/overview').then((r) => r.json());
  const data = (snapshot, device, kind) =>
    snapshot.devices.find((entry) => entry.id === device).controllers[kind].data;
  async function configure(id, actions) {
    await page.locator(`[data-scene-settings="${id}"]`).click();
    const editor = page.locator(`[data-scene-editor="${id}"]`);
    await editor.waitFor();
    while (await editor.locator('[data-scene-action-id]').count())
      await editor.locator('[data-scene-action-id]').last().locator('[data-scene-remove]').click();
    for (const action of actions) {
      await editor.locator('[data-scene-add]').click();
      const row = editor.locator('[data-scene-action-id]').last();
      for (const field of ['deviceId', 'controller', 'itemId', 'value'])
        await row.locator(`[data-scene-field="${field}"]`).selectOption(String(action[field]));
    }
    const response = page.waitForResponse(
      (r) => r.url().endsWith(`/scenes/${id}`) && r.request().method() === 'PUT',
    );
    await editor.locator('[data-scene-save]').click();
    const saved = await response;
    assert.equal(saved.status(), 200, await saved.text());
    await editor.waitFor({ state: 'hidden' });
    const definition = (await overview()).scenes.definitions.find((entry) => entry.id === id);
    assert.equal(definition.actions.length, actions.length);
    for (let i = 0; i < actions.length; i++) {
      for (const key of ['deviceId', 'controller', 'itemId', 'value'])
        assert.equal(definition.actions[i][key], actions[i][key]);
    }
  }
  async function run(id, status = 'completed') {
    if (!(await page.locator(`[data-scene-run="${id}"]`).count()))
      await page
        .locator(`[data-nav="${['home', 'away', 'prepare'].includes(id) ? 'overview' : 'scenes'}"]`)
        .click();
    const response = page.waitForResponse(
      (r) => r.url().endsWith(`/scenes/${id}/run`) && r.request().method() === 'POST',
    );
    await page.locator(`[data-scene-run="${id}"]`).click();
    const started = await response;
    assert.ok([200, 202].includes(started.status()), await started.text());
    const body = await started.json();
    const result = await completedRun(context, base, (body.run || body).id);
    assert.equal(result.run.status, status);
    if (status === 'completed')
      assert.ok(result.run.results.every((entry) => ['applied', 'skipped'].includes(entry.status)));
    await currentResult(page, result.run.id, result.run.status);
    return result;
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-nav="overview"]').click();
  assert.equal(
    await page.locator('.scene-cards .scene-card').count(),
    3,
    'Overview has exactly three quick scenes',
  );
  for (const id of ['home', 'away', 'prepare']) {
    assert.equal(await page.locator(`[data-scene-run="${id}"]`).count(), 1);
    assert.equal(await page.locator(`[data-scene-settings="${id}"]`).count(), 1);
    assert.ok((await page.locator(`[data-scene-id="${id}"] svg`).count()) >= 1);
  }
  const living = 'fcplcn-demo-living';
  await configure('home', [
    { deviceId: living, controller: 'sockets', itemId: 'socket-window', value: false },
  ]);
  await page.locator('[data-device-id="fcplcn-demo-living"]').click();
  assert.equal(
    await page.locator('.scene-cards .scene-card').count(),
    0,
    'Quick scenes are only on the hub overview',
  );
  const manualResponse = page.waitForResponse(
    (response) => response.url().endsWith('/commands') && response.request().method() === 'POST',
  );
  await page.locator('[data-item-id="light-main"] button').click();
  assert.equal((await (await manualResponse).json()).status, 'applied');
  await page.locator('.notice.success .notice-dismiss').waitFor();
  const home = await run('home');
  assert.equal(
    await page.locator('.notice.success .notice-dismiss').count(),
    0,
    'Starting a scene clears the previous manual command notification',
  );
  await page.locator('[data-nav="overview"]').click();
  const guards = home.overview.devices.filter((entry) => entry.controllers.security);
  assert.ok(guards.length > 0);
  assert.ok(guards.every((entry) => entry.controllers.security.data.armed === false));
  assert.equal(
    data(home.overview, living, 'sockets').items.find((entry) => entry.id === 'socket-window')
      .state,
    false,
  );

  await configure('away', [
    { deviceId: living, controller: 'sockets', itemId: 'socket-window', value: true },
  ]);
  const away = await run('away');
  assert.ok(
    away.overview.devices
      .filter((entry) => entry.controllers.security)
      .every((entry) => entry.controllers.security.data.armed === true),
  );
  assert.equal(
    data(away.overview, living, 'sockets').items.find((entry) => entry.id === 'socket-window')
      .state,
    true,
  );

  const prepareActions = [
    { deviceId: living, controller: 'lights', itemId: 'light-main', value: true },
    { deviceId: living, controller: 'sockets', itemId: 'socket-window', value: true },
    { deviceId: living, controller: 'thermostats', itemId: 'thermo-floor', value: true },
  ];
  await configure('prepare', prepareActions);
  for (const action of prepareActions) {
    const response = await context.request.post(`${base}/api/v1/devices/${living}/commands`, {
      data: { controller: action.controller, itemId: action.itemId, value: false },
    });
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).status, 'applied');
  }
  const prepared = await run('prepare');
  for (const action of prepareActions) {
    const item = data(prepared.overview, living, action.controller).items.find(
      (entry) => entry.id === action.itemId,
    );
    assert.equal(action.controller === 'thermostats' ? item.enabled : item.state, true);
  }
  assert.equal(
    data(prepared.overview, living, 'lights').items.find((entry) => entry.id === 'light-evening')
      .state,
    false,
    'A scene does not change unconfigured light outputs',
  );
  assert.ok(
    prepared.overview.devices
      .filter((entry) => entry.controllers.security)
      .every((entry) => entry.controllers.security.data.armed === true),
    'Preparing does not implicitly disarm security',
  );
  for (const [width, height, name] of [
    [1440, 1000, 'desktop'],
    [390, 900, 'mobile'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({
      path: path.join(artifacts, `hub-scenes-${name}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-nav="scenes"]').click();
  assert.match(await page.locator('[data-scenes-group="instant"]').textContent(), /Мгновенные/);
  assert.match(
    await page.locator('[data-scenes-group="scheduled"]').textContent(),
    /По расписанию/,
  );
  await page.locator('[data-scene-create]').click();
  let customEditor = page.locator('[data-scene-editor="new"]');
  await customEditor.locator('[data-scene-name]').fill('Вечер · проверка расписания');
  await customEditor
    .locator('[data-scene-description]')
    .fill('Свой сценарий с явным часовым поясом');
  await customEditor.locator('[data-scene-add]').click();
  let customAction = customEditor.locator('[data-scene-action-id]').last();
  for (const [field, value] of Object.entries({
    deviceId: living,
    controller: 'lights',
    itemId: 'light-evening',
    value: 'true',
  }))
    await customAction.locator(`[data-scene-field="${field}"]`).selectOption(value);
  const createdResponse = page.waitForResponse(
    (response) => response.url().endsWith('/scenes') && response.request().method() === 'POST',
  );
  await customEditor.locator('[data-scene-save]').click();
  const created = await createdResponse;
  assert.ok([200, 201].includes(created.status()), await created.text());
  const custom = await created.json();
  await customEditor.waitFor({ state: 'hidden' });
  const customCard = () => page.locator(`[data-scene-definition-id="${custom.id}"]`);
  await customCard().waitFor();
  assert.equal(
    (await overview()).scenes.definitions.find((entry) => entry.id === custom.id).schedule?.enabled,
    false,
  );
  for (const [width, height, name] of [
    [1440, 1000, 'desktop'],
    [390, 900, 'mobile'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({
      path: path.join(artifacts, `hub-scenes-instant-${name}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(`[data-scene-settings="${custom.id}"]`).click();
  customEditor = page.locator(`[data-scene-editor="${custom.id}"]`);
  await customEditor.locator('[data-scene-mode="scheduled"]').check();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const nextWeekday = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Novosibirsk',
    weekday: 'short',
  }).format(tomorrow);
  const nextDay = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(nextWeekday) + 1;
  for (let day = 1; day <= 7; day++)
    await customEditor.locator(`[data-scene-day="${day}"]`).setChecked(day === nextDay);
  await customEditor.locator('[data-scene-schedule-time]').fill('12:34');
  await customEditor.locator('[data-scene-schedule-timezone]').fill('Asia/Novosibirsk');
  await customEditor.locator('[data-scene-schedule-timezone]').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(artifacts, 'hub-scene-schedule-editor-desktop.png'),
    fullPage: false,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await customEditor.locator('[data-scene-schedule-timezone]').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(artifacts, 'hub-scene-schedule-editor-mobile.png'),
    fullPage: false,
    animations: 'disabled',
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const scheduledResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/scenes/${custom.id}`) && response.request().method() === 'PUT',
  );
  await customEditor.locator('[data-scene-save]').click();
  const scheduled = await scheduledResponse;
  assert.equal(scheduled.status(), 200, await scheduled.text());
  await customEditor.waitFor({ state: 'hidden' });
  assert.deepEqual(
    (await overview()).scenes.definitions.find((entry) => entry.id === custom.id).schedule,
    { enabled: true, days: [nextDay], time: '12:34', timeZone: 'Asia/Novosibirsk' },
  );
  await page.locator('[data-scenes-group="scheduled"]').click();
  await customCard().waitFor();
  assert.match(await customCard().textContent(), /12:34/);
  for (const [width, height, name] of [
    [1440, 1000, 'desktop'],
    [390, 900, 'mobile'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({
      path: path.join(artifacts, `hub-scenes-scheduled-${name}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  const customRun = await run(custom.id);
  assert.equal(
    customRun.run.trigger,
    'manual',
    'A scheduled scene still supports explicit manual launch',
  );
  assert.equal(
    data(customRun.overview, living, 'lights').items.find((entry) => entry.id === 'light-evening')
      .state,
    true,
  );
  assert.equal(customRun.overview.scenes.scheduler.running, true);
  assert.equal(
    customRun.overview.scenes.scheduler.events.filter(
      (entry) => entry.sceneId === custom.id && entry.status === 'started',
    ).length,
    0,
    'Future-day schedule is stored without firing during UI tests',
  );
  const failedDefinition = await context.request.post(base + '/api/v1/scenes', {
    data: {
      name: 'Проверка недоступного PLC',
      description: '',
      actions: [
        {
          id: 'notice-target-failure',
          deviceId: living,
          controller: 'lights',
          itemId: 'light-evening',
          value: true,
        },
      ],
    },
  });
  assert.equal(failedDefinition.status(), 201, await failedDefinition.text());
  const failureScene = await failedDefinition.json();
  await page.locator('[data-scenes-group="instant"]').click();
  await page.locator(`[data-scene-run="${failureScene.id}"]`).waitFor();
  const originalCommand = engine.command;
  engine.command = async (...args) => {
    if (args[0] === living && args[1] === 'lights' && args[2] === 'light-evening')
      throw new Error('PLC недоступен: проверка уведомления');
    return originalCommand(...args);
  };
  let failedNotice;
  try {
    failedNotice = await run(failureScene.id, 'failed');
  } finally {
    engine.command = originalCommand;
  }
  await page.waitForTimeout(4500);
  await page.locator(`[data-scene-current] [data-scene-run-id="${failedNotice.run.id}"]`).waitFor();
  const replacement = await run('prepare');
  assert.equal(
    await page.locator(`[data-scene-current] [data-scene-run-id="${failedNotice.run.id}"]`).count(),
    0,
    'A successful new run replaces the persistent failure',
  );
  const replacementCurrent = page.locator('[data-scene-current]');
  await replacementCurrent.locator('details.scene-result-details > summary').click();
  await page.waitForTimeout(4300);
  assert.equal(
    await replacementCurrent.count(),
    1,
    'A success remains readable while its details are open',
  );
  await replacementCurrent.locator('details.scene-result-details > summary').click();
  let polls = 0;
  const countPoll = (response) => {
    if (response.url().endsWith('/api/v1/overview') && response.request().method() === 'GET')
      polls++;
  };
  page.on('response', countPoll);
  try {
    await replacementCurrent.waitFor({ state: 'detached', timeout: 6500 });
    assert.ok(polls >= 1, 'Actual overview polling continues while the four-second notice expires');
  } finally {
    page.off('response', countPoll);
  }
  await page.locator('[data-nav="overview"]').click();
  assert.equal(await page.locator('[data-scene-current]').count(), 0);
  assert.equal(
    await page.locator('[data-scene-history]').count(),
    0,
    'Overview does not accumulate scene history panels',
  );
  await page.locator('[data-nav="scenes"]').click();
  const history = page.locator('[data-scene-history]');
  await history.waitFor();
  assert.equal(await history.evaluate((node) => node.open), false);
  await history.locator(':scope > summary').click();
  const historical = history
    .locator('details.scene-history-run')
    .filter({ has: page.locator(`[data-scene-run-id="${replacement.run.id}"]`) });
  await historical.locator(':scope > summary').click();
  assert.ok(
    (await historical.locator('[data-scene-result-id]').count()) >= 3,
    'Detailed confirmations remain in the collapsed journal',
  );
  assert.equal(await historical.locator('[data-scene-result-id]').first().isVisible(), true);
  await page.reload();
  await page.locator('[data-scene-run="home"]').waitFor();
  await page.waitForTimeout(2200);
  assert.equal(
    await page.locator('[data-scene-current]').count(),
    0,
    'Reloading existing history does not create another notification',
  );
  await page.locator('[data-nav="overview"]').click();
  await page.setViewportSize({ width: 360, height: 800 });
  assert.equal(engine.snapshot().broker.connected, true);
  console.log(
    'FCPLCn scene browser checks passed: SVG quick scenes, configurable/manual/scheduled actions, single compact result, success expiry despite polling, readable open details, persistent/replaced errors and history without notification replay.',
  );
}

/** @brief An unavailable broker must produce explicit failures and never queued scene commands. */
async function checkOfflineScene({ page, context, base, engine, artifacts }) {
  const before = engine.snapshot().commands.length;
  await page.locator('[data-nav="overview"]').click();
  const awaiting = page.waitForResponse(
    (r) => r.url().endsWith('/scenes/away/run') && r.request().method() === 'POST',
  );
  await page.locator('[data-scene-run="away"]').click();
  const response = await awaiting;
  assert.ok([200, 202].includes(response.status()), await response.text());
  const body = await response.json();
  const { run } = await completedRun(context, base, (body.run || body).id);
  assert.ok(['failed', 'partial'].includes(run.status));
  assert.ok(
    run.results.some((entry) => ['unavailable', 'rejected', 'unknown'].includes(entry.status)),
  );
  assert.ok(run.results.every((entry) => entry.status !== 'applied'));
  assert.equal(
    engine.snapshot().commands.length,
    before,
    'No offline commands are added to an outbox',
  );
  const current = await currentResult(page, run.id, run.status);
  await page.screenshot({
    path: path.join(artifacts, 'hub-scenes-offline-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await current.locator('[data-scene-dismiss]').click();
  await page.waitForTimeout(2200);
  assert.equal(
    await page.locator('[data-scene-current]').count(),
    0,
    'Dismissed errors remain dismissed while polling',
  );
  await page.locator('[data-nav="scenes"]').click();
  assert.equal(
    await page.locator('[data-scene-current]').count(),
    0,
    'Navigation does not resurrect the dismissed failure',
  );
  await page.reload();
  await page.locator('[data-scene-run="away"]').waitFor();
  assert.equal(
    await page.locator('[data-scene-current]').count(),
    0,
    'Historical failures do not reappear on page load',
  );
  console.log(
    'FCPLCn offline scene check passed: unavailable targets are reported, with no command outbox or false success.',
  );
}

module.exports = { checkScenes, checkOfflineScene };
