/** @file Черновик Telegram, отменяемый опрос и сохранение с проверкой ревизии. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { TelegramView } from '../../../../shared/telegram.js';
import { api, ApiError, jsonBody } from '../../api';
import { chatIdValid, type ChatDraft } from './model';

/** Сохраняет несохранённые поля при опросе и отбрасывает ответы устаревших запросов. */
export function useTelegramSettings() {
  // Последний ответ сервера и независимый от опроса черновик настроек.
  const [view, setView] = useState<TelegramView | null>(null);
  const [revision, setRevision] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [token, setToken] = useState('');
  const [removeToken, setRemoveToken] = useState(false);
  const [chats, setChats] = useState<ChatDraft[]>([]);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [notice, setNotice] = useState<{ text: string; kind: string } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [conflict, setConflict] = useState(false);

  // Защита от перекрытия запросов и применения ответа после сохранения или закрытия панели.
  const mounted = useRef(true);
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const loading = useRef(false);
  const reloadRequested = useRef(false);
  const loadVersion = useRef(0);
  dirtyRef.current = dirty;
  busyRef.current = busy;

  /** Помечает форму изменённой, чтобы очередной опрос статуса не заменил черновик. */
  function changed() {
    dirtyRef.current = true;
    setDirty(true);
    setNotice(null);
  }

  /** Принимает подтверждённую конфигурацию и очищает введённый секретный токен. */
  function accept(next: TelegramView) {
    setRevision(next.config.revision);
    setEnabled(next.config.enabled);
    setChats(next.config.chats.map(({ chatId, name }) => ({ chatId, name })));
    setToken('');
    setRemoveToken(false);
    dirtyRef.current = false;
    setDirty(false);
    setConflict(false);
  }

  /** Обновляет состояние бота; замена черновика допускается только по явной перезагрузке. */
  async function load(replace = false, signal?: AbortSignal) {
    if (busyRef.current) return;
    if (loading.current) {
      if (replace) reloadRequested.current = true;
      return;
    }
    const version = loadVersion.current;
    loading.current = true;
    try {
      const next = await api<TelegramView>('/telegram', { signal });
      if (!mounted.current || signal?.aborted || version !== loadVersion.current) return;
      setView(next);
      setLoadError('');
      if (replace || !dirtyRef.current) accept(next);
    } catch (error) {
      if (mounted.current && !signal?.aborted && version === loadVersion.current)
        setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить настройки');
    } finally {
      loading.current = false;
      if (mounted.current) setInitialLoading(false);
      if (mounted.current && reloadRequested.current) {
        reloadRequested.current = false;
        void load(true, signal);
      }
    }
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(false, controller.signal);
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(false, controller.signal);
    }, 2000);
    return () => {
      mounted.current = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  /** Проверяет Chat ID и имя, затем добавляет человека только в локальный черновик. */
  function addChat(chatId = newId.trim(), name = newName.trim()) {
    if (!chatIdValid(chatId)) {
      setNotice({
        kind: 'error',
        text: 'Укажите Chat ID личного чата: положительное целое число.',
      });
      return;
    }
    if (chats.some((entry) => entry.chatId === chatId)) {
      setNotice({ kind: 'warning', text: 'Этот человек уже добавлен в список доступа.' });
      return;
    }
    if (chats.length >= 64) {
      setNotice({ kind: 'error', text: 'Можно добавить не более 64 пользователей.' });
      return;
    }
    if (new TextEncoder().encode(name).length > 96 || /[\x00-\x1f\x7f]/.test(name)) {
      setNotice({
        kind: 'error',
        text: 'Имя должно быть не длиннее 96 байт и не содержать переносов строк.',
      });
      return;
    }
    setChats((current) => [...current, { chatId, name }]);
    setNewId('');
    setNewName('');
    changed();
  }

  /** Сохраняет настройки с исходной ревизией; при конфликте оставляет изменения для проверки. */
  async function save() {
    if (!view || busyRef.current) return;
    if (
      chats.some(
        (chat) =>
          !chatIdValid(chat.chatId) ||
          new TextEncoder().encode(chat.name).length > 96 ||
          /[\x00-\x1f\x7f]/.test(chat.name),
      )
    ) {
      setNotice({
        kind: 'error',
        text: 'Проверьте Chat ID и сократите слишком длинные имена пользователей.',
      });
      return;
    }
    if (enabled && removeToken && !token.trim()) {
      setNotice({ kind: 'error', text: 'Для включения бота укажите токен.' });
      return;
    }
    if (enabled && !view.config.tokenConfigured && !token.trim()) {
      setNotice({ kind: 'error', text: 'Сначала введите токен бота из BotFather.' });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    loadVersion.current++;
    try {
      const next = await api<TelegramView>('/telegram', {
        method: 'POST',
        ...jsonBody({
          baseRevision: revision,
          enabled,
          chats,
          ...(token.trim() ? { token: token.trim() } : removeToken ? { token: null } : {}),
        }),
      });
      if (!mounted.current) return;
      setView(next);
      accept(next);
      setNotice({ kind: 'success', text: 'Настройки Telegram сохранены.' });
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Не удалось сохранить настройки',
      });
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  /** Проверяет сохранённое подключение бота отдельно от редактирования его настроек. */
  async function testConnection() {
    if (testing || busy || dirty || !view?.config.tokenConfigured) return;
    setTesting(true);
    setNotice(null);
    try {
      await api('/telegram/test', { method: 'POST', ...jsonBody({}) });
      if (mounted.current) {
        setNotice({ kind: 'success', text: 'Telegram подтвердил токен бота.' });
        await load();
      }
    } catch (error) {
      if (mounted.current)
        setNotice({
          kind: 'error',
          text: error instanceof Error ? error.message : 'Не удалось проверить бота',
        });
    } finally {
      if (mounted.current) setTesting(false);
    }
  }

  return {
    view,
    revision,
    enabled,
    setEnabled,
    token,
    setToken,
    removeToken,
    setRemoveToken,
    chats,
    setChats,
    newId,
    setNewId,
    newName,
    setNewName,
    dirty,
    busy,
    testing,
    initialLoading,
    notice,
    setNotice,
    loadError,
    conflict,
    changed,
    load,
    addChat,
    save,
    testConnection,
  };
}

export type TelegramSettings = ReturnType<typeof useTelegramSettings>;
