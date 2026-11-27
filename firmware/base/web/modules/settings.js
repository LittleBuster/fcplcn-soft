/**
 * @file settings.js
 * @brief Device, network and account forms, navigation and status.
 */
export function createSettingsUI(context) {
  const { productName, state } = context;
  const api = (...args) => context.api(...args);
  const byId = (...args) => context.byId(...args);
  const checked = (...args) => context.checked(...args);
  const clearBackupSelection = (...args) => context.clearBackupSelection(...args);
  const currentSession = (...args) => context.currentSession(...args);
  const errorMessage = (...args) => context.errorMessage(...args);
  const fieldError = (...args) => context.fieldError(...args);
  const hardwareActionNotice = (...args) => context.hardwareActionNotice(...args);
  const notice = (...args) => context.notice(...args);
  const onOff = (...args) => context.onOff(...args);
  const renderBackupPreview = (...args) => context.renderBackupPreview(...args);
  const resetControllersSession = (...args) => context.resetControllersSession(...args);
  const text = (...args) => context.text(...args);
  const updateControllersPolling = (...args) => context.updateControllersPolling(...args);
  const updateHardwarePolling = (...args) => context.updateHardwarePolling(...args);
  const value = (...args) => context.value(...args);

  function dirty(tab, isDirty = true) {
    if (isDirty) state.formEdits.set(tab, (state.formEdits.get(tab) || 0) + 1);
    if (isDirty) state.dirty.add(tab);
    else state.dirty.delete(tab);
    for (const element of document.querySelectorAll('[data-dirty]')) {
      const key = element.dataset.dirty;
      const isMarked =
        key === 'network'
          ? state.dirty.has('wifi') || state.dirty.has('ethernet')
          : key === 'system'
            ? state.dirty.has('system') || state.dirty.has('hardware')
            : key === 'controllers'
              ? state.dirty.has('controllers') ||
                state.dirty.has('lights') ||
                state.dirty.has('meteo') ||
                state.dirty.has('thermostats') ||
                state.dirty.has('tanks') ||
                state.dirty.has('irrigation') ||
                state.dirty.has('security')
              : state.dirty.has(key);
      element.hidden = !isMarked;
    }
    document.querySelectorAll(`[data-save-state="${tab}"]`).forEach((el) => {
      el.textContent = isDirty ? 'Есть несохранённые изменения' : '';
    });
  }

  function updateHardwareControls() {
    const available =
      state.profilesLoaded &&
      state.profiles.some((profile) => profile.boardId === value('hardware-board-id'));
    byId('hardware-board-id').disabled =
      !state.profilesLoaded || state.profilesLoading || state.hardwareSaving;
    byId('hardware-save').disabled = !available || state.profilesLoading || state.hardwareSaving;
    byId('hardware-reload').disabled = state.profilesLoading || state.hardwareSaving;
  }

  function hardwareProfilesError(message) {
    byId('hardware-profiles-error').textContent = message;
    byId('hardware-profiles-error').hidden = !message;
    byId('hardware-reload').hidden = !message;
  }

  function fillHardwareOptions(preserveSelection = false) {
    const select = byId('hardware-board-id');
    const selected =
      preserveSelection && state.dirty.has('hardware')
        ? select.value
        : state.config?.hardware?.boardId;
    select.replaceChildren();
    if (state.profilesLoaded) {
      for (const profile of state.profiles)
        select.add(new Option(profile.boardName, profile.boardId));
      select.value = selected || '';
    } else {
      select.add(new Option(state.profilesLoading ? 'Загрузка моделей…' : 'Модели недоступны', ''));
    }
    updateHardwareControls();
  }

  function fillHardwarePending() {
    const hardware = state.hardwareStatus;
    const element = byId('hardware-reboot-notice');
    element.hidden = !hardware?.rebootRequired;
    element.textContent = hardware?.rebootRequired
      ? `Сохранён профиль ${hardware.configuredBoardId || state.config?.hardware?.boardId || '—'}. Для его применения требуется перезагрузка.`
      : '';
  }

  async function loadBoardProfiles() {
    const sessionVersion = state.sessionVersion;
    state.profilesLoading = true;
    hardwareProfilesError('');
    fillHardwareOptions(true);
    try {
      const profiles = await api('/board-profiles');
      if (!state.authenticated || sessionVersion !== state.sessionVersion) return;
      if (
        !Array.isArray(profiles) ||
        !profiles.length ||
        !profiles.every(
          (profile) =>
            typeof profile.boardId === 'string' &&
            profile.boardId &&
            typeof profile.boardName === 'string' &&
            profile.boardName,
        )
      ) {
        throw new Error('Список моделей отсутствует или имеет неверный формат.');
      }
      state.profiles = profiles;
      state.profilesLoaded = true;
      fillHardwareOptions(true);
    } catch (error) {
      if (state.authenticated && sessionVersion === state.sessionVersion) {
        state.profilesLoaded = false;
        hardwareProfilesError(`Не удалось загрузить модели плат: ${error.message}`);
        fillHardwareOptions(true);
      }
    } finally {
      if (sessionVersion === state.sessionVersion) {
        state.profilesLoading = false;
        if (!state.profilesLoaded) fillHardwareOptions(true);
        else updateHardwareControls();
        renderBackupPreview();
      }
    }
  }

  function updateControls() {
    byId('ap-enabled').disabled = !checked('wifi-enabled');
    byId('sta-enabled').disabled = !checked('wifi-enabled');
    byId('ap-fields').disabled = !checked('wifi-enabled') || !checked('ap-enabled');
    byId('sta-fields').disabled = !checked('wifi-enabled') || !checked('sta-enabled');
    byId('ap-password').disabled = checked('ap-open');
    byId('sta-password').disabled = checked('sta-open');
    byId('ethernet-dhcp').disabled = !checked('ethernet-enabled');
    byId('ethernet-static-fields').disabled =
      !checked('ethernet-enabled') || checked('ethernet-dhcp');
    byId('ntp-fields').disabled = !checked('time-ntp-enabled');
    byId('linux-password').disabled = checked('linux-clear-password');
    byId('new-password-fields').disabled = !checked('user-change-password');
    updateHardwareControls();
  }

  function setValue(id, v, fallback = '') {
    byId(id).value = v === undefined || v === null ? fallback : v;
  }

  function setChecked(id, v) {
    byId(id).checked = Boolean(v);
  }

  /** @brief Refresh only explicitly saved/reloaded forms, preserving drafts in every other form. */
  function fillConfig(config, tabs = ['wifi', 'ethernet', 'hub', 'system', 'hardware', 'users']) {
    state.config = config;
    if (tabs.includes('wifi')) {
      const wifi = config.wifi || {};
      const ap = wifi.ap || {};
      const sta = wifi.sta || {};
      setChecked('wifi-enabled', wifi.enabled);
      setChecked('ap-enabled', ap.enabled);
      setValue('ap-ssid', ap.ssid);
      setValue('ap-channel', ap.channel, 1);
      setValue('ap-ip', ap.ip, '192.168.4.1');
      setValue('ap-netmask', ap.netmask, '255.255.255.0');
      setValue('ap-password', '');
      setChecked('ap-open', !ap.passwordSet);
      text(
        'ap-password-state',
        ap.passwordSet ? 'Пароль точки доступа задан.' : 'Точка доступа работает без пароля.',
      );
      setChecked('sta-enabled', sta.enabled);
      setValue('sta-ssid', sta.ssid);
      setValue('sta-password', '');
      setChecked('sta-open', !sta.passwordSet);
      text(
        'sta-password-state',
        sta.passwordSet ? 'Пароль подключения сохранён.' : 'Пароль подключения не задан.',
      );
      dirty('wifi', false);
    }
    if (tabs.includes('ethernet')) {
      const ethernet = config.ethernet || {};
      setChecked('ethernet-enabled', ethernet.enabled);
      setChecked('ethernet-dhcp', ethernet.dhcp);
      for (const field of ['ip', 'netmask', 'gateway', 'dns'])
        setValue(`ethernet-${field}`, ethernet[field]);
      dirty('ethernet', false);
    }
    if (tabs.includes('hub')) {
      const linux = config.linux || {};
      setValue('linux-host', linux.host);
      setValue('linux-port', linux.port, 1883);
      setValue('linux-username', linux.username);
      setValue('linux-password', '');
      setChecked('linux-clear-password', false);
      text(
        'linux-password-state',
        linux.passwordSet ? 'Пароль MQTT сохранён.' : 'Пароль MQTT не задан.',
      );
      dirty('hub', false);
    }
    if (tabs.includes('system')) {
      const time = config.time || {};
      setValue('device-name', config.device?.name, productName);
      setValue('time-timezone', time.timezone, 'UTC-7');
      setChecked('time-ntp-enabled', time.ntpEnabled);
      setValue('time-ntp-server', time.ntpServer);
      dirty('system', false);
    }
    if (tabs.includes('users')) {
      setValue('user-username', config.user && config.user.username, 'admin');
      setValue('user-current-password', '');
      setValue('user-new-password', '');
      setValue('user-confirm-password', '');
      setChecked('user-change-password', false);
      dirty('users', false);
    }
    if (tabs.includes('hardware')) {
      fillHardwareOptions();
      dirty('hardware', false);
    }
    text('footer-revision', `Конфигурация: ${config.revision ?? '—'}`);
    renderBackupPreview();
    updateControls();
  }

  function formatUptime(seconds) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(n / 86400);
    const hours = Math.floor((n % 86400) / 3600);
    const minutes = Math.floor((n % 3600) / 60);
    return `${days ? `${days} д ` : ''}${hours} ч ${minutes} мин`;
  }

  function networkBadge(id, label, kind) {
    const element = byId(id);
    element.textContent = label;
    element.className = `badge state-${kind}`;
  }

  function fillNetworkSummary(wifi, ethernet) {
    const ap = wifi.ap || {};
    const sta = wifi.sta || {};
    if (typeof wifi.enabled !== 'boolean') {
      networkBadge('network-wifi-status', 'Нет данных', 'unknown');
      text('network-wifi-summary', 'Точка доступа и подключение к роутеру');
      text('network-wifi-details', 'Состояние WiFi недоступно');
    } else {
      const error = wifi.enabled ? errorMessage(sta.error) : '';
      networkBadge(
        'network-wifi-status',
        !wifi.enabled
          ? 'Выключен'
          : error
            ? 'Ошибка STA'
            : ap.enabled || sta.connected
              ? 'Работает'
              : 'Нет подключения',
        !wifi.enabled ? 'off' : error ? 'error' : ap.enabled || sta.connected ? 'on' : 'unknown',
      );
      const connections = [];
      if (wifi.enabled && ap.enabled) connections.push(`AP: ${ap.ssid || '—'}`);
      if (wifi.enabled && sta.enabled) connections.push(`STA: ${sta.ssid || '—'}`);
      text(
        'network-wifi-summary',
        connections.join(' · ') ||
          (wifi.enabled ? 'Нет активных подключений' : 'Радиомодуль выключен'),
      );
      const addresses = [];
      if (wifi.enabled && ap.enabled && ap.ip) addresses.push(`AP ${ap.ip}`);
      if (wifi.enabled && sta.connected && sta.ip) addresses.push(`STA ${sta.ip}`);
      text(
        'network-wifi-details',
        error ||
          addresses.join(' · ') ||
          (wifi.enabled ? 'IP-адрес пока не получен' : 'Включается в настройках WiFi'),
      );
    }
    if (typeof ethernet.enabled !== 'boolean') {
      networkBadge('network-ethernet-status', 'Нет данных', 'unknown');
      text('network-ethernet-summary', 'Проводное подключение W5500');
      text('network-ethernet-details', 'Состояние Ethernet недоступно');
    } else {
      const error = ethernet.enabled ? errorMessage(ethernet.error) : '';
      networkBadge(
        'network-ethernet-status',
        !ethernet.enabled
          ? 'Выключен'
          : error
            ? 'Ошибка'
            : ethernet.linkUp
              ? 'Подключён'
              : 'Нет соединения',
        !ethernet.enabled ? 'off' : error ? 'error' : ethernet.linkUp ? 'on' : 'unknown',
      );
      text(
        'network-ethernet-summary',
        !ethernet.enabled
          ? 'Проводной интерфейс выключен'
          : ethernet.dhcp
            ? 'Автоматический адрес · DHCP'
            : 'Статический IP-адрес',
      );
      text(
        'network-ethernet-details',
        error ||
          (!ethernet.enabled
            ? 'Включается в настройках Ethernet'
            : ethernet.linkUp
              ? ethernet.ip || 'IP-адрес пока не получен'
              : 'Кабель не подключён или нет Link'),
      );
    }
  }

  function fillStatus(status) {
    const wifi = status.wifi || {};
    const ap = wifi.ap || {};
    const sta = wifi.sta || {};
    const ethernet = status.ethernet || {};
    const clock = status.time || {};
    const linux = status.linux || {};
    const device = status.device || {};
    const system = status.system || {};
    const hardware = status.hardware || {};
    fillNetworkSummary(wifi, ethernet);
    text('status-wifi-enabled', onOff(wifi.enabled));
    text('status-ap-enabled', ap.enabled ? 'Работает' : 'Выключена');
    text('status-ap-ssid', ap.enabled ? ap.ssid : '—');
    text('status-ap-ip', ap.enabled ? ap.ip : '—');
    text('status-ap-clients', ap.enabled ? ap.clients : '—');
    text(
      'status-sta-connected',
      !sta.enabled ? 'Выключено' : sta.connected ? 'Подключено' : 'Нет подключения',
    );
    text('status-sta-ssid', sta.ssid);
    text('status-sta-ip', sta.connected ? sta.ip : '—');
    text(
      'status-sta-rssi',
      sta.connected && Number.isFinite(sta.rssi) && sta.rssi > -127 ? `${sta.rssi} dBm` : '—',
    );
    fieldError('status-sta-error', sta.error, 'Подключение STA');
    text('status-ethernet-enabled', onOff(ethernet.enabled));
    text(
      'status-ethernet-link',
      !ethernet.enabled ? 'Интерфейс выключен' : ethernet.linkUp ? 'Подключён' : 'Нет соединения',
    );
    text('status-ethernet-dhcp', ethernet.dhcp ? 'DHCP' : 'Статический адрес');
    for (const field of ['ip', 'netmask', 'gateway', 'dns'])
      text(`status-ethernet-${field}`, ethernet.enabled && ethernet.linkUp ? ethernet[field] : '—');
    text('status-ethernet-mac', ethernet.mac);
    fieldError('status-ethernet-error', ethernet.error, 'Ethernet');
    text('status-board-name', hardware.boardName);
    text('status-board-id', hardware.boardId);
    if (
      !Number.isFinite(status.revision) ||
      !state.config ||
      status.revision >= state.config.revision
    ) {
      state.hardwareStatus = hardware;
      fillHardwarePending();
    }
    text('status-firmware', status.firmwareVersion);
    text('status-uptime', formatUptime(status.uptimeSec));
    text(
      'status-chip-temperature',
      Number.isFinite(system.chipTemperatureC)
        ? `${system.chipTemperatureC.toFixed(1)} °C`
        : 'Недоступна',
    );
    text(
      'status-time',
      clock.valid
        ? clock.localTime || `${new Date(clock.unixTime * 1000).toLocaleString('ru-RU')} (браузер)`
        : 'Время не установлено',
    );
    text('status-time-valid', clock.valid ? 'Установлено' : 'Неизвестно');
    text(
      'status-time-source',
      { manual: 'Установлено вручную', ntp: 'NTP', rtc: 'Внешний RTC', unset: 'Не установлен' }[
        clock.source
      ] || clock.source,
    );
    text('status-external-rtc', clock.externalRtcPresent ? 'Подключён' : 'Не используется');
    text(
      'status-linux',
      !linux.host
        ? 'Не настроен'
        : `${linux.host}:${linux.port || 1883} · ${linux.connected ? 'MQTT подключён' : 'Нет MQTT-соединения'}`,
    );
    fieldError('status-linux-error', linux.error, 'MQTT');
    text(
      'device-summary',
      [device.name, device.id, device.mac].filter(Boolean).join(' · ') || 'Локальное управление',
    );
  }

  async function pollStatus() {
    if (!state.authenticated || document.hidden || state.polling) return;
    const sessionVersion = state.sessionVersion;
    state.polling = true;
    try {
      const status = await api('/status');
      if (!currentSession(sessionVersion)) return;
      fillStatus(status);
      text('connection-badge', 'На связи');
      byId('connection-badge').classList.remove('offline');
      if (state.noticeKey === 'connection')
        notice('Связь с контроллером восстановлена.', 'success');
      if (state.networkChangedAt && Date.now() - state.networkChangedAt > 3000) {
        state.networkChangedAt = 0;
        if (state.noticeKey === 'network')
          notice('Сетевые настройки применены. Соединение с контроллером доступно.', 'success');
      }
    } catch (error) {
      if (currentSession(sessionVersion)) {
        text('connection-badge', 'Нет связи');
        byId('connection-badge').classList.add('offline');
        for (const name of ['wifi', 'ethernet']) {
          networkBadge(`network-${name}-status`, 'Нет данных', 'unknown');
          text(`network-${name}-details`, 'Нет связи с контроллером');
        }
        if (!state.noticeKey || state.noticeKey === 'connection')
          notice(error.message, 'warning', 'connection');
      }
    } finally {
      state.polling = false;
    }
  }

  /** @brief End the UI session, invalidate pending replies, and clear drafts and imported secrets. */
  function showLogin(message = '', username) {
    state.authenticated = false;
    state.config = null;
    state.dirty.clear();
    state.formEdits.clear();
    state.sessionVersion++;
    context.resetFirmwareUI();
    clearBackupSelection();
    state.profiles = [];
    state.profilesLoaded = false;
    state.profilesLoading = false;
    state.hardwareSaving = false;
    state.hardwareStatus = null;
    state.ioSnapshot = null;
    state.ioActionBusy = false;
    state.ioActionId = '';
    state.ioRelayErrors.clear();
    state.ioUncertainRelays.clear();
    hardwareActionNotice('');
    byId('hardware-error').hidden = true;
    updateHardwarePolling();
    resetControllersSession();
    if (state.timer) window.clearInterval(state.timer);
    state.timer = null;
    byId('login-view').hidden = false;
    byId('app-view').hidden = true;
    byId('header-actions').hidden = true;
    byId('login-error').hidden = true;
    document.querySelectorAll('input[type="password"]').forEach((el) => {
      el.value = '';
    });
    if (username) setValue('login-username', username);
    text('footer-revision', '');
    notice(message);
  }

  function showApp(config) {
    state.sessionVersion++;
    state.authenticated = true;
    state.profiles = [];
    state.profilesLoaded = false;
    state.hardwareStatus = null;
    byId('login-view').hidden = true;
    byId('app-view').hidden = false;
    byId('header-actions').hidden = false;
    byId('login-error').hidden = true;
    activateNetworkView('list');
    const irrigationLink = /^#irrigation(?:\/([a-zA-Z0-9_-]{1,32}))?$/.exec(window.location.hash);
    state.initialIrrigationRule = irrigationLink?.[1] || '';
    if (irrigationLink) state.controllersView = 'irrigation';
    activateTab(irrigationLink ? 'controllers' : 'network');
    fillConfig(config);
    notice('');
    fillHardwarePending();
    loadBoardProfiles();
    pollStatus();
    if (state.timer) window.clearInterval(state.timer);
    state.timer = window.setInterval(pollStatus, 5000);
    updateHardwarePolling();
    updateControllersPolling();
  }

  function activateTab(tabName, focus = false) {
    state.activeTab = tabName;
    for (const button of document.querySelectorAll('[data-tab]')) {
      const active = button.dataset.tab === tabName;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    }
    for (const panel of document.querySelectorAll('[data-panel]'))
      panel.hidden = panel.dataset.panel !== tabName;
    updateHardwarePolling();
    updateControllersPolling();
    if (tabName === 'system') context.loadFirmwareStatus();
  }

  function activateNetworkView(view, focus = false) {
    const previous = state.networkView;
    state.networkView = view;
    byId('network-list-view').hidden = view !== 'list';
    for (const page of document.querySelectorAll('[data-network-view]'))
      page.hidden = page.dataset.networkView !== view;
    if (focus) byId(view === 'list' ? `network-open-${previous}` : `network-${view}-title`).focus();
  }

  function validateSsid(ssid, required, label) {
    if (required && !ssid) throw new Error(`Укажите SSID: ${label}.`);
    if (new TextEncoder().encode(ssid).length > 32)
      throw new Error(`SSID «${label}» должен занимать не более 32 байт.`);
  }

  function validatePassword(password, isOpen, passwordSet, enabled, label) {
    if (!enabled || isOpen) return;
    if (!password && passwordSet) return;
    const bytes = new TextEncoder().encode(password).length;
    if (bytes < 8 || bytes > 63)
      throw new Error(`Пароль «${label}» должен содержать от 8 до 63 байт.`);
  }

  function ipv4(v, label, allowEmpty = false) {
    if (allowEmpty && !v) return;
    const parts = v.split('.');
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255))
      throw new Error(`Некорректный IPv4-адрес: ${label}.`);
  }

  function buildWifi() {
    const enabled = checked('wifi-enabled');
    const ap = {
      enabled: checked('ap-enabled'),
      ssid: value('ap-ssid'),
      channel: Number(value('ap-channel')),
      ip: value('ap-ip'),
      netmask: value('ap-netmask'),
    };
    const sta = { enabled: checked('sta-enabled'), ssid: value('sta-ssid') };
    if (enabled && !ap.enabled && !sta.enabled)
      throw new Error('Для включённого WiFi выберите точку доступа AP или подключение STA.');
    validateSsid(ap.ssid, enabled && ap.enabled, 'точка доступа');
    validateSsid(sta.ssid, enabled && sta.enabled, 'роутер');
    validatePassword(
      byId('ap-password').value,
      checked('ap-open'),
      state.config.wifi.ap.passwordSet,
      enabled && ap.enabled,
      'точка доступа',
    );
    validatePassword(
      byId('sta-password').value,
      checked('sta-open'),
      state.config.wifi.sta.passwordSet,
      enabled && sta.enabled,
      'роутер',
    );
    if (enabled && ap.enabled) {
      if (!Number.isInteger(ap.channel) || ap.channel < 1 || ap.channel > 11)
        throw new Error('Канал точки доступа должен быть от 1 до 11.');
      ipv4(ap.ip, 'точка доступа');
      ipv4(ap.netmask, 'маска точки доступа');
    }
    if (checked('ap-open')) ap.password = '';
    else if (byId('ap-password').value) ap.password = byId('ap-password').value;
    if (checked('sta-open')) sta.password = '';
    else if (byId('sta-password').value) sta.password = byId('sta-password').value;
    return { wifi: { enabled, ap, sta } };
  }

  function buildEthernet() {
    const ethernet = { enabled: checked('ethernet-enabled'), dhcp: checked('ethernet-dhcp') };
    for (const field of ['ip', 'netmask', 'gateway', 'dns'])
      ethernet[field] = value(`ethernet-${field}`);
    if (ethernet.enabled && !ethernet.dhcp) {
      ipv4(ethernet.ip, 'Ethernet');
      ipv4(ethernet.netmask, 'маска Ethernet');
      ipv4(ethernet.gateway, 'шлюз Ethernet', true);
      ipv4(ethernet.dns, 'DNS Ethernet', true);
    }
    return { ethernet };
  }

  function buildHub() {
    const linux = {
      host: value('linux-host'),
      port: Number(value('linux-port')),
      username: value('linux-username'),
    };
    if (!Number.isInteger(linux.port) || linux.port < 1 || linux.port > 65535)
      throw new Error('Порт MQTT должен быть от 1 до 65535.');
    if (checked('linux-clear-password')) linux.password = '';
    else if (byId('linux-password').value) linux.password = byId('linux-password').value;
    return { linux };
  }

  function buildSystem() {
    const name = value('device-name');
    if (!name || new TextEncoder().encode(name).length > 64)
      throw new Error('Укажите название устройства: не более 64 байт UTF-8.');
    const time = {
      timezone: value('time-timezone'),
      ntpEnabled: checked('time-ntp-enabled'),
      ntpServer: value('time-ntp-server'),
    };
    if (!time.timezone) throw new Error('Укажите часовой пояс.');
    if (time.ntpEnabled && !time.ntpServer)
      throw new Error('Укажите NTP-сервер или отключите NTP.');
    return { device: { name }, time };
  }

  return {
    dirty,
    updateHardwareControls,
    hardwareProfilesError,
    fillHardwareOptions,
    fillHardwarePending,
    loadBoardProfiles,
    updateControls,
    setValue,
    setChecked,
    fillConfig,
    formatUptime,
    networkBadge,
    fillNetworkSummary,
    fillStatus,
    pollStatus,
    showLogin,
    showApp,
    activateTab,
    activateNetworkView,
    validateSsid,
    validatePassword,
    ipv4,
    buildWifi,
    buildEthernet,
    buildHub,
    buildSystem,
  };
}
