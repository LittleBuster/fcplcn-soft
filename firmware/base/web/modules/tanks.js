/** @file tanks.js @brief Local water monitoring, automatic outputs and cylindrical tank display. */
export function createTanksUI(context) {
  const { state } = context;
  const element = (...args) => context.hardwareElement(...args);
  let visualSequence = 0;
  const labelFor = (index, count) =>
    count === 1
      ? 'Датчик уровня'
      : index === 0
        ? 'Нижний уровень'
        : index === count - 1
          ? 'Верхний уровень'
          : 'Средний уровень';
  const settingsEqual = (model, item, saved) =>
    Boolean(saved) &&
    JSON.stringify(context.controllerSettings([item], model)) ===
      JSON.stringify(context.controllerSettings([saved], model));

  /** @brief Default two ordered local digital contacts; outputs can be assigned after monitoring. */
  function newTankBinding(model, claims) {
    const inputs = (model.snapshot?.ports.inputs || []).filter(
      (id) => !claims.some((claim) => claim.portId === id),
    );
    if (!inputs.length) return null;
    return {
      pumpRelayId: '',
      valveRelayId: '',
      levelInputs: [inputs[0], inputs[1] || ''],
      fillLevel: 2,
    };
  }

  function createTankCard(model, item) {
    const card = element('article', 'socket-card tank-card');
    card.dataset.tankId = item.id;
    const visual = element('button', 'controller-visual tank-visual');
    visual.type = 'button';
    visual.dataset.tone = 'sensor';
    visual.dataset.tankEnabled = item.id;
    visual.addEventListener('click', () => setTankEnabled(model, item.id));
    const art = element('span', 'tank-art');
    const clip = `tank-water-${++visualSequence}`;
    // Trusted, fixed SVG geometry. API names and percentages are never inserted as HTML.
    art.innerHTML = `<svg viewBox="0 0 200 220" aria-hidden="true" focusable="false"><defs><clipPath id="${clip}"><path d="M40 35C40 9 160 9 160 35V185C160 211 40 211 40 185Z"/></clipPath></defs><path class="tank-shell" d="M40 35C40 9 160 9 160 35V185C160 211 40 211 40 185Z"/><g clip-path="url(#${clip})" class="tank-water"><rect data-tank-water x="40" y="185" width="120" height="20"/><ellipse data-tank-surface cx="100" cy="185" rx="60" ry="20"/></g><path class="tank-outline" d="M40 35V185C40 211 160 211 160 185V35M40 35C40 61 160 61 160 35C160 9 40 9 40 35Z"/><path class="tank-reflection" d="M53 65V175"/></svg>`;
    const percentage = element('strong', 'tank-percentage', '—');
    percentage.dataset.tankPercentage = '';
    const caption = element('span', 'tank-caption', 'Мониторинг выключен');
    caption.dataset.tankStatus = '';
    visual.append(art, percentage, caption);
    const heading = element('div', 'socket-card-header');
    const remove = element('button', 'socket-remove', 'Удалить');
    remove.type = 'button';
    remove.dataset.tankRemove = item.id;
    remove.addEventListener('click', () => {
      if (state.controllersBusy) return;
      model.draft = model.draft.filter((entry) => entry.id !== item.id);
      context.dirty(model.dirtyKey);
      context.renderControllers();
    });
    heading.append(element('span', 'socket-number'), remove);
    card.append(visual, heading);
    for (const [field, label, tag] of [
      ['name', 'Название', 'input'],
      ['pumpRelayId', 'Реле откачивающего насоса', 'select'],
      ['valveRelayId', 'Реле крана наполнения', 'select'],
      ['levelCount', 'Количество датчиков уровня', 'select'],
    ]) {
      const input = document.createElement(tag);
      input.id = `tank-${item.id}-${field}`;
      input.dataset.tankField = field;
      if (field === 'name') {
        input.maxLength = 64;
        input.required = true;
        input.autocomplete = 'off';
      }
      if (field === 'levelCount')
        for (let count = 1; count <= 3; count++)
          input.add(new Option(String(count), String(count)));
      const labelElement = element('label', '', label);
      labelElement.htmlFor = input.id;
      input.addEventListener(tag === 'input' ? 'input' : 'change', () => {
        const draft = model.draft.find((entry) => entry.id === item.id);
        if (!draft) return;
        if (field === 'levelCount') {
          const count = Number(input.value);
          draft.levelInputs = Array.from(
            { length: count },
            (_, index) => draft.levelInputs[index] || '',
          );
          draft.fillLevel = Math.min(draft.fillLevel, count);
        } else draft[field] = input.value;
        context.dirty(model.dirtyKey);
        context.renderControllers();
      });
      card.append(labelElement, input);
    }
    const levels = element('div', 'tank-level-fields');
    levels.dataset.tankLevels = '';
    const fill = document.createElement('select');
    fill.dataset.tankField = 'fillLevel';
    fill.id = `tank-${item.id}-fillLevel`;
    fill.addEventListener('change', () => {
      const draft = model.draft.find((entry) => entry.id === item.id);
      if (!draft) return;
      draft.fillLevel = Number(fill.value);
      context.dirty(model.dirtyKey);
      context.renderControllers();
    });
    const fillLabel = element('label', '', 'Закрывать кран при достижении уровня');
    fillLabel.htmlFor = fill.id;
    const hint = element(
      'p',
      'hint',
      'Датчики замыкаются в воде. Насос откачки работает, пока нижний датчик в воде. Кран открыт ниже выбранного уровня и закрыт на нём. Проценты — дискретная оценка по числу датчиков.',
    );
    const outputs = element('p', 'tank-outputs');
    outputs.dataset.tankOutputs = '';
    const error = element('p', 'field-error');
    error.dataset.tankError = '';
    error.setAttribute('role', 'status');
    card.append(levels, fillLabel, fill, hint, outputs, error);
    return card;
  }

  function renderTankCard(card, model, item, claims) {
    const saved = model.snapshot?.items.find((entry) => entry.id === item.id);
    const bound = settingsEqual(model, item, saved);
    const fresh = model.fresh && bound && !model.uncertain.has(item.id);
    const active = fresh && model.snapshot.enabled && saved.enabled;
    const known = active && saved.available === true && Number.isFinite(saved.levelPct);
    const visual = card.querySelector('[data-tank-enabled]');
    visual.disabled = !fresh || state.controllersBusy || !context.controllersActive();
    visual.setAttribute('aria-pressed', fresh ? String(saved.enabled) : 'mixed');
    visual.setAttribute(
      'aria-label',
      `${fresh && saved.enabled ? 'Выключить' : 'Включить'} мониторинг бака ${item.name}`,
    );
    visual.dataset.state = !fresh
      ? 'unknown'
      : saved.error && active
        ? 'error'
        : active
          ? 'on'
          : 'off';
    const pct = known ? Math.max(0, Math.min(100, saved.levelPct)) : null;
    card.querySelector('[data-tank-percentage]').textContent = pct === null ? '—' : `${pct} %`;
    card.querySelector('[data-tank-status]').textContent = !fresh
      ? 'Сохраните настройки или дождитесь связи'
      : !model.snapshot.enabled
        ? 'Модуль выключен'
        : !saved.enabled
          ? 'Мониторинг выключен'
          : !known
            ? 'Нет достоверного уровня'
            : pct === 0
              ? 'Воды нет · насос выключен'
              : pct === 100
                ? 'Бак заполнен'
                : 'Уровень воды';
    const water = card.querySelector('.tank-water');
    water.style.opacity = pct === null || pct === 0 ? '0' : '1';
    const y = 185 - (pct || 0) * 1.5;
    card.querySelector('[data-tank-water]').setAttribute('y', String(y));
    card.querySelector('[data-tank-water]').setAttribute('height', String(205 - y));
    card.querySelector('[data-tank-surface]').setAttribute('cy', String(y));
    for (const field of ['pumpRelayId', 'valveRelayId']) {
      const select = card.querySelector(`[data-tank-field="${field}"]`);
      context.controllerOptions(
        select,
        model.snapshot.ports.relays,
        item[field],
        model,
        item.id,
        claims,
        true,
      );
      select.options[0].textContent = 'Не используется';
    }
    card.querySelector('[data-tank-field="levelCount"]').value = String(item.levelInputs.length);
    const levels = card.querySelector('[data-tank-levels]');
    if (levels.children.length !== item.levelInputs.length) {
      levels.replaceChildren();
      item.levelInputs.forEach((_, index) => {
        const wrapper = element('div', 'tank-level-field');
        const label = element('label', '', labelFor(index, item.levelInputs.length));
        const select = document.createElement('select');
        select.id = `tank-${item.id}-level-${index}`;
        select.dataset.tankLevelIndex = String(index);
        label.htmlFor = select.id;
        select.addEventListener('change', () => {
          const draft = model.draft.find((entry) => entry.id === item.id);
          if (!draft) return;
          draft.levelInputs[index] = select.value;
          context.dirty(model.dirtyKey);
          context.renderControllers();
        });
        const state = element('span', 'hint');
        state.dataset.tankLevelState = String(index);
        wrapper.append(label, select, state);
        levels.append(wrapper);
      });
    }
    item.levelInputs.forEach((inputId, index) => {
      const select = levels.querySelector(`[data-tank-level-index="${index}"]`);
      context.controllerOptions(
        select,
        model.snapshot.ports.inputs,
        inputId,
        model,
        item.id,
        claims,
      );
      select.options[0].textContent = 'Выберите цифровой вход';
      const wet = fresh && active ? saved.levelsWet?.[index] : null;
      levels.querySelector(`[data-tank-level-state="${index}"]`).textContent =
        typeof wet === 'boolean'
          ? wet
            ? 'В воде · контакт замкнут'
            : 'Сухо · контакт разомкнут'
          : 'Нет данных';
    });
    const fill = card.querySelector('[data-tank-field="fillLevel"]');
    if (fill.options.length !== item.levelInputs.length) {
      fill.replaceChildren();
      item.levelInputs.forEach((_, index) =>
        fill.add(new Option(labelFor(index, item.levelInputs.length), String(index + 1))),
      );
    }
    fill.value = String(item.fillLevel);
    for (const input of card.querySelectorAll('input,select'))
      input.disabled = state.controllersBusy;
    const output = (id, value) =>
      !id
        ? 'не назначен'
        : fresh && typeof value === 'boolean'
          ? value
            ? 'включён'
            : 'выключен'
          : 'нет подтверждения';
    card.querySelector('[data-tank-outputs]').textContent =
      `Насос откачки: ${output(item.pumpRelayId, saved?.pumpActual)}. Кран наполнения: ${output(item.valveRelayId, saved?.valveActual)}.`;
    const error = card.querySelector('[data-tank-error]');
    error.textContent =
      model.errors.get(item.id) || (fresh ? context.errorMessage(saved.error) : '');
    error.hidden = !error.textContent;
  }

  function validateTankSettings(model, items, claims) {
    const all = [...claims];
    for (const item of items) {
      if (
        !Array.isArray(item.levelInputs) ||
        item.levelInputs.length < 1 ||
        item.levelInputs.length > 3 ||
        !Number.isInteger(item.fillLevel) ||
        item.fillLevel < 1 ||
        item.fillLevel > item.levelInputs.length
      )
        throw new Error('Выберите от одного до трёх датчиков и уровень закрытия крана.');
      if (item.levelInputs.some((id) => !model.snapshot.ports.inputs.includes(id)))
        throw new Error('Выберите цифровой вход для каждого уровня.');
      const ports = [item.pumpRelayId, item.valveRelayId].filter(Boolean);
      if (ports.some((id) => !model.snapshot.ports.relays.includes(id)))
        throw new Error('Выберите доступные реле насоса и крана.');
      const ids = [...ports, ...item.levelInputs];
      if (new Set(ids).size !== ids.length)
        throw new Error('Каждому реле и уровню нужен отдельный порт.');
      for (const id of ids) {
        if (all.some((claim) => claim.portId === id))
          throw new Error(`Порт ${id} уже занят. Сначала освободите его у владельца.`);
        all.push({ portId: id, controllerId: model.id, ownerId: item.id, name: item.name });
      }
    }
  }

  function setTankEnabled(model, id) {
    const saved = model.snapshot?.items.find((item) => item.id === id);
    const draft = model.draft.find((item) => item.id === id);
    if (
      !model.fresh ||
      !saved ||
      !draft ||
      !settingsEqual(model, draft, saved) ||
      model.uncertain.has(id)
    )
      return;
    const target = !saved.enabled;
    context.controllerCommand(model, 'item-enabled', id, async (sessionVersion) => {
      const response = await context.post('/controllers/tanks/enabled', { id, value: target });
      if (!state.authenticated || state.sessionVersion !== sessionVersion) return;
      if (response.ok !== true) throw new Error('PLC не подтвердил режим мониторинга бака.');
      context.acceptControllerSnapshot(model, response);
      context.controllerNotice(
        model,
        `Мониторинг бака ${target ? 'включён' : 'выключен'}.`,
        'success',
      );
    });
  }
  return { newTankBinding, createTankCard, renderTankCard, validateTankSettings, setTankEnabled };
}
