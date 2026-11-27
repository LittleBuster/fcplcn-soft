/** @file Verify Telegram settings and its preview without contacting the Telegram service. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { expect } = require('@playwright/test');

/** Exercise the shipped page against a private deterministic settings API. */
async function checkTelegram({ page, base, artifacts, expectHttpError }) {
  const endpoint = base + '/api/v1/telegram';
  const fakeToken = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  let privateToken = '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  let nextConflict = false;
  const saved = [];
  const model = {
    config: {
      revision: 7,
      enabled: false,
      tokenConfigured: true,
      chats: [
        {
          chatId: '12345678',
          name: 'Сергей',
          username: 'sergey_home',
          lastSeenAt: new Date().toISOString(),
        },
      ],
    },
    lastContact: {
      chatId: '23456789',
      name: 'Анна',
      username: 'anna_home',
      receivedAt: new Date().toISOString(),
    },
    status: { state: 'disabled', botUsername: '', botName: '', error: null, lastPollAt: null },
  };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const settings = async (route) => {
    if (route.request().method() === 'GET') return json(route, model);
    const body = route.request().postDataJSON();
    saved.push(body);
    if (nextConflict || body.baseRevision !== model.config.revision) {
      nextConflict = false;
      model.config.revision++;
      return json(
        route,
        { error: 'Настройки Telegram изменились. Загрузите актуальную версию.' },
        409,
      );
    }
    if ('token' in body) privateToken = body.token;
    model.config.revision++;
    model.config.enabled = body.enabled;
    model.config.tokenConfigured = Boolean(privateToken);
    model.config.chats = body.chats.map((entry) => ({
      ...entry,
      username:
        model.config.chats.find((old) => old.chatId === entry.chatId)?.username ||
        (model.lastContact?.chatId === entry.chatId ? model.lastContact.username : ''),
      lastSeenAt:
        model.config.chats.find((old) => old.chatId === entry.chatId)?.lastSeenAt ||
        (model.lastContact?.chatId === entry.chatId ? model.lastContact.receivedAt : null),
    }));
    model.status.state = body.enabled ? 'connecting' : 'disabled';
    return json(route, model);
  };
  const test = async (route) => {
    assert.equal(route.request().method(), 'POST');
    assert.deepEqual(route.request().postDataJSON(), {});
    model.status = {
      state: 'running',
      botUsername: 'fcplcn_test_bot',
      botName: 'FCPLCn',
      lastPollAt: new Date().toISOString(),
      error: null,
    };
    return json(route, { ok: true });
  };
  await page.route(endpoint, settings);
  await page.route(endpoint + '/test', test);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-nav="telegram"]').click();
    const panel = page.locator('[data-telegram-settings]');
    await expect(panel.getByRole('heading', { name: 'Подключение бота' })).toBeVisible();
    const token = page.locator('#telegram-token');
    await expect(token).toHaveValue('');
    await expect(token).toHaveAttribute('type', 'password');
    await expect(token).toHaveAttribute('placeholder', /Токен сохранён/);
    assert.ok((await panel.locator('[data-icon="telegram"]').count()) >= 2);
    await expect(panel.locator('[data-allowed-chat="12345678"]')).toContainText('@sergey_home');
    await expect(panel.locator('[data-last-chat-id]')).toHaveText('23456789');

    await token.fill(fakeToken);
    model.lastContact = {
      chatId: '34567890',
      name: 'Мария',
      username: 'maria_home',
      receivedAt: new Date().toISOString(),
    };
    await expect(panel.locator('[data-last-chat-id]')).toHaveText('34567890', { timeout: 6000 });
    await expect(token).toHaveValue(fakeToken);
    await panel.getByRole('button', { name: 'Разрешить доступ' }).click();
    await expect(panel.locator('[data-allowed-chat="34567890"] input')).toHaveValue('Мария');
    assert.equal(saved.length, 0, 'Discovering/adding a draft does not silently authorize anyone');
    await panel.getByLabel('Chat ID', { exact: true }).fill('45678901');
    await panel.getByLabel('Имя', { exact: true }).fill('Алексей');
    await panel.getByRole('button', { name: 'Добавить', exact: true }).click();
    await panel.getByRole('switch', { name: 'Включить Telegram' }).check();
    await panel.getByRole('button', { name: 'Сохранить Telegram' }).click();
    await expect(panel.getByText('Настройки Telegram сохранены.', { exact: true })).toBeVisible();
    assert.equal(saved.at(-1).token, fakeToken);
    assert.equal(saved.at(-1).enabled, true);
    assert.equal(saved.at(-1).chats.length, 3);
    assert.ok(
      saved.at(-1).chats.every((entry) => Object.keys(entry).sort().join(',') === 'chatId,name'),
    );
    await expect(token).toHaveValue('');
    assert.equal(
      await panel.evaluate((element, secret) => element.innerHTML.includes(secret), fakeToken),
      false,
      'Saved token is absent from the rendered page',
    );

    await panel.getByRole('button', { name: 'Проверить соединение' }).click();
    await expect(panel.getByText('Telegram подтвердил токен бота.')).toBeVisible();
    await expect(panel.getByRole('link', { name: '@fcplcn_test_bot' })).toBeVisible();
    await panel.getByLabel('Имя для 45678901').fill('Алексей · семья');
    await page.waitForTimeout(2200);
    await expect(panel.getByLabel('Имя для 45678901')).toHaveValue('Алексей · семья');
    await panel.getByRole('button', { name: 'Сохранить Telegram' }).click();
    await expect(panel.getByText('Настройки Telegram сохранены.', { exact: true })).toBeVisible();
    assert.equal(
      'token' in saved.at(-1),
      false,
      'Blank credential input preserves the private stored token',
    );
    assert.equal(privateToken, fakeToken);
    await panel.getByRole('button', { name: 'Проверить соединение' }).click();
    await expect(panel.getByText('Telegram подтвердил токен бота.')).toBeVisible();
    await page.screenshot({
      path: path.join(artifacts, 'hub-telegram-desktop.png'),
      fullPage: true,
      animations: 'disabled',
    });

    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({
      path: path.join(artifacts, 'hub-telegram-mobile.png'),
      fullPage: true,
      animations: 'disabled',
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'Telegram settings fit a phone without horizontal scrolling',
    );
    const preview = panel.getByRole('complementary', { name: 'Пример меню Telegram' });
    const message = preview.locator('[data-telegram-preview-message]');
    const house = await page.request.get(base + '/api/v1/overview').then((reply) => reply.json());
    const keyboardRows = preview.locator('.telegram-keyboard > div');
    await expect(keyboardRows.first().getByRole('button')).toHaveText([
      '🏠 Я дома',
      '🚪 Ушел',
      '🚗 Готовлюсь',
    ]);
    for (const [index, device] of house.devices.entries()) {
      await expect(keyboardRows.nth(index + 1).getByRole('button')).toHaveText([
        `🏡 ${device.name || device.id}`,
      ]);
    }
    const withSockets = house.devices.find((entry) => entry.controllers.sockets);
    assert.ok(withSockets, 'The keyboard preview includes a configured socket module');
    await preview
      .getByRole('button', { name: `🏡 ${withSockets.name || withSockets.id}`, exact: true })
      .click();
    await preview.getByRole('button', { name: '🔌 Розетки', exact: true }).click();
    await expect(message).toContainText('Розетки');
    await expect(message.locator('b').first()).toContainText(withSockets.name || withSockets.id);
    const detailsButton = preview.getByRole('button', {
      name: 'ℹ️ Подробности каналов',
      exact: true,
    });
    await expect(keyboardRows.nth(-3).getByRole('button')).toHaveText(['⚙️ Настройки']);
    await expect(keyboardRows.nth(-2).getByRole('button')).toHaveText(['ℹ️ Подробности каналов']);
    await detailsButton.click();
    await expect(keyboardRows.nth(-2).getByRole('button')).toHaveText(['⚡ Быстрое управление']);
    const socket = withSockets.controllers.sockets.data.items[0];
    await preview
      .getByRole('button', { name: socket.name || socket.id })
      .first()
      .click();
    await expect(message).toContainText('Подтверждение реле:');
    await preview.getByRole('button', { name: '⬅️ Каналы', exact: true }).click();
    await expect(keyboardRows.nth(-2).getByRole('button')).toHaveText(['⚡ Быстрое управление']);
    await preview.getByRole('button', { name: '⚡ Быстрое управление', exact: true }).click();
    await expect(detailsButton).toBeVisible();
    await preview.getByRole('button', { name: '⬅️ Контроллеры', exact: true }).click();

    const requests = [];
    const collectMutation = (request) => {
      if (request.url().startsWith(base + '/api/v1/') && request.method() !== 'GET')
        requests.push(request.url());
    };
    page.on('request', collectMutation);
    try {
      const press = (label) => preview.getByRole('button', { name: label, exact: true }).click();
      await press('⬅️ Устройства');
      await press('🏡 Котельная');
      await press('🛢 Баки');
      await expect(message.locator('b').filter({ hasText: 'Бак с водой' })).toBeVisible();
      assert.match(
        await message.textContent(),
        /Бак с водой\nМониторинг: [^\n]+\nУровень: [^\n]+\nНасос: [^\n]+\nКран: [^\n]+/,
      );
      const disableModule = preview.getByRole('button', {
        name: '⚙️ Выключить модуль',
        exact: true,
      });
      await expect(disableModule).toHaveCount(0);
      await expect(keyboardRows.nth(-3).getByRole('button')).toHaveText(['🛢 Бак с водой']);
      await expect(keyboardRows.nth(-2).getByRole('button')).toHaveText(['⚙️ Настройки']);
      await press('⚙️ Настройки');
      await expect(message).toContainText('Настройки модуля');
      await disableModule.click();
      await expect(preview.getByRole('status').locator('blockquote')).toContainText(
        'Пример действия · ⚙️ Выключить модуль',
      );
      await press('⬅️ Каналы');
      await expect(disableModule).toHaveCount(0);
      await expect(
        preview.getByRole('button', { name: '🛢 Бак с водой', exact: true }),
      ).toBeVisible();
      await press('⬅️ Контроллеры');
      await press('💧 Полив');
      await press('💧 Полив сада');
      await expect(preview.getByText(/07:00/)).toBeVisible();
      assert.match(await message.textContent(), /Время старта: 07:00\nДлительность: 15 мин/);
      await expect(message.locator('b').getByText('Источник воды:', { exact: true })).toBeVisible();
      await expect(preview.getByRole('button', { name: '🟢 Включить правило' })).toBeVisible();
      await press('⚙️ Настроить');
      await press('📅 Дни полива');
      await press('⌨️ 1 3');
      await expect(message).toContainText('Сохранить новое значение «Пн, Ср»?');
      await press('💾 Сохранить');
      await expect(preview.getByRole('status').locator('blockquote')).toContainText(
        'Пример действия',
      );
      await press('⬅️ Настройки');
      await press('🛢 Бак');
      await expect(preview.getByRole('button', { name: '➖ Без бака', exact: true })).toBeVisible();
      await expect(
        preview.getByRole('button', { name: '🛢 Бак с водой', exact: true }),
      ).toBeVisible();
      assert.deepEqual(requests, [], 'Preview actions never send a controller mutation');
    } finally {
      page.off('request', collectMutation);
    }

    nextConflict = true;
    await panel.getByLabel('Имя для 12345678').fill('Несохранённое имя');
    const permit = expectHttpError?.(endpoint, 409);
    try {
      await panel.getByRole('button', { name: 'Сохранить Telegram' }).click();
      await expect(
        panel.getByText('Настройки Telegram изменились. Загрузите актуальную версию.'),
      ).toBeVisible();
      await expect(panel.getByLabel('Имя для 12345678')).toHaveValue('Несохранённое имя');
    } finally {
      permit?.();
    }
    await panel.getByRole('button', { name: 'Загрузить настройки', exact: true }).first().click();
    await expect(panel.getByLabel('Имя для 12345678')).toHaveValue('Сергей');
    await expect(panel.getByRole('button', { name: 'Сохранить Telegram' })).toBeDisabled();
    await panel.getByRole('button', { name: 'Удалить Алексей · семья', exact: true }).click();
    await panel.getByRole('button', { name: 'Сохранить Telegram' }).click();
    await expect(panel.locator('[data-allowed-chat="45678901"]')).toHaveCount(0);
    await expect(panel.getByText('Настройки Telegram сохранены.', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Удалить токен', exact: true }).click();
    await expect(panel.getByRole('switch', { name: 'Включить Telegram' })).not.toBeChecked();
    await panel.getByRole('button', { name: 'Сохранить Telegram' }).click();
    await expect(panel.getByText('Токен пока не задан', { exact: true })).toBeVisible();
    assert.equal(saved.at(-1).token, null);
    assert.equal(privateToken, null);
    console.log(
      'FCPLCn Telegram browser checks passed: private token handling, named access list, latest sender, explicit grants, preserved drafts, CAS recovery, keyboard hierarchy preview and mobile layout.',
    );
  } finally {
    await page.locator('[data-nav="overview"]').click();
    await page.unroute(endpoint, settings);
    await page.unroute(endpoint + '/test', test);
  }
}
module.exports = { checkTelegram };
