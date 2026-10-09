/**
 * Subprocess body for `presign-window.test.ts`: the media signing window
 * against the REAL presigner, which every test tier replaces through its
 * preload. Run with `bun --no-env-file`, so nothing but the arguments and the
 * throwaway R2 variables the test passes reaches it. Prints ONE line of JSON.
 */
import { signingWindow } from '@/lib/media/signing';
import { getPresignedUrl } from '@/lib/r2/client';

const KEY = 'm/2026/10/0198f3c4-6f0b-7c4e-9b1a-1d2e3f405162.webp';

const [mode, ...args] = process.argv.slice(2);

function sign(nowMs: number) {
  return getPresignedUrl({
    key: KEY,
    bucketType: 'private',
    ...signingWindow(nowMs),
    responseCacheControl: 'private, max-age=600',
  });
}

switch (mode) {
  case 'window': {
    const urls = await Promise.all(args.map((ms) => sign(Number(ms))));
    console.log(JSON.stringify({ urls }));
    break;
  }

  case 'ceiling': {
    // The longest lifetime the presigner accepts, signed at a past window start.
    const { signingDate } = signingWindow(Number(args[0]));
    const url = await getPresignedUrl({
      key: KEY,
      bucketType: 'private',
      signingDate,
      expiresIn: Number(args[1]),
    });
    console.log(JSON.stringify({ url }));
    break;
  }

  default: {
    throw new Error(`unknown mode ${mode ?? '(none)'}`);
  }
}
