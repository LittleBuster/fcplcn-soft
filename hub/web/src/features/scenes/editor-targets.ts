/** @file Выбор PLC и канала для новой либо изменённой строки действия. */

import type { DeviceView, SceneAction } from '../../../../shared/types.js';
import { rows, text } from '../../model';

/** Подбирает цели из текущего снимка, не изменяя устройства или черновик сценария. */
export function createEditorTargets(
  devices: DeviceView[],
  actionKinds: SceneAction['controller'][],
) {
  const selectable = devices.filter((device) =>
    actionKinds.some((kind) =>
      kind === 'security'
        ? Boolean(device.controllers.security)
        : rows(device.controllers[kind]?.data.items).length,
    ),
  );

  /** Возвращает каналы выбранного модуля; у охраны есть одна общая цель alarm. */
  function targets(deviceId: string, kind: SceneAction['controller']) {
    return kind === 'security'
      ? [{ id: 'alarm', name: 'Охрана PLC' }]
      : rows(devices.find((device) => device.id === deviceId)?.controllers[kind]?.data.items);
  }

  /** Подбирает существующее устройство и первый доступный канал для новой строки действия. */
  function defaultTarget(deviceId?: string, controller?: SceneAction['controller']) {
    const device = devices.find((entry) => entry.id === deviceId) || selectable[0];
    const kind =
      controller ||
      actionKinds.find((entry) =>
        entry === 'security'
          ? Boolean(device?.controllers.security)
          : rows(device?.controllers[entry]?.data.items).length,
      ) ||
      'lights';
    return {
      deviceId: device?.id || '',
      controller: kind,
      itemId:
        kind === 'security' ? 'alarm' : text(rows(device?.controllers[kind]?.data.items)[0]?.id),
    };
  }

  return { selectable, targets, defaultTarget };
}
