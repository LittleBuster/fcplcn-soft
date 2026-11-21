/** @file Карточка PLC в общем списке устройств. */

import type { DeviceView } from '../../../shared/types.js';
import { DEFAULT_DEVICE_ILLUSTRATION } from '../../../shared/device-art.js';
import { Icon } from '../icons';
import { DeviceArt } from '../device-art';
import { deviceName, kinds, moduleIcons, rows, statusText, titles } from '../model';
import { Badge } from './common';

/** Показывает PLC, его иллюстрацию и только свежую подтверждённую тревогу. */
export function DeviceCard({ device, onOpen }: { device: DeviceView; onOpen: () => void }) {
  const alarm =
    device.controllers.security?.fresh && device.controllers.security.data.phase === 'alarm';

  return (
    <button
      class={`device-card ${device.online ? '' : 'device-offline'} ${alarm ? 'has-alarm' : ''}`}
      onClick={onOpen}
      data-device-id={device.id}
      data-device-illustration={device.illustrationId || DEFAULT_DEVICE_ILLUSTRATION}
    >
      <div class="device-topline">
        <span class="eyebrow">{device.room || 'Без помещения'}</span>
        <Badge tone={alarm ? 'red' : device.status === 'online' ? 'green' : 'muted'}>
          {alarm ? 'Тревога' : statusText(device)}
        </Badge>
      </div>
      <div class="device-illustration">
        <DeviceArt id={device.illustrationId} />
      </div>
      <div class="device-card-title">
        <h3>{deviceName(device)}</h3>
        <Icon name="arrow" />
      </div>
      <p class="device-model">{device.boardId || 'Модель ожидается'}</p>
      <div class="device-modules">
        {kinds
          .filter((kind) => device.controllers[kind])
          .map((kind) => (
            <span
              key={kind}
              title={titles[kind]}
              class={kind === 'security' && alarm ? 'red-text' : ''}
            >
              <Icon name={moduleIcons[kind]} />
              {kind === 'security'
                ? alarm
                  ? 'Тревога'
                  : 'Охрана'
                : rows(device.controllers[kind]?.data.items).length}
            </span>
          ))}
      </div>
      <span class="device-open-label">
        Открыть контроллер <Icon name="arrow" />
      </span>
    </button>
  );
}
