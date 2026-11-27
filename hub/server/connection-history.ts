import type {
  ConnectionFleetHistory,
  ConnectionHistory,
  ConnectionHistoryPeriod,
  DeviceOutage,
} from '../shared/activity.js';
import type { DeviceView } from '../shared/types.js';

type ConnectionHistoryRange = Pick<ConnectionHistory, 'period' | 'from' | 'to'>;
export type ReadConnectionOutages = (
  deviceId: string | null,
  from: string,
  to: string,
) => Promise<DeviceOutage[]>;

export function connectionHistoryRange(
  period: ConnectionHistoryPeriod,
  now = Date.now(),
): ConnectionHistoryRange {
  const duration = (period === 'day' ? 24 : 168) * 60 * 60 * 1000;
  return {
    period,
    from: new Date(now - duration).toISOString(),
    to: new Date(now).toISOString(),
  };
}

export function connectionHistory(
  deviceId: string | null,
  range: ConnectionHistoryRange,
  outages: readonly DeviceOutage[],
): ConnectionHistory {
  const latest = new Map<string, DeviceOutage>();
  for (const outage of outages) {
    // A persisted closure takes precedence over an older open observation of the interval.
    if ((deviceId === null || outage.deviceId === deviceId) && !latest.get(outage.id)?.onlineAt)
      latest.set(outage.id, outage);
  }
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  return {
    ...range,
    outages: [...latest.values()]
      .filter(
        ({ offlineAt, onlineAt }) =>
          Date.parse(offlineAt) <= to && (onlineAt === null || Date.parse(onlineAt) > from),
      )
      .sort((a, b) => Date.parse(a.offlineAt) - Date.parse(b.offlineAt)),
  };
}

export function connectionFleetHistory(
  history: ConnectionHistory,
  discovered: readonly Pick<DeviceView, 'id' | 'name' | 'online'>[],
): ConnectionFleetHistory {
  const devices = new Map<string, ConnectionFleetHistory['devices'][number]>();
  for (const { deviceId: id, deviceName: name, onlineAt } of history.outages) {
    const online = onlineAt === null || devices.get(id)?.online === false ? false : null;
    devices.set(id, { id, name: name || id, online });
  }
  for (const { id, name, online } of discovered) devices.set(id, { id, name: name || id, online });
  return {
    ...history,
    devices: [...devices.values()].sort(
      (a, b) => a.name.localeCompare(b.name, 'ru') || a.id.localeCompare(b.id),
    ),
  };
}
