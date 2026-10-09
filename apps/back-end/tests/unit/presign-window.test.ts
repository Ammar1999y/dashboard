/**
 * Signed media links repeat inside a ten-minute window, proved against the real
 * presigner in a child process: every tier's preload replaces it with a stub
 * (`tests/helpers/preload-base.ts`), which could not show that the SigV4 query
 * really is byte-identical, or what the presigner refuses.
 *
 * Local: no database, no network. Signing is a computation; nothing is fetched.
 */
import { describe, expect, test } from 'bun:test';

import { signingWindow } from '@/lib/media/signing';

const RUNNER = 'tests/fixtures/_presign-child.ts';

const R2_ENV = {
  R2_ACCOUNT_ID: 'presign-account',
  R2_ACCESS_KEY_ID: 'presign-access-key',
  R2_SECRET_ACCESS_KEY: 'presign-secret-key',
  R2_PUBLIC_BUCKET: 'presign-public',
  R2_PRIVATE_BUCKET: 'presign-private',
  PATH: process.env.PATH ?? '',
};

async function run(
  argv: string[]
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', '--no-env-file', RUNNER, ...argv], {
    env: R2_ENV,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

const MINUTE = 60_000;
/** A window start: 2026-10-07T10:00:00Z. */
const WINDOW_START = Date.UTC(2026, 9, 7, 10, 0, 0);

describe('the signing window', () => {
  test('starts on a ten-minute boundary and lasts the window plus an hour', () => {
    const inside = signingWindow(WINDOW_START + 9 * MINUTE + 59_999);
    expect(inside.signingDate.toISOString()).toBe('2026-10-07T10:00:00.000Z');
    expect(inside.expiresIn).toBe(70 * 60);
    expect(
      signingWindow(WINDOW_START + 10 * MINUTE).signingDate.toISOString()
    ).toBe('2026-10-07T10:10:00.000Z');
  });

  test('the real presigner repeats a link inside one window and changes it with the next', async () => {
    const result = await run([
      'window',
      String(WINDOW_START),
      String(WINDOW_START + 9 * MINUTE),
      String(WINDOW_START + 10 * MINUTE),
    ]);
    expect(result.code, result.err).toBe(0);
    const { urls } = JSON.parse(result.out) as { urls: string[] };
    const [first, sameWindow, nextWindow] = urls.map((url) => new URL(url));
    expect(sameWindow?.href).toBe(first?.href);
    expect(nextWindow?.href).not.toBe(first?.href);

    expect(first?.searchParams.get('X-Amz-Date')).toBe('20261007T100000Z');
    expect(first?.searchParams.get('X-Amz-Expires')).toBe('4200');
    expect(first?.searchParams.get('response-cache-control')).toBe(
      'private, max-age=600'
    );
    // The S3 endpoint, never the public domain.
    expect(first?.host).toBe('presign-account.r2.cloudflarestorage.com');
    expect(first?.pathname.startsWith('/presign-private/')).toBe(true);
    expect(nextWindow?.searchParams.get('X-Amz-Date')).toBe('20261007T101000Z');
  });

  test('a past signing date still takes the seven-day ceiling, and a longer request is clamped to it', async () => {
    const atCeiling = await run(['ceiling', String(WINDOW_START), '604800']);
    expect(atCeiling.code, atCeiling.err).toBe(0);
    const accepted = new URL(
      (JSON.parse(atCeiling.out) as { url: string }).url
    );
    expect(accepted.searchParams.get('X-Amz-Expires')).toBe('604800');

    // The presigner itself throws above the ceiling; `getPresignedUrl` clamps
    // first, so a caller asking for more still gets a link.
    const above = await run(['ceiling', String(WINDOW_START), '604801']);
    expect(above.code, above.err).toBe(0);
    const clamped = new URL((JSON.parse(above.out) as { url: string }).url);
    expect(clamped.searchParams.get('X-Amz-Expires')).toBe('604800');
  });
});
