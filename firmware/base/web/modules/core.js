/**
 * @file core.js
 * @brief Shared service UI state, API boundary and DOM primitives.
 */
export function createCoreUI(context) {
  const showLogin = (...args) => context.showLogin(...args);

  const byId = (id) => document.getElementById(id);

  const productName = document.querySelector('h1').textContent.trim();

  // The hub injects only a same-origin, per-device service endpoint into its copied UI.
  const configuredApiBase = document.querySelector('meta[name="fcplcn-api-base"]')?.content || '';
  const apiBase =
    /^\/api\/v1\/(?:homes\/[a-zA-Z0-9_-]{1,96}\/hub\/)?devices\/[a-zA-Z0-9_-]{1,96}\/service$/.test(
      configuredApiBase,
    )
      ? configuredApiBase
      : '/api/v1';
  const hubEmbedded =
    apiBase !== '/api/v1' &&
    document.querySelector('meta[name="fcplcn-hub-embedded"]')?.content === 'true';

  const backupSizeLimit = 32 * 1024;

  /** @brief Session-scoped UI state; runtime freshness and unsaved settings are independent. */
  const state = {
    authenticated: false,
    config: null,
    dirty: new Set(),
    formEdits: new Map(),
    timer: null,
    polling: false,
    noticeKey: '',
    networkChangedAt: 0,
    profiles: [],
    profilesLoaded: false,
    profilesLoading: false,
    hardwareSaving: false,
    hardwareStatus: null,
    sessionVersion: 0,
    activeTab: 'network',
    networkView: 'list',
    backupDocument: null,
    backupFilename: '',
    backupBusy: '',
    backupReadVersion: 0,
    ioSnapshot: null,
    ioFresh: false,
    ioTimer: null,
    ioGeneration: 0,
    ioPending: null,
    ioActionBusy: false,
    ioActionId: '',
    ioRelayErrors: new Map(),
    ioUncertainRelays: new Set(),
    controllersView: '',
    controllersTimer: null,
    controllersGeneration: 0,
    controllersPending: null,
    controllersBusy: false,
    controllersAction: null,
    controllerResources: [],
    meteoScans: new Map(),
    meteoScanQueue: new Map(),
  };

  const controllers = [
    {
      id: 'sockets',
      data: 'socket',
      title: 'Розетки',
      singular: 'Розетка',
      object: 'розетку',
      genitive: 'розетки',
      plural: 'розеток',
      empty: 'Розетки ещё не добавлены',
      dirtyKey: 'controllers',
    },
    {
      id: 'lights',
      data: 'light',
      title: 'Свет',
      singular: 'Светильник',
      object: 'светильник',
      genitive: 'светильника',
      plural: 'светильников',
      empty: 'Светильники ещё не добавлены',
      dirtyKey: 'lights',
    },
    {
      id: 'meteo',
      data: 'meteo',
      title: 'Метео',
      singular: 'Датчик',
      object: 'датчик',
      empty: 'Датчики ещё не добавлены',
      dirtyKey: 'meteo',
      isMeteo: true,
    },
    {
      id: 'thermostats',
      data: 'thermostat',
      title: 'Термостат',
      singular: 'Термостат',
      object: 'термостат',
      empty: 'Термостаты ещё не добавлены',
      dirtyKey: 'thermostats',
      isThermostat: true,
    },
    {
      id: 'irrigation',
      data: 'irrigation',
      title: 'Полив',
      singular: 'Правило',
      object: 'правило',
      empty: 'Правила полива ещё не добавлены',
      dirtyKey: 'irrigation',
      isIrrigation: true,
    },
    {
      id: 'tanks',
      data: 'tank',
      title: 'Баки',
      singular: 'Бак',
      object: 'бак',
      empty: 'Баки ещё не добавлены',
      dirtyKey: 'tanks',
      isTank: true,
    },
    {
      id: 'security',
      data: 'security',
      title: 'Охрана',
      singular: 'Датчик охраны',
      object: 'датчик охраны',
      empty: 'Датчики охраны ещё не добавлены',
      dirtyKey: 'security',
      isSecurity: true,
    },
  ].map((model) => ({
    ...model,
    snapshot: null,
    draft: [],
    baseRevision: null,
    baseItems: '',
    loaded: false,
    fresh: false,
    errors: new Map(),
    uncertain: new Set(),
    conflict: false,
    loadError: '',
    notice: '',
    noticeKind: '',
  }));

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  /** @brief Ignore replies from a session that ended while a request was in flight. */
  const currentSession = (version) => state.authenticated && version === state.sessionVersion;

  function notice(message, kind = '', key = '') {
    const el = byId('notice');
    el.textContent = message;
    el.className = `notice ${kind}`.trim();
    el.hidden = !message;
    state.noticeKey = key;
  }

  /**
   * @brief Fetch JSON with a bounded timeout and cookie authentication.
   * @note Callers retain their session/generation token before applying asynchronous replies.
   */
  async function api(path, options = {}, authRequired = true) {
    const sessionVersion = state.sessionVersion;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), hubEmbedded ? 12000 : 10000);
    try {
      const response = await fetch(`${apiBase}${path}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.method &&
          options.method !== 'GET' &&
          document.querySelector('meta[name="fcplcn-csrf-token"]')?.content
            ? { 'X-FCPLCN-CSRF': document.querySelector('meta[name="fcplcn-csrf-token"]').content }
            : {}),
          ...options.headers,
        },
        signal: controller.signal,
      });
      let data;
      try {
        data = await response.json();
      } catch (_) {
        data = {};
      }
      if (!response.ok) {
        if (
          response.status === 401 &&
          authRequired &&
          state.authenticated &&
          sessionVersion === state.sessionVersion
        ) {
          showLogin('Сессия завершена. Войдите в контроллер снова.');
        }
        throw new ApiError(data.error || `Ошибка HTTP ${response.status}`, response.status);
      }
      if (hubEmbedded && path === '/user' && options.method === 'POST') {
        // A PLC account change ends its service session; hub authorization remains independent.
        window.setTimeout(() => window.location.reload(), 0);
      }
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error.name === 'AbortError')
        throw new ApiError('Контроллер не ответил вовремя. Проверьте подключение.', 0);
      throw new ApiError('Нет связи с контроллером. Проверьте подключение и адрес.', 0);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  const post = (path, data, authRequired = true) =>
    api(path, { method: 'POST', body: JSON.stringify(data) }, authRequired);

  const value = (id) => byId(id).value.trim();

  const checked = (id) => byId(id).checked;

  const text = (id, valueToShow) => {
    byId(id).textContent =
      valueToShow === undefined || valueToShow === null || valueToShow === ''
        ? '—'
        : String(valueToShow);
  };

  const onOff = (enabled) => (enabled ? 'Включён' : 'Выключен');

  function fieldError(id, message, prefix) {
    const element = byId(id);
    const actual = typeof message === 'string' ? message.trim() : '';
    element.textContent = actual ? `${prefix}: ${actual}` : '';
    element.hidden = !actual;
  }

  const gpioLabel = (gpio) => (Number.isInteger(gpio) && gpio >= 0 ? `GPIO ${gpio}` : 'GPIO —');

  const i2cAddress = (address) =>
    Number.isInteger(address) && address >= 0 && address <= 127
      ? `0x${address.toString(16).toUpperCase().padStart(2, '0')}`
      : '—';

  const errorMessage = (error) => (typeof error === 'string' ? error.trim() : '');

  function hardwareElement(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }

  /** @brief Reuse decorative local SVG symbols without treating API labels as HTML. */
  function iconHeading(element, label, name, small = false, tone = '') {
    let svg = Array.from(element.children).find((child) => child.matches('svg.ui-icon'));
    let caption = element.querySelector('.icon-label');
    if (!svg || !caption) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'use'));
      caption = hardwareElement('span', 'icon-label');
      element.replaceChildren(svg, caption);
    }
    element.classList.add('icon-heading');
    svg.setAttribute('class', `ui-icon${small ? ' small' : ''}${tone ? ` ${tone}` : ''}`);
    svg.dataset.icon = name;
    svg.querySelector('use').setAttribute('href', `#icon-${name}`);
    if (caption.textContent !== label) caption.textContent = label;
  }

  function controllerIcon(model, item) {
    if (model.isSecurity)
      return {
        name: item?.sensorType === 'motion' ? 'motion' : item ? 'door' : 'security',
        tone: '',
      };
    if (model.isMeteo)
      return {
        name: item?.sensorType ? (item.sensorType === 'onewire' ? 'onewire' : 'dht22') : 'weather',
        tone: '',
      };
    if (model.isIrrigation) return { name: 'irrigation', tone: 'sensor' };
    if (model.isTank) return { name: 'tank', tone: 'sensor' };
    if (model.isThermostat) return { name: item?.mode || 'probe', tone: item?.mode || '' };
    return { name: model.id === 'lights' ? 'light' : 'plug', tone: '' };
  }

  /** @brief Create a prominent controller visual; actions use native keyboard-accessible buttons. */
  function createControllerVisual({ interactive = false, onActivate } = {}) {
    const visual = hardwareElement(interactive ? 'button' : 'div', 'controller-visual');
    visual.dataset.controllerVisual = '';
    if (interactive) {
      visual.type = 'button';
      visual.disabled = true;
      visual.setAttribute('aria-pressed', 'mixed');
      if (typeof onActivate === 'function') visual.addEventListener('click', onActivate);
    } else visual.setAttribute('role', 'group');
    const number = hardwareElement('span', 'controller-visual-number');
    number.setAttribute('aria-hidden', 'true');
    const art = hardwareElement('span', 'controller-visual-art');
    art.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 128 128');
    svg.setAttribute('class', 'controller-visual-icon');
    svg.setAttribute('focusable', 'false');
    svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'use'));
    art.append(svg);
    const copy = hardwareElement('span', 'controller-visual-copy');
    copy.append(
      hardwareElement('span', 'controller-visual-caption'),
      hardwareElement('span', 'controller-visual-detail'),
    );
    visual.append(number, art, copy);
    return visual;
  }

  /** @brief Render confirmed visual state without replacing nested readings or trusted settings. */
  function renderControllerVisual(
    visual,
    {
      icon = 'plug',
      tone = 'power',
      state: visualState = 'unknown',
      pending = false,
      disabled = false,
      pressed = 'mixed',
      label = '',
      caption = '',
      detail = '',
      number = '',
    } = {},
  ) {
    const icons = [
      'plug',
      'light',
      'dht22',
      'onewire',
      'heating',
      'cooling',
      'security',
      'security-alarm',
      'irrigation',
      'door',
      'motion',
    ];
    const iconName = icons.includes(icon) ? icon : 'plug';
    visual.dataset.state = ['on', 'off', 'unknown', 'error'].includes(visualState)
      ? visualState
      : 'unknown';
    visual.dataset.tone = ['power', 'light', 'sensor', 'heating', 'cooling', 'security'].includes(
      tone,
    )
      ? tone
      : 'power';
    visual.setAttribute('aria-busy', String(Boolean(pending)));
    if (label) visual.setAttribute('aria-label', label);
    else visual.removeAttribute('aria-label');
    if (visual.tagName === 'BUTTON') {
      visual.disabled = Boolean(disabled || pending);
      visual.setAttribute('aria-pressed', typeof pressed === 'boolean' ? String(pressed) : 'mixed');
    }
    const svg = visual.querySelector('.controller-visual-icon');
    svg.dataset.icon = iconName;
    svg.querySelector('use').setAttribute('href', `#visual-${iconName}`);
    for (const [field, value] of Object.entries({ caption, detail, number })) {
      const element = visual.querySelector(`.controller-visual-${field}`);
      const content = value === undefined || value === null ? '' : String(value);
      if (element.textContent !== content) element.textContent = content;
      element.hidden = !content;
    }
  }

  return {
    byId,
    productName,
    backupSizeLimit,
    state,
    controllers,
    ApiError,
    currentSession,
    notice,
    api,
    post,
    value,
    checked,
    text,
    onOff,
    fieldError,
    gpioLabel,
    i2cAddress,
    errorMessage,
    hardwareElement,
    iconHeading,
    controllerIcon,
    createControllerVisual,
    renderControllerVisual,
  };
}
