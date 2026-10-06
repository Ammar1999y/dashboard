/**
 * The closed value sets this application shares with its PostgreSQL enums.
 *
 * ⚠️ NO imports and NO environment reads: `db/schema.ts` (and so
 * `drizzle-kit generate`) and `scripts/check-two-factor-rollout.ts`, which judges
 * a PROPOSED configuration, load this without parsing the current
 * `NEXT_PUBLIC_ENABLED_*` values. Anything that depends on what is ENABLED
 * belongs in `validation/otp.ts` or `validation/two-factor.ts`.
 */

// The email/phone split is declared HERE and nowhere else: `isPhoneChannel`,
// the per-contact quota grouping, the phone-only schemas and the availability
// flags all derive from these two lists. `OTP_CHANNELS` is the concatenation,
// so its order — which the `otp_channel` pgEnum depends on — stays stable.
// ⚠️ Changing these requires a DB migration (otp_channel pgEnum).
export const EMAIL_OTP_CHANNELS = ['email'] as const;
export const PHONE_OTP_CHANNELS = ['sms', 'whatsapp'] as const;
export const OTP_CHANNELS = [
  ...EMAIL_OTP_CHANNELS,
  ...PHONE_OTP_CHANNELS,
] as const;

export type OtpChannel = (typeof OTP_CHANNELS)[number];
export type PhoneOtpChannel = (typeof PHONE_OTP_CHANNELS)[number];

// Every verification session is purpose-bound so a proof cannot authorize a
// different action. All values are wired except the reserved 'change_password'.
// ⚠️ Changing this list requires a DB migration (otp_purpose pgEnum).
export const OTP_PURPOSES = [
  'verify_contact',
  'passwordless_login',
  'forgot_password',
  'change_password',
  'change_email',
  'change_phone',
  'two_factor',
] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

// ⚠️ Changing this list requires a DB migration (two_factor_method pgEnum).
export const TWO_FACTOR_METHODS = [
  'totp',
  'otp',
  'backup_code',
  'passkey',
] as const;

export type TwoFactorMethod = (typeof TWO_FACTOR_METHODS)[number];

// ⚠️ Changing these requires a DB migration (file_kind / bucket_type pgEnums).
export const FILE_KINDS = ['image', 'document'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const BUCKET_TYPES = ['public', 'private'] as const;
export type BucketType = (typeof BUCKET_TYPES)[number];

// ⚠️ Changing this list requires a DB migration (file_transition pgEnum).
export const FILE_TRANSITIONS = ['to_public', 'to_private', 'cleanup'] as const;
export type FileTransition = (typeof FILE_TRANSITIONS)[number];

const PHONE_CHANNEL_SET = new Set<OtpChannel>(PHONE_OTP_CHANNELS);

/**
 * sms and whatsapp reach the same destination and cost the same, so every
 * per-contact quota and block must treat them as one.
 */
export const isPhoneChannel = (c: OtpChannel): c is PhoneOtpChannel =>
  PHONE_CHANNEL_SET.has(c);

export const CONTACT_KINDS = ['email', 'phone'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

/** The contact a code over `channel` proves possession of. */
export const contactKindOf = (channel: OtpChannel): ContactKind =>
  isPhoneChannel(channel) ? 'phone' : 'email';
