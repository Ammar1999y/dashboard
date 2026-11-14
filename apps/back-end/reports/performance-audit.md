# Performance and resource-abuse audit, pre-production (2026-10-31 to 2026-11-01)

## Decisions waiting on the owner

1. **Recovery reset and complete hash before checking the code** (`modules/auth/recovery.ts`). Each captcha-solved reset buys one HIBP call and one Argon2 hash whatever the email or code; it is bounded per IP (15/min) and by the password slot. Checking the code first removes the cost, but changes the timing-floor design (P-14). Not changed.

## Not fixed, by decision or rule

- **`?disableCookieCache=true`**, or a missing cache cookie, forces one indexed session read, limited per IP and /48. It is a published parameter, and dropping the cookie has the same effect, so stripping the parameter would narrow the contract without stopping it.
