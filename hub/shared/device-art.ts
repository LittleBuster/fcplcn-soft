/** @file Canonical device-card illustrations shared by the LAN hub and the cloud portal. */
export const deviceIllustrations = [
  { id: 'board', label: 'Контроллер PLC', group: 'Общие' },
  { id: 'house', label: 'Дом', group: 'Общие' },
  { id: 'apartment', label: 'Квартира', group: 'Общие' },
  { id: 'cottage', label: 'Дача', group: 'Общие' },
  { id: 'living-room', label: 'Гостиная', group: 'Помещения' },
  { id: 'bedroom', label: 'Спальня', group: 'Помещения' },
  { id: 'kitchen', label: 'Кухня', group: 'Помещения' },
  { id: 'bathroom', label: 'Ванная', group: 'Помещения' },
  { id: 'hallway', label: 'Прихожая', group: 'Помещения' },
  { id: 'kids-room', label: 'Детская', group: 'Помещения' },
  { id: 'office', label: 'Кабинет', group: 'Помещения' },
  { id: 'balcony', label: 'Балкон', group: 'Помещения' },
  { id: 'garage', label: 'Гараж', group: 'Помещения' },
  { id: 'boiler-room', label: 'Котельная', group: 'Помещения' },
  { id: 'electrical-panel', label: 'Электрощит', group: 'Оборудование' },
  { id: 'workshop', label: 'Мастерская', group: 'Помещения' },
  { id: 'utility-room', label: 'Подсобное помещение', group: 'Помещения' },
  { id: 'sauna', label: 'Баня и сауна', group: 'Помещения' },
  { id: 'greenhouse', label: 'Теплица', group: 'Участок' },
  { id: 'garden', label: 'Сад', group: 'Участок' },
  { id: 'irrigation', label: 'Полив', group: 'Оборудование' },
  { id: 'gates', label: 'Ворота', group: 'Участок' },
  { id: 'outdoor-lighting', label: 'Уличное освещение', group: 'Оборудование' },
  { id: 'well', label: 'Колодец / скважина', group: 'Оборудование' },
  { id: 'water-tank', label: 'Бак с водой', group: 'Оборудование' },
  { id: 'septic', label: 'Септик', group: 'Оборудование' },
  { id: 'pool', label: 'Бассейн', group: 'Участок' },
  { id: 'terrace', label: 'Терраса', group: 'Участок' },
  { id: 'security', label: 'Охрана', group: 'Оборудование' },
  { id: 'ventilation', label: 'Вентиляция', group: 'Оборудование' },
] as const;

export type DeviceIllustrationId = (typeof deviceIllustrations)[number]['id'];
export const DEFAULT_DEVICE_ILLUSTRATION: DeviceIllustrationId = 'board';
const illustrationIds = new Set<string>(deviceIllustrations.map(({ id }) => id));

/** Accept catalog identities only; user-controlled file paths, SVG markup and URLs are unsupported. */
export function isDeviceIllustrationId(value: unknown): value is DeviceIllustrationId {
  return typeof value === 'string' && illustrationIds.has(value);
}
