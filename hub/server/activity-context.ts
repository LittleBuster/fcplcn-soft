/** @file Verified operation origin, carried through asynchronous dispatch and scene steps. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActivityActor, ActivityContext } from '../shared/activity.js';
import type { CommandView, SceneRun, ScenesSnapshot } from '../shared/types.js';

const activity = new AsyncLocalStorage<ActivityContext>();
const privateSourceNames = {
  web: 'Локальная учётная запись',
  telegram: 'Пользователь Telegram',
  key: 'Ключ PLC',
} as const;

export function currentActivity(): ActivityContext | undefined {
  return activity.getStore();
}

export function withActivity<T>(context: ActivityContext, operation: () => T): T {
  return activity.run(context, operation);
}

export function cloudActivityActor(userId: string, name?: string): ActivityActor {
  const clean =
    name
      ?.replace(/[\x00-\x1f\x7f]/g, ' ')
      .trim()
      .slice(0, 128) || '';
  return { source: 'cloud', name: clean || userId || 'Пользователь облака', id: userId };
}

/** Private LAN/Telegram identities stay in the hub's local journal. */
export function cloudActivityEntry<T extends CommandView | SceneRun>(entry: T): T {
  const actor = entry.actor;
  if (!actor || !Object.hasOwn(privateSourceNames, actor.source)) return entry;
  const name = privateSourceNames[actor.source as keyof typeof privateSourceNames];
  return { ...entry, actor: { source: actor.source, name } };
}

export function cloudSceneActivity(scenes: ScenesSnapshot): ScenesSnapshot {
  return {
    ...scenes,
    activeRun: scenes.activeRun && cloudActivityEntry(scenes.activeRun),
    runs: scenes.runs.map(cloudActivityEntry),
  };
}
