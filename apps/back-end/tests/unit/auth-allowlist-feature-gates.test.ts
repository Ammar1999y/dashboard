/**
 * A Better Auth path whose feature is off is absent from the allowlist, so
 * `app.ts` answers it as an unknown path (shared budget, 404, Better Auth never
 * reached) and `lib/http/openapi/` does not publish it.
 *
 * Runs in a SUBPROCESS per configuration because the allowlist is derived at
 * module load. `--no-env-file` so the repository `.env` cannot supply the
 * channel list a case meant to omit.
 */
import { expect, test } from 'bun:test';

const RUNNER = 'tests/fixtures/_auth-allowlist-child.ts';

interface Membership {
  allowed: boolean;
  known: boolean;
  routed: boolean;
}

async function membership(
  path: string,
  env: Record<string, string>
): Promise<Membership> {
  const proc = Bun.spawn(['bun', '--no-env-file', RUNNER, path], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(err.trim()).toBe('');
  expect(code).toBe(0);
  return JSON.parse(out.trim()) as Membership;
}

test('/passwordless/verify is not served while no OTP channel is enabled', async () => {
  expect(
    await membership('/passwordless/verify', {
      NEXT_PUBLIC_ENABLED_OTP_CHANNELS: '',
    })
  ).toEqual({ allowed: false, known: true, routed: false });
});

test('/passwordless/verify is served while an OTP channel is enabled', async () => {
  expect(
    await membership('/passwordless/verify', {
      NEXT_PUBLIC_ENABLED_OTP_CHANNELS: 'email',
    })
  ).toEqual({ allowed: true, known: true, routed: true });
});
