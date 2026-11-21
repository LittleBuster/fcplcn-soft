/**
 * @file Загрузка прошивки владельцем дома и наблюдение за установкой через хаб.
 * @description Браузер передаёт файл в облако; установку и проверку запуска выполняют хаб и PLC.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { HubSnapshot } from '../../../hub/shared/types.js';
import { api, APIError } from './api';
import './firmware.css';

/** Состояние одного задания установки, подтверждаемое хабом. */
interface Job {
  id: string;
  deviceId: string;
  state: string;
  progress: number;
  transferred: number;
  size: number;
  version: string;
  error: string | null;
}
/** Метаданные файла, уже принятого и проверенного облачным хранилищем. */
interface Artifact {
  id: string;
  size: number;
  sha256: string;
  version: string;
}

/** Дом и CSRF-токен текущего владельца, необходимые для загрузки файла. */
interface CloudFirmwarePanelProps {
  homeId: string;
  csrfToken: string | null;
}

/** Завершённые задания больше не блокируют запуск следующего обновления. */
const terminal = (job: Job) => ['completed', 'failed', 'unknown'].includes(job.state);

/** Подписи этапов: приём файла и подтверждённый запуск PLC показываются раздельно. */
const phases: Record<string, string> = {
  downloading: 'Хаб загружает файл из облака',
  uploading: 'Передача приложения в PLC',
  verifying: 'Проверка приложения на PLC',
  restarting: 'Перезапуск и проверка нового образа',
  completed: 'Новая прошивка запущена',
  failed: 'Обновление остановлено',
  unknown: 'Результат требует проверки',
};

/** Показывает выбор PLC, загрузку бинарника и фактический результат установки. */
export function CloudFirmwarePanel({ homeId, csrfToken }: CloudFirmwarePanelProps) {
  const [snapshot, setSnapshot] = useState<HubSnapshot | null>(null);
  const [deviceId, setDevice] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Refs сохраняют текущую операцию между рендерами и защищают от ответа после ухода.
  const alive = useRef(true);
  const xhr = useRef<XMLHttpRequest | null>(null);
  const jobId = useRef('');
  const polling = useRef(false);
  const uploadingRef = useRef(false);
  uploadingRef.current = uploading;

  const key = 'fcplcn-cloud-firmware:' + homeId;

  /** Читает состояния PLC и задания без параллельных опросов и повторной отправки файла. */
  const refresh = async () => {
    if (polling.current || uploadingRef.current) return;
    polling.current = true;
    setLoading(true);
    try {
      const state = await api<HubSnapshot>('/homes/' + homeId + '/hub/overview');
      if (!alive.current) return;
      setSnapshot(state);
      const response = await api<{ job: Job | null }>(
        '/homes/' + homeId + '/firmware/jobs/' + (jobId.current || 'active'),
      );
      if (!alive.current) return;
      if (response.job) {
        setJob(response.job);
        jobId.current = response.job.id;
        sessionStorage.setItem(key, response.job.id);
        if (response.job.state === 'completed') setError('');
      }
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : 'Нет связи с хабом');
    } finally {
      polling.current = false;
      if (alive.current) setLoading(false);
    }
  };

  // После возврата на страницу восстанавливается только наблюдение за заданием, не установка.
  useEffect(() => {
    alive.current = true;
    jobId.current = sessionStorage.getItem(key) || '';
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 1500);
    return () => {
      alive.current = false;
      clearInterval(timer);
      xhr.current?.abort();
    };
  }, [homeId]);

  const active = uploading || Boolean(job && !terminal(job));
  const devices = snapshot?.devices || [];

  /**
   * Загружает файл один раз; XHR нужен для прогресса передачи и явной отмены.
   * @param selected Бинарник приложения, выбранный пользователем.
   * @returns Метаданные облачного артефакта для отдельного запроса установки.
   */
  const stage = (selected: File) =>
    new Promise<Artifact>((resolve, reject) => {
      const request = new XMLHttpRequest();
      xhr.current = request;
      request.open('POST', '/api/v1/homes/' + homeId + '/firmware');
      request.withCredentials = true;
      request.timeout = 125000;
      request.setRequestHeader('Content-Type', 'application/octet-stream');
      request.setRequestHeader('X-FCPLCN-CSRF', csrfToken || '');
      request.upload.onprogress = (event) => {
        if (alive.current && event.lengthComputable)
          setUploadProgress(Math.floor((event.loaded / event.total) * 100));
      };
      request.onload = () => {
        let data: Artifact & { error?: string };
        try {
          data = JSON.parse(request.responseText);
        } catch {
          reject(new Error('Облако не подтвердило файл'));
          return;
        }
        if (request.status === 401) window.dispatchEvent(new Event('fcplcn:session-ended'));
        if (request.status < 200 || request.status >= 300)
          reject(new APIError(data.error || 'Файл не принят', request.status));
        else resolve(data);
      };
      request.onerror = () => reject(new Error('Передача файла в облако прервана'));
      request.ontimeout = () => reject(new Error('Истёк срок загрузки файла'));
      request.onabort = () => reject(new Error('Загрузка файла отменена'));
      request.send(selected);
    });

  return (
    <section class="cloud-firmware panel" data-cloud-firmware>
      <div class="cloud-firmware-heading">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <rect x="8" y="8" width="16" height="16" rx="4" />
          <path d="M12 2v6m8-6v6M12 24v6m8-6v6M2 12h6m-6 8h6m16-8h6m-6 8h6M16 11v10m-4-4 4 4 4-4" />
        </svg>
        <div>
          <h2>Прошивка PLC</h2>
          <p>Файл загружается в облако, хаб проверяет и передаёт его контроллеру.</p>
        </div>
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (active || !file || !deviceId || !csrfToken) return;
          if (!/\.bin$/i.test(file.name) || file.size < 288 || file.size > 6 * 1024 * 1024) {
            setError('Выберите бинарник приложения FCPLCn.bin размером до 6 МБ');
            return;
          }
          if (
            !window.confirm(
              'Обновить выбранный PLC? После проверки файла он перезагрузится. Сохранённые настройки останутся.',
            )
          )
            return;
          setUploading(true);
          setUploadProgress(0);
          setError('');
          setJob(null);
          try {
            const artifact = await stage(file);
            if (!alive.current) return;
            const result = await api<{ jobId: string; job: Job }>(
              '/homes/' + homeId + '/firmware/' + artifact.id + '/install',
              { deviceId },
            );
            if (!alive.current) return;
            jobId.current = result.jobId;
            sessionStorage.setItem(key, result.jobId);
            setJob(result.job);
          } catch (failure) {
            if (alive.current)
              setError(failure instanceof Error ? failure.message : 'Обновление не принято');
          } finally {
            if (alive.current) setUploading(false);
            xhr.current = null;
          }
        }}
      >
        <div class="cloud-firmware-fields">
          <label>
            Контроллер
            <select
              value={deviceId}
              disabled={active}
              required
              onChange={(event) => setDevice(event.currentTarget.value)}
            >
              <option value="">Выберите PLC</option>
              {devices.map((device) => (
                <option
                  key={device.id}
                  value={device.id}
                  disabled={!device.online || !device.management?.supported}
                >
                  {device.name || device.id}
                  {device.online ? '' : ' · нет связи'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Файл приложения
            <input
              type="file"
              accept=".bin,application/octet-stream"
              disabled={active}
              onChange={(event) => setFile(event.currentTarget.files?.[0] || null)}
            />
          </label>
        </div>
        <p class="cloud-firmware-hint">
          Используйте FCPLCn.bin для ESP32-S3. На время перезапуска управление этим PLC прервётся;
          конфигурация и состояния сохранятся.
        </p>
        {uploading || job ? (
          <div class="cloud-firmware-progress" role="status">
            <progress max="100" value={uploading ? uploadProgress : job?.progress || 0} />
            <strong>
              {uploading
                ? `Загрузка в облако: ${uploadProgress}%`
                : phases[job?.state || ''] || 'Проверка задания'}
            </strong>
            {job?.version ? <span>Версия {job.version}</span> : null}
          </div>
        ) : null}
        {error || job?.error ? (
          <div class="notice error" role="alert">
            {error || job?.error}
          </div>
        ) : null}
        {job?.state === 'completed' ? (
          <div class="notice success">PLC подтвердил новый образ и загрузочный раздел.</div>
        ) : null}
        <div class="cloud-firmware-actions">
          <button class="button" disabled={active || !file || !deviceId}>
            Загрузить и обновить
          </button>
          {uploading ? (
            <button type="button" class="button secondary" onClick={() => xhr.current?.abort()}>
              Отменить загрузку
            </button>
          ) : null}
          <button
            type="button"
            class="button secondary"
            disabled={loading || uploading}
            onClick={() => void refresh()}
          >
            Проверить статус
          </button>
        </div>
      </form>
    </section>
  );
}
