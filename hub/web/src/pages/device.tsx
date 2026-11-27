/** @file Выбранный PLC: оперативное управление или его постоянный сервисный редактор. */
import type { HubSnapshot, DeviceView } from '../../../shared/types.js';
import type { HubNavigation } from '../hooks/use-hub-navigation';
import type { HubCommands } from '../hooks/use-hub-commands';
import { DeviceDetail } from '../components';
import { PLCSettings } from '../plc-settings';
import { canConfigure, canControl, canManageSecurity } from '../portal';
import type { Notice } from '../app/types';

interface DevicePageProps {
  snapshot: HubSnapshot;
  selected?: DeviceView;
  navigation: HubNavigation;
  commands: HubCommands;
  brokerConnected: boolean;
  clearNotice: () => void;
  onNotice: (notice: Notice | null) => void;
}

/** Сохраняет ключ и положение вложенного редактора между обновлениями снимка. */
export function DevicePage({
  snapshot,
  selected,
  navigation,
  commands,
  brokerConnected,
  clearNotice,
  onNotice,
}: DevicePageProps) {
  const { configuringId, setConfiguringId, filter, setFilter } = navigation;
  const { pending, sceneStarting, command, rename, securityTouch } = commands;
  const devices = snapshot.devices;

  if (configuringId)
    return (
      <PLCSettings
        key={configuringId}
        deviceId={configuringId}
        irrigationRule={navigation.irrigationRule}
        device={devices.find((device) => device.id === configuringId)}
        onBack={() => setConfiguringId(null)}
        onNotice={onNotice}
      />
    );
  if (!selected) return null;

  return (
    <DeviceDetail
      key={selected.id}
      device={selected}
      filter={filter}
      setFilter={setFilter}
      pending={pending}
      connected={brokerConnected}
      onCommand={command}
      onRename={rename}
      configureIrrigation={canConfigure ? navigation.configureIrrigation : undefined}
      onSecurityTouch={
        snapshot.mode === 'demo' && canControl && canManageSecurity ? securityTouch : undefined
      }
      controlsBlocked={!canControl || sceneStarting || Boolean(snapshot.scenes.activeRun)}
      onConfigure={
        canConfigure
          ? () => {
              setConfiguringId(selected.id);
              clearNotice();
              window.scrollTo({ top: 0, behavior: 'instant' });
            }
          : undefined
      }
    />
  );
}
