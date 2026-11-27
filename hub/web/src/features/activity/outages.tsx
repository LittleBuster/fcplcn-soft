import type { DeviceOutage } from '../../../../shared/activity.js';
import { Empty } from '../../components/common';
import { activityDateTime, outageDuration } from './labels';

export function DeviceOutages({ outages, now }: { outages: DeviceOutage[]; now: string }) {
  if (!outages.length)
    return (
      <Empty
        icon="wifi"
        title="Записей о связи пока нет"
        detail="Здесь появятся время потери связи с PLC и время её восстановления."
      />
    );

  return (
    <div class="activity-records">
      {outages.map((outage) => (
        <article class="panel activity-record" key={outage.id} data-device-outage={outage.id}>
          <header class="activity-record-heading">
            <h2>{outage.deviceName || outage.deviceId}</h2>
            <span class={`activity-status ${outage.onlineAt ? 'outage-restored' : 'outage-open'}`}>
              {outage.onlineAt ? 'Связь восстановлена' : 'Нет связи'}
            </span>
          </header>
          <p class="activity-outage-reason">
            {outage.reason === 'availability'
              ? 'Брокер MQTT сообщил об отключении PLC'
              : 'Истёк срок ожидания данных PLC'}
          </p>
          <dl class="activity-facts">
            <div>
              <dt>Потеря связи</dt>
              <dd>
                <time dateTime={outage.offlineAt}>{activityDateTime(outage.offlineAt)}</time>
              </dd>
            </div>
            <div>
              <dt>Восстановление связи</dt>
              <dd>
                {outage.onlineAt ? (
                  <time dateTime={outage.onlineAt}>{activityDateTime(outage.onlineAt)}</time>
                ) : (
                  'Ожидается'
                )}
              </dd>
            </div>
            <div>
              <dt>Время без связи</dt>
              <dd>{outageDuration(outage.offlineAt, outage.onlineAt ?? now)}</dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}
