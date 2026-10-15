/**
 * A deployment with no OTP channel withholds every OTP binding and the Better
 * Auth OTP path, and keeps the phone bindings. The counterpart of
 * `route-feature-gates.test.ts`.
 *
 * Runs only in the `no-otp-channel` row of `tests/helpers/run.ts`.
 */
import { beforeEach, expect, test } from 'bun:test';

import { OTP_ENABLED } from '@app/shared/validation/otp';

import { resetRateLimits } from '../helpers/rate-limit';
import {
  expectServed,
  expectWithheld,
  OTP_ROUTES,
  otpAuthPathState,
  PHONE_ROUTES,
  routeReport,
} from '../helpers/route-report';

beforeEach(resetRateLimits);

test('the row really has no OTP channel', () => {
  expect(OTP_ENABLED).toBe(false);
});

test('the OTP routes are withheld and the phone routes are not', async () => {
  const report = await routeReport();
  expectWithheld(report, OTP_ROUTES);
  expectServed(report, PHONE_ROUTES);
}, 30_000);

test('/passwordless/verify is known but neither allowlisted nor routed', () => {
  expect(otpAuthPathState()).toEqual({
    allowed: false,
    known: true,
    routed: false,
  });
});
