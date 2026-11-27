import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { HubSnapshot } from '../../../../shared/types.js';
import { Icon } from '../../icons';
import { portal } from '../../portal';
import { DeviceConnectionHistory } from '../activity/connection-history';
import './network-summary.css';

export function PultNetworkSummary({
  snapshot,
  connected,
}: {
  snapshot: HubSnapshot;
  connected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const countId = useId();
  const statusId = useId();

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element?.showModal();
    return () => {
      if (element?.open) element.close();
    };
  }, [open]);

  const online = connected
    ? snapshot.devices.filter((device) => device.online && device.status === 'online').length
    : 0;
  const content = (
    <>
      <span class="pult-summary-icon">
        <Icon name="wifi" />
      </span>
      <span class="pult-network-content">
        <span class="pult-summary-label">Устройства</span>
        <strong id={countId}>
          {online}
          <span class="pult-summary-total"> / {snapshot.devices.length}</span>
        </strong>
        <small id={statusId}>
          {!connected
            ? 'Управление недоступно'
            : online === snapshot.devices.length && online > 0
              ? 'Все устройства на связи'
              : 'На связи с хабом'}
        </small>
        {!portal && (
          <span class="pult-network-action">
            Графики связи <Icon name="arrow" />
          </span>
        )}
      </span>
    </>
  );

  if (portal) {
    return (
      <section class="pult-summary-card pult-summary-network" aria-label="Связь с устройствами">
        {content}
      </section>
    );
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="pult-summary-card pult-summary-network pult-network-trigger"
        aria-label="Графики связи"
        aria-describedby={`${countId} ${statusId}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {content}
      </button>
      {open && (
        <dialog
          ref={dialog}
          class="pult-network-dialog"
          aria-labelledby={titleId}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus({ preventScroll: true });
          }}
        >
          <header class="pult-network-dialog-header">
            <h2 id={titleId}>
              <Icon name="activity" />
              Графики связи
            </h2>
            <button
              type="button"
              class="button secondary small"
              onClick={() => dialog.current?.close()}
            >
              Закрыть
            </button>
          </header>
          <DeviceConnectionHistory
            devices={snapshot.devices}
            outages={snapshot.outages ?? []}
            now={snapshot.now}
            titleId={titleId}
          />
        </dialog>
      )}
    </>
  );
}
