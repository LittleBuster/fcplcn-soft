/** @file RFC 6238 time-based codes and authenticated encryption for recoverable MFA secrets. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function secret(): string {
  const input = randomBytes(20);
  let bits = 0,
    value = 0,
    result = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits -= 5)) & 31];
    }
  }
  return result;
}
function decode(value: string): Buffer {
  let bits = 0,
    word = 0;
  const bytes: number[] = [];
  for (const letter of value) {
    const index = alphabet.indexOf(letter);
    if (index < 0) throw new Error('Invalid MFA secret');
    word = (word << 5) | index;
    bits += 5;
    if (bits >= 8) bytes.push((word >>> (bits -= 8)) & 255);
  }
  return Buffer.from(bytes);
}
export function totp(value: string, step = Math.floor(Date.now() / 30000)): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', decode(value)).update(counter).digest();
  const offset = hash[19] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export function verifyTOTP(value: string, code: unknown, now = Date.now()): boolean {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((delta) =>
    timingSafeEqual(Buffer.from(totp(value, Math.floor(now / 30000) + delta)), Buffer.from(code)),
  );
}
export function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
export function decryptSecret(value: string, key: Buffer): string {
  const data = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
