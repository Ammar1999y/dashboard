import crypto from 'node:crypto';
import type { Executor } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { SymmetricDecryptOptions } from 'better-auth/crypto';

import { eq, sql } from 'drizzle-orm';

import { twoFactorCredentials } from '@/db/schema';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';

/** Matches the plugin's own generator, so a stored set reads back identically. */
const BACKUP_CODE_ALPHABET =
  'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;

export function generateBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () => {
    let code = '';
    for (let i = 0; i < BACKUP_CODE_LENGTH; i++)
      code += BACKUP_CODE_ALPHABET.charAt(
        crypto.randomInt(BACKUP_CODE_ALPHABET.length)
      );
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

// Must match what the plugin's `verify-backup-code` reads under its default
// `storeBackupCodes: "encrypted"`.
export function encodeBackupCodes(
  key: SymmetricDecryptOptions['key'],
  codes: string[]
): Promise<string> {
  return symmetricEncrypt({ key, data: JSON.stringify(codes) });
}

export async function decodeBackupCodes(
  key: SymmetricDecryptOptions['key'],
  blob: string
): Promise<string[] | null> {
  const decrypted = await symmetricDecrypt({ key, data: blob }).catch(
    () => null
  );
  if (!decrypted) return null;

  let codes: unknown;
  try {
    codes = JSON.parse(decrypted);
  } catch {
    return null;
  }
  if (
    !Array.isArray(codes) ||
    !codes.every((entry): entry is string => typeof entry === 'string')
  )
    return null;
  return codes;
}

/**
 * ⚠️ `executor` must be the transaction the plugin's rewrite ran on, under the
 * user lock: elsewhere a regeneration committing in between takes the decrement
 * and the count drifts low until the method stops being offered.
 */
export async function spendBackupCode(
  userId: EntityID,
  executor: Executor
): Promise<void> {
  await executor
    .update(twoFactorCredentials)
    .set({
      backupCodesRemaining: sql`GREATEST(${twoFactorCredentials.backupCodesRemaining} - 1, 0)`,
    })
    .where(eq(twoFactorCredentials.userId, userId));
}
