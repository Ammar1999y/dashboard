// Import-free: `db/schema.ts` reads these widths, and `lib/audit/index.ts`
// imports `db/schema.ts`.

// ⚠️ Column widths in db/schema.ts. Changing one requires a new migration.
/** The longest textual IP address: an IPv4-mapped IPv6 address. */
export const IP_ADDRESS_MAX = 45;
export const USER_AGENT_MAX = 512;
export const API_PATH_MAX = 2048;
