/** @file Atomic hub-owned names, room labels and card illustrations; PLC settings stay on the device. */
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DeviceLabel } from '../shared/types.js';
import { isDeviceIllustrationId } from '../shared/device-art.js';

export function validLabel(value: unknown): value is string {
  return (
    typeof value === 'string' && Buffer.byteLength(value) <= 96 && !/[\x00-\x1f\x7f]/.test(value)
  );
}

/** Validate before either reading or replacing a durable file; keep version-1 labels compatible. */
function deviceLabels(value: unknown): Record<string, DeviceLabel> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Неизвестный формат имён устройств');
  const result: Record<string, DeviceLabel> = Object.create(null);
  const entries = Object.entries(value);
  if (entries.length > 256) throw new Error('Слишком много устройств в файле имён');
  for (const [id, entry] of entries) {
    const label = entry as DeviceLabel;
    if (
      !/^fcplcn-[a-zA-Z0-9_-]{1,96}$/.test(id) ||
      !label ||
      !validLabel(label.name) ||
      !validLabel(label.room) ||
      (Object.hasOwn(label, 'illustrationId') && !isDeviceIllustrationId(label.illustrationId))
    )
      throw new Error('Повреждены сохранённые имена или изображения устройств');
    result[id] = {
      name: label.name,
      room: label.room,
      ...(label.illustrationId === undefined ? {} : { illustrationId: label.illustrationId }),
    };
  }
  return result;
}

export class LabelStore {
  readonly path: string;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'devices.json');
  }

  load(): Record<string, DeviceLabel> {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    if (Buffer.byteLength(text) > 128 * 1024)
      throw new Error('Файл имён устройств слишком большой');
    const value = JSON.parse(text) as { version?: unknown; devices?: unknown };
    if (
      value.version !== 1 ||
      !value.devices ||
      typeof value.devices !== 'object' ||
      Array.isArray(value.devices)
    )
      throw new Error('Неизвестный формат имён устройств');
    return deviceLabels(value.devices);
  }

  save(labels: Record<string, DeviceLabel>): void {
    const document = JSON.stringify({ version: 1, devices: deviceLabels(labels) }, null, 2) + '\n';
    if (Buffer.byteLength(document) > 128 * 1024)
      throw new Error('Файл имён устройств слишком большой');
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, document, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* The last confirmed document remains intact. */
      }
      throw error;
    }
  }
}
