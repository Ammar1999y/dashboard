import type { Tx } from '@/db';
import type { EntityID } from '@app/shared/types';

import { and, eq } from 'drizzle-orm';

import { accounts } from '@/db/schema';

import { CREDENTIAL_ISSUER, CREDENTIAL_PROVIDER_ID } from './credential';

export function credentialAccountOf(userId: EntityID) {
  return and(
    eq(accounts.userId, userId),
    eq(accounts.providerId, CREDENTIAL_PROVIDER_ID)
  );
}

// `issuer` written explicitly despite the column default: it decides whether the user can log in.
export async function insertCredentialAccount(
  tx: Tx,
  userId: EntityID,
  hash: string
): Promise<void> {
  await tx.insert(accounts).values({
    accountId: userId,
    issuer: CREDENTIAL_ISSUER,
    providerId: CREDENTIAL_PROVIDER_ID,
    userId,
    password: hash,
  });
}
