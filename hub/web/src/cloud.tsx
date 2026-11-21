/** @file Привязка локального хаба к облаку и отображение состояния исходящего соединения. */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { HubCloudView } from '../../shared/cloud.js';
import { api, jsonBody } from './api';
import { Icon } from './icons';
import './cloud.css';

/** Форматирует время последнего подключения или подпись для ещё не подключавшегося хаба. */
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString('ru-RU') : 'Ещё не подключался';

/** Показывает живой статус облака отдельно от редактируемых полей привязки. */
export function CloudPanel() {
  // Живой статус соединения не заменяет несохранённые поля привязки.
  const [view, setView] = useState<HubCloudView | null>(null);
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const pending = useRef(false);
  const loading = useRef(false);
  const dirty = useRef(false);
  const version = useRef(0);

  /** Обновляет статус без параллельных опросов и не затирает несохранённые URL и имя. */
  async function load(signal?: AbortSignal) {
    if (pending.current || loading.current) return;
    loading.current = true;
    const generation = version.current;
    try {
      const next = await api<HubCloudView>('/cloud', { signal });
      if (!mounted.current || signal?.aborted || generation !== version.current) return;
      setView(next);
      if (!dirty.current) {
        setUrl(next.config.url);
        setName(next.config.name);
      }
      setError('');
    } catch (failure) {
      if (mounted.current && !signal?.aborted)
        setError(failure instanceof Error ? failure.message : 'Не удалось прочитать настройки');
    } finally {
      loading.current = false;
    }
  }

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void load(abort.signal);
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(abort.signal);
    }, 2000);
    return () => {
      mounted.current = false;
      abort.abort();
      window.clearInterval(timer);
    };
  }, []);

  /** Выполняет одну операцию привязки и принимает настройки только после ответа сервера. */
  async function mutate(path: string, body: unknown, success: string) {
    if (pending.current) return;
    pending.current = true;
    version.current++;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await api<HubCloudView>(path, { method: 'POST', ...jsonBody(body) });
      if (!mounted.current) return;
      setView(next);
      setUrl(next.config.url);
      setName(next.config.name);
      setCode('');
      dirty.current = false;
      setNotice(success);
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : 'Операция не подтверждена');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const state = view?.status.state || 'disabled';
  const labels = {
    disabled: 'Облако выключено',
    connecting: 'Подключаемся',
    online: 'На связи',
    error: 'Нет связи',
  };

  return (
    <section class="cloud-settings" data-cloud-settings>
      <article class="panel cloud-hero">
        <span class="cloud-orbit">
          <Icon name="cloud" />
        </span>
        <div>
          <span class="eyebrow">Ваш дом — откуда удобно</span>
          <h2>Облачная панель FCPLCn</h2>
          <p>
            Хаб сам устанавливает защищённое соединение с вашим сервером. Локальные сценарии и PLC
            работают независимо от интернета.
          </p>
        </div>
        <span class={`cloud-state ${state}`}>
          <i />
          {labels[state]}
        </span>
      </article>
      {error ? (
        <div class="notice error" role="alert">
          <Icon name="alarm" />
          <span>{error}</span>
          <button class="text-button" type="button" onClick={() => void load()}>
            Обновить
          </button>
        </div>
      ) : null}
      {notice ? (
        <div class="notice success" role="status">
          <Icon name="check" />
          <span>{notice}</span>
        </div>
      ) : null}
      <div class="cloud-settings-grid">
        <form
          class="panel cloud-card"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(
              '/cloud/pair',
              { url: url.trim(), code: code.trim(), name: name.trim() },
              'Хаб привязан. Ожидаем защищённое соединение с облаком.',
            );
          }}
        >
          <h2>
            <Icon name="link" />
            Привязать хаб
          </h2>
          <p>Создайте дом в облачной панели, получите одноразовый код и введите его здесь.</p>
          <label>
            Адрес облака
            <input
              type="url"
              placeholder="https://cloud.example.ru"
              value={url}
              onInput={(event) => {
                dirty.current = true;
                setUrl(event.currentTarget.value);
              }}
              required
              disabled={busy}
            />
          </label>
          <label>
            Название хаба
            <input
              placeholder="Например, Дом"
              value={name}
              onInput={(event) => {
                dirty.current = true;
                setName(event.currentTarget.value);
              }}
              maxLength={64}
              disabled={busy}
            />
          </label>
          <label>
            Код привязки
            <input
              autoComplete="off"
              placeholder="Одноразовый код из облака"
              value={code}
              onInput={(event) => setCode(event.currentTarget.value)}
              maxLength={128}
              required
              disabled={busy}
            />
          </label>
          <button class="button" disabled={busy || !url.trim() || !code.trim()}>
            <Icon name={busy ? 'refresh' : 'cloud'} />
            {busy ? 'Подключаем…' : 'Привязать к облаку'}
          </button>
          <p class="cloud-hint">
            Ключи подключения сохраняются на хабе и не показываются в браузере.
          </p>
        </form>
        <article class="panel cloud-card">
          <h2>
            <Icon name="activity" />
            Состояние подключения
          </h2>
          <dl class="cloud-diagnostics">
            <div>
              <dt>Привязка</dt>
              <dd>{view?.config.paired ? 'Хаб зарегистрирован' : 'Не настроена'}</dd>
            </div>
            <div>
              <dt>Облако</dt>
              <dd>{view?.config.url || '—'}</dd>
            </div>
            <div>
              <dt>Хаб</dt>
              <dd>{view?.config.name || '—'}</dd>
            </div>
            <div>
              <dt>Последнее подключение</dt>
              <dd>{date(view?.status.lastConnectedAt || null)}</dd>
            </div>
            <div>
              <dt>Передача состояний</dt>
              <dd>{date(view?.status.lastPublishedAt || null)}</dd>
            </div>
          </dl>
          {view?.status.error ? (
            <p class="inline-error" role="status">
              {view.status.error}
            </p>
          ) : null}
          {view?.config.paired ? (
            <>
              <button
                class="button secondary"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    '/cloud',
                    { baseRevision: view.config.revision, enabled: !view.config.enabled },
                    view.config.enabled
                      ? 'Подключение к облаку выключено.'
                      : 'Подключение к облаку включено.',
                  )
                }
              >
                <Icon name="power" />
                {view.config.enabled ? 'Выключить подключение' : 'Включить подключение'}
              </button>
              <button
                class="button cloud-disconnect"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      'Удалить привязку этого хаба к облаку? Локальные настройки и устройства сохранятся.',
                    )
                  )
                    void mutate(
                      '/cloud/disconnect',
                      {},
                      'Облачная привязка удалена. Локальная работа продолжается.',
                    );
                }}
              >
                <Icon name="trash" />
                Удалить привязку
              </button>
            </>
          ) : (
            <p>
              Проброс портов на домашнем роутере не требуется. После привязки пользователи входят в
              облачную панель, а PLC остаются в локальной сети.
            </p>
          )}
        </article>
      </div>
    </section>
  );
}
