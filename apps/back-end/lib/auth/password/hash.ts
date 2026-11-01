import { AsyncLocalStorage } from 'node:async_hooks';

import * as argon2 from 'argon2';

import { normalizePasswordInput } from '@app/shared/validation/rules';

import { createAdmission } from '@/lib/admission';
import { KEY_ID_PATTERN } from '@/lib/crypto/keyring';
import { serviceBusy } from '@/lib/http/response';

import { errorClassOf, logLine } from '@/utils/log';

import { getActivePasswordPepper, getPasswordPepper } from './pepper';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
  version: 0x13,
} satisfies argon2.HashOptions;

/**
 * Argon2 runs on Bun's process-wide work pool, which WebCrypto shares, so
 * unbounded hashing queues every session-cookie HMAC behind it: 16 sign-in
 * attempts a second took `get-session` from 10 ms to 1.7 s, and to 91 ms with
 * one slot (`reports/performance-audit.md`). One job already uses
 * `parallelism` threads.
 */
const PASSWORD_WORK_SLOTS = 1;
/** Exported so tests fill the queue rather than restate it. */
export const PASSWORD_WORK_QUEUE = 16;
/** Above a full queue's drain at the measured 70–250 ms a hash. */
const PASSWORD_WORK_MAX_WAIT_MS = 5000;
const PASSWORD_WORK_RETRY_AFTER_S = 2;

export const passwordWorkBusy = () => serviceBusy(PASSWORD_WORK_RETRY_AFTER_S);

function passwordAdmission(slots: number) {
  return createAdmission({
    slots,
    queueLimit: PASSWORD_WORK_QUEUE,
    maxWaitMs: PASSWORD_WORK_MAX_WAIT_MS,
    refusal: passwordWorkBusy,
  });
}
const admission = { acquire: passwordAdmission(PASSWORD_WORK_SLOTS) };

/**
 * Runs the slot with `slots` places until the returned restore, so a test can
 * overlap attempts the production slot serialises. Call with nothing held.
 */
export function widenPasswordSlotForTest(slots: number): () => void {
  admission.acquire = passwordAdmission(slots);
  return () => {
    admission.acquire = passwordAdmission(PASSWORD_WORK_SLOTS);
  };
}
const slotHeld = new AsyncLocalStorage<true>();

/**
 * Runs `work` holding the process's password slot; every hash and verify
 * inside it reuses the slot instead of queueing again, which with one slot
 * would deadlock. Wrap a whole operation that hashes more than once, or whose
 * admission must precede a write: a refusal between its steps would leave the
 * first one done.
 */
export async function withPasswordSlot<T>(work: () => Promise<T>): Promise<T> {
  if (slotHeld.getStore()) return work();
  const release = await admission.acquire();
  try {
    return await slotHeld.run(true, work);
  } finally {
    release();
  }
}

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

async function hashWithActivePepper(
  password: string
): Promise<{ pepperId: string; phc: string }> {
  const pepper = getActivePasswordPepper();
  const phc = await withPasswordSlot(() =>
    argon2.hash(normalizePasswordInput(password), {
      ...ARGON2_OPTIONS,
      secret: pepper.secret,
    })
  );
  return { pepperId: pepper.id, phc };
}

export async function hashPassword(password: string): Promise<string> {
  const { pepperId, phc } = await hashWithActivePepper(password);
  return `${HASH_ENVELOPE_VERSION}:${pepperId}:${phc}`;
}

/**
 * An unevaluatable stored hash answers `valid: false` and logs: a throw would
 * answer differently from an unknown email, an account-existence oracle.
 * `costPaid: false` means the caller still owes the timing guard.
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
    logLine('error', {
      msg: 'auth.password.hash unevaluatable',
      errorClass: errorClassOf(error),
      // Safe to log: neither error class puts a key or hash in its message.
      detail: error instanceof Error ? error.message : null,
    });
    return { valid: false, needsRehash: false, costPaid: false };
  }

  // The slot is taken outside the catch: a busy refusal is not an
  // unevaluatable hash, which would answer as a wrong password.
  const valid = await withPasswordSlot(async () => {
    try {
      return await argon2.verify(parsed.phc, normalizePasswordInput(password), {
        secret: pepper.secret,
      });
    } catch (error) {
      // No `detail`: the PHC parser can echo fragments of the stored value.
      logLine('error', {
        msg: 'auth.password.hash unevaluatable',
        errorClass: errorClassOf(error),
      });
      return null;
    }
  });
  if (valid === null)
    return { valid: false, needsRehash: false, costPaid: false };
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
  await hashWithActivePepper(password);
}
