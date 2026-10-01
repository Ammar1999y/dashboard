/**
 * Pool ceiling, in its own import-free module because the test harness sizes
 * `bun test --parallel` against it — N worker processes each construct the
 * pool, and the total must stay under the server's `max_connections` — and
 * importing `db/index.ts` for a number would construct a pool as a side effect.
 *
 * `withTransaction` reserves one connection for the whole block, so this is the
 * number of concurrent transactions the process supports before callers queue
 * for up to `POOL_ACQUIRE_TIMEOUT_MS`. Nothing may hold a transaction open
 * across a network call to a third party: that many calls against a hanging
 * peer exhaust the pool and fail every transactional path.
 *
 * Read against the server's `max_connections`: one process must not be able to
 * exhaust it, and a second process (a migration run, a test worker) needs
 * headroom.
 */
export const MAX_POOL_CONNECTIONS = 10;

/**
 * How long `withTransaction` waits for a free connection before answering 503.
 * Bun's `connectionTimeout` bounds only opening a connection; without this a
 * full pool queues callers forever. Kept above the longest legitimate
 * transaction measured (4.6 s, a sign-in burst hashing inside it), so a burst
 * queues rather than fails.
 */
export const POOL_ACQUIRE_TIMEOUT_MS = 10_000;

/** `Retry-After` on the 503s a contended or unreachable database answers. */
export const DATABASE_RETRY_AFTER_S = 2;

// ⚠️ Column widths in db/schema.ts. Changing one requires a new migration.
export const URL_MAX = 500;
export const OTP_IDENTIFIER_MAX = 160;
/**
 * Bound on `verifications.identifier` and `trusted_devices.trust_identifier`.
 * The values are library-shaped, and headroom matters: truncating an identifier
 * would silently collide two challenges instead of failing.
 */
export const VERIFICATION_IDENTIFIER_MAX = 160;
/** Bound on `passkeys.credential_id`, base64url of at most 1023 bytes by spec. */
export const CREDENTIAL_ID_MAX = 1400;
