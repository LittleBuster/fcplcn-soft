export type MeteoHistoryPeriod = 'day' | 'week';

export interface MeteoHistoryPoint {
  /** Beginning of the UTC hour. A missing observation is represented by null. */
  hour: string;
  temperatureC: number | null;
  humidityPct: number | null;
}

export interface MeteoHistory {
  deviceName: string;
  sensorName: string;
  period: MeteoHistoryPeriod;
  points: MeteoHistoryPoint[];
}
