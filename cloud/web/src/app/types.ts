/** @file Типы оболочки облачной панели и её адресованных операций. */
import type { CloudSession, HomeDetail, HomeView } from '../../../shared/api.js';

export type CloudView = 'control' | 'access' | 'connection' | 'history' | 'account' | 'firmware';
export type Notice = { kind: 'error' | 'success' | 'warning'; text: string };
export type CloudAction = <T = unknown>(
  path: string,
  body?: unknown,
  method?: string,
  success?: string,
) => Promise<T | undefined>;

/** Поколение исключает поздние ответы прежнего дома или прежней сессии. */
export interface CloudLifetime {
  mounted: { current: boolean };
  generation: { current: number };
}

export interface SessionModel {
  session: CloudSession | null;
  refreshSession: () => Promise<void>;
  acceptSession: (value: CloudSession) => void;
  logout: () => Promise<void>;
}

export interface HomeDataModel {
  homes: HomeView[];
  selected: string;
  selectedRef: { current: string };
  detail: HomeDetail | null;
  refresh: () => Promise<void>;
  selectHome: (id: string) => void;
  clear: (resetSelection?: boolean) => void;
}
