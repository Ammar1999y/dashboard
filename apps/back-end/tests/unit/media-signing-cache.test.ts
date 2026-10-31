/**
 * `presignInWindow` signs a link once per window and never hands one link's
 * URL to different parameters.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';

import {
  presignInWindow,
  SIGNING_WINDOW_S,
  signingWindow,
} from '@/lib/media/signing';
import * as r2Client from '@/lib/r2/client';

const signer = spyOn(r2Client, 'getPresignedUrl').mockImplementation(
  async (params) =>
    `signed:${signer.mock.calls.length}:${JSON.stringify(params)}`
);
const signatures = () => signer.mock.calls.length;

afterEach(() => {
  signer.mockClear();
});

const WINDOW_MS = SIGNING_WINDOW_S * 1000;
const start = Date.UTC(2026, 9, 31, 12, 0, 0);

const link = (key: string, extra: Record<string, string> = {}) => ({
  key,
  bucketType: 'private' as const,
  ...extra,
});

test('one window signs each link once; other parameters and the next window sign again', async () => {
  const window = signingWindow(start);
  const first = await presignInWindow({ ...link('a'), ...window });

  expect(
    await presignInWindow({ ...link('a'), ...signingWindow(start + 1000) })
  ).toBe(first);
  expect(signatures()).toBe(1);

  const download = await presignInWindow({
    ...link('a', { responseContentDisposition: 'attachment' }),
    ...window,
  });
  const other = await presignInWindow({ ...link('b'), ...window });
  expect(new Set([first, download, other]).size).toBe(3);
  expect(signatures()).toBe(3);

  const next = await presignInWindow({
    ...link('a'),
    ...signingWindow(start + WINDOW_MS),
  });
  expect(next).not.toBe(first);
  expect(signatures()).toBe(4);
});

test('a link for a window older than the cache is signed and not kept', async () => {
  await presignInWindow({
    ...link('c'),
    ...signingWindow(start + 3 * WINDOW_MS),
  });
  const older = signingWindow(start + 2 * WINDOW_MS);
  await presignInWindow({ ...link('c'), ...older });
  await presignInWindow({ ...link('c'), ...older });

  expect(signatures()).toBe(3);
});

test('a failed signature is not kept', async () => {
  const window = signingWindow(start + 5 * WINDOW_MS);
  signer.mockImplementationOnce(async () => {
    throw new Error('R2 not configured');
  });

  await expect(presignInWindow({ ...link('d'), ...window })).rejects.toThrow(
    'R2 not configured'
  );
  const url = await presignInWindow({ ...link('d'), ...window });

  expect(url).toStartWith('signed:');
});
