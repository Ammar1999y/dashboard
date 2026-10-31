import type { Tx } from '@/db';
import type { AuditMeta } from '@/lib/audit';
import type { EntityID } from '@app/shared/types';
import type {
  ContactKind,
  OtpChannel,
  PhoneOtpChannel,
} from '@app/shared/validation/enums';

import { eq } from 'drizzle-orm';

import { users } from '@/db/schema';

import { auditLog } from '@/lib/audit';

import { logLine } from '@/utils/log';

import { activeUser } from './filters';

/** The `users` column an OTP channel's identifier is stored in. */
function userContactColumn(channel: OtpChannel) {
  return channel === 'email' ? users.email : users.phoneNumber;
}

/** The identifier a channel-discriminated OTP body names. */
export function contactIdentifier(
  input:
    | { channel: 'email'; email: string }
    | { channel: PhoneOtpChannel; phoneNumber: string }
): string {
  return input.channel === 'email' ? input.email : input.phoneNumber;
}

/** The live account holding this contact, for the anonymous OTP routes. */
export function activeUserWithContact(channel: OtpChannel, identifier: string) {
  return activeUser(eq(userContactColumn(channel), identifier));
}

/** The stored destination for a contact kind. */
export function contactOf(
  user: { email: string; phoneNumber: string | null },
  kind: ContactKind
): string | null {
  return kind === 'email' ? user.email : user.phoneNumber;
}

// Unchanged addresses only: a replacement writes address and flag in one UPDATE
// (`./contact-change.ts`).
export async function markContactVerified(
  tx: Tx,
  opts: {
    userId: EntityID;
    kind: ContactKind;
    auditMeta?: AuditMeta;
    /**
     * The caller's refusal when the user was deleted or deactivated mid-flow;
     * must throw. The event is logged here, since the refusal may hide it.
     */
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

  if (!currentUser) {
    logLine('warn', {
      msg: 'contact.markVerified.userInactive',
      userId: opts.userId,
      kind: opts.kind,
    });
    opts.onMissing();
  }

  const isEmail = opts.kind === 'email';
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
