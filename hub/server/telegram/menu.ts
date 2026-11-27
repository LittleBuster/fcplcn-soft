/** @file Private reply-keyboard navigation over verified PLC states and explicit SET operations. */
import { irrigationDays } from '../../shared/irrigation.js';
import { createHash } from 'node:crypto';
import type { MeteoHistoryPeriod } from '../../shared/meteo-history.js';
import {
  controllerItemDetails,
  controllerItemStatusLines,
  controllerModuleDetails,
  controllerModuleSummaryLines,
  itemName,
  rows,
  text,
} from '../../shared/telegram-controller-status.js';
import { formatTelegramMessage } from '../../shared/telegram-format.js';
import type { TelegramControllerSettingsActions } from './controller-settings.js';
import {
  handleTelegramSettings,
  parseTelegramSetting,
  settingPrompts,
  renderTelegramSettings,
  type SettingEditor,
  type SettingsAction,
} from './settings-menu.js';
import type {
  CommandView,
  ControllerKind,
  DeviceView,
  EngineSnapshot,
  HouseSecurityView,
  SceneRun,
  ScenesSnapshot,
  WritableControllerKind,
} from '../../shared/types.js';
import type { TelegramPhoto, TelegramReply } from './client.js';

export interface TelegramActions {
  snapshot(): EngineSnapshot;
  scenes(): ScenesSnapshot;
  command(
    deviceId: string,
    kind: WritableControllerKind,
    itemId: string,
    value: boolean,
  ): Promise<CommandView>;
  runScene(id: string, signal?: AbortSignal): SceneRun | Promise<SceneRun>;
  houseStatus?(): HouseSecurityView | undefined;
  setSceneSchedule?(id: string, revision: number, enabled: boolean): Promise<void>;
  meteoChart?(
    deviceId: string,
    itemId: string,
    period: MeteoHistoryPeriod,
  ): Promise<TelegramPhoto | null>;
  service?: TelegramControllerSettingsActions['service'];
}

type Row = Record<string, unknown>;
type Page = {
  view:
    'home' | 'scenes' | 'scheduled' | 'scene' | 'device' | 'module' | 'module-settings' | 'item';
  sceneId?: string;
  details?: boolean;
  deviceId?: string;
  kind?: ControllerKind;
  itemId?: string;
  page: number;
};
type Action =
  | SettingsAction
  | { type: 'schedule'; id: string; revision: number; enabled: boolean }
  | { type: 'meteo-chart'; deviceId: string; itemId: string; period: MeteoHistoryPeriod }
  | { type: 'page'; page: Page }
  | { type: 'scene'; id: string }
  | {
      type: 'set';
      deviceId: string;
      kind: WritableControllerKind;
      itemId: string;
      value: boolean;
      bootId: string | null;
      connectionGeneration?: number;
    }
  | {
      type: 'batch';
      deviceId: string;
      kind: 'sockets' | 'lights';
      value: boolean;
      bootId: string | null;
      connectionGeneration?: number;
    };
interface Session {
  page: Page;
  actions: Map<string, Action>;
  updated: number;
  lastRun?: string;
  editor?: SettingEditor;
}
const kinds: ControllerKind[] = [
  'sockets',
  'lights',
  'meteo',
  'thermostats',
  'security',
  'tanks',
  'irrigation',
];
const titles: Record<ControllerKind, string> = {
  sockets: 'Розетки',
  lights: 'Свет',
  meteo: 'Метео',
  thermostats: 'Термостаты',
  security: 'Охрана',
  tanks: 'Баки',
  irrigation: 'Полив',
};
const icons: Record<ControllerKind, string> = {
  sockets: '🔌',
  lights: '💡',
  meteo: '🌤',
  thermostats: '🌡',
  security: '🛡',
  tanks: '🛢',
  irrigation: '💧',
};
const pageSize = 12;
const home = (): Page => ({ view: 'home', page: 0 });
// Include the complete target identity: names, ordinals and item IDs alone can repeat across PLCs.
const tag = (...parts: string[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 8);
const deviceName = (device: DeviceView) => text(device.name, device.id);
const commandResult = (command: CommandView) =>
  command.status === 'applied'
    ? '✅ PLC подтвердил изменение.'
    : command.status === 'unknown'
      ? '❔ Результат неизвестен. Команда не повторяется; обновите состояние.'
      : '⚠️ ' + text(command.error, 'PLC не подтвердил изменение.');

/** @brief Bound per-chat menus and map exact displayed labels to IDs and captured explicit values. */
export class TelegramMenu {
  private readonly sessions = new Map<string, Session>();
  constructor(
    private readonly actions: TelegramActions,
    private readonly settleMs = 2000,
    private readonly productName = 'FCPLCn',
  ) {}

  clear(): void {
    this.sessions.clear();
  }

  private session(chatId: string): Session {
    const now = Date.now();
    for (const [id, session] of this.sessions)
      if (now - session.updated > 30 * 60_000) this.sessions.delete(id);
    let current = this.sessions.get(chatId);
    if (!current) {
      if (this.sessions.size >= 128) this.sessions.delete(this.sessions.keys().next().value!);
      current = { page: home(), actions: new Map(), updated: now };
      this.sessions.set(chatId, current);
    }
    current.updated = now;
    return current;
  }

  /** @brief Reject stale boot evidence and unavailable modules before any shared control callback. */
  private commandable(
    deviceId: string,
    kind: WritableControllerKind,
    bootId: string | null,
    connectionGeneration?: number,
  ): DeviceView {
    const snapshot = this.actions.snapshot();
    const device = snapshot.devices.find((entry) => entry.id === deviceId);
    if (
      !snapshot.broker.connected ||
      !device?.online ||
      device.status !== 'online' ||
      !bootId ||
      device.bootId !== bootId ||
      (connectionGeneration !== undefined &&
        device.connectionGeneration !== connectionGeneration) ||
      !device.controllers[kind]?.fresh
    )
      throw new Error('Нет свежей связи с PLC. Обновите меню; команда не отправлена.');
    if (device.controllers[kind]?.data.enabled !== true)
      throw new Error('Контроллер выключен. Включите его в настройках PLC.');
    return device;
  }

  /** @brief Handle only current keyboard actions; free-form or old buttons never become commands. */
  async handle(
    chatId: string,
    input: string,
    permitted: () => boolean,
    signal?: AbortSignal,
  ): Promise<TelegramReply> {
    const session = this.session(chatId);
    let notice = '';
    if (/^\/(?:start|menu)(?:@[A-Za-z0-9_]+)?(?:\s.*)?$/.test(input) || input === '🏠 Главное') {
      session.page = home();
      session.editor = undefined;
      return this.render(session);
    }
    if (input === '/id') return this.render(session, `Ваш Chat ID: ${chatId}`);
    if (input === '🔄 Обновить') return this.render(session);
    const action = session.actions.get(input);
    if (!action) {
      const editor = session.editor;
      if (editor?.field && settingPrompts[editor.field] && permitted()) {
        const value = parseTelegramSetting(editor.field, input);
        if (!value) return this.render(session, '⚠️ Проверьте формат значения.');
        editor.candidate = value;
        return this.render(session);
      }
      return this.render(
        session,
        'Используйте актуальные кнопки меню. Старые команды не повторяются.',
      );
    }
    if (action.type === 'page') {
      session.page = action.page;
      session.editor = undefined;
    } else if (action.type === 'meteo-chart') {
      if (!permitted()) return this.render(session, 'Запрос устарел или доступ отозван.');
      try {
        const chart = await this.actions.meteoChart?.(
          action.deviceId,
          action.itemId,
          action.period,
        );
        if (!permitted()) return this.render(session, 'Запрос устарел или доступ отозван.');
        if (chart) return { ...this.render(session), chart };
        notice = 'За этот период ещё нет показаний.';
      } catch {
        notice = '⚠️ Не удалось построить график. Попробуйте ещё раз.';
      }
    } else if (action.type === 'schedule') {
      if (!permitted()) return this.render(session, 'Запрос устарел или доступ отозван.');
      try {
        if (!this.actions.setSceneSchedule) throw new Error('Изменение расписания недоступно.');
        await this.actions.setSceneSchedule(action.id, action.revision, action.enabled);
        notice = action.enabled ? '✅ Расписание включено.' : '✅ Расписание приостановлено.';
      } catch (error) {
        notice =
          '⚠️ ' + text(error instanceof Error ? error.message : '', 'Расписание не изменено.');
      }
    } else if (
      action.type === 'module-enabled' ||
      action.type === 'settings' ||
      action.type === 'setting-field' ||
      action.type === 'setting-value' ||
      action.type === 'setting-page' ||
      action.type === 'setting-back' ||
      action.type === 'setting-save'
    ) {
      return this.handleSettings(session, action, permitted);
    } else if (action.type === 'scene') {
      if (!permitted()) return this.render(session, 'Запрос устарел или доступ отозван.');
      try {
        const run = await this.actions.runScene(action.id, signal);
        session.lastRun = run.id;
        const deadline = Date.now() + this.settleMs;
        while (
          Date.now() < deadline &&
          permitted() &&
          this.actions.scenes().activeRun?.id === run.id
        )
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        notice = this.sceneResult(
          this.actions.scenes().runs.find((entry) => entry.id === run.id) || run,
        );
      } catch (error) {
        notice = '⚠️ ' + text(error instanceof Error ? error.message : '', 'Сценарий не запущен.');
      }
    } else {
      try {
        const device = this.commandable(
          action.deviceId,
          action.kind,
          action.bootId,
          action.connectionGeneration,
        );
        const module = device.controllers[action.kind]!;
        if (action.type === 'batch') {
          const candidates = rows(module.data.items);
          let applied = 0,
            refused = 0,
            unknown = 0,
            processed = 0;
          for (const item of candidates) {
            if (!permitted()) break;
            processed++;
            const current = this.commandable(
              action.deviceId,
              action.kind,
              action.bootId,
              action.connectionGeneration,
            );
            const fresh: Row | undefined = rows(current.controllers[action.kind]?.data.items).find(
              (row) => row.id === item.id,
            );
            if (!fresh || fresh.available !== true || typeof fresh.actual !== 'boolean') {
              refused++;
              continue;
            }
            if (fresh.actual === action.value) {
              applied++;
              continue;
            }
            const result = await this.actions.command(
              action.deviceId,
              action.kind,
              String(item.id),
              action.value,
            );
            if (result.status === 'applied') applied++;
            else if (result.status === 'unknown') {
              unknown++;
              break;
            } else refused++;
          }
          notice =
            `Подтверждено: ${applied}/${candidates.length}.` +
            (refused ? ` Недоступно или отклонено: ${refused}.` : '') +
            (unknown ? ' ❔ Есть неподтверждённая команда; дальнейшая отправка остановлена.' : '') +
            (processed < candidates.length
              ? ` Не отправлено: ${candidates.length - processed}.`
              : '');
        } else {
          if (!permitted()) return this.render(session, 'Запрос устарел или доступ отозван.');
          if (action.kind === 'security') {
            if (
              typeof module.data.armed !== 'boolean' ||
              (action.value && module.data.readyToArm !== true && module.data.armed !== true)
            )
              throw new Error('Охрана не готова к постановке. Проверьте датчики.');
          } else {
            const item = rows(module.data.items).find((row) => row.id === action.itemId);
            const field = ['thermostats', 'tanks', 'irrigation'].includes(action.kind)
              ? 'enabled'
              : 'actual';
            if (
              !item ||
              typeof item[field] !== 'boolean' ||
              (!['thermostats', 'tanks', 'irrigation'].includes(action.kind) &&
                item.available !== true)
            )
              throw new Error('Канал недоступен. Команда не отправлена.');
          }
          notice = commandResult(
            await this.actions.command(action.deviceId, action.kind, action.itemId, action.value),
          );
        }
      } catch (error) {
        notice =
          '⚠️ ' + text(error instanceof Error ? error.message : '', 'Команда не отправлена.');
      }
    }
    return this.render(session, notice);
  }

  private sceneResult(run: SceneRun): string {
    const applied = run.results.filter((result) => result.status === 'applied').length;
    const unknown = run.results.filter((result) => result.status === 'unknown').length;
    const icon = run.status === 'completed' ? '✅' : run.status === 'running' ? '⏳' : '⚠️';
    return (
      `${icon} ${text(run.name)}: ${run.status === 'running' ? 'выполняется' : run.status === 'completed' ? 'выполнен' : 'завершён с замечаниями'}. Подтверждено ${applied}/${run.results.length}.` +
      (unknown ? ` Неизвестный результат: ${unknown}; повтора нет.` : '')
    );
  }

  private async handleSettings(
    session: Session,
    action: SettingsAction,
    permitted: () => boolean,
  ): Promise<TelegramReply> {
    let notice: string;
    try {
      if (!this.actions.service) throw new Error('Настройка PLC недоступна.');
      notice = await handleTelegramSettings(
        session,
        action,
        {
          snapshot: () => this.actions.snapshot(),
          service: this.actions.service,
        },
        permitted,
      );
    } catch (error) {
      notice = '⚠️ ' + text(error instanceof Error ? error.message : '', 'Настройка не сохранена.');
    }
    return this.render(session, notice);
  }

  /** @brief Build bounded text and a native persistent reply keyboard from the latest snapshot. */
  private render(session: Session, notice = ''): TelegramReply {
    session.actions = new Map();
    const keyboard: string[][] = [];
    const lines: string[] = [];
    const headings = new Set<number>();
    const section = (title: string, ...details: string[]) => {
      lines.push('');
      headings.add(lines.length);
      lines.push(title, ...details);
    };
    const add = (label: string, action: Action) => {
      session.actions.set(label, action);
      return label;
    };
    const nav = (label: string, page: Page) => add(label, { type: 'page', page });
    const split = (labels: string[]) => {
      for (let index = 0; index < labels.length; index += 2)
        keyboard.push(labels.slice(index, index + 2));
    };
    const paginate = <T>(all: T[]): T[] => {
      const max = Math.max(0, Math.ceil(all.length / pageSize) - 1);
      session.page.page = Math.min(Math.max(0, session.page.page), max);
      const selected = all.slice(session.page.page * pageSize, (session.page.page + 1) * pageSize);
      if (max) lines.push(`Страница ${session.page.page + 1}/${max + 1}`);
      return selected;
    };
    const pages = (count: number) => {
      const row: string[] = [];
      if (session.page.page > 0)
        row.push(nav('◀️ Предыдущие', { ...session.page, page: session.page.page - 1 }));
      if ((session.page.page + 1) * pageSize < count)
        row.push(nav('Следующие ▶️', { ...session.page, page: session.page.page + 1 }));
      if (row.length) keyboard.push(row);
    };
    const snapshot = this.actions.snapshot();
    const device = snapshot.devices.find((entry) => entry.id === session.page.deviceId);
    if (!['home', 'scenes', 'scheduled', 'scene'].includes(session.page.view) && !device) {
      session.page = home();
      session.editor = undefined;
      notice = notice || 'Устройство больше не найдено.';
    }
    if (session.page.view === 'home') {
      lines.push(
        `🏡 ${this.productName} · Умный дом`,
        snapshot.broker.connected
          ? 'Хаб подключён к локальному брокеру.'
          : '⚠️ Нет связи с локальным брокером.',
        '',
        'Устройства:',
      );
      const house = this.actions.houseStatus?.();
      if (house) {
        const enrolled = house.devices.filter((plc) => plc.configured && plc.enabled);
        const confirmed = enrolled.filter((plc) => plc.status === 'confirmed');
        const desired =
          house.desiredArmed === true
            ? 'Ушел'
            : house.desiredArmed === false
              ? 'Я дома'
              : 'режим не задан';
        const alarms = enrolled.filter((plc) => plc.online && plc.phase === 'alarm');
        lines.splice(
          2,
          0,
          `🛡 Охрана дома · ${desired} · подтверждено ${confirmed.length}/${enrolled.length}`,
          ...(alarms.length
            ? ['🚨 Тревога · ' + alarms.map((plc) => text(plc.name)).join(', ')]
            : []),
        );
      }
      keyboard.push([
        add('🏠 Я дома', { type: 'scene', id: 'home' }),
        add('🚪 Ушел', { type: 'scene', id: 'away' }),
        add('🚗 Готовлюсь', { type: 'scene', id: 'prepare' }),
      ]);
      for (const entry of paginate(snapshot.devices)) {
        lines.push(
          `${entry.online ? '🟢' : '⚫'} ${deviceName(entry)}${entry.room ? ' · ' + text(entry.room) : ''}`,
        );
        keyboard.push([
          nav(`🏡 ${deviceName(entry).slice(0, 55)} · ${tag(entry.id)}`, {
            view: 'device',
            deviceId: entry.id,
            page: 0,
          }),
        ]);
      }
      if (!snapshot.devices.length) lines.push('PLC пока не обнаружены.');
      pages(snapshot.devices.length);
      keyboard.push([
        nav('🎬 Сценарии', { view: 'scenes', page: 0 }),
        nav('🗓 По расписанию', { view: 'scheduled', page: 0 }),
      ]);
    } else if (session.page.view === 'scenes' || session.page.view === 'scheduled') {
      const scheduled = session.page.view === 'scheduled';
      lines.push(scheduled ? '🗓 Сценарии по расписанию' : '🎬 Мгновенные сценарии');
      const all = this.actions
        .scenes()
        .definitions.filter((scene) => Boolean(scene.schedule?.enabled) === scheduled);
      split(
        paginate(all).map((scene) => {
          const label = `${scheduled ? (scene.schedule?.paused ? '⏸' : '🗓') : '🎬'} ${text(scene.name).slice(0, 55)} · ${tag(scene.id)}`;
          if (scheduled) {
            lines.push(`${text(scene.name)} · ${scene.schedule?.paused ? 'на паузе' : 'включён'}`);
            return nav(label, { view: 'scene', sceneId: scene.id, page: 0 });
          }
          return add(label, { type: 'scene', id: scene.id });
        }),
      );
      if (!all.length) lines.push('Сценариев пока нет.');
      pages(all.length);
    } else if (session.page.view === 'scene') {
      const scene = this.actions
        .scenes()
        .definitions.find((row) => row.id === session.page.sceneId);
      if (!scene) lines.push('Сценарий удалён.');
      else {
        lines.push(`🗓 ${text(scene.name)}`);
        const schedule = scene.schedule;
        if (schedule?.enabled) {
          lines.push(`${irrigationDays(schedule.days)} · ${schedule.time} · ${schedule.timeZone}`);
          lines.push(schedule.paused ? 'Расписание приостановлено' : 'Расписание включено');
          if (this.actions.setSceneSchedule) {
            keyboard.push([
              add(
                (schedule.paused ? '▶️ Включить расписание' : '⏸ Приостановить расписание') +
                  ' · ' +
                  tag(scene.id, String(scene.revision)),
                {
                  type: 'schedule',
                  id: scene.id,
                  revision: scene.revision,
                  enabled: Boolean(schedule.paused),
                },
              ),
            ]);
          }
        }
        keyboard.push([
          add('▶️ Запустить сейчас · ' + tag(scene.id), { type: 'scene', id: scene.id }),
        ]);
      }
    } else if (device) {
      const freshDevice = snapshot.broker.connected && device.online && device.status === 'online';
      lines.push(
        `🏡 ${deviceName(device)}`,
        freshDevice ? '🟢 На связи' : '⚫ Нет свежей связи с PLC',
      );
      if (session.page.view === 'device') {
        lines.push('', 'Контроллеры:');
        const available = kinds.filter((kind) => device.controllers[kind]);
        split(
          available.map((kind) => {
            const module = device.controllers[kind]!;
            section(
              `${icons[kind]} ${titles[kind]}`,
              ...controllerModuleSummaryLines(kind, module, freshDevice && module.fresh),
            );
            return nav(`${icons[kind]} ${titles[kind]}`, {
              view: 'module',
              deviceId: device.id,
              kind,
              page: 0,
            });
          }),
        );
        if (!available.length) lines.push('Ожидаем данные контроллеров.');
      } else {
        const kind = session.page.kind!;
        const module = device.controllers[kind];
        const fresh = freshDevice && module?.fresh === true;
        const items = rows(module?.data.items);
        const enabled = module?.data.enabled === true;
        const revision = Number(module?.data.revision);
        const canConfigure =
          fresh &&
          device.management?.supported === true &&
          this.actions.service &&
          Number.isSafeInteger(revision) &&
          revision >= 1;
        const liveTarget = {
          deviceId: device.id,
          bootId: device.bootId,
          connectionGeneration: device.connectionGeneration,
        };
        const target = { ...liveTarget, revision };
        const stateTag = (...parts: string[]) =>
          tag(
            device.id,
            kind,
            device.bootId || '',
            String(device.connectionGeneration ?? ''),
            ...parts,
          );
        const binary = kind === 'sockets' || kind === 'lights';
        lines.push(`${icons[kind]} ${titles[kind]}`);
        if (session.page.view !== 'module-settings') {
          if (!module) lines.push('Нет данных модуля.');
          else if (!enabled) lines.push('⚠️ Модуль выключен');
        }
        if (session.page.view === 'module-settings') {
          section(
            '⚙️ Настройки модуля',
            canConfigure
              ? `Состояние: модуль ${enabled ? 'включён' : 'выключен'}`
              : '⚠️ Настройки модуля недоступны.',
          );
          if (canConfigure) {
            keyboard.push([
              add(
                (enabled ? '⚙️ Выключить модуль' : '⚙️ Включить модуль') +
                  ' · ' +
                  stateTag(String(revision)),
                { type: 'module-enabled', kind, target, enabled: !enabled },
              ),
            ]);
          }
        } else if (session.page.view === 'item') {
          const item = items.find((entry) => entry.id === session.page.itemId);
          if (!item) lines.push('Канал удалён. Вернитесь к контроллеру.');
          else {
            section(...controllerItemStatusLines(kind, item, fresh, enabled));
            lines.push(...controllerItemDetails(device, kind, item, fresh, enabled));
            if (session.editor) {
              renderTelegramSettings(session.editor, item, lines, keyboard, add, tag, pageSize);
            } else {
              const itemId = String(item.id);
              const suffix = ' · ' + stateTag(itemId);
              if (kind === 'meteo' && this.actions.meteoChart) {
                const chart = { type: 'meteo-chart' as const, deviceId: device.id, itemId };
                keyboard.push([
                  add('📈 24 часа' + suffix, { ...chart, period: 'day' }),
                  add('📈 7 дней' + suffix, { ...chart, period: 'week' }),
                ]);
              }
              if (
                binary &&
                fresh &&
                enabled &&
                item.available === true &&
                typeof item.actual === 'boolean'
              ) {
                keyboard.push([
                  add((item.actual ? '⚪ Выключить' : '🟢 Включить') + suffix, {
                    type: 'set',
                    ...liveTarget,
                    kind,
                    itemId,
                    value: !item.actual,
                  }),
                ]);
              }
              if (kind === 'thermostats' || kind === 'tanks' || kind === 'irrigation') {
                const targetName =
                  kind === 'tanks' ? ' мониторинг' : kind === 'irrigation' ? ' правило' : '';
                if (fresh && enabled)
                  keyboard.push([
                    add('🟢 Включить' + targetName + suffix, {
                      type: 'set',
                      ...liveTarget,
                      kind,
                      itemId,
                      value: true,
                    }),
                    add('⚪ Выключить' + targetName + suffix, {
                      type: 'set',
                      ...liveTarget,
                      kind,
                      itemId,
                      value: false,
                    }),
                  ]);
                if (canConfigure)
                  keyboard.push([
                    add('⚙️ Настроить' + suffix, {
                      type: 'settings',
                      kind,
                      target: { ...target, itemId },
                    }),
                  ]);
              }
            }
          }
        } else {
          if (module && fresh && enabled)
            lines.push(...controllerModuleDetails(kind, module, fresh));
          if (kind === 'security' && fresh && enabled) {
            const suffix = ' · ' + stateTag();
            keyboard.push([
              add('🛡 Поставить на охрану' + suffix, {
                type: 'set',
                ...liveTarget,
                kind,
                itemId: 'alarm',
                value: true,
              }),
              add('🔓 Снять охрану' + suffix, {
                type: 'set',
                ...liveTarget,
                kind,
                itemId: 'alarm',
                value: false,
              }),
            ]);
          } else if (binary && fresh && enabled && !session.page.details)
            keyboard.push([
              add('🟢 Вкл все · ' + stateTag(), {
                type: 'batch',
                ...liveTarget,
                kind,
                value: true,
              }),
              add('⚪ Выкл все · ' + stateTag(), {
                type: 'batch',
                ...liveTarget,
                kind,
                value: false,
              }),
            ]);
          split(
            paginate(items).map((item) => {
              section(...controllerItemStatusLines(kind, item, fresh, enabled));
              const icon =
                kind === 'sockets' || kind === 'lights'
                  ? !fresh || item.available !== true
                    ? '⚫'
                    : item.actual === true
                      ? '🟢'
                      : '⚪'
                  : icons[kind];
              const label = `${icon} ${itemName(item).slice(0, 55)} · ${stateTag(String(item.id))}`;
              return binary &&
                !session.page.details &&
                fresh &&
                enabled &&
                item.available === true &&
                typeof item.actual === 'boolean'
                ? add(label, {
                    type: 'set',
                    ...liveTarget,
                    kind,
                    itemId: String(item.id),
                    value: !item.actual,
                  })
                : nav(label, {
                    view: 'item',
                    deviceId: device.id,
                    kind,
                    itemId: String(item.id),
                    page: 0,
                  });
            }),
          );
          if (!items.length) lines.push('Каналы не добавлены.');
          pages(items.length);
          if (canConfigure)
            keyboard.push([nav('⚙️ Настройки', { ...session.page, view: 'module-settings' })]);
          if (binary) {
            const details = Boolean(session.page.details);
            keyboard.push([
              nav(details ? '⚡ Быстрое управление' : 'ℹ️ Подробности каналов', {
                ...session.page,
                details: !details,
                page: 0,
              }),
            ]);
          }
        }
      }
    }
    if (session.page.view !== 'home') {
      const back =
        session.page.view === 'item'
          ? {
              view: 'module' as const,
              deviceId: session.page.deviceId,
              kind: session.page.kind,
              details: session.page.kind === 'sockets' || session.page.kind === 'lights',
              page: 0,
            }
          : session.page.view === 'module-settings'
            ? { ...session.page, view: 'module' as const }
            : session.page.view === 'module'
              ? { view: 'device' as const, deviceId: session.page.deviceId, page: 0 }
              : session.page.view === 'scene'
                ? { view: 'scheduled' as const, page: 0 }
                : home();
      keyboard.push([nav('⬅️ Назад', back), '🏠 Главное']);
    }
    keyboard.push(['🔄 Обновить']);
    if (!notice && session.lastRun) {
      const run = this.actions.scenes().runs.find((entry) => entry.id === session.lastRun);
      if (run) notice = this.sceneResult(run);
    }
    return {
      text: formatTelegramMessage(lines, notice, headings),
      parse_mode: 'HTML',
      reply_markup: {
        keyboard,
        resize_keyboard: true,
        is_persistent: true,
        one_time_keyboard: false,
      },
    };
  }
}
