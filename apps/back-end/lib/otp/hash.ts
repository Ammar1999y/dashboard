/**
 * Six-digit OTPs use HMAC-SHA-256 under a dedicated versioned key, not a slow
 * password hash: the online attempt budget stops guessing and the key prevents
 * database-only enumeration, and a memory-hard hash would improve neither while
 * adding row-lock time.
 *
 * Envelope: `o1:<keyId>:<base64url mac>` so retained keys keep live codes valid
 * during rotation.
 */
import crypto from 'node:crypto';

import { BASE64URL_32_BYTES_PATTERN, KEY_ID_PATTERN } from '@/lib/auth/keyring';
import { verifyPassword } from '@/lib/auth/password/hash';

import { getActiveOtpKey, getOtpKey } from './key';

const ENVELOPE_VERSION = 'o1';

/** Argon2id OTP hashes from `hashPassword`; recognised on the verify path only. */
const LEGACY_PASSWORD_ENVELOPE = 'p1:';

function computeMac(code: string, secret: Buffer): Buffer {
  // NFKC, matching `normalizePassword`: a no-op for ASCII digits, but a channel
  // that echoes a full-width digit would otherwise mismatch silently.
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
 * Can this stored value be compared against a submitted code AT ALL?
 *
 * `false` means only one thing: an `o1:` envelope whose key generation is no
 * longer configured. `verifyOtpCode` deliberately THROWS there — an operator has
 * to see it — but a throw on an anonymous verification path is a 500, and an
 * unknown identifier takes the generic 400 path, so the pair distinguishes a real
 * live proof from a nonexistent account. Callers on those paths ask this first
 * and answer "invalid or expired", which is the truth: the code can never match
 * again, and requesting a new one fixes it.
 *
 * A malformed envelope returns `true` — it IS evaluable, and `verifyOtpCode`
 * answers `false` for it without throwing.
 */
export function canEvaluateOtp(stored: string): boolean {
  if (stored.startsWith(LEGACY_PASSWORD_ENVELOPE)) return true;

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
 * Constant-time comparison against the stored value.
 *
 * A malformed `o1:` value returns false rather than throwing: a corrupted row
 * must not become an error-shaped oracle.
 *
 * Two cases deliberately DO throw, because both mean an operator has to act and
 * neither is a wrong code: a key id the keyring no longer holds, and a
 * malformed legacy `p1:` envelope, which `verifyPassword` rejects with
 * `PasswordHashFormatError`.
 *
 * `timingSafeEqual` throws on a length mismatch, so the length is checked first;
 * the MAC length is fixed by SHA-256 and carries no secret.
 */
export async function verifyOtpCode(
  code: string,
  stored: string
): Promise<boolean> {
  // Delete this branch, and the `verifyPassword` import, once no deployment can
  // hold a `p1:` code issued before the HMAC cutover (OTP_EXPIRY_MINUTES after
  // that deploy). Until then it keeps mid-verification users from an
  // unexplained rejection.
  if (stored.startsWith(LEGACY_PASSWORD_ENVELOPE))
    return verifyPassword({ password: code, hash: stored });

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
