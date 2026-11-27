/** @file Tablet scene tiles against an isolated demo hub and its real scene journal. */
'use strict';
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');

async function checkPultScenes({ page, context, base }) {
  const endpoint = base + '/api/v1/scenes';
  const action = {
    id: 'evening-light',
    deviceId: 'fcplcn-demo-living',
    controller: 'lights',
    itemId: 'light-evening',
    value: true,
  };
  const schedule = { enabled: true, days: [2, 4], time: '19:25', timeZone: 'UTC' };
  async function create(name, schedule) {
    const response = await context.request.post(endpoint, {
      data: { name, description: '', actions: [action], schedule },
    });
    assert.equal(response.status(), 201, await response.text());
    return response.json();
  }
  async function snapshot() {
    const response = await context.request.get(endpoint);
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  }

  // Older versions of the scene editor stored a disabled schedule object for instant scenes.
  const manual = await create('Вечерний свет вручную', { ...schedule, enabled: false });
  const timed = await create('Вечерний свет по времени', schedule);
  const initial = await snapshot();
  const instantCount = initial.definitions.filter((scene) => !scene.schedule?.enabled).length;
  const scheduledCount = initial.definitions.length - instantCount;
  const instantFilter = page.locator('[data-pult-scene-filter="instant"]');
  const scheduledFilter = page.locator('[data-pult-scene-filter="scheduled"]');
  const instantGroup = page.locator('[data-pult-scene-group="instant"]');
  const scheduledGroup = page.locator('[data-pult-scene-group="scheduled"]');
  const manualSelector = `[data-pult-scene="${manual.id}"]`;
  const timedSelector = `[data-pult-scene="${timed.id}"]`;
  const run = instantGroup.locator(manualSelector);
  const toggle = scheduledGroup.locator(timedSelector);
  const timedEndpoint = endpoint + '/' + timed.id + '/schedule';

  await page.goto(base + '/#pult');
  await page.locator('[data-pult-tab="scenes"]').tap();
  await expect(page).toHaveURL(base + '/#pult/scenes');
  await expect(instantFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(scheduledFilter).toHaveAttribute('aria-pressed', 'false');
  await expect(instantFilter).toHaveText(new RegExp(`Мгновенные\\s*${instantCount}$`));
  await expect(scheduledFilter).toHaveText(new RegExp(`По расписанию\\s*${scheduledCount}$`));
  await expect(run).toBeVisible();
  await expect(scheduledGroup).toBeHidden();
  await expect(instantGroup.locator(timedSelector)).toHaveCount(0);
  await expect(run).not.toHaveAttribute('aria-pressed', /.+/);
  const topNav = await page.getByRole('navigation', { name: 'Разделы пульта' }).boundingBox();
  const instantBox = await instantFilter.boundingBox();
  const scheduledBox = await scheduledFilter.boundingBox();
  const firstTile = await instantGroup.locator('[data-pult-scene]').first().boundingBox();
  assert.ok(
    Math.min(instantBox.y, scheduledBox.y) >= topNav.y + topNav.height &&
      firstTile.y >=
        Math.max(instantBox.y + instantBox.height, scheduledBox.y + scheduledBox.height),
    'Scene filters sit below the room navigation and above the tiles',
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Scene tiles and the room tabs fit the mobile viewport',
  );

  const [started] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === endpoint + '/' + manual.id + '/run' &&
        response.request().method() === 'POST',
    ),
    run.tap(),
  ]);
  assert.equal(started.status(), 202, await started.text());
  const accepted = await started.json();
  assert.equal(accepted.trigger, 'manual');
  await expect
    .poll(async () => (await snapshot()).runs.find((entry) => entry.id === accepted.id)?.status)
    .toBe('completed');

  await scheduledFilter.tap();
  await expect(page).toHaveURL(base + '/#pult/scenes/scheduled');
  await expect(scheduledFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(instantFilter).toHaveAttribute('aria-pressed', 'false');
  await expect(instantGroup).toBeHidden();
  await expect(scheduledGroup.locator(manualSelector)).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const fill = () =>
    toggle.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.backgroundImage];
    });
  const activeFill = await fill();
  async function pressSchedule(status = 200) {
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) => response.url() === timedEndpoint && response.request().method() === 'PUT',
      ),
      toggle.tap(),
    ]);
    assert.equal(response.status(), status, await response.text());
  }

  await pressSchedule();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const paused = (await snapshot()).definitions.find((entry) => entry.id === timed.id);
  assert.deepEqual(paused.schedule, { ...schedule, paused: true });
  assert.deepEqual(paused.actions, timed.actions);
  await page.reload();
  await expect(page).toHaveURL(base + '/#pult/scenes/scheduled');
  await expect(scheduledFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(scheduledFilter).toHaveText(new RegExp(`По расписанию\\s*${scheduledCount}$`));
  await expect(instantGroup).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  assert.notDeepEqual(await fill(), activeFill, 'Pausing changes the fill of the tile');

  await page.route(
    timedEndpoint,
    (route) =>
      route.fulfill({ status: 503, json: { error: 'Проверка ошибки сохранения расписания' } }),
    { times: 1 },
  );
  await pressSchedule(503);
  await expect(page.getByRole('alert')).toContainText('Проверка ошибки сохранения расписания');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await pressSchedule();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const final = await snapshot();
  const saved = final.definitions.find((entry) => entry.id === timed.id);
  assert.equal(Boolean(saved.schedule.paused), false);
  assert.deepEqual(saved.schedule.days, schedule.days);
  assert.equal(saved.schedule.time, schedule.time);
  assert.equal(saved.schedule.timeZone, schedule.timeZone);
  assert.deepEqual(saved.actions, timed.actions);
  assert.deepEqual(
    final.runs.map((entry) => entry.id),
    [accepted.id, ...initial.runs.map((entry) => entry.id)],
    'Only tapping the instant tile executes a scene',
  );
  await instantFilter.tap();
  await expect(page).toHaveURL(base + '/#pult/scenes');
  await expect(run).toBeVisible();
  await expect(scheduledGroup).toBeHidden();
  await page.locator('[data-pult-room="all"]').tap();
  await expect(page).toHaveURL(base + '/#pult');
  await expect(page.locator('[data-pult-tile]').first()).toBeVisible();
}

module.exports = { checkPultScenes };
