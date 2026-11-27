/** @file Render bounded Telegram HTML using only built-in tags and escaped text. */
import { telegramSettingLabels } from './telegram-controller-status.js';

const headingLines = new Set([
  'Устройства:',
  'Контроллеры:',
  '🔌 Розетки',
  '💡 Свет',
  '🌤 Метео',
  '🌡 Термостаты',
  '🛡 Охрана',
  '🛢 Баки',
  '💧 Полив',
  ...Object.values(telegramSettingLabels),
]);
const codeFields = new Set(['Порт', 'ROM', 'Ваш Chat ID']);
const emphasisFields = new Set([
  'Состояние',
  'Температура',
  'Влажность',
  'Мониторинг',
  'Уровень',
  'Режим',
  'Уставка',
  'Гистерезис',
  'Дни полива',
  'Время старта',
  'Длительность',
  'Источник воды',
  'Вода по нижнему датчику',
  'Насос',
  'Кран',
  'Сирена',
  'Зоны на связи',
  'Сработавшие зоны',
  'Реле',
  'Датчик',
]);
const htmlEscape = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function formatLine(line: string, heading: boolean): string {
  if (heading || headingLines.has(line) || line.startsWith('⚙️ ')) {
    return `<b>${htmlEscape(line)}</b>`;
  }
  if (line.startsWith('⚠️ ') || line.startsWith('🚨 ')) {
    return `<blockquote>${htmlEscape(line)}</blockquote>`;
  }
  if (line.startsWith('Страница ')) return `<i>${htmlEscape(line)}</i>`;
  const separator = line.indexOf(': ');
  if (separator < 0) return htmlEscape(line);
  const label = line.slice(0, separator);
  const detail = htmlEscape(line.slice(separator + 2));
  if (codeFields.has(label) && detail) return `<b>${label}:</b> <code>${detail}</code>`;
  if (emphasisFields.has(label)) return `<b>${label}:</b> ${detail}`;
  return htmlEscape(line);
}

/** Limit visible text before inserting markup so a tag or HTML entity cannot be cut in half. */
export function formatTelegramMessage(
  lines: readonly string[],
  notice = '',
  headings?: ReadonlySet<number>,
): string {
  const message: string[] = [];
  let remaining = 4000;
  const append = (line: string, format: (line: string) => string) => {
    const budget = remaining - (message.length ? 1 : 0);
    if (budget <= 0) return;
    const visible =
      line.length <= budget
        ? line
        : line.slice(0, budget - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…';
    message.push(format(visible));
    remaining = line.length <= budget ? budget - visible.length : 0;
  };
  if (notice) append(notice, (line) => `<blockquote>${htmlEscape(line)}</blockquote>`);
  lines.forEach((line, index) =>
    append(line, (value) => formatLine(value, index === 0 || headings?.has(index) === true)),
  );
  return message.join('\n');
}
