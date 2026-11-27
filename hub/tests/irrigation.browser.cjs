/** @file One tile per watering rule, linked to its PLC schedule editor. */
'use strict';
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');

async function checkIrrigation({ page, base }) {
  const sprinkler = page.locator('[data-pult-tile] .irrigation-symbol').first();
  const light = page.locator('.pult-kind-lights .pult-tile-icon .icon').first();
  await expect(sprinkler).toBeVisible();
  const width = (icon) => icon.evaluate((el) => getComputedStyle(el).width);
  assert.equal(
    await width(sprinkler),
    await width(light),
    'Watering and light tiles use the same icon size',
  );
  await page.locator('[data-pult-filter="irrigation"]').click();
  const cards = page.locator('[data-pult-tile][data-controller-kind="irrigation"]');
  const garden = cards.filter({ hasText: 'Полив сада' });
  const toggle = garden.locator('[data-irrigation-enable]');
  const state = garden.locator('.irrigation-state');
  await expect(cards).toHaveCount(1);
  await expect(garden.locator('.irrigation-schedule')).toHaveText('Пн, Ср, Пт · 07:00 · 15 мин');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(state).toHaveText('Ожидает старта');

  const overview = base + '/api/v1/overview';
  let dry = true,
    stale = false,
    tankless = false;
  const observe = async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    const mod = data.devices.find((d) => d.id === 'fcplcn-demo-utility').controllers.irrigation;
    mod.fresh = !stale;
    Object.assign(
      mod.data.items[0],
      tankless
        ? { tankId: '', actual: true, valveActual: true, waterAvailable: null }
        : { actual: false, valveActual: !dry, waterAvailable: !dry },
    );
    await route.fulfill({ response, json: data });
  };
  const refresh = () =>
    page.getByRole('button', { name: 'Обновить состояния', exact: true }).click();
  await page.route(overview, observe);
  try {
    await refresh();
    await expect(state).toHaveText('Нет воды в баке');
    dry = false;
    await refresh();
    await expect(state).toHaveText('Ожидает старта');
    tankless = true;
    await refresh();
    await expect(state).toHaveText('Идёт полив');
    await expect(garden).toHaveAttribute('data-pult-state', 'on');
    stale = true;
    await refresh();
    await expect(toggle).toBeDisabled();
    await expect(state).toHaveText('Нет свежих данных');
  } finally {
    await page.unroute(overview, observe);
  }
  await refresh();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await garden.getByRole('button', { name: 'Настроить правило «Полив сада»' }).click();
  const iframe = page.locator('[data-plc-settings-frame]');
  await expect(iframe).toHaveAttribute('src', /#irrigation\/irrigation-garden$/);
  const frame = page.frameLocator('[data-plc-settings-frame]');
  const add = frame.locator('#irrigation-add');
  await expect(add).toBeVisible();
  await expect(frame.locator('[data-irrigation-id="irrigation-garden"]')).toBeVisible();
  await add.click();
  const second = frame.locator('[data-irrigation-id]').last();
  const field = (key) => second.locator('[data-irrigation-field="' + key + '"]');
  await field('name').fill('Вечерний полив');
  await field('tankId').selectOption('tank-water');
  await field('relayId').selectOption('rly-0/8');
  await field('startTime').fill('21:45');
  await field('durationMinutes').fill('22');
  for (let day = 1; day <= 7; day++)
    await second.locator('[data-irrigation-day="' + day + '"]').setChecked(day === 2 || day === 6);
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/service/controllers/irrigation') && r.request().method() === 'POST',
  );
  await frame.locator('#irrigation-save').click();
  const reply = await saved;
  assert.equal(reply.status(), 200, await reply.text());
  await page.locator('[data-plc-settings-back]').click();
  await expect(page.locator('[data-module="irrigation"] [data-item-id]')).toHaveCount(2);
  await page.locator('[data-nav="pult"]').click();
  await page.locator('[data-pult-filter="irrigation"]').click();
  await expect(cards).toHaveCount(2);
  const evening = cards.filter({ hasText: 'Вечерний полив' });
  await expect(evening.locator('.irrigation-schedule')).toHaveText('Вт, Сб · 21:45 · 22 мин');
  await expect(evening.locator('[data-irrigation-enable]')).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await page.locator('[data-pult-room="Первый этаж"]').click();
  await page.locator('[data-pult-filter="irrigation"]').click();
  await expect(cards).toHaveCount(0);
  await page.getByRole('button', { name: 'Гостиная · Добавить правило' }).click();
  await expect(iframe).toHaveAttribute('src', /fcplcn-demo-living\/#irrigation$/);
  await frame.locator('#irrigation-enabled').click();
  await expect(frame.locator('#irrigation-enabled')).toHaveAttribute('aria-pressed', 'true');
  await add.click();
  const newRule = frame.locator('[data-irrigation-id]').last();
  const source = newRule.locator('[data-irrigation-field="tankId"]');
  await expect(source).toHaveValue('');
  await expect(source.locator('option:checked')).toHaveText('Без бака');
  await newRule.locator('[data-irrigation-field="name"]').fill('Полив от водопровода');
  await newRule.locator('[data-irrigation-field="startTime"]').fill('18:30');
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith('/fcplcn-demo-living/service/controllers/irrigation') &&
      r.request().method() === 'POST',
  );
  await frame.locator('#irrigation-save').click();
  const creation = await created;
  assert.equal(creation.status(), 200, await creation.text());
  await page.locator('[data-plc-settings-back]').click();
  const deviceCard = page
    .locator('[data-module="irrigation"] [data-item-id]')
    .filter({ hasText: 'Полив от водопровода' });
  await expect(deviceCard.locator('.irrigation-ports')).toContainText('Без бака');
  await deviceCard.locator('[data-irrigation-enable]').click();
  await expect(deviceCard.locator('.irrigation-state')).toHaveText('Ожидает старта');
  await page.locator('[data-nav="pult"]').click();
  await page.locator('[data-pult-filter="irrigation"]').click();
  const standalone = cards.filter({ hasText: 'Полив от водопровода' });
  await expect(standalone.locator('.irrigation-state')).toHaveText('Ожидает старта');
  await expect(standalone).toHaveAttribute('data-pult-state', 'on');
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(standalone).toBeVisible();
  const tileBox = await standalone.boundingBox();
  assert.ok(tileBox.x >= 0 && tileBox.x + tileBox.width <= 391, 'Mobile tile fits the viewport');
  await page.setViewportSize(viewport);

  await standalone
    .getByRole('button', { name: 'Настроить правило «Полив от водопровода»' })
    .click();
  const remote = frame.locator('[data-irrigation-field="tankId"]');
  const remoteRef = 'fcplcn-demo-utility/tank-water';
  await expect(remote.locator(`option[value="${remoteRef}"]`)).toHaveText(/Бак с водой.*Котельная/);
  await remote.selectOption(remoteRef);
  const rebound = page.waitForResponse(
    (r) =>
      r.url().endsWith('/fcplcn-demo-living/service/controllers/irrigation') &&
      r.request().method() === 'POST',
  );
  await frame.locator('#irrigation-save').click();
  const refreshed = await rebound;
  assert.equal(refreshed.status(), 200, await refreshed.text());
  await page.locator('[data-plc-settings-back]').click();
  await expect(deviceCard.locator('.irrigation-ports')).toContainText('Котельная · Бак с водой');
  await page.locator('[data-nav="pult"]').click();
  await page.locator('[data-pult-filter="irrigation"]').click();
  await expect(standalone.locator('.irrigation-remote-tank')).toContainText(
    'Котельная · Бак с водой',
  );
  await page.locator('[data-pult-filter="all"]').click();
}
module.exports = { checkIrrigation };
