/** @file Запуск, права доступа и открытие черновика редактора сценария. */

import { useState } from 'preact/hooks';
import type { SceneDefinition } from '../../../../shared/types.js';
import { canConfigure } from '../../portal';
import type { ScenesPanelProps } from './types';
import { useSceneRun } from './use-scene-run';

/** Хранит состояние панели; сетевые ответы не применяются после её закрытия. */
export function useScenesPanel(props: ScenesPanelProps) {
  const { snapshot } = props;
  const runner = useSceneRun(props);
  const [editing, setEditing] = useState<SceneDefinition | null>(null);
  const [group, setGroup] = useState<'instant' | 'scheduled'>('instant');

  /** Открывает редактор с отдельными копиями действий и дней расписания текущего сценария. */
  function edit(definition: SceneDefinition) {
    if (!canConfigure) return;
    setEditing({
      ...definition,
      actions: definition.actions.map((action) => ({ ...action })),
      schedule: definition.schedule
        ? { ...definition.schedule, days: [...definition.schedule.days] }
        : null,
    });
  }

  /** Открывает пустой пользовательский сценарий с расписанием, соответствующим выбранной группе. */
  function create() {
    if (!canConfigure) return;
    setEditing({
      id: '',
      name: '',
      description: '',
      revision: 1,
      actions: [],
      schedule: {
        enabled: group === 'scheduled',
        days: [1, 2, 3, 4, 5],
        time: '08:00',
        timeZone: 'Asia/Novosibirsk',
      },
    });
  }

  const grouped = snapshot.definitions.filter(
    (definition) => Boolean(definition.schedule?.enabled) === (group === 'scheduled'),
  );
  return {
    ...runner,
    editing,
    setEditing,
    group,
    setGroup,
    edit,
    create,
    grouped,
  };
}

/** Данные и действия панели для компонентов представления. */
export type ScenesPanelModel = ReturnType<typeof useScenesPanel>;
