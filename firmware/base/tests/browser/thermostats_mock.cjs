/**
 * @file thermostats_mock.cjs
 * @brief Model local thermostat freshness and minimum-cycle protection without saving demand.
 */
'use strict';
const { performance } = require('node:perf_hooks');
const { thermostatMinimumCycleSeconds } = require('./thermostat_policy.cjs');

/** @brief Evaluate local samples and confirmed outputs using a monotonic virtual runtime clock. */
function createThermostatsMock({
  hardware,
  configuration,
  observation,
  inhibited,
  persistenceError,
}) {
  const runtime = new Map();
  let offset = 0;
  const now = () => performance.now() + offset;
  function step() {
    const module = configuration(),
      time = now();
    for (const id of runtime.keys())
      if (!module.items.some((item) => item.id === id)) runtime.delete(id);
    for (const item of module.items) {
      const binding = `${item.meteoId}/${item.relayId}/${item.mode}`;
      let state = runtime.get(item.id);
      if (!state || state.binding !== binding) {
        state = {
          binding,
          state: false,
          generation: null,
          blockedSequence: -1,
          waiting: false,
          confirmed: null,
          transitionAt: time,
          cached: null,
        };
        runtime.set(item.id, state);
        hardware.driveRelay(item.relayId, false);
      }
      // A binding reset above has already confirmed OFF; never reuse its pre-reset readback
      // as an ON epoch and accidentally apply minimum ON to the required safety transition.
      const relay = hardware.snapshot().relays.find((entry) => entry.id === item.relayId);
      const relayKnown = relay?.valid === true && typeof relay.value === 'boolean';
      if (relayKnown && state.confirmed !== relay.value) {
        state.confirmed = relay.value;
        state.transitionAt = time;
      }
      const source = observation(item.meteoId);
      if (source && state.generation !== source.generation) {
        state.state = false;
        state.waiting = false;
        state.blockedSequence = -1;
        state.generation = source.generation;
        state.cached = null;
      }
      const directHealthy =
        source?.enabled &&
        !source.readFailed &&
        source.available &&
        source.postChangeSample &&
        Number.isFinite(source.temperatureC) &&
        Number.isFinite(source.ageMs) &&
        source.ageMs <= 15000;
      if (directHealthy)
        state.cached = {
          temperatureC: source.temperatureC,
          sequence: source.sequence,
          sampleAt: time - source.ageMs,
        };
      const cachedHealthy =
        source?.enabled &&
        source?.readFailed &&
        state.cached &&
        time - state.cached.sampleAt <= 15000 &&
        time >= state.cached.sampleAt;
      state.usingCachedTemperature = Boolean(cachedHealthy);
      const sample = cachedHealthy ? state.cached : directHealthy ? source : null;
      state.temperatureC = sample?.temperatureC ?? null;
      state.holdReason = '';
      state.holdRemainingSeconds = 0;
      const forceOff =
        !module.enabled || !item.enabled || inhibited(item.id) || !sample || !relayKnown;
      if (forceOff) {
        state.state = false;
        state.waiting = true;
        state.blockedSequence = source?.sequence ?? -1;
        if (!relayKnown) state.confirmed = null;
        state.error = inhibited(item.id)
          ? persistenceError(item.id) || 'Режим не сохранён; выход заблокирован'
          : !module.enabled
            ? 'Модуль выключен'
            : !item.enabled
              ? null
              : !relayKnown
                ? 'Выход недоступен'
                : !source
                  ? 'Метеоточка удалена или недоступна'
                  : 'Датчик недоступен или данные устарели';
      } else if (state.waiting && sample.sequence <= state.blockedSequence) {
        state.state = false;
        state.error = 'Ожидается новое измерение после восстановления';
      } else {
        state.waiting = false;
        state.error = null;
        let desired = state.state;
        const temperature = sample.temperatureC;
        if (item.mode === 'heating') {
          if (temperature <= item.setpointC - item.hysteresisC) desired = true;
          else if (temperature >= item.setpointC) desired = false;
        } else {
          if (temperature >= item.setpointC + item.hysteresisC) desired = true;
          else if (temperature <= item.setpointC) desired = false;
        }
        if (desired !== state.confirmed) {
          const duration = thermostatMinimumCycleSeconds * 1000;
          const remaining = Math.max(0, duration - (time - state.transitionAt));
          if (remaining > 0) {
            desired = state.confirmed;
            state.holdReason = desired ? 'minimum_on' : 'minimum_off';
            state.holdRemainingSeconds = Math.ceil(remaining / 1000);
          }
        }
        state.state = desired;
      }
      const error = hardware.driveRelay(item.relayId, state.state);
      if (error) {
        state.state = false;
        state.confirmed = null;
        state.error = error;
      } else if (state.confirmed !== state.state) {
        state.confirmed = state.state;
        state.transitionAt = time;
      }
    }
  }
  return {
    step,
    /** @brief Advance only monotonic cycle protection for deterministic simulator checks. */
    advanceTime(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0)
        throw new Error('Invalid virtual duration');
      offset += milliseconds;
      step();
    },
    snapshot() {
      const module = configuration(),
        io = hardware.snapshot();
      return {
        revision: module.revision,
        enabled: module.enabled,
        ports: {
          relays: io.relays.map((relay) => relay.id),
          inputs: io.inputs.map((input) => input.id),
        },
        items: module.items.map((item) => {
          const source = observation(item.meteoId),
            state = runtime.get(item.id),
            relay = io.relays.find((channel) => channel.id === item.relayId);
          const sensorAvailable = Boolean(state && state.temperatureC !== null && !state.waiting);
          const input = item.inputId
            ? io.inputs.find((channel) => channel.id === item.inputId)
            : null;
          const inputAvailable = Boolean(input?.valid && typeof input.value === 'boolean');
          return {
            ...item,
            inhibited: inhibited(item.id),
            inputLevel: inputAvailable ? input.value : null,
            inputAvailable,
            inputError: item.inputId && !inputAvailable ? input?.error || 'Вход недоступен' : null,
            sensorName: source?.name || '',
            temperatureC: sensorAvailable ? state.temperatureC : null,
            state: state?.state || false,
            actual: relay?.valid ? relay.value : null,
            sensorAvailable,
            holdReason: state?.holdReason || '',
            holdRemainingSeconds: state?.holdRemainingSeconds || 0,
            usingCachedTemperature: state?.usingCachedTemperature || false,
            available: Boolean(
              module.enabled &&
              item.enabled &&
              !inhibited(item.id) &&
              sensorAvailable &&
              relay?.valid,
            ),
            error: state?.error || (!sensorAvailable && item.enabled ? 'Датчик недоступен' : null),
          };
        }),
      };
    },
    reset() {
      for (const item of configuration().items) hardware.driveRelay(item.relayId, false);
      runtime.clear();
    },
    resetItem(id) {
      const item = configuration().items.find((item) => item.id === id);
      if (item) hardware.driveRelay(item.relayId, false);
      runtime.delete(id);
    },
  };
}
module.exports = { createThermostatsMock };
