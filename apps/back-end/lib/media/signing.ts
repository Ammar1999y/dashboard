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

/**
 * Only a private image may be kept, and no longer than its link repeats: a
 * public object's stored headers already govern it, and a document's link is
 * opened, not embedded.
 */
export const PRIVATE_IMAGE_CACHE_CONTROL = `private, max-age=${SIGNING_WINDOW_S}`;

/** Download and preview links must never be served from a cache. */
export const UNCACHED = 'no-store';
