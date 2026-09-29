import { errorClassOf, logSanitized } from '@/utils/log';

import { admitWindow, getRateLimitStore } from './store';

interface StoreFailureLog {
  msg: 'rate-limit store error';
  scope: string;
  errorClass: string;
}

/**
 * A limiter failure without the raw store error or the key.
 *
 * Keys end in data worth withholding (an email address or phone number), and
 * `sanitizeForLog` keeps free-text messages by policy, so a driver that ever
 * interpolated a bound parameter into its message would otherwise reach the
 * log. The operation and the error class are all an outage needs.
 *
 * `scope` is the identifier's prefix, safe because every scope is a
 * compile-time constant or an interpolation of a closed union, and none
 * contains a colon. `tests/unit/rate-limit-log-boundary.test.ts` derives the
 * full set from `ROUTES` and asserts it; a scope built from request data would
 * break that.
 */
export function describeStoreFailure(
  error: unknown,
  opts: { identifier: string }
): StoreFailureLog {
  return {
    msg: 'rate-limit store error',
    scope: opts.identifier.split(':', 1)[0] ?? '',
    errorClass: errorClassOf(error),
  };
}

interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the next request is allowed; 0 on success. */
  retryAfter: number;
  /** The store failed and the check failed open. */
  degraded: boolean;
}

/**
 * Fixed-window rate limit check. `identifier` encodes the scope
 * (`users.create:<ip>`).
 *
 * Fixed windows keep the sustained rate but admit up to twice the limit around
 * a boundary.
 *
 * There is deliberately no refund primitive: a refund cannot commit with the
 * work it refunds, so every failed refund over-charges a real user. A budget
 * that needs outcome-specific accounting wants a counter that commits with the
 * outcome.
 */
export async function rateLimit(opts: {
  identifier: string;
  limit: number;
  window: number;
  /** Units this request spends. Defaults to 1. */
  cost?: number;
}): Promise<RateLimitResult> {
  const windowMs = opts.window * 1000;
  const cost = opts.cost ?? 1;

  // `SQL_CONSUME` cannot refuse a cost over the whole budget: both its INSERT
  // and its rollover branch write `cost` unconditionally.
  if (!Number.isSafeInteger(cost) || cost < 1 || cost > opts.limit)
    return {
      success: false,
      limit: opts.limit,
      remaining: 0,
      retryAfter: opts.window,
      degraded: false,
    };

  try {
    const now = Date.now();
    const windowStart = now - (now % windowMs);
    const admitted = admitWindow(getRateLimitStore(), {
      key: opts.identifier,
      windowStart,
      cost,
      expiresAt: windowStart + windowMs,
      limit: opts.limit,
    });

    // No row: refused without a write, and the statement's WHERE proves the
    // stored row is in the `windowStart` bound above. Do not read it back —
    // a concurrent rollover between the two would overstate `retryAfter` by a
    // whole window.
    if (!admitted) {
      return {
        success: false,
        limit: opts.limit,
        remaining: 0,
        // At least 1s, so a compliant client does not hot-loop when the window
        // rolls over within the current second.
        retryAfter: Math.max(
          1,
          Math.ceil((windowStart + windowMs - now) / 1000)
        ),
        degraded: false,
      };
    }

    const used = Number(admitted.count);
    return {
      success: true,
      limit: opts.limit,
      remaining: Math.max(0, opts.limit - used),
      retryAfter: 0,
      degraded: false,
    };
  } catch (error) {
    logSanitized('error', describeStoreFailure(error, opts));
    return {
      success: true,
      limit: opts.limit,
      remaining: opts.limit,
      retryAfter: 0,
      degraded: true,
    };
  }
}
