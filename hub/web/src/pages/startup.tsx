/** @file Начальное подключение к хабу и повтор чтения сессии после сетевой ошибки. */
import { Icon } from '../icons';

interface StartupProps {
  initialError: string;
  loadSession: () => Promise<void>;
}

/** Показывает состояние первого запроса без доступа к оборудованию. */
export function StartupPage({ initialError, loadSession }: StartupProps) {
  return (
    <main class="startup-screen">
      <div class="brand-symbol">
        <Icon name="home" />
      </div>
      <h1>{initialError ? 'Хаб недоступен' : 'Подключаемся к хабу'}</h1>
      {initialError ? (
        <>
          <p role="alert">{initialError}</p>
          <button class="button" onClick={() => void loadSession()}>
            <Icon name="refresh" />
            Повторить
          </button>
        </>
      ) : (
        <p>Загружаем состояние локальной сети…</p>
      )}
    </main>
  );
}
