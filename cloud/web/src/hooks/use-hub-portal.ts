/** @file Проверка отправителя высоты iframe без обратной связи с размером окна. */
import { useEffect, useRef, useState } from 'preact/hooks';

export function useHubPortal(selected: string, selectedRef: { current: string }) {
  const [height, setHeight] = useState(1250);
  const frame = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => setHeight(1250), [selected]);

  useEffect(() => {
    const message = (event: MessageEvent) => {
      if (
        event.origin === window.location.origin &&
        event.source === frame.current?.contentWindow &&
        event.data?.type === 'fcplcn:portal-height' &&
        event.data.homeId === selectedRef.current &&
        Number.isFinite(event.data.height)
      )
        setHeight(Math.max(850, Math.min(30000, Math.ceil(event.data.height))));
    };
    window.addEventListener('message', message);
    return () => window.removeEventListener('message', message);
  }, []);

  return { height, frame };
}
