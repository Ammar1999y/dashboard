// ⚠️ Mirrored by CHECK `chk_attempt_number_max` (db/schema.ts): changing it needs a migration.
export const OTP_MAX_ATTEMPTS = 5;
// ⚠️ Mirrored by CHECK `chk_verify_attempt_number_max` (db/schema.ts): changing it needs a migration.
export const OTP_MAX_VERIFY_ATTEMPTS = 5;
// ⚠️ Mirrored by CHECK `chk_verify_attempt_daily_max` (db/schema.ts): changing it needs a migration.
// Failed verifies per proof row, so one flow cannot deny another; survives resends.
// Not charged by the anonymous purposes: their guesses are bounded per code.
export const OTP_MAX_DAILY_VERIFY_ATTEMPTS = 15;
// ⚠️ Mirrored by CHECK `chk_otp_challenges_guesses_max` (db/schema.ts): changing it needs a migration.
// Guesses per anonymous code. With no daily cap behind it, this times the
// per-destination send quota is the whole brute-force bound.
export const OTP_MAX_CHALLENGE_GUESSES = 3;
export const OTP_BLOCK_DURATION_HOURS = 6;
