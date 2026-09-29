/**
 * `bun scripts/check-two-factor-rollout.ts <methods> [channels]`
 *
 * Answers the one question a method-list or channel-list change cannot be made
 * safely without: **how many accounts does this strand?**
 *
 * A user is stranded when they hold `two_factor_enabled` and, under the PROPOSED
 * configuration, no enrolment of theirs survives the intersection of intent,
 * capability and the enabled sets. Post-refusal that is not a downgrade — it is
 * a hard 403 at their next sign-in and an administrative reset each, so an
 * unsized rollout is an outage.
 *
 * Read-only, and it takes the proposed configuration as ARGUMENTS rather than
 * from the environment: the point is to ask before the environment changes.
 *
 * ⚠️ Everything imported here has to be free of load-time environment reads, or
 * that is not true. `@app/shared/validation/enums` and `two-factor-lists` exist
 * for it: `validation/two-factor.ts` parses the CURRENT value at load and
 * throws on a malformed one — exactly the state an operator runs this to get
 * out of.
 *
 *   bun scripts/check-two-factor-rollout.ts totp,backup_code
 *   bun scripts/check-two-factor-rollout.ts totp,otp sms
 *
 * Exit code 1 when anyone would be stranded. The intersection here MUST mirror
 * `offeredMethods` in `lib/auth/two-factor/methods.ts`; it is expressed in SQL
 * because it has to run against a database this process does not otherwise open.
 */
import { PHONE_ENABLED } from '@app/shared/config';
import { isPhoneChannel } from '@app/shared/validation/enums';
import {
  parseTwoFactorMethods,
  parseTwoFactorOtpChannels,
} from '@app/shared/validation/two-factor-lists';

import { connectPreflightDatabase } from './preflight-database';

const [methodsArg, channelsArg] = process.argv.slice(2);
if (!methodsArg)
  throw new Error(
    'usage: bun scripts/check-two-factor-rollout.ts <methods> [otp-channels]'
  );

const sql = connectPreflightDatabase();

/**
 * ⚠️ The RUNTIME's parse, never a copy. A copy is free to fall behind the
 * runtime's lists and to be lenient where the server is not — empty entries
 * and duplicates are a refusal to boot — so this gate would certify a
 * configuration the deployment rejects.
 */
const methods = parseTwoFactorMethods(methodsArg);

/**
 * The EFFECTIVE channel list, after the same `PHONE_ENABLED` filter the runtime
 * applies — otherwise this certifies `email,sms` on a deployment with phone
 * support off, where the runtime drops `sms` and refuses every phone-only user
 * at sign-in. The dropped entries are reported below rather than swallowed:
 * an operator who typed `sms` has to be told it will not take effect.
 */
const requestedChannels = parseTwoFactorOtpChannels(channelsArg);
const channels = requestedChannels.filter(
  (channel) => PHONE_ENABLED || !isPhoneChannel(channel)
);
const droppedChannels = requestedChannels.filter(
  (channel) => !channels.includes(channel)
);

/**
 * Bun's SQL driver binds a JS array as a comma-joined STRING, which Postgres
 * then refuses as a malformed array literal. Both lists are already checked
 * against a closed allow-list above, so the literal cannot carry anything but
 * those names.
 */
const asArrayLiteral = (values: readonly string[]) => `{${values.join(',')}}`;

interface StrandedRow {
  id: string;
  email: string;
  enrolled: string | null;
}

try {
  // `usable` is the intersection, per user: the method is in the proposed list,
  // the capability behind it exists, and for `otp` the channel is in the
  // proposed channel list and the contact it names is verified.
  const stranded = await sql<StrandedRow[]>`
    WITH usable AS (
      SELECT m.user_id
      FROM two_factor_methods m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN two_factor_credentials c ON c.user_id = m.user_id
      WHERE m.method = ANY(${asArrayLiteral(methods)}::text[]::two_factor_method[])
        AND (
          (m.method = 'totp' AND c.verified IS TRUE)
          OR (m.method = 'backup_code'
              AND c.backup_codes_acknowledged_set_id IS NOT NULL
              AND c.backup_codes_acknowledged_set_id = c.backup_codes_set_id
              AND c.backup_codes_remaining > 0)
          OR (m.method = 'passkey'
              AND EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = m.user_id))
          OR (m.method = 'otp'
              AND m.channel::text = ANY(${asArrayLiteral(channels)}::text[])
              AND ((m.contact_kind = 'email' AND u.email_verified IS TRUE)
                OR (m.contact_kind = 'phone' AND u.phone_number_verified IS TRUE)))
        )
    )
    SELECT u.id,
           u.email,
           (SELECT string_agg(DISTINCT m.method::text || COALESCE(':' || m.contact_kind, ''), ',')
              FROM two_factor_methods m WHERE m.user_id = u.id) AS enrolled
    FROM users u
    WHERE u.two_factor_enabled IS TRUE
      AND u.deleted_at IS NULL
      -- The user half of the eligibility predicate the sign-in path uses
      -- (lockEligibleAuthUser); its role check is not repeated, so an account
      -- whose role refuses login still counts. A suspended account cannot
      -- reach the second factor at all, so it cannot be stranded by this
      -- change — counting it failed the gate over accounts nobody can sign in
      -- to, and the administrative resets it demanded would have been busywork.
      AND u.is_active IS TRUE
      AND u.id NOT IN (SELECT user_id FROM usable)
    ORDER BY u.email
  `;

  const [enabled] = await sql<{ total: number }[]>`
    SELECT count(*)::int AS total
    FROM users
    WHERE two_factor_enabled IS TRUE
      AND deleted_at IS NULL
      AND is_active IS TRUE
  `;

  console.log(
    JSON.stringify(
      {
        msg: 'twoFactor.rolloutPreflight',
        proposedMethods: methods,
        proposedOtpChannels: channels,
        ...(droppedChannels.length > 0 && {
          ignoredOtpChannels: droppedChannels,
          ignoredBecause:
            'PHONE_NUMBER_MODE is disabled in packages/shared/src/config.ts',
        }),
        accountsWithTwoFactor: enabled?.total ?? 0,
        strandedAccounts: stranded.length,
        // Bounded: the count is the decision, the sample is for the ticket.
        sample: stranded.slice(0, 20).map((row) => ({
          id: row.id,
          email: row.email,
          enrolled: row.enrolled,
        })),
      },
      null,
      2
    )
  );

  if (stranded.length > 0) {
    console.error(
      `${stranded.length} account(s) would be left two-factor-enabled with nothing to prove it. ` +
        'Each needs POST /api/dash/users/:id/two-factor/reset before this configuration ships.'
    );
    // `exitCode`, not `exit()`: the `finally` below still has to close the pool.
    process.exitCode = 1;
  }
} finally {
  await sql.close();
}
