/** @file Единый набор SVG-иконок и изображение платы для интерфейса FCPLCn. */

import type { ComponentChildren } from 'preact';

export type IconName =
  | 'tank'
  | 'irrigation'
  | 'tablet'
  | 'home'
  | 'away'
  | 'prepare'
  | 'car'
  | 'plc'
  | 'activity'
  | 'settings'
  | 'arrow'
  | 'back'
  | 'search'
  | 'logout'
  | 'link'
  | 'light'
  | 'socket'
  | 'weather'
  | 'thermometer'
  | 'heating'
  | 'cooling'
  | 'shield'
  | 'alarm'
  | 'door'
  | 'motion'
  | 'check'
  | 'clock'
  | 'wifi'
  | 'refresh'
  | 'room'
  | 'power'
  | 'telegram'
  | 'person'
  | 'person-add'
  | 'image'
  | 'copy'
  | 'trash'
  | 'chat'
  | 'cloud'
  | 'key';

const drawings: Record<IconName, ComponentChildren> = {
  irrigation: (
    <>
      <path d="M3 21h18M10 21v-3h4v3M9 18h6M12 15v-3M9 13c-1.5-4-4-6-7-5M15 13c1.5-4 4-6 7-5" />
      <path d="M12 8V5m0-3v.3M6 6l-2-2m14 2 2-2M3 12l-1 2m19-2 1 2" />
    </>
  ),
  tank: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 4 16 4 16 0V5M4 13c0 4 16 4 16 0" />
    </>
  ),
  tablet: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="3" />
      <path d="M17 4v16" />
      <circle cx="19.5" cy="12" r=".6" />
      <path d="M6 8h7M6 12h3m-3 4h7m-1-4h1" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="8" r="5" />
      <circle cx="8" cy="8" r="1" />
      <path d="m12 12 9 9m-4-4 3-3m-6 0 3-3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8" cy="8" r="1.5" />
      <path d="m3 17 5-5 4 4 4-6 5 7" />
    </>
  ),
  cloud: (
    <>
      <path d="M6 18a5 5 0 1 1 1-10 7 7 0 0 1 13 2 4 4 0 0 1-1 8H6Z" />
      <path d="m9 14 3-3 3 3m-3-3v11" />
    </>
  ),
  telegram: (
    <>
      <path d="m3 10 18-7-5 18-5-7-8-4Z" />
      <path d="m11 14 6-7m-6 7v6l4-4" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
    </>
  ),
  'person-add': (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21v-2a7 7 0 0 1 12-5m5-3v8m-4-4h8" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
    </>
  ),
  chat: (
    <>
      <path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-8l-6 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M7 8h10M7 12h7" />
    </>
  ),
  away: (
    <>
      <path d="m3 11 8-7 8 7M5 9v12h8M10 21v-7h4" />
      <path d="M15 17h8m-3-3 3 3-3 3" />
    </>
  ),
  prepare: (
    <>
      <path d="M5 18a7 7 0 0 1 14 0M3 18h18M2 22h20M12 2v3M3 7l2 2m16-2-2 2M1 14h3m16 0h3" />
      <path d="M8 17c-2-2 2-3 0-5m4 5c-2-2 2-3 0-5m4 5c-2-2 2-3 0-5" />
    </>
  ),
  car: (
    <>
      <path d="M4 16H2v-3a2 2 0 0 1 1-1.7L6 10l3-4h7l4 4 2 2v4h-2m-4 0H8M6 10h14" />
      <circle cx="6" cy="16" r="2" />
      <circle cx="18" cy="16" r="2" />
    </>
  ),
  home: (
    <>
      <path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7" />
    </>
  ),
  plc: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <rect x="8" y="8" width="8" height="8" rx="1.5" />
      <path d="M8 1v3m8-3v3M8 20v3m8-3v3M1 8h3m-3 8h3m16-8h3m-3 8h3" />
    </>
  ),
  activity: (
    <>
      <path d="M2 12h4l3-8 5 16 3-8h5" />
    </>
  ),
  settings: (
    <>
      <path d="M5 3v18M12 3v18M19 3v18" />
      <rect x="2.5" y="6" width="5" height="5" rx="1" />
      <rect x="9.5" y="13" width="5" height="5" rx="1" />
      <rect x="16.5" y="5" width="5" height="5" rx="1" />
    </>
  ),
  arrow: (
    <>
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </>
  ),
  back: (
    <>
      <path d="M20 12H4m6-6-6 6 6 6" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="m15 15 6 6" />
    </>
  ),
  logout: (
    <>
      <path d="M9 4H4v16h5m5-13 5 5-5 5m-6-5h11" />
    </>
  ),
  link: (
    <>
      <rect x="3" y="7" width="7" height="10" rx="2" />
      <rect x="14" y="7" width="7" height="10" rx="2" />
      <path d="M10 12h4M6.5 10v4m11-4v4" />
    </>
  ),
  light: (
    <>
      <path d="M8 16c0-3-3-3.5-3-7a7 7 0 0 1 14 0c0 3.5-3 4-3 7Z" />
      <path d="M9 20h6m-5 3h4M12 0v1M1 5l2 1m18-1-2 1" />
    </>
  ),
  socket: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="6" />
      <path d="M9.5 10.5v3m5-3v3M12 6v2m0 8v2" />
    </>
  ),
  weather: (
    <>
      <circle cx="8" cy="7" r="4" />
      <path d="M8 0v1M1 7H0m2-5L1 1m12 1 1-1M6 17a4 4 0 1 1 1-8 5 5 0 0 1 9 1 3.5 3.5 0 1 1 2 7ZM8 20l-1 2m6-2-1 2m6-2-1 2" />
    </>
  ),
  thermometer: (
    <>
      <path d="M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0Z" />
      <path d="M12 8v10m6-12h3m-3 4h2" />
      <circle cx="12" cy="18" r="1.3" />
    </>
  ),
  heating: (
    <>
      <rect x="3" y="9" width="18" height="11" rx="2" />
      <path d="M7 11v7m5-7v7m5-7v7M7 20v2m10-2v2M7 6c-3-2 3-3 0-5m5 5c-3-2 3-3 0-5m5 5c-3-2 3-3 0-5" />
    </>
  ),
  cooling: (
    <>
      <path d="M12 2v20M3.5 7l17 10M3.5 17l17-10M9 4l3 3 3-3M9 20l3-3 3 3M4 10l4-1-1-4m13 9-4 1 1 4M4 14l4 1-1 4m13-9-4-1 1-4" />
    </>
  ),
  shield: (
    <>
      <path d="m12 2 8 3v6c0 6-8 11-8 11S4 17 4 11V5Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  alarm: (
    <>
      <path d="m12 2 8 3v6c0 6-8 11-8 11S4 17 4 11V5Z" />
      <path d="M12 7v6" />
      <circle cx="12" cy="17" r=".6" class="filled" />
    </>
  ),
  door: (
    <>
      <path d="M5 22V2h14v20M8 22V5h8v17M14 13h.2M3 22h18" />
    </>
  ),
  motion: (
    <>
      <circle cx="14" cy="4" r="2" />
      <path d="m10 8 5 2 4 4M10 8l-4 5m6-4-2 7-4 6m4-6 6 6M3 5a10 10 0 0 0 0 14" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  wifi: (
    <>
      <path d="M2 8a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0m-10 4a5 5 0 0 1 6 0" />
      <circle cx="12" cy="20" r=".7" class="filled" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 8a8.5 8.5 0 0 0-15-2L2 9m0-6v6h6M4 16a8.5 8.5 0 0 0 15 2l3-3m0 6v-6h-6" />
    </>
  ),
  room: (
    <>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 11h8V4m0 7v10m0-6h10" />
    </>
  ),
  power: (
    <>
      <path d="M12 2v9m-5-7a9 9 0 1 0 10 0" />
    </>
  ),
};

/** Рисует именованную иконку из общего набора с необязательным дополнительным классом. */
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      class={`icon ${className}`}
      data-icon={name}
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {drawings[name]}
    </svg>
  );
}

/** Рисует стандартную плату PLC для карточек без выбранной тематической иллюстрации. */
export function BoardArt() {
  return (
    <svg class="board-art" viewBox="0 0 280 160" fill="none" aria-hidden="true" focusable="false">
      <path
        class="board-wire"
        d="M20 100h20m200 0h20M65 18v12m30-12v12m30-12v12m30-12v12m30-12v12m30-12v12M65 130v12m30-12v12m30-12v12m30-12v12m30-12v12m30-12v12"
      />
      <rect class="board-shell" x="37" y="32" width="206" height="96" rx="12" />
      <path class="board-lines" d="M53 48h174M53 112h174M53 53v54m174-54v54" />
      <rect class="board-chip" x="113" y="57" width="54" height="45" rx="7" />
      <path
        class="board-chip-lines"
        d="M126 65h28v29h-28Zm-8-11v-5m10 5v-5m11 5v-5m11 5v-5m11 5v-5m-43 56v5m10-5v5m11-5v5m11-5v5m11-5v5m-51-51h-5m5 11h-5m5 11h-5m68-22h5m-5 11h5m-5 11h5"
      />
      <g class="board-terminals">
        <rect x="54" y="26" width="23" height="15" rx="3" />
        <rect x="84" y="26" width="23" height="15" rx="3" />
        <rect x="114" y="26" width="23" height="15" rx="3" />
        <rect x="144" y="26" width="23" height="15" rx="3" />
        <rect x="174" y="26" width="23" height="15" rx="3" />
        <rect x="204" y="26" width="23" height="15" rx="3" />
        <rect x="54" y="119" width="23" height="15" rx="3" />
        <rect x="84" y="119" width="23" height="15" rx="3" />
        <rect x="114" y="119" width="23" height="15" rx="3" />
        <rect x="144" y="119" width="23" height="15" rx="3" />
        <rect x="174" y="119" width="23" height="15" rx="3" />
        <rect x="204" y="119" width="23" height="15" rx="3" />
      </g>
      <path
        class="board-traces"
        d="M72 63h23v14h15m-38 18h16V84h22m60-21h19v13h16m-35 13h21v10h14"
      />
      <circle class="board-led" cx="70" cy="80" r="3" />
      <circle class="board-led-secondary" cx="207" cy="60" r="3" />
      <path class="board-text" d="M191 87h18m-18 5h13m-13 5h16" />
    </svg>
  );
}
