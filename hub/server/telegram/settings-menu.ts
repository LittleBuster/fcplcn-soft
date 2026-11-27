/** @file Input and labels for one confirmed change in the Telegram PLC settings menu. */
import { randomUUID } from 'node:crypto';
import { irrigationDays } from '../../shared/irrigation.js';
import type { ControllerKind } from '../../shared/types.js';
import {
  telegramLevelChoiceLabels,
  telegramSettingLabels,
  telegramTankChoiceLabel,
  text,
} from '../../shared/telegram-controller-status.js';
import {
  readTelegramIrrigationTanks,
  updateTelegramControllerSetting,
  updateTelegramModuleEnabled,
  type TelegramControllerSetting,
  type TelegramControllerSettingsActions,
} from './controller-settings.js';

type Row = Record<string, unknown>;
export type SettingsTarget = {
  deviceId: string;
  bootId: string | null;
  revision: number;
  connectionGeneration?: number;
};
type ItemTarget = SettingsTarget & { itemId: string };

export interface SettingEditor {
  tag: string;
  kind: ControllerKind;
  target: ItemTarget;
  field?: SettingField;
  candidate?: TelegramControllerSetting;
  page: number;
  choices?: { id: string; label: string }[];
}

export type SettingsAction =
  | { type: 'module-enabled'; kind: ControllerKind; target: SettingsTarget; enabled: boolean }
  | { type: 'settings'; kind: ControllerKind; target: ItemTarget }
  | { type: 'setting-field'; field: SettingField }
  | { type: 'setting-value'; value: TelegramControllerSetting }
  | { type: 'setting-page'; page: number }
  | { type: 'setting-back' }
  | { type: 'setting-save' };

export type SettingField = TelegramControllerSetting['field'];

const fields: Partial<Record<ControllerKind, readonly SettingField[]>> = {
  thermostats: ['setpointC', 'mode', 'hysteresisC'],
  tanks: ['fillLevel'],
  irrigation: ['days', 'startTime', 'durationMinutes', 'tankId'],
};

export function controllerSettingFields(kind: ControllerKind): readonly SettingField[] {
  return fields[kind] || [];
}

export const settingPrompts: Partial<Record<SettingField, string>> = {
  setpointC: 'Отправьте температуру от −55 до 125 °C. Например, 22,5.',
  hysteresisC: 'Отправьте целое число от 1 до 20 °C.',
  days: 'Отправьте номера дней через пробел. Понедельник — 1, воскресенье — 7. Например, 1 3 5.',
  startTime: 'Отправьте время по часам PLC в формате ЧЧ:ММ. Например, 07:30.',
  durationMinutes: 'Отправьте длительность в минутах от 1 до 1440.',
};

function whole(input: string, min: number, max: number): number | null {
  if (!/^\d{1,4}$/.test(input)) return null;
  const value = Number(input);
  return value >= min && value <= max ? value : null;
}

export function parseTelegramSetting(
  field: SettingField,
  input: string,
): TelegramControllerSetting | null {
  const value = input.trim();
  switch (field) {
    case 'setpointC': {
      if (!/^[\-−]?\d{1,3}(?:[.,]\d)?$/.test(value)) return null;
      const setpoint = Number(value.replace('−', '-').replace(',', '.'));
      return setpoint >= -55 && setpoint <= 125
        ? { kind: 'thermostats', field, value: setpoint }
        : null;
    }
    case 'hysteresisC': {
      const hysteresis = whole(value, 1, 20);
      return hysteresis === null ? null : { kind: 'thermostats', field, value: hysteresis };
    }
    case 'days': {
      if (!/^[1-7](?:\s*[,;]\s*[1-7]|\s+[1-7]){0,6}$/.test(value)) return null;
      const days = value.split(/[\s,;]+/).map(Number);
      return new Set(days).size === days.length ? { kind: 'irrigation', field, value: days } : null;
    }
    case 'startTime':
      return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
        ? { kind: 'irrigation', field, value }
        : null;
    case 'durationMinutes': {
      const duration = whole(value, 1, 1440);
      return duration === null ? null : { kind: 'irrigation', field, value: duration };
    }
    default:
      return null;
  }
}

export function settingValueLabel(setting: TelegramControllerSetting): string {
  switch (setting.field) {
    case 'mode':
      return setting.value === 'heating' ? 'Нагрев' : 'Охлаждение';
    case 'setpointC':
    case 'hysteresisC':
      return setting.value.toLocaleString('ru-RU') + ' °C';
    case 'days':
      return irrigationDays(setting.value);
    case 'durationMinutes':
      return `${setting.value} мин`;
    case 'tankId':
      return setting.value || 'Без бака';
    default:
      return String(setting.value);
  }
}

export async function handleTelegramSettings(
  session: { editor?: SettingEditor },
  action: SettingsAction,
  actions: TelegramControllerSettingsActions,
  permitted: () => boolean,
): Promise<string> {
  if (!permitted()) throw new Error('Запрос устарел или доступ отозван.');
  let notice = '';
  if (action.type === 'module-enabled') {
    await updateTelegramModuleEnabled(
      actions,
      action.target,
      action.kind,
      action.enabled,
      permitted,
    );
    notice = action.enabled ? '✅ Модуль включён.' : '✅ Модуль выключен.';
  } else if (action.type === 'settings') {
    session.editor = { kind: action.kind, target: action.target, tag: randomUUID(), page: 0 };
  } else if (session.editor) {
    const editor = session.editor;
    if (action.type === 'setting-back') {
      if (editor.field) {
        editor.field = undefined;
        editor.candidate = undefined;
        editor.choices = undefined;
        editor.page = 0;
      } else session.editor = undefined;
    } else if (action.type === 'setting-page') {
      editor.page = action.page;
    } else if (
      action.type === 'setting-field' &&
      controllerSettingFields(editor.kind).includes(action.field)
    ) {
      const choices =
        action.field === 'tankId'
          ? await readTelegramIrrigationTanks(actions, editor.target, permitted)
          : undefined;
      editor.field = action.field;
      editor.choices = choices;
      editor.candidate = undefined;
      editor.page = 0;
    } else if (action.type === 'setting-value' && action.value.field === editor.field) {
      editor.candidate = action.value;
    } else if (action.type === 'setting-save' && editor.candidate) {
      const change = editor.candidate;
      // Consume the confirmation before awaiting a potentially ambiguous MQTT result.
      session.editor = undefined;
      await updateTelegramControllerSetting(actions, editor.target, change, permitted);
      notice = '✅ PLC подтвердил сохранение настройки.';
    }
  }
  return notice;
}

export function renderTelegramSettings(
  editor: SettingEditor,
  item: Row,
  lines: string[],
  keyboard: string[][],
  add: (label: string, action: SettingsAction) => string,
  tag: (...parts: string[]) => string,
  pageSize: number,
): void {
  const field = editor.field;
  if (!field) {
    lines.push('', '⚙️ Настройки', 'Выберите параметр.');
    for (const option of controllerSettingFields(editor.kind))
      keyboard.push([add(telegramSettingLabels[option], { type: 'setting-field', field: option })]);
    keyboard.push([add('↩️ Закрыть настройки', { type: 'setting-back' })]);
    return;
  }
  lines.push('', telegramSettingLabels[field]);
  const confirm = editor.candidate;
  if (confirm) {
    const selected =
      confirm.field === 'tankId'
        ? editor.choices?.find((choice) => choice.id === confirm.value)?.label
        : undefined;
    const label = selected || settingValueLabel(confirm);
    lines.push(`Сохранить новое значение «${label}»?`);
    keyboard.push([
      add('💾 Сохранить · ' + tag(editor.tag, field, JSON.stringify(confirm.value)), {
        type: 'setting-save',
      }),
    ]);
  } else if (settingPrompts[field]) {
    lines.push(settingPrompts[field]!);
  } else if (field === 'mode') {
    keyboard.push([
      add('🔥 Нагрев', {
        type: 'setting-value',
        value: { kind: 'thermostats', field, value: 'heating' },
      }),
      add('❄️ Охлаждение', {
        type: 'setting-value',
        value: { kind: 'thermostats', field, value: 'cooling' },
      }),
    ]);
  } else if (field === 'fillLevel') {
    const levels = Array.isArray(item.levelInputs) ? item.levelInputs.length : 0;
    const labels = telegramLevelChoiceLabels(levels);
    if (!labels.length) lines.push('Нет настроенных датчиков уровня.');
    labels.forEach((label, index) => {
      keyboard.push([
        add(label, { type: 'setting-value', value: { kind: 'tanks', field, value: index + 1 } }),
      ]);
    });
  } else if (field === 'tankId') {
    const choices = editor.choices || [];
    for (const choice of choices.slice(editor.page * pageSize, (editor.page + 1) * pageSize)) {
      keyboard.push([
        add(
          telegramTankChoiceLabel(choice.id, text(choice.label).slice(0, 72)) +
            ' · ' +
            tag(choice.id),
          {
            type: 'setting-value',
            value: { kind: 'irrigation', field, value: choice.id },
          },
        ),
      ]);
    }
    const pages = [];
    if (editor.page > 0)
      pages.push(add('◀️ Предыдущие', { type: 'setting-page', page: editor.page - 1 }));
    if ((editor.page + 1) * pageSize < choices.length)
      pages.push(add('Следующие ▶️', { type: 'setting-page', page: editor.page + 1 }));
    if (pages.length) keyboard.push(pages);
  }
  keyboard.push([add('↩️ К параметрам', { type: 'setting-back' })]);
}
