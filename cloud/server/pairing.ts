/** @file One-use, expiring home claims and individually revocable hub identities. */
import { createPublicKey, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CloudDatabase } from './db.js';
import { CloudError, label, only, uuid } from './errors.js';
import { digest } from './totp.js';
import type { CloudHomes } from './users.js';
import type { HubView } from '../shared/api.js';

export interface BrokerCredentials {
  username: string;
  password: string;
  brokerUrl: string;
  ca?: string;
}
export interface HubProvisioner {
  provision(hubId: string): Promise<BrokerCredentials>;
  revoke(hubId: string): Promise<unknown>;
}
export interface LiveHub {
  online: boolean;
  sessionId: string | null;
  lastSeenAt: string | null;
  snapshot: unknown;
}
export class CloudPairing {
  constructor(
    readonly db: CloudDatabase,
    readonly homes: CloudHomes,
    readonly provisioner: HubProvisioner,
    readonly live: (id: string) => LiveHub,
    readonly disconnectHub: (id: string) => void,
  ) {}
  async create(actor: string, homeId: string) {
    await this.homes.membership(actor, homeId, true);
    const code = randomBytes(10).toString('hex').toUpperCase();
    const row = (
      await this.db.query(
        "INSERT INTO cloud_pair_codes(code_hash,home_id,created_by,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes') RETURNING expires_at",
        [digest(code), homeId, actor],
      )
    ).rows[0];
    return { code: code.match(/.{1,4}/g)!.join('-'), expiresAt: row.expires_at.toISOString() };
  }
  async claim(input: Record<string, unknown>) {
    if (
      !only(input, ['code', 'installationId', 'name', 'publicKey']) ||
      typeof input.code !== 'string' ||
      !/^[0-9A-Fa-f-]{20,24}$/.test(input.code) ||
      typeof input.installationId !== 'string' ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(input.installationId) ||
      (input.name !== undefined && !label(input.name)) ||
      (input.publicKey !== undefined &&
        (typeof input.publicKey !== 'string' || input.publicKey.length > 4096))
    )
      throw new CloudError('Укажите код привязки и идентификатор хаба');
    if (input.publicKey) {
      try {
        createPublicKey(input.publicKey as string);
      } catch {
        throw new CloudError('Некорректный открытый ключ хаба');
      }
    }
    const normalized = input.code.replaceAll('-', '').toUpperCase();
    let provisioned: string | null = null;
    try {
      return await this.db.transaction(async (sql) => {
        let pair = (
          await sql.query(
            'SELECT * FROM cloud_pair_codes WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now()',
            [digest(normalized)],
          )
        ).rows[0];
        if (!pair) throw new CloudError('Код привязки неверен, использован или истёк', 404);
        await sql.query('SELECT id FROM cloud_homes WHERE id=$1 FOR UPDATE', [pair.home_id]);
        pair = (
          await sql.query(
            'SELECT * FROM cloud_pair_codes WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE',
            [digest(normalized)],
          )
        ).rows[0];
        if (!pair) throw new CloudError('Код привязки неверен, использован или истёк', 404);
        if (
          !(
            await sql.query(
              "SELECT 1 FROM cloud_members WHERE home_id=$1 AND user_id=$2 AND role='owner'",
              [pair.home_id, pair.created_by],
            )
          ).rowCount
        )
          throw new CloudError('Код привязки отозван', 404);
        if (
          (
            await sql.query(
              'SELECT 1 FROM cloud_hubs WHERE (home_id=$1 OR installation_id=$2) AND revoked_at IS NULL',
              [pair.home_id, input.installationId],
            )
          ).rowCount
        )
          throw new CloudError(
            'Дом или этот хаб уже привязан. Сначала отзовите прежнее подключение.',
            409,
          );
        const hubId = randomUUID();
        await sql.query(
          'INSERT INTO cloud_hubs(id,home_id,name,installation_id,public_key) VALUES($1,$2,$3,$4,$5)',
          [
            hubId,
            pair.home_id,
            input.name || 'FCPLCn Хаб',
            input.installationId,
            input.publicKey || null,
          ],
        );
        const broker = await this.provisioner.provision(hubId);
        provisioned = hubId;
        await sql.query('UPDATE cloud_hubs SET broker_secret_hash=$2 WHERE id=$1', [
          hubId,
          digest(broker.password),
        ]);
        await sql.query('UPDATE cloud_pair_codes SET used_at=now() WHERE code_hash=$1', [
          digest(normalized),
        ]);
        return { protocolVersion: 1, hubId, homeId: pair.home_id as string, broker };
      });
    } catch (error) {
      if (provisioned) await this.provisioner.revoke(provisioned).catch(() => {});
      throw error;
    }
  }
  async authorized(hubId: string): Promise<boolean> {
    if (!uuid(hubId)) return false;
    return Boolean(
      (await this.db.query('SELECT 1 FROM cloud_hubs WHERE id=$1 AND revoked_at IS NULL', [hubId]))
        .rowCount,
    );
  }
  async disconnect(input: Record<string, unknown>, authorization: unknown): Promise<void> {
    if (
      !only(input, ['hubId', 'installationId']) ||
      !uuid(input.hubId) ||
      typeof input.installationId !== 'string' ||
      typeof authorization !== 'string' ||
      !/^Bearer [A-Za-z0-9_-]{32,128}$/.test(authorization)
    )
      throw new CloudError('Необходима индивидуальная авторизация хаба', 401);
    const row = (
      await this.db.query(
        'SELECT broker_secret_hash,home_id FROM cloud_hubs WHERE id=$1 AND installation_id=$2',
        [input.hubId, input.installationId],
      )
    ).rows[0];
    const hash = digest(authorization.slice(7));
    if (
      !row?.broker_secret_hash ||
      row.broker_secret_hash.length !== hash.length ||
      !timingSafeEqual(Buffer.from(row.broker_secret_hash), Buffer.from(hash))
    )
      throw new CloudError('Необходима индивидуальная авторизация хаба', 401);
    await this.db.query(
      'UPDATE cloud_hubs SET revoked_at=coalesce(revoked_at,now()),snapshot=NULL WHERE id=$1',
      [input.hubId],
    );
    this.disconnectHub(input.hubId);
    await this.provisioner.revoke(input.hubId);
    await this.homes.audit(row.home_id, null, 'hub.disconnect', input.hubId, 'applied');
  }
  async active(homeId: string): Promise<string | null> {
    return (
      (
        await this.db.query(
          'SELECT id FROM cloud_hubs WHERE home_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
          [homeId],
        )
      ).rows[0]?.id || null
    );
  }
  async hubs(homeId: string): Promise<HubView[]> {
    return (
      await this.db.query(
        'SELECT id,home_id,name,revoked_at,last_seen_at FROM cloud_hubs WHERE home_id=$1 ORDER BY created_at DESC',
        [homeId],
      )
    ).rows.map((row) => {
      const live = this.live(row.id);
      return {
        id: row.id,
        homeId: row.home_id,
        name: row.name,
        revoked: Boolean(row.revoked_at),
        online: !row.revoked_at && live.online,
        lastSeenAt: live.lastSeenAt || row.last_seen_at?.toISOString() || null,
      };
    });
  }
  async revoke(actor: string, homeId: string, hubId: string): Promise<void> {
    await this.homes.membership(actor, homeId, true);
    if (!uuid(hubId)) throw new CloudError('Хаб не найден', 404);
    const result = await this.db.query(
      'UPDATE cloud_hubs SET revoked_at=coalesce(revoked_at,now()),snapshot=NULL WHERE id=$1 AND home_id=$2 RETURNING id',
      [hubId, homeId],
    );
    if (!result.rowCount) throw new CloudError('Хаб не найден', 404);
    this.disconnectHub(hubId);
    await this.provisioner.revoke(hubId);
    await this.homes.audit(homeId, actor, 'hub.revoke', hubId, 'applied');
  }
  async saveSnapshot(id: string, snapshot: unknown): Promise<void> {
    // Only public snapshots belong in PostgreSQL; private RPC replies never call this method.
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 2 * 1024 * 1024) return;
    await this.db.query(
      'UPDATE cloud_hubs SET snapshot=$2,snapshot_at=now(),last_seen_at=now() WHERE id=$1 AND revoked_at IS NULL',
      [id, JSON.stringify(snapshot)],
    );
  }
  async cached(homeId: string): Promise<unknown | null> {
    return (
      (
        await this.db.query(
          'SELECT snapshot FROM cloud_hubs WHERE home_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
          [homeId],
        )
      ).rows[0]?.snapshot || null
    );
  }
}
