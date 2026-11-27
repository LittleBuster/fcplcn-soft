/** @file Предпросмотр обычной клавиатуры Telegram и операций на виртуальных кнопках. */
import { useState } from 'preact/hooks';
import { irrigationDays } from '../../../../shared/irrigation.js';
import {
  controllerItemDetails,
  controllerItemStatusLines,
  controllerModuleDetails,
  controllerModuleSummaryLines,
  itemName,
  telegramLevelChoiceLabels,
  telegramSettingLabels,
  telegramTankChoiceLabel,
} from '../../../../shared/telegram-controller-status.js';
import { formatTelegramMessage } from '../../../../shared/telegram-format.js';
import type { ControllerKind, HubSnapshot } from '../../../../shared/types.js';
import { Icon } from '../../icons';
import { deviceName, kinds, rows, text, titles } from '../../model';

const emojis: Record<ControllerKind, string> = {
  sockets: '🔌',
  lights: '💡',
  meteo: '🌤',
  thermostats: '🌡',
  security: '🛡',
  tanks: '🛢',
  irrigation: '💧',
};

type Field = keyof typeof telegramSettingLabels;
const settings: Partial<Record<ControllerKind, Field[]>> = {
  thermostats: ['setpointC', 'mode', 'hysteresisC'],
  tanks: ['fillLevel'],
  irrigation: ['days', 'startTime', 'durationMinutes', 'tankId'],
};
const inputExamples = {
  setpointC: ['Введите температуру в °C.', '22,5'],
  hysteresisC: ['Введите гистерезис в °C.', '2'],
  days: ['Отправьте номера дней через пробел. Понедельник — 1, воскресенье — 7.', '1 3'],
  startTime: ['Введите местное время PLC в формате ЧЧ:ММ.', '07:30'],
  durationMinutes: ['Введите длительность полива в минутах.', '15'],
} as const;
const pageSize = 12;
type PreviewPage =
  | { view: 'home' | 'scenes' | 'scheduled' }
  | { view: 'scene'; sceneId: string }
  | { view: 'device'; deviceId: string }
  | {
      view: 'module' | 'module-settings';
      deviceId: string;
      kind: ControllerKind;
      details?: boolean;
    }
  | { view: 'item' | 'settings'; deviceId: string; kind: ControllerKind; itemId: string }
  | { view: 'field'; deviceId: string; kind: ControllerKind; itemId: string; field: Field };

interface PreviewKey {
  id: string;
  label: string;
  select?: () => void;
}

export function MenuPreview({ snapshot }: { snapshot: HubSnapshot | null }) {
  const [page, setPage] = useState<PreviewPage>({ view: 'home' });
  const [pageIndex, setPageIndex] = useState(0);
  const [selection, setSelection] = useState('');
  const [notice, setNotice] = useState('');
  const navigate = (next: PreviewPage) => {
    setNotice('');
    setSelection('');
    setPageIndex(0);
    setPage(next);
  };

  const devices = snapshot?.devices || [];
  const scenes = snapshot?.scenes.definitions || [];
  const device =
    'deviceId' in page ? devices.find((entry) => entry.id === page.deviceId) : undefined;
  const kind = 'kind' in page ? page.kind : undefined;
  const module = kind && device?.controllers[kind];
  const items = rows(module ? module.data.items : undefined);
  const item = 'itemId' in page ? items.find((row) => row.id === page.itemId) : undefined;
  const freshDevice = snapshot?.broker.connected === true && device?.status === 'online';
  const moduleEnabled = Boolean(module && module.data.enabled === true);
  const fresh = freshDevice && Boolean(module && module.fresh);
  let title = device ? `🏡 ${deviceName(device)}` : '🏠 Мой дом';
  let subtitle = kind
    ? `${emojis[kind]} ${titles[kind]}`
    : device
      ? 'Контроллеры'
      : 'Сценарии и устройства';
  let back: PreviewKey | undefined;
  const lines: string[] = [];
  const controllerHeadings: number[] = [];
  const addControllerBlock = (block: readonly string[]) => {
    if (lines.length) lines.push('');
    controllerHeadings.push(lines.length);
    lines.push(...block);
  };
  const keyboard: PreviewKey[][] = [];
  const key = (id: string, label: string, select?: () => void): PreviewKey => ({
    id,
    label,
    select,
  });
  const link = (id: string, label: string, target: PreviewPage) =>
    key(id, label, () => navigate(target));
  const demoAction = (id: string, label: string) =>
    key(id, label, () => setNotice(`Пример действия · ${label}`));
  const split = (keys: PreviewKey[], columns = 2) => {
    for (let offset = 0; offset < keys.length; offset += columns)
      keyboard.push(keys.slice(offset, offset + columns));
  };
  const paginate = <T,>(
    entries: T[],
    render: (entry: T, index: number) => PreviewKey,
    columns = 2,
  ) => {
    const last = Math.max(0, Math.ceil(entries.length / pageSize) - 1);
    const current = Math.min(pageIndex, last);
    if (last) lines.push(`Страница ${current + 1}/${last + 1}`);
    split(entries.slice(current * pageSize, (current + 1) * pageSize).map(render), columns);
    const navigation: PreviewKey[] = [];
    if (current > 0)
      navigation.push(key('previous', '◀️ Предыдущая', () => setPageIndex(current - 1)));
    if (current < last)
      navigation.push(key('next', 'Следующая ▶️', () => setPageIndex(current + 1)));
    if (navigation.length) keyboard.push(navigation);
  };

  if (page.view === 'scene' || page.view === 'scenes' || page.view === 'scheduled') {
    const scheduled = page.view !== 'scenes';
    title = scheduled ? '🗓 Сценарии по расписанию' : '🎬 Мгновенные сценарии';
    subtitle = '';
    back = link('back', '⬅️ Устройства', { view: 'home' });
    if (page.view === 'scene') {
      const scene = scenes.find((entry) => entry.id === page.sceneId);
      back = link('back', '⬅️ По расписанию', { view: 'scheduled' });
      if (scene) {
        subtitle = scene.name;
        const schedule = scene.schedule;
        if (schedule?.enabled) {
          lines.push(
            `${irrigationDays(schedule.days)} · ${schedule.time} · ${schedule.timeZone}`,
            schedule.paused ? 'Расписание приостановлено' : 'Расписание включено',
          );
          keyboard.push([
            demoAction(
              'schedule',
              schedule.paused ? '▶️ Включить расписание' : '⏸ Приостановить расписание',
            ),
          ]);
        }
        keyboard.push([demoAction('run', '▶️ Запустить сейчас')]);
      }
    } else {
      const visible = scenes.filter((scene) => Boolean(scene.schedule?.enabled) === scheduled);
      paginate(visible, (scene) =>
        scheduled
          ? link(scene.id, '🗓 ' + scene.name, { view: 'scene', sceneId: scene.id })
          : demoAction(scene.id, '🎬 ' + scene.name),
      );
      if (!visible.length) lines.push('Сценариев пока нет.');
    }
  } else if (!device) {
    keyboard.push([
      demoAction('home', '🏠 Я дома'),
      demoAction('away', '🚪 Ушел'),
      demoAction('prepare', '🚗 Готовлюсь'),
    ]);
    paginate(
      devices,
      (entry) => link(entry.id, `🏡 ${deviceName(entry)}`, { view: 'device', deviceId: entry.id }),
      1,
    );
    if (!devices.length) lines.push('PLC пока не обнаружены.');
    keyboard.push([
      link('scenes', '🎬 Сценарии', { view: 'scenes' }),
      link('scheduled', '🗓 По расписанию', { view: 'scheduled' }),
    ]);
  } else if (!kind || !module) {
    lines.push(freshDevice ? '🟢 На связи' : '⚫ Нет свежей связи с PLC');
    const available = kinds.filter((entry) => device.controllers[entry]);
    split(
      available.map((entry) => {
        const current = device.controllers[entry]!;
        addControllerBlock([
          `${emojis[entry]} ${titles[entry]}`,
          ...controllerModuleSummaryLines(entry, current, freshDevice && current.fresh),
        ]);
        return link(entry, `${emojis[entry]} ${titles[entry]}`, {
          view: 'module',
          deviceId: device.id,
          kind: entry,
        });
      }),
    );
    if (!available.length) lines.push('Ожидаем данные контроллеров.');
    back = link('back', '⬅️ Устройства', { view: 'home' });
  } else {
    back = link('back', '⬅️ Контроллеры', { view: 'device', deviceId: device.id });
    const binary = kind === 'sockets' || kind === 'lights';
    const details =
      page.view === 'module' || page.view === 'module-settings'
        ? Boolean(page.details)
        : binary && page.view === 'item';
    const modulePage = { view: 'module' as const, deviceId: device.id, kind, details };
    const canConfigure = fresh && device.management?.supported;
    if (page.view === 'module-settings') {
      lines.push('⚙️ Настройки модуля', ...controllerModuleDetails(kind, module, fresh));
      if (canConfigure) {
        keyboard.push([
          demoAction('module-switch', moduleEnabled ? '⚙️ Выключить модуль' : '⚙️ Включить модуль'),
        ]);
      }
      back = link('back', '⬅️ Каналы', modulePage);
    } else if (!item || page.view === 'module') {
      lines.push(...controllerModuleDetails(kind, module, fresh));
      if (fresh && moduleEnabled && kind === 'security') {
        keyboard.push([
          demoAction('arm', '🛡 Поставить на охрану'),
          demoAction('disarm', '🔓 Снять охрану'),
        ]);
      }
      if (fresh && moduleEnabled && binary && items.length && !details) {
        keyboard.push([demoAction('all-on', '🟢 Вкл все'), demoAction('all-off', '⚪ Выкл все')]);
      }
      paginate(items, (row, index) => {
        const id = text(row.id, String(index));
        addControllerBlock(controllerItemStatusLines(kind, row, fresh, moduleEnabled));
        const canSwitch =
          fresh && moduleEnabled && row.available === true && typeof row.actual === 'boolean';
        const icon = binary ? (!canSwitch ? '⚫' : row.actual ? '🟢' : '⚪') : emojis[kind];
        const label = `${icon} ${itemName(row)}`;
        if (binary && canSwitch && !details) return demoAction(id, label);
        return link(id, label, {
          ...modulePage,
          view: 'item',
          itemId: id,
        });
      });
      if (!items.length) lines.push('Каналы не добавлены.');
      if (canConfigure) {
        keyboard.push([
          link('module-settings', '⚙️ Настройки', { ...modulePage, view: 'module-settings' }),
        ]);
      }
      if (binary) {
        keyboard.push([
          link('view-mode', details ? '⚡ Быстрое управление' : 'ℹ️ Подробности каналов', {
            ...modulePage,
            details: !details,
          }),
        ]);
      }
    } else {
      const itemPage = { ...modulePage, view: 'item' as const, itemId: text(item.id) };
      const settingsPage = { ...itemPage, view: 'settings' as const };
      back = link('back', '⬅️ Каналы', modulePage);
      if (page.view === 'settings') {
        subtitle = itemName(item);
        lines.push('⚙️ Настройки канала');
        split(
          (settings[kind] || []).map((field) =>
            link(field, telegramSettingLabels[field], { ...settingsPage, view: 'field', field }),
          ),
        );
        back = link('back', '⬅️ Канал', itemPage);
      } else if (page.view === 'field') {
        subtitle = itemName(item);
        const field = page.field;
        lines.push(telegramSettingLabels[field]);
        back = link('back', '⬅️ Настройки', settingsPage);
        let options: { label: string; value: string }[];
        if (field === 'tankId') {
          options = [
            { label: telegramTankChoiceLabel('', 'Без бака'), value: 'Без бака' },
            ...devices.flatMap((source) =>
              rows(source.controllers.tanks?.data.items).map((tank) => {
                const value =
                  source.id === device.id
                    ? itemName(tank)
                    : `${itemName(tank)} · ${deviceName(source)}`;
                return { label: telegramTankChoiceLabel(text(tank.id), value), value };
              }),
            ),
          ];
        } else if (field === 'mode') {
          options = [
            { label: '🔥 Нагрев', value: 'Нагрев' },
            { label: '❄️ Охлаждение', value: 'Охлаждение' },
          ];
        } else if (field === 'fillLevel') {
          const count = Array.isArray(item.levelInputs) ? item.levelInputs.length : 0;
          options = telegramLevelChoiceLabels(count).map((label, index) => ({
            label,
            value: String(index + 1),
          }));
        } else {
          const [hint, value] = inputExamples[field];
          lines.push(hint);
          options = [{ label: `⌨️ ${value}`, value }];
        }
        paginate(options, ({ label, value }, index) =>
          key(String(index), label, () => setSelection(value)),
        );
        if (selection) {
          const value =
            field === 'days' ? irrigationDays(selection.split(' ').map(Number)) : selection;
          lines.push(`Сохранить новое значение «${value}»?`);
          keyboard.push([demoAction('save', '💾 Сохранить')]);
        }
      } else {
        addControllerBlock([
          ...controllerItemStatusLines(kind, item, fresh, moduleEnabled),
          ...controllerItemDetails(device, kind, item, fresh, moduleEnabled),
        ]);
        if (binary) {
          if (fresh && moduleEnabled && item.available === true && typeof item.actual === 'boolean')
            keyboard.push([demoAction('switch', item.actual ? '⚪ Выключить' : '🟢 Включить')]);
        } else if (fresh && moduleEnabled && kind !== 'meteo' && kind !== 'security') {
          const target = kind === 'tanks' ? ' мониторинг' : kind === 'irrigation' ? ' правило' : '';
          keyboard.push([
            demoAction('on', `🟢 Включить${target}`),
            demoAction('off', `⚪ Выключить${target}`),
          ]);
        }
        if (settings[kind] && canConfigure)
          keyboard.push([link('settings', '⚙️ Настроить', settingsPage)]);
      }
    }
  }
  if (back) keyboard.push([back]);
  const messageHeader = [title, ...(subtitle ? [subtitle] : []), ''];
  const messageHeadings = new Set(controllerHeadings.map((index) => index + messageHeader.length));
  return (
    <aside class="telegram-preview panel" aria-label="Пример меню Telegram">
      <div class="telegram-preview-heading">
        <Icon name="telegram" />
        <div>
          <strong>{snapshot?.product.name || 'FCPLCn'}</strong>
          <span>Пример меню бота</span>
        </div>
      </div>
      <div
        class="telegram-bubble"
        data-telegram-preview-message
        role={notice ? 'status' : undefined}
        dangerouslySetInnerHTML={{
          __html: formatTelegramMessage([...messageHeader, ...lines], notice, messageHeadings),
        }}
      />
      <div class="telegram-keyboard">
        {keyboard.map((buttons, index) => (
          <div
            key={index}
            class={buttons.length === 3 ? 'telegram-quick-preview' : 'telegram-preview-buttons'}
          >
            {buttons.map(({ id, label, select }) => (
              <button type="button" key={id} onClick={select}>
                {label}
              </button>
            ))}
          </div>
        ))}
      </div>
      <p class="telegram-preview-caption">Локальный предпросмотр команд и показаний.</p>
    </aside>
  );
}
