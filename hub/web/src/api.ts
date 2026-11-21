/** @file JSON-запросы к своему хабу или облачному порталу; секреты брокера остаются на сервере. */

import { apiBase, acceptSession, csrfToken, portal } from './portal';

/** Ошибка JSON API с HTTP-кодом; код 0 обозначает недоступность сети. */
export class ApiError extends Error {
  /** Сохраняет безопасное сообщение сервера и код результата для вызывающего интерфейса. */
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Отправляет JSON-запрос с сессионной cookie и, для облачного портала, CSRF-токеном.
 * @param route Путь относительно API текущего хаба или дома.
 * @param options Параметры запроса, включая необязательный сигнал отмены.
 * @returns Разобранный ответ сервера; ошибки HTTP и сети преобразуются в ApiError.
 */
export async function api<T>(route: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${route}`, {
      ...options,
      credentials: 'same-origin',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(portal && options.method && options.method !== 'GET'
          ? { 'X-FCPLCN-CSRF': csrfToken() }
          : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError('Нет связи с хабом. Проверьте подключение к локальной сети.', 0);
  }

  const value: unknown = await response.json().catch(() => null);
  if (route === '/session' && response.ok) acceptSession(value);
  if (!response.ok) {
    const message =
      value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
        ? value.error
        : 'Хаб не смог выполнить запрос.';
    throw new ApiError(message, response.status);
  }
  return value as T;
}

/** Сериализует тело JSON, сохраняя остальную настройку запроса за вызывающим кодом. */
export const jsonBody = (data: unknown): Pick<RequestInit, 'body'> => ({
  body: JSON.stringify(data),
});
