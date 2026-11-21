/** @file Навигация и фильтры хаба; изменения страницы не затрагивают автоматику. */
import { useState } from 'preact/hooks';
import type { ControllerKind } from '../../../shared/types.js';
import type { View } from '../app/types';

/** Держит выбор PLC и фильтры отдельно от серверных данных. */
export function useHubNavigation(clearNotice: () => void) {
  const [view, setView] = useState<View>('overview');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ControllerKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [room, setRoom] = useState('all');
  const [configuringId, setConfiguringId] = useState<string | null>(null);

  /** Меняет раздел и закрывает выбранный PLC и его настройки. */
  function navigate(next: View) {
    setConfiguringId(null);
    setView(next);
    setSelectedId(null);
    clearNotice();
  }

  /** Открывает PLC с общим фильтром модулей и возвращает страницу к началу. */
  function openDevice(id: string) {
    setConfiguringId(null);
    setSelectedId(id);
    setFilter('all');
    setView('devices');
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
