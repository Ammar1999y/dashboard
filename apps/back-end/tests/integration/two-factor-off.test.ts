/**
 * A deployment with no two-factor method: an account enrolled before the
 * feature was switched off signs in with its first factor alone, by password
 * and by Google, and a contact change still demands a fresh reauthentication.
 *
 * Runs only in the `two-factor-off` row of `tests/helpers/run.ts`.
 */
import { beforeEach, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { users } from '@/db/schema';

import { REAUTH_REQUIRED_CODE } from '@app/shared/error-codes';
import { TWO_FACTOR_ENABLED } from '@app/shared/validation/two-factor';

import { PUBLIC_ORIGIN } from '@/lib/env';

import { resetTables } from '../helpers/database';
import { startGoogle } from '../helpers/google';
import { resetRateLimits } from '../helpers/rate-limit';
import { baseHeaders, seedUser, signIn, uniquePhone } from '../helpers/session';

beforeEach(resetTables);
beforeEach(resetRateLimits);

test('the row really has two-factor off', () => {
  expect(TWO_FACTOR_ENABLED).toBe(false);
});

test('Google and password both admit a stale enrollment, and a phone change still asks for reauthentication', async () => {
  const owner = await seedUser();
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, owner.userId));
  const { cookie } = await signIn(owner);

  const phone = await app.handle(
    new Request(`${PUBLIC_ORIGIN}/api/dash/users/me/change-phone`, {
      method: 'POST',
      headers: baseHeaders({
        cookie,
        origin: PUBLIC_ORIGIN,
        'content-type': 'application/json',
      }),
      body: JSON.stringify({ newPhoneNumber: uniquePhone(), channel: 'sms' }),
    })
  );
  expect(phone.status).toBe(401);
  expect(await phone.json()).toMatchObject({ code: REAUTH_REQUIRED_CODE });

  const flow = await startGoogle({
    sub: 'feature-off-subject',
    email: owner.email,
  });
  const callback = await flow.callback();
  expect(callback.status).toBe(200);
});
