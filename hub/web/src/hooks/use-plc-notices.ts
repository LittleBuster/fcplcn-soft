/** @file Accept only the selected PLC editor's action results into the hub notification. */
import { useEffect, useRef } from 'preact/hooks';
import type { Notice } from '../app/types';

/** Keep iframe messages scoped to their origin, window and current document sequence. */
export function usePLCNotices(deviceId: string, onNotice: (notice: Notice | null) => void) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const sequence = useRef(0);
  const enable = () =>
    frame.current?.contentWindow?.postMessage(
      { type: 'fcplcn:plc-notice-enable', version: 1 },
      window.location.origin,
    );

  useEffect(() => {
    const message = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frame.current?.contentWindow ||
        !event.data ||
        typeof event.data !== 'object' ||
        event.data.version !== 1
      )
        return;
      const data = event.data;
      if (data.type === 'fcplcn:plc-notice-ready') {
        enable();
        return;
      }
      if (
        data.type !== 'fcplcn:plc-notice' ||
        !Number.isSafeInteger(data.sequence) ||
        data.sequence <= sequence.current ||
        data.sequence > 0xffff_ffff
      )
        return;
      if (data.notice === null) {
        sequence.current = data.sequence;
        onNotice(null);
      } else if (
        data.notice &&
        typeof data.notice === 'object' &&
        ['success', 'error', 'warning'].includes(data.notice.tone) &&
        typeof data.notice.text === 'string' &&
        data.notice.text.trim() &&
        data.notice.text.length <= 4096
      ) {
        sequence.current = data.sequence;
        onNotice({ tone: data.notice.tone, text: data.notice.text });
      }
    };
    window.addEventListener('message', message);
    return () => {
      window.removeEventListener('message', message);
      onNotice(null);
    };
  }, [deviceId, onNotice]);

  const loaded = () => {
    sequence.current = 0;
    onNotice(null);
    enable();
  };
  return { frame, loaded };
}
