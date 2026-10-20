import type { Executor } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { ReauthMethod } from '@app/shared/validation/reauth';
import type { AnyColumn, SQL } from 'drizzle-orm';

import { and, eq, exists, isNotNull, or, sql } from 'drizzle-orm';

import { db } from '@/db';
import { accounts, passkeys } from '@/db/schema';

import { isTwoFactorMethodEnabled } from '@app/shared/validation/two-factor';

import { CREDENTIAL_PROVIDER_ID } from '../credential';

const PASSKEY_REAUTH = isTwoFactorMethodEnabled('passkey');

const passwordCredentialOf = (userId: EntityID) =>
  and(
    eq(accounts.userId, userId),
    eq(accounts.providerId, CREDENTIAL_PROVIDER_ID),
    isNotNull(accounts.password)
  );

const passkeyOf = (userId: EntityID) => eq(passkeys.userId, userId);

export async function availableReauthMethods(
  userId: EntityID,
  executor: Executor = db
): Promise<ReauthMethod[]> {
  const methods: ReauthMethod[] = [];
  const [credential] = await executor
    .select({ id: accounts.id })
    .from(accounts)
    .where(passwordCredentialOf(userId))
    .limit(1);
  if (credential) methods.push('password');
  if (PASSKEY_REAUTH) {
    const [passkey] = await executor
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(passkeyOf(userId))
      .limit(1);
    if (passkey) methods.push('passkey');
  }
  return methods;
}

/** `availableReauthMethods` as a condition on a column that names one method. */
export function reauthMethodAvailable(
  userId: EntityID,
  method: AnyColumn
): SQL | undefined {
  const one = { one: sql`1` };
  return or(
    and(
      eq(method, 'password'),
      exists(db.select(one).from(accounts).where(passwordCredentialOf(userId)))
    ),
    PASSKEY_REAUTH
      ? and(
          eq(method, 'passkey'),
          exists(db.select(one).from(passkeys).where(passkeyOf(userId)))
        )
      : undefined
  );
}
