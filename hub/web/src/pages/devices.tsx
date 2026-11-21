/** @file Обзор оборудования и список PLC с фильтрами по имени и помещению. */
import type { HubSnapshot } from '../../../shared/types.js';
import type { HubNavigation } from '../hooks/use-hub-navigation';
import { DeviceCard, Empty, CommandLog } from '../components';
import { Icon } from '../icons';
import { metrics } from '../model';

interface DevicesPageProps {
  snapshot: HubSnapshot;
  navigation: HubNavigation;
}

/** Общий список сохраняет фильтры при переходах между обзором и выбранным PLC. */
export function DevicesPage({ snapshot, navigation }: DevicesPageProps) {
  const { view, room, setRoom, query, setQuery, openDevice, navigate } = navigation;
  const devices = snapshot.devices;
  const totals = metrics(snapshot);
  const rooms = [...new Set(devices.map((device) => device.room).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'ru'),
  );
  const visibleDevices = devices.filter(
    (device) =>
      (room === 'all' || device.room === room) &&
      `${device.name} ${device.id} ${device.room}`
        .toLocaleLowerCase('ru')
        .includes(query.toLocaleLowerCase('ru')),
  );
  return (
    <>
      {view === 'overview' ? (
        <div class="metrics-grid">
          <div class="metric-card">
            <span class="metric-icon blue">
              <Icon name="plc" />
            </span>
            <div>
              <strong>
                {totals.online}
                <small>/ {devices.length}</small>
              </strong>
              <span>PLC на связи</span>
            </div>
            <span class="metric-trend">Локальная сеть</span>
          </div>
          <div class="metric-card">
            <span class="metric-icon amber">
              <Icon name="light" />
            </span>
            <div>
              <strong>{totals.outputs}</strong>
              <span>Активных выходов</span>
            </div>
            <span class="metric-trend">Подтверждено PLC</span>
          </div>
          <div class="metric-card">
            <span class="metric-icon cyan">
              <Icon name="weather" />
            </span>
            <div>
              <strong>{totals.sensors}</strong>
              <span>Датчиков метео</span>
            </div>
            <span class="metric-trend">Свежие измерения</span>
          </div>
          <div class={`metric-card ${totals.alarms ? 'metric-alert' : ''}`}>
            <span class={`metric-icon ${totals.alarms ? 'red' : 'green'}`}>
              <Icon name={totals.alarms ? 'alarm' : 'shield'} />
            </span>
            <div>
              <strong>{totals.alarms}</strong>
              <span>{totals.alarms ? 'Активных тревог' : 'Активных тревог'}</span>
            </div>
            <span class="metric-trend">
              {totals.alarms ? 'Проверьте охрану' : 'Система спокойна'}
            </span>
          </div>
        </div>
      ) : null}
      <div class="devices-toolbar">
        <div class="section-heading">
          <h2>
            <Icon name="plc" />
            {view === 'overview' ? 'Ваши контроллеры' : 'Устройства в сети'}
          </h2>
          <span class="section-meta">{devices.length} PLC</span>
        </div>
        <div class="device-filters">
          <label class="search-field">
            <Icon name="search" />
            <input
              aria-label="Найти контроллер"
              placeholder="Найти контроллер…"
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <label class="room-filter">
            <Icon name="room" />
            <select
              aria-label="Помещение"
              value={room}
              onChange={(event) => setRoom(event.currentTarget.value)}
            >
              <option value="all">Все помещения</option>
              {rooms.map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {!devices.length ? (
        <Empty
          icon="plc"
          title="Добавим первый контроллер?"
          detail="Укажите адрес MQTT-брокера хаба во вкладке «Хаб» на PLC. Контроллер появится здесь автоматически после подключения."
        />
      ) : !visibleDevices.length ? (
        <Empty
          icon="search"
          title="Ничего не найдено"
          detail="Попробуйте другое название или выберите все помещения."
        />
      ) : (
        <div class="device-grid">
          {visibleDevices.map((device) => (
            <DeviceCard key={device.id} device={device} onOpen={() => openDevice(device.id)} />
          ))}
        </div>
      )}
      {view === 'overview' ? (
        <>
          <div class="section-heading journal-heading">
            <h2>
              <Icon name="activity" />
              Последние действия
            </h2>
            <button class="text-button" onClick={() => navigate('activity')}>
              Весь журнал
              <Icon name="arrow" />
            </button>
          </div>
          <CommandLog commands={snapshot.commands} devices={devices} compact />
        </>
      ) : null}
    </>
  );
}
