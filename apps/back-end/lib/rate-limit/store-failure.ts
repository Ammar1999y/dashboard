import { errorClassOf } from '@/utils/log';

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
