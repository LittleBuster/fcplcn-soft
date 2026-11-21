/** @file Explicit background OTA: download one verified cloud artifact, then use the existing LAN service. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import type { HubControl, DispatchResult } from '../control.js';
import { inspectFirmwareImage } from './image.js';

export interface CloudFirmwareOptions {
  control: Pick<HubControl, 'service' | 'snapshot' | 'overview' | 'holdMaintenance'>;
  origin(): string;
  hubId(): string;
  isActive(): boolean;
  connection(): string | null;
  dataDir: string;
  request?: typeof fetch;
}
export interface FirmwareJob {
  id: string;
  deviceId: string;
  state:
    'downloading' | 'uploading' | 'verifying' | 'restarting' | 'completed' | 'failed' | 'unknown';
  progress: number;
  transferred: number;
  size: number;
  version: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
interface Active {
  job: FirmwareJob;
  abort: AbortController;
  task: Promise<void>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const failure = (message: string, statusCode = 409) =>
  Object.assign(new Error(message), { statusCode });

/** A job is admitted once; neither transfer writes nor boot selection are replayed after disconnect. */
export class CloudFirmwareInstaller {
  private readonly jobs = new Map<string, FirmwareJob>();
  private active: Active | null = null;
  constructor(private readonly options: CloudFirmwareOptions) {
    const directory = join(options.dataDir, 'cloud-ota');
    if (existsSync(directory))
      for (const name of readdirSync(directory)) {
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.bin$/.test(name)) continue;
        try {
          unlinkSync(join(directory, name));
        } catch {
          /* Interrupted cache is never resumed. */
        }
      }
  }

  start(deviceId: string, body: Record<string, unknown>): DispatchResult {
    if (this.active) throw failure('Установка прошивки уже выполняется');
    if (!this.options.isActive() || !this.options.connection())
      throw failure('Нет свежего соединения с облаком', 503);
    if (
      Object.keys(body).some((key) => !['artifactId', 'ticket', 'size', 'sha256'].includes(key)) ||
      typeof body.artifactId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(body.artifactId) ||
      typeof body.ticket !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.ticket) ||
      !Number.isSafeInteger(body.size) ||
      Number(body.size) < 288 ||
      Number(body.size) > 6 * 1024 * 1024 ||
      typeof body.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.sha256)
    )
      throw failure('Некорректное задание обновления', 400);
    const device = this.options.control.snapshot().devices.find((row) => row.id === deviceId);
    if (!device?.online || !device.bootId || !device.management?.supported)
      throw failure('PLC недоступен или не поддерживает обновление', 503);
    const release = this.options.control.holdMaintenance();
    const job: FirmwareJob = {
      id: randomUUID(),
      deviceId,
      state: 'downloading',
      progress: 0,
      transferred: 0,
      size: Number(body.size),
      version: '',
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    while (this.jobs.size >= 32) this.jobs.delete(this.jobs.keys().next().value!);
    this.jobs.set(job.id, job);
    const abort = new AbortController();
    const active: Active = { job, abort, task: Promise.resolve() };
    this.active = active;
    active.task = this.run(active, body, device.bootId).finally(() => {
      release();
      if (this.active === active) this.active = null;
    });
    return { status: 202, data: { jobId: job.id, job: { ...job } } };
  }

  status(jobId: string): DispatchResult {
    if (jobId === 'active')
      return { status: 200, data: { job: this.active ? { ...this.active.job } : null } };
    const job = this.jobs.get(jobId);
    return job
      ? { status: 200, data: { job: { ...job } } }
      : { status: 404, data: { error: 'Задание обновления не найдено' } };
  }

  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.abort.abort();
    await active.task;
  }

  private async run(
    active: Active,
    body: Record<string, unknown>,
    originalBoot: string,
  ): Promise<void> {
    const { job, abort } = active;
    const origin = this.options.origin(),
      hubId = this.options.hubId(),
      connection = this.options.connection();
    const directory = join(this.options.dataDir, 'cloud-ota');
    const path = join(directory, job.id + '.bin');
    let uploadId = '',
      activating = false;
    const until = performance.now() + 300000;
    const changed = () =>
      !this.options.isActive() ||
      this.options.origin() !== origin ||
      this.options.hubId() !== hubId ||
      this.options.connection() !== connection;
    const guard = () => {
      if (abort.signal.aborted || performance.now() >= until || changed())
        throw failure('Задание остановлено: соединение с облаком изменилось');
    };
    const timer = setInterval(() => {
      if (changed() || performance.now() >= until) abort.abort();
    }, 250).unref();
    const update = (patch: Partial<FirmwareJob>) => {
      Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    };
    const rpc = async (
      method: 'GET' | 'POST',
      route: string,
      payload?: Record<string, unknown>,
    ) => {
      guard();
      const reply = await this.options.control.service(job.deviceId, method, route, payload, {
        signal: abort.signal,
        maintenance: true,
        remainingMs: Math.min(8000, until - performance.now()),
      });
      try {
        guard();
      } catch (error) {
        throw Object.assign(error as Error, { unknown: method === 'POST' });
      }
      if (reply.status >= 400 || !object(reply.data))
        throw Object.assign(
          failure(
            object(reply.data) && typeof reply.data.error === 'string'
              ? reply.data.error
              : 'PLC не подтвердил обновление',
            reply.status,
          ),
          { unknown: object(reply.data) && reply.data.unknown === true },
        );
      return reply.data;
    };
    try {
      guard();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = await open(path, 'wx', 0o600);
      const digest = createHash('sha256');
      try {
        const download = new URL('/api/v1/hub/firmware/' + body.artifactId, origin);
        let response: Response;
        try {
          response = await (this.options.request || fetch)(download, {
            headers: { Authorization: 'Bearer ' + body.ticket, 'X-FCPLCN-Hub': hubId },
            redirect: 'error',
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
          });
        } catch {
          throw failure('Не удалось загрузить файл из облака', 503);
        }
        if (
          !response.ok ||
          !response.body ||
          Number(response.headers.get('content-length')) !== job.size
        )
          throw failure('Облако не подтвердило файл обновления', 503);
        const reader = response.body.getReader();
        let received = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            guard();
            received += chunk.value.byteLength;
            if (received > job.size) throw failure('Размер загруженного приложения превышен', 400);
            const bytes = Buffer.from(chunk.value);
            let offset = 0;
            while (offset < bytes.length) {
              const saved = await file.write(bytes, offset, bytes.length - offset);
              if (!saved.bytesWritten) throw new Error('Write failed');
              offset += saved.bytesWritten;
            }
            digest.update(bytes);
            update({ transferred: received, progress: Math.floor((received / job.size) * 20) });
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (received !== job.size || digest.digest('hex') !== body.sha256)
          throw failure('SHA-256 или размер загруженного приложения не совпал', 400);
        await file.sync();
      } finally {
        await file.close();
      }
      const image = inspectFirmwareImage(
        await readFile(path),
        this.options.control.overview().product.name,
      );
      update({ version: image.version });
      guard();
      if (
        this.options.control.snapshot().devices.find((row) => row.id === job.deviceId)?.bootId !==
        originalBoot
      )
        throw failure('PLC перезапущен во время загрузки файла; повторите установку явно');
      const begun = await rpc('POST', '/firmware/begin', { size: job.size, sha256: body.sha256 });
      if (begun.ok !== true || typeof begun.uploadId !== 'string')
        throw failure('PLC не подтвердил начало обновления');
      uploadId = begun.uploadId;
      const chunkSize = Math.min(
        12288,
        Number.isSafeInteger(begun.chunkSize) && Number(begun.chunkSize) >= 288
          ? Number(begun.chunkSize)
          : 12288,
      );
      update({ state: 'uploading', transferred: 0, progress: 20 });
      const input = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(chunkSize);
        let offset = 0;
        while (offset < job.size) {
          guard();
          const chunk = await input.read(
            buffer,
            0,
            Math.min(buffer.length, job.size - offset),
            offset,
          );
          if (!chunk.bytesRead) throw failure('Временный файл прошивки повреждён');
          const received = offset + chunk.bytesRead;
          const reply = await rpc('POST', '/firmware/chunk', {
            uploadId,
            offset,
            data: buffer.subarray(0, chunk.bytesRead).toString('base64'),
          });
          if (reply.ok !== true || reply.received !== received)
            throw failure('PLC не подтвердил фрагмент приложения');
          offset = received;
          update({ transferred: received, progress: 20 + Math.floor((received / job.size) * 70) });
        }
      } finally {
        await input.close();
      }
      update({ state: 'verifying', progress: 90 });
      const pending = await rpc('GET', '/firmware');
      if (
        pending.targetImageId !== image.imageId ||
        typeof pending.targetPartition !== 'string' ||
        pending.received !== job.size
      )
        throw failure('PLC не подтвердил целиком переданное приложение');
      activating = true;
      try {
        const finished = await rpc('POST', '/firmware/finish', { uploadId });
        if (finished.ok !== true || finished.rebootRequired !== true)
          throw Object.assign(failure('PLC не подтвердил активацию приложения'), { unknown: true });
      } catch (error) {
        if (!(error as { unknown?: boolean }).unknown) {
          activating = false;
          throw error;
        }
      }
      update({ state: 'restarting', progress: 95 });
      const bootUntil = Math.min(until, performance.now() + 45000);
      while (performance.now() < bootUntil) {
        guard();
        try {
          const running = await rpc('GET', '/firmware');
          if (
            !running.pendingReboot &&
            running.imageId === image.imageId &&
            running.runningPartition === pending.targetPartition
          ) {
            update({ state: 'completed', progress: 100, error: null });
            return;
          }
          if (
            !running.pendingReboot &&
            this.options.control.snapshot().devices.find((row) => row.id === job.deviceId)
              ?.bootId !== originalBoot &&
            running.state === 'idle'
          )
            throw failure('PLC вернулся к другому образу после обновления', 422);
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode === 422) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      update({
        state: 'unknown',
        error: 'Не удалось подтвердить запуск нового образа; повторной активации не было',
      });
    } catch (error) {
      update({
        state:
          activating && (error as { statusCode?: number }).statusCode !== 422
            ? 'unknown'
            : 'failed',
        error:
          error instanceof Error &&
          typeof (error as { statusCode?: number }).statusCode === 'number'
            ? error.message.slice(0, 256)
            : 'Не удалось завершить установку прошивки',
      });
      if (uploadId && !activating) {
        await this.options.control
          .service(
            job.deviceId,
            'POST',
            '/firmware/abort',
            { uploadId },
            { signal: AbortSignal.timeout(5000), maintenance: true, remainingMs: 5000 },
          )
          .catch(() => {});
      }
    } finally {
      clearInterval(timer);
      await unlink(path).catch(() => {});
    }
  }
}
