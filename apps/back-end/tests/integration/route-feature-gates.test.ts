/**
 * A binding whose build-time feature is off is neither registered nor
 * published, in the running document or on the deployed surface, and answers
 * the 404 the handlers' own feature gate gave before the bindings withheld the
 * route. A Better Auth path whose feature is off is absent from the allowlist.
 * With every feature on, nothing changes.
 *
 * The OTP switch is environment: `otp-off.test.ts` asserts it off, in its own
 * row. The phone switch is a source constant, so its case is a child process
 * that replaces it, with its own `SQLITE_DIR` so its requests spend no budget
 * this worker's limiter reads.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RouteState } from '../helpers/route-report';

import { BINDINGS } from '@/modules';

import { compareCodeUnits } from '@/utils/text';

import { resetRateLimits } from '../helpers/rate-limit';
import {
  expectServed,
  expectWithheld,
  OTP_ROUTES,
  otpAuthPathState,
  PHONE_ROUTES,
  routeReport,
} from '../helpers/route-report';

const RUNNER = 'tests/fixtures/_route-feature-gates-child.ts';

const sqliteDir = await mkdtemp(path.join(os.tmpdir(), 'route-gates-'));

beforeEach(resetRateLimits);

afterAll(async () => {
  await rm(sqliteDir, { recursive: true, force: true });
});

test('every feature-gated row declares its switch', () => {
  const gated = BINDINGS.filter(
    (binding) => binding.options.enabled !== undefined
  ).map((binding) => binding.entry.path);
  expect(gated.toSorted(compareCodeUnits)).toEqual(
    [...OTP_ROUTES, ...PHONE_ROUTES].toSorted(compareCodeUnits)
  );
});

test('in this configuration every gated route is served and published', async () => {
  const report = await routeReport();
  expectServed(report, [...OTP_ROUTES, ...PHONE_ROUTES]);
  expect(otpAuthPathState()).toEqual({
    allowed: true,
    known: true,
    routed: true,
  });
}, 30_000);

test('with phone disabled, the phone routes are withheld and the OTP routes are not', async () => {
  const proc = Bun.spawn(['bun', '--no-env-file', RUNNER], {
    env: {
      ...process.env,
      SQLITE_DIR: sqliteDir,
      NEXT_PUBLIC_ENABLED_OTP_CHANNELS: 'email',
      NEXT_PUBLIC_ENABLED_2FA_METHODS: 'totp',
      NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect({ code, err: code === 0 ? '' : err }).toEqual({ code: 0, err: '' });
  // The app's request log shares stdout.
  const line = out.split('\n').find((entry) => entry.startsWith('{"routes"'));
  const { routes } = JSON.parse(line ?? '') as { routes: RouteState[] };
  expectWithheld(routes, PHONE_ROUTES);
  expectServed(routes, OTP_ROUTES);
}, 60_000);
