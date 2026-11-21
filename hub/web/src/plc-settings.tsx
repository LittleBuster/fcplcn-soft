/** @file Встроенная сервисная панель PLC с сохранением черновика при обновлении статусов. */

import { useEffect, useState } from 'preact/hooks';
import type { DeviceView } from '../../shared/types.js';
import { Badge } from './components';
import { Icon } from './icons';
import { deviceName, statusText } from './model';
import { homeId, portal } from './portal';

/** Сохраняет уже открытый iframe при потере статуса PLC, чтобы не потерять черновик настроек. */
export function PLCSettings({
  deviceId,
  device,
  onBack,
}: {
  deviceId: string;
  device?: DeviceView;
  onBack: () => void;
}) {
  const supported = device?.management?.supported === true;
  const [opened, setOpened] = useState(supported);

  useEffect(() => {
    if (supported) setOpened(true);
  }, [supported]);

  return (
    <section class="plc-settings-view" data-plc-settings={deviceId}>
      <div class="plc-settings-heading panel">
        <div>
          <span class="eyebrow">Настройка через хаб</span>
          <h2>
            <Icon name="plc" />
            {device ? deviceName(device) : deviceId}
          </h2>
          <p>
            Все настройки сохраняются на самом PLC. Веб-панель доступна через локальный MQTT-брокер.
          </p>
        </div>
        <div>
          <Badge tone={device?.online ? 'green' : 'muted'}>
            {device ? statusText(device) : 'Ожидаем данные'}
          </Badge>
          <button class="button secondary small" data-plc-settings-back onClick={onBack}>
            <Icon name="back" />К управлению
          </button>
        </div>
      </div>
      {!device?.online && opened ? (
        <div class="notice warning" role="status">
          <Icon name="link" />
          <span>
            Нет свежей связи с PLC. Несохранённые настройки остаются в редакторе. После
            восстановления связи обновите состояние перед сохранением.
          </span>
        </div>
      ) : null}
      {!supported && !opened ? (
        <div class="plc-upgrade-message panel">
          <Icon name="plc" />
          <h3>Обновите прошивку PLC</h3>
          <p>
            Эта версия прошивки ещё не поддерживает полную настройку через хаб. После установки
            прошивки с поддержкой удалённой настройки здесь откроются все разделы PLC.
          </p>
          <button class="button secondary" onClick={onBack}>
            <Icon name="back" />
            Вернуться к управлению
          </button>
        </div>
      ) : null}
      {opened ? (
        <iframe
          key={deviceId}
          class="plc-settings-frame"
          data-plc-settings-frame
          title={`Настройки PLC ${device ? deviceName(device) : deviceId}`}
          src={
            portal
              ? `/plc/${encodeURIComponent(homeId)}/${encodeURIComponent(deviceId)}/`
              : `/plc/${encodeURIComponent(deviceId)}/`
          }
        />
      ) : null}
    </section>
  );
}
