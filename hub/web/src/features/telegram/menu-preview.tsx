/** @file Локальный пример обычной клавиатуры бота; нажатия не отправляют команды. */
import { useState } from 'preact/hooks';
import type { ControllerKind, HubSnapshot } from '../../../../shared/types.js';
import { Icon } from '../../icons';
import { deviceName, rows, temperature, titles } from '../../model';

export function MenuPreview({ snapshot }: { snapshot: HubSnapshot | null }) {
  const [deviceId, setDeviceId] = useState('');
  const [kind, setKind] = useState<ControllerKind | null>(null);
  const devices = snapshot?.devices || [];
  const device = devices.find((entry) => entry.id === deviceId);
  const emojis: Record<ControllerKind, string> = {
    sockets: '🔌',
    lights: '💡',
    meteo: '🌤',
    thermostats: '🌡',
    security: '🛡',
  };
  const kinds: ControllerKind[] = ['sockets', 'lights', 'meteo', 'thermostats', 'security'];
  const items = kind && device?.controllers[kind] ? rows(device.controllers[kind]!.data.items) : [];

  return (
    <aside class="telegram-preview panel" aria-label="Пример меню Telegram">
      <div class="telegram-preview-heading">
        <Icon name="telegram" />
        <div>
          <strong>{snapshot?.product.name || 'Бот дома'}</strong>
          <span>Пример меню бота</span>
        </div>
      </div>
      <div class="telegram-bubble">
        <strong>{device ? `🏡 ${deviceName(device)}` : '🏠 Мой дом'}</strong>
        <p>{kind ? titles[kind] : device ? 'Контроллеры' : 'Быстрые сценарии и устройства'}</p>
        {kind ? (
          <ul>
            {items.length ? (
              items
                .slice(0, 6)
                .map((item, index) => (
                  <li key={String(item.id || index)}>
                    {kind === 'meteo'
                      ? `🌡 ${String(item.name || 'Датчик')}: ${temperature(item.temperatureC)} °C`
                      : `${item.actual === true ? '🟢' : '⚪'} ${String(item.name || 'Канал')}`}
                  </li>
                ))
            ) : (
              <li>
                {kind === 'security'
                  ? '🛡 Состояние охраны и датчиков'
                  : 'Настроенные каналы появятся здесь'}
              </li>
            )}
          </ul>
        ) : device ? (
          <ul>
            {kinds
              .filter((entry) => device.controllers[entry])
              .map((entry) => (
                <li key={entry}>
                  {emojis[entry]} {titles[entry]}:{' '}
                  {rows(device.controllers[entry]?.data.items).length}
                </li>
              ))}
          </ul>
        ) : (
          <p class="telegram-preview-hint">
            Статусы приходят сообщением, управление — обычными кнопками под ним.
          </p>
        )}
      </div>
      <div class="telegram-keyboard">
        {!device ? (
          <>
            <div class="telegram-quick-preview">
              <span>🏠 Я дома</span>
              <span>🚪 Ушел</span>
              <span>🌅 Готовлюсь</span>
            </div>
            <div class="telegram-preview-buttons">
              {devices.slice(0, 6).map((entry) => (
                <button type="button" key={entry.id} onClick={() => setDeviceId(entry.id)}>
                  🏡 {deviceName(entry)}
                </button>
              ))}
            </div>
          </>
        ) : kind ? (
          <>
            <div class="telegram-preview-buttons">
              {items.slice(0, 4).map((item, index) => (
                <span key={String(item.id || index)}>
                  {emojis[kind]} {String(item.name || 'Канал')}
                </span>
              ))}
            </div>
            <button type="button" onClick={() => setKind(null)}>
              ⬅️ Контроллеры
            </button>
          </>
        ) : (
          <>
            <div class="telegram-preview-buttons">
              {kinds
                .filter((entry) => device.controllers[entry])
                .map((entry) => (
                  <button type="button" key={entry} onClick={() => setKind(entry)}>
                    {emojis[entry]} {titles[entry]}
                  </button>
                ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setDeviceId('');
                setKind(null);
              }}
            >
              ⬅️ Устройства
            </button>
          </>
        )}
      </div>
      <p class="telegram-preview-caption">
        Это предварительный просмотр. Кнопки здесь не переключают оборудование.
      </p>
    </aside>
  );
}
