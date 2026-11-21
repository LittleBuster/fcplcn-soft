/** @file История запрашивается только открытым разделом и не обновляет закрытую страницу. */
import { useEffect, useState } from 'preact/hooks';
import type { CloudAudit } from '../../../shared/api.js';
import type { CloudView, Notice } from '../app/types';
import { api } from '../api';
import { failure } from '../lib/presentation';

export function useCloudHistory(
  view: CloudView,
  selected: string,
  onNotice: (notice: Notice) => void,
) {
  const [history, setHistory] = useState<CloudAudit[]>([]);

  useEffect(() => setHistory([]), [selected]);

  useEffect(() => {
    if (view !== 'history' || !selected) return;
    let active = true;
    const load = () =>
      api<{ events: CloudAudit[] }>('/homes/' + selected + '/history')
        .then((value) => {
          if (active) setHistory(value.events);
        })
        .catch((error) => {
          if (active) onNotice({ kind: 'error', text: failure(error) });
        });
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [view, selected]);

  return history;
}
