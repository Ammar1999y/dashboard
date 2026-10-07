/**
 * Both successes of the phone change, which the integration tier cannot reach:
 * it enables no phone OTP channel, so `change-phone` answers 503 first. Run with
 * `email,sms`. The response check, inherited from the tier, holds both answers
 * to their contract and records them for its coverage gate.
 *
 * The verify proves a code seeded for a second user: the send path defers
 * delivery and never returns the code it issued, and a user holds one
 * phone-change proof at a time.
 */
import * as z from 'zod';

import { installEgressGuard } from '../helpers/egress';

installEgressGuard();
const { closeDatabase } = await import('@/db');
const { seedUser, signIn, baseHeaders, uniquePhone } =
  await import('../helpers/session');
const { seedOtpProof } = await import('../helpers/otp');
const { app } = await import('@/app');
const { PUBLIC_ORIGIN } = await import('@/lib/env');
const { drainAfterResponse } = await import('@/lib/http/after-response');

async function post(
  cookie: string,
  path: string,
  body: unknown
): Promise<unknown> {
  const response = await app.handle(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      method: 'POST',
      headers: baseHeaders({
        cookie,
        origin: PUBLIC_ORIGIN,
        'content-type': 'application/json',
      }),
      body: JSON.stringify(body),
    })
  );
  const answer: unknown = await response.json();
  if (response.status !== 200)
    throw new Error(
      `${path} answered ${response.status} ${JSON.stringify(answer)}`
    );
  return answer;
}

const starter = await seedUser();
const starterSession = await signIn(starter);
const started = await post(
  starterSession.cookie,
  '/api/dash/users/me/change-phone',
  {
    currentPassword: starter.password,
    newPhoneNumber: uniquePhone(),
    channel: 'sms',
  }
);
z.object({ data: z.object({ otpSent: z.literal(true) }) }).parse(started);
// The code goes out after the response.
await drainAfterResponse(5000);

const verifier = await seedUser();
const target = uniquePhone();
const { code } = await seedOtpProof({
  userId: verifier.userId,
  identifier: target,
  targetIdentifier: target,
  purpose: 'change_phone',
  code: '246810',
  channel: 'sms',
});
const verifierSession = await signIn(verifier);
const verified = await post(
  verifierSession.cookie,
  '/api/dash/users/me/change-phone/verify',
  { newPhoneNumber: target, channel: 'sms', code }
);
z.object({ data: z.object({ verified: z.literal(true) }) }).parse(verified);

await closeDatabase();
console.log('change-phone answered both of its successes.');
