import type { SceneRun } from '../../../../shared/types.js';
import { Empty } from '../../components/common';
import { readableError, runLabels } from '../scenes/labels';
import { SceneActionResults } from '../scenes/run-result';
import { activityActorLabel, activityDateTime } from './labels';

export function SceneRuns({ runs }: { runs: SceneRun[] }) {
  if (!runs.length)
    return (
      <Empty
        icon="prepare"
        title="Запусков пока нет"
        detail="Здесь появятся запуски сценариев и результаты их действий."
      />
    );

  return (
    <div class="activity-records">
      {runs.map((run) => {
        const applied = run.results.filter((result) => result.status === 'applied').length;
        return (
          <article
            class="panel activity-record"
            key={run.id}
            data-scene-run-id={run.id}
            data-run-status={run.status}
          >
            <header class="activity-record-heading">
              <h2>{run.name}</h2>
              <span class={`activity-status scene-status-${run.status}`}>
                {runLabels[run.status]}
              </span>
            </header>
            <dl class="activity-facts">
              <div>
                <dt>Инициатор</dt>
                <dd>
                  {activityActorLabel(
                    run.actor,
                    run.trigger === 'schedule' ? 'Расписание' : undefined,
                  )}
                </dd>
              </div>
              <div>
                <dt>Запущен</dt>
                <dd>
                  <time dateTime={run.startedAt}>{activityDateTime(run.startedAt)}</time>
                </dd>
              </div>
              {run.completedAt ? (
                <div>
                  <dt>Завершён</dt>
                  <dd>
                    <time dateTime={run.completedAt}>{activityDateTime(run.completedAt)}</time>
                  </dd>
                </div>
              ) : null}
            </dl>
            {run.error ? <p class="activity-error">{readableError(run.error)}</p> : null}
            {run.results.length ? (
              <details class="activity-scene-details">
                <summary>
                  PLC подтвердили {applied} из {run.results.length} действий
                </summary>
                <SceneActionResults results={run.results} />
              </details>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
