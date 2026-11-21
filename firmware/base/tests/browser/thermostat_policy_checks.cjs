/** @file thermostat_policy_checks.cjs @brief Deterministically check local cycle holds and sample reuse. */
'use strict';
const assert = require('node:assert/strict');

/** @brief Exercise fixed 60-second holds, immediate safety OFF and bounded last-sample reuse. */
async function checkThermostatPolicy({ createMock }) {
  const mock = createMock();
  const module = mock.thermostats;
  const state = () => module.snapshot().items[0];
  const advance = (milliseconds) => mock.controllers.advanceThermostatTime(milliseconds);
  try {
    assert.equal(
      (
        await mock.meteo.save({
          baseRevision: 1,
          enabled: true,
          items: [
            { id: 'room', name: 'Room', portId: 'sens-0/1', sensorType: 'dht22', address: '' },
          ],
        })
      ).status,
      200,
    );
    mock.setMeteoTemperature('room', 20);
    const item = {
      id: 'heat',
      name: 'Heat',
      meteoId: 'room',
      relayId: 'rly-0/1',
      inputId: '',
      mode: 'heating',
      setpointC: 22,
      hysteresisC: 1,
      minOnSeconds: 2,
      minOffSeconds: 3,
    };
    assert.equal(
      (await module.save({ baseRevision: 1, enabled: true, items: [item] })).status,
      200,
    );
    assert.equal((await module.enabled({ id: 'heat', value: true })).status, 200);
    assert.equal(state().actual, false, 'Startup imposes minimum OFF after confirmed OFF');
    assert.equal(state().holdReason, 'minimum_off');
    advance(58000);
    assert.equal(state().actual, false);
    advance(2100);
    assert.equal(state().actual, true);
    mock.setMeteoTemperature('room', 22);
    assert.equal(state().actual, true, 'Ordinary threshold OFF waits for minimum ON');
    assert.equal(state().holdReason, 'minimum_on');
    advance(58000);
    assert.equal(state().actual, true);
    advance(2100);
    assert.equal(state().actual, false);
    mock.setMeteoTemperature('room', 20);
    assert.equal(state().actual, false);
    advance(60001);
    assert.equal(state().actual, true);
    assert.equal((await module.enabled({ id: 'heat', value: false })).status, 200);
    assert.equal(state().actual, false, 'Explicit disable overrides minimum ON immediately');
    assert.equal((await module.enabled({ id: 'heat', value: true })).status, 200);
    advance(60001);
    assert.equal(state().actual, true);
    mock.setMeteoFault('sens-0/1', 'Sensor disconnected');
    mock.controllers.tick();
    assert.equal(state().actual, false, 'A hard sensor fault bypasses minimum ON');
    mock.setMeteoFault('sens-0/1', '');
    mock.setMeteoTemperature('room', 20);
    advance(60001);
    assert.equal(state().actual, true);
    mock.controllers.setMeteoReadFailure('room', true);
    mock.controllers.tick();
    assert.equal(state().actual, true, 'Transient snapshot failure reuses a fresh prior sample');
    assert.equal(state().usingCachedTemperature, true);
    advance(16000);
    assert.equal(state().actual, false, 'A cached sample cannot outlive freshness');
    assert.equal(state().sensorAvailable, false);
    mock.controllers.setMeteoReadFailure('room', false);
    mock.setMeteoTemperature('room', 20);
    for (const value of [-1, 1.5, 86401]) {
      const request = {
        baseRevision: module.snapshot().revision,
        enabled: true,
        items: [{ ...item, minOffSeconds: value }],
      };
      assert.equal((await module.save(request)).status, 400);
    }
    assert.equal(
      (
        await module.save({
          baseRevision: module.snapshot().revision,
          enabled: true,
          items: [{ ...item, mode: 'cooling', minOnSeconds: undefined, minOffSeconds: undefined }],
        })
      ).status,
      200,
    );
    assert.equal('minOnSeconds' in state(), false);
    assert.equal('minOffSeconds' in state(), false);
    mock.setMeteoTemperature('room', 24);
    assert.equal(state().actual, false, 'Cooling uses the same fixed minimum OFF');
    advance(58000);
    assert.equal(state().actual, false);
    advance(2100);
    assert.equal(state().actual, true);
    mock.setMeteoTemperature('room', 22);
    assert.equal(state().actual, true, 'Cooling also uses fixed minimum ON');
    advance(60001);
    assert.equal(state().actual, false);
    mock.setMeteoTemperature('room', 24);
    advance(60001);
    assert.equal(state().actual, true);
    assert.equal(
      (
        await module.save({
          baseRevision: module.snapshot().revision,
          enabled: true,
          items: [{ ...item, mode: 'heating' }],
        })
      ).status,
      200,
    );
    assert.equal(state().actual, false, 'Changing a binding/mode confirms OFF without minimum ON');
  } finally {
    mock.controllers.close();
  }
}
module.exports = { checkThermostatPolicy };
