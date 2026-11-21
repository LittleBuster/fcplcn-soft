/**
 * @file bootstrap.js
 * @brief Service UI event wiring and initial session discovery.
 */
export function createBootstrapUI(context) {
  const { controllers, state } = context;
  const activateNetworkView = (...args) => context.activateNetworkView(...args);
  const activateTab = (...args) => context.activateTab(...args);
  const api = (...args) => context.api(...args);
  const buildEthernet = (...args) => context.buildEthernet(...args);
  const buildHub = (...args) => context.buildHub(...args);
  const buildSystem = (...args) => context.buildSystem(...args);
  const buildWifi = (...args) => context.buildWifi(...args);
  const byId = (...args) => context.byId(...args);
  const checked = (...args) => context.checked(...args);
  const clearBackupSelection = (...args) => context.clearBackupSelection(...args);
  const controllerClaims = (...args) => context.controllerClaims(...args);
  const currentSession = (...args) => context.currentSession(...args);
  const dirty = (...args) => context.dirty(...args);
  const downloadBackup = (...args) => context.downloadBackup(...args);
  const fillConfig = (...args) => context.fillConfig(...args);
  const fillHardwarePending = (...args) => context.fillHardwarePending(...args);
  const hardwareActionNotice = (...args) => context.hardwareActionNotice(...args);
  const hardwareCommand = (...args) => context.hardwareCommand(...args);
  const iconHeading = (...args) => context.iconHeading(...args);
  const loadBoardProfiles = (...args) => context.loadBoardProfiles(...args);
  const newMeteoBinding = (...args) => context.newMeteoBinding(...args);
  const notice = (...args) => context.notice(...args);
  const pollStatus = (...args) => context.pollStatus(...args);
  const post = (...args) => context.post(...args);
  const reloadController = (...args) => context.reloadController(...args);
  const renderControllers = (...args) => context.renderControllers(...args);
  const requestMeteoScan = (...args) => context.requestMeteoScan(...args);
  const restoreBackup = (...args) => context.restoreBackup(...args);
  const saveController = (...args) => context.saveController(...args);
  const selectBackupFile = (...args) => context.selectBackupFile(...args);
  const setControllerEnabled = (...args) => context.setControllerEnabled(...args);
  const setValue = (...args) => context.setValue(...args);
  const showApp = (...args) => context.showApp(...args);
  const showLogin = (...args) => context.showLogin(...args);
  const text = (...args) => context.text(...args);
  const updateControllersPolling = (...args) => context.updateControllersPolling(...args);
  const updateControls = (...args) => context.updateControls(...args);
  const updateHardwareControls = (...args) => context.updateHardwareControls(...args);
  const updateHardwarePolling = (...args) => context.updateHardwarePolling(...args);
  const value = (...args) => context.value(...args);

  function mergedConfig(config, patch, revision) {
    const result = JSON.parse(JSON.stringify(config));
    function merge(target, changes) {
      for (const [key, val] of Object.entries(changes)) {
        if (key === 'password') {
          target.passwordSet = val.length > 0;
          continue;
        }
        if (val && typeof val === 'object' && !Array.isArray(val))
          merge(target[key] || (target[key] = {}), val);
        else target[key] = val;
      }
    }
    merge(result, patch);
    result.revision = revision;
    return result;
  }

  /** @brief Disable submit actions and suppress errors delivered after their session ended. */
  async function withBusy(form, operation) {
    const sessionVersion = state.sessionVersion;
    const buttons = form.querySelectorAll('button');
    buttons.forEach((button) => {
      button.disabled = true;
    });
    try {
      await operation();
    } catch (error) {
      if (currentSession(sessionVersion)) notice(error.message, 'error');
    } finally {
      buttons.forEach((button) => {
        button.disabled = false;
      });
    }
  }

  /** @brief Save one form, retaining any edits entered after its request was sent. */
  async function saveConfig(tab, builder, form) {
    await withBusy(form, async () => {
      const sessionVersion = state.sessionVersion;
      const editVersion = state.formEdits.get(tab) || 0;
      const patch = builder();
      const proposed = mergedConfig(state.config, patch, state.config.revision);
      const wifiUsable =
        proposed.wifi.enabled && (proposed.wifi.ap.enabled || proposed.wifi.sta.enabled);
      if (!proposed.ethernet.enabled && !wifiUsable)
        throw new Error('Оставьте включённым хотя бы один сетевой интерфейс.');
      const response = await post('/config', { baseRevision: state.config.revision, ...patch });
      if (!currentSession(sessionVersion)) return;
      if (response.ok !== true || !Number.isSafeInteger(response.revision))
        throw new Error('Контроллер не подтвердил сохранение настроек.');
      const editedDuringSave = (state.formEdits.get(tab) || 0) !== editVersion;
      fillConfig(
        mergedConfig(state.config, patch, response.revision),
        editedDuringSave ? [] : [tab],
      );
      const pendingEdits = editedDuringSave ? ' Новые правки в этой форме ещё не сохранены.' : '';
      if (tab === 'hub') {
        notice(
          `Настройки хаба сохранены. Подключение к хабу обновляется.${pendingEdits}`,
          'success',
        );
        pollStatus();
      } else if (response.networkRestart) {
        state.networkChangedAt = Date.now();
        notice(
          `Настройки сохранены. Сетевые интерфейсы перезапускаются. При потере связи подключитесь к новой сети или откройте новый IP-адрес контроллера.${pendingEdits}`,
          'warning',
          'network',
        );
      } else {
        notice(`Настройки сохранены.${pendingEdits}`, 'success');
        pollStatus();
      }
    });
  }

  async function requestReboot(message) {
    const sessionVersion = state.sessionVersion;
    await post('/reboot', {});
    if (currentSession(sessionVersion)) notice(message, 'warning', 'reboot');
  }

  async function saveHardware() {
    if (
      [...state.dirty].some((key) => key !== 'hardware') &&
      !window.confirm(
        'В других формах есть несохранённые изменения. При перезагрузке они будут потеряны. Сохранить модель платы и перезагрузить контроллер?',
      )
    )
      return;
    const sessionVersion = state.sessionVersion;
    state.hardwareSaving = true;
    updateHardwareControls();
    try {
      const boardId = value('hardware-board-id');
      if (!state.profilesLoaded || !state.profiles.some((profile) => profile.boardId === boardId))
        throw new Error('Выберите доступную модель платы.');
      const patch = { hardware: { boardId } };
      const response = await post('/config', { baseRevision: state.config.revision, ...patch });
      if (!currentSession(sessionVersion)) return;
      if (response.ok !== true || !Number.isSafeInteger(response.revision))
        throw new Error('Контроллер не подтвердил сохранение модели платы.');
      fillConfig(mergedConfig(state.config, patch, response.revision), ['hardware']);
      state.hardwareStatus = {
        ...state.hardwareStatus,
        configuredBoardId: boardId,
        rebootRequired: Boolean(response.rebootRequired),
      };
      fillHardwarePending();
      try {
        await requestReboot(
          'Модель платы сохранена. Команда перезагрузки принята. Дождитесь запуска контроллера и войдите снова.',
        );
      } catch (error) {
        if (currentSession(sessionVersion)) {
          notice(
            `Модель платы сохранена, но не удалось отправить команду перезагрузки: ${error.message}`,
            'error',
            'hardware-reboot',
          );
          pollStatus();
        }
      }
    } catch (error) {
      if (currentSession(sessionVersion)) notice(error.message, 'error');
    } finally {
      if (currentSession(sessionVersion)) {
        state.hardwareSaving = false;
        updateHardwareControls();
      }
    }
  }

  function fillBrowserTime() {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    setValue('manual-time', local.toISOString().slice(0, 19));
  }

  function start() {
    byId('login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const sessionVersion = ++state.sessionVersion;
      const button = event.currentTarget.querySelector('button');
      button.disabled = true;
      byId('login-error').hidden = true;
      try {
        await post(
          '/login',
          { username: value('login-username'), password: byId('login-password').value },
          false,
        );
        if (sessionVersion !== state.sessionVersion) return;
        byId('login-password').value = '';
        const config = await api('/config', {}, false);
        if (sessionVersion === state.sessionVersion) showApp(config);
      } catch (error) {
        if (sessionVersion === state.sessionVersion) {
          text('login-error', error.message);
          byId('login-error').hidden = false;
        }
      } finally {
        button.disabled = false;
      }
    });

    byId('logout').addEventListener('click', async () => {
      if (state.dirty.size && !window.confirm('Выйти? Несохранённые изменения будут потеряны.'))
        return;
      const sessionVersion = state.sessionVersion;
      try {
        await post('/logout', {});
        if (currentSession(sessionVersion)) showLogin('Вы вышли из контроллера.');
      } catch (error) {
        if (currentSession(sessionVersion)) notice(error.message, 'error');
      }
    });

    byId('reload-config').addEventListener('click', async () => {
      if (state.activeTab === 'controllers') {
        reloadController(
          controllers.find((model) => model.id === state.controllersView) || controllers[0],
        );
        return;
      }
      if (
        state.dirty.size &&
        !window.confirm('Загрузить сохранённые настройки? Несохранённые изменения будут потеряны.')
      )
        return;
      const sessionVersion = state.sessionVersion;
      const editVersions = new Map(state.formEdits);
      try {
        const config = await api('/config');
        if (!currentSession(sessionVersion)) return;
        const tabs = ['wifi', 'ethernet', 'hub', 'system', 'hardware', 'users'];
        const unchanged = tabs.filter(
          (tab) => (state.formEdits.get(tab) || 0) === (editVersions.get(tab) || 0),
        );
        fillConfig(config, unchanged);
        notice(
          `Сохранённые настройки загружены.${unchanged.length < tabs.length ? ' Правки, введённые во время загрузки, оставлены в формах.' : ''}`,
          'success',
        );
      } catch (error) {
        if (currentSession(sessionVersion)) notice(error.message, 'error');
      }
    });

    for (const button of document.querySelectorAll('[data-tab]')) {
      button.addEventListener('click', () => activateTab(button.dataset.tab));
      button.addEventListener('keydown', (event) => {
        const tabs = Array.from(document.querySelectorAll('[data-tab]'));
        let index = tabs.indexOf(button);
        if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') index = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') index = 0;
        else if (event.key === 'End') index = tabs.length - 1;
        else return;
        event.preventDefault();
        activateTab(tabs[index].dataset.tab, true);
      });
    }

    for (const button of document.querySelectorAll('[data-network-target]')) {
      button.addEventListener('click', () =>
        activateNetworkView(button.dataset.networkTarget, true),
      );
    }

    for (const button of document.querySelectorAll('[data-network-back]')) {
      button.addEventListener('click', () => activateNetworkView('list', true));
    }

    for (const form of document.querySelectorAll('[data-config]')) {
      form.addEventListener('input', () => {
        dirty(form.dataset.config);
        updateControls();
      });
      form.addEventListener('change', () => {
        dirty(form.dataset.config);
        updateControls();
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const tab = form.dataset.config;
        if (tab === 'hardware') saveHardware();
        else
          saveConfig(
            tab,
            { wifi: buildWifi, ethernet: buildEthernet, hub: buildHub, system: buildSystem }[tab],
            form,
          );
      });
    }

    byId('user-change-password').addEventListener('change', updateControls);

    byId('config-backup-download').addEventListener('click', downloadBackup);

    byId('config-backup-file').addEventListener('change', selectBackupFile);

    byId('config-backup-clear').addEventListener('click', () => clearBackupSelection());

    byId('config-backup-restore').addEventListener('click', restoreBackup);

    byId('user-form').addEventListener('input', () => dirty('users'));

    byId('user-form').addEventListener('change', () => dirty('users'));

    byId('hardware-reload').addEventListener('click', loadBoardProfiles);

    for (const model of controllers) {
      byId(`${model.id}-open`).addEventListener('click', () => {
        state.controllersView = model.id;
        renderControllers();
        byId(`${model.id}-page-title`).focus();
        if (model.isMeteo)
          for (const item of model.draft) {
            if (
              item.sensorType === 'onewire' &&
              !state.meteoScans.has(item.portId) &&
              !state.meteoScanQueue.has(item.portId)
            )
              requestMeteoScan(item.portId, item.id);
          }
      });
      byId(`${model.id}-back`).addEventListener('click', () => {
        state.controllersView = '';
        renderControllers();
        byId(`${model.id}-open`).focus();
      });
      byId(`${model.id}-tile-enabled`).addEventListener('click', () => setControllerEnabled(model));
      byId(`${model.id}-enabled`).addEventListener('click', () => setControllerEnabled(model));
      byId(`${model.id}-reload`).addEventListener('click', () => reloadController(model));
      byId(`${model.id}-add`).addEventListener('click', () => {
        if (!model.loaded || state.controllersBusy || model.draft.length >= 16) return;
        const claims = controllerClaims();
        const binding = model.isSecurity
          ? {
              inputId: model.snapshot.ports.inputs.find(
                (id) => !claims.some((claim) => claim.portId === id),
              ),
              sensorType: 'reed',
              entryDelay: false,
            }
          : model.isMeteo
            ? newMeteoBinding(model, claims)
            : {
                relayId: model.snapshot.ports.relays.find(
                  (id) => !claims.some((claim) => claim.portId === id),
                ),
                ...(model.isThermostat
                  ? {
                      meteoId: '',
                      inputId: '',
                      mode: 'heating',
                      setpointC: 22,
                      hysteresisC: 1,
                    }
                  : { inputId: '' }),
              };
        if (!binding || (model.isSecurity ? !binding.inputId : !model.isMeteo && !binding.relayId))
          return;
        const random = new Uint32Array(2);
        window.crypto.getRandomValues(random);
        const id = `${model.data}-${Array.from(random, (n) => n.toString(16).padStart(8, '0')).join('')}`;
        model.draft.push({ id, name: `${model.singular} ${model.draft.length + 1}`, ...binding });
        dirty(model.dirtyKey);
        renderControllers();
        const card = Array.from(byId(`${model.id}-items`).children).find(
          (element) => element.dataset[`${model.data}Id`] === id,
        );
        card.querySelector(`[data-${model.data}-field="name"]`).focus();
        if (model.isMeteo && binding.sensorType === 'onewire') requestMeteoScan(binding.portId, id);
      });
      byId(`${model.id}-form`).addEventListener('submit', (event) => {
        event.preventDefault();
        saveController(model);
      });
    }

    byId('hardware-scan').addEventListener('click', () =>
      hardwareCommand('scan', async (sessionVersion) => {
        const response = await post('/hardware/scan', {});
        if (!state.authenticated || sessionVersion !== state.sessionVersion) return;
        if (response.ok !== true) throw new Error('Контроллер не подтвердил запуск сканирования.');
        hardwareActionNotice(
          'Сканирование поставлено в очередь. Результаты обновятся автоматически.',
        );
      }),
    );

    byId('user-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      await withBusy(event.currentTarget, async () => {
        const sessionVersion = state.sessionVersion;
        const username = value('user-username');
        if (!username) throw new Error('Логин не может быть пустым.');
        const payload = { username, currentPassword: byId('user-current-password').value };
        if (checked('user-change-password')) {
          if (byId('user-new-password').value !== byId('user-confirm-password').value)
            throw new Error('Новые пароли не совпадают.');
          payload.newPassword = byId('user-new-password').value;
        } else if (username === state.config.user.username)
          throw new Error('Измените логин или выберите смену пароля.');
        await post('/user', payload);
        if (!currentSession(sessionVersion)) return;
        showLogin('Учётные данные сохранены. Войдите с новым логином и паролем.', username);
      });
    });

    byId('time-from-browser').addEventListener('click', fillBrowserTime);

    byId('manual-time-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      await withBusy(event.currentTarget, async () => {
        const sessionVersion = state.sessionVersion;
        const unixTime = Math.floor(new Date(byId('manual-time').value).getTime() / 1000);
        if (!Number.isFinite(unixTime)) throw new Error('Укажите корректную дату и время.');
        const response = await post('/time', { unixTime, timezone: state.config.time.timezone });
        if (!currentSession(sessionVersion)) return;
        if (response.revision !== undefined) {
          state.config.revision = response.revision;
          text('footer-revision', `Конфигурация: ${response.revision}`);
        }
        notice(
          'Время контроллера установлено. При включённом NTP оно будет уточнено сервером времени.',
          'success',
        );
        pollStatus();
      });
    });

    byId('reboot').addEventListener('click', async () => {
      if (
        !window.confirm(
          'Перезагрузить ESP32? Соединение временно прервётся. Несохранённые изменения не будут применены.',
        )
      )
        return;
      const button = byId('reboot');
      const sessionVersion = state.sessionVersion;
      button.disabled = true;
      try {
        await requestReboot(
          'Команда перезагрузки принята. Дождитесь запуска контроллера и войдите снова.',
        );
      } catch (error) {
        if (currentSession(sessionVersion)) notice(error.message, 'error');
      } finally {
        button.disabled = false;
      }
    });

    window.addEventListener('beforeunload', (event) => {
      if (!state.authenticated || !state.dirty.size) return;
      event.preventDefault();
      event.returnValue = '';
    });

    document.addEventListener('visibilitychange', () => {
      updateHardwarePolling();
      updateControllersPolling();
      if (!document.hidden) pollStatus();
    });

    text(
      'browser-timezone',
      `Дата и время вводятся в часовом поясе браузера: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`,
    );

    fillBrowserTime();

    for (const heading of document.querySelectorAll('[data-card-icon]'))
      iconHeading(heading, heading.textContent, heading.dataset.cardIcon, heading.tagName === 'H3');

    context.initializeFirmwareUI();
    updateControls();

    const initialSessionVersion = state.sessionVersion;

    api('/config', {}, false)
      .then((config) => {
        if (initialSessionVersion === state.sessionVersion) showApp(config);
      })
      .catch((error) => {
        if (initialSessionVersion === state.sessionVersion)
          showLogin(error.status === 401 ? '' : error.message);
      });
  }

  return {
    mergedConfig,
    withBusy,
    saveConfig,
    requestReboot,
    saveHardware,
    fillBrowserTime,
    start,
  };
}
