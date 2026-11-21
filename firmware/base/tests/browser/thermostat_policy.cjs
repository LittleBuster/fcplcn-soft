/** @file thermostat_policy.cjs @brief Fixed simulated cycle protection and legacy field migration. */
'use strict';
const thermostatMinimumCycleSeconds = 60;
/** @brief Validate deprecated configurable fields before deliberately discarding them. */
function validLegacyThermostatDurations(item, required = false) {
  return ['minOnSeconds', 'minOffSeconds'].every(
    (field) =>
      (!required && item[field] === undefined) ||
      (Number.isInteger(item[field]) && item[field] >= 0 && item[field] <= 86400),
  );
}
/** @brief Copy a legacy thermostat without obsolete per-item duration settings. */
function withoutLegacyThermostatDurations(item) {
  const { minOnSeconds, minOffSeconds, ...current } = item;
  return current;
}
module.exports = {
  thermostatMinimumCycleSeconds,
  validLegacyThermostatDurations,
  withoutLegacyThermostatDurations,
};
