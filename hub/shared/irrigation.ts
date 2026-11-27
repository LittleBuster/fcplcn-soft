/** @file PLC-owned weekly irrigation schedules and their confirmed telemetry. */
const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const isWeekday = (day: unknown): day is number =>
  typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 7;

function validDays(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 7 &&
    value.every(isWeekday) &&
    new Set(value).size === value.length
  );
}

const isFeedback = (value: unknown) => value === null || typeof value === 'boolean';

/** A remote source includes its device ID so tank IDs can repeat across PLCs. */
export function remoteTankReference(value: unknown): { deviceId: string; tankId: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^(fcplcn-[A-Za-z0-9_-]{1,97})\/([A-Za-z0-9_-]{1,32})$/.exec(value);
  return match ? { deviceId: match[1], tankId: match[2] } : null;
}

/** Actual watering and the physical relay can differ when multiple rules share one valve. */
export function validIrrigationTelemetry(row: Record<string, unknown>): boolean {
  return (
    typeof row.enabled === 'boolean' &&
    typeof row.relayId === 'string' &&
    /^rly-\d+\/\d+$/.test(row.relayId) &&
    (row.tankId === ''
      ? row.waterAvailable === null
      : typeof row.tankId === 'string' &&
        (/^[a-zA-Z0-9_-]{1,32}$/.test(row.tankId) || remoteTankReference(row.tankId) !== null) &&
        isFeedback(row.waterAvailable)) &&
    validDays(row.days) &&
    typeof row.startTime === 'string' &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(row.startTime) &&
    typeof row.durationMinutes === 'number' &&
    Number.isInteger(row.durationMinutes) &&
    row.durationMinutes >= 1 &&
    row.durationMinutes <= 1440 &&
    isFeedback(row.actual) &&
    isFeedback(row.valveActual) &&
    typeof row.remainingSeconds === 'number' &&
    Number.isInteger(row.remainingSeconds) &&
    row.remainingSeconds >= 0 &&
    row.remainingSeconds <= 86400 &&
    (row.error === null || typeof row.error === 'string')
  );
}

export function irrigationDays(value: unknown): string {
  if (!validDays(value)) return '—';
  if (value.length === 7) return 'Ежедневно';
  return [...value]
    .sort((a, b) => a - b)
    .map((day) => weekdays[day - 1])
    .join(', ');
}

/** A shared valve can be open while this particular rule waits for its next start. */
export function irrigationRuleState(item: Record<string, unknown>): string {
  if (!item.enabled) return 'Правило выключено';
  if (item.tankId !== '' && item.waterAvailable === false) return 'Нет воды в баке';
  if (item.error) return 'Полив заблокирован';
  if (item.tankId !== '' && item.waterAvailable !== true) return 'Нет данных бака';
  if (item.actual === true) return 'Идёт полив';
  if (item.actual === false) return 'Ожидает старта';
  return 'Нет данных полива';
}
