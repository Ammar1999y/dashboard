/**
 * HMAC under a versioned key, not a slow hash: the attempt budget stops online
 * guessing, the key stops database-only enumeration, and a memory-hard hash
 * would only add row-lock time.
 */
import crypto from 'node:crypto';

import { BASE64URL_32_BYTES_PATTERN, KEY_ID_PATTERN } from '@/lib/auth/keyring';

import { getActiveOtpKey, getOtpKey } from './key';

const ENVELOPE_VERSION = 'o1';

function computeMac(code: string, secret: Buffer): Buffer {
  // A channel echoing full-width digits would otherwise mismatch silently.
  return crypto
    .createHmac('sha256', secret)
    .update(code.normalize('NFKC'), 'utf8')
    .digest();
}

export function hashOtpCode(code: string): string {
  const key = getActiveOtpKey();
  return `${ENVELOPE_VERSION}:${key.id}:${computeMac(code, key.secret).toString('base64url')}`;
}

/**
 * `false` only for a retired key id, where `verifyOtpCode` throws; on an
 * anonymous path that 500 would reveal a live proof, so callers ask first and
 * answer "invalid or expired".
 */
export function canEvaluateOtp(stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3) return true;
  const [version, keyId] = parts;
  if (version !== ENVELOPE_VERSION || !keyId || !KEY_ID_PATTERN.test(keyId))
    return true;

  try {
    getOtpKey(keyId);
    return true;
  } catch {
    return false;
  }
}

/**
 * A malformed value answers `false`, not a throw, so a corrupted row is no
 * oracle. A retired key id deliberately throws: an operator has to act.
 */
export async function verifyOtpCode(
  code: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3) return false;

  const [version, keyId, encoded] = parts;
  if (
    version !== ENVELOPE_VERSION ||
    !keyId ||
    !encoded ||
    !KEY_ID_PATTERN.test(keyId) ||
    !BASE64URL_32_BYTES_PATTERN.test(encoded)
  )
    return false;

  const key = getOtpKey(keyId);

  const actual = Buffer.from(encoded, 'base64url');
  const expected = computeMac(code, key.secret);
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}
