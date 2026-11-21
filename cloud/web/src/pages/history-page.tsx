/** @file Подтверждённые удалённые действия; журнал не содержит приватные настройки или прошивки. */
import type { CloudAudit } from '../../../shared/api.js';
import { Icon } from '../icons';
import { date } from '../lib/presentation';

export function HistoryPage({ history }: { history: CloudAudit[] }) {
  return (
    <section class="panel card">
      <h2>
        <Icon name="clock" />
        История облачных действий
      </h2>
      {history.length ? (
        <div class="audit-list">
          {history.map((event) => (
            <article class="audit-row" key={event.id}>
              <span class="audit-icon">
                <Icon
                  name={
                    event.status === 'applied' || event.status === 'completed' ? 'check' : 'clock'
                  }
                />
              </span>
              <div>
                <strong>{event.operation}</strong>
                <p>
                  {event.actorName} · {event.target}
                </p>
                {event.detail ? <small>{event.detail}</small> : null}
              </div>
              <span class="badge">{event.status}</span>
              <time>{date(event.at)}</time>
            </article>
          ))}
        </div>
      ) : (
        <div class="empty-history">
          <Icon name="clock" />
          <p>
            Здесь появятся действия пользователей и результаты команд. Секретные настройки и файлы
            прошивки в журнал не попадают.
          </p>
        </div>
      )}
    </section>
  );
}
