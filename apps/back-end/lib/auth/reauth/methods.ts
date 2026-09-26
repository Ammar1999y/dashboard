import type { Executor } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { ReauthMethod } from '@app/shared/validation/reauth';

import { and, eq, isNotNull } from 'drizzle-orm';

import { db } from '@/db';
import { accounts, passkeys } from '@/db/schema';

import { isTwoFactorMethodEnabled } from '@app/shared/validation/two-factor';

import { CREDENTIAL_PROVIDER_ID } from '../credential';

export async function availableReauthMethods(
  userId: EntityID,
  executor: Executor = db
): Promise<ReauthMethod[]> {
  const methods: ReauthMethod[] = [];
  const credentials = await executor
    .select({ provider: accounts.providerId })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), isNotNull(accounts.password)));
  if (credentials.some((entry) => entry.provider === CREDENTIAL_PROVIDER_ID))
    methods.push('password');
  if (isTwoFactorMethodEnabled('passkey')) {
    const [credential] = await executor
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .limit(1);
    if (credential) methods.push('passkey');
  }
  return methods;
}
