/** @file Домашний пульт для планшета: плитки оборудования и сценариев дома. */
import { useState } from 'preact/hooks';
import type { HubSnapshot } from '../../../shared/types.js';
import type { PultSettingsView } from '../../../shared/pult.js';
import type { CommandAction, ConfigureIrrigation } from '../components/types';
import { deviceName } from '../model';
import { Icon } from '../icons';
import { PultControlTile } from '../features/pult/control-tile';
import { PultScenes, type PultSceneActions } from '../features/pult/scenes';
import type { SceneGroup } from '../features/scenes/types';
import { PultSummary } from '../features/pult/summary';
import {
  pultEntries,
  pultIcons,
  pultKinds,
  pultLabels,
  type PultFilter,
} from '../features/pult/model';
import '../styles/pult.css';

interface PultPageProps extends PultSceneActions {
  sceneGroup: SceneGroup | null;
  onSelectSceneGroup: (group: SceneGroup | null) => void;
  hubAvailable: boolean;
  snapshot: HubSnapshot;
  pending: Set<string>;
  connected: boolean;
  controlsBlocked: boolean;
  onCommand: CommandAction;
  configureIrrigation?: ConfigureIrrigation;
  openDevice: (id: string) => void;
  onPultSettingsSaved: (value: PultSettingsView) => void;
}

/** Читает тот же снимок и использует тот же подтверждаемый командный путь, что панель PLC. */
export function PultPage({
  snapshot,
  pending,
  connected,
  controlsBlocked,
  onCommand,
  configureIrrigation,
  openDevice,
  onPultSettingsSaved,
  sceneGroup,
  onSelectSceneGroup,
  onRun,
  onSchedule,
  hubAvailable,
}: PultPageProps) {
  const [selectedRoom, setRoom] = useState('');
  const [filter, setFilter] = useState<PultFilter>('all');
  const entries = pultEntries(snapshot);
  const rooms = [...new Set(entries.map((entry) => entry.room))];
  // Удалённое помещение не оставляет пульт в невидимом устаревшем фильтре.
  const room = rooms.includes(selectedRoom) ? selectedRoom : '';
  const roomEntries = entries.filter((entry) => !room || entry.room === room);
  const visible = roomEntries.filter((entry) => filter === 'all' || entry.kind === filter);
  const irrigationDevices =
    (filter === 'irrigation' || (filter === 'all' && !entries.length)) &&
    configureIrrigation &&
    connected
      ? snapshot.devices.filter(
          (device) =>
            device.online &&
            device.management?.supported &&
            device.controllers.irrigation &&
            (!room || (device.room || deviceName(device)) === room),
        )
      : [];
  const filters: PultFilter[] = ['all', ...pultKinds];

  function selectRoom(value: string) {
    setRoom(value);
    if (sceneGroup) onSelectSceneGroup(null);
  }

  return (
    <div class="pult-page" data-pult>
      <PultSummary
        snapshot={snapshot}
        entries={entries}
        connected={connected}
        onPultSettingsSaved={onPultSettingsSaved}
      />
      <nav class="pult-rooms" aria-label="Разделы пульта">
        <button
          type="button"
          class={!sceneGroup && !room ? 'active' : ''}
          aria-pressed={!sceneGroup && !room}
          data-pult-room="all"
          onClick={() => selectRoom('')}
        >
          <Icon name="home" />
          Весь дом
        </button>
        <button
          type="button"
          class={sceneGroup ? 'active' : ''}
          aria-pressed={Boolean(sceneGroup)}
          data-pult-tab="scenes"
          onClick={() => onSelectSceneGroup(sceneGroup ?? 'instant')}
        >
          <Icon name="prepare" />
          Сценарии
        </button>
        {rooms.map((value) => (
          <button
            key={value}
            type="button"
            class={!sceneGroup && room === value ? 'active' : ''}
            aria-pressed={!sceneGroup && room === value}
            data-pult-room={value}
            onClick={() => selectRoom(value)}
          >
            {value}
          </button>
        ))}
      </nav>
      {sceneGroup ? (
        <PultScenes
          group={sceneGroup}
          onSelectGroup={onSelectSceneGroup}
          snapshot={snapshot.scenes}
          connected={connected}
          hubAvailable={hubAvailable}
          manualBusy={controlsBlocked || pending.size > 0}
          onRun={onRun}
          onSchedule={onSchedule}
        />
      ) : (
        <>
          <div class="pult-section-heading">
            <h2>{room || 'Управление домом'}</h2>
            <span>
              {visible.length}{' '}
              {visible.length === 1
                ? 'устройство'
                : visible.length >= 2 && visible.length <= 4
                  ? 'устройства'
                  : 'устройств'}
            </span>
          </div>
          <nav class="pult-filters" aria-label="Оборудование пульта">
            {filters.map((kind) => {
              const count =
                kind === 'all'
                  ? roomEntries.length
                  : roomEntries.filter((entry) => entry.kind === kind).length;
              return (
                <button
                  key={kind}
                  type="button"
                  class={filter === kind ? 'active' : ''}
                  aria-pressed={filter === kind}
                  data-pult-filter={kind}
                  onClick={() => setFilter(kind)}
                >
                  <Icon name={pultIcons[kind]} />
                  {pultLabels[kind]}
                  <span>{count}</span>
                </button>
              );
            })}
          </nav>
          {visible.length ? (
            <div class="pult-controls">
              {visible.map((entry) => (
                <PultControlTile
                  key={entry.key}
                  entry={entry}
                  pending={pending.has(`${entry.device.id}/${entry.kind}`)}
                  connected={connected}
                  controlsBlocked={controlsBlocked}
                  configureIrrigation={configureIrrigation}
                  onCommand={onCommand}
                  openDevice={openDevice}
                />
              ))}
            </div>
          ) : (
            <section class="pult-empty" role="status">
              <Icon name={pultIcons[filter]} />
              <h3>
                {filter === 'irrigation'
                  ? 'Правил полива пока нет'
                  : entries.length
                    ? 'Здесь пока нет устройств'
                    : 'Дом готов к подключению'}
              </h3>
              <p>
                {irrigationDevices.length
                  ? 'Выберите PLC для настройки первого правила полива.'
                  : entries.length
                    ? 'Выберите другое помещение или вид оборудования.'
                    : 'Настроенные на PLC свет, розетки, климат, датчики, баки и полив появятся на пульте автоматически.'}
              </p>
              {irrigationDevices.map((device) => (
                <button
                  key={device.id}
                  type="button"
                  class="button secondary small"
                  onClick={() => configureIrrigation?.(device.id)}
                >
                  <Icon name="settings" />
                  {deviceName(device)} · Добавить правило
                </button>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
