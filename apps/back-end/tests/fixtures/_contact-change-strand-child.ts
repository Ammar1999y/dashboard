/**
 * The phone variant of the stranding refusal, which the integration tier cannot
 * reach: it enables no phone OTP channel, so `change-phone` answers 503 first.
 */
import * as z from 'zod';

import { installEgressGuard } from '../helpers/egress';

installEgressGuard();
const { eq } = await import('drizzle-orm');
const { db, closeDatabase } = await import('@/db');
const { twoFactorMethods, users, verificationSessions } =
  await import('@/db/schema');
const { seedUser, signIn, baseHeaders, uniquePhone } =
  await import('../helpers/session');
const { app } = await import('@/app');
const { PUBLIC_ORIGIN } = await import('@/lib/env');
const { twoFactorMsg } = await import('@/lib/auth/messages');

const owner = await seedUser({
  phoneNumber: uniquePhone(),
  phoneNumberVerified: true,
});
// Before the factor exists, or sign-in would stop at the challenge.
const { cookie } = await signIn(owner);
await db.insert(twoFactorMethods).values({
  userId: owner.userId,
  method: 'otp',
  channel: 'sms',
  isDefault: true,
});
await db
  .update(users)
  .set({ twoFactorEnabled: true })
  .where(eq(users.id, owner.userId));

const response = await app.handle(
  new Request(`${PUBLIC_ORIGIN}/api/dash/users/me/change-phone`, {
    method: 'POST',
    headers: baseHeaders({
      cookie,
      origin: PUBLIC_ORIGIN,
      'content-type': 'application/json',
    }),
    body: JSON.stringify({
      currentPassword: owner.password,
      newPhoneNumber: uniquePhone(),
      channel: 'sms',
    }),
  })
);
const body: unknown = await response.json();
const refusal = z
  .object({ message: z.literal(twoFactorMsg.contactChangeStrands) })
  .safeParse(body);
if (!refusal.success || response.status !== 409)
  throw new Error(
    `change-phone answered ${response.status} ${JSON.stringify(body)}`
  );
const proofs = await db
  .select({ id: verificationSessions.id })
  .from(verificationSessions)
  .where(eq(verificationSessions.userId, owner.userId));
if (proofs.length > 0) throw new Error('a code was issued before the refusal');
await closeDatabase();
console.log('change-phone refused the stranding change before any SMS.');
