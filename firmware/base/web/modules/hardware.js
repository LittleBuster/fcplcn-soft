/**
 * @file hardware.js
 * @brief Hardware status, relay operations and isolated polling.
 */
export function createHardwareUI(context) {
  const { controllers, state } = context;
  const api = (...args) => context.api(...args);
  const byId = (...args) => context.byId(...args);
  const errorMessage = (...args) => context.errorMessage(...args);
  const fieldError = (...args) => context.fieldError(...args);
  const gpioLabel = (...args) => context.gpioLabel(...args);
  const hardwareElement = (...args) => context.hardwareElement(...args);
  const i2cAddress = (...args) => context.i2cAddress(...args);
  const iconHeading = (...args) => context.iconHeading(...args);
  const post = (...args) => context.post(...args);
  const text = (...args) => context.text(...args);

  function hardwareActionNotice(message, kind = '') {
    const element = byId('hardware-action-notice');
    element.textContent = message;
    element.className = `notice ${kind}`.trim();
    element.hidden = !message;
  }

  function hardwareActive() {
    return state.authenticated && state.activeTab === 'hardware' && !document.hidden;
  }

  function renderChannels(containerId, channels, isRelay) {
    const container = byId(containerId);
    const existing = new Map(
      Array.from(container.children)
        .filter((child) => child.dataset.channelId)
        .map((child) => [child.dataset.channelId, child]),
    );
    const retained = new Set();
    for (const channel of channels) {
      if (!channel || typeof channel.id !== 'string') continue;
      retained.add(channel.id);
      let card = existing.get(channel.id);
      if (!card) {
        card = hardwareElement('article', 'channel-card');
        card.dataset.channelId = channel.id;
        const heading = hardwareElement('div', 'channel-heading');
        heading.append(
          hardwareElement('h3', 'channel-name', channel.id),
          hardwareElement('span', 'badge channel-state'),
        );
        card.append(heading, hardwareElement('p', 'channel-binding'));
        if (isRelay) {
          card.classList.add('relay-card');
          const button = hardwareElement('button', 'relay-toggle');
          button.type = 'button';
          button.dataset.relayId = channel.id;
          const track = hardwareElement('span', 'relay-switch-track');
          track.setAttribute('aria-hidden', 'true');
          const thumb = hardwareElement('span', 'relay-switch-thumb');
          thumb.append(
            hardwareElement('span', 'relay-switch-grip'),
            hardwareElement('span', 'relay-switch-progress'),
            hardwareElement('span', 'relay-switch-unknown', '?'),
          );
          track.append(thumb);
          const legend = hardwareElement('span', 'relay-switch-legend');
          legend.setAttribute('aria-hidden', 'true');
          legend.append(
            hardwareElement('span', '', '0 / OFF'),
            hardwareElement('span', '', 'I / ON'),
          );
          button.append(track, legend);
          button.addEventListener('click', () => setRelay(channel.id));
          card.append(button);
        }
        const error = hardwareElement('p', 'field-error');
        error.setAttribute('role', 'status');
        card.append(error);
        container.append(card);
      }
      iconHeading(
        card.querySelector('.channel-name'),
        channel.id,
        isRelay ? 'relay' : 'input',
        true,
      );
      const known = state.ioFresh && channel.valid === true && typeof channel.value === 'boolean';
      const uncertain = isRelay && state.ioUncertainRelays.has(channel.id);
      const valid = known && !uncertain;
      const badge = card.querySelector('.channel-state');
      const actualError = errorMessage(channel.error);
      const actionError = isRelay ? state.ioRelayErrors.get(channel.id) : '';
      badge.textContent = valid
        ? isRelay
          ? channel.value
            ? 'Включено'
            : 'Выключено'
          : channel.value
            ? 'HIGH'
            : 'LOW'
        : 'Нет данных';
      badge.className = `badge channel-state ${valid ? (channel.value ? 'state-on' : 'state-off') : actualError ? 'state-error' : 'state-unknown'}`;
      const portPin =
        Number.isInteger(channel.pin) && channel.pin >= 0 && channel.pin < 16
          ? `GP${channel.pin < 8 ? 'A' : 'B'}${channel.pin % 8}`
          : '';
      const binding = [
        channel.expander,
        Number.isInteger(channel.address) ? i2cAddress(channel.address) : '',
        portPin,
      ].filter((part) => part !== undefined && part !== null && part !== '');
      const ownerController = state.controllerResources.find(
        (resource) => resource.id === channel.id,
      )?.ownerController;
      const thermostatOwned = isRelay && ownerController === 'thermostats';
      if (thermostatOwned) binding.push('Управляет термостат');
      card.querySelector('.channel-binding').textContent =
        binding.join(' · ') || 'Привязка не указана';
      const error = card.querySelector('.field-error');
      error.textContent = [actionError, actualError].filter(Boolean).join(' · ');
      error.hidden = !error.textContent;
      if (isRelay) {
        const button = card.querySelector('button');
        const pending = state.ioActionBusy && state.ioActionId === channel.id;
        const label = valid ? (channel.value ? 'Выключить' : 'Включить') : 'Недоступно';
        button.dataset.state = valid ? (channel.value ? 'on' : 'off') : 'unknown';
        button.setAttribute('aria-pressed', valid ? String(channel.value) : 'mixed');
        button.setAttribute('aria-busy', String(pending));
        button.setAttribute(
          'aria-label',
          pending
            ? `${channel.id}: отправка команды. Подтверждённое состояние: ${known ? (channel.value ? 'включено' : 'выключено') : 'неизвестно'}.`
            : uncertain
              ? `${channel.id}: команда не подтверждена. Последнее подтверждённое состояние: ${known ? (channel.value ? 'включено' : 'выключено') : 'неизвестно'}.`
              : valid
                ? `${label} реле ${channel.id}`
                : `Реле ${channel.id}: состояние неизвестно`,
        );
        if (thermostatOwned)
          button.setAttribute(
            'aria-label',
            `Реле ${channel.id}: управляет термостат, ручное переключение недоступно`,
          );
        button.disabled = thermostatOwned || !valid || state.ioActionBusy || !hardwareActive();
        card.classList.toggle('relay-on', valid && channel.value);
        card.classList.toggle('relay-unknown', !valid);
        card.classList.toggle('relay-pending', pending);
        card.classList.toggle('relay-error', Boolean(actualError || actionError));
      }
    }
    for (const child of Array.from(container.children)) {
      if (!retained.has(child.dataset.channelId)) child.remove();
    }
    if (!retained.size)
      container.append(
        hardwareElement('p', 'muted', isRelay ? 'Нет данных о реле.' : 'Нет данных о входах.'),
      );
  }

  function renderI2c(buses) {
    const container = byId('hardware-i2c');
    container.replaceChildren();
    for (const bus of buses) {
      if (!bus) continue;
      const card = hardwareElement('div', 'hardware-bus');
      card.dataset.busId = bus.id;
      const heading = hardwareElement('div', 'channel-heading');
      const known = state.ioFresh && typeof bus.ready === 'boolean';
      const label = !known
        ? 'Нет данных'
        : bus.scanning
          ? 'Сканирование…'
          : bus.ready
            ? 'Готова'
            : 'Недоступна';
      heading.append(
        hardwareElement('h3', 'channel-name', bus.id || 'Шина I²C'),
        hardwareElement(
          'span',
          `badge ${!known ? 'state-unknown' : bus.ready ? 'state-on' : 'state-error'}`,
          label,
        ),
      );
      iconHeading(heading.querySelector('h3'), bus.id || 'Шина I²C', 'bus', true);
      card.append(
        heading,
        hardwareElement(
          'p',
          'hint',
          `SDA: ${gpioLabel(bus.sdaGpio)} · SCL: ${gpioLabel(bus.sclGpio)}`,
        ),
      );
      const addresses = hardwareElement('div', 'address-list');
      if (state.ioFresh && bus.ready && Array.isArray(bus.addresses) && bus.addresses.length) {
        for (const address of bus.addresses)
          addresses.append(hardwareElement('span', 'address-chip', i2cAddress(address)));
      } else {
        addresses.append(
          hardwareElement(
            'span',
            'muted',
            !known
              ? 'Нет данных об адресах'
              : bus.scanning
                ? 'Поиск устройств…'
                : !bus.ready
                  ? 'Шина недоступна'
                  : !Number.isFinite(bus.updatedAtMs)
                    ? 'Сканирование ещё не выполнено'
                    : 'Устройства не найдены',
          ),
        );
      }
      card.append(addresses);
      if (errorMessage(bus.error)) card.append(hardwareElement('p', 'field-error', bus.error));
      container.append(card);
    }
    if (!container.children.length)
      container.append(hardwareElement('p', 'muted', 'Нет данных о шинах.'));
  }

  /** @brief Show the selected memory technology, verified health and current journal allocation. */
  function renderStateMemory(storage) {
    const type = typeof storage.type === 'string' ? storage.type.toUpperCase() : '';
    const memoryType = ['FRAM', 'EEPROM'].includes(type) ? type : '';
    iconHeading(
      byId('hardware-fram-title'),
      memoryType ? `Память ${memoryType}` : 'Постоянная память',
      'chip',
    );
    const known = state.ioFresh && typeof storage.available === 'boolean';
    const available = known && storage.available;
    const valid = available && storage.valid === true;
    const badge = byId('hardware-fram-status');
    badge.textContent = !known
      ? 'Нет данных'
      : !available
        ? 'Нет связи'
        : valid
          ? 'Исправна'
          : 'Ошибка данных';
    badge.className = `badge ${!known ? 'state-unknown' : valid ? 'state-on' : 'state-error'}`;
    text('hardware-fram-model', storage.model);
    text(
      'hardware-fram-binding',
      [
        storage.busId || storage.bus || storage.i2cBus,
        Number.isInteger(storage.address) ? i2cAddress(storage.address) : '',
      ]
        .filter(Boolean)
        .join(' · '),
    );
    const number = (value) => Number.isSafeInteger(value) && value >= 0;
    const formatNumber = (value) => value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    const bytes = (value) =>
      value >= 1024 ? `${formatNumber(value / 1024)} КиБ` : `${formatNumber(value)} Б`;
    const capacity = storage.capacityBytes;
    const used = storage.usedBytes;
    const memoryKnown =
      available && number(capacity) && capacity > 0 && number(used) && used <= capacity;
    const progress = byId('hardware-fram-progress');
    progress.hidden = !memoryKnown;
    if (memoryKnown) {
      const description = `${bytes(used)} из ${bytes(capacity)} · ${formatNumber((100 * used) / capacity)} %`;
      text('hardware-fram-used', description);
      text('hardware-fram-free', `Свободно: ${bytes(capacity - used)}`);
      progress.max = capacity;
      progress.value = used;
      progress.setAttribute('aria-valuetext', description);
    } else {
      text('hardware-fram-used', 'Нет данных');
      text('hardware-fram-free', 'Свободно: нет данных');
      progress.removeAttribute('value');
      progress.removeAttribute('aria-valuetext');
    }
    text(
      'hardware-fram-payload',
      valid && number(storage.payloadBytes) ? bytes(storage.payloadBytes) : '—',
    );
    fieldError('hardware-fram-error', known ? storage.error : '', memoryType || 'Память');
  }

  function renderHardware() {
    const snapshot = state.ioSnapshot || {};
    const relays = Array.isArray(snapshot.relays) ? snapshot.relays : [];
    const inputs = Array.isArray(snapshot.inputs) ? snapshot.inputs : [];
    renderChannels('hardware-relays', relays, true);
    renderChannels('hardware-inputs', inputs, false);
    text('hardware-relay-count', relays.length ? `${relays.length} каналов` : '');
    text('hardware-input-count', inputs.length ? `${inputs.length} каналов` : '');
    renderI2c(Array.isArray(snapshot.i2c) ? snapshot.i2c : []);
    byId('hardware-scan').disabled = state.ioActionBusy || !hardwareActive();
    byId('hardware-scan').textContent =
      state.ioActionBusy && state.ioActionId === 'scan' ? 'Запуск…' : 'Сканировать шины';

    const rtc = snapshot.rtc || {};
    text('hardware-rtc-model', rtc.model);
    text(
      'hardware-rtc-binding',
      [rtc.busId, Number.isInteger(rtc.address) ? i2cAddress(rtc.address) : '']
        .filter(Boolean)
        .join(' · '),
    );
    const rtcKnown = state.ioFresh && typeof rtc.present === 'boolean';
    const rtcValid = rtcKnown && rtc.present && rtc.valid === true && Number.isFinite(rtc.unixTime);
    const rtcState = byId('hardware-rtc-status');
    rtcState.textContent = !rtcKnown
      ? 'Нет данных'
      : !rtc.present
        ? 'Не обнаружены'
        : rtcValid
          ? 'Время установлено'
          : 'Время недостоверно';
    rtcState.className = `badge ${!rtcKnown ? 'state-unknown' : rtcValid ? 'state-on' : 'state-error'}`;
    text(
      'hardware-rtc-time',
      rtcValid
        ? rtc.localTime || `${new Date(rtc.unixTime * 1000).toLocaleString('ru-RU')} (браузер)`
        : 'Нет данных',
    );
    fieldError('hardware-rtc-error', rtc.error, 'RTC');
    renderStateMemory(snapshot.stateStorage || {});

    const sensors = byId('hardware-sensors');
    sensors.replaceChildren();
    for (const sensor of Array.isArray(snapshot.sensors) ? snapshot.sensors : []) {
      if (!sensor) continue;
      const chip = hardwareElement('div', 'pin-chip');
      chip.append(
        hardwareElement('strong', '', sensor.id || 'Датчик'),
        hardwareElement('span', '', gpioLabel(sensor.gpio)),
      );
      const configured = controllers
        .find((model) => model.isMeteo)
        .snapshot?.items.find((item) => item.portId === sensor.id);
      iconHeading(
        chip.querySelector('strong'),
        sensor.id || 'Датчик',
        configured ? (configured.sensorType === 'onewire' ? 'onewire' : 'dht22') : 'probe',
        true,
      );
      if (errorMessage(sensor.error))
        chip.append(hardwareElement('p', 'field-error', sensor.error));
      sensors.append(chip);
    }
    if (!sensors.children.length)
      sensors.append(hardwareElement('p', 'muted', 'Нет данных о выводах датчиков.'));

    const leds = byId('hardware-leds');
    leds.replaceChildren();
    for (const led of Array.isArray(snapshot.leds) ? snapshot.leds : []) {
      if (!led) continue;
      const card = hardwareElement('div', 'hardware-bus');
      const heading = hardwareElement('div', 'channel-heading');
      const valid = state.ioFresh && led.valid === true && typeof led.value === 'boolean';
      heading.append(
        hardwareElement('h3', 'channel-name', led.id || 'LED'),
        hardwareElement(
          'span',
          `badge ${valid ? (led.value ? 'state-on' : 'state-off') : 'state-unknown'}`,
          valid ? (led.value ? 'Включён' : 'Выключен') : 'Нет данных',
        ),
      );
      iconHeading(heading.querySelector('h3'), led.id || 'LED', 'led', true);
      card.append(heading, hardwareElement('p', 'hint', gpioLabel(led.gpio)));
      if (errorMessage(led.error)) card.append(hardwareElement('p', 'field-error', led.error));
      leds.append(card);
    }
    if (!leds.children.length)
      leds.append(hardwareElement('p', 'muted', 'Нет данных о светодиодах.'));

    const pinMap = byId('hardware-pin-map');
    pinMap.replaceChildren();
    const directions = {
      input: 'Вход',
      output: 'Выход',
      'open-drain': 'Открытый сток',
      bus: 'Шина',
      'power-sense': 'Контроль питания',
      i2c: 'I²C',
      spi: 'SPI',
      uart: 'UART',
      usb: 'USB',
    };
    for (const pin of Array.isArray(snapshot.pinMap) ? snapshot.pinMap : []) {
      if (!pin) continue;
      const row = document.createElement('tr');
      row.append(
        hardwareElement('td', '', pin.name || '—'),
        hardwareElement('td', '', gpioLabel(pin.gpio)),
        hardwareElement('td', '', directions[pin.direction] || pin.direction || '—'),
      );
      pinMap.append(row);
    }
    if (!pinMap.children.length) {
      const cell = hardwareElement('td', 'muted', 'Нет данных о выводах.');
      cell.colSpan = 3;
      const row = document.createElement('tr');
      row.append(cell);
      pinMap.append(row);
    }
  }

  function scheduleHardwarePoll(delay = 1000) {
    if (state.ioTimer) window.clearTimeout(state.ioTimer);
    state.ioTimer = null;
    if (hardwareActive() && !state.ioActionBusy)
      state.ioTimer = window.setTimeout(pollHardware, delay);
  }

  /** @brief Sample only the visible hardware page; obsolete generations cannot refresh it. */
  async function pollHardware() {
    if (!hardwareActive() || state.ioPending || state.ioActionBusy) return;
    const generation = state.ioGeneration;
    const sessionVersion = state.sessionVersion;
    const request = (async () => {
      try {
        const snapshot = await api('/hardware');
        if (
          !hardwareActive() ||
          generation !== state.ioGeneration ||
          sessionVersion !== state.sessionVersion
        )
          return;
        state.ioSnapshot = snapshot;
        state.ioFresh = true;
        state.ioUncertainRelays.clear();
        const driverError = errorMessage(snapshot.error);
        byId('hardware-error').textContent = driverError;
        byId('hardware-error').hidden = !driverError;
        text(
          'hardware-live-status',
          snapshot.initialized === false
            ? 'Оборудование не готово'
            : `Обновлено ${new Date().toLocaleTimeString('ru-RU')}`,
        );
        byId('hardware-live-status').className =
          `badge ${driverError || snapshot.initialized === false ? 'state-unknown' : 'state-on'}`;
        renderHardware();
      } catch (error) {
        if (
          !hardwareActive() ||
          generation !== state.ioGeneration ||
          sessionVersion !== state.sessionVersion
        )
          return;
        state.ioFresh = false;
        byId('hardware-error').textContent = error.message;
        byId('hardware-error').hidden = false;
        text('hardware-live-status', 'Нет связи');
        byId('hardware-live-status').className = 'badge state-error';
        renderHardware();
      }
    })();
    state.ioPending = request;
    try {
      await request;
    } finally {
      if (state.ioPending === request) state.ioPending = null;
      scheduleHardwarePoll();
    }
  }

  function updateHardwarePolling() {
    state.ioGeneration++;
    if (state.ioTimer) window.clearTimeout(state.ioTimer);
    state.ioTimer = null;
    state.ioFresh = false;
    if (hardwareActive()) {
      text('hardware-live-status', 'Обновление…');
      byId('hardware-live-status').className = 'badge';
      renderHardware();
      if (!state.ioPending && !state.ioActionBusy) pollHardware();
    }
  }

  /**
   * @brief Serialize an explicit hardware command after the outstanding read.
   * @note A failed acknowledgement makes the affected output unknown until a fresh read succeeds.
   */
  async function hardwareCommand(id, operation) {
    if (!hardwareActive() || state.ioActionBusy) return;
    const sessionVersion = state.sessionVersion;
    state.ioActionBusy = true;
    state.ioActionId = id;
    if (state.ioTimer) window.clearTimeout(state.ioTimer);
    state.ioTimer = null;
    renderHardware();
    try {
      if (state.ioPending) await state.ioPending;
      if (!hardwareActive() || sessionVersion !== state.sessionVersion) return;
      await operation(sessionVersion);
    } catch (error) {
      if (state.authenticated && sessionVersion === state.sessionVersion) {
        if (id !== 'scan') {
          state.ioRelayErrors.set(id, `Команда не подтверждена: ${error.message}`);
          state.ioUncertainRelays.add(id);
        }
        hardwareActionNotice(error.message, 'error');
      }
    } finally {
      if (sessionVersion === state.sessionVersion) {
        state.ioActionBusy = false;
        state.ioActionId = '';
        renderHardware();
        scheduleHardwarePoll(0);
      }
    }
  }

  function setRelay(id) {
    const relay = state.ioSnapshot?.relays?.find((channel) => channel.id === id);
    if (
      !state.ioFresh ||
      !relay ||
      relay.valid !== true ||
      typeof relay.value !== 'boolean' ||
      state.ioUncertainRelays.has(id)
    )
      return;
    const target = !relay.value;
    hardwareCommand(id, async (sessionVersion) => {
      const response = await post('/hardware/relay', { id, value: target });
      if (!state.authenticated || sessionVersion !== state.sessionVersion) return;
      if (response.ok !== true || !response.hardware)
        throw new Error('Контроллер не подтвердил изменение выхода.');
      state.ioSnapshot = response.hardware;
      state.ioFresh = hardwareActive();
      state.ioRelayErrors.delete(id);
      state.ioUncertainRelays.delete(id);
      hardwareActionNotice(
        `Команда для ${id} подтверждена: ${target ? 'включить' : 'выключить'}.`,
        'success',
      );
    });
  }

  return {
    hardwareActionNotice,
    hardwareActive,
    renderChannels,
    renderI2c,
    renderHardware,
    scheduleHardwarePoll,
    pollHardware,
    updateHardwarePolling,
    hardwareCommand,
    setRelay,
  };
}
