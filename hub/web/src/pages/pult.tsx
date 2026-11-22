/** @file Домашний пульт для планшета: крупные каналы оборудования без быстрых сценариев. */
import { useState } from 'preact/hooks';
import type { HubSnapshot } from '../../../shared/types.js';
import type { PultSettingsView } from '../../../shared/pult.js';
import type { CommandAction } from '../components/types';
import { Icon } from '../icons';
import { PultControlTile } from '../features/pult/control-tile';
import { PultSummary } from '../features/pult/summary';
import {
  pultEntries,
  pultIcons,
  pultKinds,
  pultLabels,
  type PultFilter,
} from '../features/pult/model';
import '../styles/pult.css';

interface PultPageProps {
  snapshot: HubSnapshot;
  pending: Set<string>;
  connected: boolean;
  controlsBlocked: boolean;
  onCommand: CommandAction;
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
  openDevice,
  onPultSettingsSaved,
}: PultPageProps) {
  const [selectedRoom, setRoom] = useState('');
  const [filter, setFilter] = useState<PultFilter>('all');
  const entries = pultEntries(snapshot);
  const rooms = [...new Set(entries.map((entry) => entry.room))];
  // Удалённое помещение не оставляет пульт в невидимом устаревшем фильтре.
  const room = rooms.includes(selectedRoom) ? selectedRoom : '';
  const roomEntries = entries.filter((entry) => !room || entry.room === room);
  const visible = roomEntries.filter((entry) => filter === 'all' || entry.kind === filter);
  const filters: PultFilter[] = ['all', ...pultKinds];

  return (
    <div class="pult-page" data-pult>
      <PultSummary
        snapshot={snapshot}
        entries={entries}
        connected={connected}
        onPultSettingsSaved={onPultSettingsSaved}
      />
      <nav class="pult-rooms" aria-label="Помещения пульта">
        <button
          type="button"
          class={!room ? 'active' : ''}
          aria-pressed={!room}
          data-pult-room="all"
          onClick={() => setRoom('')}
        >
          <Icon name="home" />
          Весь дом
        </button>
        {rooms.map((value) => (
          <button
            key={value}
            type="button"
            class={room === value ? 'active' : ''}
            aria-pressed={room === value}
            data-pult-room={value}
            onClick={() => setRoom(value)}
          >
            {value}
          </button>
        ))}
      </nav>
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
              onCommand={onCommand}
              openDevice={openDevice}
            />
          ))}
        </div>
      ) : (
        <section class="pult-empty" role="status">
          <Icon name={pultIcons[filter]} />
          <h3>{entries.length ? 'Здесь пока нет устройств' : 'Дом готов к подключению'}</h3>
          <p>
            {entries.length
              ? 'Выберите другое помещение или вид оборудования.'
              : 'Настроенные на PLC свет, розетки, климат и датчики появятся на пульте автоматически.'}
          </p>
        </section>
      )}
    </div>
  );
}
