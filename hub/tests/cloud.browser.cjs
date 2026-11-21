/** @file Local pairing UI presentation; TLS claim and MQTT transport have independent real tests. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { expect } = require('@playwright/test');

async function checkCloudSettings({ page, base, artifacts }) {
  const endpoint = base + '/api/v1/cloud';
  const model = {
    config: {
      revision: 1,
      enabled: false,
      url: '',
      paired: false,
      hubId: '',
      homeId: '',
      name: '',
    },
    status: { state: 'disabled', error: null, lastConnectedAt: null, lastPublishedAt: null },
  };
  const saves = [];
  const route = async (request) => {
    const url = request.request().url(),
      method = request.request().method();
    if (method === 'POST') {
      const body = request.request().postDataJSON();
      saves.push({ url, body });
      if (url === endpoint + '/pair') {
        assert.equal(body.url, 'https://cloud.example.test');
        assert.equal(body.code, 'ABCD-1234-EFGH-5678');
        model.config = {
          revision: 2,
          enabled: true,
          paired: true,
          url: body.url,
          name: body.name,
          hubId: 'hub-test',
          homeId: 'home-test',
        };
        model.status.state = 'connecting';
      } else if (url === endpoint + '/disconnect') {
        model.config = {
          revision: model.config.revision + 1,
          enabled: false,
          paired: false,
          url: '',
          name: '',
          hubId: '',
          homeId: '',
        };
        model.status = {
          state: 'disabled',
          error: null,
          lastConnectedAt: null,
          lastPublishedAt: null,
        };
      } else {
        assert.equal(body.baseRevision, model.config.revision);
        model.config.revision++;
        model.config.enabled = body.enabled;
        model.status.state = body.enabled ? 'connecting' : 'disabled';
      }
    }
    await request.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(model),
    });
  };
  await page.route(endpoint, route);
  await page.route(endpoint + '/*', route);
  try {
    await page.locator('[data-nav="cloud"]').click();
    const panel = page.locator('[data-cloud-settings]');
    await expect(panel.getByRole('heading', { name: 'Привязать хаб' })).toBeVisible();
    assert.equal(await page.locator('.scene-cards .scene-card').count(), 0);
    await panel.getByLabel('Адрес облака', { exact: true }).fill('https://cloud.example.test');
    await panel.getByLabel('Название хаба', { exact: true }).fill('Домашний хаб');
    await panel.getByLabel('Код привязки', { exact: true }).fill('ABCD-1234-EFGH-5678');
    await page.waitForTimeout(2200);
    await expect(panel.getByLabel('Название хаба', { exact: true })).toHaveValue('Домашний хаб');
    await panel.getByRole('button', { name: 'Привязать к облаку' }).click();
    await expect(panel.locator('.cloud-state')).toContainText('Подключаемся');
    await expect(panel.getByLabel('Код привязки', { exact: true })).toHaveValue('');
    model.status = {
      state: 'online',
      error: null,
      lastConnectedAt: new Date().toISOString(),
      lastPublishedAt: new Date().toISOString(),
    };
    await expect(panel.locator('.cloud-state')).toContainText('На связи', { timeout: 6000 });
    await page.screenshot({ path: path.join(artifacts, 'hub-cloud-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: path.join(artifacts, 'hub-cloud-mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await panel.getByRole('button', { name: 'Выключить подключение' }).click();
    await expect(panel.locator('.cloud-state')).toContainText('Облако выключено');
    page.once('dialog', (dialog) => dialog.accept());
    await panel.getByRole('button', { name: 'Удалить привязку' }).click();
    await expect(panel.getByText('Не настроена', { exact: true })).toBeVisible();
    assert.equal(saves.length, 3);
    assert.equal(
      saves.filter((entry) => entry.url.endsWith('/pair')).length,
      1,
      'A pairing request is never retried by polling',
    );
    console.log(
      'FCPLCn local cloud settings browser passed: explicit pairing, draft preservation, live status, private credentials, disable/unpair and mobile layout.',
    );
  } finally {
    await page.unroute(endpoint, route);
    await page.unroute(endpoint + '/*', route);
    await page.locator('[data-nav="overview"]').click();
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}
module.exports = { checkCloudSettings };
