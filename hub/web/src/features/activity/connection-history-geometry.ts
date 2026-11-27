import type { ConnectionHistoryPeriod, DeviceOutage } from '../../../../shared/activity.js';

export const connectionTicks = [0, 0.25, 0.5, 0.75, 1];
export const connectionPlotWidth = 1000;

const tickFormat = {
  day: new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }),
  week: new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }),
};

export function connectionTickLabel(period: ConnectionHistoryPeriod, value: number) {
  return tickFormat[period].format(value);
}

export interface ConnectionInterval {
  id: string;
  from: number;
  to: number;
  offlineAt: string;
  onlineAt: string | null;
}

/** Clip recorded intervals to the plotted window and join touching or overlapping outages. */
export function plottedOutages(outages: readonly DeviceOutage[], from: number, to: number) {
  const intervals = outages
    .map((outage) => ({
      id: outage.id,
      from: Math.max(Date.parse(outage.offlineAt), from),
      to: Math.min(outage.onlineAt === null ? to : Date.parse(outage.onlineAt), to),
      offlineAt: outage.offlineAt,
      onlineAt: outage.onlineAt,
    }))
    .filter((outage) => outage.from <= outage.to)
    .sort((a, b) => Date.parse(a.offlineAt) - Date.parse(b.offlineAt));
  const merged: ConnectionInterval[] = [];
  for (const outage of intervals) {
    const last = merged.at(-1);
    if (!last || outage.from > last.to) {
      merged.push(outage);
    } else if (outage.to > last.to || outage.onlineAt === null) {
      last.to = outage.to;
      last.onlineAt = outage.onlineAt;
    }
  }
  return merged;
}
