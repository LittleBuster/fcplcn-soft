/** @file Одно текущее уведомление с независимым от опросов таймером успеха. */
import { useEffect, useState } from 'preact/hooks';
import type { Notice } from '../app/types';

export function useNotice(selected: string) {
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => setNotice(null), [selected]);

  useEffect(() => {
    if (!notice || notice.kind !== 'success') return;
    const timer = window.setTimeout(
      () => setNotice((value) => (value === notice ? null : value)),
      5000,
    );
    return () => window.clearTimeout(timer);
  }, [notice]);

  return { notice, setNotice };
}
