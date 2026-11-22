/** @file Явный выбор датчика верхней карточки пульта с отдельным черновиком и проверкой ревизии. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PultSettingsView, PultTemperatureSource } from '../../../../shared/pult.js';
import { api, ApiError, jsonBody } from '../../api';
import { Icon } from '../../icons';
import { deviceName, text } from '../../model';
import type { PultEntry } from './model';
import './temperature-settings.css';

interface TemperatureSettingsProps {
  entries: PultEntry[];
  settings: PultSettingsView | null;
  onSaved: (value: PultSettingsView) => void;
  onClose: () => void;
}

interface SensorOption extends PultTemperatureSource {
  online: boolean;
}

const optionsFrom = (entries: PultEntry[]): SensorOption[] =>
  entries
    .filter((entry) => entry.kind === 'meteo')
    .map((entry) => ({
      deviceId: entry.device.id,
      deviceName: deviceName(entry.device),
      itemId: text(entry.item.id),
      itemName: text(entry.item.name, 'Датчик температуры'),
      online: entry.device.online && entry.device.status === 'online',
    }));

/** Ограничивает ожидание даже если браузер после сна не завершил отменённый запрос. */
async function requestSettings(
  options: RequestInit,
  controller: AbortController,
): Promise<PultSettingsView> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new ApiError(
          'Хаб не ответил вовремя. Загрузите актуальные настройки и повторите выбор.',
          0,
        ),
      );
      controller.abort();
    }, 8000);
  });
  try {
    return await Promise.race([
      api<PultSettingsView>('/pult/settings', { ...options, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Опрос телеметрии обновляет список устройств, сохраняя начатый пользователем выбор. */
export function TemperatureSettings({
  entries,
  settings,
  onSaved,
  onClose,
}: TemperatureSettingsProps) {
  const [base, setBase] = useState<PultSettingsView | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [itemId, setItemId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const remembered = useRef<SensorOption[]>([
    ...optionsFrom(entries),
    ...(settings?.temperatureSource ? [{ ...settings.temperatureSource, online: false }] : []),
  ]);

  // Keep even a removed source visible while the editor is open, including its saved name.
  const choices = [
    ...optionsFrom(entries),
    ...remembered.current.map((entry) => ({ ...entry, online: false })),
  ];
  if (base?.temperatureSource) choices.push({ ...base.temperatureSource, online: false });
  const sensorMap = new Map<string, SensorOption>();
  for (const entry of choices) {
    const key = `${entry.deviceId}/${entry.itemId}`;
    if (!sensorMap.has(key)) sensorMap.set(key, entry);
  }
  const sensors = [...sensorMap.values()];
  remembered.current = sensors;
  const deviceMap = new Map<string, SensorOption>();
  for (const entry of sensors)
    if (!deviceMap.has(entry.deviceId)) deviceMap.set(entry.deviceId, entry);
  const devices = [...deviceMap.values()];
  const deviceSensors = sensors.filter((entry) => entry.deviceId === deviceId);

  function acceptDraft(value: PultSettingsView) {
    setBase(value);
    setDeviceId(value.temperatureSource?.deviceId || '');
    setItemId(value.temperatureSource?.itemId || '');
    setConflict(false);
  }

  async function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const value = await requestSettings({}, controller);
      if (!alive.current || current !== generation.current) return;
      acceptDraft(value);
    } catch (failure) {
      if (!alive.current || current !== generation.current) return;
      setError(
        failure instanceof Error ? failure.message : 'Не удалось загрузить настройки пульта.',
      );
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      generation.current++;
      request.current?.abort();
    };
  }, []);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!base || loading || saving || conflict || (deviceId && !itemId)) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const current = ++generation.current;
    setSaving(true);
    setError('');
    try {
      const value = await requestSettings(
        {
          method: 'PUT',
          ...jsonBody({
            baseRevision: base.revision,
            temperatureSource: deviceId ? { deviceId, itemId } : null,
          }),
        },
        controller,
      );
      if (!alive.current || current !== generation.current) return;
      onSaved(value);
      onClose();
    } catch (failure) {
      if (!alive.current || current !== generation.current) return;
      if (failure instanceof ApiError && failure.status === 409) {
        setConflict(true);
        setError(
          'Выбор уже изменён на другом устройстве. Загрузите актуальные настройки перед сохранением.',
        );
        try {
          const latest = await requestSettings({}, controller);
          if (alive.current && current === generation.current) setBase(latest);
        } catch {
          // The draft remains intact; the explicit reload action can retry the read.
        }
      } else {
        setError(
          failure instanceof Error ? failure.message : 'Не удалось сохранить настройки пульта.',
        );
      }
    } finally {
      if (alive.current && current === generation.current) setSaving(false);
    }
  }

  return (
    <section
      class="pult-temperature-settings"
      id="pult-temperature-settings"
      data-pult-temperature-settings
      aria-labelledby="pult-temperature-settings-title"
    >
      <div class="pult-temperature-settings-heading">
        <span class="pult-temperature-settings-icon">
          <Icon name="thermometer" />
        </span>
        <div>
          <h3 id="pult-temperature-settings-title">Температура на главной</h3>
          <p>Этот датчик будет показан в верхней карточке «Температура».</p>
        </div>
      </div>
      <form onSubmit={save} aria-busy={loading || saving}>
        <div class="pult-temperature-settings-fields">
          <label>
            Контроллер
            <select
              data-pult-temperature-device
              value={deviceId}
              disabled={loading || saving}
              onChange={(event) => {
                const id = event.currentTarget.value;
                setDeviceId(id);
                setItemId(sensors.find((entry) => entry.deviceId === id)?.itemId || '');
              }}
            >
              <option value="">Не выбран</option>
              {devices.map((entry) => (
                <option key={entry.deviceId} value={entry.deviceId}>
                  {entry.deviceName}
                  {entry.online ? '' : ' · не в сети'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Датчик
            <select
              data-pult-temperature-sensor
              value={itemId}
              disabled={loading || saving || !deviceId}
              onChange={(event) => setItemId(event.currentTarget.value)}
            >
              {!deviceId || !deviceSensors.length ? <option value="">Не выбран</option> : null}
              {deviceSensors.map((entry) => (
                <option key={entry.itemId} value={entry.itemId}>
                  {entry.itemName}
                </option>
              ))}
            </select>
          </label>
        </div>
        {loading ? (
          <p class="pult-temperature-settings-status" role="status">
            Загружаем настройки…
          </p>
        ) : null}
        {error ? (
          <p class="pult-temperature-settings-error" role="alert">
            {error}
          </p>
        ) : null}
        <div class="pult-temperature-settings-actions">
          {conflict || (!loading && Boolean(error)) ? (
            <button
              type="button"
              class="pult-temperature-reload"
              data-pult-temperature-reload
              onClick={() => void load()}
              disabled={loading || saving}
            >
              <Icon name="refresh" />
              {base ? 'Загрузить актуальные настройки' : 'Повторить загрузку'}
            </button>
          ) : null}
          <button
            type="button"
            class="pult-temperature-cancel"
            data-pult-temperature-cancel
            onClick={onClose}
            disabled={saving}
          >
            Отмена
          </button>
          <button
            type="submit"
            class="pult-temperature-save"
            data-pult-temperature-save
            disabled={loading || saving || !base || conflict || Boolean(deviceId && !itemId)}
          >
            <Icon name="check" />
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </form>
    </section>
  );
}
