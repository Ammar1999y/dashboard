/**
 * The single-use reservation RFC 6238 §5.2 requires and the library's verifier
 * does not perform. Shared by sign-in, enrolment confirmation and password
 * recovery, which verify against the same secret.
 */
import type { Executor } from '@/db';
import type { EntityID } from '@app/shared/types';
import type { SymmetricDecryptOptions } from 'better-auth/crypto';

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { db } from '@/db';
import { twoFactorCredentials } from '@/db/schema';
import { createOTP } from '@better-auth/utils/otp';
import { symmetricDecrypt } from 'better-auth/crypto';

/** Must match the library's defaults, which its verifier uses. */
const TOTP_PERIOD_S = 30;
const TOTP_WINDOW = 1;

/**
 * For when the library's `/two-factor/verify-totp` decides, re-reading the
 * clock after this reservation. ⚠️ Not a wider tolerance: the extra period
 * covers a step boundary crossed between the two reads, so every step the
 * library can accept was looked at here.
 */
export const DELEGATED_TOTP_WINDOW = TOTP_WINDOW + 1;

export type TotpVerdict = 'matched' | 'rejected' | 'replayed';

// `@better-auth/utils/otp`'s `constantTimeEqualOTP`, which is not exported. On
// sign-in this runs before the library's comparison, so it is the one measured.
function constantTimeEqual(input: string, expected: string): boolean {
  let difference = input.length ^ expected.length;
  for (let index = 0; index < expected.length; index++)
    /* eslint-disable-next-line unicorn/prefer-code-point -- a fixed step per
       UTF-16 unit is what makes the loop's work independent of the input;
       `codePointAt` consumes a surrogate pair in one step */
    difference |= input.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

/** The step a code is valid for, or `null` when it is valid for none. */
async function matchedStep(
  secret: string,
  code: string,
  window: number
): Promise<number | null> {
  const current = Math.floor(Date.now() / (TOTP_PERIOD_S * 1000));
  const otp = createOTP(secret, { period: TOTP_PERIOD_S });
  let found: number | null = null;
  // No early exit, so timing does not depend on which step matched. Newest
  // first, so the highest matching step is the one reserved.
  for (let offset = window; offset >= -window; offset--) {
    const step = current + offset;
    const matches = constantTimeEqual(code, await otp.hotp(step));
    if (matches && found === null) found = step;
  }
  return found;
}

// A guarded UPDATE, not read-then-write, so exactly one concurrent request
// wins. `false` also covers a user with no credential row.
async function claimStep(
  userId: EntityID,
  step: number,
  executor: Executor
): Promise<boolean> {
  const claimed = await executor
    .update(twoFactorCredentials)
    .set({ lastTotpStep: step })
    .where(
      and(
        eq(twoFactorCredentials.userId, userId),
        or(
          isNull(twoFactorCredentials.lastTotpStep),
          lt(twoFactorCredentials.lastTotpStep, sql`${step}::bigint`)
        )
      )
    )
    .returning({ id: twoFactorCredentials.id });
  return claimed.length > 0;
}

/**
 * `'replayed'` exists for logging only: both it and `'rejected'` must reach the
 * user as the same invalid-code answer.
 *
 * ⚠️ A caller inside a transaction must pass its `executor`: the default takes
 * a second pool connection while the first is held, which deadlocks the pool
 * under concurrency.
 */
export async function consumeTotpCode(
  userId: EntityID,
  secret: string,
  code: string,
  options: { executor?: Executor; window?: number } = {}
): Promise<TotpVerdict> {
  const step = await matchedStep(secret, code, options.window ?? TOTP_WINDOW);
  if (step === null) return 'rejected';
  return (await claimStep(userId, step, options.executor ?? db))
    ? 'matched'
    : 'replayed';
}

export async function readVerifiedTotpSecret(
  userId: EntityID,
  key: SymmetricDecryptOptions['key']
): Promise<string | null> {
  const [credential] = await db
    .select({
      secret: twoFactorCredentials.secret,
      verified: twoFactorCredentials.verified,
    })
    .from(twoFactorCredentials)
    .where(eq(twoFactorCredentials.userId, userId))
    .limit(1);
  if (!credential?.verified) return null;
  return symmetricDecrypt({ key, data: credential.secret }).catch(() => null);
}
