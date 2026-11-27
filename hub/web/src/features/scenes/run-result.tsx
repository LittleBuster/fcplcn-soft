/** @file Подтверждения отдельных действий одного запуска сценария. */

import type { SceneRun } from '../../../../shared/types.js';
import { Icon } from '../../icons';
import { time } from '../../model';
import { actionLabel, readableError, resultLabels, runLabels } from './labels';

export function SceneActionResults({ results }: { results: SceneRun['results'] }) {
  return (
    <div class="scene-result-list">
      {results.map((result) => (
        <div
          class={`scene-action-result result-${result.status}`}
          key={result.id}
          data-scene-result-id={result.id}
          data-result-status={result.status}
        >
          <span class="scene-result-dot" />
          <div>
            <strong>{result.deviceName || result.deviceId}</strong>
            <p>{actionLabel(result)}</p>
            {result.error ? <p class="scene-result-error">{readableError(result.error)}</p> : null}
          </div>
          <span class="scene-result-status">{resultLabels[result.status]}</span>
        </div>
      ))}
    </div>
  );
}

/** Сохраняет видимость результата каждого действия, даже если сценарий выполнился лишь частично. */
export function RunResult({
  run,
  collapsible = false,
  onDismiss,
  onDetailsChange,
}: {
  run: SceneRun;
  collapsible?: boolean;
  onDismiss?: () => void;
  onDetailsChange?: (open: boolean) => void;
}) {
  const applied = run.results.filter((result) => result.status === 'applied').length;
  const failed = run.results.filter(
    (result) => !['pending', 'applied'].includes(result.status),
  ).length;
  const actions = run.results.length ? <SceneActionResults results={run.results} /> : null;

  return (
    <div
      class={`scene-run-result run-${run.status}`}
      data-scene-run-id={run.id}
      data-run-status={run.status}
    >
      <div class="scene-run-heading">
        <span class="scene-run-symbol">
          <Icon
            name={
              run.status === 'completed'
                ? 'check'
                : run.status === 'running'
                  ? 'refresh'
                  : run.status === 'empty'
                    ? 'settings'
                    : 'alarm'
            }
          />
        </span>
        <div>
          <strong>
            {run.name} <span>· {runLabels[run.status]}</span>
          </strong>
          <p>
            {run.results.length
              ? `${applied} из ${run.results.length} действий подтверждено${failed ? ` · ${failed} без подтверждения` : ''}`
              : run.status === 'empty'
                ? 'Настройте действия сценария, чтобы запустить его.'
                : run.status === 'running'
                  ? 'Подготавливаем действия сценария…'
                  : readableError(run.error || '') || 'Действия сценария не выполнены.'}
          </p>
          {run.results.length && run.error ? (
            <p class="scene-result-error">{readableError(run.error)}</p>
          ) : null}
        </div>
        <time>{time(run.completedAt || run.startedAt)}</time>
        {onDismiss && run.status !== 'running' ? (
          <button
            type="button"
            class="scene-result-dismiss"
            data-scene-dismiss
            onClick={onDismiss}
            aria-label="Закрыть результат сценария"
          >
            ×
          </button>
        ) : null}
      </div>
      {actions && collapsible ? (
        <details
          class="scene-result-details"
          onToggle={(event) => onDetailsChange?.(event.currentTarget.open)}
        >
          <summary>Подробнее по устройствам</summary>
          {actions}
        </details>
      ) : (
        actions
      )}
    </div>
  );
}
