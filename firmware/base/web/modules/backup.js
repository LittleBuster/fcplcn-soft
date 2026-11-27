/**
 * @file backup.js
 * @brief Portable configuration preview, download and restore.
 */
export function createBackupUI(context) {
  const { backupSizeLimit, controllers, productName, state } = context;
  const api = (...args) => context.api(...args);
  const byId = (...args) => context.byId(...args);
  const post = (...args) => context.post(...args);
  const showLogin = (...args) => context.showLogin(...args);
  const text = (...args) => context.text(...args);
  const thermostatParametersValid = (...args) => context.thermostatParametersValid(...args);
  const validIbuttonAddress = (...args) => context.validIbuttonAddress(...args);
  const validMeteoAddress = (...args) => context.validMeteoAddress(...args);

  function backupMessage(id, message, kind = '') {
    const element = byId(id);
    element.textContent = message;
    element.hidden = !message;
    if (id === 'config-backup-notice') element.className = `notice ${kind}`.trim();
  }

  function updateBackupControls() {
    const busy = Boolean(state.backupBusy);
    byId('config-backup-download').disabled = busy;
    byId('config-backup-file').disabled = busy;
    byId('config-backup-clear').disabled = busy;
    byId('config-backup-restore').disabled = busy || !state.backupDocument;
    byId('config-backup-download').setAttribute(
      'aria-busy',
      String(state.backupBusy === 'download'),
    );
    byId('config-backup-restore').setAttribute('aria-busy', String(state.backupBusy === 'restore'));
  }

  function renderBackupPreview() {
    const document = state.backupDocument;
    byId('config-backup-preview').hidden = !document;
    if (document) {
      text('config-backup-filename', state.backupFilename);
      text('config-backup-device', document.config.device.name);
      const profileForId = (id) =>
        state.profilesLoaded
          ? state.profiles.find((profile) => profile.boardId === id) ||
            state.profiles.find(
              (profile) => Array.isArray(profile.legacyIds) && profile.legacyIds.includes(id),
            )
          : undefined;
      const fileProfile = profileForId(document.boardId);
      text(
        'config-backup-profile',
        fileProfile ? `${fileProfile.boardName} · ${fileProfile.boardId}` : document.boardId,
      );
      const sockets = document.controllers.sockets;
      text(
        'config-backup-sockets',
        `${sockets.items.length} · модуль ${sockets.enabled ? 'включён' : 'выключен'}`,
      );
      const lights = document.version === 1 ? null : document.controllers.lights;
      text(
        'config-backup-lights',
        lights
          ? `${lights.items.length} · модуль ${lights.enabled ? 'включён' : 'выключен'}`
          : '0 · модуль выключен (файл версии 1)',
      );
      const meteo = document.version < 3 ? null : document.controllers.meteo;
      text(
        'config-backup-meteo',
        meteo
          ? `${meteo.items.length} · модуль ${meteo.enabled ? 'включён' : 'выключен'}`
          : `0 · модуль выключен (файл версии ${document.version})`,
      );
      const thermostats = document.version < 4 ? null : document.controllers.thermostats;
      text(
        'config-backup-thermostats',
        thermostats
          ? `${thermostats.items.length} · модуль ${thermostats.enabled ? 'включён' : 'выключен'}`
          : `0 · модуль выключен (файл версии ${document.version})`,
      );
      backupMessage(
        'config-backup-thermostat-legacy',
        document.version <= 6 && thermostats?.items.length
          ? `${document.version === 4 ? 'В файле версии 4 нет индивидуальных выключателей: термостаты будут включены без входов кнопок. Общий выключатель модуля сохранится. ' : ''}Минимальные интервалы ON/OFF термостатов фиксированы: 60 секунд. Прежние настройки времени из файла не применяются.`
          : '',
      );
      const irrigation = document.version >= 10 ? document.controllers.irrigation : null;
      text(
        'config-backup-irrigation',
        irrigation
          ? `${irrigation.items.length} · модуль ${irrigation.enabled ? 'включён' : 'выключен'}`
          : '0 · полив выключен (старая версия)',
      );
      const tanks = document.version >= 9 ? document.controllers.tanks : null;
      text(
        'config-backup-tanks',
        tanks
          ? `${tanks.items.length} · модуль ${tanks.enabled ? 'включён' : 'выключен'}`
          : '0 · баки выключены (старая версия)',
      );
      const security = document.version >= 8 ? document.controllers.security : null;
      text(
        'config-backup-security',
        security
          ? `${security.items.length} датчиков · ${security.keys.length} ключей · ${security.armed ? 'под охраной' : 'снята'}`
          : '0 · охрана выключена (старая версия)',
      );
      const currentProfile = state.config?.hardware?.boardId;
      const currentBoardId = profileForId(currentProfile)?.boardId || currentProfile;
      const fileBoardId = fileProfile?.boardId || document.boardId;
      backupMessage(
        'config-backup-profile-warning',
        state.profilesLoaded && currentBoardId && fileBoardId !== currentBoardId
          ? `Профиль файла отличается от профиля контроллера (${currentBoardId}). Контроллер отклонит загрузку; автоматической смены модели платы не будет.`
          : '',
      );
    }
    updateBackupControls();
  }

  function clearBackupSelection(clearFile = true) {
    state.backupReadVersion++;
    state.backupDocument = null;
    state.backupFilename = '';
    state.backupBusy = '';
    if (clearFile) byId('config-backup-file').value = '';
    backupMessage('config-backup-error', '');
    backupMessage('config-backup-notice', '');
    for (const id of [
      'config-backup-irrigation',
      'config-backup-filename',
      'config-backup-device',
      'config-backup-profile',
      'config-backup-sockets',
      'config-backup-lights',
      'config-backup-meteo',
      'config-backup-thermostats',
      'config-backup-security',
      'config-backup-tanks',
    ])
      text(id, '');
    backupMessage('config-backup-profile-warning', '');
    backupMessage('config-backup-thermostat-legacy', '');
    renderBackupPreview();
  }

  /**
   * @brief Validate enough structure for a safe preview; the PLC validates the full restore.
   * @note The import document is not normalized or modified before sending it to the PLC.
   */
  function validateBackupDocument(document) {
    const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (
      !object(document) ||
      document.format !== 'fcplcn-config' ||
      ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes(document.version) ||
      document.product !== productName
    ) {
      throw new Error(`Нужен файл конфигурации ${productName} формата fcplcn-config, версия 1–10.`);
    }
    const config = document.config;
    if (
      typeof document.boardId !== 'string' ||
      !document.boardId ||
      !object(config) ||
      !['device', 'hardware', 'wifi', 'ethernet', 'linux', 'time'].every((key) =>
        object(config[key]),
      ) ||
      !object(config.wifi.ap) ||
      !object(config.wifi.sta) ||
      config.hardware.boardId !== document.boardId ||
      typeof config.device.name !== 'string' ||
      !config.device.name.trim() ||
      new TextEncoder().encode(config.device.name).length > 64
    ) {
      throw new Error(
        'В файле отсутствуют обязательные настройки устройства или аппаратного профиля.',
      );
    }
    const user = document.user;
    if (
      !object(user) ||
      typeof user.username !== 'string' ||
      !user.username ||
      user.algorithm !== 'PBKDF2-HMAC-SHA256' ||
      !Number.isSafeInteger(user.iterations) ||
      user.iterations < 1 ||
      typeof user.salt !== 'string' ||
      !/^[0-9a-f]+$/i.test(user.salt) ||
      typeof user.hash !== 'string' ||
      !/^[0-9a-f]+$/i.test(user.hash)
    ) {
      throw new Error(
        'В файле отсутствует веб-учётная запись или указан неподдерживаемый формат её защиты.',
      );
    }
    for (const model of controllers) {
      if (
        (model.id === 'lights' && document.version === 1) ||
        (model.isMeteo && document.version < 3) ||
        (model.isThermostat && document.version < 4) ||
        (model.isSecurity && document.version < 8) ||
        (model.isTank && document.version < 9) ||
        (model.isIrrigation && document.version < 10)
      )
        continue;
      const module = document.controllers?.[model.id];
      if (
        !object(module) ||
        typeof module.enabled !== 'boolean' ||
        !Array.isArray(module.items) ||
        module.items.length > 16 ||
        (model.isSecurity &&
          (!Array.isArray(module.keys) ||
            module.keys.length > 16 ||
            module.keys.some(
              (key) =>
                !object(key) || typeof key.name !== 'string' || !validIbuttonAddress(key.address),
            ) ||
            typeof module.armed !== 'boolean' ||
            typeof module.triggered !== 'boolean' ||
            !['entryDelaySeconds', 'exitDelaySeconds'].every(
              (key) => Number.isInteger(module[key]) && module[key] >= 0 && module[key] <= 300,
            ))) ||
        module.items.some(
          (item) =>
            !object(item) ||
            (model.isSecurity
              ? !['id', 'name', 'inputId', 'sensorType'].every(
                  (key) => typeof item[key] === 'string',
                ) ||
                !['reed', 'motion'].includes(item.sensorType) ||
                typeof item.entryDelay !== 'boolean'
              : model.isIrrigation
                ? !context.irrigationParametersValid(item) ||
                  typeof item.enabled !== 'boolean' ||
                  typeof item.id !== 'string' ||
                  typeof item.name !== 'string'
                : model.isTank
                  ? !['id', 'name', 'pumpRelayId', 'valveRelayId'].every(
                      (key) => typeof item[key] === 'string',
                    ) ||
                    !Array.isArray(item.levelInputs) ||
                    item.levelInputs.length < 1 ||
                    item.levelInputs.length > 3 ||
                    item.levelInputs.some((id) => typeof id !== 'string') ||
                    !Number.isInteger(item.fillLevel) ||
                    item.fillLevel < 1 ||
                    item.fillLevel > item.levelInputs.length ||
                    typeof item.enabled !== 'boolean'
                  : model.isMeteo
                    ? !['id', 'name', 'portId', 'sensorType', 'address'].every(
                        (key) => typeof item[key] === 'string',
                      ) ||
                      !['dht22', 'onewire'].includes(item.sensorType) ||
                      (item.sensorType === 'dht22'
                        ? item.address !== ''
                        : !validMeteoAddress(item.address))
                    : model.isThermostat
                      ? !['id', 'name', 'meteoId', 'relayId', 'mode'].every(
                          (key) => typeof item[key] === 'string',
                        ) ||
                        !thermostatParametersValid(item) ||
                        (document.version === 6 &&
                          !['minOnSeconds', 'minOffSeconds'].every(
                            (key) =>
                              Number.isInteger(item[key]) && item[key] >= 0 && item[key] <= 86400,
                          )) ||
                        (document.version >= 5 &&
                          (typeof item.inputId !== 'string' || typeof item.enabled !== 'boolean'))
                      : !['id', 'name', 'relayId', 'inputId'].every(
                          (key) => typeof item[key] === 'string',
                        ) || typeof item.state !== 'boolean'),
        )
      ) {
        throw new Error(`В файле отсутствуют корректные настройки контроллера «${model.title}».`);
      }
    }
    return document;
  }

  /** @brief Download saved settings directly, without copying exported secrets into UI config state. */
  async function downloadBackup() {
    if (!state.authenticated || state.backupBusy) return;
    const sessionVersion = state.sessionVersion;
    state.backupBusy = 'download';
    updateBackupControls();
    backupMessage('config-backup-error', '');
    backupMessage('config-backup-notice', 'Подготовка сохранённой конфигурации…');
    try {
      const document = await api('/config/backup');
      if (!state.authenticated || sessionVersion !== state.sessionVersion) return;
      validateBackupDocument(document);
      const safeName =
        document.config.device.name
          .normalize('NFKC')
          .replace(/[^\p{L}\p{N}._-]+/gu, '-')
          .replace(/^[.-]+|[.-]+$/g, '') || productName;
      const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      try {
        link.href = url;
        link.download = `${productName}-${safeName}-config.json`;
        window.document.body.append(link);
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      backupMessage(
        'config-backup-notice',
        'Файл конфигурации подготовлен для сохранения.',
        'success',
      );
    } catch (error) {
      if (state.authenticated && sessionVersion === state.sessionVersion) {
        backupMessage('config-backup-notice', '');
        backupMessage('config-backup-error', error.message);
      }
    } finally {
      if (sessionVersion === state.sessionVersion) {
        state.backupBusy = '';
        updateBackupControls();
      }
    }
  }

  /** @brief Read a bounded JSON file; session/read tokens reject superseded file reads. */
  async function selectBackupFile() {
    if (!state.authenticated || state.backupBusy) return;
    const file = byId('config-backup-file').files[0];
    clearBackupSelection(false);
    if (!file) return;
    const sessionVersion = state.sessionVersion;
    const readVersion = state.backupReadVersion;
    state.backupBusy = 'read';
    updateBackupControls();
    try {
      if (file.size > backupSizeLimit)
        throw new Error(
          'Размер файла превышает 32 КБ. Выберите файл конфигурации меньшего размера.',
        );
      let document;
      try {
        document = JSON.parse(await file.text());
      } catch (_) {
        throw new Error('Не удалось прочитать JSON. Выберите корректный файл конфигурации.');
      }
      if (
        !state.authenticated ||
        sessionVersion !== state.sessionVersion ||
        readVersion !== state.backupReadVersion
      )
        return;
      state.backupDocument = validateBackupDocument(document);
      state.backupFilename = file.name;
      renderBackupPreview();
    } catch (error) {
      if (
        state.authenticated &&
        sessionVersion === state.sessionVersion &&
        readVersion === state.backupReadVersion
      )
        backupMessage('config-backup-error', error.message);
    } finally {
      if (sessionVersion === state.sessionVersion && readVersion === state.backupReadVersion) {
        state.backupBusy = '';
        updateBackupControls();
      }
    }
  }

  /** @brief Apply the selected backup with CAS; successful restore schedules its own PLC reboot. */
  async function restoreBackup() {
    if (!state.authenticated || state.backupBusy || !state.backupDocument) return;
    const document = state.backupDocument;
    const sessionVersion = state.sessionVersion;
    state.backupBusy = 'restore';
    updateBackupControls();
    backupMessage('config-backup-error', '');
    backupMessage(
      'config-backup-notice',
      'Конфигурация применяется. Дождитесь ответа контроллера…',
    );
    try {
      const response = await post('/config/restore', {
        baseRevision: state.config.revision,
        document,
      });
      if (!state.authenticated || sessionVersion !== state.sessionVersion) return;
      if (response.ok !== true || response.rebootRequired !== true)
        throw new Error('Контроллер не подтвердил применение конфигурации и перезагрузку.');
      showLogin(
        'Конфигурация применена. Контроллер перезагружается. Дождитесь запуска и войдите с логином и паролем из файла. Если адрес или сеть изменились, подключитесь заново.',
        document.user.username,
      );
    } catch (error) {
      if (state.authenticated && sessionVersion === state.sessionVersion) {
        backupMessage('config-backup-notice', '');
        backupMessage(
          'config-backup-error',
          error.status === 409
            ? `${error.message} Проверьте аппаратный профиль файла и актуальность настроек контроллера.`
            : error.message,
        );
      }
    } finally {
      if (sessionVersion === state.sessionVersion) {
        state.backupBusy = '';
        updateBackupControls();
      }
    }
  }

  return {
    backupMessage,
    updateBackupControls,
    renderBackupPreview,
    clearBackupSelection,
    validateBackupDocument,
    downloadBackup,
    selectBackupFile,
    restoreBackup,
  };
}
