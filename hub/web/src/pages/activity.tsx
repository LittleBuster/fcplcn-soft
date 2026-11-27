/** @file История управления домом и связи с контроллерами. */
import { useState } from 'preact/hooks';
import type { HubSnapshot } from '../../../shared/types.js';
import { CommandLog } from '../components';
import { DeviceConnectionHistory } from '../features/activity/connection-history';
import { DeviceOutages } from '../features/activity/outages';
import { SceneRuns } from '../features/activity/scene-runs';
import { Icon } from '../icons';
import { portal } from '../portal';
import '../features/activity/activity.css';

const sections = [
  { id: 'commands', label: 'Команды', icon: 'activity' },
  { id: 'scenes', label: 'Сценарии', icon: 'prepare' },
  { id: 'outages', label: 'Связь с PLC', icon: 'wifi' },
] as const;

export function ActivityPage({ snapshot }: { snapshot: HubSnapshot }) {
  const [section, setSection] = useState<(typeof sections)[number]['id']>('commands');
  return (
    <>
      <div class="activity-sections" role="group" aria-label="Раздел журнала">
        {sections.map(({ id, label, icon }) => (
          <button
            type="button"
            key={id}
            aria-pressed={section === id}
            onClick={() => setSection(id)}
          >
            <Icon name={icon} />
            {label}
          </button>
        ))}
      </div>
      {section === 'commands' && (
        <CommandLog commands={snapshot.commands} devices={snapshot.devices} />
      )}
      {section === 'scenes' && <SceneRuns runs={snapshot.scenes.runs} />}
      {section === 'outages' && (
        <>
          {!portal && (
            <DeviceConnectionHistory
              devices={snapshot.devices}
              outages={snapshot.outages ?? []}
              now={snapshot.now}
            />
          )}
          <DeviceOutages outages={snapshot.outages ?? []} now={snapshot.now} />
        </>
      )}
    </>
  );
}
