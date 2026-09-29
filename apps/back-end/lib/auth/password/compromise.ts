import { createHash } from 'node:crypto';

import { betterFetch } from '@better-fetch/fetch';

import {
  HTTP_STATUS,
  MSG_PASSWORD_COMPROMISED,
} from '@app/shared/api-messages';
import { CustomError } from '@app/shared/error-class';

import { logSanitized } from '@/utils/log';

const HIBP_RETRIES = 2;
const HIBP_RETRY_BASE_MS = 75;
// Per attempt, so an HIBP outage bounds the whole check instead of stalling
// every password-setting write.
const HIBP_ATTEMPT_TIMEOUT_MS = 1000;

/**
 * k-Anonymity check against the HaveIBeenPwned Passwords API: only the first 5
 * characters of the SHA-1 hash are sent. Throws `CustomError` (400) when the
 * password appears in known breaches.
 *
 * **The only implementation, and it FAILS OPEN — both deliberate.** Do not also
 * register Better Auth's `haveIBeenPwned` plugin: it fails closed, so the two
 * would disagree on an outage.
 *
 * After `HIBP_RETRIES + 1` bounded attempts an unreachable HIBP logs
 * `hibp.degraded` and the password is ACCEPTED: a third party being down must
 * not take account creation, password reset and credential rotation down with
 * it, and a breached password that slips through is still subject to every
 * other control. The cost: during an outage every password-setting path accepts
 * a known-breached password, recorded only by the log line. Alert on
 * `hibp.degraded`.
 */
export async function checkPasswordCompromise(password: string): Promise<void> {
  const sha1Hash = createHash('sha1')
    .update(password, 'utf8')
    .digest('hex')
    .toUpperCase();
  const prefix = sha1Hash.slice(0, 5);
  const suffix = sha1Hash.slice(5);

  for (let attempt = 0; attempt <= HIBP_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      HIBP_ATTEMPT_TIMEOUT_MS
    );
    try {
      const { data, error } = await betterFetch<string>(
        `https://api.pwnedpasswords.com/range/${prefix}`,
        {
          headers: {
            'Add-Padding': 'true',
            'User-Agent': 'BetterAuth Password Checker',
          },
          signal: controller.signal,
        }
      );

      if (error) throw new Error(`HIBP API returned ${error.status}`);

      if (
        data
          .split('\n')
          .some((line) => line.split(':', 1)[0]?.toUpperCase() === suffix)
      ) {
        throw new CustomError(
          MSG_PASSWORD_COMPROMISED,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      return;
    } catch (error) {
      if (error instanceof CustomError) throw error;
      logSanitized('error', { msg: 'hibp.degraded', attempt, error });
      if (attempt < HIBP_RETRIES) {
        await new Promise((r) =>
          setTimeout(r, HIBP_RETRY_BASE_MS * (attempt + 1))
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
