/** @file Public tank telemetry validation; actuation remains exclusively on its PLC. */
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const relay = (value: unknown) =>
  typeof value === 'string' && (value === '' || /^rly-\d+\/\d+$/.test(value));

/** Reject a forged percentage or impossible wet sequence before displaying it as fresh telemetry. */
export function validTankTelemetry(value: unknown): boolean {
  if (
    !object(value) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.available !== 'boolean' ||
    !relay(value.pumpRelayId) ||
    !relay(value.valveRelayId) ||
    !Array.isArray(value.levelInputs) ||
    value.levelInputs.length < 1 ||
    value.levelInputs.length > 3 ||
    value.levelInputs.some((id) => typeof id !== 'string' || !/^in-\d+\/\d+$/.test(id)) ||
    new Set(value.levelInputs).size !== value.levelInputs.length ||
    !Number.isInteger(value.fillLevel) ||
    Number(value.fillLevel) < 1 ||
    Number(value.fillLevel) > value.levelInputs.length ||
    !Array.isArray(value.levelsWet) ||
    value.levelsWet.length !== value.levelInputs.length ||
    value.levelsWet.some((wet) => wet !== null && typeof wet !== 'boolean') ||
    (value.pumpActual !== null && typeof value.pumpActual !== 'boolean') ||
    (value.valveActual !== null && typeof value.valveActual !== 'boolean') ||
    (value.error !== null && typeof value.error !== 'string') ||
    (value.levelPct !== null &&
      (!Number.isInteger(value.levelPct) ||
        Number(value.levelPct) < 0 ||
        Number(value.levelPct) > 100))
  )
    return false;
  const wet = value.levelsWet;
  const coherent = wet.every(
    (entry, index) =>
      typeof entry === 'boolean' &&
      (entry !== true || wet.slice(0, index).every((lower) => lower === true)),
  );
  if (
    value.available === true &&
    (!value.enabled || !coherent || value.levelPct === null || value.error !== null)
  )
    return false;
  return (
    value.levelPct === null ||
    (coherent &&
      value.levelPct ===
        Math.round((100 * wet.filter((entry) => entry === true).length) / wet.length))
  );
}
