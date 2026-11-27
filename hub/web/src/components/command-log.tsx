/** @file Список отправленных команд с результатами, подтверждёнными PLC. */

import type { CommandView, DeviceView } from '../../../shared/types.js';
import { activityActorLabel, activityDateTime } from '../features/activity/labels';
import { Icon } from '../icons';
import { commandText, moduleIcons, time, titles } from '../model';
import { Empty } from './common';

/** Показывает результат каждой команды отдельно от факта её отправки на сервер. */
export function CommandLog({
  commands,
  devices,
  compact = false,
}: {
  commands: CommandView[];
  devices: DeviceView[];
  compact?: boolean;
}) {
  const entries = commands.slice(0, compact ? 5 : 100);
  if (!entries.length)
    return (
      <Empty
        icon="activity"
        title="Команд пока нет"
        detail="Здесь появятся подтверждения PLC и результаты управления из хаба."
      />
    );

  return (
    <div class={`command-log panel${compact ? '' : ' command-log-full'}`} data-command-log>
      {entries.map((command) => (
        <div class="command-row" key={command.id}>
          <div
            class={`command-icon ${command.status === 'applied' ? 'green' : command.status === 'rejected' || command.status === 'unknown' ? 'red' : ''}`}
          >
            <Icon name={moduleIcons[command.controller]} />
          </div>
          <div class="command-copy">
            <strong>
              {(compact ? undefined : command.deviceName) ||
                devices.find((device) => device.id === command.deviceId)?.name ||
                command.deviceId}
              <span> · {titles[command.controller]}</span>
            </strong>
            <p>
              {command.itemId === 'alarm'
                ? command.value
                  ? 'Поставить на охрану'
                  : 'Снять охрану'
                : `${command.itemId} · ${command.value ? 'включить' : 'выключить'}`}
              {command.error ? ` · ${command.error}` : ''}
            </p>
            {compact ? null : (
              <dl class="activity-facts command-facts">
                <div>
                  <dt>Инициатор</dt>
                  <dd>{activityActorLabel(command.actor)}</dd>
                </div>
                <div>
                  <dt>Отправлена</dt>
                  <dd>
                    <time dateTime={command.createdAt}>{activityDateTime(command.createdAt)}</time>
                  </dd>
                </div>
              </dl>
            )}
          </div>
          <div class="command-result">
            <span class={`result-${command.status}`}>{commandText(command)}</span>
            {compact ? (
              <time>{time(command.completedAt || command.createdAt)}</time>
            ) : command.completedAt ? (
              <dl class="activity-facts command-facts">
                <div>
                  <dt>{command.status === 'applied' ? 'PLC подтвердил' : 'Статус зафиксирован'}</dt>
                  <dd>
                    <time dateTime={command.completedAt}>
                      {activityDateTime(command.completedAt)}
                    </time>
                  </dd>
                </div>
              </dl>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
