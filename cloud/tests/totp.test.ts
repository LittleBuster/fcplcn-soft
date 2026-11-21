/** @file Independent RFC vectors and encryption integrity checks for cloud MFA. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { totp, verifyTOTP, encryptSecret, decryptSecret } from '../server/totp.js';
test('SHA-1 TOTP matches RFC 6238 test vectors with six-digit display', () => {
  const key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp(key, Math.floor(59 / 30)), '287082');
  assert.equal(totp(key, Math.floor(1111111109 / 30)), '081804');
  assert.equal(verifyTOTP(key, '287082', 59000), true);
  assert.equal(verifyTOTP(key, '287082', 150000), false);
});
test('stored MFA secrets are authenticated ciphertext and reject another master key', () => {
  const key = randomBytes(32),
    plain = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const encrypted = encryptSecret(plain, key);
  assert.equal(encrypted.includes(plain), false);
  assert.equal(decryptSecret(encrypted, key), plain);
  assert.throws(() => decryptSecret(encrypted, randomBytes(32)));
});
