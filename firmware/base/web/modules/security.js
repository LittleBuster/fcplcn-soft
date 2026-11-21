/** @file security.js @brief Autonomous alarm configuration, authorized iButton keys and zone visuals. */
export function createSecurityUI(context) {
  const { state, controllers } = context;
  const byId = (...args) => context.byId(...args);
  const element = (...args) => context.hardwareElement(...args);
  const model = () => controllers.find((entry) => entry.isSecurity);
  const commonFields = {
    sirenRelayId: 'security-siren',
    readerPortId: 'security-reader',
    exitDelaySeconds: 'security-exit-delay',
    entryDelaySeconds: 'security-entry-delay',
  };
  let scanToken = 0;
  /** @brief Copy only saved common settings, excluding armed/alarm runtime flags. */
  function securityCommonSettings(source) {
    return {
      sirenRelayId: source?.sirenRelayId || '',
      readerPortId: source?.readerPortId || '',
      exitDelaySeconds: Number(source?.exitDelaySeconds ?? 30),
      entryDelaySeconds: Number(source?.entryDelaySeconds ?? 15),
      keys: (source?.keys || []).map(({ id, name, address }) => ({ id, name, address })),
    };
  }
  /** @brief Check the complete wire-order DS1990A ROM including its Dallas CRC byte. */
  function validIbuttonAddress(address) {
    if (typeof address !== 'string' || !/^01[0-9a-f]{14}$/i.test(address)) return false;
    let crc = 0;
    for (let index = 0; index < 16; index += 2) {
      let part = parseInt(address.slice(index, index + 2), 16);
      for (let bit = 0; bit < 8; bit++) {
        const mixed = (crc ^ part) & 1;
        crc >>= 1;
        if (mixed) crc ^= 0x8c;
        part >>= 1;
      }
    }
    return crc === 0;
  }
  function changed() {
    context.dirty('security');
    context.renderControllers();
  }
  for (const [field, id] of Object.entries(commonFields))
    byId(id).addEventListener('change', () => {
      const entry = model();
      if (!entry.common) return;
      entry.common[field] = field.endsWith('Seconds') ? Number(byId(id).value) : byId(id).value;
      if (field === 'readerPortId') {
        entry.scan = null;
        ++scanToken;
      }
      changed();
    });
  /** @brief Discover a contact key asynchronously without modifying the configured reader binding. */
  async function scanKey() {
    const entry = model(),
      portId = entry.common?.readerPortId;
    if (!portId || entry.snapshot?.armed || state.controllersBusy) return;
    const token = ++scanToken,
      sessionVersion = state.sessionVersion;
    entry.scan = { busy: true, complete: false, addresses: [], error: '' };
    context.renderControllers();
    try {
      let refresh = true;
      do {
        if (
          token !== scanToken ||
          sessionVersion !== state.sessionVersion ||
          !state.authenticated ||
          entry.common?.readerPortId !== portId
        )
          return;
        const response = await context.post('/controllers/security/scan', { portId, refresh });
        if (token !== scanToken || sessionVersion !== state.sessionVersion || !state.authenticated)
          return;
        if (
          typeof response.busy !== 'boolean' ||
          typeof response.complete !== 'boolean' ||
          !Array.isArray(response.addresses) ||
          response.addresses.length > 16 ||
          response.addresses.some((address) => !validIbuttonAddress(address))
        )
          throw new Error('Считыватель вернул неверные данные поиска iButton.');
        entry.scan = response;
        context.renderControllers();
        if (!response.busy) break;
        refresh = false;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      } while (true);
    } catch (error) {
      if (token === scanToken && sessionVersion === state.sessionVersion) {
        entry.scan = { busy: false, complete: true, addresses: [], error: error.message };
        context.renderControllers();
      }
    }
  }
  byId('security-key-scan').addEventListener('click', scanKey);
  byId('security-key-address').addEventListener('change', () => context.renderControllers());
  byId('security-key-name').addEventListener('input', () => context.renderControllers());
  byId('security-key-add').addEventListener('click', () => {
    const entry = model(),
      address = byId('security-key-address').value.toLowerCase(),
      name = byId('security-key-name').value.trim();
    if (
      !entry.common ||
      !validIbuttonAddress(address) ||
      !name ||
      entry.common.keys.length >= 16 ||
      entry.common.keys.some((key) => key.address.toLowerCase() === address) ||
      entry.snapshot?.armed
    )
      return;
    entry.common.keys.push({ id: `key-${address}`, name, address });
    byId('security-key-name').value = '';
    changed();
  });
  function validateSecuritySettings(entry, items, claims) {
    const common = securityCommonSettings(entry.common);
    if (
      !['exitDelaySeconds', 'entryDelaySeconds'].every(
        (key) => Number.isInteger(common[key]) && common[key] >= 0 && common[key] <= 300,
      )
    )
      throw new Error('Задержки входа и выхода должны быть целыми от 0 до 300 секунд.');
    if (
      (common.sirenRelayId && !entry.snapshot.ports.relays.includes(common.sirenRelayId)) ||
      (common.readerPortId && !entry.snapshot.ports.sensors.includes(common.readerPortId))
    )
      throw new Error('Выберите доступные сирену и считыватель.');
    const uses = [
      { id: common.sirenRelayId, owner: 'siren' },
      { id: common.readerPortId, owner: 'reader' },
      ...items.map((item) => ({ id: item.inputId, owner: item.id })),
    ].filter((use) => use.id);
    if (
      new Set(uses.map((use) => use.id)).size !== uses.length ||
      uses.some((use) => claims.some((claim) => claim.portId === use.id))
    )
      throw new Error('Порт уже используется другим контроллером или датчиком.');
    if (
      items.some(
        (item) =>
          !entry.snapshot.ports.inputs.includes(item.inputId) ||
          !['reed', 'motion'].includes(item.sensorType) ||
          typeof item.entryDelay !== 'boolean',
      )
    )
      throw new Error('Проверьте входы и типы датчиков охраны.');
    if (
      common.keys.length > 16 ||
      common.keys.some(
        (key) =>
          !key.name.trim() ||
          new TextEncoder().encode(key.name).length > 64 ||
          !validIbuttonAddress(key.address),
      ) ||
      new Set(common.keys.map((key) => key.address.toLowerCase())).size !== common.keys.length
    )
      throw new Error('Проверьте имена и уникальные серийные номера ключей iButton.');
  }
  /** @brief Send an explicit armed target and wait for PLC confirmation before changing the visual. */
  function setSecurityArmed() {
    const entry = model(),
      saved = entry.snapshot;
    if (
      !entry.fresh ||
      !saved ||
      entry.uncertain.has('armed') ||
      (!saved.armed && state.dirty.has('security'))
    )
      return;
    const target = !saved.armed;
    context.controllerCommand(entry, 'armed', 'armed', async (sessionVersion) => {
      try {
        const response = await context.post('/controllers/security/armed', { value: target });
        if (!state.authenticated || sessionVersion !== state.sessionVersion) return;
        if (response.ok !== true) throw new Error('PLC не подтвердил изменение охраны.');
        context.acceptControllerSnapshot(entry, response);
        context.controllerNotice(entry, target ? 'Охрана поставлена.' : 'Охрана снята.', 'success');
      } catch (error) {
        entry.uncertain.add('armed');
        throw error;
      }
    });
  }
  /** @brief Render common controls and one confirmed alarm-level action before the sensor cards. */
  function renderSecurity(entry, claims) {
    const common = entry.common || securityCommonSettings(),
      saved = entry.snapshot,
      armed = saved?.armed === true;
    let visual = byId('security-arm-visual').firstElementChild;
    if (!visual) {
      visual = context.createControllerVisual({ interactive: true, onActivate: setSecurityArmed });
      visual.dataset.securityArmed = '';
      byId('security-arm-visual').append(visual);
    }
    const known =
      entry.fresh && saved && typeof saved.armed === 'boolean' && !entry.uncertain.has('armed');
    const labels = {
      disarmed: 'Охрана снята',
      exit_delay: 'Время на выход',
      armed: 'Под охраной',
      entry_delay: 'Время на снятие',
      alarm: 'Тревога',
    };
    const tile = byId('security-tile-status');
    tile.textContent = !entry.fresh
      ? 'Нет связи'
      : !saved?.enabled
        ? 'Модуль выключен'
        : labels[saved.phase] || 'Нет данных';
    tile.className = `badge ${!entry.fresh ? 'state-unknown' : saved?.phase === 'alarm' || saved?.inhibited ? 'state-error' : saved?.phase === 'entry_delay' ? 'security-entry-badge' : saved?.armed ? 'state-on' : 'state-off'}`;
    const tileAlarm = Boolean(entry.fresh && saved?.phase === 'alarm'),
      tileCard = document.querySelector('[data-controller-id="security"]');
    tileCard.classList.toggle('security-alarm', tileAlarm);
    tileCard
      .querySelector('.tile-icon use')
      .setAttribute('href', tileAlarm ? '#icon-security-alarm' : '#icon-security');
    const phase = known ? saved.phase : 'unknown';
    const pending =
      state.controllersAction?.controllerId === 'security' &&
      state.controllersAction?.kind === 'armed';
    context.renderControllerVisual(visual, {
      icon: phase === 'alarm' ? 'security-alarm' : 'security',
      tone: 'security',
      state: !known
        ? 'unknown'
        : saved.phase === 'alarm' || saved.inhibited
          ? 'error'
          : armed
            ? 'on'
            : 'off',
      pressed: known ? armed : 'mixed',
      pending,
      disabled:
        !known ||
        state.controllersBusy ||
        !context.controllersActive() ||
        (!armed && (!saved.readyToArm || state.dirty.has('security'))),
      label: known
        ? armed
          ? phase === 'alarm'
            ? 'Тревога. Нажмите, чтобы снять охрану'
            : 'Снять охрану'
          : 'Поставить на охрану'
        : 'Состояние охраны неизвестно',
      caption: labels[phase] || 'Нет данных',
      detail: pending
        ? 'Ожидаем подтверждения PLC'
        : !known
          ? 'Обновите состояние'
          : saved.remainingSeconds > 0
            ? `Осталось ${saved.remainingSeconds} с`
            : !armed && state.dirty.has('security')
              ? 'Сначала сохраните настройки'
              : !armed && saved.armBlockReason
                ? saved.armBlockReason
                : armed
                  ? 'Нажмите щит, чтобы снять охрану'
                  : 'Нажмите щит, чтобы поставить на охрану',
    });
    visual.dataset.phase = phase;
    const error = byId('security-arm-error');
    error.textContent = context.errorMessage(saved?.error);
    error.hidden = !error.textContent;
    context.controllerOptions(
      byId('security-siren'),
      saved?.ports.relays || [],
      common.sirenRelayId,
      entry,
      'siren',
      claims,
      true,
    );
    context.controllerOptions(
      byId('security-reader'),
      saved?.ports.sensors || [],
      common.readerPortId,
      entry,
      'reader',
      claims,
      true,
    );
    for (const [field, id] of Object.entries(commonFields)) {
      const control = byId(id);
      if (control.value !== String(common[field])) control.value = common[field];
      control.disabled = armed || state.controllersBusy;
    }
    byId('security-save').disabled ||= armed;
    byId('security-add').disabled ||= armed;
    byId('security-reader-status').textContent = !entry.fresh
      ? 'Считыватель: нет данных'
      : saved?.reader?.available === true
        ? `Считыватель готов${saved.reader.present ? ' · ключ приложен' : ''}`
        : `Считыватель: ${saved?.reader?.error || 'порт не настроен'}`;
    if (entry.fresh && saved?.hubSync?.version === 1)
      byId('security-reader-status').textContent += saved.hubSync.connected
        ? saved.hubSync.busy
          ? ' · хаб занят'
          : ' · таблетка управляет охраной всего дома'
        : ' · автономно: таблетка управляет только этим PLC';
    const scan = entry.scan,
      select = byId('security-key-address'),
      chosen = select.value;
    const addresses = (scan?.addresses || []).filter(validIbuttonAddress);
    if (select.dataset.addresses !== JSON.stringify(addresses)) {
      select.replaceChildren(
        new Option(addresses.length ? 'Выберите найденный ключ' : 'Сначала найдите ключ', ''),
      );
      for (const address of addresses) {
        const option = new Option(address.toUpperCase(), address.toLowerCase());
        option.disabled = common.keys.some(
          (key) => key.address.toLowerCase() === address.toLowerCase(),
        );
        select.add(option);
      }
      select.dataset.addresses = JSON.stringify(addresses);
      if (addresses.some((address) => address.toLowerCase() === chosen)) select.value = chosen;
    }
    for (const option of select.options)
      if (option.value)
        option.disabled = common.keys.some((key) => key.address.toLowerCase() === option.value);
    select.disabled = armed || state.controllersBusy || scan?.busy === true;
    byId('security-key-name').disabled = armed || state.controllersBusy;
    byId('security-key-scan').disabled =
      armed || state.controllersBusy || !common.readerPortId || scan?.busy === true;
    byId('security-key-scan').textContent = scan?.busy ? 'Поиск…' : 'Найти ключ';
    byId('security-key-add').disabled =
      armed ||
      state.controllersBusy ||
      common.keys.length >= 16 ||
      !byId('security-key-name').value.trim() ||
      !validIbuttonAddress(select.value) ||
      common.keys.some((key) => key.address.toLowerCase() === select.value);
    byId('security-key-scan-status').textContent = scan?.busy
      ? 'Идёт поиск iButton…'
      : scan?.error || scan?.complete
        ? scan?.error || addresses.length
          ? scan?.error || `Найдено ключей: ${addresses.length}`
          : 'Ключ не найден. Приложите его и повторите поиск.'
        : 'Поиск доступен при снятой охране.';
    if (entry.fresh && saved?.enrollmentRemainingSeconds > 0)
      byId('security-key-scan-status').textContent +=
        ` Режим добавления: ещё ${saved.enrollmentRemainingSeconds} с. Постановка ключом временно приостановлена.`;
    const keys = byId('security-keys-list');
    keys.replaceChildren();
    if (!common.keys.length)
      keys.append(element('p', 'muted', 'Разрешённые ключи ещё не добавлены.'));
    for (const key of common.keys) {
      const row = element('div', 'security-key-row'),
        copy = element('div');
      copy.append(element('strong', '', key.name), element('code', '', key.address.toUpperCase()));
      const remove = element('button', 'socket-remove', 'Удалить');
      remove.type = 'button';
      remove.dataset.securityKeyRemove = key.id;
      remove.disabled = armed || state.controllersBusy;
      remove.addEventListener('click', () => {
        entry.common.keys = entry.common.keys.filter((item) => item.id !== key.id);
        changed();
      });
      row.append(copy, remove);
      keys.append(row);
    }
  }
  function createSecurityCard(entry, item) {
    const card = element('article', 'socket-card security-zone-card');
    card.dataset.securityId = item.id;
    const visual = context.createControllerVisual();
    visual.dataset.securityVisual = '';
    const heading = element('div', 'socket-card-header'),
      remove = element('button', 'socket-remove', 'Удалить');
    remove.type = 'button';
    remove.dataset.securityRemove = item.id;
    remove.addEventListener('click', () => {
      if (state.controllersBusy || entry.snapshot?.armed) return;
      entry.draft = entry.draft.filter((row) => row.id !== item.id);
      changed();
    });
    heading.append(element('span', 'socket-number'), remove);
    card.append(visual, heading);
    for (const [field, label, tag] of [
      ['name', 'Название', 'input'],
      ['inputId', 'Цифровой вход', 'select'],
      ['sensorType', 'Тип датчика', 'select'],
    ]) {
      const input = element(tag);
      input.id = `security-${item.id}-${field}`;
      input.dataset.securityField = field;
      if (field === 'name') {
        input.maxLength = 64;
        input.required = true;
      }
      if (field === 'sensorType') {
        input.add(new Option('Геркон · нормально замкнут', 'reed'));
        input.add(new Option('Движение · замыкание при сработке', 'motion'));
      }
      const caption = element('label', '', label);
      caption.htmlFor = input.id;
      input.addEventListener(field === 'name' ? 'input' : 'change', () => {
        const draft = entry.draft.find((row) => row.id === item.id);
        if (draft) {
          draft[field] = input.value;
          changed();
        }
      });
      card.append(caption, input);
    }
    const label = element('label', 'checkbox-field'),
      delay = element('input');
    delay.type = 'checkbox';
    delay.dataset.securityField = 'entryDelay';
    delay.addEventListener('change', () => {
      const draft = entry.draft.find((row) => row.id === item.id);
      if (draft) {
        draft.entryDelay = delay.checked;
        changed();
      }
    });
    label.append(delay, element('span', '', 'Задержка входа'));
    card.append(label, element('p', 'hint security-zone-level'));
    return card;
  }
  function renderSecurityCard(card, entry, item, claims) {
    context.controllerOptions(
      card.querySelector('[data-security-field="inputId"]'),
      entry.snapshot?.ports.inputs || [],
      item.inputId,
      entry,
      item.id,
      claims,
    );
    const saved = entry.snapshot?.items.find((row) => row.id === item.id),
      bound =
        saved && ['inputId', 'sensorType', 'entryDelay'].every((key) => saved[key] === item[key]);
    const known =
      entry.fresh && bound && saved.available === true && typeof saved.active === 'boolean';
    const phase = !bound
      ? 'Назначение не сохранено'
      : !known
        ? 'Нет данных'
        : saved.active
          ? 'Тревога'
          : 'Норма';
    context.renderControllerVisual(card.querySelector('[data-security-visual]'), {
      icon: item.sensorType === 'motion' ? 'motion' : 'door',
      tone: 'security',
      state: !known ? 'unknown' : saved.active ? 'error' : 'on',
      caption: phase,
      number: `#${entry.draft.findIndex((row) => row.id === item.id) + 1}`,
      detail:
        item.sensorType === 'reed'
          ? 'Норма: замкнут · тревога: разомкнут'
          : 'Норма: разомкнут · тревога: замкнут',
    });
    card.querySelector('[data-security-field="sensorType"]').value = item.sensorType;
    card.querySelector('[data-security-field="entryDelay"]').checked = item.entryDelay;
    for (const input of card.querySelectorAll('input,select'))
      input.disabled = state.controllersBusy || entry.snapshot?.armed;
    card.querySelector('[data-security-remove]').disabled =
      state.controllersBusy || entry.snapshot?.armed;
    card.querySelector('.security-zone-level').textContent = !bound
      ? 'Сохраните назначение датчика'
      : !known
        ? context.errorMessage(saved?.error) || 'Ожидание достоверного входа'
        : `${saved.inputLevel ? 'HIGH · разомкнут' : 'LOW · замкнут'}${item.entryDelay ? ' · с задержкой входа' : ''}`;
  }
  return {
    securityCommonSettings,
    validIbuttonAddress,
    validateSecuritySettings,
    renderSecurity,
    createSecurityCard,
    renderSecurityCard,
    setSecurityArmed,
  };
}
