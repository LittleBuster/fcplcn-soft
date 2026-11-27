/** @file Same-origin web and API server for local PLC supervision. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { HubEngine, Product } from '../shared/types.js';
import { Sessions } from './auth.js';
import { CredentialStore, type HubCredentials } from './credentials.js';
import { isLoopback, type HubConfig } from './config.js';
import { Scenes } from './scenes.js';
import type { SceneScheduler } from './scheduler.js';
import type { TelegramView } from '../shared/telegram.js';
import { HubControl, type TelegramAPI } from './control.js';
export type { TelegramAPI } from './control.js';
import type { CloudMethod, HubCloudView } from '../shared/cloud.js';
import { TelegramAPIError } from './telegram/client.js';
import type { ReadMeteoHistory } from './meteo-history.js';
import { withActivity } from './activity-context.js';
import {
  connectionFleetHistory,
  connectionHistory,
  connectionHistoryRange,
  type ReadConnectionOutages,
} from './connection-history.js';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function reply(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

async function body(
  request: IncomingMessage,
  maximumBytes = 8192,
): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw Object.assign(new Error('Нужен запрос application/json'), { status: 415 });
  let size = 0;
  const parts: Buffer[] = [];
  for await (const part of request) {
    const bytes = Buffer.from(part as Uint8Array);
    size += bytes.length;
    if (size > maximumBytes)
      throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
    parts.push(bytes);
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Некорректный JSON'), { status: 400 });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw Object.assign(new Error('Ожидается объект JSON'), { status: 400 });
  return data as Record<string, unknown>;
}

/** Reject cross-site writes and DNS-rebinding hostnames on the default loopback listener. */
function allowedOrigin(request: IncomingMessage, config: HubConfig): boolean {
  try {
    const host = request.headers.host;
    if (!host) return false;
    const target = new URL(`http://${host}`);
    if (isLoopback(config.host) && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
      return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    const source = new URL(origin);
    return ['http:', 'https:'].includes(source.protocol) && source.host === target.host;
  } catch {
    return false;
  }
}

export interface HubCloudAPI {
  snapshot(): HubCloudView;
  pair(body: unknown): Promise<HubCloudView>;
  update(body: unknown): HubCloudView;
  disconnect(): Promise<HubCloudView>;
}

export interface ServerOptions {
  config: HubConfig;
  engine: HubEngine;
  product: Product;
  webDir: string;
  scenes?: Scenes;
  scheduler?: SceneScheduler;
  onManualCommandBusy?: (busy: boolean) => void;
  plcDir?: string;
  telegram?: TelegramAPI;
  onControlReady?: (actions: HubControl) => void;
  control?: HubControl;
  cloud?: HubCloudAPI;
  credentials?: HubCredentials;
  meteoHistory?: ReadMeteoHistory;
  connectionOutages?: ReadConnectionOutages;
}

export function createHubServer({
  config,
  engine,
  product,
  webDir,
  scenes: suppliedScenes,
  scheduler,
  onManualCommandBusy,
  plcDir,
  telegram,
  onControlReady,
  control: suppliedControl,
  cloud,
  credentials,
  meteoHistory,
  connectionOutages,
}: ServerOptions) {
  const sessions = new Sessions(
    credentials || new CredentialStore(config.dataDir, config.password),
  );
  const scenes = suppliedScenes || new Scenes(engine);
  const controls =
    suppliedControl ||
    new HubControl({
      engine,
      scenes,
      scheduler,
      product,
      mode: config.mode,
      dataDir: config.dataDir,
      telegram,
      onBusy: onManualCommandBusy,
    });
  onControlReady?.(controls);
  const directory = resolve(webDir);
  const plcDirectory = resolve(plcDir || resolve(directory, '../plc'));
  const session = (request: IncomingMessage, response: ServerResponse) => ({
    authenticated: sessions.authenticated(request, response),
    requiresLogin: sessions.required,
    product,
    mode: config.mode,
  });
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      if (!allowedOrigin(request, config)) {
        reply(response, 403, { error: 'Недопустимый источник запроса' });
        return;
      }
      const url = new URL(request.url || '/', 'http://fcplcn.local');
      const path = decodeURIComponent(url.pathname);
      const method = request.method || 'GET';
      if (method === 'GET' && path === '/health') {
        reply(response, 200, {
          status: 'ok',
          product: product.name,
          mode: config.mode,
          brokerConnected: engine.snapshot().broker.connected,
        });
        return;
      }
      if (method === 'GET' && path === '/api/v1/session') {
        reply(response, 200, session(request, response));
        return;
      }
      if (method === 'POST' && path === '/api/v1/auth/login') {
        const data = await body(request);
        const status = sessions.login(request, response, data.username, data.password);
        reply(
          response,
          status,
          status === 200
            ? session(requestAfterLogin(request, response), response)
            : {
                error:
                  status === 503
                    ? 'Хранилище учётной записи хаба недоступно'
                    : status === 429
                      ? 'Слишком много попыток. Повторите через минуту'
                      : 'Проверьте логин и пароль',
              },
        );
        return;
      }
      if ((method === 'GET' || method === 'HEAD') && path.startsWith('/plc-assets/')) {
        const file = resolve(plcDirectory, `.${path.slice('/plc-assets'.length)}`);
        if (
          !file.startsWith(plcDirectory + sep) ||
          !mime[extname(file)] ||
          extname(file) === '.html' ||
          path.includes('\0') ||
          path.includes('\\')
        ) {
          reply(response, 404, { error: 'Файл панели PLC не найден' });
          return;
        }
        try {
          const content = await readFile(file);
          response.writeHead(200, {
            'Content-Type': mime[extname(file)],
            'Cache-Control': 'no-cache',
          });
          response.end(method === 'HEAD' ? undefined : content);
        } catch {
          reply(response, 404, { error: 'Файл панели PLC не найден' });
        }
        return;
      }
      const plcFrame = /^\/plc\/(fcplcn-[a-zA-Z0-9_-]{1,96})\/?$/.exec(path);
      if (method === 'GET' && plcFrame) {
        if (!sessions.authenticated(request, response)) {
          reply(response, 401, { error: 'Войдите в хаб' });
          return;
        }
        const device = engine.snapshot().devices.find((device) => device.id === plcFrame[1]);
        if (!device) {
          reply(response, 404, { error: 'PLC не найден' });
          return;
        }
        const html = (await readFile(resolve(plcDirectory, 'index.html'), 'utf8')).replaceAll(
          '__FCPLCN_API_BASE__',
          `/api/v1/devices/${plcFrame[1]}/service`,
        );
        response.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
        );
        response.setHeader('X-Frame-Options', 'SAMEORIGIN');
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(html);
        return;
      }
      if (path.startsWith('/api/')) {
        if (!sessions.authenticated(request, response)) {
          reply(response, 401, { error: 'Войдите в хаб' });
          return;
        }
        if (method === 'POST' && path === '/api/v1/auth/logout') {
          await body(request);
          sessions.logout(request, response);
          reply(response, 200, { ok: true });
          return;
        }
        if (method === 'GET' && path === '/api/v1/account') {
          reply(response, 200, sessions.account());
          return;
        }
        if (method === 'POST' && path === '/api/v1/account') {
          const status = await sessions.change(request, response, await body(request));
          reply(
            response,
            status,
            status === 200
              ? { ok: true, requiresLogin: true }
              : {
                  error:
                    status === 503
                      ? 'Хранилище учётной записи хаба недоступно'
                      : status === 403
                        ? 'Текущий пароль неверен'
                        : status === 429
                          ? 'Слишком много попыток. Повторите через минуту'
                          : 'Укажите логин и пароль от 8 символов либо оставьте новый пароль пустым',
                },
          );
          return;
        }
        if (path === '/api/v1/cloud' || path.startsWith('/api/v1/cloud/')) {
          if (!cloud) {
            reply(response, 503, { error: 'Служба облака не запущена' });
            return;
          }
          if (method === 'GET' && path === '/api/v1/cloud') {
            reply(response, 200, cloud.snapshot());
            return;
          }
          if (method === 'POST' && path === '/api/v1/cloud') {
            reply(response, 200, cloud.update(await body(request)));
            return;
          }
          if (method === 'POST' && path === '/api/v1/cloud/pair') {
            reply(response, 200, await cloud.pair(await body(request)));
            return;
          }
          if (method === 'POST' && path === '/api/v1/cloud/disconnect') {
            if (Object.keys(await body(request)).length) {
              reply(response, 400, { error: 'Отключение не принимает параметры' });
              return;
            }
            reply(response, 200, await cloud.disconnect());
            return;
          }
          reply(response, 404, { error: 'Метод облака не найден' });
          return;
        }
        const relative = path.slice('/api/v1'.length);
        const history =
          /^\/devices\/(fcplcn-[a-zA-Z0-9_-]{1,96})\/meteo\/([a-zA-Z0-9_-]{1,32})\/history$/.exec(
            relative,
          );
        if (method === 'GET' && history) {
          const period = url.searchParams.get('period') ?? 'day';
          if (period !== 'day' && period !== 'week') {
            reply(response, 400, { error: 'Выберите график за сутки или за неделю' });
          } else if (!meteoHistory) {
            reply(response, 503, { error: 'История метеодатчиков недоступна' });
          } else {
            reply(response, 200, await meteoHistory(history[1], history[2], period));
          }
          return;
        }
        const connection = /^\/devices\/(fcplcn-[a-zA-Z0-9_-]{1,96})\/connection-history$/.exec(
          relative,
        );
        if (method === 'GET' && (connection || relative === '/devices/connection-history')) {
          const period = url.searchParams.get('period') ?? 'day';
          if (period !== 'day' && period !== 'week') {
            reply(response, 400, { error: 'Выберите график за сутки или за неделю' });
            return;
          }
          const deviceId = connection?.[1] ?? null;
          const range = connectionHistoryRange(period);
          try {
            const stored = (await connectionOutages?.(deviceId, range.from, range.to)) ?? [];
            const snapshot = engine.snapshot();
            const current = snapshot.outages ?? [];
            const history = connectionHistory(deviceId, range, [...stored, ...current]);
            if (deviceId === null) {
              reply(response, 200, connectionFleetHistory(history, snapshot.devices));
            } else if (
              !history.outages.length &&
              !snapshot.devices.some(({ id }) => id === deviceId) &&
              !current.some((outage) => outage.deviceId === deviceId)
            ) {
              reply(response, 404, { error: 'PLC не найден' });
            } else reply(response, 200, history);
          } catch {
            reply(response, 503, { error: 'История связи с PLC недоступна' });
          }
          return;
        }
        const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
        const maximum = relative.includes('/service/')
          ? 40 * 1024
          : relative.startsWith('/scenes')
            ? 32 * 1024
            : relative === '/telegram'
              ? 24 * 1024
              : 8192;
        const payload = mutating ? await body(request, maximum) : {};
        const abort = new AbortController();
        const cancel = () => {
          if (!response.writableFinished) abort.abort();
        };
        response.once('close', cancel);
        try {
          const result = await withActivity(
            { actor: { source: 'web', name: sessions.account().username } },
            () =>
              controls.dispatch(method as CloudMethod, relative, payload, { signal: abort.signal }),
          );
          if (!response.destroyed) reply(response, result.status, result.data);
        } finally {
          response.off('close', cancel);
        }
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') {
        reply(response, 405, { error: 'Метод не поддерживается' });
        return;
      }
      const file = resolve(directory, path === '/' ? 'index.html' : `.${path}`);
      if (
        !file.startsWith(directory + sep) ||
        !mime[extname(file)] ||
        path.includes('\0') ||
        path.includes('\\')
      ) {
        reply(response, 404, { error: 'Файл не найден' });
        return;
      }
      try {
        const content = await readFile(file);
        response.writeHead(200, {
          'Content-Type': mime[extname(file)],
          'Cache-Control': path.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        });
        response.end(method === 'HEAD' ? undefined : content);
      } catch (error) {
        if (['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code || ''))
          reply(response, 404, { error: 'Файл не найден' });
        else throw error;
      }
    } catch (error) {
      const failure = error as { status?: number; statusCode?: number; message?: string };
      const status = failure.status || failure.statusCode || 500;
      if (!response.headersSent)
        reply(response, status, {
          error:
            status < 500 || error instanceof TelegramAPIError
              ? failure.message
              : 'Не удалось выполнить запрос',
        });
      else response.destroy();
    }
  });
  server.once('close', () => controls.close());
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

/** Build the login response from the newly issued cookie without a second request round trip. */
function requestAfterLogin(request: IncomingMessage, response: ServerResponse): IncomingMessage {
  const header = response.getHeader('Set-Cookie');
  if (typeof header === 'string') request.headers.cookie = header.split(';')[0];
  return request;
}
