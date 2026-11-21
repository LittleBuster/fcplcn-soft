/** @file Подписи ролей, форматирование дат и копирование пользовательских значений. */
import type { CloudRole } from '../../../shared/api.js';

/** Названия облачных ролей; право управления охраной назначается отдельно. */
export const roles: Record<CloudRole, string> = {
  owner: 'Владелец',
  operator: 'Пользователь',
  viewer: 'Наблюдатель',
};

/** Форматирует время для пользователя, отдельно обозначая отсутствие первого подключения. */
export const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
    : 'Ещё не подключался';

/** Возвращает пригодное для интерфейса сообщение без предположений о типе исключения. */
export const failure = (error: unknown) =>
  error instanceof Error ? error.message : 'Не удалось выполнить действие';

/** Копирует значение; если Clipboard API недоступен, оставляет способ скопировать вручную. */
export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    window.prompt('Скопируйте значение:', text);
  }
}
