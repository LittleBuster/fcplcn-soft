/** @file Bounded virtual ESP32-S3 application OTA; never writes the computer's firmware. */
'use strict';
const crypto = require('node:crypto');
const maximum = 6 * 1024 * 1024;
const chunkSize = 12288;
const fail = (status, error) => ({ status, data: { error } });

/** Validate the actual ESP app layout used by the device, including segment checksum/simple hash. */
function inspectImage(image, complete = true, product = 'FCPLCn') {
  if (
    image.length < 288 ||
    image[0] !== 0xe9 ||
    image[1] < 1 ||
    image[1] > 16 ||
    image.readUInt16LE(12) !== 9 ||
    image.readUInt32LE(28) < 256 ||
    image.readUInt32LE(32) !== 0xabcd5432
  )
    throw new Error('Нужен бинарник приложения FCPLCn для ESP32-S3, не полный образ Flash');
  const name = image.subarray(80, 112).toString('utf8').split('\0')[0];
  const version = image.subarray(48, 80).toString('utf8').split('\0')[0];
  if (name !== product || !version) throw new Error('Этот бинарник создан для другого проекта');
  if (version === '0.0.0' || version.includes('tooling-check'))
    throw new Error('Проверочный образ не содержит рабочей прошивки FCPLCn');
  const imageId = image.subarray(176, 208).toString('hex');
  if (!complete) return { version, imageId };
  let offset = 24;
  let checksum = 0xef;
  for (let index = 0; index < image[1]; index++) {
    if (offset + 8 > image.length) throw new Error('Образ приложения обрезан');
    const length = image.readUInt32LE(offset + 4);
    offset += 8;
    if (length > image.length - offset) throw new Error('Повреждён сегмент приложения');
    for (const byte of image.subarray(offset, offset + length)) checksum ^= byte;
    offset += length;
  }
  const end = offset + (15 - (offset % 16));
  if (end >= image.length || image[end] !== checksum)
    throw new Error('Не совпала контрольная сумма приложения');
  const unsignedSize = end + 1 + (image[23] === 1 ? 32 : 0);
  if (unsignedSize !== image.length || ![0, 1].includes(image[23]))
    throw new Error('Неверный размер бинарника приложения');
  if (
    image[23] === 1 &&
    !crypto
      .createHash('sha256')
      .update(image.subarray(0, end + 1))
      .digest()
      .equals(image.subarray(end + 1))
  )
    throw new Error('Повреждён встроенный SHA-256 приложения');
  return { version, imageId };
}

/** Own a single expiring upload, retaining only bounded RAM in the desktop fixture. */
function createFirmwareMock({
  product = 'FCPLCn',
  version = '0.1.0-base-sim',
  now = Date.now,
  initial,
} = {}) {
  let session;
  let state = 'idle';
  let error = '';
  let partition = initial?.runningPartition === 'ota_1' ? 'ota_1' : 'ota_0';
  if (typeof initial?.version === 'string' && initial.version.length <= 32)
    version = initial.version;
  let imageId =
    typeof initial?.imageId === 'string' && /^[a-f0-9]{64}$/.test(initial.imageId)
      ? initial.imageId
      : crypto
          .createHash('sha256')
          .update(product + version)
          .digest('hex');
  let completed = 0;
  let aborted = 0;
  let nextVersion = '';
  let nextImageId = '';
  const expire = () => {
    if (session && state === 'receiving' && now() - session.updated > 60000) {
      session = undefined;
      state = 'error';
      nextVersion = nextImageId = '';
      error = 'Передача прервана: время ожидания следующего блока истекло';
    }
  };
  const snapshot = () => {
    expire();
    return {
      supported: true,
      maxSize: maximum,
      chunkSize,
      state,
      received: session?.received || 0,
      size: session?.size || 0,
      version,
      imageId,
      runningPartition: partition,
      pendingReboot: state === 'ready',
      targetVersion: nextVersion,
      targetImageId: nextImageId,
      targetPartition: session ? (partition === 'ota_0' ? 'ota_1' : 'ota_0') : '',
      error,
    };
  };
  return {
    snapshot,
    get completed() {
      return completed;
    },
    get aborted() {
      return aborted;
    },
    reboot() {
      session = undefined;
      if (state === 'ready' && nextVersion) {
        version = nextVersion;
        imageId = nextImageId;
        partition = partition === 'ota_0' ? 'ota_1' : 'ota_0';
      }
      nextVersion = nextImageId = '';
      state = 'idle';
      error = '';
    },
    route(method, path, body = {}) {
      expire();
      if (method === 'GET' && path === '/firmware') return { status: 200, data: snapshot() };
      if (method !== 'POST') return fail(404, 'Метод обновления не найден');
      if (state === 'ready') return fail(409, 'Обновление принято, ожидается перезагрузка');
      if (path === '/firmware/begin') {
        if (session || state === 'ready') return fail(409, 'Обновление уже выполняется');
        if (
          Object.keys(body).some((key) => !['size', 'sha256'].includes(key)) ||
          !Number.isSafeInteger(body.size) ||
          body.size < 288 ||
          body.size > maximum ||
          typeof body.sha256 !== 'string' ||
          !/^[a-fA-F0-9]{64}$/.test(body.sha256)
        )
          return fail(400, 'Укажите размер приложения и SHA-256');
        session = {
          id: crypto.randomUUID(),
          size: body.size,
          sha256: body.sha256.toLowerCase(),
          received: 0,
          bytes: Buffer.alloc(body.size),
          updated: now(),
        };
        state = 'receiving';
        nextVersion = nextImageId = '';
        error = '';
        return { status: 200, data: { ok: true, uploadId: session.id, chunkSize } };
      }
      if (!session || body.uploadId !== session.id) return fail(409, 'Сеанс обновления не найден');
      if (path === '/firmware/abort') {
        if (Object.keys(body).some((key) => key !== 'uploadId'))
          return fail(400, 'Неверные поля отмены');
        session = undefined;
        state = 'idle';
        nextVersion = nextImageId = '';
        error = '';
        aborted++;
        return { status: 200, data: { ok: true } };
      }
      if (path === '/firmware/chunk') {
        if (
          Object.keys(body).some((key) => !['uploadId', 'offset', 'data'].includes(key)) ||
          body.offset !== session.received ||
          typeof body.data !== 'string' ||
          !body.data.length ||
          body.data.length > Math.ceil(chunkSize / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)
        )
          return fail(409, 'Блок нарушает порядок передачи или имеет неверный формат');
        const bytes = Buffer.from(body.data, 'base64');
        if (
          !bytes.length ||
          bytes.length > chunkSize ||
          bytes.length > session.size - session.received
        )
          return fail(400, 'Неверный размер блока приложения');
        if (!session.received) {
          try {
            const description = inspectImage(bytes, false, product);
            nextVersion = description.version;
            nextImageId = description.imageId;
          } catch (failure) {
            session = undefined;
            state = 'error';
            nextVersion = nextImageId = '';
            error = failure.message;
            return fail(400, error);
          }
        }
        bytes.copy(session.bytes, session.received);
        session.received += bytes.length;
        session.updated = now();
        return { status: 200, data: { ok: true, received: session.received } };
      }
      if (path === '/firmware/finish') {
        if (Object.keys(body).some((key) => key !== 'uploadId'))
          return fail(400, 'Неверные поля завершения');
        if (session.received !== session.size) return fail(409, 'Приложение передано не полностью');
        try {
          const digest = crypto.createHash('sha256').update(session.bytes).digest('hex');
          if (digest !== session.sha256) throw new Error('SHA-256 загруженного файла не совпал');
          const verified = inspectImage(session.bytes, true, product);
          nextVersion = verified.version;
          nextImageId = verified.imageId;
        } catch (failure) {
          session = undefined;
          state = 'error';
          nextVersion = nextImageId = '';
          error = failure.message;
          return fail(400, error);
        }
        state = 'ready';
        completed++;
        session.bytes = Buffer.alloc(0);
        return {
          status: 200,
          data: {
            ok: true,
            rebootRequired: true,
            version: nextVersion,
            imageId: nextImageId,
            targetPartition: partition === 'ota_0' ? 'ota_1' : 'ota_0',
          },
        };
      }
      return fail(404, 'Метод обновления не найден');
    },
  };
}
module.exports = { createFirmwareMock, inspectImage };
