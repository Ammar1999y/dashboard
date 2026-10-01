/**
 * Toggles that live in code rather than only in the environment because several
 * gate DB CHECK constraints and FK behaviour, so changing one needs a migration.
 *
 * ⚠️ Keep this file import-free: `db/schema.ts` and the client bundle both load it.
 */

const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Riyadh';

function resolveBusinessTimezone(): string {
  const configured = process.env.NEXT_PUBLIC_BUSINESS_TIMEZONE?.trim();
  if (!configured) return DEFAULT_BUSINESS_TIMEZONE;

  try {
    // Refused rather than defaulted: a typo resolving to the default zone ships
    // an off-by-one-day filter.
    new Intl.DateTimeFormat('en-US', { timeZone: configured });
  } catch {
    throw new Error(
      `Invalid NEXT_PUBLIC_BUSINESS_TIMEZONE: "${configured}" is not a recognized IANA time zone`
    );
  }

  return configured;
}

/**
 * Calendar boundaries for date filtering are resolved in this one zone, so a
 * "created on 2 Aug" filter means the same rows for every viewer and the server.
 *
 * `NEXT_PUBLIC_` so both bundles resolve the same value: a server-only variable
 * is `undefined` in the client, which reintroduces the per-host divergence.
 */
export const BUSINESS_TIMEZONE = resolveBusinessTimezone();

export type PhoneNumberMode = 'required' | 'optional' | 'disabled';

/**
 * Controls the role of the phone number across the whole app:
 * - 'required': every active user must have a phone number; it is part of the
 *   account identity and `phone_number` is NOT NULL at the DB level.
 * - 'optional': a phone number may be present and verifiable, but is never
 *   mandatory. A present `phone_number_verified = true` still requires a
 *   `phone_number` to exist (CHECK constraint).
 * - 'disabled': phone is removed from every flow — sms/whatsapp OTP is off,
 *   `phone_number_verified` is unused, and the change-phone endpoints 404.
 *
 * ⚠️ Toggling this requires a new migration (`bun drizzle-kit generate`): it
 * gates the `chk_phone_disabled` / `chk_phone_verified_requires_phone` CHECK
 * constraints and the `phone_number` nullability on the users table.
 */
export const PHONE_NUMBER_MODE = 'optional' as PhoneNumberMode;

export const PHONE_ENABLED = PHONE_NUMBER_MODE !== 'disabled';

export const PHONE_REQUIRED = PHONE_NUMBER_MODE === 'required';

/**
 * A correct password alone does not obtain a session: the email must also be
 * verified. The gate runs after the password is checked and answers with the
 * distinct `EMAIL_NOT_VERIFIED` code, so it leaks nothing to a caller who does
 * not know the password.
 */
export const REQUIRE_EMAIL_VERIFICATION = false as boolean;

/**
 * The same policy for the phone number, enforced only while phone is enabled
 * and an enabled OTP channel can verify it (the login gate in `lib/auth`).
 */
export const REQUIRE_PHONE_VERIFICATION = false as boolean;

/**
 * OTP bypass: a contact-verification send marks the contact verified, and an
 * email/phone change commits, WITHOUT a code. Recovery and passwordless always
 * issue a real code. For development, or a deployment with no OTP provider whose
 * owner does not want contact verification.
 *
 * ⚠️ This constant is the switch; nothing reads `NEXT_PUBLIC_OTP_AUTO_VERIFY`.
 */
export const OTP_AUTO_VERIFY = false;

/**
 * Whether a submitted `rememberMe` is honoured, i.e. whether the UI offers the
 * choice at all.
 *
 * `false` ignores the client's value and gives every session the REMEMBERED
 * lifetime, which is also what an absent field means (`submittedRememberMe`);
 * it does not pin sessions to the short lifetime.
 */
export const HONOUR_REMEMBER_ME = true as boolean;

/**
 * Whether passwordless sign-in (`/api/auth/passwordless/*`) is served; a disabled
 * surface answers 404.
 *
 * ⚠️ Deliberately separate from `OTP_ENABLED`: passwordless is the weakest first
 * factor, and switching it off must not take down the contact verification,
 * recovery and second factor that share the OTP machinery.
 */
export const PASSWORDLESS_ENABLED = true as boolean;
