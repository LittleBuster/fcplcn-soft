/** @file Private bounded firmware staging and one-use hub downloads, separate from MQTT telemetry. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createReadStream,
  constants,
  mkdirSync,
  readdirSync,
  readFileSync,
  lstatSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  chmodSync,
} from 'node:fs';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { CloudError, uuid } from './errors.js';
import { inspectFirmwareImage } from '../../hub/server/cloud/image.js';

export interface ArtifactView {
  id: string;
  size: number;
  sha256: string;
  version: string;
  imageId: string;
  expiresAt: string;
}
interface Artifact extends ArtifactView {
  homeId: string;
}
interface Ticket {
  artifactId: string;
  hubId: string;
  until: number;
}
const MAX_IMAGE = 6 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_FILES = 512;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Only authenticated home owners upload; download tickets expose an app binary and no settings. */
export class CloudArtifacts {
  private readonly directory: string;
  private readonly records = new Map<string, Artifact>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly uploading = new Map<string, { size: number; homeId: string }>();
  constructor(
    directory: string,
    private readonly productName = 'FCPLCn',
    private readonly now = Date.now,
  ) {
    this.directory = join(directory, 'firmware');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    // Inspect every manifest before orphan cleanup; directory order is not a retention policy.
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith('.json') || !uuid(name.slice(0, -5))) continue;
      try {
        const file = join(this.directory, name),
          stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) continue;
        const row = JSON.parse(readFileSync(file, 'utf8')) as Artifact;
        if (!row || row.id !== name.slice(0, -5) || !uuid(row.id)) continue;
        const binary = lstatSync(join(this.directory, row.id + '.bin'));
        if (
          uuid(row.id) &&
          uuid(row.homeId) &&
          Number.isSafeInteger(row.size) &&
          row.size >= 288 &&
          row.size <= MAX_IMAGE &&
          typeof row.sha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(row.sha256) &&
          typeof row.imageId === 'string' &&
          /^[a-f0-9]{64}$/.test(row.imageId) &&
          typeof row.version === 'string' &&
          row.version.length <= 32 &&
          Number.isFinite(Date.parse(row.expiresAt)) &&
          binary.isFile() &&
          !binary.isSymbolicLink() &&
          binary.size === row.size
        )
          this.records.set(row.id, row);
      } catch {
        /* Corrupt staging data is never served or silently treated as a valid release. */
      }
    }
    // This private cache has one process owner; interrupted UUID staging is disposable.
    for (const name of readdirSync(this.directory)) {
      const match = /^([a-f0-9-]{36})(\.part|\.json\.tmp|\.bin|\.json)$/.exec(name);
      if (!match || !uuid(match[1])) continue;
      if (['.part', '.json.tmp'].includes(match[2]) || !this.records.has(match[1])) {
        try {
          unlinkSync(join(this.directory, name));
        } catch {
          /* Already removed. */
        }
      }
    }
    this.expire();
  }
  private expire(): void {
    for (const [id, row] of this.records)
      if (Date.parse(row.expiresAt) <= this.now()) {
        this.records.delete(id);
        for (const extension of ['.bin', '.json'])
          try {
            unlinkSync(join(this.directory, id + extension));
          } catch {
            /* Already removed. */
          }
      }
    for (const [id, ticket] of this.tickets)
      if (ticket.until <= this.now()) this.tickets.delete(id);
  }
  private public(row: Artifact): ArtifactView {
    return {
      id: row.id,
      size: row.size,
      sha256: row.sha256,
      version: row.version,
      imageId: row.imageId,
      expiresAt: row.expiresAt,
    };
  }
  async upload(request: IncomingMessage, homeId: string): Promise<ArtifactView> {
    this.expire();
    if (!uuid(homeId)) throw new CloudError('Дом не найден', 404);
    const size = Number(request.headers['content-length']);
    if (
      request.headers['content-type']?.split(';')[0] !== 'application/octet-stream' ||
      !Number.isSafeInteger(size) ||
      size < 288 ||
      size > MAX_IMAGE
    )
      throw new CloudError('Загрузите бинарник приложения размером до 6 МБ', 413);
    const homeCount = [...this.records.values(), ...this.uploading.values()].filter(
      (row) => row.homeId === homeId,
    ).length;
    if (
      this.uploading.size >= 2 ||
      homeCount >= 5 ||
      this.records.size + this.uploading.size >= MAX_FILES
    )
      throw new CloudError('Дождитесь загрузки или истечения срока предыдущих файлов', 429);
    const total = [...this.records.values(), ...this.uploading.values()].reduce(
      (sum, row) => sum + row.size,
      0,
    );
    if (total + size > MAX_TOTAL) throw new CloudError('Лимит временных прошивок исчерпан', 429);
    const id = randomUUID(),
      temporary = join(this.directory, id + '.part');
    this.uploading.set(id, { size, homeId });
    let file: FileHandle | undefined;
    const timer = setTimeout(() => request.destroy(new Error('Firmware upload timed out')), 120000);
    const digest = createHash('sha256');
    let received = 0;
    try {
      file = await open(temporary, 'wx', 0o600);
      for await (const value of request) {
        const bytes = Buffer.from(value as Uint8Array);
        received += bytes.length;
        if (received > size || received > MAX_IMAGE)
          throw new CloudError('Размер файла превышает заявленный', 413);
        let offset = 0;
        while (offset < bytes.length) {
          const written = await file.write(bytes, offset, bytes.length - offset);
          if (!written.bytesWritten) throw new Error('Could not write firmware');
          offset += written.bytesWritten;
        }
        digest.update(bytes);
      }
      if (received !== size || request.aborted) throw new CloudError('Передача файла прервана');
      await file.sync();
      await file.close();
      const image = await readFile(temporary);
      let metadata;
      try {
        metadata = inspectFirmwareImage(image, this.productName);
      } catch (error) {
        throw new CloudError(
          error instanceof Error ? error.message : 'Бинарник не прошёл проверку',
        );
      }
      const row: Artifact = {
        id,
        homeId,
        size,
        sha256: digest.digest('hex'),
        ...metadata,
        expiresAt: new Date(this.now() + 3600000).toISOString(),
      };
      await rename(temporary, join(this.directory, id + '.bin'));
      const metadataFile = join(this.directory, id + '.json.tmp');
      writeFileSync(metadataFile, JSON.stringify(row), { mode: 0o600, flag: 'wx' });
      renameSync(metadataFile, join(this.directory, id + '.json'));
      this.records.set(id, row);
      return this.public(row);
    } catch (error) {
      if (file) await file.close().catch(() => {});
      for (const suffix of ['.part', '.bin', '.json.tmp'])
        await unlink(join(this.directory, id + suffix)).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      this.uploading.delete(id);
    }
  }
  issue(id: string, homeId: string, hubId: string): { artifact: ArtifactView; ticket: string } {
    this.expire();
    const row = this.records.get(id);
    if (!row || row.homeId !== homeId) throw new CloudError('Файл прошивки не найден', 404);
    if (this.tickets.size >= 128) throw new CloudError('Слишком много операций загрузки', 429);
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(hash(ticket), { artifactId: id, hubId, until: this.now() + 120000 });
    return { artifact: this.public(row), ticket };
  }
  download(id: string, token: string, hubId: string) {
    this.expire();
    if (!uuid(id) || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new CloudError('Загрузка не разрешена', 403);
    const key = hash(token),
      ticket = this.tickets.get(key),
      row = this.records.get(id);
    if (!ticket || !row || ticket.artifactId !== id || ticket.hubId !== hubId)
      throw new CloudError('Загрузка не разрешена', 403);
    this.tickets.delete(key);
    const descriptor = openSync(
      join(this.directory, id + '.bin'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      return {
        stream: createReadStream('', { fd: descriptor, autoClose: true }),
        size: row.size,
        sha256: row.sha256,
      };
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }
}
