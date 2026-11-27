/** @file Навигация и фильтры хаба; изменения страницы не затрагивают автоматику. */
import { useEffect, useState } from 'preact/hooks';
import type { ControllerKind } from '../../../shared/types.js';
import type { View } from '../app/types';
import type { SceneGroup } from '../features/scenes/types';

const sceneHashes: Record<SceneGroup, string> = {
  instant: '#pult/scenes',
  scheduled: '#pult/scenes/scheduled',
};

function sceneGroupFromHash(): SceneGroup | null {
  if (window.location.hash === sceneHashes.instant) return 'instant';
  if (window.location.hash === sceneHashes.scheduled) return 'scheduled';
  return null;
}

const isPult = () => window.location.hash === '#pult' || sceneGroupFromHash() !== null;

/** Держит выбор PLC и фильтры отдельно от серверных данных. */
export function useHubNavigation(clearNotice: () => void) {
  const [view, setView] = useState<View>(isPult() ? 'pult' : 'overview');
  const [pultSceneGroup, setPultSceneGroup] = useState(sceneGroupFromHash);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ControllerKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [room, setRoom] = useState('all');
  const [configuration, setConfiguration] = useState<{
    id: string;
    irrigationRule?: string;
  } | null>(null);
  function setConfiguringId(id: string | null) {
    setConfiguration(id ? { id } : null);
  }

  function configureIrrigation(id: string, ruleId = '') {
    openDevice(id);
    setFilter('irrigation');
    setConfiguration({ id, irrigationRule: ruleId });
  }

  useEffect(() => {
    const followLink = () => {
      setConfiguringId(null);
      setSelectedId(null);
      setPultSceneGroup(sceneGroupFromHash());
      setView(isPult() ? 'pult' : 'overview');
      window.scrollTo({ top: 0, behavior: 'instant' });
    };
    window.addEventListener('hashchange', followLink);
    return () => window.removeEventListener('hashchange', followLink);
  }, []);

  /** Меняет раздел и закрывает выбранный PLC и его настройки. */
  function navigate(next: View) {
    setConfiguringId(null);
    setView(next);
    setPultSceneGroup(null);
    setSelectedId(null);
    window.history.replaceState(
      null,
      '',
      next === 'pult' ? '#pult' : window.location.pathname + window.location.search,
    );
    window.scrollTo({ top: 0, behavior: 'instant' });
    clearNotice();
  }

  function selectPultSceneGroup(group: SceneGroup | null) {
    setPultSceneGroup(group);
    window.history.replaceState(null, '', group ? sceneHashes[group] : '#pult');
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
    configuringId: configuration?.id,
    irrigationRule: configuration?.irrigationRule,
    configureIrrigation,
    setConfiguringId,
    navigate,
    pultSceneGroup,
    selectPultSceneGroup,
    openDevice,
  };
}

export type HubNavigation = ReturnType<typeof useHubNavigation>;
