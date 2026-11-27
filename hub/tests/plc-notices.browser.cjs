/** @file Embedded PLC action feedback belongs to the host viewport, without moving its forms. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

/** The editor must already be open on Tanks with a saved, enabled module and a usable row. */
async function checkPLCNotices({
  page,
  scope = page,
  service,
  tankId,
  artifacts,
  label = 'hub',
  expect: suppliedExpect,
}) {
  const expect = suppliedExpect || require('@playwright/test').expect;
  const initialViewport = page.viewportSize();
  const frameElement = scope.locator('[data-plc-settings-frame]');
  const handle = await frameElement.elementHandle();
  assert.ok(handle);
  const host = await handle.ownerFrame();
  const editor = await handle.contentFrame();
  assert.ok(host && editor);
  const form = editor.locator('#tanks-form');
  const card = editor.locator(`[data-tank-id="${tankId}"]`);
  const toggle = card.locator('[data-tank-enabled]');
  const name = card.locator('[data-tank-field="name"]');
  const source = editor.locator('#tanks-notice');
  const toast = scope.locator('[data-action-notice]');
  const originalName = await name.inputValue();
  const originalEnabled = (await toggle.getAttribute('aria-pressed')) === 'true';
  let polls = 0;
  const observe = (response) => {
    if (response.url() === service + '/controllers' && response.request().method() === 'GET')
      polls++;
  };
  page.on('response', observe);
  const waitForPolls = async (count = 2) => {
    const target = polls + count;
    await expect.poll(() => polls, { timeout: 8000 }).toBeGreaterThanOrEqual(target);
  };
  const dismiss = async () => {
    if (await toast.count())
      await toast.getByRole('button', { name: 'Закрыть уведомление' }).click();
    await expect(toast).toHaveCount(0);
  };
  const setMonitoring = async (enabled) => {
    await expect(toggle).toBeEnabled();
    if ((await toggle.getAttribute('aria-pressed')) === String(enabled)) return;
    const reply = page.waitForResponse(
      (response) =>
        response.url() === service + '/controllers/tanks/enabled' &&
        response.request().method() === 'POST',
    );
    await toggle.click();
    const response = await reply;
    assert.equal(response.status(), 200, await response.text());
    await expect(toggle).toHaveAttribute('aria-pressed', String(enabled));
    await expect(toggle).toBeEnabled();
  };
  const geometry = async () => ({
    editor: await editor.evaluate((tankId) => {
      const form = document.getElementById('tanks-form').getBoundingClientRect();
      const card = document.querySelector(`[data-tank-id="${tankId}"]`).getBoundingClientRect();
      return {
        formTop: form.top + scrollY,
        formHeight: form.height,
        cardTop: card.top + scrollY,
        cardHeight: card.height,
        documentHeight: document.documentElement.scrollHeight,
      };
    }, tankId),
    host: await host.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      frame: document.querySelector('[data-plc-settings-frame]').getBoundingClientRect().height,
    })),
    outer: await page.evaluate(() => document.documentElement.scrollHeight),
    details: await card.evaluate((element) =>
      Array.from(element.children).map((child) => ({
        className: child.className,
        text: child.textContent.trim().slice(0, 160),
        height: child.getBoundingClientRect().height,
      })),
    ),
  });
  const unchanged = (before, after, description) => {
    const diagnostic = JSON.stringify({ before, after });
    for (const [key, value] of Object.entries(before.editor))
      assert.ok(
        Math.abs(value - after.editor[key]) <= 2,
        `${description}: editor ${key} stays fixed; ${diagnostic}`,
      );
    for (const [key, value] of Object.entries(before.host))
      assert.ok(
        Math.abs(value - after.host[key]) <= 2,
        `${description}: host ${key} stays fixed; ${diagnostic}`,
      );
    assert.ok(
      Math.abs(before.outer - after.outer) <= 2,
      `${description}: outer height stays fixed; ${diagnostic}`,
    );
  };
  const hiddenInline = async () => {
    assert.equal(await source.evaluate((element) => getComputedStyle(element).display), 'none');
    assert.equal(await source.evaluate((element) => element.getBoundingClientRect().height), 0);
  };
  try {
    await expect(form).toBeVisible();
    await dismiss();
    await toggle.scrollIntoViewIfNeeded();
    const before = await geometry();
    await setMonitoring(!originalEnabled);
    await expect(toast).toContainText(/Мониторинг бака (?:включён|выключен)/);
    await expect(toast).toHaveClass(/success/);
    await hiddenInline();
    const afterCommand = await geometry();
    for (const key of ['formTop', 'cardTop'])
      assert.ok(
        Math.abs(before.editor[key] - afterCommand.editor[key]) <= 2,
        `Monitoring confirmation: ${key} stays fixed; ${JSON.stringify({ before, afterCommand })}`,
      );
    // Monitoring changes sensor availability and may remove its debounce diagnostic.
    // Reloading the now-stable settings produces feedback without changing equipment content.
    await waitForPolls();
    await expect(card.locator('[data-tank-error]')).toBeHidden();
    await dismiss();
    const stable = await geometry();
    const acceptReload = (dialog) => dialog.accept();
    page.on('dialog', acceptReload);
    try {
      await editor.locator('#tanks-reload').click();
      await expect(toast).toContainText('загружены');
      await expect(editor.locator('#tanks-reload')).toBeEnabled();
    } finally {
      page.off('dialog', acceptReload);
    }
    await hiddenInline();
    unchanged(stable, await geometry(), 'Settings reload feedback');
    await waitForPolls();
    await expect(toast).toHaveCount(0, { timeout: 6500 });
    unchanged(stable, await geometry(), 'Success expiry after polling');

    // The same confirmation is emitted by another action, then stays dismissed through polling.
    await setMonitoring(originalEnabled);
    await expect(toast).toContainText('Мониторинг бака');
    await dismiss();
    await waitForPolls();
    await expect(toast).toHaveCount(0);

    // A genuine client validation refusal is persistent, and the next successful save replaces it.
    await name.fill('я'.repeat(33));
    await editor.locator('#tanks-save').click();
    await expect(toast).toHaveClass(/error/);
    await expect(toast).toContainText('64 байт');
    assert.equal(await toast.getAttribute('role'), 'alert');
    await hiddenInline();
    await waitForPolls();
    await expect(toast).toContainText('64 байт');
    await name.fill(originalName);
    const saved = page.waitForResponse(
      (response) =>
        response.url() === service + '/controllers/tanks' && response.request().method() === 'POST',
    );
    await editor.locator('#tanks-save').click();
    assert.equal((await saved).status(), 200);
    await expect(toast).toHaveCount(1);
    await expect(toast).toHaveClass(/success/);
    await expect(toast).toContainText('сохранены');
    await dismiss();

    // The public message boundary never accepts another window or another origin as this editor.
    await host.evaluate(() => {
      const content = document.querySelector('[data-plc-settings-frame]').contentWindow;
      const envelope = {
        type: 'fcplcn:plc-notice',
        version: 1,
        sequence: 1_000_000,
        notice: { tone: 'error', text: 'Чужое уведомление' },
      };
      for (const [origin, source] of [
        [location.origin, window],
        ['https://unrelated.example', content],
      ])
        window.dispatchEvent(new MessageEvent('message', { origin, source, data: envelope }));
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: location.origin,
          source: content,
          data: { ...envelope, notice: { tone: 'error', text: 'x'.repeat(50_000) } },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: location.origin,
          source: content,
          data: { ...envelope, sequence: 1 },
        }),
      );
    });
    await expect(toast).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 900 });
    await toggle.scrollIntoViewIfNeeded();
    await setMonitoring(!originalEnabled);
    await expect(toast).toContainText('Мониторинг бака');
    await expect
      .poll(async () => {
        const box = await toast.boundingBox();
        return Boolean(
          box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 391 && box.y + box.height <= 901,
        );
      })
      .toBe(true);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    if (artifacts)
      await page.screenshot({
        path: path.join(artifacts, `${label}-plc-action-notice-mobile.png`),
        fullPage: true,
      });
    await dismiss();
    await waitForPolls();
    await expect(toast).toHaveCount(0);
    console.log(
      `FCPLCn ${label} embedded notices passed: confirmed Tank actions, stable geometry, polling expiry/dismiss, error replacement, trusted frame boundary and mobile viewport.`,
    );
  } finally {
    page.off('response', observe);
    if ((await name.inputValue().catch(() => originalName)) !== originalName)
      await name.fill(originalName);
    await setMonitoring(originalEnabled);
    await dismiss();
    if (initialViewport) await page.setViewportSize(initialViewport);
  }
}

module.exports = { checkPLCNotices };
