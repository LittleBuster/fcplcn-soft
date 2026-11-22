/** @file Hub-owned source for the tablet temperature summary. */
export interface PultTemperatureSource {
  deviceId: string;
  itemId: string;
  /** Last confirmed names remain available while the PLC is missing or offline. */
  deviceName: string;
  itemName: string;
}

export interface PultSettingsView {
  revision: number;
  temperatureSource: PultTemperatureSource | null;
}
