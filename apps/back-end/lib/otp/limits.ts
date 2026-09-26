// ⚠️ Baked into DB CHECK constraint `chk_attempt_number_max` (db/schema.ts).
// Changing this value requires generating a new migration to keep the DB in sync.
export const OTP_MAX_ATTEMPTS = 5;
// ⚠️ Baked into DB CHECK constraint `chk_verify_attempt_number_max` (db/schema.ts).
// Changing this value requires generating a new migration to keep the DB in sync.
export const OTP_MAX_VERIFY_ATTEMPTS = 5;
// Failed verifies per (userId, contactKind, purpose) — the unique key of a proof
// row, so one flow's failures cannot deny another. Anchored per row rather than
// rolling, and survives resends so a new code cannot reset it.
export const OTP_MAX_DAILY_VERIFY_ATTEMPTS = 15;
export const OTP_BLOCK_DURATION_HOURS = 6;
