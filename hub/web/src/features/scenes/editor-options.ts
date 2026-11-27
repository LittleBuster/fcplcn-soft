/** @file Дни недели и допустимые типы действий редактора. */

import type { SceneAction } from '../../../../shared/types.js';

export const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const builtinIds = ['home', 'away', 'prepare'];
export const standardKinds: SceneAction['controller'][] = [
  'sockets',
  'lights',
  'thermostats',
  'tanks',
  'irrigation',
];
