/** @file Размер встроенного портала определяется его собственным содержимым. */
import { useEffect } from 'preact/hooks';
import { portal, homeId } from '../portal';

/** Передаёт родителю фактическую высоту без обратной зависимости от размера iframe. */
export function usePortalHeight() {
  // Высота встроенного портала зависит от содержимого, а не от размеров родительского окна.
  useEffect(() => {
    if (!portal) return;
    document.documentElement.dataset.cloudPortal = 'true';
    const root = document.getElementById('app')!;
    let lastHeight = 0;
    const report = () => {
      // Измеряем собственное содержимое: высота iframe не должна увеличивать результат измерения.
      const height = Math.ceil(Math.max(root.scrollHeight, root.getBoundingClientRect().height));
      if (height === lastHeight) return;
      lastHeight = height;
      window.parent.postMessage(
        {
          type: 'fcplcn:portal-height',
          homeId,
          height,
        },
        window.location.origin,
      );
    };
    const observer = new ResizeObserver(report);
    observer.observe(root);
    report();
    return () => observer.disconnect();
  }, []);
}
