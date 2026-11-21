/** @file Private reply-keyboard navigation over verified PLC states and explicit SET operations. */
import { createHash } from 'node:crypto';
import type {
  CommandView,
  ControllerKind,
  DeviceView,
  EngineSnapshot,
  SceneRun,
  ScenesSnapshot,
  WritableControllerKind,
} from '../../shared/types.js';
import type { TelegramReply } from './client.js';

export interface TelegramActions {
  snapshot(): EngineSnapshot;
  scenes(): ScenesSnapshot;
  command(
    deviceId: string,
    kind: WritableControllerKind,
    itemId: string,
    value: boolean,
  ): Promise<CommandView>;
  runScene(id: string): SceneRun;
}

type Row = Record<string, unknown>;
type Page = {
  view: 'home' | 'scenes' | 'device' | 'module' | 'item';
  deviceId?: string;
  kind?: ControllerKind;
  itemId?: string;
  page: number;
};
type Action =
  | { type: 'page'; page: Page }
  | { type: 'scene'; id: string }
  | {
      type: 'set';
      deviceId: string;
      kind: WritableControllerKind;
      itemId: string;
      value: boolean;
      bootId: string | null;
    }
  | {
      type: 'batch';
      deviceId: string;
      kind: 'sockets' | 'lights';
      value: boolean;
      bootId: string | null;
    };
interface Session {
  page: Page;
  actions: Map<string, Action>;
  updated: number;
  lastRun?: string;
}
const kinds: ControllerKind[] = ['sockets', 'lights', 'meteo', 'thermostats', 'security'];
const titles: Record<ControllerKind, string> = {
  sockets: 'Розетки',
  lights: 'Свет',
  meteo: 'Метео',
  thermostats: 'Термостаты',
  security: 'Охрана',
};
const icons: Record<ControllerKind, string> = {
  sockets: '🔌',
  lights: '💡',
  meteo: '🌤',
  thermostats: '🌡',
  security: '🛡',
};
const phases: Record<string, string> = {
  disarmed: 'Охрана снята',
  armed: 'Под охраной',
  exit_delay: 'Задержка выхода',
  entry_delay: 'Задержка входа',
  alarm: '🚨 ТРЕВОГА',
};
const pageSize = 12;
const rows = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter((row): row is Row =>
        Boolean(row && typeof row === 'object' && !Array.isArray(row)),
      )
    : [];
const text = (value: unknown, fallback = '') =>
  typeof value === 'string'
    ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 96) || fallback
    : fallback;
const reading = (value: unknown, unit = ' °C') =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + unit
    : '—';
const home = (): Page => ({ view: 'home', page: 0 });
// Include the complete target identity: names, ordinals and item IDs alone can repeat across PLCs.
const tag = (...parts: string[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 8);
const deviceName = (device: DeviceView) => text(device.name, device.id);
const itemName = (item: Row) => text(item.name, text(item.id, 'Без имени'));
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
  ): DeviceView {
    const snapshot = this.actions.snapshot();
    const device = snapshot.devices.find((entry) => entry.id === deviceId);
    if (
      !snapshot.broker.connected ||
      !device?.online ||
      device.status !== 'online' ||
      !bootId ||
      device.bootId !== bootId ||
      !device.controllers[kind]?.fresh
    )
      throw new Error('Нет свежей связи с PLC. Обновите меню; команда не отправлена.');
    if (device.controllers[kind]?.data.enabled !== true)
      throw new Error('Контроллер выключен. Включите его в настройках PLC.');
    return device;
  }

  /** @brief Handle only current keyboard actions; free-form or old buttons never become commands. */
  async handle(chatId: string, input: string, permitted: () => boolean): Promise<TelegramReply> {
    const session = this.session(chatId);
    let notice = '';
    if (/^\/(?:start|menu)(?:@[A-Za-z0-9_]+)?(?:\s.*)?$/.test(input) || input === '🏠 Главное') {
      session.page = home();
      return this.render(session);
    }
    if (input === '/id') return this.render(session, `Ваш Chat ID: ${chatId}`);
    if (input === '🔄 Обновить') return this.render(session);
    const action = session.actions.get(input);
    if (!action)
      return this.render(
        session,
        'Используйте актуальные кнопки меню. Старые команды не повторяются.',
      );
    if (action.type === 'page') session.page = action.page;
    else if (action.type === 'scene') {
      if (!permitted()) return this.render(session, 'Запрос устарел или доступ отозван.');
      try {
        const run = this.actions.runScene(action.id);
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
        const device = this.commandable(action.deviceId, action.kind, action.bootId);
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
            const current = this.commandable(action.deviceId, action.kind, action.bootId);
            const fresh = rows(current.controllers[action.kind]?.data.items).find(
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
            const field = action.kind === 'thermostats' ? 'enabled' : 'actual';
            if (
              !item ||
              typeof item[field] !== 'boolean' ||
              (action.kind !== 'thermostats' && item.available !== true)
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

  private itemStatus(kind: ControllerKind, item: Row, fresh: boolean): string {
    const name = itemName(item);
    if (!fresh) return `⚫ ${name} — данные устарели`;
    if (kind === 'security')
      return item.available !== true || typeof item.active !== 'boolean'
        ? `⚫ ${name} — недоступно`
        : `${item.active ? '🔴' : '🟢'} ${name} — ${item.active ? 'сработка' : 'норма'}`;
    if (kind === 'meteo')
      return (
        `${item.available === true ? '🌡' : '⚫'} ${name}: ${item.available === true ? reading(item.temperatureC) : 'нет показаний'}` +
        (item.available === true && typeof item.humidityPercent === 'number'
          ? ` · ${reading(item.humidityPercent, '%')}`
          : '')
      );
    if (kind === 'thermostats')
      return `${item.enabled === true ? '🟢' : '⚪'} ${name}: ${item.enabled === true ? 'включён' : 'выключен'} · ${item.mode === 'cooling' ? '❄️' : '🔥'} ${item.available === true ? reading(item.temperatureC) : 'нет показаний'} → ${reading(item.setpointC)}`;
    return `${item.available === true ? (item.actual === true ? '🟢' : '⚪') : '⚫'} ${name} — ${item.available === true ? (item.actual === true ? 'включено' : 'выключено') : 'недоступно'}`;
  }

  /** @brief Build bounded text and a native persistent reply keyboard from the latest snapshot. */
  private render(session: Session, notice = ''): TelegramReply {
    session.actions = new Map();
    const keyboard: string[][] = [];
    const lines: string[] = [];
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
    if (!['home', 'scenes'].includes(session.page.view) && !device) {
      session.page = home();
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
      keyboard.push([
        add('🏠 Я дома', { type: 'scene', id: 'home' }),
        add('🚪 Ушел', { type: 'scene', id: 'away' }),
        add('🌅 Готовлюсь', { type: 'scene', id: 'prepare' }),
      ]);
      const selected = paginate(snapshot.devices);
      split(
        selected.map((entry) => {
          lines.push(
            `${entry.online ? '🟢' : '⚫'} ${deviceName(entry)}${entry.room ? ' · ' + text(entry.room) : ''}`,
          );
          return nav(`🏡 ${deviceName(entry).slice(0, 55)} · ${tag(entry.id)}`, {
            view: 'device',
            deviceId: entry.id,
            page: 0,
          });
        }),
      );
      if (!snapshot.devices.length) lines.push('PLC пока не обнаружены.');
      pages(snapshot.devices.length);
      keyboard.push([nav('🎬 Сценарии', { view: 'scenes', page: 0 })]);
    } else if (session.page.view === 'scenes') {
      lines.push('🎬 Сценарии', 'Одно нажатие запускает назначенные действия.');
      const all = this.actions.scenes().definitions;
      split(
        paginate(all).map((scene) =>
          add(`🎬 ${text(scene.name).slice(0, 55)} · ${tag(scene.id)}`, {
            type: 'scene',
            id: scene.id,
          }),
        ),
      );
      pages(all.length);
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
            const items = rows(module.data.items);
            const fresh = freshDevice && module.fresh;
            const value =
              kind === 'security'
                ? text(module.data.phase, 'неизвестно')
                : `${items.filter((item) => (kind === 'meteo' ? item.available === true : kind === 'thermostats' ? item.enabled === true : item.actual === true)).length}/${items.length}`;
            lines.push(
              `${icons[kind]} ${titles[kind]}: ${fresh ? (kind === 'security' ? phases[value] || value : value) : 'устарело'}${module.data.enabled === true ? '' : ' · модуль выключен'}`,
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
        lines.push(
          `${icons[kind]} ${titles[kind]}`,
          module?.data.enabled === true ? '' : '⚠️ Модуль выключен',
        );
        if (session.page.view === 'item') {
          const item = items.find((entry) => entry.id === session.page.itemId);
          if (!item) lines.push('Канал удалён. Вернитесь к контроллеру.');
          else {
            lines.push('', this.itemStatus(kind, item, fresh));
            if (kind === 'thermostats') {
              lines.push(
                `Режим: ${item.mode === 'cooling' ? '❄️ Охлаждение' : '🔥 Нагрев'}`,
                `Уставка: ${reading(item.setpointC)} · Гистерезис: ${reading(item.hysteresisC)}`,
                `Выход: ${fresh && item.actual === true ? 'включён' : fresh ? 'выключен' : 'неизвестно'}`,
              );
              const suffix = ' · ' + tag(device.id, kind, String(item.id));
              keyboard.push([
                add('🟢 Включить' + suffix, {
                  type: 'set',
                  deviceId: device.id,
                  kind,
                  itemId: String(item.id),
                  value: true,
                  bootId: device.bootId,
                }),
                add('⚪ Выключить' + suffix, {
                  type: 'set',
                  deviceId: device.id,
                  kind,
                  itemId: String(item.id),
                  value: false,
                  bootId: device.bootId,
                }),
              ]);
            } else if (kind === 'meteo') {
              lines.push(
                `Тип: ${item.sensorType === 'onewire' ? 'DS18B20 / OneWire' : text(item.sensorType, '—')}`,
                `Порт: ${text(item.portId, '—')}`,
                `Адрес: ${text(item.address, '—')}`,
              );
              if (typeof item.humidityPercent === 'number')
                lines.push(`Влажность: ${reading(item.humidityPercent, '%')}`);
            } else if (kind === 'security')
              lines.push(
                `Тип: ${item.sensorType === 'motion' ? 'Датчик движения' : 'Геркон'}`,
                `Вход: ${text(item.inputId, '—')}`,
              );
          }
        } else {
          if (kind === 'security') {
            lines.push(
              '',
              fresh
                ? phases[text(module?.data.phase)] || 'Неизвестный режим охраны'
                : 'Состояние охраны устарело',
            );
            const suffix = ' · ' + tag(device.id, kind);
            keyboard.push([
              add('🛡 Поставить на охрану' + suffix, {
                type: 'set',
                deviceId: device.id,
                kind,
                itemId: 'alarm',
                value: true,
                bootId: device.bootId,
              }),
              add('🔓 Снять охрану' + suffix, {
                type: 'set',
                deviceId: device.id,
                kind,
                itemId: 'alarm',
                value: false,
                bootId: device.bootId,
              }),
            ]);
          } else if (kind === 'sockets' || kind === 'lights')
            keyboard.push([
              add('🟢 Вкл все · ' + tag(device.id, kind), {
                type: 'batch',
                deviceId: device.id,
                kind,
                value: true,
                bootId: device.bootId,
              }),
              add('⚪ Выкл все · ' + tag(device.id, kind), {
                type: 'batch',
                deviceId: device.id,
                kind,
                value: false,
                bootId: device.bootId,
              }),
            ]);
          lines.push('');
          split(
            paginate(items).map((item) => {
              lines.push(this.itemStatus(kind, item, fresh));
              const icon =
                kind === 'sockets' || kind === 'lights'
                  ? !fresh || item.available !== true
                    ? '⚫'
                    : item.actual === true
                      ? '🟢'
                      : '⚪'
                  : icons[kind];
              const label = `${icon} ${itemName(item).slice(0, 55)} · ${tag(device.id, kind, String(item.id))}`;
              return kind === 'sockets' || kind === 'lights'
                ? add(label, {
                    type: 'set',
                    deviceId: device.id,
                    kind,
                    itemId: String(item.id),
                    value: item.actual !== true,
                    bootId: device.bootId,
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
              page: 0,
            }
          : session.page.view === 'module'
            ? { view: 'device' as const, deviceId: session.page.deviceId, page: 0 }
            : home();
      keyboard.push([nav('⬅️ Назад', back), '🏠 Главное']);
    }
    keyboard.push(['🔄 Обновить']);
    if (!notice && session.lastRun) {
      const run = this.actions.scenes().runs.find((entry) => entry.id === session.lastRun);
      if (run) notice = this.sceneResult(run);
    }
    return {
      text: [notice, ...lines]
        .filter((line, index) => index !== 0 || line)
        .join('\n')
        .slice(0, 4000),
      reply_markup: {
        keyboard,
        resize_keyboard: true,
        is_persistent: true,
        one_time_keyboard: false,
      },
    };
  }
}
