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
 * ⚠️ Deliberately FAILS OPEN: an unreachable HIBP logs `hibp.degraded` and the
 * password is accepted, so a third-party outage cannot take password writes
 * down. Alert on `hibp.degraded`. Do not also register Better Auth's
 * `haveIBeenPwned` plugin, which fails closed.
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
