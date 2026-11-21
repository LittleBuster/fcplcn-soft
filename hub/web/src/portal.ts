/** @file Параметры облачного встраивания, права интерфейса и текущий CSRF-токен. */

/** Читает параметр встраивания, заданный сервером в метаданных страницы. */
const metadata = (name: string) =>
  document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || '';

// Путь API и отображаемые права задаёт сервер конкретного дома.
const configured = metadata('fcplcn-hub-api-base');
export const portal =
  metadata('fcplcn-cloud-portal') === 'true' &&
  /^\/api\/v1\/homes\/[a-zA-Z0-9_-]{1,96}\/hub$/.test(configured);
export const apiBase = portal ? configured : '/api/v1';
export const homeId = portal ? configured.split('/')[4] : '';
export const portalRole = portal ? metadata('fcplcn-cloud-role') : 'owner';
export const canConfigure = !portal || portalRole === 'owner';
export const canControl = !portal || portalRole === 'owner' || portalRole === 'operator';
export const canManageSecurity =
  !portal || portalRole === 'owner' || metadata('fcplcn-security-control') === 'true';

// Токен обновляется при чтении сессии; сервер повторно проверяет права каждой операции.
let csrf = portal ? metadata('fcplcn-csrf-token') : '';

/** Возвращает текущий CSRF-токен для изменяющих запросов облачного портала. */
export const csrfToken = () => csrf;

/** Принимает новый ограниченный по длине CSRF-токен только в режиме облачного портала. */
export function acceptSession(value: unknown): void {
  if (
    portal &&
    value &&
    typeof value === 'object' &&
    'csrfToken' in value &&
    typeof value.csrfToken === 'string' &&
    value.csrfToken.length <= 256
  )
    csrf = value.csrfToken;
}
