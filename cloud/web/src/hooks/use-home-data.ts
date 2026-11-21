/** @file Список домов и свежие данные выбранного дома с защитой от запоздавших ответов. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { HomeDetail, HomeView } from '../../../shared/api.js';
import type { CloudLifetime, HomeDataModel } from '../app/types';
import { api } from '../api';
import { failure } from '../lib/presentation';

interface Options {
  authenticated: boolean;
  lifetime: CloudLifetime;
  onError: (message: string) => void;
}

/** Опросы не перекрываются, а смена дома немедленно отделяет прежние ответы. */
export function useHomeData({ authenticated, lifetime, onError }: Options): HomeDataModel {
  const [homes, setHomes] = useState<HomeView[]>([]);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<HomeDetail | null>(null);
  const loading = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  async function refresh() {
    if (loading.current) return;
    loading.current = true;
    const current = lifetime.generation.current;
    try {
      const list = await api<{ homes: HomeView[] }>('/homes');
      if (!lifetime.mounted.current || current !== lifetime.generation.current) return;
      setHomes(list.homes);
      const id = list.homes.some((entry) => entry.id === selectedRef.current)
        ? selectedRef.current
        : list.homes[0]?.id || '';
      if (id !== selectedRef.current) {
        setSelected(id);
        setDetail(null);
      }
      if (id) {
        const data = await api<HomeDetail>('/homes/' + encodeURIComponent(id));
        if (lifetime.mounted.current && current === lifetime.generation.current) {
          setDetail(data);
          onError('');
        }
      } else setDetail(null);
    } catch (error) {
      if (lifetime.mounted.current && current === lifetime.generation.current)
        onError(failure(error));
    } finally {
      loading.current = false;
    }
  }

  useEffect(() => {
    if (!authenticated) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [authenticated]);

  useEffect(() => {
    if (authenticated) void refresh();
  }, [selected]);

  function selectHome(id: string) {
    lifetime.generation.current++;
    setSelected(id);
    setDetail(null);
  }

  function clear(resetSelection = false) {
    setDetail(null);
    setHomes([]);
    if (resetSelection) setSelected('');
  }

  return { homes, selected, selectedRef, detail, refresh, selectHome, clear };
}
