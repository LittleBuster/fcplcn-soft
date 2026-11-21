/** @file Единственное изменяющее действие дома и последующее чтение подтверждённых данных. */
import { useState } from 'preact/hooks';
import type { CloudAction, Notice } from '../app/types';
import { api } from '../api';
import { failure } from '../lib/presentation';

/** Ошибка остаётся видимой и передаётся форме; успешное действие перечитывает дом. */
export function useCloudActions(
  refresh: () => Promise<void>,
  onNotice: (notice: Notice | null) => void,
) {
  const [busy, setBusy] = useState(false);

  const act: CloudAction = async <T>(
    path: string,
    body?: unknown,
    method?: string,
    success?: string,
  ) => {
    if (busy) return;
    setBusy(true);
    onNotice(null);
    try {
      const result = await api<T>(path, body, method);
      if (success) onNotice({ kind: 'success', text: success });
      await refresh();
      return result;
    } catch (error) {
      onNotice({ kind: 'error', text: failure(error) });
      throw error;
    } finally {
      setBusy(false);
    }
  };

  return { busy, act };
}
