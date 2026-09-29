// Import-free: `db/schema.ts` reads `CREDENTIAL_ISSUER` at load, so an import
// here closes a cycle through the schema.

export const CREDENTIAL_PROVIDER_ID = 'credential' as const;

export const GOOGLE_PROVIDER_ID = 'google' as const;

/**
 * The `accounts.issuer` value Better Auth requires for a password account.
 *
 * Better Auth identifies an account by `(issuer, accountId)`: `/sign-in/email`
 * looks for `providerId === 'credential' && issuer ===
 * createLocalAccountIssuer('credential')` and answers a plain 401 when nothing
 * matches — so a wrong value is a total password-login outage that reads as
 * "wrong password" and that `tsc` cannot see. Mirrors
 * `createLocalAccountIssuer` (`local:${providerId}`,
 * `@better-auth/core/dist/db/schema/account.mjs`).
 */
export const CREDENTIAL_ISSUER = 'local:credential' as const;
