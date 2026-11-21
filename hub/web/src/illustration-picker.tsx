/** @file Выбор иллюстрации PLC с отдельным черновиком и явным сохранением. */

import { useState } from 'preact/hooks';
import {
  deviceIllustrations,
  DEFAULT_DEVICE_ILLUSTRATION,
  isDeviceIllustrationId,
  type DeviceIllustrationId,
} from '../../shared/device-art.js';
import { DeviceArt } from './device-art';
import { Icon } from './icons';
import './illustration-picker.css';

const groups = [...new Set(deviceIllustrations.map((entry) => entry.group))];

/**
 * Хранит выбор отдельно от телеметрии и применяет его через API метаданных только по сохранению.
 */
export function IllustrationPicker({
  value,
  onSave,
  onCancel,
}: {
  value: DeviceIllustrationId | undefined;
  onSave: (value: DeviceIllustrationId) => Promise<void>;
  onCancel: () => void;
}) {
  const initial = isDeviceIllustrationId(value) ? value : DEFAULT_DEVICE_ILLUSTRATION;
  const [selected, setSelected] = useState<DeviceIllustrationId>(initial);
  const [group, setGroup] = useState('Все');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const chosen = deviceIllustrations.find((entry) => entry.id === selected)!;
  const entries = deviceIllustrations.filter(
    (entry) =>
      (group === 'Все' || entry.group === group) &&
      `${entry.label} ${entry.group}`
        .toLocaleLowerCase('ru-RU')
        .includes(query.trim().toLocaleLowerCase('ru-RU')),
  );

  return (
    <section
      class="illustration-picker panel"
      data-illustration-picker
      aria-label="Картинка контроллера"
    >
      <div class="illustration-heading">
        <div>
          <span class="eyebrow">Оформление устройства</span>
          <h3>Картинка контроллера</h3>
          <p>Выберите, какой частью дома управляет этот PLC.</p>
        </div>
        <div class="illustration-preview" aria-live="polite">
          <DeviceArt id={selected} />
          <strong>{chosen.label}</strong>
        </div>
      </div>
      <div class="illustration-toolbar">
        <div class="illustration-groups" role="group" aria-label="Категории картинок">
          {['Все', ...groups].map((name) => (
            <button
              type="button"
              key={name}
              aria-pressed={group === name}
              disabled={saving}
              onClick={() => setGroup(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <label class="illustration-search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="Найти картинку"
            value={query}
            placeholder="Гараж, кухня, полив…"
            disabled={saving}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      </div>
      <div class="illustration-options" role="group" aria-label="Картинки контроллера">
        {entries.map((entry) => (
          <button
            type="button"
            key={entry.id}
            class="illustration-choice"
            data-illustration-option={entry.id}
            aria-pressed={selected === entry.id}
            aria-label={entry.label}
            disabled={saving}
            onClick={() => setSelected(entry.id)}
          >
            <DeviceArt id={entry.id} />
            <span>{entry.label}</span>
            {selected === entry.id ? <Icon name="check" className="illustration-selected" /> : null}
          </button>
        ))}
      </div>
      {!entries.length ? (
        <p class="illustration-empty">Картинки не найдены. Измените запрос или категорию.</p>
      ) : null}
      {error ? (
        <p class="notice error" role="alert">
          {error}
        </p>
      ) : null}
      <div class="illustration-actions">
        <span>Картинка будет одинаковой в хабе и облаке.</span>
        <button type="button" class="button secondary" disabled={saving} onClick={onCancel}>
          Отмена
        </button>
        <button
          type="button"
          class="button"
          disabled={saving || selected === initial}
          onClick={async () => {
            if (saving) return;
            setSaving(true);
            setError('');
            try {
              await onSave(selected);
            } catch (failure) {
              setError(
                failure instanceof Error ? failure.message : 'Не удалось сохранить картинку',
              );
              setSaving(false);
            }
          }}
        >
          {saving ? 'Сохраняем…' : 'Сохранить картинку'}
        </button>
      </div>
    </section>
  );
}
