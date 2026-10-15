/**
 * The idle-timeout ceiling for the media routes that call R2 in the request.
 *
 * A CHOSEN bound, not a derived worst case: the visibility saga
 * (`lib/media/visibility.ts`) and a two-bucket bulk delete
 * (`lib/media/lifecycle.ts`) can each run past it with every R2 retry and the
 * purge budget spent. It covers the healthy path with a wide margin; past it
 * the connection drops with the destructive half already logged and the
 * remainder left to the retention sweep, the accepted residual risk. The
 * global `IDLE_TIMEOUT_SECONDS` would drop the healthy path mid-operation.
 *
 * ⚠️ It is the largest term in `MAX_ROUTE_TIMEOUT_SECONDS` (`app.ts`), which
 * sets the shutdown drain window (`lib/shutdown.ts`): raising it lengthens
 * every deploy.
 */
export const MEDIA_ROUTE_TIMEOUT_SECONDS = 120;

/**
 * Per user per minute, shared by both upload routes, so the allowance is per
 * user, not per route; an IP bucket would let one account spend its NAT
 * neighbours' budget. Charged BEFORE the body is read: the kind budgets in
 * `lib/media/upload.ts` need the bytes to know the kind, so this bounds the
 * parsing an account over one of them can still cause. Deferred, because it
 * follows the checks the handler makes (`acceptUpload`).
 */
export const UPLOAD_ADMISSION = {
  scope: 'upload.admission',
  limit: 20,
  failClosed: true,
  by: 'user',
  deferred: true,
} as const;
