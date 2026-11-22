/** @file Компактная шапка домашнего пульта: часы, дата и возврат к полной панели. */
import { useEffect, useState } from 'preact/hooks';
import type { HubSnapshot } from '../../../shared/types.js';
import { Icon } from '../icons';

interface PultHeadingProps {
  snapshot: HubSnapshot | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
  onBack: () => void;
}

/** Показывает время самого планшета, в том числе после возвращения приложения из фона. */
export function PultHeading({ snapshot, refreshing, refresh, onBack }: PultHeadingProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const update = () => setNow(new Date());
    const timer = window.setInterval(update, 15_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  useEffect(() => {
    if (!snapshot) return;
    const previous = document.title;
    document.title = `${snapshot.product.name} · Пульт — ${snapshot.product.fullName}`;
    return () => {
      document.title = previous;
    };
  }, [snapshot?.product.name, snapshot?.product.fullName]);

  return (
    <header class="pult-heading">
      <div class="pult-heading-identity">
        <span class="pult-heading-icon">
          <Icon name="home" />
        </span>
        <div>
          <p>{snapshot?.product.name || 'Локальный хаб'} · Всё под рукой</p>
          <h1>
            Пульт<span>.</span>
          </h1>
        </div>
      </div>
      <div class="pult-clock" aria-label="Местное время">
        <time dateTime={now.toISOString()}>
          {now.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          })}
        </time>
        <span>
          {now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}
        </span>
      </div>
      <div class="pult-heading-actions">
        <button
          type="button"
          class={`pult-header-button pult-refresh ${refreshing ? 'refreshing' : ''}`}
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label="Обновить состояния"
          title="Обновить состояния"
        >
          <Icon name="refresh" />
        </button>
        <button
          type="button"
          class="pult-header-button"
          onClick={onBack}
          aria-label="Панель хаба"
          title="Панель хаба"
        >
          <Icon name="settings" />
          <span>Панель хаба</span>
        </button>
      </div>
    </header>
  );
}
