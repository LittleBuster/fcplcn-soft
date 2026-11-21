/** @file Persistent sessions, editable account names and one-time default administrator creation. */
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudUser } from '../shared/api.js';
import { CloudDatabase, type SQL } from './db.js';
import { CloudError, email, label, only } from './errors.js';
import { decryptSecret, digest, encryptSecret, secret, verifyTOTP } from './totp.js';

interface UserRow {
  auth_version: number;
  id: string;
  username: string;
  email: string | null;
  default_admin: boolean;
  name: string;
  password_hash: string;
  totp_secret: string | null;
  totp_pending: string | null;
  recovery_hashes: string[];
}
export interface Authenticated {
  user: CloudUser;
  csrfToken: string;
  tokenHash: string;
}
export const userView = (
  row: Pick<UserRow, 'id' | 'username' | 'email' | 'name' | 'totp_secret'>,
): CloudUser => ({
  id: row.id,
  username: row.username,
  email: row.email,
  name: row.name,
  totpEnabled: Boolean(row.totp_secret),
});
let deriving = 0;
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function passwordValid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value === '' || value.length >= 10) &&
    Buffer.byteLength(value) <= 256
  );
}
/** Account names share a deterministic, case-insensitive namespace independent of optional email. */
export function username(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,253}$/.test(value.trim()))
    throw new CloudError('Логин: 1–254 латинских букв, цифр или символов . _ @ + -');
  return value.trim().toLowerCase();
}
async function derive(password: string, salt: string): Promise<Buffer> {
  if (deriving >= 4) throw new CloudError('Слишком много попыток. Повторите позже.', 429);
  deriving++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        32,
        { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
  } finally {
    deriving--;
  }
}
export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$32768$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function passwordMatches(password: string, encoded: string | null): Promise<boolean> {
  const parts = encoded?.split('$');
  const valid =
    parts?.length === 4 &&
    parts[0] === 'scrypt' &&
    parts[1] === '32768' &&
    /^[a-f0-9]{32}$/.test(parts[2]) &&
    /^[a-f0-9]{64}$/.test(parts[3]);
  const result = await derive(password, valid ? parts[2] : '0'.repeat(32));
  return Boolean(valid && timingSafeEqual(result, Buffer.from(parts![3], 'hex')));
}
export class LoginLimiter {
  private readonly attempts = new Map<string, { count: number; expires: number }>();
  take(key: string, maximum = 10): void {
    const now = Date.now();
    for (const [id, item] of this.attempts) if (item.expires <= now) this.attempts.delete(id);
    const item = this.attempts.get(key) || { count: 0, expires: now + 15 * 60_000 };
    if (++item.count > maximum)
      throw new CloudError('Слишком много попыток. Повторите позже.', 429);
    if (this.attempts.size >= 4096 && !this.attempts.has(key))
      this.attempts.delete(this.attempts.keys().next().value!);
    this.attempts.set(key, item);
  }
}
export class CloudAuth {
  private readonly verified = new WeakMap<CloudUser, number>();
  readonly limiter = new LoginLimiter();
  readonly cookieName: string;
  constructor(
    readonly db: CloudDatabase,
    readonly secure: boolean,
    private readonly setupKey: string,
    private readonly masterKey: Buffer,
  ) {
    this.cookieName = secure ? '__Host-fcplcn_cloud' : 'fcplcn_cloud';
  }
  async setupRequired(): Promise<boolean> {
    return (await this.db.query('SELECT 1 FROM cloud_users LIMIT 1')).rowCount === 0;
  }
  /** Only an empty database receives admin/empty-password; existing accounts are never reset. */
  async initializeDefaultAdmin(): Promise<void> {
    await this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(646322)');
      if ((await sql.query('SELECT 1 FROM cloud_users LIMIT 1')).rowCount) return;
      await sql.query(
        "INSERT INTO cloud_users(id,username,email,name,password_hash,default_admin) VALUES($1,'admin',NULL,'admin',$2,true)",
        [randomUUID(), await passwordHash('')],
      );
    });
  }
  async createUser(sql: SQL, input: Record<string, unknown>): Promise<CloudUser> {
    const address = email(input.email);
    const account = input.username === undefined ? address : username(input.username);
    if (!label(input.name) || !passwordValid(input.password))
      throw new CloudError('Укажите имя; пароль оставьте пустым или задайте от 10 символов');
    const id = randomUUID(),
      hash = await passwordHash(input.password);
    try {
      await sql.query(
        'INSERT INTO cloud_users(id,email,username,name,password_hash) VALUES($1,$2,$3,$4,$5)',
        [id, address, account, input.name.trim(), hash],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new CloudError('Эта учётная запись уже существует. Войдите в неё.', 409);
      throw error;
    }
    const user = {
      id,
      username: account,
      email: address,
      name: input.name.trim(),
      totpEnabled: false,
    };
    this.verified.set(user, 1);
    return user;
  }
  async setup(input: Record<string, unknown>, address: string): Promise<CloudUser> {
    this.limiter.take('setup:' + address, 5);
    const value = typeof input.setupKey === 'string' ? input.setupKey : '';
    if (!value.length || !equal(value, this.setupKey))
      throw new CloudError('Неверный ключ первоначальной настройки', 403);
    return this.db.transaction(async (sql) => {
      await sql.query('SELECT pg_advisory_xact_lock(646322)');
      const existing = (
        await sql.query<UserRow>(
          'SELECT * FROM cloud_users ORDER BY created_at,id LIMIT 2 FOR UPDATE',
        )
      ).rows;
      if (existing.length) {
        const initial = existing[0];
        if (
          existing.length !== 1 ||
          !initial.default_admin ||
          initial.username !== 'admin' ||
          initial.totp_secret ||
          initial.totp_pending ||
          (
            await sql.query(
              'SELECT 1 FROM cloud_sessions WHERE user_id=$1 UNION ALL SELECT 1 FROM cloud_members WHERE user_id=$1 LIMIT 1',
              [initial.id],
            )
          ).rowCount
        )
          throw new CloudError('Первоначальная настройка уже завершена', 409);
        // Compatibility for the previous setup-key flow, before anyone has used the default account.
        await sql.query('DELETE FROM cloud_users WHERE id=$1', [initial.id]);
      }
      return this.createUser(sql, input);
    });
  }
  async login(input: Record<string, unknown>, address: string): Promise<CloudUser> {
    this.limiter.take('login-ip:' + address, 30);
    const byUsername = input.username !== undefined;
    const supplied = byUsername ? input.username : input.email;
    const account = typeof supplied === 'string' ? supplied.trim().toLowerCase().slice(0, 254) : '';
    this.limiter.take('login-user:' + account, 12);
    if (typeof input.password !== 'string' || Buffer.byteLength(input.password) > 256)
      throw new CloudError('Неверный логин, пароль или код подтверждения', 401);
    const row = (
      await this.db.query<UserRow>(
        byUsername
          ? 'SELECT * FROM cloud_users WHERE lower(username)=$1'
          : 'SELECT * FROM cloud_users WHERE email=$1',
        [account],
      )
    ).rows[0];
    if (!(await passwordMatches(input.password, row?.password_hash || null)))
      throw new CloudError('Неверный логин, пароль или код подтверждения', 401);
    if (row.totp_secret && !(await this.secondFactor(row, input.totp)))
      throw new CloudError('Введите код приложения-аутентификатора или резервный код', 401);
    const user = userView(row);
    this.verified.set(user, row.auth_version);
    return user;
  }
  private async secondFactor(row: UserRow, code: unknown): Promise<boolean> {
    if (verifyTOTP(decryptSecret(row.totp_secret!, this.masterKey), code)) return true;
    if (typeof code !== 'string' || !/^[A-Fa-f0-9-]{20,40}$/.test(code)) return false;
    const hash = digest(code.replaceAll('-', '').toLowerCase());
    const result = await this.db.query(
      'UPDATE cloud_users SET recovery_hashes=recovery_hashes - $2 WHERE id=$1 AND recovery_hashes ? $2 RETURNING id',
      [row.id, hash],
    );
    return Boolean(result.rowCount);
  }
  async issue(user: CloudUser, response: ServerResponse): Promise<Authenticated> {
    const token = randomBytes(32).toString('base64url'),
      csrfToken = randomBytes(32).toString('base64url');
    const tokenHash = digest(token);
    await this.db.transaction(async (sql) => {
      const row = (
        await sql.query<UserRow>('SELECT * FROM cloud_users WHERE id=$1 FOR UPDATE', [user.id])
      ).rows[0];
      const expected = this.verified.get(user);
      if (!row || (expected !== undefined && row.auth_version !== expected))
        throw new CloudError('Учётные данные изменились. Войдите заново.', 401);
      await sql.query('DELETE FROM cloud_sessions WHERE expires_at<=now()');
      await sql.query(
        'DELETE FROM cloud_sessions WHERE token_hash IN (SELECT token_hash FROM cloud_sessions WHERE user_id=$1 ORDER BY created_at DESC OFFSET 19)',
        [user.id],
      );
      await sql.query(
        "INSERT INTO cloud_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",
        [tokenHash, user.id, csrfToken],
      );
      await sql.query('UPDATE cloud_users SET default_admin=false WHERE id=$1 AND default_admin', [
        user.id,
      ]);
    });
    response.setHeader(
      'Set-Cookie',
      `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${this.secure ? '; Secure' : ''}`,
    );
    return { user, csrfToken, tokenHash };
  }
  async session(request: IncomingMessage): Promise<Authenticated | null> {
    const token = request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(this.cookieName + '='))
      ?.slice(this.cookieName.length + 1);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = (
      await this.db.query<UserRow & { csrf_token: string }>(
        'SELECT u.*,s.csrf_token FROM cloud_sessions s JOIN cloud_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',
        [digest(token)],
      )
    ).rows[0];
    return row
      ? { user: userView(row), csrfToken: row.csrf_token, tokenHash: digest(token) }
      : null;
  }
  csrf(request: IncomingMessage, session: Authenticated): void {
    const token = request.headers['x-fcplcn-csrf'];
    if (typeof token !== 'string' || !equal(token, session.csrfToken))
      throw new CloudError('Проверка безопасности запроса не пройдена. Обновите страницу.', 403);
  }
  async logout(session: Authenticated, response: ServerResponse): Promise<void> {
    await this.db.query('DELETE FROM cloud_sessions WHERE token_hash=$1', [session.tokenHash]);
    response.setHeader(
      'Set-Cookie',
      `${this.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.secure ? '; Secure' : ''}`,
    );
  }
  async setupTOTP(
    session: Authenticated,
    password: unknown,
  ): Promise<{ secret: string; uri: string }> {
    const row = (
      await this.db.query<UserRow>('SELECT * FROM cloud_users WHERE id=$1', [session.user.id])
    ).rows[0];
    if (
      typeof password !== 'string' ||
      Buffer.byteLength(password) > 256 ||
      !(await passwordMatches(password, row?.password_hash || null))
    )
      throw new CloudError('Подтвердите текущий пароль', 403);
    if (row.totp_secret) throw new CloudError('Двухфакторная защита уже включена', 409);
    const value = secret();
    const updated = await this.db.query(
      'UPDATE cloud_users SET totp_pending=$2 WHERE id=$1 AND password_hash=$3 AND auth_version=$5 AND EXISTS(SELECT 1 FROM cloud_sessions WHERE token_hash=$4 AND user_id=$1 AND expires_at>now())',
      [
        session.user.id,
        encryptSecret(value, this.masterKey),
        row.password_hash,
        session.tokenHash,
        row.auth_version,
      ],
    );
    if (!updated.rowCount) throw new CloudError('Учётные данные изменились. Войдите заново.', 401);
    return {
      secret: value,
      uri: `otpauth://totp/FCPLCn:${encodeURIComponent(session.user.username)}?secret=${value}&issuer=FCPLCn&algorithm=SHA1&digits=6&period=30`,
    };
  }
  async confirmTOTP(session: Authenticated, code: unknown): Promise<string[]> {
    return this.db.transaction(async (sql) => {
      const row = (
        await sql.query<UserRow>('SELECT * FROM cloud_users WHERE id=$1 FOR UPDATE', [
          session.user.id,
        ])
      ).rows[0];
      if (
        !(
          await sql.query(
            'SELECT 1 FROM cloud_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()',
            [session.tokenHash, session.user.id],
          )
        ).rowCount
      )
        throw new CloudError('Войдите заново', 401);
      if (
        !row?.totp_pending ||
        row.totp_secret ||
        !verifyTOTP(decryptSecret(row.totp_pending, this.masterKey), code)
      )
        throw new CloudError('Неверный или уже использованный код подтверждения');
      const codes = Array.from({ length: 10 }, () => randomBytes(12).toString('hex'));
      await sql.query(
        'UPDATE cloud_users SET totp_secret=totp_pending,totp_pending=NULL,recovery_hashes=$2,auth_version=auth_version+1 WHERE id=$1',
        [session.user.id, JSON.stringify(codes.map(digest))],
      );
      await sql.query('DELETE FROM cloud_sessions WHERE user_id=$1 AND token_hash<>$2', [
        session.user.id,
        session.tokenHash,
      ]);
      return codes;
    });
  }
  async disableTOTP(session: Authenticated, password: unknown, code: unknown): Promise<void> {
    const row = (
      await this.db.query<UserRow>('SELECT * FROM cloud_users WHERE id=$1', [session.user.id])
    ).rows[0];
    if (
      typeof password !== 'string' ||
      password.length > 256 ||
      !(await passwordMatches(password, row?.password_hash || null)) ||
      !row.totp_secret ||
      !(await this.secondFactor(row, code))
    )
      throw new CloudError('Неверный пароль или код подтверждения', 403);
    await this.db.transaction(async (sql) => {
      const changed = await sql.query(
        "UPDATE cloud_users SET totp_secret=NULL,totp_pending=NULL,recovery_hashes='[]',auth_version=auth_version+1 WHERE id=$1 AND password_hash=$2 AND auth_version=$4 AND EXISTS(SELECT 1 FROM cloud_sessions WHERE token_hash=$3 AND user_id=$1 AND expires_at>now())",
        [session.user.id, row.password_hash, session.tokenHash, row.auth_version],
      );
      if (!changed.rowCount)
        throw new CloudError('Учётные данные изменились. Войдите заново.', 401);
      await sql.query('DELETE FROM cloud_sessions WHERE user_id=$1 AND token_hash<>$2', [
        session.user.id,
        session.tokenHash,
      ]);
    });
  }
  async changePassword(
    session: Authenticated,
    currentPassword: unknown,
    password: unknown,
    code: unknown,
  ): Promise<CloudUser> {
    return this.changeAccount(session, { currentPassword, password, code });
  }
  /** Change only explicitly supplied fields, invalidate old sessions and issue against the new version. */
  async changeAccount(session: Authenticated, input: Record<string, unknown>): Promise<CloudUser> {
    if (
      !only(input, ['username', 'name', 'currentPassword', 'password', 'code']) ||
      !['username', 'name', 'password'].some((field) => Object.hasOwn(input, field))
    )
      throw new CloudError('Укажите логин, имя или новый пароль');
    const account = Object.hasOwn(input, 'username') ? username(input.username) : undefined;
    if (Object.hasOwn(input, 'name') && !label(input.name))
      throw new CloudError('Укажите имя до 96 байт');
    const changingPassword = Object.hasOwn(input, 'password');
    if (changingPassword && !passwordValid(input.password))
      throw new CloudError('Пароль оставьте пустым или задайте от 10 символов');
    const row = (
      await this.db.query<UserRow>('SELECT * FROM cloud_users WHERE id=$1', [session.user.id])
    ).rows[0];
    if (
      typeof input.currentPassword !== 'string' ||
      Buffer.byteLength(input.currentPassword) > 256 ||
      !(await passwordMatches(input.currentPassword, row?.password_hash || null)) ||
      (row.totp_secret && !(await this.secondFactor(row, input.code)))
    )
      throw new CloudError('Неверный текущий пароль или код подтверждения', 403);
    const hash = changingPassword
      ? await passwordHash(input.password as string)
      : row.password_hash;
    let updatedRow: UserRow;
    try {
      updatedRow = await this.db.transaction(async (sql) => {
        const locked = (
          await sql.query<UserRow>('SELECT * FROM cloud_users WHERE id=$1 FOR UPDATE', [row.id])
        ).rows[0];
        if (
          !locked ||
          locked.auth_version !== row.auth_version ||
          !(
            await sql.query(
              'SELECT 1 FROM cloud_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()',
              [session.tokenHash, row.id],
            )
          ).rowCount
        )
          throw new CloudError('Учётные данные изменились. Войдите заново.', 401);
        const updated = await sql.query<UserRow>(
          'UPDATE cloud_users SET password_hash=$2,username=$3,name=$4,default_admin=false,auth_version=auth_version+1 WHERE id=$1 RETURNING *',
          [
            row.id,
            hash,
            account ?? row.username,
            typeof input.name === 'string' ? input.name.trim() : row.name,
          ],
        );
        await sql.query('DELETE FROM cloud_sessions WHERE user_id=$1', [row.id]);
        return updated.rows[0];
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new CloudError('Этот логин уже занят', 409);
      throw error;
    }
    const user = userView(updatedRow);
    this.verified.set(user, updatedRow.auth_version);
    return user;
  }
}
