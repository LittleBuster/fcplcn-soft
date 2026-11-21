/** @file Подключение и отзыв Linux-хаба, название дома и одноразовый код привязки. */
import type { HomeDetail, HomeView, HubView, PairingView } from '../../../shared/api.js';
import type { CloudAction } from '../app/types';
import type { useConnectionDraft } from '../hooks/use-home-drafts';
import { Icon } from '../icons';
import { copy, date } from '../lib/presentation';

interface ConnectionPageProps {
  home: HomeView;
  detail: HomeDetail | null;
  owner: boolean;
  activeHub: HubView | undefined;
  busy: boolean;
  act: CloudAction;
  draft: ReturnType<typeof useConnectionDraft>;
}

export function ConnectionPage({
  home,
  detail,
  owner,
  activeHub,
  busy,
  act,
  draft,
}: ConnectionPageProps) {
  const { homeName, setHomeName, pairing, setPairing } = draft;
  return (
    <div class="connection-grid">
      <article class="panel card">
        <h2>
          <Icon name="cloud" />
          Связь дома с облаком
        </h2>
        <p>
          Локальный хаб открывает исходящее защищённое соединение. Открывать домашнюю сеть снаружи
          не требуется.
        </p>
        {detail?.hubs.length ? (
          <div class="hub-list">
            {detail.hubs.map((hub) => (
              <div class={'hub-row ' + (hub.revoked ? 'revoked' : '')} key={hub.id}>
                <span class="hub-art">
                  <Icon name="hub" />
                </span>
                <div>
                  <strong>{hub.name || 'Linux-хаб'}</strong>
                  <span>
                    {hub.revoked ? 'Доступ отозван' : hub.online ? 'На связи' : 'Не в сети'}
                  </span>
                  <small>Последние данные: {date(hub.lastSeenAt)}</small>
                </div>
                {owner && !hub.revoked ? (
                  <button
                    class="icon-button danger"
                    aria-label={'Отозвать хаб ' + hub.name}
                    disabled={busy}
                    onClick={async () => {
                      if (
                        window.confirm(
                          'Отозвать облачный доступ этого хаба? Локальная работа сохранится.',
                        )
                      )
                        try {
                          await act(
                            '/homes/' + home.id + '/hubs/' + hub.id,
                            {},
                            'DELETE',
                            'Доступ хаба отозван.',
                          );
                        } catch {}
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p class="muted">Хаб ещё не привязан.</p>
        )}
        {owner ? (
          <>
            <label>
              Название дома
              <input
                value={homeName}
                onInput={(event) => setHomeName(event.currentTarget.value)}
                maxLength={96}
              />
            </label>
            <button
              class="button secondary"
              disabled={busy || !homeName.trim() || homeName === home.name}
              onClick={() =>
                void act(
                  '/homes/' + home.id,
                  { name: homeName.trim() },
                  'PATCH',
                  'Название дома сохранено.',
                ).catch(() => {})
              }
            >
              Сохранить название
            </button>
          </>
        ) : null}
      </article>
      <article class="panel card">
        <h2>
          <Icon name="key" />
          Привязка локального хаба
        </h2>
        {owner ? (
          <>
            <ol class="setup-steps">
              <li>Получите одноразовый код.</li>
              <li>Откройте локальную панель Linux-хаба.</li>
              <li>В разделе «Облако» введите адрес этой панели и код.</li>
            </ol>
            <button
              class="button"
              disabled={busy || Boolean(activeHub)}
              onClick={async () => {
                try {
                  const value = await act<PairingView>('/homes/' + home.id + '/pairing', {});
                  if (value) setPairing(value);
                } catch {}
              }}
            >
              <Icon name="plus" />
              Получить код привязки
            </button>
            {activeHub ? (
              <p class="hint">Для замены хаба сначала отзовите доступ текущего.</p>
            ) : null}
            {pairing ? (
              <div class="pair-code">
                <span>Код привязки</span>
                <code>{pairing.code}</code>
                <button class="button secondary small" onClick={() => void copy(pairing.code)}>
                  <Icon name="copy" />
                  Скопировать
                </button>
                <small>Действует до {date(pairing.expiresAt)}</small>
              </div>
            ) : null}
            <label>
              Адрес облака
              <input value={window.location.origin} readOnly />
            </label>
          </>
        ) : (
          <p>Привязкой и заменой хаба управляет владелец дома.</p>
        )}
        <div class="local-note">
          <Icon name="shield" />
          <p>
            При потере интернета PLC сохраняют локальные функции, а хаб — сценарии и расписания.
          </p>
        </div>
      </article>
    </div>
  );
}
