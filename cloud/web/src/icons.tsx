/** @file Общие SVG-значки облачной панели FCPLCn: навигация, доступ и состояния. */
import type { ComponentChildren } from 'preact';

/** Закрытый набор имён, чтобы опечатка в значке обнаруживалась при сборке. */
type Name =
  | 'cloud'
  | 'home'
  | 'users'
  | 'hub'
  | 'shield'
  | 'arrow'
  | 'back'
  | 'logout'
  | 'check'
  | 'refresh'
  | 'key'
  | 'copy'
  | 'clock'
  | 'trash'
  | 'plus'
  | 'lock';

/** Геометрия значков в общей системе координат 24 × 24. */
const paths: Record<Name, ComponentChildren> = {
  cloud: (
    <>
      <path d="M6 18a5 5 0 1 1 1-10 7 7 0 0 1 13 2 4 4 0 0 1-1 8H6Z" />
      <path d="m9 14 3-3 3 3m-3-3v11" />
    </>
  ),
  home: (
    <>
      <path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 22v-3a7 7 0 0 1 14 0v3m1-18a4 4 0 0 1 0 8m2 3a6 6 0 0 1 3 5v2" />
    </>
  ),
  hub: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <rect x="8" y="8" width="8" height="8" rx="2" />
      <path d="M8 1v3m8-3v3M8 20v3m8-3v3M1 8h3m-3 8h3m16-8h3m-3 8h3" />
    </>
  ),
  shield: (
    <>
      <path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z" />
      <path d="m7 12 3 3 7-7" />
    </>
  ),
  arrow: <path d="M3 12h18m-7-7 7 7-7 7" />,
  back: <path d="M21 12H3m7-7-7 7 7 7" />,
  logout: <path d="M10 3H3v18h7m2-9h10m-4-4 4 4-4 4" />,
  check: <path d="m4 12 5 5L20 6" />,
  refresh: (
    <>
      <path d="M20 8a9 9 0 1 0 1 8M20 2v6h-6" />
    </>
  ),
  key: (
    <>
      <circle cx="7" cy="8" r="5" />
      <path d="m11 12 10 10m-4-4 3-3m-6 0 3-3" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 5v7l4 3" />
    </>
  ),
  trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />,
  plus: <path d="M12 3v18M3 12h18" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="12" rx="3" />
      <path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v3" />
    </>
  ),
};

/** Выводит декоративный значок; доступное название задаётся окружающему элементу. */
export function Icon({ name, class: className = '' }: { name: Name; class?: string }) {
  return (
    <svg
      class={`icon ${className}`}
      data-icon={name}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
