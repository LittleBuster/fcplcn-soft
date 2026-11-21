/** @file Same-origin public cloud API; every forwarded operation is scoped to a current membership. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { CloudActor, CloudHubView, CloudMethod } from '../../hub/shared/cloud.js';
import { cloudPermitted, cloudRoute } from '../../hub/shared/cloud.js';
import type { Product, HubSnapshot } from '../../hub/shared/types.js';
import type { CloudConfig } from './config.js';
import type { CloudDatabase } from './db.js';
import { CloudAuth, type Authenticated } from './auth.js';
import { CloudHomes } from './users.js';
import { CloudPairing, type HubProvisioner } from './pairing.js';
import { CloudError, object, only, uuid } from './errors.js';
import { CloudBridgeError } from './bridge.js';
import type { CloudArtifacts } from './artifacts.js';

export interface CloudBridgeAPI {
  snapshot(hubId: string): CloudHubView;
  request(
    hubId: string,
    method: CloudMethod,
    path: string,
    body: Record<string, unknown> | undefined,
    actor: CloudActor,
  ): Promise<{ status: number; data: unknown }>;
  revoke(hubId: string): void;
}
export interface CloudServerOptions {
  config: CloudConfig;
  db: CloudDatabase;
  product: Product;
  bridge: CloudBridgeAPI;
  broker: HubProvisioner;
  webDir: string;
  portalDir: string;
  plcDir: string;
  artifacts?: CloudArtifacts;
}
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const reply = (response: ServerResponse, status: number, data: unknown) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
};
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new CloudError('Нужен запрос application/json', 415);
  const chunks: Buffer[] = [];
  let size = 0;
  const deadline = setTimeout(
    () => request.destroy(new CloudError('Время передачи JSON истекло', 408)),
    10000,
  ).unref();
  try {
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 80 * 1024) throw new CloudError('Запрос слишком большой', 413);
      chunks.push(bytes);
    }
  } finally {
    clearTimeout(deadline);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CloudError('Некорректный JSON');
  }
  if (!object(value)) throw new CloudError('Ожидается объект JSON');
  return value;
}
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
function originAllowed(request: IncomingMessage, config: CloudConfig): boolean {
  try {
    const configured = new URL(config.publicOrigin),
      target = new URL(`${configured.protocol}//${request.headers.host || ''}`);
    if (
      target.username ||
      target.password ||
      (config.secureCookies ? target.host !== configured.host : !loopback(target.hostname))
    )
      return false;
    const origin = request.headers.origin;
    return (
      !origin ||
      (new URL(origin).host === target.host && new URL(origin).protocol === configured.protocol)
    );
  } catch {
    return false;
  }
}
function errorBody(error: unknown) {
  return error instanceof CloudError || error instanceof CloudBridgeError
    ? {
        status: error.statusCode,
        message: error.message,
        ...(error instanceof CloudBridgeError && error.unknown ? { unknown: true } : {}),
      }
    : { status: 503, message: 'Сервис временно недоступен' };
}
function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
function offline(snapshot: HubSnapshot, lastSeenAt: string | null): HubSnapshot {
  const result = structuredClone(snapshot);
  result.broker = { connected: false, error: 'Нет связи с облачным хабом' };
  for (const device of result.devices) {
    device.online = false;
    device.status = 'stale';
    for (const module of Object.values(device.controllers)) if (module) module.fresh = false;
  }
  return Object.assign(result, { cloud: { online: false, lastSeenAt } });
}
/** Record acknowledgement accurately without storing private response bodies or configuration. */
function auditOutcome(result: { status: number; data: unknown }): string {
  if (result.status >= 400) return 'rejected';
  const data = object(result.data) ? result.data : {};
  if (data.unknown === true || data.status === 'unknown' || data.status === 'interrupted')
    return 'unknown';
  if (data.status === 'rejected' || data.status === 'failed') return 'rejected';
  if (data.status === 'partial') return 'partial';
  if (
    result.status === 202 ||
    data.rebootRequired === true ||
    ['pending', 'running'].includes(String(data.status))
  )
    return 'accepted';
  return 'confirmed';
}
export function createCloudServer(options: CloudServerOptions) {
  const { config, db, product, bridge, broker } = options;
  const auth = new CloudAuth(db, config.secureCookies, config.setupKey, config.masterKey);
  let readiness: Promise<void> | undefined;
  // Defer work until awaited: embedded servers may be constructed before their database migration.
  const initialize = () => {
    if (!readiness) {
      readiness = auth.initializeDefaultAdmin();
      void readiness.catch(() => {});
    }
    return readiness;
  };
  const homes = new CloudHomes(db, auth);
  const pairing = new CloudPairing(
    db,
    homes,
    broker,
    (id) => bridge.snapshot(id),
    (id) => bridge.revoke(id),
  );
  /** Commit the actor's intent before dispatch; a failed journal write prevents actuation. */
  async function callHub(
    homeId: string,
    hubId: string,
    method: CloudMethod,
    path: string,
    payload: Record<string, unknown> | undefined,
    actor: CloudActor,
    audit = { operation: method + ' ' + path, target: hubId },
  ) {
    const auditId =
      method !== 'GET'
        ? await homes.audit(homeId, actor.userId, audit.operation, audit.target, 'pending')
        : null;
    let result: { status: number; data: unknown };
    try {
      result = await bridge.request(hubId, method, path, payload, actor);
    } catch (error) {
      if (auditId)
        await homes.finishAudit(
          auditId,
          error instanceof CloudBridgeError && !error.unknown ? 'rejected' : 'unknown',
        );
      throw error;
    }
    if (auditId) await homes.finishAudit(auditId, auditOutcome(result));
    return result;
  }
  async function sessionView(session: Authenticated | null) {
    return {
      authenticated: Boolean(session),
      setupRequired: await auth.setupRequired(),
      product,
      user: session?.user || null,
      csrfToken: session?.csrfToken || null,
    };
  }
  const requireSession = (session: Authenticated | null) => {
    if (!session) throw new CloudError('Войдите в FCPLCn', 401);
    return session;
  };
  async function serve(response: ServerResponse, directory: string, path: string, head = false) {
    const file = resolve(directory, '.' + path);
    if (
      !file.startsWith(resolve(directory) + sep) ||
      !types[extname(file)] ||
      path.includes('\0') ||
      path.includes('\\')
    )
      throw new CloudError('Файл не найден', 404);
    let content: Buffer;
    try {
      content = await readFile(file);
    } catch {
      throw new CloudError('Файл не найден', 404);
    }
    response.writeHead(200, {
      'Content-Type': types[extname(file)],
      'Cache-Control': path.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    response.end(head ? undefined : content);
  }
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (config.secureCookies) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      await initialize();
      if (!originAllowed(request, config))
        throw new CloudError('Недопустимый источник запроса', 403);
      const url = new URL(request.url || '/', 'http://fcplcn.invalid');
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        throw new CloudError('Некорректный адрес');
      }
      const method = request.method || 'GET';
      const address = request.socket.remoteAddress || 'unknown';
      if (path === '/health' && method === 'GET') {
        await db.query('SELECT 1');
        reply(response, 200, { ok: true, product: product.name });
        return;
      }
      const download = /^\/api\/v1\/hub\/firmware\/([a-f0-9-]{36})$/.exec(path);
      if (download && method === 'GET') {
        if (!options.artifacts) throw new CloudError('Служба прошивок недоступна', 503);
        const authorization = request.headers.authorization,
          hubId = request.headers['x-fcplcn-hub'];
        if (
          typeof authorization !== 'string' ||
          !authorization.startsWith('Bearer ') ||
          typeof hubId !== 'string'
        )
          throw new CloudError('Загрузка не разрешена', 403);
        if (!(await pairing.authorized(hubId)))
          throw new CloudError('Подключение хаба отозвано', 403);
        const file = options.artifacts.download(download[1], authorization.slice(7), hubId);
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': file.size,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        await pipeline(file.stream, response);
        return;
      }
      const session = await auth.session(request);
      if (path === '/api/v1/session' && method === 'GET') {
        reply(response, 200, await sessionView(session));
        return;
      }
      if (path === '/api/v1/auth/setup' && method === 'POST') {
        const value = await body(request);
        if (!only(value, ['setupKey', 'email', 'username', 'name', 'password']))
          throw new CloudError('Некорректные поля настройки');
        const user = await auth.setup(value, address);
        reply(response, 201, await sessionView(await auth.issue(user, response)));
        return;
      }
      if (path === '/api/v1/auth/login' && method === 'POST') {
        const value = await body(request);
        if (
          !only(value, ['email', 'username', 'password', 'totp']) ||
          ('email' in value && 'username' in value)
        )
          throw new CloudError('Некорректные поля входа');
        const user = await auth.login(value, address);
        reply(response, 200, await sessionView(await auth.issue(user, response)));
        return;
      }
      if (path === '/api/v1/hubs/claim' && method === 'POST') {
        auth.limiter.take('claim-ip:' + address, 20);
        reply(response, 200, await pairing.claim(await body(request)));
        return;
      }
      if (path === '/api/v1/hubs/disconnect' && method === 'POST') {
        auth.limiter.take('disconnect-ip:' + address, 40);
        await pairing.disconnect(await body(request), request.headers.authorization);
        reply(response, 200, { ok: true });
        return;
      }
      const invite = /^\/api\/v1\/invites\/([A-Za-z0-9_-]{43})$/.exec(path);
      if (invite && method === 'GET') {
        auth.limiter.take('invite-read:' + address, 100);
        reply(response, 200, await homes.invitation(invite[1]));
        return;
      }
      if (path === '/api/v1/invites/accept' && method === 'POST') {
        auth.limiter.take('invite-accept:' + address, 10);
        if (session) auth.csrf(request, session);
        const accepted = await homes.accept(await body(request), session?.user || null);
        reply(response, 200, {
          ...(await sessionView(session || (await auth.issue(accepted.user, response)))),
          homeId: accepted.homeId,
        });
        return;
      }
      if (path.startsWith('/api/')) {
        const current = requireSession(session);
        if (!['GET', 'HEAD'].includes(method)) auth.csrf(request, current);
        if (
          method === 'POST' &&
          (path.startsWith('/api/v1/auth/totp/') ||
            path === '/api/v1/auth/password' ||
            path === '/api/v1/auth/account')
        )
          auth.limiter.take('account-security:' + current.user.id, 12);
        if (path === '/api/v1/auth/logout' && method === 'POST') {
          await body(request);
          await auth.logout(current, response);
          reply(response, 200, { ok: true });
          return;
        }
        if (path === '/api/v1/auth/totp/setup' && method === 'POST') {
          const value = await body(request);
          reply(response, 200, await auth.setupTOTP(current, value.password));
          return;
        }
        if (path === '/api/v1/auth/totp/confirm' && method === 'POST') {
          const value = await body(request);
          reply(response, 200, {
            ok: true,
            recoveryCodes: await auth.confirmTOTP(current, value.code),
          });
          return;
        }
        if (path === '/api/v1/auth/totp/disable' && method === 'POST') {
          const value = await body(request);
          await auth.disableTOTP(current, value.password, value.code);
          reply(response, 200, { ok: true });
          return;
        }
        if (path === '/api/v1/auth/password' && method === 'POST') {
          const value = await body(request);
          const user = await auth.changePassword(
            current,
            value.currentPassword,
            value.password,
            value.code,
          );
          reply(response, 200, await sessionView(await auth.issue(user, response)));
          return;
        }
        if (path === '/api/v1/auth/account' && method === 'POST') {
          const user = await auth.changeAccount(current, await body(request));
          reply(response, 200, await sessionView(await auth.issue(user, response)));
          return;
        }
        if (path === '/api/v1/homes' && method === 'GET') {
          reply(response, 200, { homes: await homes.list(current.user.id) });
          return;
        }
        if (path === '/api/v1/homes' && method === 'POST') {
          const value = await body(request);
          if (!only(value, ['name'])) throw new CloudError('Укажите название дома');
          reply(response, 201, await homes.create(current.user.id, value.name));
          return;
        }
        const home = /^\/api\/v1\/homes\/([a-f0-9-]{36})(.*)$/.exec(path);
        if (home) {
          const homeId = home[1],
            suffix = home[2],
            membership = await homes.membership(current.user.id, homeId);
          if (suffix === '' && method === 'GET') {
            reply(response, 200, {
              home: membership,
              members:
                membership.role === 'owner' ? await homes.members(current.user.id, homeId) : [],
              hubs: await pairing.hubs(homeId),
            });
            return;
          }
          if (suffix === '' && method === 'PATCH') {
            const value = await body(request);
            if (!only(value, ['name'])) throw new CloudError('Укажите название дома');
            reply(response, 200, await homes.rename(current.user.id, homeId, value.name));
            return;
          }
          if (suffix === '/members' && method === 'GET') {
            reply(response, 200, { members: await homes.members(current.user.id, homeId) });
            return;
          }
          const member = /^\/members\/([a-f0-9-]{36})$/.exec(suffix);
          if (member && (method === 'PATCH' || method === 'DELETE')) {
            const value = await body(request);
            await homes.updateMember(
              current.user.id,
              homeId,
              member[1],
              value,
              method === 'DELETE',
            );
            reply(response, 200, { ok: true });
            return;
          }
          if (suffix === '/invites' && method === 'POST') {
            auth.limiter.take('invite-create:' + current.user.id, 30);
            reply(
              response,
              201,
              await homes.invite(current.user.id, homeId, await body(request), config.publicOrigin),
            );
            return;
          }
          if (suffix === '/pairing' && method === 'POST') {
            auth.limiter.take('pair-create:' + current.user.id, 20);
            await body(request);
            reply(response, 201, await pairing.create(current.user.id, homeId));
            return;
          }
          if (suffix === '/history' && method === 'GET') {
            reply(response, 200, { events: await homes.history(current.user.id, homeId) });
            return;
          }
          if (suffix === '/firmware' && method === 'POST') {
            await homes.membership(current.user.id, homeId, true);
            if (!options.artifacts) throw new CloudError('Служба прошивок недоступна', 503);
            reply(response, 201, await options.artifacts.upload(request, homeId));
            return;
          }
          const install = /^\/firmware\/([a-f0-9-]{36})\/install$/.exec(suffix);
          if (install && method === 'POST') {
            await homes.membership(current.user.id, homeId, true);
            if (!options.artifacts) throw new CloudError('Служба прошивок недоступна', 503);
            const value = await body(request);
            if (
              !only(value, ['deviceId']) ||
              typeof value.deviceId !== 'string' ||
              !/^fcplcn-[a-zA-Z0-9_-]{1,96}$/.test(value.deviceId)
            )
              throw new CloudError('Выберите PLC');
            const hubId = await pairing.active(homeId);
            if (!hubId || !bridge.snapshot(hubId).online)
              throw new CloudError('Хаб не в сети. Обновление не отправлено.', 503);
            const { artifact, ticket } = options.artifacts.issue(install[1], homeId, hubId);
            const result = await callHub(
              homeId,
              hubId,
              'POST',
              `/devices/${value.deviceId}/firmware/install`,
              { artifactId: artifact.id, ticket, size: artifact.size, sha256: artifact.sha256 },
              { userId: current.user.id, role: 'owner', securityControl: true },
              { operation: 'firmware.install', target: value.deviceId },
            );
            await homes.membership(current.user.id, homeId, true);
            reply(response, result.status, result.data);
            return;
          }
          const job = /^\/firmware\/jobs\/([a-zA-Z0-9_-]{1,80})$/.exec(suffix);
          if (job && method === 'GET') {
            await homes.membership(current.user.id, homeId, true);
            const hubId = await pairing.active(homeId);
            if (!hubId) throw new CloudError('Хаб не привязан', 503);
            const result = await bridge.request(
              hubId,
              'GET',
              `/firmware/jobs/${job[1]}`,
              undefined,
              { userId: current.user.id, role: 'owner', securityControl: true },
            );
            reply(response, result.status, result.data);
            return;
          }
          const hub = /^\/hubs\/([a-f0-9-]{36})$/.exec(suffix);
          if (hub && method === 'DELETE') {
            await body(request);
            await pairing.revoke(current.user.id, homeId, hub[1]);
            reply(response, 200, { ok: true });
            return;
          }
          if (suffix === '/hub/session' && method === 'GET') {
            reply(response, 200, {
              authenticated: true,
              requiresLogin: false,
              product,
              mode: 'mqtt',
              csrfToken: current.csrfToken,
              cloudRole: membership.role,
              capabilities: {
                canControl: membership.role !== 'viewer',
                canConfigure: membership.role === 'owner',
                canManageSecurity: membership.securityControl,
              },
            });
            return;
          }
          if (suffix.startsWith('/hub/')) {
            const route = suffix.slice(4),
              payload = ['GET', 'HEAD'].includes(method) ? undefined : await body(request);
            const actor: CloudActor = {
              userId: current.user.id,
              role: membership.role,
              securityControl: membership.securityControl,
            };
            if (!cloudRoute(method, route))
              throw new CloudError('Удалённый метод не поддерживается', 404);
            if (!cloudPermitted(actor, method, route, payload))
              throw new CloudError('Недостаточно прав для этого действия', 403);
            const hubId = await pairing.active(homeId);
            if (route === '/overview' && method === 'GET') {
              const live = hubId ? bridge.snapshot(hubId) : null;
              const snapshot =
                live?.snapshot || ((await pairing.cached(homeId)) as HubSnapshot | null);
              if (!snapshot) throw new CloudError('Хаб ещё не передал состояния', 503);
              reply(
                response,
                200,
                live?.online
                  ? Object.assign(structuredClone(snapshot), {
                      cloud: { online: true, lastSeenAt: live.lastSeenAt },
                    })
                  : offline(snapshot, live?.lastSeenAt || null),
              );
              return;
            }
            if (!hubId || !bridge.snapshot(hubId).online)
              throw new CloudError('Хаб не в сети. Команда не отправлена.', 503);
            const sceneRun = /^\/scenes\/([a-zA-Z0-9_-]{1,64})\/run$/.exec(route);
            if (sceneRun && actor.role === 'operator' && !actor.securityControl) {
              const definition = bridge
                .snapshot(hubId)
                .snapshot?.scenes.definitions.find((item) => item.id === sceneRun[1]);
              if (
                !definition ||
                ['home', 'away'].includes(sceneRun[1]) ||
                definition.actions.some((item) => item.controller === 'security')
              )
                throw new CloudError('Нет разрешения управлять охраной в этом сценарии', 403);
            }
            const result = await callHub(
              homeId,
              hubId,
              method as CloudMethod,
              route,
              payload,
              actor,
            );
            const freshMembership = await homes.membership(current.user.id, homeId);
            if (
              !cloudPermitted(
                {
                  userId: current.user.id,
                  role: freshMembership.role,
                  securityControl: freshMembership.securityControl,
                },
                method,
                route,
                payload,
              )
            )
              throw new CloudError('Доступ изменён во время выполнения запроса', 403);
            reply(response, result.status, result.data);
            return;
          }
        }
        throw new CloudError('Метод API не найден', 404);
      }
      const portal = /^\/portal\/([a-f0-9-]{36})\/?$/.exec(path);
      if (portal && method === 'GET') {
        const current = requireSession(session),
          membership = await homes.membership(current.user.id, portal[1]);
        let source = await readFile(resolve(options.portalDir, 'index.html'), 'utf8');
        const metas = `<meta name="fcplcn-hub-api-base" content="/api/v1/homes/${portal[1]}/hub"><meta name="fcplcn-cloud-portal" content="true"><meta name="fcplcn-home-id" content="${portal[1]}"><meta name="fcplcn-cloud-role" content="${membership.role}"><meta name="fcplcn-security-control" content="${membership.securityControl}"><meta name="fcplcn-csrf-token" content="${html(current.csrfToken)}">`;
        source = source
          .replaceAll('__FCPLCN_HUB_API_BASE__', `/api/v1/homes/${portal[1]}/hub`)
          .replaceAll('__FCPLCN_HOME_ID__', portal[1])
          .replaceAll('__FCPLCN_CLOUD_ROLE__', membership.role)
          .replaceAll('__FCPLCN_SECURITY_CONTROL__', String(membership.securityControl))
          .replaceAll('__FCPLCN_CSRF_TOKEN__', html(current.csrfToken));
        if (!source.includes('name="fcplcn-hub-api-base"'))
          source = source.replace('</head>', metas + '</head>');
        response.setHeader('X-Frame-Options', 'SAMEORIGIN');
        response.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
        );
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(source);
        return;
      }
      const plc = /^\/plc\/([a-f0-9-]{36})\/(fcplcn-[a-zA-Z0-9_-]{1,96})\/?$/.exec(path);
      if (plc && method === 'GET') {
        const current = requireSession(session);
        await homes.membership(current.user.id, plc[1], true);
        let source = await readFile(resolve(options.plcDir, 'index.html'), 'utf8');
        source = source.replaceAll(
          '__FCPLCN_API_BASE__',
          `/api/v1/homes/${plc[1]}/hub/devices/${plc[2]}/service`,
        );
        source = source.replaceAll('__FCPLCN_CSRF_TOKEN__', html(current.csrfToken));
        if (!source.includes('name="fcplcn-csrf-token"'))
          source = source.replace(
            '</head>',
            `<meta name="fcplcn-csrf-token" content="${html(current.csrfToken)}"></head>`,
          );
        response.setHeader('X-Frame-Options', 'SAMEORIGIN');
        response.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
        );
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(source);
        return;
      }
      if (!['GET', 'HEAD'].includes(method)) throw new CloudError('Метод не поддерживается', 405);
      if (path.startsWith('/portal-assets/')) {
        await serve(response, options.portalDir, '/assets/' + path.slice(15), method === 'HEAD');
        return;
      }
      if (path.startsWith('/hub-assets/')) {
        await serve(response, options.portalDir, path.slice(11), method === 'HEAD');
        return;
      }
      if (path.startsWith('/plc-assets/')) {
        await serve(response, options.plcDir, path.slice(11), method === 'HEAD');
        return;
      }
      await serve(
        response,
        options.webDir,
        path === '/' || /^\/invite\/[A-Za-z0-9_-]+$/.test(path) ? '/index.html' : path,
        method === 'HEAD',
      );
    } catch (error) {
      const failure = errorBody(error);
      if (!response.headersSent)
        reply(response, failure.status, {
          error: failure.message,
          ...('unknown' in failure ? { unknown: true } : {}),
        });
      else response.destroy();
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 256;
  const application = Object.assign(server, { auth, homes, pairing }) as typeof server & {
    auth: CloudAuth;
    homes: CloudHomes;
    pairing: CloudPairing;
    readonly ready: Promise<void>;
  };
  Object.defineProperty(application, 'ready', { get: initialize });
  return application;
}
