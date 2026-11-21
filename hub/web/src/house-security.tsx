/** @file Общий режим охраны и отдельные подтверждения PLC, включая недоступные устройства. */

import type { HouseSecurityView } from '../../shared/types.js';
import { Icon } from './icons';
import { time } from './model';
import './house-security.css';

/** Разделяет заданный режим дома, подтверждения PLC и фактические тревоги и задержки. */
export function HouseSecurityStatus({
  view,
  unavailable = false,
}: {
  view: HouseSecurityView | undefined;
  unavailable?: boolean;
}) {
  if (!view) return null;
  const eligible = view.devices.filter((device) => device.configured && device.enabled);
  const confirmed = unavailable ? [] : eligible.filter((device) => device.status === 'confirmed');
  const waiting = unavailable
    ? eligible
    : eligible.filter((device) => device.status !== 'confirmed');
  const rejected =
    view.desiredArmed !== null &&
    waiting.some((device) => ['rejected', 'unknown'].includes(device.status));
  const alarms = eligible.filter(
    (device) => !unavailable && device.online && device.phase === 'alarm',
  );
  const entering = eligible.filter(
    (device) => !unavailable && device.online && device.phase === 'entry_delay',
  );
  const exiting = eligible.filter(
    (device) => !unavailable && device.online && device.phase === 'exit_delay',
  );
  const phase = alarms.length
    ? 'alarm'
    : entering.length
      ? 'entry_delay'
      : exiting.length
        ? 'exit_delay'
        : 'stable';
  const remaining = Math.max(
    0,
    ...(entering.length ? entering : exiting).map((device) => device.remainingSeconds || 0),
  );
  const label =
    view.desiredArmed === null ? 'Режим не задан' : view.desiredArmed ? 'Ушел' : 'Я дома';
  const summary = unavailable
    ? 'Нет свежей связи. Показан последний заданный режим.'
    : alarms.length
      ? `Тревога на ${alarms.length} PLC`
      : entering.length
        ? 'Идёт время на снятие охраны'
        : exiting.length
          ? 'Идёт задержка постановки; действия сценария не ждут её окончания'
          : view.error
            ? 'Нужно проверить состояние'
            : view.desiredArmed === null
              ? 'Приложите таблетку или выберите сценарий'
              : view.busy
                ? 'Применяем режим охраны'
                : !eligible.length
                  ? 'Настройте охрану на PLC'
                  : !waiting.length
                    ? 'Режим принят всеми PLC'
                    : rejected
                      ? 'Частично подтверждено'
                      : 'Ожидаем часть PLC';
  const tone = unavailable
    ? 'neutral'
    : alarms.length
      ? 'alarm'
      : entering.length || view.error || rejected
        ? 'attention'
        : waiting.length || view.busy || exiting.length
          ? 'pending'
          : view.desiredArmed === null
            ? 'neutral'
            : 'confirmed';
  const statuses = {
    confirmed: 'Режим принят',
    pending: 'Ожидаем подтверждения',
    offline: 'Нет связи · применим при подключении',
    skipped: 'Модуль выключен',
    'not-configured': 'Охрана не настроена',
    unknown: 'Результат не подтверждён',
    rejected: 'PLC отклонил изменение',
  };
  const last = view.lastEvent;
  const source = last && view.devices.find((device) => device.deviceId === last.deviceId);

  /** Возвращает актуальную фазу конкретного PLC; устаревшие данные не выглядят подтверждением. */
  const phaseLabel = (device: HouseSecurityView['devices'][number]) => {
    if (unavailable || !device.online) return '';
    const seconds =
      typeof device.remainingSeconds === 'number' && device.remainingSeconds > 0
        ? ` · ${device.remainingSeconds} с`
        : '';
    return device.phase === 'alarm'
      ? 'Тревога'
      : device.phase === 'entry_delay'
        ? 'Время на снятие' + seconds
        : device.phase === 'exit_delay'
          ? 'Постановка на охрану' + seconds
          : device.status === 'confirmed' && device.phase === 'armed'
            ? 'Под охраной'
            : device.status === 'confirmed' && device.phase === 'disarmed'
              ? 'Охрана снята'
              : '';
  };

  return (
    <section
      class={`house-security panel ${tone}`}
      data-house-security
      data-house-stale={unavailable}
      data-house-phase={phase}
      data-house-mode={view.desiredArmed === null ? 'unset' : view.desiredArmed ? 'away' : 'home'}
    >
      <div class="house-security-heading">
        <span class="house-security-icon">
          <Icon name={alarms.length ? 'alarm' : 'shield'} />
        </span>
        <div class="house-security-title">
          <span class="eyebrow">Охрана всего дома</span>
          <h2>
            {label}
            {phase !== 'stable' ? (
              <span class="house-security-phase">
                {phase === 'alarm'
                  ? 'Тревога'
                  : phase === 'entry_delay'
                    ? 'Время на снятие'
                    : 'Постановка'}
                {phase !== 'alarm' && remaining > 0 ? ` · ${remaining} с` : ''}
              </span>
            ) : null}
          </h2>
          <p>{summary}</p>
        </div>
        <span class="house-security-count" data-house-security-count>
          {unavailable
            ? 'Нет свежих подтверждений'
            : `${confirmed.length} из ${eligible.length} PLC · режим принят`}
        </span>
      </div>
      {waiting.length && view.desiredArmed !== null ? (
        <p class="house-security-waiting" data-house-security-waiting>
          <Icon name="clock" />
          {waiting
            .slice(0, 3)
            .map((device) => device.name || device.deviceId)
            .join(', ')}
          {waiting.length > 3 ? ` и ещё ${waiting.length - 3}` : ''}
          <span>Подключившиеся PLC получат текущий режим.</span>
        </p>
      ) : null}
      {view.error ? <p class="house-security-error">{view.error}</p> : null}
      {last ? (
        <p class="house-security-event" data-house-security-event>
          <Icon name="key" />
          Таблетка {last.keyName || 'iButton'} · {source?.name || last.deviceId} · {time(last.at)}
        </p>
      ) : null}
      {view.devices.length ? (
        <details class="house-security-details">
          <summary>
            Подтверждения PLC <span>{view.devices.length}</span>
          </summary>
          <ul>
            {view.devices.map((device) => (
              <li
                key={device.deviceId}
                data-house-security-device={device.deviceId}
                data-house-security-status={unavailable ? 'offline' : device.status}
                data-house-security-phase={unavailable ? 'unknown' : device.phase || 'unknown'}
              >
                <span>{device.name || device.deviceId}</span>
                <span>
                  {unavailable ? (
                    'Нет свежих данных'
                  ) : phaseLabel(device) ? (
                    <>
                      {phaseLabel(device)}
                      {device.error ? (
                        <small>{device.error}</small>
                      ) : ['rejected', 'unknown'].includes(device.status) ? (
                        <small>{statuses[device.status]}</small>
                      ) : null}
                    </>
                  ) : (
                    device.error || statuses[device.status]
                  )}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
