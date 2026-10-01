// Import-free: `db/schema.ts` reads `CREDENTIAL_ISSUER` at load, so an import
// here closes a cycle through the schema.

export const CREDENTIAL_PROVIDER_ID = 'credential' as const;

export const GOOGLE_PROVIDER_ID = 'google' as const;

/**
 * ⚠️ Mirrors Better Auth's `createLocalAccountIssuer('credential')`. A wrong
 * value is a total password-login outage that reads as "wrong password".
 */
export const CREDENTIAL_ISSUER = 'local:credential' as const;
