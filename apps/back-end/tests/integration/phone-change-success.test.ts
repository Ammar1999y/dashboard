/**
 * The phone change's 2xx answers, which only a deployment with a phone OTP
 * channel can give: the integration tier's phone-contact row runs them, and
 * without them its response-contract coverage gate would see neither.
 */
import { beforeAll, expect, test } from 'bun:test';
import type { SignedInSession } from '../helpers/session';

import { app } from '@/app';

import { changePhone, verifyPhoneChange } from '@app/shared/api/users';
import { PHONE_OTP_AVAILABLE } from '@app/shared/validation/otp';

import { resetTables } from '../helpers/database';
import { expectData } from '../helpers/expect-body';
import { seedOtpProof } from '../helpers/otp';
import {
  authedRequest,
  seedUser,
  signIn,
  uniquePhone,
} from '../helpers/session';

beforeAll(async () => {
  await resetTables();
}, 30_000);

const post = (session: SignedInSession, path: string, body: unknown) =>
  app.handle(
    authedRequest(session, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

test.if(PHONE_OTP_AVAILABLE)(
  'a phone change answers that its code was sent',
  async () => {
    const user = await seedUser();
    const { data } = await expectData(
      await post(await signIn(user), changePhone.path, {
        currentPassword: user.password,
        newPhoneNumber: uniquePhone(),
        channel: 'sms',
      }),
      changePhone
    );
    expect(data).toEqual({ otpSent: true });
  },
  30_000
);

// The send path never returns the code it issued, so the proof is seeded.
test.if(PHONE_OTP_AVAILABLE)(
  'a phone change answers that the number was verified',
  async () => {
    const user = await seedUser();
    const target = uniquePhone();
    const { code } = await seedOtpProof({
      userId: user.userId,
      identifier: target,
      targetIdentifier: target,
      purpose: 'change_phone',
      code: '246810',
      channel: 'sms',
    });
    const { data } = await expectData(
      await post(await signIn(user), verifyPhoneChange.path, {
        newPhoneNumber: target,
        channel: 'sms',
        code,
      }),
      verifyPhoneChange
    );
    expect(data).toEqual({ verified: true });
  },
  30_000
);
