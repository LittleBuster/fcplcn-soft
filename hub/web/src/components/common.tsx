/** @file Общие метки и пустые состояния интерфейса хаба. */

import type { ComponentChildren } from 'preact';
import { Icon, type IconName } from '../icons';

/** Отображает компактную текстовую метку состояния с общей цветовой индикацией. */
export function Badge({ tone = '', children }: { tone?: string; children: ComponentChildren }) {
  return (
    <span class={`badge ${tone}`}>
      <span class="badge-dot" />
      {children}
    </span>
  );
}

/** Выводит единое пустое состояние с иконкой, заголовком и пояснением. */
export function Empty({ icon, title, detail }: { icon: IconName; title: string; detail: string }) {
  return (
    <div class="empty-state panel">
      <Icon name={icon} />
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
