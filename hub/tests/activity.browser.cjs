'use strict';
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');

async function checkActivity({ page, base, screenshot }) {
  const offlineAt = '2026-11-20T10:00:00.000Z';
  const onlineAt = '2026-11-20T10:03:15.000Z';
  const now = '2026-11-20T10:05:00.000Z';
  const actor = { name: 'Сергей', source: 'telegram' };
  const overview = base + '/api/v1/overview';
  const historyEndpoint = base + '/api/v1/devices/*/connection-history?*';
  const fleetEndpoint = base + '/api/v1/devices/connection-history?*';
  const garage = 'fcplcn-demo-garage';
  const living = 'fcplcn-demo-living';
  const retired = 'fcplcn-retired-fixture';
  const archive = 'fcplcn-archive-fixture';
  const olderStart = '2026-11-17T08:00:00.000Z';
  const olderRecovery = '2026-11-19T12:15:00.000Z';
  const dayStart = '2026-11-19T10:05:00.000Z';
  const weekStart = '2026-11-13T10:05:00.000Z';
  const restoredOutage = {
    id: 'test-restored',
    deviceId: garage,
    deviceName: 'Гараж',
    offlineAt,
    onlineAt,
    reason: 'availability',
  };
  const openOutage = {
    id: 'test-open',
    deviceId: retired,
    deviceName: 'Котельная',
    offlineAt,
    onlineAt: null,
    reason: 'timeout',
  };
  const archiveOutage = {
    ...restoredOutage,
    id: 'test-archive',
    deviceId: archive,
    deviceName: 'Мастерская',
    offlineAt: '2026-11-16T06:05:00.000Z',
    onlineAt: '2026-11-16T08:05:00.000Z',
  };
  const withRecordedActivity = async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    const command = {
      ...snapshot.commands[0],
      actor,
      deviceName: 'PLC гаража в журнале',
      status: 'applied',
      createdAt: offlineAt,
      completedAt: onlineAt,
    };
    snapshot.now = now;
    snapshot.commands[0] = command;
    snapshot.scenes.runs = [
      {
        id: 'test-activity-run',
        name: 'Вечернее освещение',
        status: 'partial',
        actor,
        startedAt: offlineAt,
        completedAt: onlineAt,
        results: [
          {
            ...command,
            id: 'test-activity-run-result',
            itemName: 'Свет',
            source: 'configured',
            error: null,
          },
          {
            ...command,
            id: 'test-activity-missing-result',
            deviceName: 'PLC котельной в журнале',
            itemName: 'Свет',
            source: 'configured',
            status: 'unknown',
            error: null,
          },
        ],
      },
    ];
    snapshot.outages = [restoredOutage, openOutage];
    await route.fulfill({ response, json: snapshot });
  };
  const withConnectionHistory = async (route) => {
    const url = new URL(route.request().url());
    const period = url.searchParams.get('period');
    const deviceId = url.pathname.split('/').at(-2);
    const outages =
      deviceId === garage
        ? [
            { ...restoredOutage, id: 'test-old', offlineAt: olderStart, onlineAt: olderRecovery },
            restoredOutage,
          ]
        : deviceId === retired
          ? [openOutage]
          : [];
    await route.fulfill({
      json: { period, from: period === 'week' ? weekStart : dayStart, to: now, outages },
    });
  };
  const withFleetHistory = async (route) => {
    const period = new URL(route.request().url()).searchParams.get('period');
    const devices = [
      { id: garage, name: 'Гараж', online: true },
      { id: living, name: 'Гостиная', online: true },
      { id: retired, name: 'Котельная', online: false },
    ];
    const outages = [restoredOutage, openOutage];
    if (period === 'week') {
      devices.push({ id: archive, name: archiveOutage.deviceName, online: null });
      outages.unshift(archiveOutage);
    }
    await route.fulfill({
      json: { period, from: period === 'week' ? weekStart : dayStart, to: now, devices, outages },
    });
  };

  await page.route(overview, withRecordedActivity);
  await page.route(historyEndpoint, withConnectionHistory);
  await page.route(fleetEndpoint, withFleetHistory);
  try {
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    const command = page.locator('.command-row').filter({ hasText: 'PLC гаража в журнале' });
    await command.getByText('Сергей · Telegram', { exact: true }).waitFor();
    assert.equal(await command.locator(`time[datetime="${offlineAt}"]`).count(), 1);
    assert.equal(await command.locator(`time[datetime="${onlineAt}"]`).count(), 1);
    await command.getByText('PLC подтвердил', { exact: true }).waitFor();

    const sections = page.getByRole('group', { name: 'Раздел журнала' });
    await sections.getByRole('button', { name: 'Сценарии', exact: true }).click();
    const run = page.locator('[data-scene-run-id="test-activity-run"]');
    await run.getByText('Сергей · Telegram', { exact: true }).waitFor();
    await run.getByText('PLC подтвердили 1 из 2 действий', { exact: true }).click();
    const confirmed = run.locator('[data-scene-result-id="test-activity-run-result"]');
    await confirmed.getByText('Подтверждено', { exact: true }).waitFor();
    const unknown = run.locator('[data-scene-result-id="test-activity-missing-result"]');
    await unknown.getByText('PLC котельной в журнале', { exact: true }).waitFor();
    await unknown.getByText('Не подтверждено', { exact: true }).waitFor();

    await sections.getByRole('button', { name: 'Связь с PLC', exact: true }).click();
    const restored = page.locator('[data-device-outage="test-restored"]');
    await restored.getByText('Связь восстановлена', { exact: true }).waitFor();
    assert.equal(await restored.locator(`time[datetime="${offlineAt}"]`).count(), 1);
    assert.equal(await restored.locator(`time[datetime="${onlineAt}"]`).count(), 1);
    await restored.getByText('3 мин 15 с', { exact: true }).waitFor();
    const open = page.locator('[data-device-outage="test-open"]');
    await open.getByText('Ожидается', { exact: true }).waitFor();
    await open.getByText('5 мин 0 с', { exact: true }).waitFor();

    const controller = page.getByLabel('Контроллер', { exact: true });
    const periods = page.getByRole('group', { name: 'Период графика' });
    const day = periods.getByRole('button', { name: '24 часа', exact: true });
    const week = periods.getByRole('button', { name: '7 дней', exact: true });
    const fleet = page.locator('.fleet-connection-history');
    const garageRow = fleet.locator(`[data-fleet-device="${garage}"]`);
    const livingRow = fleet.locator(`[data-fleet-device="${living}"]`);
    const retiredRow = fleet.locator(`[data-fleet-device="${retired}"]`);
    const archiveRow = fleet.locator(`[data-fleet-device="${archive}"]`);
    const details = fleet.locator('[data-fleet-details]');
    await expect(controller.locator('option:checked')).toHaveText('Все контроллеры');
    await expect(fleet).toHaveAttribute('data-from', dayStart);
    await expect(garageRow.getByText('На связи', { exact: true })).toHaveCSS(
      'color',
      'rgb(126, 213, 173)',
    );
    await expect(livingRow).toBeVisible();
    await expect(retiredRow.getByText('Офлайн', { exact: true })).toBeVisible();
    const openDip = retiredRow.locator('button[data-fleet-outage="test-open"]');
    await expect(openDip).toHaveAttribute('data-from', offlineAt);
    await expect(openDip).toHaveAttribute('data-to', now);
    const x = (mark) => mark.evaluate((element) => element.getBBox().x);
    assert.equal(
      await x(garageRow.locator('[data-fleet-outage-path="test-restored"]')),
      await x(retiredRow.locator('[data-fleet-outage-path="test-open"]')),
    );
    await openDip.press('Enter');
    await expect(details).toContainText('5 мин');
    await expect(details.locator(`time[datetime="${offlineAt}"]`)).toHaveCount(1);
    await week.click();
    await expect(fleet).toHaveAttribute('data-from', weekStart);
    await expect(archiveRow.getByText('Нет данных', { exact: true })).toBeVisible();
    await expect(openDip).toHaveAttribute('aria-pressed', 'true');
    await screenshot('hub-connection-fleet-mobile');
    await day.click();
    await expect(fleet).toHaveAttribute('data-from', dayStart);
    await expect(archiveRow).toHaveCount(0);

    const chart = page.getByRole('img', { name: 'График связи с PLC' });
    const oldDip = chart.locator('[data-connection-outage="test-old"]');
    const shortDip = chart.locator('[data-connection-outage="test-restored"]');
    const ongoingDip = chart.locator('[data-connection-outage="test-open"]');
    await controller.selectOption(garage);
    await expect(day).toHaveAttribute('aria-pressed', 'true');
    await expect(chart).toHaveAttribute('data-from', dayStart);
    await expect(oldDip).toHaveAttribute('data-from', dayStart);
    await expect(oldDip).toHaveAttribute('data-to', olderRecovery);
    await expect(shortDip).toHaveAttribute('data-from', offlineAt);
    await expect(shortDip).toHaveAttribute('data-to', onlineAt);
    assert.match(await shortDip.getAttribute('d'), /^M[\d. ,]+V[\d. ,]+H[\d. ,]+V[\d. ,]+$/);
    const dayWidth = await shortDip.evaluate((element) => element.getBBox().width);
    assert.ok(dayWidth > 0);

    await week.click();
    await expect(chart).toHaveAttribute('data-from', weekStart);
    await expect(oldDip).toHaveAttribute('data-from', olderStart);
    await expect(shortDip).toHaveAttribute('data-to', onlineAt);
    const weekWidth = await shortDip.evaluate((element) => element.getBBox().width);
    assert.ok(weekWidth > 0 && Math.abs(dayWidth / weekWidth - 7) < 0.05);

    await controller.selectOption(retired);
    await expect(controller).toHaveValue(retired);
    await expect(ongoingDip).toHaveAttribute('data-from', offlineAt);
    await expect(ongoingDip).toHaveAttribute('data-to', now);
    assert.doesNotMatch(await ongoingDip.getAttribute('d'), /H[\d. ,]+V/);

    await controller.selectOption(living);
    await expect(
      page.getByText('За этот период офлайн не зафиксирован.', { exact: true }),
    ).toBeVisible();
    await controller.selectOption(garage);
    await expect(shortDip).toBeVisible();
    await screenshot('hub-connection-journal-mobile');
  } finally {
    await page.unroute(overview, withRecordedActivity);
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await page.unroute(historyEndpoint, withConnectionHistory);
    await page.unroute(fleetEndpoint, withFleetHistory);
  }
}

module.exports = { checkActivity };
