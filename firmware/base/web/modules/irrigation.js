/** @file Irrigation schedules with local or hub-discovered tanks. */
export function createIrrigationUI(context) {
  const { state, controllers } = context;
  const element = (...args) => context.hardwareElement(...args);
  const tanks = () => controllers.find((model) => model.isTank)?.snapshot?.items || [];
  const isRemoteTank = (id) =>
    typeof id === 'string' && /^fcplcn-[A-Za-z0-9_-]{1,97}\/[A-Za-z0-9_-]{1,32}$/.test(id);
  const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const weekdaysFull = [
    'Понедельник',
    'Вторник',
    'Среда',
    'Четверг',
    'Пятница',
    'Суббота',
    'Воскресенье',
  ];
  const settingsEqual = (model, left, right) =>
    right &&
    JSON.stringify(context.controllerSettings([left], model)) ===
      JSON.stringify(context.controllerSettings([right], model));

  function irrigationParametersValid(item) {
    return (
      (item.tankId === undefined ||
        isRemoteTank(item.tankId) ||
        (typeof item.tankId === 'string' && /^[a-zA-Z0-9_-]{0,32}$/.test(item.tankId))) &&
      typeof item.relayId === 'string' &&
      Array.isArray(item.days) &&
      item.days.length >= 1 &&
      item.days.length <= 7 &&
      item.days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7) &&
      new Set(item.days).size === item.days.length &&
      typeof item.startTime === 'string' &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(item.startTime) &&
      Number.isInteger(item.durationMinutes) &&
      item.durationMinutes >= 1 &&
      item.durationMinutes <= 1440
    );
  }

  function relayClaims(model, item, claims) {
    return claims.filter(
      (claim) =>
        claim.controllerId !== model.id ||
        (claim.ownerId !== item.id &&
          !model.draft.some((other) => other.id === claim.ownerId && other.tankId === item.tankId)),
    );
  }

  function newIrrigationBinding(model, claims) {
    const candidates = model.snapshot?.ports.relays || [];
    const relayId =
      candidates.find((id) => !claims.some((claim) => claim.portId === id)) ||
      model.draft.find((row) => !row.tankId && candidates.includes(row.relayId))?.relayId ||
      '';
    if (!relayId && !model.draft.some((row) => candidates.includes(row.relayId))) return null;
    return {
      relayId,
      tankId: '',
      days: [1, 2, 3, 4, 5, 6, 7],
      startTime: '06:00',
      durationMinutes: 10,
    };
  }

  function validateIrrigationSettings(model, items, claims) {
    const owners = new Map();
    for (const item of items) {
      if (!irrigationParametersValid(item))
        throw new Error(
          'Выберите дни полива, задайте время старта и длительность от 1 до 1440 минут.',
        );
      if (
        item.tankId &&
        !isRemoteTank(item.tankId) &&
        !tanks().some((tank) => tank.id === item.tankId)
      )
        throw new Error('Выберите сохранённый бак этого PLC.');
      if (
        !model.snapshot.ports.relays.includes(item.relayId) ||
        claims.some((claim) => claim.portId === item.relayId)
      )
        throw new Error('Выберите свободное реле крана полива.');
      if (owners.has(item.relayId) && owners.get(item.relayId) !== item.tankId)
        throw new Error('Выберите одинаковый источник воды для всех правил этого крана.');
      owners.set(item.relayId, item.tankId);
    }
  }

  function renderTankOptions(select, selected, catalogue) {
    const local = tanks().map(({ id, name }) => [id, name]);
    const remote = (Array.isArray(catalogue) ? catalogue : [])
      .filter(
        (tank) =>
          isRemoteTank(tank?.id) &&
          typeof tank.name === 'string' &&
          typeof tank.deviceName === 'string',
      )
      .map(({ id, name, deviceName }) => [id, `${name} · ${deviceName}`]);
    const group = isRemoteTank(selected) ? remote : local;
    if (selected && !group.some(([id]) => id === selected))
      group.push([selected, `${selected} · недоступен`]);

    const optionsKey = JSON.stringify([local, remote]);
    if (select.dataset.options !== optionsKey) {
      select.replaceChildren(new Option('Без бака', ''));
      for (const [label, options] of [
        ['На этом контроллере', local],
        ['На других контроллерах', remote],
      ]) {
        if (!options.length) continue;
        const category = document.createElement('optgroup');
        category.label = label;
        category.append(...options.map(([id, text]) => new Option(text, id)));
        select.append(category);
      }
      select.dataset.options = optionsKey;
    }
    if (select.value !== selected) select.value = selected;
  }

  function toggle(model, id) {
    const saved = model.snapshot?.items.find((row) => row.id === id);
    const draft = model.draft.find((row) => row.id === id);
    if (!model.fresh || !draft || !settingsEqual(model, draft, saved) || model.uncertain.has(id))
      return;
    const value = !saved.enabled;
    context.controllerCommand(model, 'item-enabled', id, async (version) => {
      const current = model.snapshot?.items.find((row) => row.id === id);
      if (!model.fresh || !settingsEqual(model, draft, current))
        throw new Error('Настройки правила изменились. Загрузите их ещё раз.');
      const reply = await context.post('/controllers/irrigation/enabled', { id, value });
      if (!state.authenticated || state.sessionVersion !== version) return;
      if (!reply.ok) throw new Error('PLC не подтвердил изменение правила.');
      model.errors.delete(id);
      context.acceptControllerSnapshot(model, reply);
      context.controllerNotice(
        model,
        value ? 'Правило полива включено.' : 'Правило полива выключено.',
        'success',
      );
    });
  }

  function createIrrigationCard(model, item) {
    const card = element('article', 'socket-card');
    card.dataset.irrigationId = item.id;
    const visual = context.createControllerVisual({
      interactive: true,
      onActivate: () => toggle(model, item.id),
    });
    visual.dataset.irrigationEnabled = item.id;
    const heading = element('div', 'socket-card-header');
    const remove = element('button', 'socket-remove', 'Удалить');
    remove.type = 'button';
    remove.dataset.irrigationRemove = item.id;
    remove.addEventListener('click', () => {
      if (state.controllersBusy) return;
      model.draft = model.draft.filter((row) => row.id !== item.id);
      context.dirty(model.dirtyKey);
      context.renderControllers();
    });
    heading.append(element('span', 'socket-number'), remove);
    card.append(visual, heading);
    const change = (field, value) => {
      const draft = model.draft.find((row) => row.id === item.id);
      if (!draft) return;
      draft[field] = value;
      context.dirty(model.dirtyKey);
      context.renderControllers();
    };
    for (const [field, label, type] of [
      ['name', 'Название', 'text'],
      ['tankId', 'Бак с водой (необязательно)', 'select'],
      ['relayId', 'Реле крана полива', 'select'],
      ['startTime', 'Время старта по часам PLC', 'time'],
      ['durationMinutes', 'Длительность, мин', 'number'],
    ]) {
      const input = document.createElement(type === 'select' ? 'select' : 'input');
      if (type !== 'select') input.type = type;
      if (field === 'name') input.maxLength = 64;
      if (field === 'durationMinutes') {
        input.min = 1;
        input.max = 1440;
        input.step = 1;
      }
      input.required = field !== 'tankId';
      input.id = `irrigation-${item.id}-${field}`;
      input.dataset.irrigationField = field;
      const caption = element('label', '', label);
      caption.htmlFor = input.id;
      input.addEventListener(type === 'select' ? 'change' : 'input', () =>
        change(field, input.value),
      );
      card.append(caption, input);
    }
    const days = element('fieldset', 'irrigation-weekdays');
    days.append(element('legend', '', 'Дни полива'));
    weekdays.forEach((day, i) => {
      const label = element('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.setAttribute('aria-label', weekdaysFull[i]);
      check.dataset.irrigationDay = String(i + 1);
      check.addEventListener('change', () =>
        change(
          'days',
          [...days.querySelectorAll('input:checked')].map((el) => Number(el.dataset.irrigationDay)),
        ),
      );
      label.append(check, element('span', '', day));
      days.append(label);
    });
    const error = element('p', 'field-error');
    error.dataset.irrigationError = '';
    error.setAttribute('role', 'status');
    card.append(days, error);
    return card;
  }

  function renderIrrigationCard(card, model, item, claims) {
    const saved = model.snapshot?.items.find((row) => row.id === item.id);
    const fresh = model.fresh && settingsEqual(model, item, saved) && !model.uncertain.has(item.id);
    const visual = card.querySelector('[data-irrigation-enabled]');
    const enabled = fresh && saved.enabled;
    const active = enabled && model.snapshot.enabled;
    const status = !fresh
      ? 'Нет подтверждения PLC'
      : !model.snapshot.enabled
        ? 'Модуль выключен'
        : !enabled
          ? 'Правило выключено'
          : saved.actual === true
            ? 'Идёт полив'
            : saved.tankId && saved.waterAvailable === false
              ? 'Бак пуст'
              : saved.tankId && saved.waterAvailable !== true
                ? 'Нет данных о воде'
                : saved.error
                  ? 'Полив приостановлен'
                  : 'По расписанию';
    context.renderControllerVisual(visual, {
      icon: 'irrigation',
      tone: 'sensor',
      state: !fresh ? 'unknown' : active && saved.error ? 'error' : enabled ? 'on' : 'off',
      disabled: !fresh || state.controllersBusy || !context.controllersActive(),
      pressed: fresh ? saved.enabled : 'mixed',
      label: `${enabled ? 'Выключить' : 'Включить'} правило полива ${item.name}`,
      caption: status,
      detail: !fresh
        ? 'Сохраните настройки или дождитесь связи'
        : saved.actual && Number.isFinite(saved.remainingSeconds)
          ? `Осталось ${Math.ceil(saved.remainingSeconds / 60)} мин`
          : 'Нажатие переключает расписание',
    });
    const field = (name) => card.querySelector(`[data-irrigation-field="${name}"]`);
    renderTankOptions(field('tankId'), item.tankId || '', model.remoteTanks);
    context.controllerOptions(
      field('relayId'),
      model.snapshot.ports.relays,
      item.relayId,
      model,
      item.id,
      relayClaims(model, item, claims),
    );
    for (const name of ['startTime', 'durationMinutes'])
      if (field(name).value !== String(item[name])) field(name).value = item[name];
    for (const input of card.querySelectorAll('[data-irrigation-day]'))
      input.checked = item.days.includes(Number(input.dataset.irrigationDay));
    for (const input of card.querySelectorAll('input,select'))
      input.disabled = state.controllersBusy;
    const error = card.querySelector('[data-irrigation-error]');
    error.textContent =
      model.errors.get(item.id) || (fresh && context.errorMessage(saved.error)) || '';
    error.hidden = !error.textContent;
  }
  return {
    irrigationParametersValid,
    newIrrigationBinding,
    validateIrrigationSettings,
    createIrrigationCard,
    renderIrrigationCard,
  };
}
