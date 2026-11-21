/** @file Отдельные уведомления о связи и результате текущего действия. */
import type { HubSnapshot } from '../../../shared/types.js';
import type { Notice } from './types';
import { Icon } from '../icons';

/** Устаревший снимок остаётся видимым, но не считается разрешением управлять PLC. */
export function ConnectionNotice({
  snapshot,
  loadError,
}: {
  snapshot: HubSnapshot | null;
  loadError: string;
}) {
  return loadError ? (
    <div class="notice error" role="alert">
      <Icon name="link" />
      <span>{loadError} Управление временно отключено.</span>
    </div>
  ) : snapshot && !snapshot.broker.connected ? (
    <div class="notice warning" role="status">
      <Icon name="link" />
      <span>
        {snapshot.broker.error || 'Нет связи с MQTT-брокером.'} Состояния показаны для справки;
        команды недоступны.
      </span>
    </div>
  ) : null;
}

/** Новое действие заменяет прежнее уведомление; закрытие не меняет журнал команд. */
export function ActionNotice({
  notice,
  onDismiss,
}: {
  notice: Notice | null;
  onDismiss: () => void;
}) {
  return notice ? (
    <div class={`notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      <Icon
        name={notice.tone === 'success' ? 'check' : notice.tone === 'error' ? 'alarm' : 'clock'}
      />
      <span>{notice.text}</span>
      <button class="notice-dismiss" onClick={onDismiss} aria-label="Закрыть уведомление">
        ×
      </button>
    </div>
  ) : null;
}
