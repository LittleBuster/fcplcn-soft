/** @file Планшетные плитки для немедленного запуска и переключения расписаний. */
import { useState } from 'preact/hooks';
import type { SceneDefinition, ScenesSnapshot } from '../../../../shared/types.js';
import { ActionNotice } from '../../app/notices';
import { Icon } from '../../icons';
import { canConfigure } from '../../portal';
import { weekdays } from '../scenes/editor-options';
import { runLabels, scenes } from '../scenes/labels';
import type { SceneGroup } from '../scenes/types';
import { useSceneRun } from '../scenes/use-scene-run';
import './scenes.css';

export interface PultSceneActions {
  onRun: (id: string) => Promise<void>;
  onSchedule: (scene: SceneDefinition, enabled: boolean) => Promise<void>;
}

interface PultScenesProps extends PultSceneActions {
  group: SceneGroup;
  onSelectGroup: (group: SceneGroup) => void;
  snapshot: ScenesSnapshot;
  connected: boolean;
  hubAvailable: boolean;
  manualBusy: boolean;
}

const filters = [
  { group: 'instant', label: 'Мгновенные', icon: 'power' },
  { group: 'scheduled', label: 'По расписанию', icon: 'clock' },
] as const;

/** У каждой плитки свой ожидающий запрос. Подсветку определяет подтверждённый снимок. */
function ScheduleTile({
  scene,
  disabled,
  onSchedule,
  onError,
}: {
  scene: SceneDefinition;
  disabled: boolean;
  onSchedule: PultSceneActions['onSchedule'];
  onError: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const schedule = scene.schedule;
  if (!schedule?.enabled) return null;
  const enabled = !schedule.paused;
  const days =
    schedule.days.length === 7
      ? 'Ежедневно'
      : schedule.days.map((day) => weekdays[day - 1]).join(', ');
  async function toggle() {
    if (disabled || saving) return;
    setSaving(true);
    onError('');
    try {
      await onSchedule(scene, !enabled);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Не удалось изменить расписание.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      type="button"
      class="pult-tile pult-scene-tile"
      data-pult-scene={scene.id}
      aria-pressed={enabled}
      aria-busy={saving}
      disabled={disabled || saving}
      onClick={() => void toggle()}
    >
      <span class="pult-scene-top">
        <Icon name={scene.id === 'prepare' ? 'car' : 'clock'} />
        <span class="pult-scene-switch" aria-hidden="true" />
      </span>
      <strong class="pult-tile-name">{scene.name}</strong>
      <span class="pult-scene-caption">
        {days} · {schedule.time} · {schedule.timeZone}
      </span>
      <span class="pult-scene-action">
        <span class="pult-state-dot" />
        {saving ? 'Сохраняем…' : enabled ? 'Расписание включено' : 'Расписание выключено'}
      </span>
    </button>
  );
}

export function PultScenes({
  group,
  onSelectGroup,
  snapshot,
  connected,
  hubAvailable,
  manualBusy,
  onRun,
  onSchedule,
}: PultScenesProps) {
  const runner = useSceneRun({ snapshot, unavailable: !connected, manualBusy, onRun });
  const groups = {
    instant: snapshot.definitions.filter((entry) => !entry.schedule?.enabled),
    scheduled: snapshot.definitions.filter((entry) => entry.schedule?.enabled),
  };
  const visible = groups[group];
  const configBlocked =
    !canConfigure || !hubAvailable || runner.busy || manualBusy || Boolean(runner.storageError);
  return (
    <>
      <div class="pult-section-heading">
        <h2>Сценарии дома</h2>
      </div>
      <nav class="pult-filters" aria-label="Виды сценариев пульта">
        {filters.map((filter) => (
          <button
            type="button"
            key={filter.group}
            id={`pult-scene-filter-${filter.group}`}
            class={group === filter.group ? 'active' : ''}
            aria-pressed={group === filter.group}
            data-pult-scene-filter={filter.group}
            onClick={() => onSelectGroup(filter.group)}
          >
            <Icon name={filter.icon} />
            {filter.label}
            <span>{groups[filter.group].length}</span>
          </button>
        ))}
      </nav>
      <section data-pult-scene-group={group} aria-labelledby={`pult-scene-filter-${group}`}>
        {visible.length ? (
          <div class="pult-controls pult-scene-grid">
            {visible.map((scene) => {
              if (group === 'scheduled')
                return (
                  <ScheduleTile
                    key={scene.id}
                    scene={scene}
                    disabled={configBlocked}
                    onSchedule={onSchedule}
                    onError={runner.setError}
                  />
                );
              const builtin = scenes.find((entry) => entry.id === scene.id);
              const running =
                runner.starting === scene.id || snapshot.activeRun?.sceneId === scene.id;
              const result =
                runner.current?.sceneId === scene.id && runner.current.id === runner.visibleRunId
                  ? runner.current
                  : null;
              return (
                <button
                  key={scene.id}
                  type="button"
                  class="pult-tile pult-scene-tile"
                  data-pult-scene={scene.id}
                  aria-busy={running}
                  disabled={runner.blocked || !runner.allowed(scene.id)}
                  onClick={() => void runner.run(scene.id)}
                >
                  <span class="pult-scene-top">
                    <Icon name={builtin?.icon || 'activity'} />
                    <Icon name="arrow" />
                  </span>
                  <strong class="pult-tile-name">{scene.name}</strong>
                  <span class="pult-scene-caption">{builtin?.caption || scene.description}</span>
                  <span class="pult-scene-action" aria-live="polite">
                    {running ? 'Выполняется…' : result ? runLabels[result.status] : 'Запустить'}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p class="pult-scenes-empty">
            {group === 'scheduled'
              ? 'Расписаний пока нет. Дни и время можно задать в разделе «Сценарии» панели хаба.'
              : 'Мгновенных сценариев пока нет.'}
          </p>
        )}
      </section>
      {runner.storageError || snapshot.scheduler?.error ? (
        <p class="notice error" role="alert">
          {runner.storageError || snapshot.scheduler?.error}
        </p>
      ) : null}
      <ActionNotice
        notice={runner.error ? { tone: 'error', text: runner.error } : null}
        onDismiss={() => runner.setError('')}
      />
    </>
  );
}
