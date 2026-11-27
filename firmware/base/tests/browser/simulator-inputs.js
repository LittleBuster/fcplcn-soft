/**
 * @file simulator-inputs.js
 * @brief Provide simulator-only virtual buttons and temperature controls; never ship to the PLC.
 */
'use strict';

// Injected only by createMock({interactive:true}); never embedded in firmware.
(() => {
  const container = document.getElementById('simulator-input-buttons');
  const status = document.getElementById('simulator-input-status');
  let busy = false;
  let inputRead = null;
  /** @brief Refresh demonstration buttons without overlapping reads or an in-flight write. */
  async function refresh() {
    if (busy || inputRead || document.hidden) return;
    const pending = (async () => {
      try {
        const response = await fetch('/__simulator/inputs');
        if (busy) return;
        if (document.getElementById('app-view').hidden) {
          container.replaceChildren();
          status.textContent = 'Войдите в симулятор, чтобы управлять тестовыми кнопками входов.';
          return;
        }
        if (response.status === 401) {
          container.replaceChildren();
          status.textContent = 'Войдите в симулятор, чтобы управлять тестовыми кнопками входов.';
          return;
        }
        const data = await response.json();
        if (busy || document.getElementById('app-view').hidden) return;
        if (!response.ok) throw new Error(data.error || 'Кнопки симулятора недоступны');
        container.replaceChildren();
        status.textContent = data.inputs.length
          ? 'Только симулятор: нажатие LOW, отпускание HIGH. Назначенные входы сами не изменяются.'
          : 'Добавьте розетку, свет или термостат с входом кнопки, чтобы проверить нажатие. Без входа используется веб-переключатель.';
        for (const input of data.inputs) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'button secondary';
          button.dataset.simulatorInput = input.id;
          button.setAttribute('aria-pressed', String(input.pressed));
          button.textContent = `${input.pressed ? 'Отпустить' : 'Нажать'} ${input.id}`;
          button.addEventListener('click', async () => {
            if (busy) return;
            busy = true;
            button.disabled = true;
            try {
              if (inputRead) await inputRead;
              const result = await fetch('/__simulator/input', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: input.id, pressed: !input.pressed }),
              });
              const data = await result.json();
              if (!result.ok) throw new Error(data.error || 'Нажатие не принято');
            } catch (error) {
              status.textContent = error.message;
            } finally {
              busy = false;
              await refresh();
            }
          });
          container.append(button);
        }
      } catch (error) {
        if (!busy) status.textContent = error.message;
      }
    })();
    inputRead = pending;
    try {
      await pending;
    } finally {
      if (inputRead === pending) inputRead = null;
    }
  }
  refresh();
  window.setInterval(refresh, 1000);
  const temperatures = document.getElementById('simulator-temperatures');
  const temperatureStatus = document.getElementById('simulator-temperature-status');
  let temperatureBusy = false;
  let temperatureRead = null;
  /** @brief Keep virtual sensor reads and explicit slider writes in confirmed order. */
  async function refreshTemperatures() {
    if (temperatureBusy || temperatureRead || document.hidden) return;
    const pending = (async () => {
      try {
        const response = await fetch('/__simulator/temperatures');
        if (temperatureBusy) return;
        if (document.getElementById('app-view').hidden) {
          temperatures.replaceChildren();
          return;
        }
        if (response.status === 401) {
          temperatures.replaceChildren();
          return;
        }
        const data = await response.json();
        if (temperatureBusy || document.getElementById('app-view').hidden) return;
        if (!response.ok) throw new Error(data.error || 'Температуры недоступны');
        const ids = new Set(data.temperatures.map((item) => item.id));
        for (const card of temperatures.children)
          if (!ids.has(card.dataset.simulatorMeteo)) card.remove();
        temperatureStatus.textContent = data.temperatures.length
          ? 'Двигайте ползунок: это имитация нового измерения, а не изменение уставки. Работа реле видна во вкладке Термостат.'
          : 'Сохраните метеоточку, чтобы менять виртуальную температуру.';
        for (const item of data.temperatures) {
          let card = [...temperatures.children].find(
            (node) => node.dataset.simulatorMeteo === item.id,
          );
          if (!card) {
            card = document.createElement('label');
            card.dataset.simulatorMeteo = item.id;
            card.className = 'field';
            const label = document.createElement('span'),
              value = document.createElement('output'),
              slider = document.createElement('input');
            value.style.marginInlineStart = '0.5em';
            slider.type = 'range';
            slider.min = '-55';
            slider.max = '125';
            slider.step = '0.1';
            slider.style.width = '100%';
            slider.setAttribute('aria-label', `Виртуальная температура ${item.name}`);
            slider.addEventListener('input', () => {
              value.textContent = `${Number(slider.value).toFixed(1)} °C`;
            });
            slider.addEventListener('change', async () => {
              if (temperatureBusy) return;
              const target = Number(slider.value);
              temperatureBusy = true;
              for (const input of temperatures.querySelectorAll('input')) input.disabled = true;
              try {
                if (temperatureRead) await temperatureRead;
                const response = await fetch('/__simulator/temperature', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ id: item.id, temperatureC: target }),
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Измерение не принято');
              } catch (error) {
                temperatureStatus.textContent = error.message;
              } finally {
                temperatureBusy = false;
                for (const input of temperatures.querySelectorAll('input')) input.disabled = false;
                await refreshTemperatures();
              }
            });
            card.append(label, value, slider);
            temperatures.append(card);
          }
          card.children[0].textContent = `${item.name} · ${item.id}`;
          const slider = card.querySelector('input');
          if (document.activeElement !== slider && Number.isFinite(item.temperatureC)) {
            slider.value = item.temperatureC;
            card.querySelector('output').textContent = `${item.temperatureC.toFixed(1)} °C`;
          }
        }
      } catch (error) {
        if (!temperatureBusy) temperatureStatus.textContent = error.message;
      }
    })();
    temperatureRead = pending;
    try {
      await pending;
    } finally {
      if (temperatureRead === pending) temperatureRead = null;
    }
  }
  refreshTemperatures();
  window.setInterval(refreshTemperatures, 1000);
  const securityKeys = document.getElementById('simulator-security-keys');
  const securityZones = document.getElementById('simulator-security-zones');
  const securityStatus = document.getElementById('simulator-security-status');
  let securityBusy = false;
  /** @brief Expose physical contact and alarm-zone demonstrations only in the desktop simulator. */
  async function refreshSecurity() {
    if (securityBusy || document.hidden || !securityKeys) return;
    securityBusy = true;
    try {
      const response = await fetch('/__simulator/security');
      if (!response.ok || document.getElementById('app-view').hidden) {
        securityKeys.replaceChildren();
        securityZones.replaceChildren();
        return;
      }
      const data = await response.json();
      securityKeys.replaceChildren();
      securityZones.replaceChildren();
      securityStatus.textContent = data.present
        ? `Приложен ключ ${data.address.toUpperCase()}. Для нового касания сначала уберите ключ.`
        : 'Приложите ключ для поиска или переключения охраны. Датчики ниже переключают физические контакты.';
      const action = async (route, body) => {
        securityBusy = true;
        try {
          const result = await fetch(route, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const reply = await result.json();
          if (!result.ok) throw new Error(reply.error || 'Действие не принято');
        } catch (error) {
          securityStatus.textContent = error.message;
        } finally {
          securityBusy = false;
          refreshSecurity();
        }
      };
      for (const [index, address] of data.demoKeys.entries()) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button secondary';
        button.dataset.simulatorIbutton = address;
        const present = data.present && data.address === address;
        button.setAttribute('aria-pressed', String(present));
        button.textContent = present ? `Убрать ключ ${index + 1}` : `Приложить ключ ${index + 1}`;
        button.addEventListener('click', () =>
          action('/__simulator/ibutton', { address, present: !present }),
        );
        securityKeys.append(button);
      }
      for (const zone of data.zones) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button secondary';
        button.dataset.simulatorSecurityZone = zone.id;
        const active = zone.active === true;
        button.setAttribute('aria-pressed', String(active));
        button.textContent = `${zone.name}: ${active ? 'вернуть норму' : 'сработать'}`;
        button.addEventListener('click', () =>
          action('/__simulator/security-zone', { id: zone.id, active: !active }),
        );
        securityZones.append(button);
      }
    } catch (error) {
      securityStatus.textContent = error.message;
    } finally {
      securityBusy = false;
    }
  }
  refreshSecurity();
  window.setInterval(refreshSecurity, 1000);
})();

// Separate raw contact controls permit every pattern, including deliberately inconsistent wiring.
(() => {
  const container = document.getElementById('simulator-tanks');
  if (!container) return;
  const status = document.getElementById('simulator-tanks-status');
  let busy = false;
  async function refreshTanks() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const reply = await fetch('/__simulator/tanks');
      if (reply.status === 401) {
        container.replaceChildren();
        return;
      }
      const data = await reply.json();
      if (!reply.ok) throw new Error(data.error || 'Уровни недоступны');
      container.replaceChildren();
      status.textContent = data.tanks.length
        ? 'Только симулятор: переключайте контакт каждого датчика. Можно проверить и ошибочную последовательность уровней.'
        : 'Сначала сохраните бак с цифровыми входами.';
      for (const tank of data.tanks) {
        const row = document.createElement('div');
        row.className = 'button-row';
        const label = document.createElement('strong');
        label.textContent = tank.name;
        row.append(label);
        tank.levelInputs.forEach((id, index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'button secondary';
          button.dataset.simulatorTank = tank.id;
          button.dataset.simulatorTankLevel = String(index);
          const wet = tank.simulatedWet[index];
          button.textContent = `${id}: ${wet ? 'в воде' : 'сухо'}`;
          button.setAttribute('aria-pressed', String(wet));
          button.addEventListener('click', async () => {
            if (busy) return;
            busy = true;
            button.disabled = true;
            try {
              const next = [...tank.simulatedWet];
              next[index] = !wet;
              const response = await fetch('/__simulator/tank', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: tank.id, wet: next }),
              });
              const value = await response.json();
              if (!response.ok) throw new Error(value.error);
            } catch (error) {
              status.textContent = error.message;
            } finally {
              busy = false;
              void refreshTanks();
            }
          });
          row.append(button);
        });
        container.append(row);
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
    }
  }
  void refreshTanks();
  window.setInterval(refreshTanks, 1000);
})();
