/** @file Regression for intrinsic iframe height: repeated growth, shrink and nested PLC layout. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, expect } = require('@playwright/test');

async function checkPortalResize({ page, artifacts, deviceId }) {
  const initialViewport = page.viewportSize();
  const portal = page.frameLocator('[data-hub-portal]');
  const measure = () =>
    page.evaluate(() => {
      const frame = document.querySelector('[data-hub-portal]');
      const root = frame?.contentDocument?.querySelector('#app');
      if (!frame || !root) return null;
      const nested = root.querySelector('[data-plc-settings-frame]');
      return {
        frame: frame.getBoundingClientRect().height,
        content: Math.max(root.scrollHeight, root.getBoundingClientRect().height),
        outer: document.documentElement.scrollHeight,
        nested: nested?.getBoundingClientRect().height || 0,
      };
    });
  async function probe(height) {
    await page.evaluate((height) => {
      const doc = document.querySelector('[data-hub-portal]').contentDocument;
      doc.querySelector('[data-resize-probe]')?.remove();
      if (!height) return;
      const element = doc.createElement('div');
      element.dataset.resizeProbe = '';
      element.style.cssText = `height:${height}px;min-height:${height}px;flex:none`;
      doc.querySelector('.main-content').append(element);
    }, height);
  }
  async function stable(name) {
    await page.waitForTimeout(180);
    const samples = [];
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(100);
      const current = await measure();
      assert.ok(current, name + ': portal content is available');
      samples.push(current);
    }
    const spread = (key) =>
      Math.max(...samples.map((row) => row[key])) - Math.min(...samples.map((row) => row[key]));
    assert.ok(
      spread('frame') <= 3,
      name + ': iframe height stabilizes, samples=' + JSON.stringify(samples),
    );
    assert.ok(spread('outer') <= 3, name + ': page stops growing without content changes');
    const last = samples.at(-1);
    assert.ok(last.frame >= last.content - 2, name + ': content is not clipped');
    assert.ok(
      last.frame <= Math.max(850, last.content) + 3,
      name + ': no accumulating empty space',
    );
    return last;
  }
  async function roundTrips(name, count, nested = false) {
    const start = await stable(name + ' baseline');
    for (let i = 0; i < count; i++) {
      await probe(900);
      await expect.poll(async () => (await measure()).frame).toBeGreaterThan(start.frame + 700);
      if (nested)
        assert.ok(
          Math.abs((await measure()).nested - start.nested) <= 2,
          name + ': nested PLC frame does not grow with its parent viewport',
        );
      await probe(0);
      await expect.poll(async () => (await measure()).frame).toBeLessThanOrEqual(start.frame + 3);
    }
    const end = await stable(name + ' after ' + count + ' grow/shrink cycles');
    assert.ok(
      Math.abs(end.frame - start.frame) <= 3,
      name + ': original content height is restored',
    );
  }
  try {
    await page.locator('[data-cloud-nav="control"]').click();
    await portal.locator('.app-shell').waitFor();
    for (const [name, viewport] of [
      ['desktop', { width: 1440, height: 1000 }],
      ['mobile', { width: 390, height: 900 }],
    ]) {
      await page.setViewportSize(viewport);
      await portal.locator('[data-nav="overview"]').click();
      await portal.locator('[data-device-id]').first().waitFor();
      const natural = await stable(name + ' initial overview');
      await page.locator('[data-hub-portal]').evaluate((frame) => {
        frame.style.height = '3000px';
      });
      await portal.locator('[data-nav="devices"]').click();
      await portal.locator('[data-device-id]').first().waitFor();
      await portal.locator('[data-nav="overview"]').click();
      await expect.poll(async () => (await measure()).frame).toBeLessThanOrEqual(natural.frame + 3);
      await roundTrips(name + ' overview', 6);
      const tile = deviceId
        ? portal.locator(`[data-device-id="${deviceId}"]`)
        : portal.locator('[data-device-id]').first();
      const selectedId = await tile.getAttribute('data-device-id');
      await tile.click();
      await stable(name + ' device');
      await portal.locator(`[data-plc-configure="${selectedId}"]`).click();
      const plc = portal.frameLocator('[data-plc-settings-frame]');
      await plc.locator('#app-view').waitFor({ state: 'visible' });
      await plc.locator('#tab-system').click();
      await roundTrips(name + ' nested PLC', 2, true);
      if (artifacts) {
        await fs.mkdir(artifacts, { recursive: true });
        await page.screenshot({
          path: path.join(artifacts, 'cloud-portal-resize-' + name + '.png'),
          fullPage: true,
        });
      }
      await portal.locator('[data-plc-settings-back]').click();
      await portal.locator('[data-nav="overview"]').click();
      await stable(name + ' return to overview');
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        name + ': no horizontal overflow',
      );
    }
    console.log(
      'FCPLCn portal resize passed: stable heights across 6 grow/shrink cycles per viewport, desktop/mobile navigation and nested PLC frame isolation.',
    );
  } finally {
    await probe(0).catch(() => {});
    if (initialViewport) await page.setViewportSize(initialViewport);
  }
}

/** Optional read-only run against an explicitly selected local preview; no settings are saved. */
async function standalone() {
  const base = process.env.FCPLCN_CLOUD_RESIZE_BASE;
  assert.ok(base, 'Set FCPLCN_CLOUD_RESIZE_BASE to the local cloud preview URL');
  const url = new URL(base);
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'Standalone resize checks are restricted to local preview',
  );
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await page.goto(url.origin);
    await page
      .getByLabel('Логин', { exact: true })
      .fill(process.env.FCPLCN_CLOUD_RESIZE_USERNAME || 'admin');
    await page
      .getByLabel('Пароль', { exact: true })
      .fill(process.env.FCPLCN_CLOUD_RESIZE_PASSWORD || '');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await checkPortalResize({ page, artifacts: path.resolve(__dirname, '../.artifacts') });
  } finally {
    await browser.close();
  }
}

module.exports = { checkPortalResize };
if (require.main === module)
  standalone().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
