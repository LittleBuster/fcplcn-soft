/** @file Страница PLC: его оборудование, имя, помещение и иллюстрация. */

import { useState } from 'preact/hooks';
import type { ControllerKind, DeviceView } from '../../../shared/types.js';
import {
  DEFAULT_DEVICE_ILLUSTRATION,
  type DeviceIllustrationId,
} from '../../../shared/device-art.js';
import { Icon } from '../icons';
import { DeviceArt } from '../device-art';
import { IllustrationPicker } from '../illustration-picker';
import { canConfigure, canManageSecurity } from '../portal';
import {
  deviceName,
  kinds,
  moduleIcons,
  rows,
  statusText,
  text,
  time,
  titles,
  uptime,
} from '../model';
import { Badge, Empty } from './common';
import { ItemCard } from './equipment-card';
import { SecurityPanel } from './security-panel';
import type { CommandAction } from './types';

/** Объединяет управление оборудованием, сведения о PLC и черновики имени и иллюстрации. */
export function DeviceDetail({
  device,
  filter,
  setFilter,
  pending,
  connected,
  onCommand,
  onRename,
  controlsBlocked = false,
  onConfigure,
  onSecurityTouch,
}: {
  device: DeviceView;
  filter: ControllerKind | 'all';
  setFilter: (kind: ControllerKind | 'all') => void;
  pending: Set<string>;
  connected: boolean;
  onCommand: CommandAction;
  onRename: (
    deviceId: string,
    name: string,
    room: string,
    illustrationId?: DeviceIllustrationId,
  ) => Promise<void>;
  controlsBlocked?: boolean;
  onConfigure?: () => void;
  onSecurityTouch?: (deviceId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [artEditing, setArtEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [room, setRoom] = useState(device.room);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const availableKinds = kinds.filter((kind) => device.controllers[kind]);

  return (
    <>
      <section
        class="device-detail-banner panel"
        data-device-illustration={device.illustrationId || DEFAULT_DEVICE_ILLUSTRATION}
      >
        <div class="detail-board">
          <DeviceArt id={device.illustrationId} />
        </div>
        <div class="detail-identity">
          <div class="eyebrow">{device.room || 'Без помещения'}</div>
          <h2>{deviceName(device)}</h2>
          <p>{device.id}</p>
          <div class="detail-tags">
            <Badge tone={device.status === 'online' ? 'green' : 'muted'}>
              {statusText(device)}
            </Badge>
            <span>{device.boardId || 'Профиль не получен'}</span>
          </div>
        </div>
        <div class="detail-actions">
          <button
            class="button secondary small"
            hidden={!canConfigure}
            onClick={() => {
              if (!editing) {
                setName(device.name);
                setRoom(device.room);
              }
              setEditing(!editing);
              setArtEditing(false);
            }}
          >
            <Icon name="room" />
            Имя и помещение
          </button>
          {canConfigure ? (
            <button
              class="button secondary small"
              data-edit-illustration={device.id}
              onClick={() => {
                setArtEditing(!artEditing);
                setEditing(false);
              }}
            >
              <Icon name="image" />
              Картинка
            </button>
          ) : null}
          {onConfigure ? (
            <button class="button small" data-plc-configure={device.id} onClick={onConfigure}>
              <Icon name="settings" />
              Настроить PLC
            </button>
          ) : null}
        </div>
      </section>
      {artEditing && canConfigure ? (
        <IllustrationPicker
          key={device.id}
          value={device.illustrationId}
          onCancel={() => setArtEditing(false)}
          onSave={async (id) => {
            await onRename(device.id, device.name || device.id, device.room, id);
            setArtEditing(false);
          }}
        />
      ) : null}
      {editing && canConfigure ? (
        <form
          class="device-edit panel"
          onSubmit={async (event) => {
            event.preventDefault();
            if (saving) return;
            setSaving(true);
            setFormError('');
            try {
              await onRename(device.id, name.trim(), room.trim());
              setEditing(false);
            } catch (error) {
              setFormError(error instanceof Error ? error.message : 'Не удалось сохранить');
            } finally {
              setSaving(false);
            }
          }}
        >
          <label>
            Название
            <input
              value={name}
              onInput={(event) => setName(event.currentTarget.value)}
              maxLength={64}
              placeholder={device.id}
              required
            />
          </label>
          <label>
            Помещение
            <input
              value={room}
              onInput={(event) => setRoom(event.currentTarget.value)}
              maxLength={64}
              placeholder="Например, гостиная"
            />
          </label>
          <button class="button" disabled={saving}>
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
          {formError ? (
            <p class="inline-error" role="alert">
              {formError}
            </p>
          ) : null}
        </form>
      ) : null}
      <div class="device-info-strip">
        <span>
          <Icon name="clock" />
          Работает {uptime(device.uptimeSec)}
        </span>
        <span>
          Прошивка <b>{device.firmwareVersion || '—'}</b>
        </span>
        <span>
          Последний пакет <b>{time(device.lastSeenAt)}</b>
        </span>
      </div>
      <nav class="module-tabs" aria-label="Контроллеры PLC">
        <button class={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
          <Icon name="settings" />
          Все модули
        </button>
        {availableKinds.map((kind) => (
          <button
            key={kind}
            class={filter === kind ? 'active' : ''}
            onClick={() => setFilter(kind)}
            data-module-tab={kind}
          >
            <Icon name={moduleIcons[kind]} />
            {titles[kind]}
            <span>
              {kind === 'security' ? '' : rows(device.controllers[kind]?.data.items).length}
            </span>
          </button>
        ))}
      </nav>
      {!availableKinds.length ? (
        <Empty
          icon="link"
          title="Ожидаем данные модулей"
          detail="PLC появится на панели после подключения к локальному MQTT-брокеру и публикации состояний."
        />
      ) : (
        availableKinds
          .filter((kind) => filter === 'all' || filter === kind)
          .map((kind) => {
            const module = device.controllers[kind]!;
            const items = rows(module.data.items);
            const busy = pending.has(`${device.id}/${kind}`);
            return (
              <section class="controller-section" key={kind} data-module={kind}>
                <div class="section-heading">
                  <h2>
                    <Icon name={moduleIcons[kind]} />
                    {titles[kind]}
                  </h2>
                  <Badge
                    tone={
                      !module.fresh ? 'muted' : module.data.enabled === true ? 'green' : 'muted'
                    }
                  >
                    {!module.fresh
                      ? 'Данные устарели'
                      : module.data.enabled === true
                        ? 'Модуль включён'
                        : 'Модуль выключен'}
                  </Badge>
                </div>
                {kind === 'security' ? (
                  <SecurityPanel
                    device={device}
                    module={module}
                    pending={busy}
                    connected={connected}
                    controlsBlocked={controlsBlocked || !canManageSecurity}
                    onCommand={onCommand}
                    onSecurityTouch={onSecurityTouch}
                  />
                ) : null}
                {!items.length ? (
                  <div class="empty-module">
                    {kind === 'security'
                      ? 'Датчики охраны ещё не настроены на PLC.'
                      : 'В этом модуле пока нет настроенных устройств.'}
                  </div>
                ) : (
                  <div class="equipment-grid">
                    {items.map((item) => (
                      <ItemCard
                        key={text(item.id)}
                        device={device}
                        kind={kind}
                        module={module}
                        item={item}
                        pending={busy}
                        connected={connected}
                        controlsBlocked={controlsBlocked}
                        onCommand={onCommand}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })
      )}
      <div class="autonomy-note">
        <Icon name="shield" />
        <p>
          Терморегулирование, кнопки и охрана выполняются на самом PLC. Потеря связи с хабом не
          останавливает его автономные функции.
        </p>
      </div>
    </>
  );
}
