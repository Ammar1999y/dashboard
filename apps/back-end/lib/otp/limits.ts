// ⚠️ Mirrored by CHECK `chk_attempt_number_max` (db/schema.ts): changing it needs a migration.
export const OTP_MAX_ATTEMPTS = 5;
// ⚠️ Mirrored by CHECK `chk_verify_attempt_number_max` (db/schema.ts): changing it needs a migration.
export const OTP_MAX_VERIFY_ATTEMPTS = 5;
// ⚠️ Mirrored by CHECK `chk_verify_attempt_daily_max` (db/schema.ts): changing it needs a migration.
// Failed verifies per proof row, so one flow cannot deny another; survives resends.
export const OTP_MAX_DAILY_VERIFY_ATTEMPTS = 15;
export const OTP_BLOCK_DURATION_HOURS = 6;
