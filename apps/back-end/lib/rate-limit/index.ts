import type { EntityID } from '@app/shared/types';
import type { OtpChannel } from '@app/shared/validation/enums';

import {
  HTTP_STATUS,
  MSG_MISSING_CLIENT_IP,
  MSG_SERVICE_UNAVAILABLE,
  MSG_TOO_MANY_REQUESTS,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';
import { contactKindOf } from '@app/shared/validation/enums';

import { getClientIp } from '@/lib/http/client-ip';

import { logSanitized } from '@/utils/log';

import { rateLimit } from './fixed-window';

/**
 * IPv6 collapses to its /64: ISPs hand a whole /64 to one customer, so keying
 * on the full address lets one host rotate past per-IP caps. IPv4 and
 * IPv4-mapped IPv6 keep the full address.
 *
 * Inputs already passed `getClientIp`'s ipv4/ipv6 validator, so a colon is a
 * sufficient discriminator.
 */
function ipBucket(ip: string): string {
  if (!ip.includes(':')) return ip;

  if (ip.includes('.')) return ip;

  // Expand "::" so exactly four hextets are taken from a compressed address.
  const hasDoubleColon = ip.includes('::');
  const segments = ip.split(':');
  if (hasDoubleColon) {
    const filled: string[] = [];
    let used = false;
    for (const seg of segments) {
      if (seg === '' && !used) {
        used = true;
        const missing = 8 - segments.filter((s) => s !== '').length;
        for (let i = 0; i < missing; i++) filled.push('0');
        continue;
      }
      if (seg === '') continue;
      filled.push(seg);
    }
    while (filled.length < 8) filled.push('0');
    return filled.slice(0, 4).join(':') + '::/64';
  }

  return segments.slice(0, 4).join(':') + '::/64';
}

/**
 * Fails closed with 503 when no client IP resolves, instead of pooling traffic
 * into a shared `ip:unknown` bucket. Behind Cloudflare that means a
 * misconfigured edge or direct origin access, not a client error, and a 400
 * would let the privacy-collapsing OTP catches mistake it for one and return a
 * fake success. Development never gets here: `getClientIp` falls back to
 * loopback there.
 */
// TODO(proxy-trust): the resolved header is trusted on syntax alone; see the
// note on TRUSTED_IP_HEADERS in lib/http/client-ip.ts.
export function ipIdentifier(headers: Headers): string {
  const ip = getClientIp(headers);
  if (!ip) {
    logSanitized('error', {
      msg: 'missing client ip headers',
      cf: headers.get('cf-connecting-ip'),
      forwarded: headers.get('x-forwarded-for'),
      host: headers.get('host'),
      ua: headers.get('user-agent'),
    });
    throw new CustomError(
      MSG_MISSING_CLIENT_IP,
      HTTP_STATUS.SERVICE_UNAVAILABLE
    );
  }
  return `ip:${ipBucket(ip)}`;
}

export function userIdentifier(userId: EntityID): string {
  return `user:${userId}`;
}

/**
 * Independent OTP budgets, so one surface cannot starve another.
 *
 * The global breaker bounds total provider spend; the surface quota bounds
 * messages to ONE destination from ONE surface; per-IP limits at the call
 * sites bound a single caller.
 *
 * There is deliberately no per-destination budget SHARED across surfaces.
 * Charged pre-lookup, requests naming a victim would spend the victim's
 * allowance on every other surface for free; charged post-lookup, whether it
 * was spent is visible from another surface, an account-existence oracle.
 */
export type OtpSendSurface =
  | 'verify_contact'
  | 'recovery'
  | 'passwordless'
  | 'contact_change'
  | 'two_factor'
  // The second factor asked for DURING a password reset: the only channel a
  // locked-out user has left, so the anonymous surfaces must not be able to
  // exhaust it.
  | 'recovery_second_factor';

/** Aggregate outbound send ATTEMPTS per contact kind per day. */
const OTP_GLOBAL_SEND_CAP_PER_DAY = 2000;
/** Per destination per surface per hour; below ~5 a real user's resend hits it. */
const OTP_SURFACE_SEND_CAP_PER_HOUR = 5;
const OTP_DESTINATION_VERIFY_CAP = 10;
const OTP_DESTINATION_VERIFY_WINDOW_S = 600;

const ONE_HOUR_S = 3600;
const ONE_DAY_S = 86_400;

/**
 * The send quota, charged pre-lookup on every request from every surface.
 *
 * Pre-lookup because charging after the account lookup would cap real accounts
 * and not fake ones, an existence oracle. Keyed by destination and surface, so
 * naming addresses nobody owns only exhausts those addresses on that surface.
 *
 * Fails closed: losing the limiter on a paid-delivery path is a cost event.
 */
export async function enforceOtpSurfaceSendQuota(opts: {
  channel: OtpChannel;
  /** Normalized destination (email address / phone number). */
  destination: string;
  surface: OtpSendSurface;
}): Promise<void> {
  await enforceRateLimit({
    scope: `otp.send.surface.${opts.surface}.${contactKindOf(opts.channel)}`,
    identifier: opts.destination.toLowerCase(),
    limit: OTP_SURFACE_SEND_CAP_PER_HOUR,
    window: ONE_HOUR_S,
    failClosed: true,
  });
}

/**
 * The app-wide delivery breaker, charged by `processOtpSend` immediately
 * before dispatch and NOT with the pre-lookup chain: it is the one quota every
 * user shares, so requests naming nonexistent addresses must not be able to
 * spend it. A rejection surfaces as the handlers' usual generic success.
 * Charged before dispatch rather than after, so a provider that is timing out
 * still trips it.
 */
export async function enforceOtpGlobalSendBudget(opts: {
  channel: OtpChannel;
}): Promise<void> {
  await enforceRateLimit({
    scope: 'otp.send.global',
    identifier: contactKindOf(opts.channel),
    limit: OTP_GLOBAL_SEND_CAP_PER_DAY,
    window: ONE_DAY_S,
    failClosed: true,
  });
}

/**
 * Verify-side quota against one destination, keyed per surface.
 *
 * One key across surfaces would let ten junk requests to the anonymous
 * `/api/auth/otp/verify` lock a victim out of `/forgot-password/reset` and
 * `/two-factor/otp/verify` for the window, even with a correct code. Splitting
 * costs no brute-force resistance: the authority on that is the per-proof
 * `OTP_MAX_VERIFY_ATTEMPTS` plus `verification_sessions.verifyAttemptDaily`,
 * both per user, transactional, and reached after this.
 *
 * The 24h verify-FAILURE budget likewise lives only in
 * `verification_sessions.verifyAttemptDaily`, enforced in `processOtpVerify`;
 * a second copy here would need a refund protocol.
 *
 * `surface` is required: a new verify entry point must choose its budget.
 */
export async function enforceOtpVerifyQuota(opts: {
  channel: OtpChannel;
  identifier: string;
  surface: OtpSendSurface;
}): Promise<void> {
  const kind = contactKindOf(opts.channel);
  await enforceRateLimit({
    scope: `otp.verify.dest.${opts.surface}.${kind}`,
    identifier: opts.identifier.toLowerCase(),
    limit: OTP_DESTINATION_VERIFY_CAP,
    window: OTP_DESTINATION_VERIFY_WINDOW_S,
    failClosed: true,
  });
}

/**
 * Throws `CustomError(429)` carrying `Retry-After` and `X-RateLimit-*` when
 * over the limit. `scope` keeps per-endpoint counters apart when two endpoints
 * share an identifier.
 */
export async function enforceRateLimit(opts: {
  scope: string;
  identifier: string;
  limit: number;
  /** Window duration in seconds. Defaults to 60. */
  window?: number;
  /**
   * Units this request spends against `limit`. Defaults to 1. For work that
   * varies by orders of magnitude per request, so budget and capacity are
   * sized against each other; see `chargeUploadBudget` in
   * `lib/media/upload.ts`.
   */
  cost?: number;
  /**
   * Reject with 503 when the store is unreachable instead of letting the
   * request through. For auth/OTP paths, where losing the limiter is a
   * security event.
   */
  failClosed?: boolean;
}): Promise<void> {
  const window = opts.window ?? 60;
  const result = await rateLimit({
    identifier: `${opts.scope}:${opts.identifier}`,
    limit: opts.limit,
    window,
    cost: opts.cost,
  });

  if (result.degraded && opts.failClosed) {
    const error = new CustomError(
      MSG_SERVICE_UNAVAILABLE,
      HTTP_STATUS.SERVICE_UNAVAILABLE
    );
    error.responseHeaders = { 'Retry-After': '30' };
    throw error;
  }

  if (result.success) return;

  const error = new CustomError(
    MSG_TOO_MANY_REQUESTS,
    HTTP_STATUS.TOO_MANY_REQUESTS
  );
  error.responseHeaders = {
    'Retry-After': String(result.retryAfter),
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
  };
  throw error;
}
