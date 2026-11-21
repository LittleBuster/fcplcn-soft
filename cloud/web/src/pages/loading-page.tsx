/** @file Первичное чтение сессии и повторная попытка после сетевой ошибки. */
import { Icon } from '../icons';

export function LoadingPage({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <main class="loading-page">
      <Icon name="cloud" />
      <h1>FCPLCn</h1>
      <p>{error || 'Подключаемся к вашему дому…'}</p>
      {error ? (
        <button class="button" onClick={onRetry}>
          Повторить
        </button>
      ) : null}
    </main>
  );
}
