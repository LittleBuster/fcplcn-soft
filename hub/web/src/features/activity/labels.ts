import type { ActivityActor } from '../../../../shared/activity.js';

const sources: Record<ActivityActor['source'], string> = {
  web: 'Веб-панель',
  cloud: 'Облако',
  telegram: 'Telegram',
  schedule: 'Расписание',
  key: 'Ключ',
  system: 'Автоматизация',
};

const timestamp = new Intl.DateTimeFormat('ru-RU', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function activityActorLabel(actor?: ActivityActor, fallback = 'Источник неизвестен') {
  if (!actor) return fallback;
  const source = sources[actor.source];
  const name = actor.name.trim();
  return name && name !== source ? `${name} · ${source}` : source;
}

export function activityDateTime(value: string) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? timestamp.format(milliseconds) : '—';
}

export function outageDuration(start: string, end: string) {
  return formatOutageDuration(Date.parse(end) - Date.parse(start));
}

export function formatOutageDuration(elapsed: number) {
  if (!Number.isFinite(elapsed)) return '—';
  const seconds = Math.max(0, Math.floor(elapsed / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} д ${hours} ч`;
  if (hours) return `${hours} ч ${minutes} мин`;
  if (minutes) return `${minutes} мин ${seconds % 60} с`;
  return `${seconds} с`;
}
