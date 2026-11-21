/** @file Shared LAN hub contracts; operative control loops remain on each PLC. */
import type { DeviceIllustrationId } from './device-art.js';
import type {
  SecurityCommandFence,
  SecurityLeaseInput,
  SecurityTouchEvent,
} from './security-sync.js';
export type {
  SecurityCommandFence,
  SecurityLeaseInput,
  SecurityTouchEvent,
} from './security-sync.js';
export const controllerKinds = ['sockets', 'lights', 'meteo', 'thermostats', 'security'] as const;
export type ControllerKind = (typeof controllerKinds)[number];
export type WritableControllerKind = Exclude<ControllerKind, 'meteo'>;

export interface Product {
  name: string;
  fullName: string;
  id: string;
}

export interface DeviceLabel {
  name: string;
  room: string;
  /** Hub-owned card appearance; omitted by legacy files and clients. */
  illustrationId?: DeviceIllustrationId;
}

export interface ControllerView {
  kind: ControllerKind;
  fresh: boolean;
  receivedAt: string;
  data: Record<string, unknown>;
}

export interface DeviceView extends DeviceLabel {
  id: string;
  boardId: string;
  firmwareVersion: string;
  bootId: string | null;
  status: 'online' | 'offline' | 'stale' | 'unknown';
  online: boolean;
  /** Monotonic live-connection identity, including short offline intervals between UI/coordinator polls. */
  connectionGeneration?: number;
  lastSeenAt: string | null;
  uptimeSec: number | null;
  controllers: Partial<Record<ControllerKind, ControllerView>>;
  management?: { version: number; supported: boolean; busy: boolean; sequence: number };
}

/** Private correlated service request; never retained, logged or placed in telemetry history. */
export interface ManagementRequest {
  schemaVersion: 1;
  requestId: string;
  bootId: string;
  sequence: number;
  expiresAtUptimeMs: number;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}
export interface ManagementReply {
  schemaVersion: 1;
  requestId: string;
  bootId: string;
  sequence: number;
  status: number;
  data: Record<string, unknown> | unknown[];
}

export interface CommandView {
  id: string;
  deviceId: string;
  controller: WritableControllerKind;
  itemId: string;
  value: boolean;
  sequence: number;
  status: 'pending' | 'applied' | 'rejected' | 'unknown';
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface EngineSnapshot {
  broker: { connected: boolean; error: string | null };
  devices: DeviceView[];
  commands: CommandView[];
}

export interface HubSnapshot extends EngineSnapshot {
  product: Product;
  mode: 'demo' | 'mqtt';
  now: string;
  scenes: ScenesSnapshot;
  houseSecurity?: HouseSecurityView;
}

export interface HouseSecurityDeviceView {
  deviceId: string;
  name: string;
  online: boolean;
  configured: boolean;
  enabled: boolean;
  actualArmed: boolean | null;
  phase?: string | null;
  remainingSeconds?: number | null;
  status:
    'confirmed' | 'pending' | 'offline' | 'skipped' | 'not-configured' | 'unknown' | 'rejected';
  error: string | null;
}
export interface HouseSecurityView {
  desiredArmed: boolean | null;
  revision: number;
  busy: boolean;
  error: string | null;
  devices: HouseSecurityDeviceView[];
  lastEvent: {
    eventId: string;
    deviceId: string;
    keyName: string;
    at: string;
    value: boolean;
  } | null;
}

export const sceneIds = ['home', 'away', 'prepare'] as const;
export type BuiltinSceneId = (typeof sceneIds)[number];
export type SceneId = string;
export interface SceneAction {
  id: string;
  deviceId: string;
  controller: WritableControllerKind;
  itemId: string;
  value: boolean;
}
export interface SceneDefinition {
  id: SceneId;
  name: string;
  description: string;
  revision: number;
  actions: SceneAction[];
  builtin?: boolean;
  schedule?: SceneSchedule | null;
}
export interface SceneSchedule {
  enabled: boolean;
  /** ISO weekdays: Monday=1 through Sunday=7. */
  days: number[];
  time: string;
  timeZone: string;
}
export interface SceneActionResult {
  id: string;
  deviceId: string;
  deviceName: string;
  controller: WritableControllerKind;
  itemId: string;
  itemName: string;
  value: boolean;
  source: 'security' | 'configured';
  status: 'pending' | 'applied' | 'rejected' | 'unknown' | 'unavailable' | 'skipped';
  error: string | null;
  commandId?: string;
}
export interface SceneRun {
  id: string;
  sceneId: SceneId;
  name: string;
  status: 'running' | 'completed' | 'partial' | 'failed' | 'empty' | 'interrupted';
  startedAt: string;
  completedAt: string | null;
  results: SceneActionResult[];
  error?: string | null;
  trigger?: 'manual' | 'schedule';
}
export interface ScenesSnapshot {
  definitions: SceneDefinition[];
  activeRun: SceneRun | null;
  runs: SceneRun[];
  storageError?: string | null;
  scheduler?: {
    running: boolean;
    error: string | null;
    events: ScheduleEvent[];
  };
}
export interface ScheduleEvent {
  sceneId: string;
  name: string;
  dueAt: string;
  status: 'started' | 'skipped' | 'error';
  reason: string | null;
}

export interface SessionView {
  authenticated: boolean;
  requiresLogin: boolean;
  product: Product;
  mode: 'demo' | 'mqtt';
}

export interface HubEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): EngineSnapshot;
  command(
    deviceId: string,
    controller: WritableControllerKind,
    itemId: string,
    value: boolean,
    timeoutMs?: number,
    fence?: SecurityCommandFence,
  ): Promise<CommandView>;
  sendSecurityLease?(deviceId: string, input: SecurityLeaseInput): Promise<SecurityCommandFence>;
  onSecurityTouch?(handler: (event: SecurityTouchEvent) => void): () => void;
  demoSecurityTouch?(deviceId: string, keyId?: string): Promise<{ status: number; data: unknown }>;
  rename(deviceId: string, name: string, room: string, illustrationId?: DeviceIllustrationId): void;
  service?(
    deviceId: string,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ManagementReply>;
}

export interface EngineOptions {
  product: Product;
  mode: 'demo' | 'mqtt';
  brokerUrl: string;
  username?: string;
  password?: string;
  clientId: string;
  staleAfterMs: number;
  commandTimeoutMs: number;
  labels: Record<string, DeviceLabel>;
  onLabelsChanged(labels: Record<string, DeviceLabel>): void;
  demoDataDir?: string;
}
