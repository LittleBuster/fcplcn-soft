/** @file Exercise the history dialog with deterministic hourly readings. */
'use strict';
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');

async function checkMeteoHistory({ page, base }) {
  const endpoint = base + '/api/v1/devices/fcplcn-demo-living/meteo/temp-living/history?*';
  const requested = [];
  let empty = false;
  const respond = async (route) => {
    const period = new URL(route.request().url()).searchParams.get('period');
    requested.push(period);
    const count = period === 'week' ? 168 : 24;
    const points = Array.from({ length: count }, (_, i) => ({
      hour: new Date(Date.UTC(2026, 10, 24, i)).toISOString(),
      temperatureC: empty || i === 8 ? null : 19 + (i % 6) / 2,
      humidityPct: empty || i === 9 ? null : 45 + (i % 9),
    }));
    await route.fulfill({
      json: { deviceName: 'Гостиная', sensorName: 'Воздух в гостиной', period, points },
    });
  };
  const viewport = page.viewportSize();
  const button = page
    .locator('[data-controller-kind="meteo"][data-item-id="temp-living"]')
    .getByRole('button', { name: 'График' });
  const dialog = page.getByRole('dialog', { name: 'Воздух в гостиной' });
  async function checkTrace(series, pointCount, missingHour) {
    const markers = series.locator('circle');
    await expect(markers).toHaveCount(pointCount - 1);
    const coordinates = await markers.evaluateAll((points) =>
      points.map((point) => `${point.getAttribute('cx')} ${point.getAttribute('cy')}`),
    );
    const segments = coordinates.map(
      (point, index) => `${index === 0 || index === missingHour ? 'M' : 'L'}${point}`,
    );
    await expect(series.locator('.meteo-history-trace')).toHaveAttribute('d', segments.join(' '));
  }
  await page.route(endpoint, respond);
  try {
    await button.click();
    await expect(dialog.getByRole('button', { name: '24 часа' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const temperature = dialog.locator('[data-history-series="temperatureC"]');
    const humidity = dialog.locator('[data-history-series="humidityPct"]');
    await expect(temperature.getByRole('img')).toBeVisible();
    await expect(humidity).toBeVisible();
    await checkTrace(temperature, 24, 8);
    await checkTrace(humidity, 24, 9);
    await expect(temperature.locator('[data-history-hour="2026-11-24T08:00:00.000Z"]')).toHaveCount(
      0,
    );
    await expect(humidity.locator('[data-history-hour="2026-11-24T09:00:00.000Z"]')).toHaveCount(0);

    await page.setViewportSize({ width: 360, height: 760 });
    await dialog.getByRole('button', { name: '7 дней' }).click();
    await expect(dialog.getByRole('button', { name: '7 дней' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(temperature.getByRole('img')).toBeVisible();
    await checkTrace(temperature, 168, 8);
    await checkTrace(humidity, 168, 9);
    assert.deepEqual(requested, ['day', 'week']);
    assert.equal(
      await dialog.evaluate((element) => element.scrollWidth > element.clientWidth),
      false,
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();

    empty = true;
    await button.click();
    await expect(dialog.getByRole('status')).toHaveText('За этот период показаний пока нет.');
    await expect(dialog.getByRole('img')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Закрыть' }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await page.unroute(endpoint, respond);
    await page.setViewportSize(viewport);
  }
}

module.exports = { checkMeteoHistory };
