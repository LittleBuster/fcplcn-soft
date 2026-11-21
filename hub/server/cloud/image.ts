/** @file Host-side ESP32-S3 application validation; the PLC repeats validation before boot selection. */
import { createHash } from 'node:crypto';

export interface FirmwareImage {
  version: string;
  imageId: string;
}

/** Validate the app descriptor, segment checksum, exact length and optional embedded image hash. */
export function inspectFirmwareImage(image: Buffer, productName: string): FirmwareImage {
  const invalid = () =>
    new Error('Нужен бинарник приложения FCPLCn для ESP32-S3; полный образ Flash не подходит');
  if (
    image.length < 288 ||
    image[0] !== 0xe9 ||
    image[1] < 1 ||
    image[1] > 16 ||
    image.readUInt16LE(12) !== 9 ||
    image.readUInt32LE(28) < 256 ||
    image.readUInt32LE(32) !== 0xabcd5432
  )
    throw invalid();
  const field = (offset: number) =>
    image
      .subarray(offset, offset + 32)
      .toString('utf8')
      .split('\0')[0];
  const version = field(48);
  if (
    field(80) !== productName ||
    !version ||
    version === '0.0.0' ||
    version.includes('tooling-check')
  )
    throw invalid();
  let offset = 24,
    checksum = 0xef;
  for (let index = 0; index < image[1]; index++) {
    if (offset + 8 > image.length) throw invalid();
    const length = image.readUInt32LE(offset + 4);
    offset += 8;
    if (length > image.length - offset) throw invalid();
    for (const byte of image.subarray(offset, offset + length)) checksum ^= byte;
    offset += length;
  }
  const end = offset + (15 - (offset % 16));
  if (end >= image.length || image[end] !== checksum || ![0, 1].includes(image[23]))
    throw invalid();
  const size = end + 1 + (image[23] === 1 ? 32 : 0);
  if (size !== image.length) throw invalid();
  if (
    image[23] === 1 &&
    !createHash('sha256')
      .update(image.subarray(0, end + 1))
      .digest()
      .equals(image.subarray(end + 1))
  )
    throw new Error('Не совпала встроенная контрольная сумма приложения');
  return { version, imageId: image.subarray(176, 208).toString('hex') };
}
