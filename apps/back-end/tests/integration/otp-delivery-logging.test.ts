/**
 * A failed OTP delivery is one error line, written by whichever boundary
 * answers it, carrying the provider diagnosis `deliverOtp` vetted and nothing
 * the message held: neither the code nor the destination.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { SeededUser } from '../helpers/session';

import { eq } from 'drizzle-orm';

import { app } from '@/app';
import { db } from '@/db';
import { twoFactorMethods, users } from '@/db/schema';

import { issueRecoveryGrant } from '@/lib/auth/recovery/grant';
import {
  readEnrolmentState,
  recoveryOptions,
} from '@/lib/auth/two-factor/methods';
import { PUBLIC_ORIGIN } from '@/lib/env';

import { resetTables } from '../helpers/database';
import { scriptEgress } from '../helpers/egress';
import { failNextMail, resetMailbox, settleDelivery } from '../helpers/mailbox';
import { resetRateLimits } from '../helpers/rate-limit';
import { baseHeaders, seedUser, signIn, uniquePhone } from '../helpers/session';
import { resetSqliteStores } from '../helpers/sqlite';

const restores: (() => void)[] = [];

beforeEach(async () => {
  await resetTables();
  await resetSqliteStores();
  await resetRateLimits();
  resetMailbox();
  scriptEgress('challenges.cloudflare.com', () =>
    Response.json({ success: true })
  );
});

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  resetMailbox();
});

function post(path: string, body: object, cookie = '') {
  return app.handle(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      method: 'POST',
      headers: baseHeaders({
        origin: PUBLIC_ORIGIN,
        cookie,
        'content-type': 'application/json',
      }),
      body: JSON.stringify(body),
    })
  );
}

function errorLines() {
  const spy = spyOn(console, 'error').mockImplementation(() => {});
  restores.push(() => spy.mockRestore());
  return () => spy.mock.calls.map((args) => Bun.inspect(args));
}

/** The SMS provider refusing with 503; answers the codes it was asked to send. */
function failingSms(): string[] {
  const texts: string[] = [];
  scriptEgress('apis.deewan.sa', async (request) => {
    const body: unknown = await request.json();
    if (typeof body === 'object' && body !== null && 'messageText' in body)
      texts.push(String(body.messageText));
    return new Response('unavailable', { status: 503 });
  });
  return texts;
}

async function smsUser(): Promise<{ user: SeededUser; phone: string }> {
  const phone = uniquePhone();
  const user = await seedUser({
    phoneNumber: phone,
    phoneNumberVerified: true,
  });
  await db
    .insert(twoFactorMethods)
    .values({ userId: user.userId, method: 'otp', channel: 'sms' });
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(eq(users.id, user.userId));
  return { user, phone };
}

function expectOneDiagnosis(
  lines: readonly string[],
  diagnosis: readonly string[],
  secrets: readonly string[]
) {
  expect(lines).toHaveLength(1);
  const [line = ''] = lines;
  for (const field of diagnosis) expect(line).toContain(field);
  for (const secret of secrets) expect(line).not.toContain(secret);
}

/** The six-digit codes inside the texts the provider was asked to send. */
const codesIn = (texts: readonly string[]) =>
  texts.flatMap((text) => text.match(/\d{6}/g) ?? []);

test('the two-factor send, answered by asAuthError', async () => {
  const { user, phone } = await smsUser();
  const { cookie } = await signIn(user);
  const texts = failingSms();
  const lines = errorLines();

  const answered = await post('/api/auth/two-factor/otp/send', {}, cookie);
  expect(answered.status).toBeGreaterThanOrEqual(400);
  expect(texts).toHaveLength(1);
  expectOneDiagnosis(
    lines(),
    ['otp.provider.failed', 'sms', '503'],
    [phone, ...codesIn(texts)]
  );
});

test('the recovery second-factor send, answered by handleApiError', async () => {
  const { user, phone } = await smsUser();
  const grant = await issueRecoveryGrant({
    userId: user.userId,
    excludeContactKind: 'email',
    options: recoveryOptions(await readEnrolmentState(user.userId), 'email'),
  });
  const texts = failingSms();
  const lines = errorLines();

  const answered = await post('/api/auth/forgot-password/second-factor/send', {
    grant,
    option: 'otp:phone',
  });
  expect(answered.status).toBe(500);
  expect(texts).toHaveLength(1);
  expectOneDiagnosis(
    lines(),
    ['otp.provider.failed', 'sms', '503'],
    [phone, ...codesIn(texts)]
  );
});

test('the anonymous recovery send, answered by the after-response line', async () => {
  const user = await seedUser();
  failNextMail(
    Object.assign(new Error(`535 rejected for ${user.email}`), {
      code: 'EAUTH',
    })
  );
  const lines = errorLines();

  const answered = await post('/api/auth/forgot-password/send', {
    channel: 'email',
    email: user.email,
  });
  expect(answered.status).toBe(200);
  await settleDelivery();
  expectOneDiagnosis(
    lines(),
    ['after-response task failed', 'otp.provider.failed', 'email', 'EAUTH'],
    [user.email, '535 rejected']
  );
}, 30_000);
