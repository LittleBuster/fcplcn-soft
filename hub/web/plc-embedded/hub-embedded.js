/** @file Presentation and notifications for the hub-hosted PLC editor only. */
import { connectPLCNotices } from './notice-bridge.js';

const marker = document.querySelector('meta[name="fcplcn-hub-embedded"]');
if (marker?.content === 'true') {
  document.documentElement.dataset.fcplcnHubEmbedded = 'true';
  document.getElementById('logout').hidden = true;
  const login = document.getElementById('login-view');
  login.querySelector('h2').textContent = 'Подключение к PLC';
  login.querySelector('.muted').textContent =
    'Настройка через локальный хаб. Отдельный вход в PLC не требуется.';
  const form = document.getElementById('login-form');
  form.querySelector('button').textContent = 'Повторить подключение';
  form.addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.location.reload();
    },
    true,
  );
  connectPLCNotices();
}
