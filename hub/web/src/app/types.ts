/** @file Типы навигации и единственного уведомления панели хаба. */
export type View =
  'overview' | 'devices' | 'activity' | 'scenes' | 'telegram' | 'cloud' | 'account';
export type Notice = { tone: 'success' | 'error' | 'warning'; text: string };
