/** @file Bounded cloud uplink contract; the local hub remains the sole PLC command authority. */
import type { HubSnapshot } from './types.js';

export const CLOUD_PROTOCOL_VERSION = 1;
export const CLOUD_TOPIC_PREFIX = 'fcplcn-cloud/v1/hubs';
export const CLOUD_MAX_PACKET = 2 * 1024 * 1024;
export type CloudMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface CloudActor {
  userId: string;
  role: 'owner' | 'operator' | 'viewer';
  securityControl?: boolean;
}
export interface CloudRequest {
  version: 1;
  id: string;
  hubId: string;
  sessionId: string;
  sequence: number;
  expiresAtUptimeMs: number;
  method: CloudMethod;
  path: string;
  body?: Record<string, unknown>;
  actor: CloudActor;
}
export interface CloudReply {
  version: 1;
  id: string;
  hubId: string;
  sessionId: string;
  sequence: number;
  status: number;
  data: unknown;
}
export interface CloudState {
  version: 1;
  hubId: string;
  sessionId: string;
  sequence: number;
  uptimeMs: number;
  requestSequence: number;
  snapshot: HubSnapshot;
}
export interface CloudBrokerCredentials {
  username: string;
  password: string;
  brokerUrl: string;
  ca?: string;
}
export interface CloudClaim {
  protocolVersion: 1;
  hubId: string;
  homeId: string;
  broker: CloudBrokerCredentials;
}
export interface HubCloudView {
  config: {
    revision: number;
    enabled: boolean;
    url: string;
    paired: boolean;
    hubId: string;
    homeId: string;
    name: string;
  };
  status: {
    state: 'disabled' | 'connecting' | 'online' | 'error';
    error: string | null;
    lastConnectedAt: string | null;
    lastPublishedAt: string | null;
  };
}
export interface CloudHubView {
  online: boolean;
  sessionId: string | null;
  lastSeenAt: string | null;
  snapshot: HubSnapshot | null;
}
export const cloudHubId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
export const cloudObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Exact application allowlist; the uplink cannot issue arbitrary HTTP, MQTT or shell operations. */
export function cloudRoute(method: string, path: string): boolean {
  if (method === 'GET')
    return (
      ['/overview', '/scenes', '/telegram'].includes(path) ||
      /^\/firmware\/jobs\/[a-zA-Z0-9_-]{1,96}$/.test(path) ||
      /^\/devices\/fcplcn-[a-zA-Z0-9_-]{1,96}\/service\/(?:config(?:\/backup)?|status|board-profiles|hardware|controllers(?:\/(?:sockets|lights|meteo|thermostats|security))?|firmware)$/.test(
        path,
      )
    );
  if (method === 'POST')
    return (
      ['/scenes', '/telegram', '/telegram/test'].includes(path) ||
      /^\/devices\/fcplcn-[a-zA-Z0-9_-]{1,96}\/security\/key$/.test(path) ||
      /^\/scenes\/[a-zA-Z0-9_-]{1,64}\/run$/.test(path) ||
      /^\/devices\/fcplcn-[a-zA-Z0-9_-]{1,96}\/(?:commands|firmware\/install|service\/(?:login|logout|config(?:\/restore)?|hardware\/(?:scan|relay)|controllers\/(?:sockets|lights|meteo|thermostats|security)(?:\/(?:state|enabled|armed|scan))?|user|time|reboot|firmware\/(?:begin|chunk|finish|abort)))$/.test(
        path,
      )
    );
  return method === 'PATCH'
    ? /^\/devices\/fcplcn-[a-zA-Z0-9_-]{1,96}$/.test(path)
    : (method === 'PUT' || method === 'DELETE') && /^\/scenes\/[a-zA-Z0-9_-]{1,64}$/.test(path);
}

/** Recheck identity privileges at both ends; role strings and home membership originate in the cloud API. */
export function cloudPermitted(
  actor: CloudActor,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): boolean {
  if (!actor || !['owner', 'operator', 'viewer'].includes(actor.role) || !cloudRoute(method, path))
    return false;
  if (actor.role === 'owner') return true;
  if (method === 'GET') return path === '/overview' || path === '/scenes';
  if (actor.role !== 'operator') return false;
  if (/\/security\/key$/.test(path)) return actor.securityControl === true;
  if (/\/commands$/.test(path))
    return body?.controller !== 'security' || actor.securityControl === true;
  return (
    /^\/scenes\/[a-zA-Z0-9_-]{1,64}\/run$/.test(path) &&
    (!/^\/scenes\/(?:home|away)\/run$/.test(path) || actor.securityControl === true)
  );
}
