/** @file Shared local/cloud proof for native device illustrations and persisted hub-owned selection. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function checkIllustration({
  page,
  scope = page,
  request,
  persisted,
  artifacts,
  label = 'hub',
  deviceId = 'fcplcn-demo-garage',
  expect: providedExpect,
}) {
  // Hub and cloud install Playwright independently; reuse the caller's matcher instance.
  const expect = providedExpect || require('@playwright/test').expect;
  const { deviceIllustrations } = await import(
    pathToFileURL(path.resolve(__dirname, '../dist/shared/device-art.js'))
  );
  assert.equal(deviceIllustrations.length, 30);
  const saved = await request('/overview').then((reply) => reply.json());
  const original = saved.devices.find((device) => device.id === deviceId);
  assert.ok(original);
  const initialViewport = page.viewportSize();
  const imageRequests = [];
  const imageRequest = (request) => {
    if (request.resourceType() === 'image') imageRequests.push(request.url());
  };
  page.on('request', imageRequest);
  try {
    await scope.locator('[data-nav="overview"]').click();
    await scope.locator(`[data-device-id="${deviceId}"]`).click();
    await scope.locator(`[data-edit-illustration="${deviceId}"]`).click();
    const picker = scope.locator('[data-illustration-picker]');
    await expect(picker).toBeVisible();
    const options = picker.locator('[data-illustration-option]');
    await expect(options).toHaveCount(30);
    assert.deepEqual(
      (
        await options.evaluateAll((elements) =>
          elements.map((element) => element.dataset.illustrationOption),
        )
      ).sort(),
      deviceIllustrations.map((item) => item.id).sort(),
    );
    const drawings = await options.evaluateAll((elements) =>
      elements.map((element) => {
        const svg = element.querySelector('svg');
        return (
          svg?.innerHTML
            .replace(/<title[\s\S]*?<\/title>/g, '')
            .replace(/\s+id="[^"]*"/g, '')
            .replace(/url\(#[^)]*\)/g, 'url(#paint)') || ''
        );
      }),
    );
    assert.ok(drawings.every(Boolean), 'Every catalog entry has an inline SVG');
    assert.equal(new Set(drawings).size, 30, 'Illustrations contain distinct SVG drawings');
    await picker.getByRole('button', { name: 'Оборудование', exact: true }).click();
    await expect(options).toHaveCount(
      deviceIllustrations.filter((item) => item.group === 'Оборудование').length,
    );
    await picker.getByRole('button', { name: 'Все', exact: true }).click();
    await picker.getByLabel('Найти картинку', { exact: true }).fill('Котельная');
    await expect(options).toHaveCount(1);
    await picker.locator('[data-illustration-option="boiler-room"]').click();
    await expect(picker.locator('[data-illustration-option="boiler-room"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await picker.getByLabel('Найти картинку', { exact: true }).fill('');
    await picker.locator('[data-illustration-option="garage"]').click();
    await page.waitForTimeout(2200);
    await expect(picker.locator('[data-illustration-option="garage"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const pending = page.waitForResponse(
      (reply) =>
        reply.request().method() === 'PATCH' && reply.url().endsWith('/devices/' + deviceId),
    );
    await picker.getByRole('button', { name: 'Сохранить картинку', exact: true }).click();
    const response = await pending;
    assert.equal(response.status(), 200);
    assert.equal(response.request().postDataJSON().illustrationId, 'garage');
    await expect(scope.locator('.device-detail-banner')).toHaveAttribute(
      'data-device-illustration',
      'garage',
    );
    assert.equal(
      (await request('/overview').then((reply) => reply.json())).devices.find(
        (device) => device.id === deviceId,
      ).illustrationId,
      'garage',
    );
    if (persisted) assert.equal((await persisted())[deviceId].illustrationId, 'garage');
    const renameOnly = await request(
      '/devices/' + deviceId,
      { name: original.name, room: original.room },
      'PATCH',
    );
    assert.equal(renameOnly.status(), 200);
    assert.equal(
      (await request('/overview').then((reply) => reply.json())).devices.find(
        (device) => device.id === deviceId,
      ).illustrationId,
      'garage',
      'Older name-only clients preserve the selected illustration',
    );
    page.off('request', imageRequest);
    assert.deepEqual(imageRequests, [], 'Catalog SVGs need no image downloads');
    await page.reload();
    const card = scope.locator(`[data-device-id="${deviceId}"]`);
    await expect(card).toHaveAttribute('data-device-illustration', 'garage');
    await page.waitForTimeout(2200);
    await expect(card).toHaveAttribute('data-device-illustration', 'garage');
    await card.click();
    await scope.locator(`[data-edit-illustration="${deviceId}"]`).click();
    await expect(scope.locator('[data-illustration-option="garage"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(scope.locator('[data-illustration-picker]')).toBeVisible();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'Illustration picker fits a phone',
    );
    assert.equal(
      await scope.locator('html').evaluate((element) => element.scrollWidth > element.clientWidth),
      false,
      'The embedded picker also fits its own viewport',
    );
    if (artifacts)
      await page.screenshot({
        path: path.join(artifacts, label + '-illustration-mobile.png'),
        fullPage: true,
      });
    await scope.locator('[data-nav="overview"]').click();
    if (persisted)
      assert.equal(
        (await persisted())[deviceId].illustrationId,
        'garage',
        'A fresh label-store reader retains the illustration',
      );
    console.log(
      `FCPLCn ${label} illustration checks passed: 30 distinct inline SVGs, filters/search, confirmed selection, name-only compatibility, persisted reload, polling and mobile layout.`,
    );
  } finally {
    page.off('request', imageRequest);
    if (initialViewport) await page.setViewportSize(initialViewport);
  }
}

module.exports = { checkIllustration };
