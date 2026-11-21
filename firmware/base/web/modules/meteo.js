/**
 * @file meteo.js
 * @brief Meteo sensor cards, OneWire discovery and validation.
 */
export function createMeteoUI(context) {
  const { controllers, state } = context;
  const controllersActive = (...args) => context.controllersActive(...args);
  const createControllerVisual = (...args) => context.createControllerVisual(...args);
  const dirty = (...args) => context.dirty(...args);
  const errorMessage = (...args) => context.errorMessage(...args);
  const hardwareElement = (...args) => context.hardwareElement(...args);
  const otherPortClaims = (...args) => context.otherPortClaims(...args);
  const ownerLabel = (...args) => context.ownerLabel(...args);
  const post = (...args) => context.post(...args);
  const renderControllers = (...args) => context.renderControllers(...args);
  const renderControllerVisual = (...args) => context.renderControllerVisual(...args);
  const scheduleControllersPoll = (...args) => context.scheduleControllersPoll(...args);

  const validMeteoAddress = (address) =>
    typeof address === 'string' && /^28[0-9a-f]{14}$/.test(address);

  function meteoPortBlockers(portId, item, model, claims) {
    return otherPortClaims(portId, model, item.id, claims).filter(
      (claim) =>
        item.sensorType !== 'onewire' ||
        claim.controllerId !== model.id ||
        claim.sensorType !== 'onewire',
    );
  }

  function meteoAddressOwners(portId, address, item, model, claims) {
    return otherPortClaims(portId, model, item.id, claims).filter(
      (claim) =>
        claim.controllerId !== model.id ||
        claim.sensorType !== 'onewire' ||
        claim.address === address,
    );
  }

  function newMeteoBinding(model, claims) {
    const ports = model.snapshot?.ports.sensors || [];
    const free = ports.find((portId) => !claims.some((claim) => claim.portId === portId));
    if (free) return { portId: free, sensorType: 'dht22', address: '' };
    const shared = ports.find(
      (portId) =>
        !meteoPortBlockers(portId, { id: '', sensorType: 'onewire' }, model, claims).length,
    );
    return shared ? { portId: shared, sensorType: 'onewire', address: '' } : null;
  }

  function meteoOptions(select, entries, selected, placeholder) {
    const signature = JSON.stringify([entries, selected, placeholder]);
    if (select.dataset.options !== signature) {
      select.replaceChildren(new Option(placeholder, ''));
      for (const entry of entries) {
        const option = new Option(entry.label, entry.id);
        option.disabled = entry.disabled;
        select.add(option);
      }
      select.dataset.options = signature;
    }
    if (select.value !== selected) select.value = selected;
  }

  function createMeteoCard(model, item) {
    const card = hardwareElement('article', 'socket-card meteo-card');
    card.dataset.meteoId = item.id;
    const visual = createControllerVisual({ interactive: false });
    visual.classList.add('controller-visual-meteo');
    visual.dataset.meteoVisual = item.id;
    const heading = hardwareElement('div', 'socket-card-header');
    const remove = hardwareElement('button', 'socket-remove', 'Удалить');
    remove.type = 'button';
    remove.dataset.meteoRemove = item.id;
    remove.addEventListener('click', () => {
      if (state.controllersBusy) return;
      model.draft = model.draft.filter((draft) => draft.id !== item.id);
      dirty(model.dirtyKey);
      renderControllers();
    });
    heading.append(hardwareElement('span', 'socket-number'), remove);
    card.append(visual, heading);
    const addressField = hardwareElement('div', 'meteo-address-field');
    addressField.dataset.meteoAddressField = '';
    for (const [field, label, tag] of [
      ['name', 'Название', 'input'],
      ['sensorType', 'Тип датчика', 'select'],
      ['portId', 'Порт датчика', 'select'],
      ['address', 'Датчик DS18B20 · серийный номер', 'select'],
    ]) {
      const input = document.createElement(tag);
      input.id = `meteo-${item.id}-${field}`;
      input.dataset.meteoField = field;
      if (field === 'name') {
        input.maxLength = 64;
        input.required = true;
        input.autocomplete = 'off';
      }
      if (field === 'sensorType') {
        input.add(new Option('DHT22', 'dht22'));
        input.add(new Option('OneWire · DS18B20', 'onewire'));
      }
      const caption = hardwareElement('label', '', label);
      caption.htmlFor = input.id;
      input.addEventListener(field === 'name' ? 'input' : 'change', () => {
        const draft = model.draft.find((entry) => entry.id === item.id);
        if (!draft) return;
        const changed = draft[field] !== input.value;
        draft[field] = input.value;
        if (changed && ['sensorType', 'portId'].includes(field)) draft.address = '';
        dirty(model.dirtyKey);
        renderControllers();
        if (changed && ['sensorType', 'portId'].includes(field) && draft.sensorType === 'onewire')
          requestMeteoScan(draft.portId, draft.id);
      });
      (field === 'address' ? addressField : card).append(caption, input);
    }
    const scan = hardwareElement('button', 'text-button meteo-scan', 'Найти датчики');
    scan.type = 'button';
    scan.dataset.meteoScan = item.id;
    scan.addEventListener('click', () => {
      const draft = model.draft.find((entry) => entry.id === item.id);
      if (draft) requestMeteoScan(draft.portId, draft.id);
    });
    const scanStatus = hardwareElement('p', 'hint meteo-scan-status');
    scanStatus.dataset.meteoScanStatus = '';
    scanStatus.setAttribute('role', 'status');
    addressField.append(scan, scanStatus);
    card.append(addressField);
    const readings = hardwareElement('div', 'meteo-readings');
    for (const [key, label] of [
      ['temperature', 'Температура'],
      ['humidity', 'Влажность'],
    ]) {
      const cell = hardwareElement('div', `meteo-reading meteo-${key}`);
      const reading = hardwareElement('strong', '', 'Нет данных');
      reading.dataset[key === 'temperature' ? 'meteoTemperature' : 'meteoHumidity'] = '';
      cell.append(hardwareElement('span', '', label), reading);
      readings.append(cell);
    }
    const status = hardwareElement('span', 'badge state-unknown', 'Нет данных');
    status.dataset.meteoStatus = '';
    const age = hardwareElement('p', 'hint');
    age.dataset.meteoAge = '';
    const error = hardwareElement('p', 'field-error');
    error.setAttribute('role', 'status');
    visual.append(readings, status, age);
    card.append(hardwareElement('p', 'socket-binding-state'), error);
    return card;
  }

  function renderMeteoCard(card, model, item, claims) {
    const action = state.controllersAction;
    const busy = state.controllersBusy && ['save', 'reload'].includes(action?.kind);
    card.querySelector('[data-meteo-field="sensorType"]').value = item.sensorType;
    const ports = model.snapshot?.ports.sensors || [];
    const entries = ports.map((portId) => {
      const owners = otherPortClaims(portId, model, item.id, claims);
      const blocked = meteoPortBlockers(portId, item, model, claims);
      const labels = [...new Set(owners.map(ownerLabel))];
      return {
        id: portId,
        label: labels.length
          ? `${portId} · ${blocked.length ? '' : 'OneWire · '}${labels.join('; ')}`
          : portId,
        disabled: blocked.length > 0,
      };
    });
    if (item.portId && !ports.includes(item.portId))
      entries.push({ id: item.portId, label: `${item.portId} · недоступен`, disabled: true });
    meteoOptions(
      card.querySelector('[data-meteo-field="portId"]'),
      entries,
      item.portId,
      'Выберите порт',
    );
    const scan = state.meteoScans.get(item.portId);
    const queued = state.meteoScanQueue.has(item.portId);
    const knownDevices = [
      ...(scan?.devices || []),
      ...(model.snapshot?.items || [])
        .filter((entry) => entry.portId === item.portId)
        .flatMap((entry) => entry.devices || []),
    ];
    const discovered = new Set(
      knownDevices.map((device) => device.address).filter(validMeteoAddress),
    );
    const addresses = new Set([
      ...discovered,
      ...claims
        .filter((claim) => claim.portId === item.portId)
        .map((claim) => claim.address)
        .filter(validMeteoAddress),
    ]);
    if (item.address) addresses.add(item.address);
    const serials = Array.from(addresses)
      .sort()
      .map((address) => {
        const owners = meteoAddressOwners(item.portId, address, item, model, claims);
        const labels = [...new Set(owners.map(ownerLabel))];
        return {
          id: address,
          label: `${address}${labels.length ? ` · ${labels.join('; ')}` : discovered.has(address) ? '' : ' · сейчас не найден'}`,
          disabled: owners.length > 0,
        };
      });
    meteoOptions(
      card.querySelector('[data-meteo-field="address"]'),
      serials,
      item.address,
      'Выберите DS18B20',
    );
    card.querySelector('[data-meteo-address-field]').hidden = item.sensorType !== 'onewire';
    const scanButton = card.querySelector('[data-meteo-scan]');
    scanButton.disabled =
      state.controllersBusy ||
      !ports.includes(item.portId) ||
      meteoPortBlockers(item.portId, item, model, claims).length > 0 ||
      scan?.busy === true ||
      queued;
    scanButton.textContent =
      scan?.busy || queued ? 'Поиск…' : scan ? 'Повторить поиск' : 'Найти датчики';
    scanButton.setAttribute('aria-busy', String(scan?.busy === true || queued));
    const scanStatus = card.querySelector('[data-meteo-scan-status]');
    scanStatus.textContent = queued
      ? 'Поиск поставлен в очередь…'
      : scan?.busy
        ? 'Идёт поиск DS18B20 на выбранном порту…'
        : scan?.error
          ? scan.error
          : scan?.complete
            ? scan.devices.length
              ? `Найдено датчиков: ${scan.devices.length}. Выберите серийный номер.`
              : 'Датчики не найдены. Проверьте подключение и повторите поиск.'
            : 'Найдите подключённые датчики, затем выберите конкретный DS18B20.';
    scanStatus.classList.toggle('error-text', Boolean(scan?.error));
    for (const input of card.querySelectorAll('input, select')) input.disabled = busy;
    const saved = model.snapshot?.items.find((entry) => entry.id === item.id);
    const bound =
      saved && ['portId', 'sensorType', 'address'].every((field) => saved[field] === item[field]);
    const age = bound && Number.isFinite(saved.ageMs) && saved.ageMs >= 0 ? saved.ageMs : null;
    const valid =
      model.fresh &&
      bound &&
      model.snapshot.enabled &&
      saved.available === true &&
      (age === null || age <= 15000);
    const temperature =
      valid && Number.isFinite(saved.temperatureC)
        ? `${saved.temperatureC.toFixed(1)} °C`
        : 'Нет данных';
    const humidity =
      valid && Number.isFinite(saved.humidityPct)
        ? `${saved.humidityPct.toFixed(1)} %`
        : 'Нет данных';
    card.querySelector('[data-meteo-temperature]').textContent = temperature;
    card.querySelector('[data-meteo-humidity]').textContent = humidity;
    card
      .querySelector('[data-meteo-temperature]')
      .classList.toggle('has-value', Boolean(valid && Number.isFinite(saved.temperatureC)));
    card
      .querySelector('[data-meteo-humidity]')
      .classList.toggle('has-value', Boolean(valid && Number.isFinite(saved.humidityPct)));
    card.querySelector('.meteo-humidity').hidden = item.sensorType !== 'dht22';
    const badge = card.querySelector('[data-meteo-status]');
    badge.textContent = !bound
      ? 'Привязка не сохранена'
      : !model.snapshot.enabled
        ? 'Модуль выключен'
        : valid && Number.isFinite(saved.temperatureC)
          ? 'Данные получены'
          : 'Нет данных';
    badge.className = `badge ${valid && Number.isFinite(saved.temperatureC) ? 'state-on' : 'state-unknown'}`;
    card.querySelector('[data-meteo-age]').textContent =
      bound && age !== null
        ? `Последнее измерение: ${Math.floor(age / 1000)} с назад${age > 15000 ? ' · устарело' : ''}`
        : 'Время последнего измерения неизвестно';
    const visualState =
      !model.fresh || !bound
        ? 'unknown'
        : !model.snapshot.enabled
          ? 'off'
          : valid && Number.isFinite(saved.temperatureC)
            ? 'on'
            : errorMessage(saved.error)
              ? 'error'
              : 'unknown';
    renderControllerVisual(card.querySelector('[data-meteo-visual]'), {
      icon: item.sensorType === 'onewire' ? 'onewire' : 'dht22',
      tone: 'sensor',
      state: visualState,
      pending: false,
      caption: item.sensorType === 'onewire' ? 'DS18B20' : 'DHT22',
      detail: '',
      number: `#${model.draft.findIndex((entry) => entry.id === item.id) + 1}`,
      label: `${item.name || 'Датчик'}: ${temperature}`,
    });
    card.querySelector('.socket-binding-state').textContent =
      item.sensorType === 'onewire'
        ? `DS18B20 · ${item.address || 'серийный номер не выбран'}`
        : 'DHT22 · температура и влажность';
    const error = card.querySelector('.field-error');
    error.textContent = [model.errors.get(item.id), errorMessage(bound && saved.error)]
      .filter(Boolean)
      .join(' · ');
    error.hidden = !error.textContent;
  }

  function requestMeteoScan(portId, itemId) {
    const model = controllers.find((entry) => entry.isMeteo);
    if (!controllersActive() || !model.loaded || !model.snapshot.ports.sensors.includes(portId))
      return;
    state.meteoScanQueue.set(portId, itemId);
    renderControllers();
    scheduleControllersPoll(0);
  }

  /** @brief Advance one queued or running OneWire scan inside the controller request queue. */
  async function pollMeteoScan(sessionVersion, generation) {
    if (state.controllersView !== 'meteo' || !controllersActive() || state.controllersBusy) return;
    const model = controllers.find((entry) => entry.isMeteo);
    const ports = new Set(
      model.draft.filter((item) => item.sensorType === 'onewire').map((item) => item.portId),
    );
    let portId = Array.from(state.meteoScanQueue.keys()).find((id) => ports.has(id));
    const refresh = Boolean(portId);
    if (!portId)
      portId = Array.from(state.meteoScans).find(([id, scan]) => ports.has(id) && scan.busy)?.[0];
    if (!portId) return;
    const previous = state.meteoScans.get(portId);
    const itemId = refresh ? state.meteoScanQueue.get(portId) : previous.itemId;
    state.meteoScanQueue.delete(portId);
    state.meteoScans.set(portId, {
      ...previous,
      itemId,
      busy: true,
      error: '',
      devices: previous?.devices || [],
    });
    renderControllers();
    try {
      const response = await post('/controllers/meteo/scan', {
        portId,
        itemId,
        baseRevision: model.baseRevision,
        refresh,
      });
      if (
        !controllersActive() ||
        sessionVersion !== state.sessionVersion ||
        generation !== state.controllersGeneration
      )
        return;
      if (
        response.ok !== true ||
        response.portId !== portId ||
        typeof response.busy !== 'boolean' ||
        typeof response.complete !== 'boolean' ||
        !Array.isArray(response.devices)
      )
        throw new Error('Контроллер вернул неверный ответ поиска датчиков.');
      state.meteoScans.delete(portId);
      state.meteoScans.set(portId, {
        ...response,
        itemId,
        devices: response.devices.filter((device) => validMeteoAddress(device?.address)),
      });
    } catch (error) {
      if (state.authenticated && sessionVersion === state.sessionVersion)
        state.meteoScans.set(portId, {
          ...previous,
          itemId,
          busy: false,
          complete: false,
          devices: previous?.devices || [],
          error: error.message,
        });
    }
    if (state.authenticated && sessionVersion === state.sessionVersion) renderControllers();
  }

  function validateMeteoSettings(model, items, claims) {
    for (const item of items) {
      if (!model.snapshot.ports.sensors.includes(item.portId))
        throw new Error('Выберите доступный порт для каждого датчика.');
      if (!['dht22', 'onewire'].includes(item.sensorType))
        throw new Error('Выберите DHT22 или OneWire.');
      if (item.sensorType === 'dht22' && item.address !== '')
        throw new Error('У DHT22 не должно быть серийного номера OneWire.');
      if (item.sensorType === 'onewire' && !validMeteoAddress(item.address))
        throw new Error('Найдите и выберите конкретный DS18B20 по серийному номеру.');
      claims.push({
        portId: item.portId,
        controllerId: model.id,
        ownerId: item.id,
        name: item.name,
        sensorType: item.sensorType,
        address: item.address,
      });
    }
    for (const item of items) {
      const blockers = meteoPortBlockers(item.portId, item, model, claims);
      if (blockers.length)
        throw new Error(`Порт ${item.portId} занят: ${blockers.map(ownerLabel).join('; ')}.`);
      const duplicate =
        item.sensorType === 'onewire'
          ? meteoAddressOwners(item.portId, item.address, item, model, claims)
          : [];
      if (duplicate.length)
        throw new Error(
          `DS18B20 ${item.address} уже назначен: ${duplicate.map(ownerLabel).join('; ')}.`,
        );
    }
  }

  return {
    validMeteoAddress,
    meteoPortBlockers,
    meteoAddressOwners,
    newMeteoBinding,
    meteoOptions,
    createMeteoCard,
    renderMeteoCard,
    requestMeteoScan,
    pollMeteoScan,
    validateMeteoSettings,
  };
}
