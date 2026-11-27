/** @file The shared tank visual and monitoring command path on tablet, device and cloud-ready UI. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { expect } = require('@playwright/test');

async function checkTanks({ page, context, base, artifacts }) {
  await page.locator('[data-pult-filter="tanks"]').click();
  const card = page.locator('[data-controller-kind="tanks"]').first();
  await card.waitFor();
  await expect(card.locator('[data-tank-level]')).toHaveAttribute('data-tank-level', '50');
  const monitoringDot = card.locator('.pult-tile-state:not([data-tank-output]) .pult-state-dot');
  const activeDotColor = await monitoringDot.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  assert.ok(activeDotColor && !['transparent', 'rgba(0, 0, 0, 0)'].includes(activeDotColor));
  const outputs = async (pumpState, valveState) => {
    for (const [id, label, state] of [
      ['pump', 'Насос', pumpState],
      ['valve', 'Кран', valveState],
    ]) {
      const row = card.locator(`[data-tank-output="${id}"]`);
      await expect(row).toHaveText(label);
      await expect(row).toHaveAttribute('data-output-state', state);
      const dotColor = await row
        .locator('.pult-state-dot')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      if (state === 'on')
        assert.equal(
          dotColor,
          activeDotColor,
          `${label}: confirmed ON matches the monitoring indicator`,
        );
      else assert.notEqual(dotColor, activeDotColor, `${label}: ${state} never looks active`);
    }
  };
  await outputs('on', 'on');
  assert.equal(await card.locator('.tank-levels').count(), 0, 'Pult omits individual level blocks');
  assert.equal(
    await card.locator('.tank-estimate').count(),
    0,
    'Pult omits the detailed estimate note',
  );
  await expect(card).toHaveAttribute('data-pult-state', 'on');
  await expect(card).toHaveClass(/pult-state-on/);
  const paint = () =>
    card.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundImage, style.backgroundColor, style.borderColor];
    });
  const onPaint = await paint();
  const monitoring = card.locator('[data-tank-monitoring]');
  const commandEndpoint = base + '/api/v1/devices/fcplcn-demo-utility/commands';
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let submitted;
  const intercepted = new Promise((resolve) => {
    submitted = resolve;
  });
  const hold = async (route) => {
    assert.deepEqual(route.request().postDataJSON(), {
      controller: 'tanks',
      itemId: 'tank-water',
      value: false,
    });
    submitted();
    await gate;
    await route.continue();
  };
  await page.route(commandEndpoint, hold);
  try {
    const confirmation = page.waitForResponse(
      (response) => response.url() === commandEndpoint && response.request().method() === 'POST',
    );
    await monitoring.click();
    await intercepted;
    await expect(monitoring).toHaveAttribute('aria-busy', 'true');
    await expect(monitoring).toHaveAttribute('aria-pressed', 'true');
    await expect(card).toHaveAttribute('data-pult-state', 'on');
    assert.deepEqual(await paint(), onPaint, 'Pending OFF does not invent a disabled tank color');
    await outputs('on', 'on');
    release();
    const response = await confirmation;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).status, 'applied');
  } finally {
    release();
    await page.unroute(commandEndpoint, hold);
  }
  await expect(monitoring).toHaveAttribute('aria-pressed', 'false');
  await expect(card).toHaveAttribute('data-pult-state', 'off');
  await expect(card).toHaveClass(/pult-state-off/);
  await expect.poll(paint).not.toEqual(onPaint);
  const offPaint = await paint();
  await expect(card.locator('[data-tank-level]')).toHaveAttribute('data-tank-level', 'unknown');
  const read = async () => {
    const reply = await context.request.get(base + '/api/v1/overview');
    assert.equal(reply.status(), 200);
    return reply.json();
  };
  const item = () =>
    read().then(
      (data) =>
        data.devices.find((d) => d.id === 'fcplcn-demo-utility').controllers.tanks.data.items[0],
    );
  await expect
    .poll(async () => {
      const row = await item();
      return [row.enabled, row.pumpActual, row.valveActual];
    })
    .toEqual([false, false, false]);
  await outputs('off', 'off');
  await monitoring.click();
  await expect(monitoring).toHaveAttribute('aria-pressed', 'true');
  await expect(card).toHaveAttribute('data-pult-state', 'on');
  await expect.poll(paint).toEqual(onPaint);
  assert.notDeepEqual(onPaint, offPaint, 'Confirmed monitoring uses a visibly active background');
  await expect(card.locator('[data-tank-level]')).toHaveAttribute('data-tank-level', '50');
  await outputs('on', 'on');

  const acquisitionMessage = 'Ожидается подтверждение датчиков уровня';
  const status = card.locator('.pult-tile-state:not([data-tank-output])');
  let level = 0,
    stale = false,
    issue = null;
  const endpoint = base + '/api/v1/overview';
  const projection = async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    const module = data.devices.find((d) => d.id === 'fcplcn-demo-utility').controllers.tanks;
    module.fresh = !stale;
    Object.assign(module.data.items[0], {
      enabled: true,
      levelPct: issue ? null : level,
      available: !issue,
      levelsWet: issue ? [null, null] : [level >= 50, level === 100],
      pumpActual: issue ? false : level >= 50,
      valveActual: issue ? false : level < 100,
      error: issue,
    });
    await route.fulfill({ response, json: data });
  };
  await page.route(endpoint, projection);
  try {
    issue = acquisitionMessage;
    await page.getByRole('button', { name: 'Обновить состояния', exact: true }).click();
    await expect(status).toHaveText('Ожидаем датчики…');
    await expect(card).toHaveAttribute('data-pult-state', 'on');
    await expect(card.locator('[data-tank-level]')).toHaveAttribute('data-tank-level', 'unknown');
    await outputs('off', 'off');
    for (const fault of [
      acquisitionMessage + '; выключение реле не подтверждено',
      'Ошибка уровней: верхний датчик мокрый, нижний сухой',
    ]) {
      issue = fault;
      await page.getByRole('button', { name: 'Обновить состояния', exact: true }).click();
      await expect(status).toHaveText('Ошибка бака');
      await expect(card).toHaveAttribute('data-pult-state', 'error');
      await expect(status).toHaveAttribute('title', fault);
    }
    issue = null;
    for (const pct of [0, 50, 100]) {
      level = pct;
      await page.getByRole('button', { name: 'Обновить состояния', exact: true }).click();
      await expect(card.locator('[data-tank-level]')).toHaveAttribute(
        'data-tank-level',
        String(pct),
      );
      await expect(card).toHaveAttribute('data-pult-state', 'on');
      await expect(status).toHaveText('Мониторинг вкл.');
      assert.equal(await card.locator('[data-tank-water]').count(), pct ? 1 : 0);
      await outputs(pct === 0 ? 'off' : 'on', pct === 100 ? 'off' : 'on');
    }
    if (await page.locator('[data-action-notice]').count())
      await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).click();
    for (const [name, width, height] of [
      ['landscape', 1194, 834],
      ['portrait', 820, 1180],
      ['mobile', 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.locator('[data-pult-filter="all"]').click();
      const boxes = await page
        .locator('.pult-controls > [data-pult-tile]')
        .evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return {
              kind: element.dataset.controllerKind,
              width: box.width,
              height: box.height,
              top: box.top,
            };
          }),
        );
      const tankBox = boxes.find((box) => box.kind === 'tanks');
      const regular = boxes.filter((box) => box.kind !== 'tanks');
      assert.ok(tankBox && regular.length > 0);
      const ordinaryColumnWidth = Math.min(...regular.map((box) => box.width));
      assert.ok(
        Math.abs(tankBox.width - ordinaryColumnWidth) <= 2,
        `${name}: tank occupies one ordinary grid column; ${JSON.stringify(boxes)}`,
      );
      // Exclude the tank's own row: a formerly oversized tank must not make its peers
      // appear to match merely because CSS grid stretched that entire row.
      const otherRows = regular.filter((box) => Math.abs(tankBox.top - box.top) > 2);
      assert.ok(
        otherRows.some((box) => Math.abs(tankBox.height - box.height) <= 2),
        `${name}: tank height matches an ordinary equipment row; ${JSON.stringify(boxes)}`,
      );
      assert.equal(await card.locator('.tank-levels,.tank-estimate').count(), 0);
      const diagram = await card.locator('[data-tank-level]').boundingBox();
      assert.ok(
        diagram.width <= 120 && diagram.width < tankBox.width * 0.55,
        `${name}: compact tank diagram leaves room for readings`,
      );
      await page.screenshot({
        path: path.join(artifacts, `hub-tanks-${name}.png`),
        fullPage: true,
      });
      await card.screenshot({
        path: path.join(artifacts, `hub-tank-compact-${name}.png`),
        animations: 'disabled',
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.ok((await monitoring.boundingBox()).height >= 48);
    }
    stale = true;
    await page.getByRole('button', { name: 'Обновить состояния', exact: true }).click();
    await expect(card.locator('[data-tank-level]')).toHaveAttribute('data-tank-level', 'unknown');
    await expect(monitoring).toBeDisabled();
    await expect(monitoring).toHaveAttribute('aria-pressed', 'mixed');
    await expect(card).toHaveAttribute('data-pult-state', 'unknown');
    await expect(card).toHaveClass(/pult-state-unknown/);
    assert.notDeepEqual(await paint(), onPaint, 'Stale monitoring never keeps its active color');
    assert.equal(await card.locator('[data-tank-water]').count(), 0);
    await outputs('unknown', 'unknown');
  } finally {
    await page.unroute(endpoint, projection);
  }
  await page.getByRole('button', { name: 'Обновить состояния', exact: true }).click();
  await page.locator('[data-pult-filter="all"]').click();
  console.log(
    'Tank UI passed: acquisition waiting versus real faults, confirmed monitoring colors, pump/valve dots, compact 0/50/100 tiles, stale neutral state and tablet/mobile layout.',
  );
}
module.exports = { checkTanks };
