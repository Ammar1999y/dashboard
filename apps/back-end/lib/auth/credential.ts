// Import-free: `db/schema.ts` reads `CREDENTIAL_ISSUER` at load, so an import
// here closes a cycle through the schema.

export const CREDENTIAL_PROVIDER_ID = 'credential' as const;

export const GOOGLE_PROVIDER_ID = 'google' as const;

/**
 * Spelled out again in `chk_credential_issuer`, so a change needs a migration.
 * Better Auth never reads it: it finds the credential account by provider and
 * `accountId === user.id`.
 */
export const CREDENTIAL_ISSUER = 'local:credential' as const;
