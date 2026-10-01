/**
 * A table route whose build-time feature is off is neither registered nor
 * published, in the running document or the deployed one, and answers the same
 * 404 its handler's `requireFeature` gave. With the feature on, nothing changes.
 *
 * Runs in a SUBPROCESS per configuration because `enabled` is read at module
 * load. Its own `SQLITE_DIR`, so its requests spend no budget this worker's
 * limiter reads.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ROUTES } from '@/routes';

import { MSG_PAGE_NOT_FOUND } from '@app/shared/api-messages';

import { toPublishedManifest } from '@/lib/http/route-manifest';

import { compareCodeUnits } from '@/utils/text';

const RUNNER = 'tests/fixtures/_route-feature-gates-child.ts';

const OTP_ROUTES = [
  '/api/auth/forgot-password/reset',
  '/api/auth/forgot-password/second-factor/send',
  '/api/auth/forgot-password/complete',
  '/api/auth/forgot-password/send',
  '/api/auth/otp/send',
  '/api/auth/otp/verify',
  '/api/auth/passwordless/send',
];
const PHONE_ROUTES = [
  '/api/dash/users/me/change-phone',
  '/api/dash/users/me/change-phone/verify',
];

interface RouteState {
  path: string;
  registered: boolean;
  published: boolean;
  deployed: boolean;
  status: number;
  body: unknown;
}

interface ChildReport {
  routes: RouteState[];
  featureAnswer: { status: number; body: unknown };
}

const sqliteDir = await mkdtemp(path.join(os.tmpdir(), 'route-gates-'));

afterAll(async () => {
  await rm(sqliteDir, { recursive: true, force: true });
});

async function report(
  mode: 'phone-on' | 'phone-off',
  otpChannels: string
): Promise<ChildReport> {
  const proc = Bun.spawn(
    ['bun', '--no-env-file', RUNNER, mode, ...OTP_ROUTES, ...PHONE_ROUTES],
    {
      env: {
        ...process.env,
        SQLITE_DIR: sqliteDir,
        NEXT_PUBLIC_ENABLED_OTP_CHANNELS: otpChannels,
        NEXT_PUBLIC_ENABLED_2FA_METHODS: 'totp',
        NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect({ code, err: code === 0 ? '' : err }).toEqual({ code: 0, err: '' });
  // The app's request log shares stdout.
  const line = out.split('\n').find((entry) => entry.startsWith('{"routes"'));
  return JSON.parse(line ?? '') as ChildReport;
}

function expectWithheld(child: ChildReport, paths: readonly string[]): void {
  expect(child.featureAnswer).toEqual({
    status: 404,
    body: { success: false, message: MSG_PAGE_NOT_FOUND, data: null },
  });
  for (const path of paths)
    expect(child.routes.find((route) => route.path === path)).toEqual({
      path,
      registered: false,
      published: false,
      deployed: false,
      ...child.featureAnswer,
    });
}

function expectServed(child: ChildReport, paths: readonly string[]): void {
  for (const path of paths) {
    const route = child.routes.find((entry) => entry.path === path);
    expect(route).toMatchObject({
      registered: true,
      published: true,
      deployed: true,
    });
    expect(route?.status).not.toBe(404);
  }
}

test('every feature-gated row declares its switch', () => {
  const gated = ROUTES.filter((route) => route.enabled !== undefined).map(
    (route) => route.path
  );
  expect(gated.toSorted(compareCodeUnits)).toEqual(
    [...OTP_ROUTES, ...PHONE_ROUTES].toSorted(compareCodeUnits)
  );
});

test('in this configuration every gated route is served and published', () => {
  const published = new Set(
    toPublishedManifest(ROUTES, true).map((e) => e.path)
  );
  for (const path of [...OTP_ROUTES, ...PHONE_ROUTES])
    expect(published.has(path)).toBe(true);
});

test('with no OTP channel, the OTP routes are withheld and the phone routes are not', async () => {
  const child = await report('phone-on', '');
  expectWithheld(child, OTP_ROUTES);
  expectServed(child, PHONE_ROUTES);
}, 60_000);

test('with phone disabled, the phone routes are withheld and the OTP routes are not', async () => {
  const child = await report('phone-off', 'email');
  expectWithheld(child, PHONE_ROUTES);
  expectServed(child, OTP_ROUTES);
}, 60_000);
