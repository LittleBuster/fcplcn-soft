/** @file Autonomous tank fixture: board-normalized contacts, discrete levels and safe derived outputs. */
'use strict';

function validateTank(module, ports, states = false) {
  if (
    !module ||
    typeof module.enabled !== 'boolean' ||
    !Array.isArray(module.items) ||
    module.items.length > 16
  )
    return 'Некорректные настройки баков';
  const seen = new Set();
  for (const item of module.items) {
    if (
      !item ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(item.id) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      Buffer.byteLength(item.name) > 64 ||
      /[\x00-\x1f\x7f]/.test(item.name) ||
      seen.has(item.id)
    )
      return 'Некорректное имя или идентификатор бака';
    seen.add(item.id);
    const allowed = [
      'id',
      'name',
      'pumpRelayId',
      'valveRelayId',
      'levelInputs',
      'fillLevel',
      ...(states ? ['enabled'] : []),
    ];
    if (
      Object.keys(item).some((key) => !allowed.includes(key)) ||
      (states ? typeof item.enabled !== 'boolean' : 'enabled' in item)
    )
      return 'Неизвестное поле бака';
    if (
      !Array.isArray(item.levelInputs) ||
      item.levelInputs.length < 1 ||
      item.levelInputs.length > 3 ||
      item.levelInputs.some((id) => !ports.inputs.includes(id)) ||
      !Number.isInteger(item.fillLevel) ||
      item.fillLevel < 1 ||
      item.fillLevel > item.levelInputs.length
    )
      return 'Выберите от одного до трёх входов уровня и порог крана';
    if (
      [item.pumpRelayId, item.valveRelayId].some(
        (id) => typeof id !== 'string' || (id && !ports.relays.includes(id)),
      )
    )
      return 'Некорректное реле бака';
    const bindings = [item.pumpRelayId, item.valveRelayId, ...item.levelInputs].filter(Boolean);
    if (new Set(bindings).size !== bindings.length) return 'Дублирование портов бака';
  }
  return '';
}

function createTanksMock({ hardware, configuration, resources, inhibited }) {
  const runtime = new Map();
  const binding = (item) =>
    JSON.stringify([item.pumpRelayId, item.valveRelayId, item.levelInputs, item.fillLevel]);
  function reset() {
    for (const row of runtime.values())
      for (const id of row.outputs) if (id) hardware.driveRelay(id, false);
    runtime.clear();
  }
  function step() {
    const module = configuration();
    for (const [id, row] of runtime)
      if (!module.items.some((item) => item.id === id)) {
        for (const output of row.outputs) if (output) hardware.driveRelay(output, false);
        runtime.delete(id);
      }
    for (const item of module.items) {
      const key = binding(item);
      let row = runtime.get(item.id);
      if (!row || row.binding !== key) {
        if (row) for (const id of row.outputs) if (id) hardware.driveRelay(id, false);
        row = {
          binding: key,
          outputs: [item.pumpRelayId, item.valveRelayId],
          candidate: '',
          since: null,
          samples: 0,
          sampleAt: -1,
          acceptedWet: null,
        };
        runtime.set(item.id, row);
        for (const id of row.outputs) if (id) hardware.driveRelay(id, false);
      }
      const io = hardware.snapshot();
      const inputs = item.levelInputs.map((id) => io.inputs.find((input) => input.id === id));
      const wet = inputs.map((input) =>
        input?.valid && typeof input.active === 'boolean' ? input.active : null,
      );
      const contactsKnown = wet.every((value) => typeof value === 'boolean');
      const prefixValid =
        contactsKnown &&
        !wet.some((value, index) => value && wet.slice(0, index).some((lower) => !lower));
      const active = module.enabled && item.enabled;
      const clash = resources().some(
        (resource) =>
          resource.conflict && [...row.outputs, ...item.levelInputs].includes(resource.id),
      );
      const observedOutputs = row.outputs.map((id) => io.relays.find((relay) => relay.id === id));
      const outputsKnown = observedOutputs.every(
        (relay, index) => !row.outputs[index] || (relay?.valid && typeof relay.value === 'boolean'),
      );
      let error = inhibited(item.id)
        ? 'Режим не сохранён; выходы заблокированы'
        : clash
          ? 'Конфликт назначений портов'
          : !contactsKnown
            ? 'Цифровой вход уровня недоступен'
            : !prefixValid
              ? 'Неверная последовательность датчиков: верхний в воде, нижний сухой'
              : !outputsKnown
                ? 'Нет свежих данных реле бака'
                : null;
      const resetBaseline = () => {
        row.candidate = '';
        row.since = null;
        row.samples = 0;
        row.sampleAt = -1;
        row.acceptedWet = null;
      };
      const drive = (desired) => {
        let failed = '';
        row.outputs.forEach((id, index) => {
          if (!id) return;
          const relay = hardware.snapshot().relays.find((entry) => entry.id === id);
          if (relay?.valid && relay.value === desired[index]) return;
          const failure = hardware.driveRelay(id, desired[index]);
          failed ||= failure;
        });
        return failed;
      };
      let healthy = false;
      if (!active || error) {
        resetBaseline();
        error ||= drive([false, false]) || null;
        // Every safety path attempts OFF, even when a diagnostic already exists.
        if (error) drive([false, false]);
      } else {
        const now = Date.now();
        const candidate = JSON.stringify(wet);
        if (candidate !== row.candidate || row.since === null) {
          row.candidate = candidate;
          row.since = now;
          row.samples = 0;
        }
        // Simulated hardware polls at 10ms; repeated snapshots in one poll cannot
        // manufacture the three distinct observations required by the PLC.
        const sampleAt = Math.floor(now / 10);
        if (sampleAt !== row.sampleAt) {
          row.sampleAt = sampleAt;
          row.samples++;
        }
        const stable = row.samples >= 3 && now - row.since >= 50;
        const desired = stable
          ? [wet[0], !wet[item.fillLevel - 1]]
          : [
              Boolean(row.acceptedWet?.[0] && wet[0] && observedOutputs[0]?.value),
              Boolean(
                row.acceptedWet &&
                !row.acceptedWet[item.fillLevel - 1] &&
                !wet[item.fillLevel - 1] &&
                observedOutputs[1]?.value,
              ),
            ];
        error = drive(desired) || null;
        if (error) {
          resetBaseline();
          drive([false, false]);
        } else if (stable) {
          row.acceptedWet = [...wet];
          healthy = true;
        } else error = 'Ожидается подтверждение датчиков уровня';
      }
      const after = hardware.snapshot();
      const actual = (id) => {
        const relay = after.relays.find((entry) => entry.id === id);
        return relay?.valid && typeof relay.value === 'boolean' ? relay.value : null;
      };
      // An upper contact changing leaves an already-confirmed wet bottom usable.
      // A dry bottom cuts permission immediately, before the level has settled.
      row.irrigationWater = row.acceptedWet ? Boolean(row.acceptedWet[0] && wet[0]) : null;
      row.value = {
        available: Boolean(healthy && !error),
        levelsWet: healthy && !error ? wet : wet.map(() => null),
        levelPct:
          healthy && !error ? Math.round((100 * wet.filter(Boolean).length) / wet.length) : null,
        pumpActual: actual(item.pumpRelayId),
        valveActual: actual(item.valveRelayId),
        error: active ? error : null,
      };
    }
  }
  function snapshot() {
    step();
    const module = configuration(),
      io = hardware.snapshot();
    return {
      revision: module.revision,
      enabled: module.enabled,
      ports: { relays: io.relays.map((row) => row.id), inputs: io.inputs.map((row) => row.id) },
      items: module.items.map((item) => ({ ...item, ...runtime.get(item.id)?.value })),
    };
  }
  function waterForIrrigation() {
    step();
    return new Map([...runtime].map(([id, row]) => [id, row.irrigationWater]));
  }
  return { step, snapshot, reset, waterForIrrigation };
}
module.exports = { createTanksMock, validateTank };
