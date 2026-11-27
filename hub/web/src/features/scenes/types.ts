/** @file Контракты панели, редактора и группы сценариев. */

import type { DeviceView, SceneDefinition, ScenesSnapshot } from '../../../../shared/types.js';

/** Группа отображения пользовательской библиотеки. */
export type SceneGroup = 'instant' | 'scheduled';

/** Подтверждённые данные и события владельца общей панели. */
export interface ScenesPanelProps {
  snapshot: ScenesSnapshot;
  devices: DeviceView[];
  unavailable: boolean;
  manualBusy: boolean;
  onRun: (id: string) => Promise<void>;
  onSaved: (definition: SceneDefinition) => void;
  onDeleted: (id: string) => void;
  expanded?: boolean;
  clearNoticeToken?: number;
  showQuick?: boolean;
}

/** Редактор удерживает исходную ревизию и локальный черновик до успешного сохранения. */
export interface SceneEditorProps {
  definition: SceneDefinition;
  devices: DeviceView[];
  latestRevision: number;
  disabled: boolean;
  onClose: () => void;
  onSaved: (definition: SceneDefinition) => void;
  onDeleted: (id: string) => void;
}
