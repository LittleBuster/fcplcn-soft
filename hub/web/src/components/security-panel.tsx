/** @file Локальная охрана PLC, подтверждённый режим и демонстрационное касание ключа. */

import { useState } from 'preact/hooks';
import type { ControllerView, DeviceView } from '../../../shared/types.js';
import { Icon } from '../icons';
import { number, text } from '../model';
import { Badge } from './common';
import type { CommandAction } from './types';

/** Отправляет явную постановку или снятие; неготовность охраны не препятствует её снятию. */
export function SecurityPanel({
  device,
  module,
  pending,
  connected,
  controlsBlocked,
  onCommand,
  onSecurityTouch,
}: {
  device: DeviceView;
  module: ControllerView;
  pending: boolean;
  connected: boolean;
  controlsBlocked: boolean;
  onCommand: CommandAction;
  onSecurityTouch?: (deviceId: string) => Promise<void>;
}) {
  const [touchError, setTouchError] = useState('');
  const [touchStatus, setTouchStatus] = useState('');
  const fresh = connected && device.online && device.status === 'online' && module.fresh;
  const armed = module.data.armed === true;
  const alarm = fresh && module.data.phase === 'alarm';
  const delayed = fresh && ['exit_delay', 'entry_delay'].includes(text(module.data.phase));
  const phases: Record<string, string> = {
    disarmed: 'Охрана снята',
    armed: 'Под охраной',
    exit_delay: 'Время на выход',
    entry_delay: 'Время на снятие',
    alarm: 'Тревога',
  };

  // Кнопка доступна только при свежем состоянии и отсутствии конкурирующей операции.
  const canCommand =
    fresh &&
    module.data.enabled === true &&
    !pending &&
    !controlsBlocked &&
    typeof module.data.armed === 'boolean' &&
    (armed || module.data.readyToArm === true);

  return (
    <div
      class={`security-panel ${alarm ? 'alarm-panel' : delayed ? 'delayed-panel' : armed && fresh ? 'armed-panel' : ''}`}
    >
      <button
        class="security-action"
        data-security-action={device.id}
        onClick={() => {
          if (canCommand) void onCommand(device.id, 'security', 'alarm', !armed);
        }}
        disabled={!canCommand}
        aria-pressed={fresh ? armed : 'mixed'}
        aria-label={
          alarm ? 'Тревога. Снять охрану' : armed ? 'Снять охрану' : 'Поставить на охрану'
        }
        aria-busy={pending}
      >
        <Icon name={alarm ? 'alarm' : 'shield'} className="security-shield" />
        <strong>
          {!fresh ? 'Нет свежих данных' : phases[text(module.data.phase)] || 'Состояние неизвестно'}
        </strong>
        <span>
          {pending
            ? 'Ожидаем подтверждения PLC…'
            : !fresh
              ? 'Управление станет доступно после восстановления связи'
              : number(module.data.remainingSeconds) && (module.data.remainingSeconds as number) > 0
                ? `Осталось ${module.data.remainingSeconds} с`
                : armed
                  ? 'Нажмите щит, чтобы снять охрану'
                  : module.data.readyToArm === true
                    ? 'Нажмите щит, чтобы поставить на охрану'
                    : text(module.data.armBlockReason, 'Настройте охрану на PLC')}
        </span>
      </button>
      {fresh && text(module.data.error) ? (
        <p class="inline-error">{text(module.data.error)}</p>
      ) : null}
      <div class="security-meta">
        <span>
          <Icon name="shield" />
          Выполняется автономно на PLC
        </span>
        <span>
          <Icon name="link" />
          Сирена{' '}
          {module.data.sirenActual === true
            ? 'включена'
            : module.data.sirenActual === false
              ? 'выключена'
              : 'не назначена / нет данных'}
        </span>
      </div>
      {onSecurityTouch ? (
        <div class="security-demo-touch">
          <button
            class="button secondary small"
            type="button"
            data-security-demo-touch={device.id}
            disabled={!fresh || module.data.enabled !== true || pending || controlsBlocked}
            aria-busy={pending}
            onClick={async () => {
              setTouchError('');
              setTouchStatus('');
              try {
                await onSecurityTouch(device.id);
                setTouchStatus('Таблетка приложена. Общий режим показан в статусе охраны дома.');
              } catch (error) {
                setTouchError(error instanceof Error ? error.message : 'Касание не подтверждено');
              }
            }}
          >
            <Icon name="key" />
            {pending ? 'Считываем…' : 'Приложить таблетку'}
          </button>
          <Badge tone="muted">Демо</Badge>
          <p>{touchError || touchStatus || 'Одно касание меняет режим охраны всего дома.'}</p>
        </div>
      ) : null}
    </div>
  );
}
