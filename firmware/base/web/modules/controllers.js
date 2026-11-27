/**
 * @file controllers.js
 * @brief Controller resource claims, configuration and confirmed runtime state.
 */
export function createControllersUI(context) {
  const { controllers, state } = context;
  let noticeTimer = null;
  let noticeVersion = 0;
  const api = (...args) => context.api(...args);
  const byId = (...args) => context.byId(...args);
  const renderSecurity = (...args) => context.renderSecurity(...args);
  const securityCommonSettings = (...args) => context.securityCommonSettings(...args);
  const validateSecuritySettings = (...args) => context.validateSecuritySettings(...args);
  const createSecurityCard = (...args) => context.createSecurityCard(...args);
  const renderSecurityCard = (...args) => context.renderSecurityCard(...args);
  const controllerIcon = (...args) => context.controllerIcon(...args);
  const createControllerVisual = (...args) => context.createControllerVisual(...args);
  const createMeteoCard = (...args) => context.createMeteoCard(...args);
  const createThermostatCard = (...args) => context.createThermostatCard(...args);
  const dirty = (...args) => context.dirty(...args);
  const errorMessage = (...args) => context.errorMessage(...args);
  const hardwareElement = (...args) => context.hardwareElement(...args);
  const iconHeading = (...args) => context.iconHeading(...args);
  const newMeteoBinding = (...args) => context.newMeteoBinding(...args);
  const pollMeteoScan = (...args) => context.pollMeteoScan(...args);
  const post = (...args) => context.post(...args);
  const renderMeteoCard = (...args) => context.renderMeteoCard(...args);
  const renderThermostatCard = (...args) => context.renderThermostatCard(...args);
  const renderControllerVisual = (...args) => context.renderControllerVisual(...args);
  const thermostatNumber = (...args) => context.thermostatNumber(...args);
  const thermostatRowSaved = (...args) => context.thermostatRowSaved(...args);
  const validateMeteoSettings = (...args) => context.validateMeteoSettings(...args);
  const validateThermostatSettings = (...args) => context.validateThermostatSettings(...args);

  function controllersActive() {
    return state.authenticated && state.activeTab === 'controllers' && !document.hidden;
  }

  /** @brief Keep one current controller notification; successful confirmations expire. */
  function controllerNotice(model, message, kind = '') {
    const version = ++noticeVersion;
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    noticeTimer = null;
    for (const entry of controllers) {
      entry.notice = '';
      entry.noticeKind = '';
    }
    model.notice = message;
    model.noticeKind = kind;
    if (message && kind === 'success') {
      const sessionVersion = state.sessionVersion;
      noticeTimer = window.setTimeout(() => {
        if (version !== noticeVersion) return;
        noticeTimer = null;
        if (!state.authenticated || sessionVersion !== state.sessionVersion) return;
        model.notice = '';
        model.noticeKind = '';
        renderControllers();
      }, 4000);
    }
  }

  /** @brief Build a settings-only DTO; runtime readings and thermostat enabled flags stay out. */
  function controllerSettings(items, model) {
    if (model?.isSecurity)
      return items.map(({ id, name, inputId, sensorType, entryDelay }) => ({
        id,
        name,
        inputId,
        sensorType,
        entryDelay,
      }));
    if (model?.isMeteo)
      return items.map((item) => ({
        id: item.id,
        name: item.name,
        portId: item.portId,
        sensorType: item.sensorType,
        address: item.address,
      }));
    if (model?.isIrrigation)
      return items.map(({ id, name, relayId, tankId = '', days, startTime, durationMinutes }) => ({
        id,
        name,
        relayId,
        tankId,
        days: [...days],
        startTime,
        durationMinutes: Number(durationMinutes),
      }));
    if (model?.isTank)
      return items.map(({ id, name, pumpRelayId, valveRelayId, levelInputs, fillLevel }) => ({
        id,
        name,
        pumpRelayId: pumpRelayId || '',
        valveRelayId: valveRelayId || '',
        levelInputs: [...levelInputs],
        fillLevel: Number(fillLevel),
      }));
    if (model?.isThermostat)
      return items.map((item) => ({
        id: item.id,
        name: item.name,
        meteoId: item.meteoId,
        relayId: item.relayId,
        inputId: item.inputId || '',
        mode: item.mode,
        setpointC: thermostatNumber(item.setpointC),
        hysteresisC: thermostatNumber(item.hysteresisC),
      }));
    return items.map((item) => ({
      id: item.id,
      name: item.name,
      relayId: item.relayId,
      inputId: item.inputId || '',
    }));
  }

  function controllerItemsKey(items, model) {
    if (model?.isSecurity)
      return JSON.stringify({
        common: securityCommonSettings(model.snapshot),
        items: controllerSettings(items, model),
      });
    return JSON.stringify(
      controllerSettings(items, model).sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  function validateControllerSnapshot(snapshot, model) {
    if (model.isSecurity) {
      if (
        !snapshot ||
        !Number.isSafeInteger(snapshot.revision) ||
        typeof snapshot.enabled !== 'boolean' ||
        typeof snapshot.armed !== 'boolean' ||
        typeof snapshot.triggered !== 'boolean' ||
        !Array.isArray(snapshot.keys) ||
        snapshot.keys.length > 16 ||
        !snapshot.keys.every(
          (key) =>
            key &&
            typeof key.id === 'string' &&
            typeof key.name === 'string' &&
            context.validIbuttonAddress(key.address),
        ) ||
        typeof snapshot.sirenRelayId !== 'string' ||
        typeof snapshot.readerPortId !== 'string' ||
        !['entryDelaySeconds', 'exitDelaySeconds'].every(
          (key) => Number.isInteger(snapshot[key]) && snapshot[key] >= 0 && snapshot[key] <= 300,
        ) ||
        !Array.isArray(snapshot.items) ||
        snapshot.items.length > 16 ||
        !snapshot.items.every(
          (item) =>
            item &&
            /^[a-zA-Z0-9_-]{1,32}$/.test(item.id) &&
            typeof item.name === 'string' &&
            typeof item.inputId === 'string' &&
            ['reed', 'motion'].includes(item.sensorType) &&
            typeof item.entryDelay === 'boolean',
        ) ||
        !Array.isArray(snapshot.ports?.inputs) ||
        !Array.isArray(snapshot.ports?.sensors) ||
        !Array.isArray(snapshot.ports?.relays)
      )
        throw new Error('Контроллер вернул неверный формат охраны.');
      return;
    }
    if (
      !snapshot ||
      !Number.isSafeInteger(snapshot.revision) ||
      typeof snapshot.enabled !== 'boolean' ||
      !Array.isArray(snapshot.items) ||
      snapshot.items.length > 16 ||
      !snapshot.items.every(
        (item) =>
          item &&
          /^[a-zA-Z0-9_-]{1,32}$/.test(item.id) &&
          typeof item.name === 'string' &&
          (model.isMeteo
            ? typeof item.portId === 'string' &&
              ['dht22', 'onewire'].includes(item.sensorType) &&
              typeof item.address === 'string'
            : model.isIrrigation
              ? context.irrigationParametersValid(item) && typeof item.enabled === 'boolean'
              : model.isTank
                ? typeof item.pumpRelayId === 'string' &&
                  typeof item.valveRelayId === 'string' &&
                  Array.isArray(item.levelInputs) &&
                  item.levelInputs.length >= 1 &&
                  item.levelInputs.length <= 3 &&
                  item.levelInputs.every((id) => typeof id === 'string') &&
                  Number.isInteger(item.fillLevel) &&
                  typeof item.enabled === 'boolean'
                : model.isThermostat
                  ? typeof item.meteoId === 'string' &&
                    typeof item.relayId === 'string' &&
                    typeof item.inputId === 'string' &&
                    typeof item.enabled === 'boolean' &&
                    ['heating', 'cooling'].includes(item.mode) &&
                    Number.isFinite(item.setpointC) &&
                    Number.isFinite(item.hysteresisC)
                  : typeof item.relayId === 'string' && typeof item.inputId === 'string'),
      ) ||
      new Set(snapshot.items.map((item) => item.id)).size !== snapshot.items.length ||
      (model.isMeteo
        ? !Array.isArray(snapshot.ports?.sensors)
        : !Array.isArray(snapshot.ports?.relays) ||
          (!model.isIrrigation && !Array.isArray(snapshot.ports?.inputs)))
    ) {
      throw new Error('Контроллер вернул неверный формат настроек.');
    }
  }

  /**
   * @brief Accept confirmed state without overwriting unsaved settings.
   * @note An unchanged saved baseline may advance CAS revision; changed bindings mark a conflict.
   */
  function acceptControllerSnapshot(model, snapshot, replaceDraft = false) {
    validateControllerSnapshot(snapshot, model);
    model.snapshot = snapshot;
    model.loaded = true;
    model.fresh = true;
    model.uncertain.clear();
    const itemsKey = controllerItemsKey(snapshot.items, model);
    if (replaceDraft || !state.dirty.has(model.dirtyKey)) {
      model.draft = controllerSettings(snapshot.items, model);
      if (model.isSecurity) {
        const previousPort = model.common?.readerPortId;
        model.common = securityCommonSettings(snapshot);
        if (previousPort !== model.common.readerPortId) model.scan = null;
      }
      model.baseRevision = snapshot.revision;
      model.baseItems = itemsKey;
      model.conflict = false;
      dirty(model.dirtyKey, false);
    } else if (itemsKey === model.baseItems) {
      model.baseRevision = snapshot.revision;
    } else {
      model.conflict = true;
    }
    model.loadError = '';
  }

  function acceptControllersSnapshot(snapshot, replaceIds = []) {
    const supported = controllers.filter(
      (model) => !model.isIrrigation || snapshot?.irrigation !== undefined,
    );
    const irrigation = controllers.find((model) => model.isIrrigation);
    if (irrigation) {
      const missing = !supported.includes(irrigation);
      document.querySelector('[data-controller-id="irrigation"]').hidden = missing;
      if (missing) {
        irrigation.loaded = irrigation.fresh = false;
        irrigation.snapshot = null;
        irrigation.remoteTanks = [];
        if (state.controllersView === irrigation.id) state.controllersView = '';
      }
    }
    for (const model of supported) validateControllerSnapshot(snapshot?.[model.id], model);
    if (!Array.isArray(snapshot.resources)) throw new Error('Контроллер не вернул каталог портов.');
    state.controllerResources = snapshot.resources.filter(
      (resource) =>
        resource &&
        typeof resource.id === 'string' &&
        ['relay', 'input', 'sensor'].includes(resource.kind),
    );
    for (const model of supported)
      acceptControllerSnapshot(model, snapshot[model.id], replaceIds.includes(model.id));
    if (state.controllersView === 'meteo' && controllersActive()) {
      const meteo = controllers.find((model) => model.isMeteo);
      for (const item of meteo.draft) {
        if (
          item.sensorType === 'onewire' &&
          !state.meteoScans.has(item.portId) &&
          !state.meteoScanQueue.has(item.portId)
        )
          state.meteoScanQueue.set(item.portId, item.id);
      }
    }
    renderControllers();
    if (state.initialIrrigationRule) {
      if (state.controllersView === 'irrigation') {
        const rule = byId('irrigation-' + state.initialIrrigationRule + '-name');
        (rule || byId('irrigation-page-title')).focus();
      }
      state.initialIrrigationRule = '';
    }
  }

  /**
   * @brief Combine saved and draft port claims across all controller modules.
   * @note Saved ports remain reserved until their owner successfully saves a release.
   * Ownership is the pair controller ID + item ID, rather than the item ID alone.
   */
  function controllerClaims() {
    const claims = new Map();
    const add = (portId, controllerId, ownerId, name, sensorType = '', address = '') => {
      if (!portId || !controllerId || !ownerId) return;
      const key = JSON.stringify([portId, controllerId, ownerId, sensorType, address]);
      claims.set(key, {
        portId,
        controllerId,
        ownerId,
        name: name || ownerId,
        sensorType,
        address,
      });
    };
    for (const resource of state.controllerResources) {
      const owner = controllers.find((model) => model.id === resource.ownerController);
      const known = owner?.snapshot?.items.some(
        (item) =>
          item.id === resource.ownerId &&
          [item.relayId, item.inputId, item.portId].includes(resource.id),
      );
      if (!known) add(resource.id, resource.ownerController, resource.ownerId, resource.ownerName);
    }
    for (const model of controllers) {
      if (model.isSecurity)
        for (const source of [model.snapshot, model.common]) {
          add(source?.sirenRelayId, model.id, 'siren', 'Сирена');
          add(source?.readerPortId, model.id, 'reader', 'Считыватель iButton');
        }
      for (const item of model.snapshot?.items || []) {
        for (const port of [item.pumpRelayId, item.valveRelayId, ...(item.levelInputs || [])])
          add(port, model.id, item.id, item.name);
        add(item.relayId, model.id, item.id, item.name);
        add(item.inputId, model.id, item.id, item.name);
        add(item.portId, model.id, item.id, item.name, item.sensorType, item.address);
      }
      for (const item of model.draft) {
        for (const port of [item.pumpRelayId, item.valveRelayId, ...(item.levelInputs || [])])
          add(port, model.id, item.id, item.name);
        add(item.relayId, model.id, item.id, item.name);
        add(item.inputId, model.id, item.id, item.name);
        add(item.portId, model.id, item.id, item.name, item.sensorType, item.address);
      }
    }
    return Array.from(claims.values());
  }

  function otherPortClaims(portId, model, itemId, claims = controllerClaims()) {
    return claims.filter(
      (claim) =>
        claim.portId === portId && (claim.controllerId !== model.id || claim.ownerId !== itemId),
    );
  }

  function ownerLabel(claim) {
    const title =
      controllers.find((model) => model.id === claim.controllerId)?.title || claim.controllerId;
    return `${title}: ${claim.name}`;
  }

  function controllerOptions(select, ids, selected, model, itemId, claims, optional = false) {
    const ports = ids.filter((id) => typeof id === 'string');
    const options = ports.map((id) => {
      const owners = otherPortClaims(id, model, itemId, claims);
      return {
        id,
        label: owners.length ? `${id} · ${owners.map(ownerLabel).join('; ')}` : id,
        disabled: owners.length > 0,
      };
    });
    const signature = JSON.stringify([options, selected, optional]);
    if (select.dataset.options !== signature) {
      select.replaceChildren(new Option(optional ? 'Без входа' : 'Выберите реле', ''));
      for (const entry of options) {
        const option = new Option(entry.label, entry.id);
        option.disabled = entry.disabled;
        select.add(option);
      }
      if (selected && !ports.includes(selected)) {
        const missing = new Option(`${selected} · недоступен`, selected);
        missing.disabled = true;
        select.add(missing);
      }
      select.dataset.options = signature;
    }
    if (select.value !== selected) select.value = selected;
  }

  function createControllerCard(model, item) {
    const card = hardwareElement('article', 'socket-card');
    card.dataset[`${model.data}Id`] = item.id;
    const visual = createControllerVisual({
      interactive: true,
      onActivate: () => setControllerState(model, item.id),
    });
    visual.dataset[`${model.data}Toggle`] = item.id;
    card.append(visual);
    const heading = hardwareElement('div', 'socket-card-header');
    const remove = hardwareElement('button', 'socket-remove', 'Удалить');
    remove.type = 'button';
    remove.dataset[`${model.data}Remove`] = item.id;
    remove.addEventListener('click', () => {
      if (state.controllersBusy) return;
      model.draft = model.draft.filter((draft) => draft.id !== item.id);
      dirty(model.dirtyKey);
      renderControllers();
    });
    heading.append(hardwareElement('span', 'socket-number'), remove);
    card.append(heading);
    for (const [field, label, tag] of [
      ['name', 'Название', 'input'],
      ['relayId', 'Релейный выход', 'select'],
      ['inputId', 'Вход кнопки (необязательно)', 'select'],
    ]) {
      const input = document.createElement(tag);
      input.id = `${model.data}-${item.id}-${field}`;
      input.dataset[`${model.data}Field`] = field;
      if (field === 'name') {
        input.dataset[`${model.data}Name`] = '';
        input.maxLength = 64;
        input.required = true;
        input.autocomplete = 'off';
      } else if (field === 'relayId') input.dataset[`${model.data}Relay`] = '';
      else input.dataset[`${model.data}Input`] = '';
      const caption = hardwareElement('label', '', label);
      caption.htmlFor = input.id;
      input.addEventListener(field === 'name' ? 'input' : 'change', () => {
        const draft = model.draft.find((entry) => entry.id === item.id);
        if (!draft) return;
        draft[field] = input.value;
        dirty(model.dirtyKey);
        renderControllers();
      });
      card.append(caption, input);
    }
    const live = hardwareElement('div', 'socket-live');
    live.append(hardwareElement('span', 'badge socket-state'));
    const error = hardwareElement('p', 'field-error');
    error.setAttribute('role', 'status');
    card.append(
      live,
      hardwareElement('p', 'socket-input-state'),
      hardwareElement('p', 'socket-binding-state'),
      error,
    );
    return card;
  }

  function renderController(model, claims) {
    const snapshot = model.snapshot;
    const enabled = snapshot?.enabled === true;
    const action = state.controllersAction;
    const ownAction = action?.controllerId === model.id;
    const resourceConflict = (snapshot?.items || []).some((item) =>
      [
        item.relayId,
        item.inputId,
        item.portId,
        item.pumpRelayId,
        item.valveRelayId,
        ...(item.levelInputs || []),
      ].some(
        (id) =>
          id &&
          state.controllerResources.some((resource) => resource.id === id && resource.conflict),
      ),
    );
    const conflictMessage =
      errorMessage(snapshot?.error) ||
      (resourceConflict
        ? 'Есть конфликт назначений портов. У каждого реле и входа должен быть один владелец. Исправьте привязки и сохраните настройки; автоматика конфликтующих привязок приостановлена.'
        : '');
    const moduleLabel = model.loaded
      ? enabled
        ? 'Модуль включён'
        : 'Модуль выключен'
      : 'Загрузка…';
    for (const id of [`${model.id}-tile-enabled`, `${model.id}-enabled`]) {
      const button = byId(id);
      button.setAttribute('aria-pressed', model.loaded ? String(enabled) : 'mixed');
      button.setAttribute('aria-busy', String(ownAction && action.kind === 'enabled'));
      button.setAttribute(
        'aria-label',
        `${enabled ? 'Выключить' : 'Включить'} модуль ${model.title}`,
      );
      button.disabled = !model.loaded || state.controllersBusy || !controllersActive();
    }
    const tileBadge = byId(`${model.id}-tile-status`);
    tileBadge.textContent = !model.loaded
      ? 'Загрузка…'
      : !model.fresh
        ? 'Нет связи'
        : conflictMessage
          ? 'Конфликт портов'
          : enabled
            ? 'Включён'
            : 'Выключен';
    tileBadge.className = `badge ${!model.fresh ? 'state-unknown' : conflictMessage ? 'state-error' : enabled ? 'state-on' : 'state-off'}`;
    tileBadge.title = conflictMessage;
    document
      .querySelector(`[data-controller-id="${model.id}"]`)
      .classList.toggle('module-on', model.loaded && enabled);
    byId(`${model.id}-module-status`).textContent = moduleLabel;
    byId(`${model.id}-view`).hidden = state.controllersView !== model.id;
    byId(`${model.id}-conflict`).hidden = !model.conflict;
    byId(`${model.id}-count`).textContent = `${model.draft.length} из 16`;
    byId(`${model.id}-revision`).textContent = model.loaded
      ? `Конфигурация «${model.title}»: ${snapshot.revision}`
      : '';
    const visible = !state.controllersView || state.controllersView === model.id;
    const error = byId(`${model.id}-error`);
    error.textContent = model.loadError;
    error.hidden = !model.loadError || !visible;
    const noticeElement = byId(`${model.id}-notice`);
    noticeElement.textContent = model.notice;
    noticeElement.className = `notice ${model.noticeKind}`.trim();
    noticeElement.hidden = !model.notice || !visible;
    const warning = byId(`${model.id}-resource-warning`);
    warning.textContent = conflictMessage;
    warning.hidden = !warning.textContent;
    const relays = snapshot?.ports.relays || [];
    const inputs = snapshot?.ports.inputs || [];
    const freeBinding = model.isSecurity
      ? inputs.find((id) => !claims.some((claim) => claim.portId === id))
      : model.isIrrigation
        ? context.newIrrigationBinding(model, claims)
        : model.isTank
          ? context.newTankBinding(model, claims)
          : model.isMeteo
            ? newMeteoBinding(model, claims)
            : relays.find((id) => !claims.some((claim) => claim.portId === id));
    byId(`${model.id}-add`).disabled =
      !model.loaded || state.controllersBusy || model.draft.length >= 16 || !freeBinding;
    byId(`${model.id}-save`).disabled =
      !model.loaded || state.controllersBusy || !state.dirty.has(model.dirtyKey);
    const saving = ownAction && action.kind === 'save';
    byId(`${model.id}-save`).setAttribute('aria-busy', String(saving));
    byId(`${model.id}-reload`).disabled = state.controllersBusy;
    byId(`${model.id}-save`).textContent = saving ? 'Сохранение…' : 'Сохранить настройки';
    document.querySelector(`[data-save-state="${model.dirtyKey}"]`).textContent = saving
      ? 'Сохраняем настройки…'
      : state.dirty.has(model.dirtyKey)
        ? 'Есть несохранённые изменения'
        : model.loaded
          ? 'Все изменения сохранены'
          : '';
    byId(`${model.id}-empty`).hidden = model.draft.length > 0;
    const emptyIcon = controllerIcon(model);
    iconHeading(
      byId(`${model.id}-empty`).querySelector('h3'),
      model.loaded ? model.empty : 'Загрузка настроек…',
      emptyIcon.name,
    );
    if (model.isSecurity) renderSecurity(model, claims);
    const container = byId(`${model.id}-items`);
    const existing = new Map(
      Array.from(container.children).map((card) => [card.dataset[`${model.data}Id`], card]),
    );
    const retained = new Set();
    for (const [index, item] of model.draft.entries()) {
      let card = existing.get(item.id);
      if (!card) {
        card = model.isSecurity
          ? createSecurityCard(model, item)
          : model.isMeteo
            ? createMeteoCard(model, item)
            : model.isThermostat
              ? createThermostatCard(model, item)
              : model.isTank
                ? context.createTankCard(model, item)
                : model.isIrrigation
                  ? context.createIrrigationCard(model, item)
                  : createControllerCard(model, item);
        container.append(card);
      }
      retained.add(item.id);
      const icon = controllerIcon(model, item);
      iconHeading(
        card.querySelector('.socket-number'),
        `${model.singular} ${index + 1}`,
        icon.name,
        false,
        icon.tone,
      );
      const remove = card.querySelector(`[data-${model.data}-remove]`);
      remove.setAttribute('aria-label', `Удалить ${model.object} ${item.name || index + 1}`);
      remove.disabled = state.controllersBusy;
      const name = card.querySelector(`[data-${model.data}-field="name"]`);
      if (name.value !== item.name) name.value = item.name;
      if (model.isSecurity) {
        renderSecurityCard(card, model, item, claims);
        continue;
      }
      if (model.isMeteo) {
        renderMeteoCard(card, model, item, claims);
        continue;
      }
      if (model.isIrrigation) {
        context.renderIrrigationCard(card, model, item, claims);
        continue;
      }
      if (model.isTank) {
        context.renderTankCard(card, model, item, claims);
        continue;
      }
      if (model.isThermostat) {
        renderThermostatCard(card, model, item, claims);
        continue;
      }
      controllerOptions(
        card.querySelector(`[data-${model.data}-field="relayId"]`),
        relays,
        item.relayId,
        model,
        item.id,
        claims,
      );
      controllerOptions(
        card.querySelector(`[data-${model.data}-field="inputId"]`),
        inputs,
        item.inputId,
        model,
        item.id,
        claims,
        true,
      );
      for (const input of card.querySelectorAll('input, select'))
        input.disabled = state.controllersBusy && ['save', 'reload'].includes(action?.kind);
      const saved = snapshot?.items.find((entry) => entry.id === item.id);
      const bound = saved && saved.relayId === item.relayId && saved.inputId === item.inputId;
      const known =
        model.fresh &&
        bound &&
        saved.available === true &&
        typeof saved.actual === 'boolean' &&
        !model.uncertain.has(item.id);
      const pending = ownAction && action.kind === 'state' && action.id === item.id;
      const toggle = card.querySelector(`[data-${model.data}-toggle]`);
      card.classList.toggle('socket-on', known && saved.actual);
      const badge = card.querySelector('.socket-state');
      badge.textContent = !bound
        ? 'Привязка не сохранена'
        : known
          ? saved.actual
            ? 'Включено'
            : 'Выключено'
          : 'Нет данных';
      if (model.id === 'sockets' && known)
        badge.textContent = saved.actual ? 'Включена' : 'Выключена';
      badge.className = `badge socket-state ${!known ? 'state-unknown' : saved.actual ? 'state-on' : 'state-off'}`;
      renderControllerVisual(toggle, {
        icon: icon.name,
        tone: model.id === 'lights' ? 'light' : 'power',
        state: known
          ? saved.actual
            ? 'on'
            : 'off'
          : model.errors.has(item.id)
            ? 'error'
            : 'unknown',
        pending,
        disabled: !known || !enabled || state.controllersBusy || !controllersActive(),
        pressed: known ? saved.actual : 'mixed',
        label: pending
          ? `${item.name}: отправка команды`
          : known
            ? `${saved.actual ? 'Выключить' : 'Включить'} ${model.object} ${item.name}`
            : `${item.name}: состояние недоступно`,
        caption: badge.textContent,
        detail: !bound
          ? 'Сначала сохраните назначение портов'
          : pending
            ? 'Ожидаем подтверждения контроллера'
            : !enabled
              ? 'Модуль выключен'
              : known
                ? 'Нажмите, чтобы переключить'
                : 'Управление доступно после обновления данных',
        number: `#${index + 1}`,
      });
      card.querySelector('.socket-input-state').textContent = !item.inputId
        ? 'Переключение от входа не используется'
        : !bound
          ? 'Новый вход применится после сохранения'
          : `${item.inputId} · ${model.fresh && typeof saved.inputLevel === 'boolean' ? (saved.inputLevel ? 'HIGH' : 'LOW') : 'Нет данных'}`;
      card.querySelector('.socket-binding-state').textContent =
        bound && typeof saved.state === 'boolean'
          ? `Сохранённое состояние: ${saved.state ? 'включено' : 'выключено'}`
          : `Сохраните настройки для управления`;
      const error = card.querySelector('.field-error');
      error.textContent = [model.errors.get(item.id), errorMessage(bound && saved.error)]
        .filter(Boolean)
        .join(' · ');
      error.hidden = !error.textContent;
    }
    for (const card of Array.from(container.children))
      if (!retained.has(card.dataset[`${model.data}Id`])) card.remove();
  }

  function renderControllers() {
    byId('controllers-list-view').hidden = Boolean(state.controllersView);
    const claims = controllerClaims();
    for (const model of controllers) renderController(model, claims);
  }

  function scheduleControllersPoll(delay = 1000) {
    if (state.controllersTimer) window.clearTimeout(state.controllersTimer);
    state.controllersTimer = null;
    if (controllersActive() && !state.controllersBusy)
      state.controllersTimer = window.setTimeout(pollControllers, delay);
  }

  async function refreshRemoteTanks(sessionVersion, generation) {
    if (state.controllersView !== 'irrigation') return;
    const model = controllers.find((entry) => entry.isIrrigation);
    if (!model?.loaded) return;
    // The aggregate controller snapshot keeps the port claims. Remote tank names and
    // identities use a separate read so they do not enlarge ordinary controller polling.
    const reply = await api('/controllers/irrigation', {}, false).catch(() => null);
    if (
      reply &&
      controllersActive() &&
      state.controllersView === 'irrigation' &&
      sessionVersion === state.sessionVersion &&
      generation === state.controllersGeneration
    ) {
      model.remoteTanks = Array.isArray(reply.remoteTanks) ? reply.remoteTanks : [];
      renderControllers();
    }
  }

  async function pollControllers() {
    if (!controllersActive() || state.controllersPending || state.controllersBusy) return;
    const generation = state.controllersGeneration;
    const sessionVersion = state.sessionVersion;
    const request = (async () => {
      try {
        const snapshot = await api('/controllers');
        if (
          controllersActive() &&
          generation === state.controllersGeneration &&
          sessionVersion === state.sessionVersion
        ) {
          acceptControllersSnapshot(snapshot);
          if (!state.controllersBusy) await refreshRemoteTanks(sessionVersion, generation);
          if (!state.controllersBusy) await pollMeteoScan(sessionVersion, generation);
        }
      } catch (error) {
        if (
          !controllersActive() ||
          generation !== state.controllersGeneration ||
          sessionVersion !== state.sessionVersion
        )
          return;
        for (const model of controllers) {
          model.fresh = false;
          model.loadError = error.message;
        }
        renderControllers();
      }
    })();
    state.controllersPending = request;
    try {
      await request;
    } finally {
      if (state.controllersPending === request) state.controllersPending = null;
      scheduleControllersPoll();
    }
  }

  function updateControllersPolling() {
    state.controllersGeneration++;
    if (state.controllersTimer) window.clearTimeout(state.controllersTimer);
    state.controllersTimer = null;
    for (const model of controllers) model.fresh = false;
    if (controllersActive()) {
      renderControllers();
      if (!state.controllersPending && !state.controllersBusy) pollControllers();
    }
  }

  /**
   * @brief Serialize module writes and scans after the shared aggregate poll.
   * @note Values are confirmed by the server; failures preserve drafts and mark uncertain actions.
   */
  async function controllerCommand(model, kind, id, operation) {
    if (!controllersActive() || state.controllersBusy) return;
    controllerNotice(model, '');
    const sessionVersion = state.sessionVersion;
    state.controllersBusy = true;
    state.controllersAction = { controllerId: model.id, kind, id };
    if (state.controllersTimer) window.clearTimeout(state.controllersTimer);
    state.controllersTimer = null;
    renderControllers();
    try {
      if (state.controllersPending) await state.controllersPending;
      if (!controllersActive() || sessionVersion !== state.sessionVersion) return;
      await operation(sessionVersion);
    } catch (error) {
      if (state.authenticated && sessionVersion === state.sessionVersion) {
        if (kind === 'state' || kind === 'item-enabled') {
          model.errors.set(id, error.message);
          model.uncertain.add(id);
        }
        if (error.status === 409) model.conflict = true;
        controllerNotice(
          model,
          error.status === 409
            ? `${error.message} Ваши правки сохранены на странице; проверьте назначения портов и загрузите актуальные настройки при необходимости.`
            : error.message,
          'error',
        );
      }
    } finally {
      if (sessionVersion === state.sessionVersion) {
        state.controllersBusy = false;
        state.controllersAction = null;
        renderControllers();
        scheduleControllersPoll(0);
      }
    }
  }

  function setThermostatEnabled(model, id) {
    const saved = model.snapshot?.items.find((item) => item.id === id);
    const draft = model.draft.find((item) => item.id === id);
    if (
      !model.fresh ||
      !saved ||
      !draft ||
      typeof saved.enabled !== 'boolean' ||
      !thermostatRowSaved(model, draft, saved) ||
      model.uncertain.has(id)
    )
      return;
    const target = !saved.enabled;
    const settingsKey = JSON.stringify(controllerSettings([saved], model));
    controllerCommand(model, 'item-enabled', id, async (sessionVersion) => {
      const current = model.snapshot?.items.find((item) => item.id === id);
      if (
        !model.fresh ||
        !current ||
        !thermostatRowSaved(model, draft, current) ||
        JSON.stringify(controllerSettings([current], model)) !== settingsKey
      )
        throw new Error(
          'Настройки термостата изменились. Сохраните или обновите параметры перед переключением.',
        );
      const response = await post('/controllers/thermostats/enabled', { id, value: target });
      if (!state.authenticated || sessionVersion !== state.sessionVersion) return;
      if (response.ok !== true)
        throw new Error('Контроллер не подтвердил сохранение включения термостата.');
      model.errors.delete(id);
      acceptControllerSnapshot(model, response);
      controllerNotice(
        model,
        `Термостат «${current.name}» ${target ? 'включён' : 'выключен'}.${target && !response.enabled ? ' Общий модуль выключен: выход остаётся выключенным.' : ''}`,
        'success',
      );
    });
  }

  function setControllerState(model, id) {
    const saved = model.snapshot?.items.find((item) => item.id === id);
    const draft = model.draft.find((item) => item.id === id);
    if (
      !model.fresh ||
      !model.snapshot.enabled ||
      !saved ||
      !draft ||
      saved.relayId !== draft.relayId ||
      saved.inputId !== draft.inputId ||
      saved.available !== true ||
      typeof saved.actual !== 'boolean' ||
      model.uncertain.has(id)
    )
      return;
    const target = !saved.actual;
    const relayId = saved.relayId;
    const inputId = saved.inputId;
    controllerCommand(model, 'state', id, async (sessionVersion) => {
      const current = model.snapshot?.items.find((item) => item.id === id);
      if (
        !model.fresh ||
        !model.snapshot.enabled ||
        !current ||
        current.available !== true ||
        typeof current.actual !== 'boolean'
      )
        throw new Error('Обновите состояние перед отправкой команды.');
      if (current.relayId !== relayId || current.inputId !== inputId)
        throw new Error('Привязка изменилась. Проверьте актуальные настройки перед управлением.');
      const response = await post(`/controllers/${model.id}/state`, { id, value: target });
      if (!state.authenticated || sessionVersion !== state.sessionVersion) return;
      if (response.ok !== true) throw new Error('Контроллер не подтвердил изменение состояния.');
      model.errors.delete(id);
      acceptControllerSnapshot(model, response);
      controllerNotice(model, `Состояние «${draft.name}» сохранено.`, 'success');
    });
  }

  async function refreshControllerResources(sessionVersion, replaceIds = []) {
    const generation = state.controllersGeneration;
    const snapshot = await api('/controllers');
    if (state.authenticated && sessionVersion === state.sessionVersion) {
      acceptControllersSnapshot(snapshot, replaceIds);
      await refreshRemoteTanks(sessionVersion, generation);
    }
  }

  function setControllerEnabled(model) {
    if (!model.loaded) return;
    const target = !model.snapshot.enabled;
    controllerCommand(model, 'enabled', '', async (sessionVersion) => {
      const response = await post(`/controllers/${model.id}`, {
        ...(model.isSecurity ? securityCommonSettings(model.snapshot) : {}),
        baseRevision: model.snapshot.revision,
        enabled: target,
        items: controllerSettings(model.snapshot.items, model),
      });
      if (!state.authenticated || sessionVersion !== state.sessionVersion) return;
      if (response.ok !== true) throw new Error('Контроллер не подтвердил настройку модуля.');
      acceptControllerSnapshot(model, response);
      await refreshControllerResources(sessionVersion);
      controllerNotice(
        model,
        target
          ? `Модуль «${model.title}» включён.`
          : `Модуль «${model.title}» выключен.${model.isMeteo ? '' : ' Все его выходы выключаются.'}`,
        'success',
      );
    });
  }

  function reloadController(model) {
    if (
      state.dirty.has(model.dirtyKey) &&
      !window.confirm(
        `Загрузить сохранённые настройки «${model.title}»? Несохранённые изменения этой формы будут потеряны.`,
      )
    )
      return;
    controllerCommand(model, 'reload', '', async (sessionVersion) => {
      await refreshControllerResources(sessionVersion, [model.id]);
      controllerNotice(model, `Сохранённые настройки «${model.title}» загружены.`, 'success');
    });
  }

  function saveController(model) {
    controllerCommand(model, 'save', '', async (sessionVersion) => {
      const items = controllerSettings(model.draft, model).map((item) => ({
        ...item,
        name: item.name.trim(),
      }));
      if (items.length > 16) throw new Error('Можно настроить не более 16 элементов в модуле.');
      if (items.some((item) => !item.name || new TextEncoder().encode(item.name).length > 64))
        throw new Error('Укажите название каждого элемента: не более 64 байт.');
      const claims = controllerClaims().filter((claim) => claim.controllerId !== model.id);
      if (model.isSecurity) {
        validateSecuritySettings(model, items, claims);
      } else if (model.isMeteo) {
        validateMeteoSettings(model, items, claims);
      } else if (model.isIrrigation) {
        context.validateIrrigationSettings(model, items, claims);
      } else if (model.isTank) {
        context.validateTankSettings(model, items, claims);
      } else if (model.isThermostat) {
        validateThermostatSettings(model, items, claims);
      } else {
        for (const item of items)
          for (const portId of [item.relayId, item.inputId].filter(Boolean))
            claims.push({ portId, controllerId: model.id, ownerId: item.id, name: item.name });
        for (const item of items) {
          if (!model.snapshot.ports.relays.includes(item.relayId))
            throw new Error('Выберите доступное реле для каждого элемента.');
          if (item.inputId && !model.snapshot.ports.inputs.includes(item.inputId))
            throw new Error('Выберите доступный вход или вариант «Без входа».');
          for (const id of [item.relayId, item.inputId].filter(Boolean)) {
            const others = otherPortClaims(id, model, item.id, claims);
            if (others.length)
              throw new Error(
                `Порт ${id} занят: ${others.map(ownerLabel).join('; ')}. Сначала сохраните освобождение порта у его владельца.`,
              );
          }
        }
      }
      const response = await post(`/controllers/${model.id}`, {
        ...(model.isSecurity ? securityCommonSettings(model.common) : {}),
        baseRevision: model.baseRevision,
        enabled: model.snapshot.enabled,
        items,
      });
      if (!state.authenticated || sessionVersion !== state.sessionVersion) return;
      if (response.ok !== true) throw new Error('Контроллер не подтвердил сохранение настроек.');
      acceptControllerSnapshot(model, response, true);
      await refreshControllerResources(sessionVersion);
      controllerNotice(model, `Настройки «${model.title}» сохранены.`, 'success');
    });
  }

  function resetControllersSession() {
    ++noticeVersion;
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    noticeTimer = null;
    state.controllersView = '';
    state.controllerResources = [];
    state.controllersBusy = false;
    state.controllersAction = null;
    state.meteoScans.clear();
    state.meteoScanQueue.clear();
    for (const model of controllers) {
      Object.assign(model, {
        snapshot: null,
        draft: [],
        baseRevision: null,
        baseItems: '',
        loaded: false,
        fresh: false,
        conflict: false,
        loadError: '',
        notice: '',
        noticeKind: '',
        ...(model.isSecurity ? { common: null, scan: null } : {}),
        ...(model.isIrrigation ? { remoteTanks: [] } : {}),
      });
      model.errors.clear();
      model.uncertain.clear();
      dirty(model.dirtyKey, false);
    }
    renderControllers();
    updateControllersPolling();
  }

  return {
    controllersActive,
    controllerNotice,
    controllerSettings,
    controllerItemsKey,
    validateControllerSnapshot,
    acceptControllerSnapshot,
    acceptControllersSnapshot,
    controllerClaims,
    otherPortClaims,
    ownerLabel,
    controllerOptions,
    createControllerCard,
    renderController,
    renderControllers,
    scheduleControllersPoll,
    pollControllers,
    updateControllersPolling,
    controllerCommand,
    setThermostatEnabled,
    setControllerState,
    refreshControllerResources,
    setControllerEnabled,
    reloadController,
    saveController,
    resetControllersSession,
  };
}
