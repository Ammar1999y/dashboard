import * as argon2 from 'argon2';

import { KEY_ID_PATTERN } from '../keyring';
import { getActivePasswordPepper, getPasswordPepper } from './pepper';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
  version: 0x13,
} satisfies argon2.HashOptions;

const HASH_ENVELOPE_VERSION = 'p1';
const ARGON2ID_PREFIX = '$argon2id$';

interface ParsedPasswordHash {
  pepperId: string;
  phc: string;
}

type PasswordVerificationResult =
  | { valid: false; needsRehash: false; costPaid: boolean }
  | {
      valid: true;
      needsRehash: boolean;
      costPaid: true;
      pepperId: string;
      activePepperId: string;
    };

class PasswordHashFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordHashFormatError';
  }
}

function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

function parsePasswordHash(hash: string): ParsedPasswordHash | null {
  if (!hash.startsWith(`${HASH_ENVELOPE_VERSION}:`)) {
    if (/^p\d+:/.test(hash)) {
      throw new PasswordHashFormatError(
        'Stored password hash uses an unsupported envelope version'
      );
    }
    return null;
  }

  const parts = hash.split(':');
  if (parts.length !== 3) {
    throw new PasswordHashFormatError(
      'Stored password hash has an invalid envelope'
    );
  }

  const [, pepperId, phc] = parts;
  if (
    pepperId === undefined ||
    phc === undefined ||
    !KEY_ID_PATTERN.test(pepperId) ||
    !phc.startsWith(ARGON2ID_PREFIX)
  ) {
    throw new PasswordHashFormatError(
      'Stored password hash has an invalid envelope'
    );
  }

  return { pepperId, phc };
}

export function assertPasswordHashEvaluable(hash: string): void {
  const parsed = parsePasswordHash(hash);
  if (!parsed)
    throw new PasswordHashFormatError('Stored password hash has no envelope');
  getPasswordPepper(parsed.pepperId);
}

export async function hashPassword(password: string): Promise<string> {
  const pepper = getActivePasswordPepper();
  const phc = await argon2.hash(normalizePassword(password), {
    ...ARGON2_OPTIONS,
    secret: pepper.secret,
  });
  return `${HASH_ENVELOPE_VERSION}:${pepper.id}:${phc}`;
}

/**
 * The single credential-verification entry point, so the only place that
 * decides what an UNEVALUATABLE stored hash means: a malformed or unsupported
 * envelope, or a pepper id the keyring no longer holds.
 *
 * Both answer `valid: false`, indistinguishable from a wrong password, and reach
 * the operator through the log. A thrown fault would answer differently from an
 * unknown email — an unauthenticated account-existence oracle. `costPaid: false`
 * because no Argon2 work was done, so the caller still owes the timing guard.
 */
export async function verifyPasswordDetailed({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<PasswordVerificationResult> {
  let parsed: ParsedPasswordHash | null;
  let pepper: ReturnType<typeof getPasswordPepper>;
  try {
    parsed = parsePasswordHash(hash);
    if (!parsed) {
      return { valid: false, needsRehash: false, costPaid: false };
    }
    pepper = getPasswordPepper(parsed.pepperId);
  } catch (error) {
    console.error(
      JSON.stringify({
        msg: 'auth.password.hash unevaluatable',
        errorClass: error instanceof Error ? error.name : 'UnknownError',
        // The message names the envelope defect or the missing generation. It
        // carries no secret: `KeyringConfigurationError` reports the env var and
        // the rule, never a key, and `PasswordHashFormatError` reports the shape.
        detail: error instanceof Error ? error.message : null,
      })
    );
    return { valid: false, needsRehash: false, costPaid: false };
  }

  const valid = await argon2.verify(parsed.phc, normalizePassword(password), {
    secret: pepper.secret,
  });
  if (!valid) return { valid: false, needsRehash: false, costPaid: true };

  const activePepper = getActivePasswordPepper();
  return {
    valid: true,
    needsRehash: pepper.generation < activePepper.generation,
    costPaid: true,
    pepperId: pepper.id,
    activePepperId: activePepper.id,
  };
}

export async function verifyPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  const result = await verifyPasswordDetailed({ hash, password });
  return result.valid;
}

export async function runPasswordTimingGuard(password: string): Promise<void> {
  const pepper = getActivePasswordPepper();
  await argon2.hash(normalizePassword(password), {
    ...ARGON2_OPTIONS,
    secret: pepper.secret,
  });
}
