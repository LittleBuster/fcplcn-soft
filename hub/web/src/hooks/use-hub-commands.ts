/** @file Явные команды каналам, демо-касание и метаданные карточки PLC. */
import { useState } from 'preact/hooks';
import type { CommandView, WritableControllerKind } from '../../../shared/types.js';
import type { DeviceIllustrationId } from '../../../shared/device-art.js';
import { api, jsonBody } from '../api';
import { canControl, canConfigure, canManageSecurity } from '../portal';
import type { HubSession } from './use-hub-session';
import type { HubSnapshotState } from './use-hub-snapshot';
import type { HubNotices } from './use-hub-notices';

/** Обрабатывает подтверждения без оптимистичного изменения оборудования и без повторной отправки. */
export function useHubCommands(auth: HubSession, data: HubSnapshotState, notices: HubNotices) {
  const { sessionVersion } = auth;
  const { snapshot, refresh } = data;
  const { setNotice, setClearSceneNoticeToken } = notices;
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [sceneStarting, setSceneStarting] = useState(false);

  /** Отправляет ON/OFF и различает подтверждение PLC, отказ и неизвестный результат. */
  async function command(
    deviceId: string,
    controller: WritableControllerKind,
    itemId: string,
    value: boolean,
  ) {
    const key = `${deviceId}/${controller}`;
    const version = sessionVersion.current;
    if (
      !canControl ||
      (controller === 'security' && !canManageSecurity) ||
      pending.has(key) ||
      sceneStarting ||
      snapshot?.scenes.activeRun
    )
      return;
    setPending((items) => new Set([...items, key]));
    setNotice(null);
    setClearSceneNoticeToken((value) => value + 1);
    try {
      const result = await api<CommandView>(`/devices/${encodeURIComponent(deviceId)}/commands`, {
        method: 'POST',
        ...jsonBody({ controller, itemId, value }),
      });
      if (version !== sessionVersion.current) return;
      setNotice(
        result.status === 'applied'
          ? { tone: 'success', text: 'PLC подтвердил выполнение команды.' }
          : result.status === 'rejected'
            ? { tone: 'error', text: result.error || 'PLC отклонил команду.' }
            : {
                tone: 'warning',
                text:
                  result.error || 'Выполнение не подтверждено. Проверьте актуальное состояние PLC.',
              },
      );
      await refresh();
    } catch (error) {
      if (version === sessionVersion.current)
        setNotice({
          tone: 'error',
          text: error instanceof Error ? error.message : 'Не удалось отправить команду',
        });
    } finally {
      if (version === sessionVersion.current)
        setPending((items) => {
          const next = new Set(items);
          next.delete(key);
          return next;
        });
    }
  }

  /** Имитирует отдельное авторизованное касание только в демонстрационном доме. */
  async function securityTouch(deviceId: string) {
    if (!canControl || !canManageSecurity || snapshot?.mode !== 'demo')
      throw new Error('Нет разрешения управлять охраной.');
    const key = `${deviceId}/security`;
    const version = sessionVersion.current;
    if (pending.has(key) || sceneStarting || snapshot.scenes.activeRun)
      throw new Error('Дождитесь завершения текущего действия.');
    setPending((items) => new Set([...items, key]));
    setNotice(null);
    setClearSceneNoticeToken((value) => value + 1);
    try {
      await api(`/devices/${encodeURIComponent(deviceId)}/security/key`, {
        method: 'POST',
        ...jsonBody({}),
      });
      if (version === sessionVersion.current) await refresh();
    } finally {
      if (version === sessionVersion.current)
        setPending((items) => {
          const next = new Set(items);
          next.delete(key);
          return next;
        });
    }
  }

  /** Сохраняет имя, помещение и необязательную иллюстрацию без изменения конфигурации PLC. */
  async function rename(
    deviceId: string,
    name: string,
    nextRoom: string,
    illustrationId?: DeviceIllustrationId,
  ) {
    if (!canConfigure) throw new Error('Для изменения настроек нужны права владельца.');
    const version = sessionVersion.current;
    setNotice(null);
    setClearSceneNoticeToken((value) => value + 1);
    await api(`/devices/${encodeURIComponent(deviceId)}`, {
      method: 'PATCH',
      ...jsonBody({
        name,
        room: nextRoom,
        ...(illustrationId === undefined ? {} : { illustrationId }),
      }),
    });
    if (version !== sessionVersion.current) return;
    setNotice({ tone: 'success', text: 'Настройки карточки сохранены в хабе.' });
    await refresh();
  }

  return { pending, setPending, sceneStarting, setSceneStarting, command, securityTouch, rename };
}

export type HubCommands = ReturnType<typeof useHubCommands>;
