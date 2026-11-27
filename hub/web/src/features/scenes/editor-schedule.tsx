/** @file Выбор ручного запуска либо недельного расписания сценария. */

import { Icon } from '../../icons';
import { weekdays } from './editor-options';
import type { SceneEditorProps } from './types';
import type { SceneEditorModel } from './use-scene-editor';

type EditorScheduleProps = Pick<SceneEditorProps, 'disabled'> &
  Pick<SceneEditorModel, 'schedule' | 'setSchedule' | 'saving'> & { paused: boolean };

/** Меняет дни, время и часовой пояс только в черновике редактора. */
export function EditorSchedule({
  disabled,
  paused,
  schedule,
  setSchedule,
  saving,
}: EditorScheduleProps) {
  return (
    <section class="scene-schedule-settings">
      <h3>
        <Icon name="clock" />
        Когда запускать
      </h3>
      <div class="scene-mode-picker">
        <label>
          <input
            type="radio"
            name="scene-mode"
            data-scene-mode="instant"
            checked={!schedule.enabled}
            disabled={disabled || saving}
            onChange={() => setSchedule((value) => ({ ...value, enabled: false }))}
          />
          <span>Мгновенный</span>
        </label>
        <label>
          <input
            type="radio"
            name="scene-mode"
            data-scene-mode="scheduled"
            data-scene-schedule-enabled
            checked={schedule.enabled}
            disabled={disabled || saving}
            onChange={() => setSchedule((value) => ({ ...value, enabled: true }))}
          />
          <span>По расписанию</span>
        </label>
      </div>
      <p>
        {!schedule.enabled
          ? 'Только вручную — нажатием кнопки сценария.'
          : paused
            ? 'Расписание выключено. Включить его можно на вкладке «Сценарии» пульта.'
            : 'Сценарий запускается в выбранные дни и время. Кнопка ручного запуска тоже доступна.'}
      </p>
      <fieldset class="scene-schedule-fields" disabled={!schedule.enabled || disabled || saving}>
        <legend class="visually-hidden">Параметры расписания</legend>
        <div class="scene-weekdays" role="group" aria-label="Дни недели">
          {weekdays.map((day, index) => (
            <label key={day}>
              <input
                type="checkbox"
                data-scene-day={index + 1}
                checked={schedule.days.includes(index + 1)}
                onChange={(event) =>
                  setSchedule((value) => ({
                    ...value,
                    days: event.currentTarget.checked
                      ? [...value.days, index + 1]
                      : value.days.filter((value) => value !== index + 1),
                  }))
                }
              />
              <span>{day}</span>
            </label>
          ))}
        </div>
        <div class="scene-schedule-time">
          <label>
            Время
            <input
              type="time"
              data-scene-schedule-time
              value={schedule.time}
              onInput={(event) =>
                setSchedule((value) => ({ ...value, time: event.currentTarget.value }))
              }
              required
            />
          </label>
          <label>
            Часовой пояс
            <input
              data-scene-schedule-timezone
              list="scene-timezones"
              value={schedule.timeZone}
              onInput={(event) =>
                setSchedule((value) => ({ ...value, timeZone: event.currentTarget.value }))
              }
              required
            />
            <datalist id="scene-timezones">
              <option value="Asia/Novosibirsk" />
              <option value="Europe/Moscow" />
              <option value="Europe/Kaliningrad" />
              <option value="Asia/Yekaterinburg" />
              <option value="Asia/Krasnoyarsk" />
              <option value="Asia/Irkutsk" />
              <option value="Asia/Vladivostok" />
              <option value="UTC" />
            </datalist>
          </label>
        </div>
      </fieldset>
      <p class="scene-editor-hint">
        Если хаб был выключен или другой сценарий уже выполнялся, пропущенный запуск не переносится
        на более позднее время.
      </p>
    </section>
  );
}
