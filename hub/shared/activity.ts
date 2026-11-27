/** @file Hub activity identities and controller connection intervals. */
import type { CommandView } from './types.js';

export interface ActivityActor {
  source: 'web' | 'cloud' | 'telegram' | 'schedule' | 'key' | 'system';
  name: string;
  id?: string;
}

export interface ActivityContext {
  actor: ActivityActor;
  sceneRunId?: string;
}

export interface DeviceOutage {
  id: string;
  deviceId: string;
  deviceName: string;
  offlineAt: string;
  onlineAt: string | null;
  reason: 'availability' | 'timeout';
}

export type ConnectionHistoryPeriod = 'day' | 'week';

export interface ConnectionHistory {
  period: ConnectionHistoryPeriod;
  from: string;
  to: string;
  outages: DeviceOutage[];
}

export interface ConnectionFleetHistory extends ConnectionHistory {
  devices: { id: string; name: string; online: boolean | null }[];
}

export interface EngineActivityHooks {
  commands?: CommandView[];
  outages?: DeviceOutage[];
  context?(): ActivityContext | undefined;
  commandStarted?(command: CommandView): Promise<void>;
  commandFinished?(command: CommandView): Promise<void>;
  outageChanged?(outage: DeviceOutage): void;
}
