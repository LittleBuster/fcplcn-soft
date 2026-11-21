/** @file Название сценария, штатное действие дома и предупреждение о конфликте ревизий. */

import { Icon } from '../../icons';
import type { SceneEditorProps } from './types';
import type { SceneEditorModel } from './use-scene-editor';

type EditorOverviewProps = Pick<
  SceneEditorProps,
  'definition' | 'latestRevision' | 'disabled' | 'onClose'
> &
  Pick<
    SceneEditorModel,
    | 'isNew'
    | 'builtin'
    | 'actions'
    | 'name'
    | 'setName'
    | 'description'
    | 'setDescription'
    | 'saving'
  >;

/** Сохраняет пользовательские поля и отдельно показывает защищённую часть встроенного сценария. */
export function EditorOverview({
  definition,
  latestRevision,
  disabled,
  onClose,
  isNew,
  builtin,
  actions,
  name,
  setName,
  description,
  setDescription,
  saving,
}: EditorOverviewProps) {
  return (
    <>
      <div class="scene-editor-heading">
        <div>
          <p class="eyebrow">{isNew ? 'Новый сценарий' : 'Настройки сценария'}</p>
          <h2 id="scene-editor-title">{isNew ? 'Свой сценарий' : definition.name}</h2>
        </div>
        <button
          type="button"
          class="scene-close"
          onClick={onClose}
          disabled={saving}
          aria-label="Закрыть настройки сценария"
        >
          ×
        </button>
      </div>
      {!builtin ? (
        <div class="scene-name-fields">
          <label>
            Название
            <input
              data-scene-name
              value={name}
              maxLength={64}
              onInput={(event) => setName(event.currentTarget.value)}
              required
              disabled={saving || disabled}
              placeholder="Например, Вечер дома"
            />
          </label>
          <label>
            Описание
            <textarea
              data-scene-description
              value={description}
              maxLength={256}
              onInput={(event) => setDescription(event.currentTarget.value)}
              disabled={saving || disabled}
              placeholder="Что подготовить одним нажатием"
              rows={2}
            />
          </label>
        </div>
      ) : null}
      <div class="scene-fixed-action">
        <Icon name={definition.id === 'home' || definition.id === 'away' ? 'shield' : 'prepare'} />
        <p>
          {definition.id === 'home'
            ? 'Сначала снять охрану со всех известных PLC с модулем охраны.'
            : definition.id === 'away'
              ? 'Сначала поставить под охрану все известные PLC с модулем охраны. Каждый PLC проверит свои датчики и применит настроенную задержку выхода.'
              : 'Выберите устройства: освещение, розетки, термостаты или охрану конкретного PLC.'}
        </p>
      </div>
      <div class="scene-editor-section">
        <h3>
          {definition.id === 'home' || definition.id === 'away'
            ? 'Дополнительные действия'
            : 'Действия'}
          <span>{actions.length} / 64</span>
        </h3>
        <p>
          {definition.id === 'home' || definition.id === 'away'
            ? 'Выполняются по порядку после действий с охраной. Например: включить контактор при возвращении и выключить при уходе.'
            : 'Выполняются последовательно в указанном порядке.'}{' '}
          Логика термостата остаётся на PLC.
        </p>
      </div>
      {!isNew && latestRevision !== definition.revision ? (
        <p class="notice warning">
          Сценарий изменился в другой сессии. Ваши правки сохранены в форме. Закройте и откройте
          настройки, чтобы загрузить актуальную версию.
        </p>
      ) : null}
    </>
  );
}
