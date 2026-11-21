/** @file Список отправленных команд с результатами, подтверждёнными PLC. */

import type { CommandView, DeviceView } from '../../../shared/types.js';
import { Icon } from '../icons';
import { commandText, deviceName, moduleIcons, time, titles } from '../model';
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
    <div class="command-log panel" data-command-log>
      {entries.map((command) => (
        <div class="command-row" key={command.id}>
          <div
            class={`command-icon ${command.status === 'applied' ? 'green' : command.status === 'rejected' || command.status === 'unknown' ? 'red' : ''}`}
          >
            <Icon name={moduleIcons[command.controller]} />
          </div>
          <div class="command-copy">
            <strong>
              {deviceName(
                devices.find((device) => device.id === command.deviceId) ||
                  ({ name: command.deviceId } as DeviceView),
              )}
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
          </div>
          <div class="command-result">
            <span class={`result-${command.status}`}>{commandText(command)}</span>
            <time>{time(command.completedAt || command.createdAt)}</time>
          </div>
        </div>
      ))}
    </div>
  );
}
