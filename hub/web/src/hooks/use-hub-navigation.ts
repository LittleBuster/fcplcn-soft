/** @file Навигация и фильтры хаба; изменения страницы не затрагивают автоматику. */
import { useEffect, useState } from 'preact/hooks';
import type { ControllerKind } from '../../../shared/types.js';
import type { View } from '../app/types';

/** Держит выбор PLC и фильтры отдельно от серверных данных. */
export function useHubNavigation(clearNotice: () => void) {
  const [view, setView] = useState<View>(window.location.hash === '#pult' ? 'pult' : 'overview');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ControllerKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [room, setRoom] = useState('all');
  const [configuringId, setConfiguringId] = useState<string | null>(null);

  useEffect(() => {
    const followLink = () => {
      setConfiguringId(null);
      setSelectedId(null);
      setView(window.location.hash === '#pult' ? 'pult' : 'overview');
      window.scrollTo({ top: 0, behavior: 'instant' });
    };
    window.addEventListener('hashchange', followLink);
    return () => window.removeEventListener('hashchange', followLink);
  }, []);

  /** Меняет раздел и закрывает выбранный PLC и его настройки. */
  function navigate(next: View) {
    setConfiguringId(null);
    setView(next);
    setSelectedId(null);
    window.history.replaceState(
      null,
      '',
      next === 'pult' ? '#pult' : window.location.pathname + window.location.search,
    );
    window.scrollTo({ top: 0, behavior: 'instant' });
    clearNotice();
  }

  /** Открывает PLC с общим фильтром модулей и возвращает страницу к началу. */
  function openDevice(id: string) {
    setConfiguringId(null);
    setSelectedId(id);
    setFilter('all');
    setView('devices');
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    clearNotice();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  return {
    view,
    selectedId,
    setSelectedId,
    filter,
    setFilter,
    query,
    setQuery,
    room,
    setRoom,
    configuringId,
    setConfiguringId,
    navigate,
    openDevice,
  };
}

export type HubNavigation = ReturnType<typeof useHubNavigation>;
