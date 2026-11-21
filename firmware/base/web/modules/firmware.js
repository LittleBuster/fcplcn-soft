/**
 * @file firmware.js
 * @brief Bounded, sequential application-image upload over local HTTP or the hub's MQTT service.
 */

/** @brief Compute SHA-256 without requiring HTTPS-only Web Crypto on a local PLC address. */
export function firmwareSha256(bytes) {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  const block = new Uint8Array(64);
  const rotate = (value, shift) => (value >>> shift) | (value << (32 - shift));
  const paddedSize = Math.ceil((bytes.length + 9) / 64) * 64;
  for (let offset = 0; offset < paddedSize; offset += 64) {
    block.fill(0);
    block.set(bytes.subarray(offset, Math.min(offset + 64, bytes.length)));
    if (offset <= bytes.length && bytes.length < offset + 64) block[bytes.length - offset] = 0x80;
    if (offset + 64 === paddedSize) {
      const view = new DataView(block.buffer);
      view.setUint32(56, Math.floor(bytes.length / 0x20000000));
      view.setUint32(60, (bytes.length * 8) >>> 0);
    }
    const view = new DataView(block.buffer);
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(index * 4);
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15],
        b = words[index - 2];
      words[index] =
        (words[index - 16] +
          (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) +
          words[index - 7] +
          (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>>
        0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const first =
        (h +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          constants[index] +
          words[index]) >>>
        0;
      const second =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + first) >>> 0, c, b, a, (first + second) >>> 0];
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => {
      hash[index] = (hash[index] + value) >>> 0;
    });
  }
  return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
}

/** @brief Read the standard ESP application descriptor and reject merged, foreign or wrong-chip images. */
export function inspectFirmware(bytes, productName = 'FCPLCn') {
  if (bytes.length < 288 || bytes[0] !== 0xe9)
    throw new Error(
      'Нужен бинарник приложения FCPLCn.bin. Объединённый образ для USB не подходит.',
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(12, true) !== 9)
    throw new Error(
      'Этот файл предназначен для другого микроконтроллера. Нужна прошивка ESP32-S3.',
    );
  if (view.getUint32(32, true) !== 0xabcd5432)
    throw new Error('Не найдено приложение FCPLCn. Выберите FCPLCn.bin, а не полный образ памяти.');
  const string = (offset, length) => {
    const field = bytes.subarray(offset, offset + length);
    const end = field.indexOf(0);
    return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end));
  };
  if (string(80, 32) !== productName)
    throw new Error('В файле другое приложение. Нужен бинарник FCPLCn.');
  return {
    version: string(48, 32) || 'без номера',
    imageId: Array.from(bytes.subarray(176, 208), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join(''),
  };
}

/** @brief Own firmware file selection and transfer independently of polled settings and form drafts. */
export function createFirmwareUI(context) {
  const { state } = context;
  const byId = (...args) => context.byId(...args);
  const api = (...args) => context.api(...args);
  const post = (...args) => context.post(...args);
  let status = null,
    file = null,
    busy = false,
    cancelRequested = false,
    activating = false;
  let uploadId = '',
    generation = 0,
    uncertain = false,
    accepted = false,
    expectedBoot = null;

  /** @brief Replace one scoped status message instead of adding repeated notices. */
  function message(text, kind = '') {
    const element = byId('firmware-notice');
    element.textContent = text;
    element.className = `notice ${kind}`.trim();
    element.hidden = !text;
  }

  /** @brief Keep transfer controls stable across unrelated status polling. */
  function render() {
    byId('firmware-file').disabled = busy || accepted || !status?.supported;
    byId('firmware-upload').disabled =
      busy ||
      accepted ||
      uncertain ||
      !file ||
      !status?.supported ||
      Boolean(status.pendingReboot) ||
      status.state === 'receiving';
    byId('firmware-upload').setAttribute('aria-busy', String(busy));
    byId('firmware-refresh').disabled = busy;
    byId('firmware-cancel').hidden = !busy && !(uploadId && uncertain);
    byId('firmware-cancel').disabled = cancelRequested || accepted || activating;
    byId('firmware-current').textContent = status?.version || '—';
    byId('firmware-file-details').textContent = file
      ? `${file.name} · ${(file.size / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КБ`
      : 'Файл ещё не выбран';
    byId('firmware-limit').textContent = status?.supported
      ? `Бинарник приложения .bin, до ${(status.maxSize / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ.`
      : 'Проверка поддержки обновления…';
  }

  /** @brief Read authoritative transfer state; a lost write reply is never retried automatically. */
  async function loadFirmwareStatus() {
    if (!state.authenticated || busy || state.activeTab !== 'system') return;
    const token = generation;
    try {
      const result = await api('/firmware');
      if (token !== generation) return;
      if (
        result.supported !== true ||
        !Number.isSafeInteger(result.maxSize) ||
        result.maxSize < 288
      )
        throw new Error('Контроллер не сообщил параметры обновления.');
      status = result;
      if (
        (accepted || uncertain) &&
        expectedBoot &&
        !result.pendingReboot &&
        result.state === 'idle'
      ) {
        const installed =
          result.imageId === expectedBoot.imageId &&
          result.runningPartition === expectedBoot.targetPartition;
        accepted = false;
        uncertain = false;
        uploadId = '';
        expectedBoot = null;
        file = null;
        byId('firmware-file').value = '';
        message(
          installed
            ? `Новая прошивка запущена. Версия ${result.version || '—'}.`
            : 'После перезапуска запущен другой образ. Обновление не подтверждено; проверьте текущую версию перед новой попыткой.',
          installed ? 'success' : 'error',
        );
      }
      if (!accepted && !uncertain) {
        if (result.pendingReboot)
          message('Прошивка принята. Ожидается перезагрузка контроллера.', 'warning');
        else if (result.state === 'receiving')
          message(
            'На контроллер уже передаётся прошивка. Дождитесь окончания или истечения времени передачи.',
            'warning',
          );
      }
      if (uncertain) {
        if (result.pendingReboot || result.state === 'ready') {
          accepted = true;
          uncertain = false;
          uploadId = '';
          if (
            /^[a-f0-9]{64}$/i.test(result.targetImageId || '') &&
            typeof result.targetPartition === 'string'
          )
            expectedBoot = {
              imageId: result.targetImageId,
              targetPartition: result.targetPartition,
            };
          message(
            'Контроллер подтвердил готовую прошивку. После перезагрузки проверьте её версию.',
            'success',
          );
        } else if (result.state !== 'receiving') {
          uncertain = false;
          uploadId = '';
          message('Новая прошивка не принята. Можно начать загрузку заново.', 'warning');
        } else
          message(
            uploadId
              ? 'Передача не завершена. Можно отменить её и начать заново.'
              : 'Передача не завершена. Подождите 60 секунд и проверьте статус снова.',
            'warning',
          );
      }
      render();
    } catch (error) {
      if (token !== generation) return;
      if ([404, 405, 426].includes(error.status)) {
        status = { supported: false };
        byId('firmware-limit').textContent =
          'Текущая прошивка ещё не поддерживает обновление через веб. Первое обновление установите через USB.';
      }
      message(
        error.status === 404
          ? 'Для обновления из веб-интерфейса сначала установите новую базовую прошивку через USB.'
          : error.message,
        'warning',
      );
      render();
      if (!status?.supported)
        byId('firmware-limit').textContent =
          'Первую прошивку с поддержкой веб-обновления нужно установить через USB.';
    }
  }

  /** @brief Clear large file references and invalidate pending work when the authenticated session ends. */
  function resetFirmwareUI() {
    generation++;
    file = status = null;
    busy = cancelRequested = uncertain = accepted = activating = false;
    uploadId = '';
    expectedBoot = null;
    byId('firmware-file').value = '';
    byId('firmware-progress-wrap').hidden = true;
    message('');
    render();
  }

  /** @brief Abort only the selected upload; never retry an uncertain activation request. */
  async function abortUpload() {
    if (!uploadId) return;
    const response = await post('/firmware/abort', { uploadId });
    if (response.ok !== true) throw new Error('Контроллер не подтвердил отмену передачи.');
    uploadId = '';
    uncertain = false;
    expectedBoot = null;
    if (status) status.state = 'idle';
    message('Передача отменена. Текущая прошивка продолжает работать.', 'warning');
  }

  /** @brief Send one bounded chunk at a time and activate only after the PLC verifies the entire image. */
  async function uploadFirmware() {
    if (busy || !file || !status?.supported || uncertain || accepted) return;
    if (
      !window.confirm(
        'Обновить прошивку контроллера? После проверки файла он перезагрузится. Сохранённые настройки останутся, несохранённые правки не применятся.',
      )
    )
      return;
    const token = ++generation;
    const selected = file;
    busy = true;
    cancelRequested = false;
    activating = false;
    expectedBoot = null;
    byId('firmware-progress-wrap').hidden = false;
    byId('firmware-progress').value = 0;
    byId('firmware-progress-label').textContent = 'Проверка файла…';
    message('');
    render();
    try {
      if (selected.size > status.maxSize)
        throw new Error('Файл больше доступного раздела прошивки.');
      if (!/\.bin$/i.test(selected.name))
        throw new Error('Выберите файл прошивки с расширением .bin.');
      const bytes = new Uint8Array(await selected.arrayBuffer());
      if (token !== generation) return;
      const image = inspectFirmware(bytes, context.productName);
      const sha256 = firmwareSha256(bytes);
      if (cancelRequested) {
        message('Передача отменена до отправки файла.', 'warning');
        return;
      }
      const started = await post('/firmware/begin', { size: bytes.length, sha256 });
      if (token !== generation) return;
      if (started.ok !== true || typeof started.uploadId !== 'string' || !started.uploadId)
        throw new Error('Контроллер не подтвердил начало передачи.');
      uploadId = started.uploadId;
      const chunkSize = Math.min(
        12288,
        Number.isSafeInteger(started.chunkSize) && started.chunkSize > 0
          ? started.chunkSize
          : 12288,
      );
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        if (cancelRequested) {
          await abortUpload();
          return;
        }
        const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        let binary = '';
        for (const byte of chunk) binary += String.fromCharCode(byte);
        const reply = await post('/firmware/chunk', { uploadId, offset, data: btoa(binary) });
        if (token !== generation) return;
        const received = offset + chunk.length;
        if (reply.ok !== true || reply.received !== received)
          throw new Error('Контроллер не подтвердил принятый блок. Передача остановлена.');
        const percent = Math.floor((received * 100) / bytes.length);
        byId('firmware-progress').value = percent;
        byId('firmware-progress-label').textContent =
          `Передано ${percent}% · ${(received / 1024).toFixed(0)} из ${(bytes.length / 1024).toFixed(0)} КБ`;
      }
      if (cancelRequested) {
        await abortUpload();
        return;
      }
      byId('firmware-progress-label').textContent = 'Проверка прошивки на контроллере…';
      const received = await api('/firmware');
      if (token !== generation) return;
      if (
        received.received !== bytes.length ||
        received.targetImageId !== image.imageId ||
        typeof received.targetPartition !== 'string' ||
        !received.targetPartition
      )
        throw new Error('Контроллер не подтвердил целиком переданное приложение.');
      expectedBoot = { imageId: received.targetImageId, targetPartition: received.targetPartition };
      if (cancelRequested) {
        await abortUpload();
        return;
      }
      activating = true;
      render();
      const finished = await post('/firmware/finish', { uploadId });
      if (token !== generation) return;
      if (finished.ok !== true || finished.rebootRequired !== true)
        throw new Error('Контроллер не подтвердил принятие прошивки.');
      accepted = true;
      expectedBoot =
        /^[a-f0-9]{64}$/i.test(finished.imageId || '') &&
        typeof finished.targetPartition === 'string'
          ? { imageId: finished.imageId, targetPartition: finished.targetPartition }
          : null;
      uploadId = '';
      byId('firmware-progress-label').textContent = 'Файл проверен и принят';
      message(
        `Прошивка ${finished.version || image.version} принята. Контроллер перезагружается. После подключения проверьте версию в системе.`,
        'success',
      );
    } catch (error) {
      if (token !== generation) return;
      uncertain = Boolean(uploadId) || error.status === 0;
      message(
        `${error.message}${uncertain ? (activating ? ' Результат обновления неизвестен. Проверьте статус после восстановления связи; повторная команда не отправляется.' : ' Передача остановлена. Проверьте статус или отмените её перед новой попыткой.') : ''}`,
        'error',
      );
      byId('firmware-progress-label').textContent = activating
        ? 'Ожидается подтверждение контроллера'
        : 'Передача остановлена';
    } finally {
      if (token === generation) {
        busy = false;
        cancelRequested = false;
        activating = false;
        render();
      }
    }
  }

  /** @brief Bind explicit upload, cancellation and manual recovery controls once. */
  function initializeFirmwareUI() {
    byId('firmware-file').addEventListener('change', () => {
      file = byId('firmware-file').files[0] || null;
      byId('firmware-progress-wrap').hidden = true;
      message('');
      render();
    });
    byId('firmware-upload').addEventListener('click', uploadFirmware);
    byId('firmware-refresh').addEventListener('click', loadFirmwareStatus);
    byId('firmware-cancel').addEventListener('click', async () => {
      if (busy) {
        cancelRequested = true;
        message('Отмена после текущего блока…', 'warning');
        render();
        return;
      }
      busy = true;
      render();
      try {
        await abortUpload();
      } catch (error) {
        message(error.message, 'error');
      } finally {
        busy = false;
        render();
      }
    });
    window.addEventListener('beforeunload', (event) => {
      if (!busy) return;
      event.preventDefault();
      event.returnValue = '';
    });
    render();
  }

  return { initializeFirmwareUI, loadFirmwareStatus, resetFirmwareUI };
}
