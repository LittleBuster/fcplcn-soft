/** @file Редактор упорядоченных действий над оборудованием PLC. */

import type { SceneAction } from '../../../../shared/types.js';
import { Icon } from '../../icons';
import { deviceName, text, titles } from '../../model';
import type { SceneEditorProps } from './types';
import type { SceneEditorModel } from './use-scene-editor';

type EditorActionsProps = Pick<SceneEditorProps, 'definition' | 'devices' | 'disabled'> &
  Pick<
    SceneEditorModel,
    | 'actions'
    | 'setActions'
    | 'saving'
    | 'actionKinds'
    | 'selectable'
    | 'targets'
    | 'defaultTarget'
    | 'change'
    | 'reorder'
  >;

/** Строки действий используют стабильные id и меняют только локальный черновик. */
export function EditorActions({
  definition,
  devices,
  disabled,
  actions,
  setActions,
  saving,
  actionKinds,
  selectable,
  targets,
  defaultTarget,
  change,
  reorder,
}: EditorActionsProps) {
  return (
    <>
      <div class="scene-action-editor-list">
        {actions.map((action, index) => {
          const device = devices.find((entry) => entry.id === action.deviceId);
          const items = targets(action.deviceId, action.controller);
          const exists = items.some((item) => item.id === action.itemId);
          return (
            <fieldset
              class="scene-action-editor-row"
              key={action.id}
              data-scene-action-id={action.id}
              disabled={disabled || saving}
            >
              <legend>Действие {index + 1}</legend>
              <div class="scene-action-row-heading">
                <span>{titles[action.controller]}</span>
                <div>
                  <button
                    type="button"
                    onClick={() => reorder(index, -1)}
                    disabled={index === 0 || disabled || saving}
                    aria-label={`Поднять действие ${index + 1}`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => reorder(index, 1)}
                    disabled={index === actions.length - 1 || disabled || saving}
                    aria-label={`Опустить действие ${index + 1}`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    class="scene-remove-action"
                    data-scene-remove
                    onClick={() =>
                      setActions((values) => values.filter((entry) => entry.id !== action.id))
                    }
                    aria-label={`Удалить действие ${index + 1}`}
                  >
                    Удалить
                  </button>
                </div>
              </div>
              <div class="scene-action-fields">
                <label>
                  Контроллер
                  <select
                    data-scene-field="deviceId"
                    value={action.deviceId}
                    onChange={(event) =>
                      change(action.id, defaultTarget(event.currentTarget.value))
                    }
                  >
                    {!device ? (
                      <option value={action.deviceId}>{action.deviceId || 'Выберите PLC'}</option>
                    ) : null}
                    {devices.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {deviceName(entry)}
                        {entry.room ? ` · ${entry.room}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Модуль
                  <select
                    data-scene-field="controller"
                    value={action.controller}
                    onChange={(event) =>
                      change(
                        action.id,
                        defaultTarget(
                          action.deviceId,
                          event.currentTarget.value as SceneAction['controller'],
                        ),
                      )
                    }
                  >
                    {actionKinds.map((kind) => (
                      <option value={kind} key={kind}>
                        {titles[kind]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Устройство
                  <select
                    data-scene-field="itemId"
                    value={action.itemId}
                    onChange={(event) => change(action.id, { itemId: event.currentTarget.value })}
                  >
                    {!exists ? (
                      <option value={action.itemId}>
                        {action.itemId ? `${action.itemId} · нет данных` : 'Выберите устройство'}
                      </option>
                    ) : null}
                    {items.map((item) => (
                      <option key={text(item.id)} value={text(item.id)}>
                        {text(item.name, text(item.id))}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Действие
                  <select
                    data-scene-field="value"
                    value={String(action.value)}
                    onChange={(event) =>
                      change(action.id, { value: event.currentTarget.value === 'true' })
                    }
                  >
                    <option value="true">
                      {action.controller === 'security' ? 'Поставить на охрану' : 'Включить'}
                    </option>
                    <option value="false">
                      {action.controller === 'security' ? 'Снять охрану' : 'Выключить'}
                    </option>
                  </select>
                </label>
              </div>
            </fieldset>
          );
        })}
      </div>
      {!actions.length ? (
        <div class="scene-empty-actions">
          <Icon name="settings" />
          <p>
            Действия не настроены.
            {definition.id === 'home' || definition.id === 'away'
              ? ' Штатное действие с охраной сохранится.'
              : ' Добавьте хотя бы одно устройство.'}
          </p>
        </div>
      ) : null}
      <button
        type="button"
        class="button secondary scene-add-action"
        data-scene-add
        disabled={disabled || saving || actions.length >= 64 || !selectable.length}
        onClick={() =>
          setActions((values) => [
            ...values,
            {
              id: `action-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
              ...defaultTarget(),
              value: true,
            },
          ])
        }
      >
        <span>+</span>Добавить действие
      </button>
      {!selectable.length ? (
        <p class="scene-editor-hint">Подключите PLC с настроенными устройствами.</p>
      ) : null}
    </>
  );
}
