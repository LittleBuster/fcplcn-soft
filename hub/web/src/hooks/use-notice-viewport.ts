/** @file Смещение плавающего уведомления к видимой области облачного портала. */
import { useLayoutEffect, useState } from 'preact/hooks';
import { portal } from '../portal';

/** Полноразмерный iframe привязывает нижний край уведомления к окну пользователя. */
export function useNoticeViewport(active: boolean): number {
  const [bottom, setBottom] = useState(0);

  useLayoutEffect(() => {
    setBottom(0);
    if (!active || !portal) return;

    // Portal documents are same-origin; an unexpected embedding must remain harmless.
    let frame: Element | null;
    let parentWindow: Window;
    let viewport: VisualViewport | null;
    try {
      frame = window.frameElement;
      parentWindow = window.parent;
      viewport = parentWindow.visualViewport;
      if (!frame || parentWindow === window) return;
    } catch {
      return;
    }

    let pending = 0;
    const measure = () => {
      pending = 0;
      try {
        const visibleBottom = viewport
          ? viewport.offsetTop + viewport.height
          : parentWindow.innerHeight;
        const offset = Math.max(
          0,
          window.innerHeight + frame!.getBoundingClientRect().top - visibleBottom,
        );
        setBottom(offset);
      } catch {
        setBottom(0);
      }
    };
    const schedule = () => {
      if (!pending) pending = window.requestAnimationFrame(measure);
    };

    measure();
    parentWindow.addEventListener('scroll', schedule, true);
    parentWindow.addEventListener('resize', schedule);
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    viewport?.addEventListener('resize', schedule);
    return () => {
      if (pending) window.cancelAnimationFrame(pending);
      try {
        parentWindow.removeEventListener('scroll', schedule, true);
        parentWindow.removeEventListener('resize', schedule);
      } catch {
        // The parent may have navigated away from the same-origin portal.
      }
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      viewport?.removeEventListener('resize', schedule);
    };
  }, [active]);

  return bottom;
}
