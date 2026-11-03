# Performance and resource-abuse audit, pre-production (2026-10-31 to 2026-11-01)

## Decisions waiting on the owner

1. **Recovery reset and complete hash before checking the code** (`modules/auth/recovery.ts`). Each captcha-solved reset buys one HIBP call and one Argon2 hash whatever the email or code; it is bounded per IP (15/min) and by the password slot. Checking the code first removes the cost, but changes the timing-floor design (P-14). Not changed.
2. **Storage quotas.** Library files have no per-account total, and pending uploads can outrun the daily sweep (about 28,800 a day from one account against a 1,000-row sweep). Quotas are a product choice.

## Not fixed, by decision or rule

- **`?disableCookieCache=true`**, or a missing cache cookie, forces one indexed session read, limited per IP and /48. It is a published parameter, and dropping the cookie has the same effect, so stripping the parameter would narrow the contract without stopping it.
- **`reapUnfiled`** can starve the same way the deleting sweep did. It is inert while no usage sources are registered, and both obvious fixes change visible timestamps.
- **The pool size.** Raising the list pool from 4 to 8 bought nothing (lists p50 3.3 s against 3.5 s, back to back). The list cost was PostgreSQL plans, now fixed above.
