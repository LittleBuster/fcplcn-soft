/** @file Общий контракт действия над оборудованием PLC для компонентов хаба. */

import type { WritableControllerKind } from '../../../shared/types.js';

/** Отправляет явное значение канала и завершается после обработки результата команды. */
export interface CommandAction {
  (deviceId: string, kind: WritableControllerKind, itemId: string, value: boolean): Promise<void>;
}
