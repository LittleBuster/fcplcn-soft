/** @file Журнал команд с разделением подтверждённых и неизвестных результатов. */
import type { HubSnapshot } from '../../../shared/types.js';
import { CommandLog } from '../components';
import { Icon } from '../icons';

/** Команда считается выполненной только после подтверждения соответствующего PLC. */
export function ActivityPage({ snapshot }: { snapshot: HubSnapshot }) {
  const devices = snapshot.devices;
  return (
    <>
      <div class="section-heading">
        <h2>
          <Icon name="activity" />
          Последние команды
        </h2>
        <span class="section-meta">{snapshot.commands.length} в журнале</span>
      </div>
      <CommandLog commands={snapshot.commands} devices={devices} />
      <p class="activity-note">
        <Icon name="check" />
        «Выполнено» означает, что PLC вернул подтверждение. Потерянное подтверждение отображается
        отдельно.
      </p>
    </>
  );
}
