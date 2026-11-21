/**
 * @file JSON-запросы облачной панели в пределах текущего сайта.
 * @description CSRF-токен хранится в памяти вкладки; полномочия хаба сюда не передаются.
 */

let csrf = '';

/** Ошибка API с HTTP-статусом; статус 0 обозначает недоступность сервера. */
export class APIError extends Error {
  /**
   * @param message Сообщение, которое можно показать пользователю.
   * @param status HTTP-статус ответа или 0 при сетевой ошибке.
   */
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Обновляет CSRF-токен после чтения сессии; null сбрасывает токен в памяти. */
export function sessionToken(token: string | null) {
  csrf = token || '';
}

/**
 * Выполняет авторизованный JSON-запрос и сообщает о завершившейся сессии.
 *
 * @param path Путь относительно /api/v1, без адреса другого сервера.
 * @param body Тело запроса; отсутствие тела выбирает GET по умолчанию.
 * @param method HTTP-метод; изменяющие запросы получают CSRF-заголовок.
 * @param signal Позволяет отменить запрос при смене страницы или сессии.
 * @returns Разобранный ответ API, приведённый к контракту вызывающего кода.
 * @throws {APIError} Сервер отклонил запрос или соединение недоступно.
 */
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/v1' + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'X-FCPLCN-CSRF': csrf }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    // Отмена принадлежит вызывающему коду и не должна выглядеть как потеря связи.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new APIError('Нет связи с облаком FCPLCn. Проверьте подключение.', 0);
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    // Одно событие переводит оболочку в форму входа и убирает старые данные дома.
    if (response.status === 401 && csrf) {
      csrf = '';
      window.dispatchEvent(new Event('fcplcn:session-ended'));
    }
    throw new APIError(
      value && typeof value.error === 'string' ? value.error : 'Не удалось выполнить запрос.',
      response.status,
    );
  }
  return value as T;
}
