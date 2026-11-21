/**
 * @file thermostats.js
 * @brief Thermostat settings, minimum-cycle protection and live regulation display.
 */
export function createThermostatsUI(context) {
  const { controllers, state } = context;
  const controllerOptions = (...args) => context.controllerOptions(...args);
  const controllerSettings = (...args) => context.controllerSettings(...args);
  const controllersActive = (...args) => context.controllersActive(...args);
  const createControllerVisual = (...args) => context.createControllerVisual(...args);
  const dirty = (...args) => context.dirty(...args);
  const errorMessage = (...args) => context.errorMessage(...args);
  const hardwareElement = (...args) => context.hardwareElement(...args);
  const meteoOptions = (...args) => context.meteoOptions(...args);
  const otherPortClaims = (...args) => context.otherPortClaims(...args);
  const ownerLabel = (...args) => context.ownerLabel(...args);
  const renderControllers = (...args) => context.renderControllers(...args);
  const renderControllerVisual = (...args) => context.renderControllerVisual(...args);
  const setThermostatEnabled = (...args) => context.setThermostatEnabled(...args);

  function thermostatNumber(value) {
    return typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  }

  function thermostatParametersValid(item) {
    return (
      ['heating', 'cooling'].includes(item.mode) &&
      Number.isFinite(item.setpointC) &&
      item.setpointC >= -55 &&
      item.setpointC <= 125 &&
      Number.isInteger(item.hysteresisC) &&
      item.hysteresisC >= 1 &&
      item.hysteresisC <= 20
    );
  }

  function thermostatThresholds(item) {
    const parameters = {
      ...item,
      setpointC: thermostatNumber(item.setpointC),
      hysteresisC: thermostatNumber(item.hysteresisC),
    };
    if (!thermostatParametersValid(parameters))
      return 'Укажите уставку от −55 до 125 °C и выберите гистерезис от 1 до 20 °C.';
    const { setpointC: target, hysteresisC: gap } = parameters;
    return item.mode === 'heating'
      ? `Включение при T ≤ ${(target - gap).toFixed(1)} °C; выключение при T ≥ ${target.toFixed(1)} °C.`
      : `Включение при T ≥ ${(target + gap).toFixed(1)} °C; выключение при T ≤ ${target.toFixed(1)} °C.`;
  }

  function thermostatRowSaved(model, item, saved) {
    if (!saved) return false;
    const draft = controllerSettings([item], model)[0];
    return Object.keys(draft).every((key) => draft[key] === saved[key]);
  }

  function createThermostatCard(model, item) {
    const card = hardwareElement('article', 'socket-card thermostat-card');
    card.dataset.thermostatId = item.id;
    const heading = hardwareElement('div', 'socket-card-header');
    const remove = hardwareElement('button', 'socket-remove', 'Удалить');
    remove.type = 'button';
    remove.dataset.thermostatRemove = item.id;
    remove.addEventListener('click', () => {
      if (state.controllersBusy) return;
      model.draft = model.draft.filter((draft) => draft.id !== item.id);
      dirty(model.dirtyKey);
      renderControllers();
    });
    const toggle = createControllerVisual({
      interactive: true,
      onActivate: () => setThermostatEnabled(model, item.id),
    });
    toggle.classList.add('thermostat-visual');
    toggle.dataset.thermostatEnabled = item.id;
    const controls = hardwareElement('div', 'thermostat-header-controls');
    controls.append(remove);
    heading.append(hardwareElement('span', 'socket-number'), controls);
    card.append(toggle, heading);
    const enabledHint = hardwareElement('p', 'hint thermostat-enabled-hint');
    enabledHint.id = `thermostat-${item.id}-enabled-hint`;
    enabledHint.dataset.thermostatEnabledHint = '';
    toggle.setAttribute('aria-describedby', enabledHint.id);
    card.append(enabledHint);
    const parametersRow = hardwareElement('div', 'thermostat-parameters-row');
    for (const [field, label, tag] of [
      ['name', 'Название', 'input'],
      ['meteoId', 'Источник температуры «Метео»', 'select'],
      ['relayId', 'Релейный выход', 'select'],
      ['inputId', 'Вход кнопки включения (необязательно)', 'select'],
      ['mode', 'Режим', 'select'],
      ['setpointC', 'Уставка, °C', 'input'],
      ['hysteresisC', 'Гистерезис', 'select'],
    ]) {
      const input = document.createElement(tag);
      input.id = `thermostat-${item.id}-${field}`;
      input.dataset.thermostatField = field;
      input.required = field !== 'inputId';
      if (field === 'name') {
        input.maxLength = 64;
        input.autocomplete = 'off';
      }
      if (field === 'mode') {
        input.add(new Option('Нагрев', 'heating'));
        input.add(new Option('Охлаждение', 'cooling'));
      }
      if (field === 'setpointC') {
        input.type = 'number';
        input.min = '-55';
        input.max = '125';
        input.step = '0.1';
        input.inputMode = 'decimal';
      }
      if (field === 'hysteresisC')
        for (let degrees = 1; degrees <= 20; degrees++)
          input.add(new Option(`${degrees} °C`, String(degrees)));
      const caption = hardwareElement('label', '', label);
      caption.htmlFor = input.id;
      input.addEventListener(tag === 'input' ? 'input' : 'change', () => {
        const draft = model.draft.find((entry) => entry.id === item.id);
        if (!draft) return;
        draft[field] = input.value;
        dirty(model.dirtyKey);
        renderControllers();
      });
      if (field === 'setpointC' || field === 'hysteresisC') {
        const parameter = hardwareElement('div', 'thermostat-parameter-field');
        parameter.append(caption, input);
        parametersRow.append(parameter);
        if (field === 'setpointC') card.append(parametersRow);
      } else {
        card.append(caption, input);
      }
      if (field === 'meteoId') {
        const hint = hardwareElement('p', 'hint');
        hint.dataset.thermostatSourceHint = '';
        card.append(hint);
      }
      if (field === 'inputId') {
        const inputStatus = hardwareElement('p', 'hint thermostat-input-status');
        inputStatus.dataset.thermostatInputStatus = '';
        card.append(inputStatus);
      }
    }
    const thresholds = hardwareElement('p', 'notice thermostat-thresholds');
    thresholds.dataset.thermostatThresholds = '';
    const readings = hardwareElement(
      'span',
      'meteo-readings controller-visual-readings thermostat-visual-readings',
    );
    for (const [field, label] of [
      ['temperature', 'Температура'],
      ['target', 'Уставка'],
    ]) {
      const cell = hardwareElement('span', 'meteo-reading');
      const reading = hardwareElement('strong', '', 'Нет данных');
      reading.dataset[field === 'temperature' ? 'thermostatTemperature' : 'thermostatTarget'] = '';
      cell.append(hardwareElement('span', '', label), reading);
      readings.append(cell);
    }
    const status = hardwareElement('span', 'badge state-unknown', 'Нет данных');
    status.dataset.thermostatStatus = '';
    const output = hardwareElement('p', 'socket-binding-state');
    output.dataset.thermostatOutput = '';
    const error = hardwareElement('p', 'field-error');
    error.setAttribute('role', 'status');
    toggle.append(readings);
    card.append(thresholds, status, output, error);
    return card;
  }

  /**
   * @brief Render settings separately from confirmed thermostat demand and enabled state.
   * @note An unavailable saved source never falls back to a cached Meteo value for that source.
   */
  function renderThermostatCard(card, model, item, claims) {
    const meteo = controllers.find((entry) => entry.isMeteo);
    const sources = meteo.snapshot?.items || [];
    const sourceOptions = sources.map((source) => ({
      id: source.id,
      label: `${source.name} · ${source.portId} · ${source.sensorType === 'onewire' ? `DS18B20 ${source.address}` : 'DHT22'}`,
      disabled: false,
    }));
    const source = sources.find((entry) => entry.id === item.meteoId);
    if (item.meteoId && !source)
      sourceOptions.push({
        id: item.meteoId,
        label: `${item.meteoId} · источник не найден`,
        disabled: true,
      });
    meteoOptions(
      card.querySelector('[data-thermostat-field="meteoId"]'),
      sourceOptions,
      item.meteoId,
      'Выберите датчик «Метео»',
    );
    card.querySelector('[data-thermostat-source-hint]').textContent =
      item.meteoId && !source
        ? 'Источник удалён или недоступен. Привязка сохранена; выберите существующий датчик для восстановления автоматики.'
        : !sources.length
          ? 'Сначала добавьте и сохраните датчик во вкладке «Метео».'
          : 'Один источник температуры можно выбрать для нескольких термостатов.';
    controllerOptions(
      card.querySelector('[data-thermostat-field="relayId"]'),
      model.snapshot?.ports.relays || [],
      item.relayId,
      model,
      item.id,
      claims,
    );
    controllerOptions(
      card.querySelector('[data-thermostat-field="inputId"]'),
      model.snapshot?.ports.inputs || [],
      item.inputId,
      model,
      item.id,
      claims,
      true,
    );
    for (const field of ['mode', 'setpointC', 'hysteresisC']) {
      const input = card.querySelector(`[data-thermostat-field="${field}"]`);
      if (input.value !== String(item[field])) input.value = item[field];
    }
    const action = state.controllersAction;
    for (const input of card.querySelectorAll('input, select'))
      input.disabled = state.controllersBusy && ['save', 'reload'].includes(action?.kind);
    const saved = model.snapshot?.items.find((entry) => entry.id === item.id);
    const parameters = {
      ...item,
      setpointC: thermostatNumber(item.setpointC),
      hysteresisC: thermostatNumber(item.hysteresisC),
    };
    const bound =
      saved &&
      ['meteoId', 'relayId', 'inputId', 'mode', 'setpointC', 'hysteresisC'].every(
        (field) => saved[field] === parameters[field],
      );
    const rowSaved = thermostatRowSaved(model, item, saved);
    const flagKnown =
      model.fresh && saved && typeof saved.enabled === 'boolean' && !model.uncertain.has(item.id);
    const pending =
      action?.controllerId === model.id && action.kind === 'item-enabled' && action.id === item.id;
    const toggle = card.querySelector('[data-thermostat-enabled]');
    card.querySelector('[data-thermostat-enabled-hint]').textContent = !rowSaved
      ? 'Сохраните настройки'
      : pending
        ? 'Сохраняется…'
        : !flagKnown
          ? 'Нет подтверждённого состояния'
          : `${saved.enabled ? 'Включён' : 'Выключен'}${saved.inhibited ? ' · выход заблокирован после ошибки' : saved.enabled && !model.snapshot.enabled ? ' · общий модуль выключен' : ''}`;
    const inputBound = saved && saved.inputId === item.inputId;
    const inputError = errorMessage(inputBound && saved.inputError);
    const inputWarning = Boolean(
      item.inputId && inputBound && model.fresh && (saved.inputAvailable === false || inputError),
    );
    const inputStatus = card.querySelector('[data-thermostat-input-status]');
    inputStatus.className = `${inputWarning ? 'notice warning' : 'hint'} thermostat-input-status`;
    inputStatus.textContent = !item.inputId
      ? 'Кнопка не назначена'
      : !inputBound
        ? 'Привязка кнопки применится после сохранения'
        : `${item.inputId} · ${model.fresh && saved.inputAvailable === true && typeof saved.inputLevel === 'boolean' ? (saved.inputLevel ? 'HIGH' : 'LOW') : 'Нет данных'}${inputError ? ` · ${inputError}` : ''}`;
    const relayKnown =
      model.fresh && saved && saved.relayId === item.relayId && typeof saved.actual === 'boolean';
    const sensorKnown =
      model.fresh &&
      saved &&
      saved.meteoId === item.meteoId &&
      saved.sensorAvailable === true &&
      Number.isFinite(saved.temperatureC);
    const sourceKnown =
      (!saved || saved.meteoId !== item.meteoId) &&
      meteo.fresh &&
      meteo.snapshot?.enabled === true &&
      source?.available === true &&
      Number.isFinite(source.temperatureC);
    const temperature = sensorKnown ? saved.temperatureC : sourceKnown ? source.temperatureC : null;
    card.querySelector('[data-thermostat-temperature]').textContent = Number.isFinite(temperature)
      ? `${temperature.toFixed(1)} °C`
      : 'Нет данных';
    card.querySelector('[data-thermostat-target]').textContent = Number.isFinite(
      parameters.setpointC,
    )
      ? `${parameters.setpointC.toFixed(1)} °C`
      : 'Не задана';
    card
      .querySelector('[data-thermostat-temperature]')
      .classList.toggle('has-value', Number.isFinite(temperature));
    card
      .querySelector('[data-thermostat-target]')
      .classList.toggle('has-value', Number.isFinite(parameters.setpointC));
    card.querySelector('[data-thermostat-thresholds]').textContent =
      `${bound ? '' : 'После сохранения: '}${thermostatThresholds(item)} Между порогами сохраняется предыдущее состояние.`;
    const status = card.querySelector('[data-thermostat-status]');
    let label = 'Нет данных',
      kind = 'unknown';
    if (!bound) label = 'Настройки не сохранены';
    else if (!model.fresh) label = 'Нет данных';
    else if (saved.inhibited === true) {
      label = 'Выход заблокирован после ошибки';
      kind = 'error';
    } else if (!saved.enabled) {
      label = 'Выключен';
      kind = 'off';
    } else if (!model.snapshot.enabled) label = 'Модуль выключен';
    else if (saved.sensorAvailable !== true)
      label = `Датчик недоступен · ${relayKnown && !saved.actual ? 'выход выключен' : 'нет подтверждения отключения'}`;
    else if (!relayKnown) label = 'Нет данных о выходе';
    else if (
      saved.available !== true ||
      (typeof saved.state === 'boolean' && saved.state !== saved.actual)
    ) {
      label = 'Ошибка управления выходом';
      kind = 'error';
    } else if (saved.actual) {
      label = item.mode === 'heating' ? 'Нагрев' : 'Охлаждение';
      kind = 'on';
    } else {
      label = 'Ожидание';
      kind = 'off';
    }
    if (bound && model.fresh && saved?.holdRemainingSeconds > 0)
      label += ` · минимум ${saved.holdReason === 'minimum_on' ? 'ON' : 'OFF'}: ${saved.holdRemainingSeconds} с`;
    if (bound && saved?.usingCachedTemperature) label += ' · последнее свежее измерение';
    status.textContent = label;
    status.className = `badge thermostat-status state-${kind}`;
    const visualMode = bound ? saved.mode : item.mode;
    renderControllerVisual(toggle, {
      icon: visualMode,
      tone: visualMode,
      state: kind,
      pending,
      disabled: !rowSaved || !flagKnown || state.controllersBusy || !controllersActive(),
      pressed: flagKnown ? saved.enabled : 'mixed',
      label: pending
        ? `${item.name}: сохранение включения термостата`
        : `${saved?.enabled ? 'Выключить' : 'Включить'} термостат ${item.name}`,
      caption: label,
      detail: !rowSaved
        ? 'Сохраните настройки для управления'
        : !flagKnown
          ? 'Нет подтверждённого состояния'
          : pending
            ? 'Ожидается подтверждение контроллера'
            : `${saved.enabled ? 'Автоматика включена' : 'Автоматика выключена'} · нажмите для переключения`,
      number: `#${model.draft.findIndex((entry) => entry.id === item.id) + 1}`,
    });
    card.classList.toggle(
      'socket-on',
      Boolean(
        bound &&
        relayKnown &&
        saved.actual &&
        saved.enabled &&
        !saved.inhibited &&
        model.snapshot.enabled,
      ),
    );
    card.querySelector('[data-thermostat-output]').textContent =
      `Реле ${item.relayId || 'не выбрано'}: ${relayKnown ? (saved.actual ? 'включено' : 'выключено') : 'нет данных'}${saved && !bound ? ' · по сохранённым настройкам' : ''}`;
    const error = card.querySelector('.field-error');
    const activeError =
      saved &&
      (saved.inhibited ||
        (model.snapshot.enabled && saved.enabled) ||
        (relayKnown && saved.actual));
    error.textContent = [model.errors.get(item.id), errorMessage(activeError && saved.error)]
      .filter(Boolean)
      .join(' · ');
    error.hidden = !error.textContent;
  }

  function validateThermostatSettings(model, items, claims) {
    const sources = controllers.find((entry) => entry.isMeteo).snapshot?.items || [];
    for (const item of items) {
      if (!thermostatParametersValid(item))
        throw new Error('Проверьте режим, уставку −55…125 °C и гистерезис 1…20 °C.');
      if (!model.snapshot.ports.relays.includes(item.relayId))
        throw new Error('Выберите доступное реле для каждого термостата.');
      if (item.inputId && !model.snapshot.ports.inputs.includes(item.inputId))
        throw new Error('Выберите доступный вход кнопки или «Без входа».');
      const previous = model.snapshot.items.find((entry) => entry.id === item.id);
      if (
        !item.meteoId ||
        (!sources.some((source) => source.id === item.meteoId) &&
          previous?.meteoId !== item.meteoId)
      )
        throw new Error('Выберите сохранённый источник температуры из «Метео».');
      for (const portId of [item.relayId, item.inputId].filter(Boolean))
        claims.push({ portId, controllerId: model.id, ownerId: item.id, name: item.name });
    }
    for (const item of items) {
      for (const portId of [item.relayId, item.inputId].filter(Boolean)) {
        const others = otherPortClaims(portId, model, item.id, claims);
        if (others.length)
          throw new Error(
            `Порт ${portId} занят: ${others.map(ownerLabel).join('; ')}. Сначала сохраните освобождение порта у его владельца.`,
          );
      }
    }
  }

  return {
    thermostatNumber,
    thermostatParametersValid,
    thermostatThresholds,
    thermostatRowSaved,
    createThermostatCard,
    renderThermostatCard,
    validateThermostatSettings,
  };
}
