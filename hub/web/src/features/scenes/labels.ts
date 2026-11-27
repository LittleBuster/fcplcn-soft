/** @file Названия встроенных сценариев, статусов и пояснения результатов. */

import type { SceneActionResult, SceneId, SceneRun } from '../../../../shared/types.js';
import type { IconName } from '../../icons';

export const scenes: { id: SceneId; name: string; icon: IconName; caption: string }[] = [
  { id: 'home', name: 'Я дома', icon: 'home', caption: 'Снять охрану и встретить вас дома' },
  { id: 'away', name: 'Ушел', icon: 'away', caption: 'Поставить дом под охрану' },
  { id: 'prepare', name: 'Готовлюсь', icon: 'car', caption: 'Подготовить свет и комфорт' },
];
export const runLabels: Record<SceneRun['status'], string> = {
  running: 'Выполняется',
  completed: 'Все команды подтверждены',
  partial: 'Выполнено частично',
  failed: 'Команды не выполнены',
  empty: 'Нет действий для запуска',
  interrupted: 'Запуск прерван',
};
export const resultLabels: Record<SceneActionResult['status'], string> = {
  pending: 'Ожидаем PLC',
  applied: 'Подтверждено',
  rejected: 'Отклонено',
  unknown: 'Не подтверждено',
  unavailable: 'PLC недоступен',
  skipped: 'Не выполнялось',
};

/**
 * Заменяет внутренние сообщения протокола понятной причиной отказа или отсутствия подтверждения.
 */
export function readableError(error: string | null): string {
  if (!error) return '';
  if (/[а-яё]/i.test(error)) return error;
  if (/offline|connect|unavailable|broker|stale|fresh|heartbeat|boot/i.test(error))
    return 'Нет свежей связи с PLC';
  if (/timeout|unknown/i.test(error)) return 'PLC не подтвердил выполнение';
  return 'Действие не выполнено. Проверьте состояние PLC.';
}

/** Формирует подпись явного действия: режим охраны либо включение или выключение канала. */
export function actionLabel(result: SceneActionResult): string {
  if (result.controller === 'irrigation')
    return `${result.itemName || result.itemId} · ${result.value ? 'включить' : 'выключить'} правило`;
  return result.controller === 'security'
    ? result.value
      ? 'Поставить на охрану'
      : 'Снять охрану'
    : `${result.itemName || result.itemId} · ${result.value ? 'включить' : 'выключить'}`;
}
