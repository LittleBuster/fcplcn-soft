/** @file Свёрнутый журнал последних запусков сценариев. */

import type { SceneRun } from '../../../../shared/types.js';
import { time } from '../../model';
import { runLabels } from './labels';
import { RunResult } from './run-result';

/** Отображает историю отдельно от текущего уведомления. */
export function SceneHistory({ runs }: { runs: SceneRun[] }) {
  return (
    <details class="scene-history" data-scene-run-history data-scene-history>
      <summary>История запусков · {runs.length}</summary>
      {runs.slice(0, 20).map((run) => (
        <details class="scene-history-run" key={run.id}>
          <summary>
            {run.name} · {runLabels[run.status]} · {time(run.completedAt || run.startedAt)}
          </summary>
          <RunResult run={run} />
        </details>
      ))}
    </details>
  );
}
