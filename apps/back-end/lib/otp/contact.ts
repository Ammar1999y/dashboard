import type { Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';
import type { OtpChannel } from '@app/shared/validation/enums';

import { eq } from 'drizzle-orm';

import { users } from '@/db/schema';

import { auditLog } from '@/lib/audit';
import { activeUser } from '@/lib/users/filters';

// Unchanged addresses only: a replacement writes address and flag in one UPDATE
// (`lib/users/contact-change.ts`).
export async function markContactVerified(
  tx: Tx,
  opts: {
    userId: EntityID;
    channel: OtpChannel;
    auditMeta?: AuditMeta;
    /** Invoked (must throw) when the user vanished/deactivated mid-flow. */
    onMissing: () => never;
  }
): Promise<void> {
  const [currentUser] = await tx
    .select({
      email: users.email,
      emailVerified: users.emailVerified,
      phoneNumberVerified: users.phoneNumberVerified,
    })
    .from(users)
    .where(activeUser(eq(users.id, opts.userId)))
    .for('update');

  if (!currentUser) opts.onMissing();

  const isEmail = opts.channel === 'email';
  const alreadyVerified = isEmail
    ? currentUser.emailVerified
    : currentUser.phoneNumberVerified;

  if (alreadyVerified) return;

  await tx
    .update(users)
    .set(isEmail ? { emailVerified: true } : { phoneNumberVerified: true })
    .where(eq(users.id, opts.userId));

  const fieldName = isEmail ? 'emailVerified' : 'phoneNumberVerified';
  if (opts.auditMeta)
    await auditLog(tx, {
      userId: opts.userId,
      userEmail: currentUser.email,
      action: 'UPDATE',
      tableName: 'users',
      recordId: opts.userId,
      oldData: { [fieldName]: false },
      newData: { [fieldName]: true },
      meta: opts.auditMeta,
    });
}
