// Import-free: `db/schema.ts` reads these widths, and `lib/audit/index.ts`
// imports `db/schema.ts`.

// ⚠️ Column widths in db/schema.ts. Changing one requires a new migration.
/** The longest textual IP address: an IPv4-mapped IPv6 address. */
export const IP_ADDRESS_MAX = 45;
export const USER_AGENT_MAX = 512;
export const API_PATH_MAX = 2048;

/**
 * Trusted edge headers. Shared with Better Auth
 * (`advanced.ipAddress.ipAddressHeaders`) so our limiters, Better Auth's limiter
 * and session IP metadata all read the same source instead of Better Auth
 * defaulting to `x-forwarded-for`. A header nothing in front of the origin sets
 * is attack surface: a forged value is accepted on syntax alone.
 *
 * TODO(proxy-trust): nothing checks that the socket peer is the expected
 * upstream, so a request that reaches the origin directly can forge this
 * header. Resolve once the edge is final and its proxy CIDRs are known:
 * `server.requestIP(request)` asserts the PROXY, and does not replace this
 * header rule.
 */
export const TRUSTED_IP_HEADERS = ['cf-connecting-ip'] as const;
