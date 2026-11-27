import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { MeteoHistory, MeteoHistoryPeriod } from '../../../../shared/meteo-history.js';
import { api } from '../../api';
import { Icon } from '../../icons';
import { portal } from '../../portal';
import { MeteoHistoryChart } from './history-chart';
import './history.css';

interface SensorRef {
  deviceId: string;
  sensorId: string;
  name: string;
}

type RequestState =
  | { period: MeteoHistoryPeriod; history: MeteoHistory }
  | { period: MeteoHistoryPeriod; error: string };

const periods: Record<MeteoHistoryPeriod, string> = { day: '24 часа', week: '7 дней' };

function MeteoHistoryDialog({
  deviceId,
  sensorId,
  name,
  onClose,
}: SensorRef & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [period, setPeriod] = useState<MeteoHistoryPeriod>('day');
  const [result, setResult] = useState<RequestState | null>(null);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      if (element?.open) element.close();
    };
  }, []);

  useEffect(() => {
    setResult(null);
    const abort = new AbortController();
    const route = `/devices/${encodeURIComponent(deviceId)}/meteo/${encodeURIComponent(sensorId)}/history?period=${period}`;
    void api<MeteoHistory>(route, { signal: abort.signal })
      .then((history) => {
        if (!abort.signal.aborted) setResult({ period, history });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setResult({
            period,
            error: error instanceof Error ? error.message : 'Не удалось загрузить показания.',
          });
      });
    return () => abort.abort();
  }, [deviceId, sensorId, period]);

  const current = result?.period === period ? result : null;
  const history = current && 'history' in current ? current.history : null;
  const points = history?.points;
  const hasReadings = points?.some(
    (point) => point.temperatureC !== null || point.humidityPct !== null,
  );
  return (
    <dialog ref={dialog} class="meteo-history-dialog" onClose={onClose} aria-labelledby={title}>
      <header class="meteo-history-heading">
        <div>
          {history ? <p>{history.deviceName}</p> : null}
          <h2 id={title}>{history?.sensorName || name}</h2>
        </div>
        <button
          type="button"
          class="button secondary small"
          onClick={() => dialog.current?.close()}
        >
          Закрыть
        </button>
      </header>
      <div class="meteo-history-period" role="group" aria-label="Период графика">
        {(['day', 'week'] as const).map((choice) => (
          <button
            type="button"
            key={choice}
            class={`button small${choice === period ? '' : ' secondary'}`}
            aria-pressed={choice === period}
            onClick={() => setPeriod(choice)}
          >
            {periods[choice]}
          </button>
        ))}
      </div>
      {!current ? (
        <p class="meteo-history-status" role="status">
          Загружаем показания…
        </p>
      ) : 'error' in current ? (
        <p class="meteo-history-status inline-error" role="alert">
          {current.error}
        </p>
      ) : !hasReadings || !points ? (
        <p class="meteo-history-status" role="status">
          За этот период показаний пока нет.
        </p>
      ) : (
        <>
          <p class="meteo-history-caption">Каждая точка показывает среднее за час</p>
          <MeteoHistoryChart points={points} period={period} metric="temperatureC" />
          <MeteoHistoryChart points={points} period={period} metric="humidityPct" />
        </>
      )}
    </dialog>
  );
}

/** Open recorded readings even when the PLC is currently offline. */
export function MeteoHistoryButton(sensor: SensorRef) {
  const [open, setOpen] = useState(false);
  if (portal || !sensor.sensorId) return null;
  return (
    <>
      <button
        type="button"
        class="button secondary small meteo-history-trigger"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon name="activity" />
        График
      </button>
      {open ? <MeteoHistoryDialog {...sensor} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
