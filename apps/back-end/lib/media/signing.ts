import { getPresignedUrl } from '@/lib/r2/client';

/**
 * Seconds a signed link repeats, so a browser can reuse what it fetched. No
 * `@/db` import: `tests/fixtures/_presign-child.ts` runs this against the
 * real presigner without the server's secrets.
 */
export const SIGNING_WINDOW_S = 10 * 60;
/** What a link signed at the very end of its window still has left. */
export const SIGNED_LINK_MIN_LIFETIME_S = 60 * 60;

export interface SigningWindow {
  signingDate: Date;
  expiresIn: number;
}

/**
 * Every link signed inside one window is byte-identical, and is valid from the
 * window's start for the window plus the minimum lifetime.
 */
export function signingWindow(nowMs: number): SigningWindow {
  const windowMs = SIGNING_WINDOW_S * 1000;
  return {
    signingDate: new Date(nowMs - (nowMs % windowMs)),
    expiresIn: SIGNING_WINDOW_S + SIGNED_LINK_MIN_LIFETIME_S,
  };
}

type WindowedSigning = Parameters<typeof getPresignedUrl>[0] & SigningWindow;

export const SIGNED_LINKS_MAX = 5000;
const signedLinks = { windowStart: 0, byParams: new Map<string, string>() };

/**
 * `getPresignedUrl`, reusing a link already signed in this window: a link signed
 * inside one window is byte-identical (`tests/unit/presign-window.test.ts`).
 * Keyed on every parameter but the date, so a parameter added later can only
 * miss, never return another link. Full, it drops its oldest entry: clearing
 * it would make one caller paging through a large list re-sign everyone's.
 */
export async function presignInWindow(
  params: WindowedSigning
): Promise<string> {
  const { signingDate, ...signed } = params;
  const windowStart = signingDate.getTime();
  if (windowStart > signedLinks.windowStart) {
    signedLinks.byParams.clear();
    signedLinks.windowStart = windowStart;
  }
  const id = JSON.stringify(signed);
  const hit =
    windowStart === signedLinks.windowStart && signedLinks.byParams.get(id);
  if (hit) return hit;

  const url = await getPresignedUrl(params);
  // The window may have turned while this one was signed.
  if (windowStart === signedLinks.windowStart) {
    const { byParams } = signedLinks;
    if (byParams.size >= SIGNED_LINKS_MAX && !byParams.has(id)) {
      const oldest = byParams.keys().next();
      if (!oldest.done) byParams.delete(oldest.value);
    }
    byParams.set(id, url);
  }
  return url;
}

/**
 * Only a private image may be kept, and no longer than its link repeats: a
 * public object's stored headers already govern it, and a document's link is
 * opened, not embedded.
 */
export const PRIVATE_IMAGE_CACHE_CONTROL = `private, max-age=${SIGNING_WINDOW_S}`;

/** Download and preview links must never be served from a cache. */
export const UNCACHED = 'no-store';
