/** @file Home-scoped membership, invitation and audit transactions. */
import { randomBytes, randomUUID } from 'node:crypto';
import type { CloudRole, CloudUser, HomeDetail, HomeView, MemberView } from '../shared/api.js';
import { CloudDatabase, type SQL } from './db.js';
import { CloudError, email, label, object, only, uuid } from './errors.js';
import { digest } from './totp.js';
import type { CloudAuth } from './auth.js';

interface Membership {
  id: string;
  name: string;
  role: CloudRole;
  security_control: boolean;
}
export const homeView = (row: Membership): HomeView => ({
  id: row.id,
  name: row.name,
  role: row.role,
  securityControl: row.role === 'owner' || row.security_control,
});
export class CloudHomes {
  constructor(
    readonly db: CloudDatabase,
    readonly auth: CloudAuth,
  ) {}
  async membership(
    userId: string,
    homeId: string,
    owner = false,
    sql: SQL = this.db,
  ): Promise<HomeView> {
    if (!uuid(homeId)) throw new CloudError('Дом не найден', 404);
    const row = (
      await sql.query<Membership>(
        'SELECT h.id,h.name,m.role,m.security_control FROM cloud_homes h JOIN cloud_members m ON m.home_id=h.id WHERE h.id=$1 AND m.user_id=$2',
        [homeId, userId],
      )
    ).rows[0];
    if (!row) throw new CloudError('Дом не найден', 404);
    if (owner && row.role !== 'owner')
      throw new CloudError('Действие доступно владельцу дома', 403);
    return homeView(row);
  }
  async list(userId: string): Promise<HomeView[]> {
    return (
      await this.db.query<Membership>(
        'SELECT h.id,h.name,m.role,m.security_control FROM cloud_homes h JOIN cloud_members m ON m.home_id=h.id WHERE m.user_id=$1 ORDER BY h.created_at,h.id',
        [userId],
      )
    ).rows.map(homeView);
  }
  async create(userId: string, name: unknown): Promise<HomeView> {
    if (!label(name)) throw new CloudError('Укажите название дома до 96 байт');
    return this.db.transaction(async (sql) => {
      await sql.query('SELECT id FROM cloud_users WHERE id=$1 FOR UPDATE', [userId]);
      if (
        Number(
          (
            await sql.query(
              "SELECT count(*) FROM cloud_members WHERE user_id=$1 AND role='owner'",
              [userId],
            )
          ).rows[0].count,
        ) >= 32
      )
        throw new CloudError('Достигнут предел домов', 409);
      const id = randomUUID();
      await sql.query('INSERT INTO cloud_homes(id,name) VALUES($1,$2)', [id, name.trim()]);
      await sql.query(
        "INSERT INTO cloud_members(home_id,user_id,role,security_control) VALUES($1,$2,'owner',true)",
        [id, userId],
      );
      return { id, name: name.trim(), role: 'owner', securityControl: true };
    });
  }
  async rename(userId: string, homeId: string, name: unknown): Promise<HomeView> {
    await this.membership(userId, homeId, true);
    if (!label(name)) throw new CloudError('Укажите название дома до 96 байт');
    await this.db.query('UPDATE cloud_homes SET name=$2 WHERE id=$1', [homeId, name.trim()]);
    return this.membership(userId, homeId);
  }
  async members(userId: string, homeId: string): Promise<MemberView[]> {
    await this.membership(userId, homeId, true);
    return (
      await this.db.query<{
        user_id: string;
        username: string;
        email: string | null;
        name: string;
        role: CloudRole;
        security_control: boolean;
      }>(
        'SELECT m.user_id,u.username,u.email,u.name,m.role,m.security_control FROM cloud_members m JOIN cloud_users u ON u.id=m.user_id WHERE m.home_id=$1 ORDER BY u.name,u.id',
        [homeId],
      )
    ).rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      email: row.email,
      name: row.name,
      role: row.role,
      securityControl: row.role === 'owner' || row.security_control,
    }));
  }
  async updateMember(
    actor: string,
    homeId: string,
    userId: string,
    patch: unknown,
    remove = false,
  ): Promise<void> {
    if (!uuid(userId)) throw new CloudError('Пользователь не найден', 404);
    if (
      !remove &&
      (!object(patch) ||
        !only(patch, ['role', 'securityControl']) ||
        !['owner', 'operator', 'viewer'].includes(String(patch.role)) ||
        typeof patch.securityControl !== 'boolean')
    )
      throw new CloudError('Укажите роль и доступ к охране');
    await this.db.transaction(async (sql) => {
      await sql.query('SELECT id FROM cloud_homes WHERE id=$1 FOR UPDATE', [homeId]);
      await this.membership(actor, homeId, true, sql);
      const current = (
        await sql.query('SELECT role FROM cloud_members WHERE home_id=$1 AND user_id=$2', [
          homeId,
          userId,
        ])
      ).rows[0];
      if (!current) throw new CloudError('Пользователь не найден', 404);
      if (current.role === 'owner' && (remove || (patch as { role: string }).role !== 'owner')) {
        const count = Number(
          (
            await sql.query(
              "SELECT count(*) FROM cloud_members WHERE home_id=$1 AND role='owner'",
              [homeId],
            )
          ).rows[0].count,
        );
        if (count <= 1) throw new CloudError('У дома должен остаться хотя бы один владелец', 409);
      }
      if (remove)
        await sql.query('DELETE FROM cloud_members WHERE home_id=$1 AND user_id=$2', [
          homeId,
          userId,
        ]);
      else {
        const value = patch as { role: CloudRole; securityControl: boolean };
        await sql.query(
          'UPDATE cloud_members SET role=$3,security_control=$4 WHERE home_id=$1 AND user_id=$2',
          [
            homeId,
            userId,
            value.role,
            value.role === 'owner' || (value.role === 'operator' && value.securityControl),
          ],
        );
      }
      if (current.role === 'owner' && (remove || (patch as { role: string }).role !== 'owner')) {
        await sql.query(
          'DELETE FROM cloud_invites WHERE home_id=$1 AND created_by=$2 AND consumed_at IS NULL',
          [homeId, userId],
        );
        await sql.query(
          'DELETE FROM cloud_pair_codes WHERE home_id=$1 AND created_by=$2 AND used_at IS NULL',
          [homeId, userId],
        );
      }
    });
    await this.audit(homeId, actor, remove ? 'member.remove' : 'member.update', userId, 'applied');
  }
  async invite(userId: string, homeId: string, input: Record<string, unknown>, origin: string) {
    await this.membership(userId, homeId, true);
    if (
      !only(input, ['email', 'role', 'securityControl']) ||
      !['owner', 'operator', 'viewer'].includes(String(input.role)) ||
      typeof input.securityControl !== 'boolean'
    )
      throw new CloudError('Укажите роль приглашённого пользователя');
    const address = input.email === undefined || input.email === '' ? null : email(input.email);
    const token = randomBytes(32).toString('base64url');
    const result = await this.db.query(
      "INSERT INTO cloud_invites(token_hash,home_id,email,role,security_control,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days') RETURNING expires_at",
      [
        digest(token),
        homeId,
        address,
        input.role,
        input.role === 'owner' || (input.role === 'operator' && input.securityControl),
        userId,
      ],
    );
    await this.audit(homeId, userId, 'invite.create', 'invitation', 'applied');
    return {
      token,
      url: `${origin}/?invite=${token}`,
      expiresAt: result.rows[0].expires_at.toISOString(),
    };
  }
  async invitation(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new CloudError('Приглашение не найдено или истекло', 404);
    const row = (
      await this.db.query(
        'SELECT i.role,i.email,h.name FROM cloud_invites i JOIN cloud_homes h ON h.id=i.home_id WHERE i.token_hash=$1 AND i.consumed_at IS NULL AND i.expires_at>now()',
        [digest(token)],
      )
    ).rows[0];
    if (!row) throw new CloudError('Приглашение не найдено или истекло', 404);
    return { homeName: row.name, role: row.role, emailRequired: Boolean(row.email) };
  }
  async accept(
    input: Record<string, unknown>,
    existing: CloudUser | null,
  ): Promise<{ user: CloudUser; homeId: string }> {
    if (
      typeof input.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.token) ||
      !only(input, ['token', 'email', 'username', 'name', 'password'])
    )
      throw new CloudError('Укажите действующее приглашение');
    return this.db.transaction(async (sql) => {
      let invite = (
        await sql.query(
          'SELECT * FROM cloud_invites WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now()',
          [digest(input.token as string)],
        )
      ).rows[0];
      if (!invite) throw new CloudError('Приглашение не найдено или истекло', 404);
      await sql.query('SELECT id FROM cloud_homes WHERE id=$1 FOR UPDATE', [invite.home_id]);
      invite = (
        await sql.query(
          'SELECT * FROM cloud_invites WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',
          [digest(input.token as string)],
        )
      ).rows[0];
      if (!invite) throw new CloudError('Приглашение не найдено или истекло', 404);
      if (
        !(
          await sql.query(
            "SELECT 1 FROM cloud_members WHERE home_id=$1 AND user_id=$2 AND role='owner'",
            [invite.home_id, invite.created_by],
          )
        ).rowCount
      )
        throw new CloudError('Приглашение отозвано', 404);
      const user = existing || (await this.auth.createUser(sql, input));
      if (invite.email && invite.email !== user.email)
        throw new CloudError('Приглашение предназначено для другой учётной записи', 403);
      const member = (
        await sql.query(
          'SELECT role,security_control FROM cloud_members WHERE home_id=$1 AND user_id=$2',
          [invite.home_id, user.id],
        )
      ).rows[0];
      // Accepting another invitation never silently demotes an existing membership.
      if (!member)
        await sql.query(
          'INSERT INTO cloud_members(home_id,user_id,role,security_control) VALUES($1,$2,$3,$4)',
          [invite.home_id, user.id, invite.role, invite.security_control],
        );
      await sql.query('UPDATE cloud_invites SET consumed_at=now() WHERE token_hash=$1', [
        digest(input.token as string),
      ]);
      return { user, homeId: invite.home_id as string };
    });
  }
  async audit(
    homeId: string,
    actor: string | null,
    operation: string,
    target: string,
    status: string,
    detail: string | null = null,
  ): Promise<string> {
    const id = randomUUID();
    await this.db.query(
      'INSERT INTO cloud_audit(id,home_id,actor_id,operation,target,status,detail) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        homeId,
        actor,
        operation.slice(0, 128),
        target.slice(0, 128),
        status.slice(0, 32),
        detail?.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 256) || null,
      ],
    );
    return id;
  }
  /** Complete an existing intent without creating a second operation in the journal. */
  async finishAudit(id: string, status: string): Promise<void> {
    await this.db.query('UPDATE cloud_audit SET status=$2 WHERE id=$1 AND status=$3', [
      id,
      status.slice(0, 32),
      'pending',
    ]);
  }
  /** A restart cannot establish whether a previously dispatched operation reached its target. */
  async recoverPendingAudit(): Promise<void> {
    await this.db.query(
      "UPDATE cloud_audit SET status='unknown',detail=$1 WHERE status='pending'",
      ['Облачный сервер перезапущен до получения подтверждения'],
    );
  }
  async history(actor: string, homeId: string) {
    await this.membership(actor, homeId);
    return (
      await this.db.query(
        'SELECT a.id,a.created_at,a.operation,a.target,a.status,a.detail,u.name FROM cloud_audit a LEFT JOIN cloud_users u ON u.id=a.actor_id WHERE home_id=$1 ORDER BY a.created_at DESC LIMIT 100',
        [homeId],
      )
    ).rows.map((row) => ({
      id: row.id,
      at: row.created_at.toISOString(),
      actorName: row.name || 'Система',
      operation: row.operation,
      target: row.target,
      status: row.status,
      detail: row.detail,
    }));
  }
}
