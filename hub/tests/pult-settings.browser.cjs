/** @file Explicit tablet temperature source, durable choices and unavailable-data behavior. */
'use strict';
const assert = require('node:assert/strict');
const { expect } = require('@playwright/test');

/** Exercise the real settings API while observing its effect on the tablet summary. */
async function checkPultSettings({ page, context, base }) {
  const endpoint = base + '/api/v1/pult/settings';
  const overviewEndpoint = base + '/api/v1/overview';
  const card = page.locator('[data-pult-temperature]');
  const editor = page.locator('[data-pult-temperature-settings]');
  const deviceField = editor.locator('[data-pult-temperature-device]');
  const sensorField = editor.locator('[data-pult-temperature-sensor]');
  const readSettings = async () => {
    const response = await context.request.get(endpoint);
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  const overview = await context.request.get(overviewEndpoint);
  assert.equal(overview.status(), 200, await overview.text());
  const snapshot = await overview.json();
  const candidates = snapshot.devices.flatMap((device) =>
    (device.controllers.meteo?.data.items || [])
      .filter((item) => item.available && typeof item.temperatureC === 'number')
      .map((item) => ({ device, item })),
  );
  const primary =
    candidates.find((entry) => entry.device.id === 'fcplcn-demo-living') || candidates[0];
  const alternate = candidates.find((entry) => entry.device.id !== primary?.device.id);
  assert.ok(primary && alternate, 'The demo supplies independent sources for selection checks');
  const reference = ({ device, item }) => ({ deviceId: device.id, itemId: item.id });
  const isSource = (view, candidate) => {
    assert.equal(view.temperatureSource?.deviceId, candidate.device.id);
    assert.equal(view.temperatureSource?.itemId, candidate.item.id);
  };
  async function open() {
    await page.locator('[data-pult-temperature-configure]').click();
    await editor.waitFor();
    await expect(deviceField).toBeEnabled();
  }
  async function choose(candidate) {
    await deviceField.selectOption(candidate.device.id);
    await sensorField.selectOption(candidate.item.id);
  }
  async function save(status = 200) {
    const pending = page.waitForResponse(
      (response) => response.url() === endpoint && response.request().method() === 'PUT',
    );
    await editor.locator('[data-pult-temperature-save]').click();
    const response = await pending;
    assert.equal(response.status(), status, await response.text());
    return response.json();
  }
  async function refresh() {
    const pending = page.waitForResponse(
      (response) => response.url() === overviewEndpoint && response.request().method() === 'GET',
    );
    await page.getByRole('button', { name: 'Обновить состояния', exact: true }).click();
    assert.equal((await pending).status(), 200);
  }
  async function expectSelected(candidate) {
    await expect(card).toContainText(candidate.device.name);
    await expect(card).toContainText(candidate.item.name);
  }

  assert.equal((await readSettings()).temperatureSource, null);
  await expect(card.locator('strong')).toHaveText('—');
  await open();
  await choose(primary);
  await refresh();
  await expect(deviceField).toHaveValue(primary.device.id);
  await expect(sensorField).toHaveValue(primary.item.id);

  // A read already in flight before saving must not roll the accepted source back.
  let releaseOld;
  const oldGate = new Promise((resolve) => {
    releaseOld = resolve;
  });
  let oldSnapshot;
  let pendingOld = Promise.resolve();
  const oldOverview = (route) => {
    if (oldSnapshot) return route.continue();
    pendingOld = (async () => {
      const response = await route.fetch();
      oldSnapshot = await response.json();
      await oldGate;
      await route.fulfill({ response, json: oldSnapshot });
    })();
    return pendingOld;
  };
  await page.route(overviewEndpoint, oldOverview);
  try {
    await page.getByRole('button', { name: 'Обновить состояния', exact: true }).click();
    await expect.poll(() => Boolean(oldSnapshot)).toBe(true);
    assert.equal(oldSnapshot.pult.temperatureSource, null);
    isSource(await save(), primary);
    await editor.waitFor({ state: 'hidden' });
    await expectSelected(primary);
    releaseOld();
    await pendingOld;
    await expect(
      page.getByRole('button', { name: 'Обновить состояния', exact: true }),
    ).toBeEnabled();
    await expectSelected(primary);
    await expect(card.locator('strong')).not.toHaveText('—');
  } finally {
    releaseOld();
    await page.unroute(overviewEndpoint, oldOverview);
    await pendingOld;
  }
  await page.reload();
  await card.waitFor();
  await expectSelected(primary);
  isSource(await readSettings(), primary);

  // Polling and cancellation never turn a temporary draft into a saved choice.
  await open();
  await choose(alternate);
  await refresh();
  await expect(deviceField).toHaveValue(alternate.device.id);
  await expect(sensorField).toHaveValue(alternate.item.id);
  await editor.locator('[data-pult-temperature-cancel]').click();
  await editor.waitFor({ state: 'hidden' });
  isSource(await readSettings(), primary);
  await expectSelected(primary);

  // Another panel wins by revision; a stale editor must not silently overwrite it.
  await open();
  await choose(alternate);
  const current = await readSettings();
  const concurrent = await context.request.put(endpoint, {
    data: { baseRevision: current.revision, temperatureSource: null },
  });
  assert.equal(concurrent.status(), 200, await concurrent.text());
  await save(409);
  await expect(editor.getByRole('alert')).toBeVisible();
  await expect(deviceField).toHaveValue(alternate.device.id);
  await expect(sensorField).toHaveValue(alternate.item.id);
  assert.equal((await readSettings()).temperatureSource, null);
  await expect(editor.locator('[data-pult-temperature-save]')).toBeDisabled();
  await editor.locator('[data-pult-temperature-reload]').click();
  await expect(deviceField).toHaveValue('');
  await expect(editor.locator('[data-pult-temperature-save]')).toBeEnabled();
  await choose(primary);
  isSource(await save(), primary);
  await editor.waitFor({ state: 'hidden' });

  let projection = 'stale';
  const unavailable = async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const device = data.devices.find((entry) => entry.id === primary.device.id);
    if (projection === 'missing-device') {
      data.devices = data.devices.filter((entry) => entry.id !== primary.device.id);
    } else if (projection === 'offline') {
      device.online = false;
      device.status = 'offline';
    } else if (projection === 'missing') {
      device.controllers.meteo.data.items = device.controllers.meteo.data.items.filter(
        (item) => item.id !== primary.item.id,
      );
    } else device.controllers.meteo.fresh = false;
    await route.fulfill({ response, json: data });
  };
  await page.route(overviewEndpoint, unavailable);
  try {
    for (const state of ['stale', 'offline', 'missing', 'missing-device']) {
      projection = state;
      await refresh();
      await expect(card.locator('strong')).toHaveText('—');
      await expectSelected(primary);
      isSource(await readSettings(), primary);
    }
  } finally {
    await page.unroute(overviewEndpoint, unavailable);
  }
  await refresh();
  await expect(card.locator('strong')).not.toHaveText('—');
  await expectSelected(primary);

  await open();
  await deviceField.selectOption('');
  const cleared = await save();
  assert.equal(cleared.temperatureSource, null);
  await editor.waitFor({ state: 'hidden' });
  await expect(card.locator('strong')).toHaveText('—');
  assert.equal((await readSettings()).temperatureSource, null);
  console.log(
    'FCPLCn pult settings passed: explicit source, reload, preserved/cancelled drafts, CAS conflict, stale/offline/missing source and clearing without fallback.',
  );
}

module.exports = { checkPultSettings };
