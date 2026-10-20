# Performance audit: fixed findings

These findings were in `performance-audit.md` and have since been removed from it because they are fixed. The open ones are still in `performance-audit.md` and its Arabic summary. P-14 and P-14b were not fixed: they moved to `TODO.md` under "Do later".

Everything below is uncommitted on branch `http-layer`. Unless a section says otherwise, "before → after" numbers come from the same probe run before and after the fix, on the Windows dev box under load. Timings are relative; statement, encode and call counts don't depend on load. After the fixes, all tiers passed on better-auth 1.7.10, drizzle-orm 0.45.4 and Bun 1.4.3: unit 2966, integration 1713 across 5 configurations, process 131, matrix in all 6 configurations. Lint and both type-checks were clean.

Paths are relative to `apps/back-end/`.

---

## Already fixed when the audit was re-checked (removed 2026-10-16)

The HTTP-layer rewrite and other work had already fixed these. The re-check found them fixed:

| ID                    | Problem in the first audit                                                                      | What fixed it                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1                   | Better Auth endpoints that use `sessionMiddleware` dropped the refreshed `session_token` cookie | `lib/auth/path-policy.ts` reads the session in its before hook and queues its cookies; all 13 two-factor endpoints and the passkey list now deliver both cookies |
| C-6                   | Private media URLs changed every second, so the browser never cached them                       | `lib/media/signing.ts` signs per 10-minute window and adds `private, max-age=600`; live R2 honours it                                                            |
| P-11 (boot part)      | Each container start loaded the app twice to build the OpenAPI document                         | The Dockerfile runs `server.ts` directly, and the document is generated lazily                                                                                   |
| P-19 (token exchange) | The Google token exchange had no timeout                                                        | `lib/auth/oauth/token-exchange.ts` aborts at 5 s, including a body that arrives slowly                                                                           |
| P-12 (part)           | Upload called `getSession` twice, and the path policy read the session three times              | The upload gate's actor is reused, and the session read is memoised per request                                                                                  |

---

## Fixed on 2026-10-16

### Cookies and sessions

**C-2. A revoked or suspended session got a 401 that cleared no cookies.**

- **Before:** after a session row was deleted, `me/*`, `/openapi.json` and the two-factor settings answered 401 with no `Set-Cookie`, and the permission routes answered 200 from the cache. A suspended user was even handed a fresh 5-minute cache.
- **Fix:** any refused session (row gone, user suspended or deleted) now expires the token, cache and dont_remember cookies on every path, through Better Auth's own `deleteSessionCookie`. The Better Auth paths send each cookie exactly once (`lib/permissions/checker.ts`, `lib/http/session.ts`, `lib/auth/path-policy.ts`, `lib/auth/session/live.ts`, `lib/auth/errors.ts`).
- **Result:** 401 with all three cookies expired; with that jar applied, `get-session` returns null on every route.
- **Tests:** `tests/integration/session-cookie-delivery.test.ts` (revoked row, suspended user, suspended user with an aged row and an expired cache, exactly one `Set-Cookie` per name).

**C-3. Renaming yourself left the old name in the session for up to 5 minutes.**

- **Fix:** `PUT /api/dash/users/me` returns refreshed session cookies, the same way the contact-change handlers do (`modules/users/me.ts`). The OpenAPI document now lists `Set-Cookie` on that route.
- **Test:** `get-session` shows the new name right after the PUT.

**C-4. A 401 thrown inside `getSession` became a 500.**

- **Fix:** `authenticatedSession` catches Better Auth's 401, reads the cookie expiries from `kAPIErrorHeaderSymbol`, queues them and answers 401. `refreshSessionCookies` had the same gap and now returns them too. On Better Auth paths, the null session goes through the same refusal.
- **Result:** users table and preferences: 500 → 401 with the cookies expired.

**P-12 (rest of the upload and `/openapi.json` part). The same session row was checked twice per request.**

- **Fix:** `requireSession` runs its liveness check through the live-grants query and returns those rows, and the permission checks reuse them. The 401-before-400 order is kept. A duplicate liveness check on two passkey paths was also removed.
- **Result:**
  - Upload with a cache cookie: 6 → 5 statements, 2 → 1 session-row reads.
  - `/openapi.json`: 2 → 1 session-row reads.
- **Still open:** Better Auth paths with no cache cookie, recorded in the audit.

### Sign-in and two-factor

**P-3. Better Auth deleted expired verification rows on every lookup, partly inside our `FOR UPDATE` transactions.**

- **Fix:** `disableCleanup: true` on `verification` (`lib/auth/index.ts`). Every reachable reader checks expiry, and the nightly sweep still deletes expired rows.
- **Result:**
  - Cleanup statements on `verify-totp` / OTP send / OTP verify: 14 / 4 / 6 → 0.
  - `verify-totp` behind another user's held lock: 1 556 ms → 71 ms.

**P-6 (parts a, c, d, e, f, g). Sign-in made far more statements than it needed.**

- **Fixes:**
  - The challenge is resolved once per request (memoised on the request).
  - The enrolment read is one statement instead of four.
  - Standalone audit writes no longer open a transaction.
  - The re-reads of the TOTP secret, the state row and the user's email are gone.
  - Recovery reads the enrolment state once.
  - `/reauth/methods` no longer re-reads the user and role.
- **Result:**

  | Flow                             | Statements       | Transactions  |
  | -------------------------------- | ---------------- | ------------- |
  | Password sign-in, no 2FA         | 13 → 9           | 2 → 1         |
  | 2FA step 1                       | 20 → 16          | 3 → 1         |
  | 2FA step 2 (`verify-totp`)       | 54 → 27          | 3 → 1         |
  | **Password + TOTP**              | **74 → 43**      | **6 → 2**     |
  | 2FA OTP send / verify            | 16 / 40 → 8 / 29 | 1 / 4 → 1 / 2 |
  | Forgot-password reset (2FA user) | 18 → 10          |               |

- **Still open:** part b (the session created then deleted in step 1), recorded in the audit.

**P-9. `auditLog` forced a transaction around a single INSERT.**

- **Fix:** `auditLog` accepts `db` or a transaction. Standalone sites, and the single-statement transactions in `trusted-device.ts` and `recovery/grant.ts`, no longer open one.

**P-13. The reauth window check made 4 queries in a row.**

- **Fix:** `hasAdminReauth` is now 1 query, checking only the method that was recorded (`lib/auth/reauth/window.ts`, `methods.ts`).

**P-19 (JWKS). Google's signing keys were fetched on every OAuth callback.**

- **Fix:** one key-set resolver at module level, without the forced reload. A missing key against an empty set still answers `signing_keys_unavailable`.
- **Result:** 6 callbacks: 6 → 1 key-set fetches.

### Database

**P-2. PostgreSQL prepared statements were never freed, so dashboard filters grew backend memory without limit.**

- **Fix:** data-table list reads run on a separate pool, `dataTableDb` (`db/index.ts`), that never prepares statements and refuses writes (`default_transaction_read_only`). All three list routes use it. Every new list table only needs to run its two reads there.
- **Result:** 1 500 distinct users-list filter shapes:
  - Old pool: 0 → 1 596 prepared statements, backend memory 1.67 → 65.1 MB.
  - New pool: 0 → 0, memory 1.67 → 2.33 MB.
  - List latency unchanged within noise.
- **Rejected options, measured:**
  - `prepare: false` everywhere: short queries became about twice as slow, and jsonb and `Date` parameters broke.
  - Bounding filter shapes: still combinatorial.
  - `DEALLOCATE` sweeps: they break Bun's statement cache.
  - `maxLifetime` / `idleTimeout`: on Bun 1.4.3 they abort statements and transactions that are still running.
- **Also:** 4 more connections per process (`DATA_TABLE_POOL_CONNECTIONS`), documented in `coolify-deployment.md`.
- **Test:** `tests/integration/data-table-pool.test.ts`.

**P-8. Every transaction rebuilt Drizzle's relational config.**

- **Fix:** the config and dialect are built once in `db/transaction.ts`, with one `BunSQLSession` per transaction.
- **Result:** one-statement transaction, median 1 320 → 868 µs.

**P-10. A role delete locked every live member before refusing because the role has members.**

- **Fix:** an unlocked live-member check runs first. The lock and the final authority check are unchanged.
- **Result:**
  - 875-member role: 7.5–56 ms and 875 row locks → 1.7–3.5 ms and no locks.
  - The refusal is now immediate, instead of waiting on a member's row lock.

**P-17 (database guards). Each guard cost an extra round trip.**

- OTP send: the advisory lock was removed, and the users-row lock serializes sends. 0 advisory waits were ever seen.
- OTP verify: the daily SUM was folded into the locked select (5 → 4 statements).
- Users GET: the scope check reuses the rows it already loaded (3 → 2).
- Permissions PUT: the matrix is read once (9 → 8).

**P-29. The permissions list showed `usersCount` 0 for every role and scanned all of `users` on every request.**

- **Fix:** the count is correlated to `roles.id` properly.
- **Result:** a role with 875 members lists 875; the full-table scan is gone.
- **Also:** the matching entry in `review-findings.md` was removed.

### Media

**P-4 (encode search). Each image upload ran 6–7 full encodes.**

- **Fix:** a guided quality search (`lib/media/image/optimize.ts`) that picks the same rung as before with fewer encodes. Every `optimizeImage` now logs `iterations` and `durationMs`.
- **Result:** 2048 px photos sent the way the dashboard sends them now take 2–4 encodes instead of 6–7, with identical output. A PNG that fits at q95 still takes 1.
- **Still open:** the second encoder slot, recorded in the audit.

**P-5 and P-5b. An SVG upload froze the whole server for up to about 1 s, and the SVG libraries loaded at boot.**

- **Fix:** sanitise, svgo and the recheck run in a Bun Worker (`lib/media/image/svg-jobs.ts`, `svg-worker.ts`), started on the first SVG. It shares the encoder's admission rules (one job running, 4 waiting) and has a 15 s per-job timeout. A crash or bad reply answers a 500, and unsanitised markup can never be accepted.
- **Result:**
  - Longest event-loop gap: 806–1 313 ms → 9–84 ms.
  - App import at boot: +131–137 MiB / 3.8–4.3 s → +83–87 MiB / 2.1–2.8 s.
  - All 558 test-suite SVG inputs give byte-identical results (153 stored, 405 refused).
- **Still open:** the cost of a refused SVG, recorded in the audit.

**P-15. Deleting a private file waited on a Cloudflare purge it didn't need.**

- **Fix:** only public rows are purged (`lib/media/lifecycle.ts`).
- **Result:**
  - 200 private files: 7 purge batches → 0.
  - With Cloudflare down: 0 removed → all 200 removed.

**P-26. The purge's "25 s budget" could run about 45 s.**

- **Fix:** the deadline is carried into each attempt, and no attempt starts after it, even when the rate-limit reservation is slow (`lib/cloudflare/purge.ts`).
- **Result:** 44.9 s → 25.0 s.

**P-21. The sweeps purged one URL per Cloudflare call.**

- **Fix:** the orphan drain and transition retry batch up to 30 URLs per call, and each failure maps back to its own row.
- **Result:** 100 orphans: 100 calls → 4 calls.

**P-22. Bulk delete, move and claim wrote one audit INSERT per row under the tree lock.**

- **Fix:** `auditMany` writes one multi-row INSERT (`lib/audit/index.ts`), and `auditLog` shares its row builder.
- **Result:**
  - Deleting 200 files and 1 folder: 214 → 14 statements in the locked transaction.
  - Moving 50 items: 61 → 12.

**P-23. Media reads and uploads ran queries one after another.**

- **Fix:**
  - The entity upload uses `.returning(…)` instead of reading its own insert back.
  - Folder listing, folder checks, breadcrumbs, subfolders and search run in parallel. A missing folder still answers 404.
- **Result:** the entity upload went from 6 to 4 statements, and the folder listing from 5 serial stages to all reads overlapping.

**P-27. Maintenance passes had no time limit while holding a pool connection.**

- **Fix:** each orphan and transition pass gets a 10-minute budget, stops after 3 consecutive timeouts, and passes an abort signal down to the R2 calls. Unfinished rows keep their markers for the next run.
- **Result:**
  - One hung R2 delete: 45.4 s → ends at the signal's deadline.
  - 10 hung orphans: 10 attempts → 3.

**P-17 (HEAD after COPY). Publish and unpublish made an extra HEAD request.**

- **Fix:** the copy is verified from the COPY result's own ETag; the target HEAD is gone. Confirmed on live R2.
- **Result:** about 700 ms saved per publish or unpublish from this box.

### Infrastructure and tests

**P-1b and P-1c. The rate-limit index doubled SQLite WAL writes, and a comment about writer locks was wrong.**

- **Fix:** migration 3 drops `rate_limit_expires_at`, `RATE_LIMIT_SCHEMA_VERSION` is now 3, and the comment is corrected.
- **Result:**
  - WAL frames per admission: 2.00 → 1.00 (same key), 2.90 → 1.49 (realistic keys).
  - Checkpoints per 20k admissions: 39 → 19 and 61 → 31.
  - Total stall: 1 582 → 489 ms.
- **Also:** an image built before this change won't start on a migrated volume (noted in `coolify-deployment.md`).
- **Still open:** the remaining checkpoints, recorded in the audit.

**P-11 (serialisation). `/openapi.json` was serialised again on every request, and the first request generated the document.**

- **Fix:** the serialised body is cached next to the document, and in production it is built right after `listen`.
- **Result:**
  - Per-request cost: 5.2–9.5 ms → 3.3–3.9 ms.
  - The body is byte-identical to before.

**P-18. The unused `lib/cache` store was created and swept every 15 minutes.**

- **Fix:** the cache half of the job was removed. The rate-limit sweep it shares stays.

**P-28. Retention reported "no backlog" after skipping rows that were locked.**

- **Fix:** after a short final batch, each table runs a non-locking "anything still overdue?" check, and `hasMore` now reports a backlog behind locked rows.

**T-1. The test drain hooks cost about 106 ms per test, and a test that left background work stuck still passed.**

- **Fixes:**
  - A drain that doesn't settle now fails the test, and shared mocks are not reset over unfinished work.
  - Tests that enqueued nothing skip the 50 ms wait.
  - A later test is not blamed for an earlier test's work that settled late.
- **Result:**
  - 100 hook pairs: 10.7 s → 54 ms.
  - Unit tier: about 15 min → about 5.5 min.
- **Test:** `tests/unit/deferred-work.test.ts`.

**T-2. A retention test passed even with the production code broken.**

- **Fix:** it is replaced by a real test through `startSchedule`: a job that throws must log `scheduled sweep failed` with its error class, and scheduling must continue.

---

## Review follow-ups (same day)

An independent review of the fixes found no correctness, security or contract regressions. Its four small notes were fixed:

- A purge attempt could still start after the deadline when the rate-limit reservation was slow (P-26).
- The Better Auth 401 sent the same cookie twice (C-2).
- The test harness could blame a later test for earlier stuck work that settled late (T-1).
- Two different patterns were used to return refreshed cookies (C-3).
