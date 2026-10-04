# Back-end performance & resource audit

Date: 2026-10-01. Report only; no code was changed.

**Scope.** All of `apps/back-end`, plus the `packages/shared` modules it runs. Seven parallel auditors each took one area: request pipeline, session and authorization, credentials/2FA/OTP/OAuth, media and storage, database and admin routes, rate-limit/SQLite/maintenance, and a cross-route cookie and caching sweep. Each finding below states how strongly it is proven:

- **PROVEN:** a probe, test or benchmark was run.
- **TRACED:** the full call path was read, including library source in `node_modules`.
- **HYPOTHESIS:** not verified.

I re-checked the two traced findings that touch security against the source myself (P-14 timing floor, P-15 private-delete purge).

**Merged with a second, independent audit** (`reports/performance-audit-2.md`, findings PA2-01 … PA2-10). I checked each PA2 claim against the source before merging it:

- **Same issue in both reports:** PA2-01 = C-5, PA2-02 = C-2, PA2-03 and PA2-04 = P-19, PA2-05 overlaps P-6. Their extra evidence is folded into those entries.
- **Only in PA2:** PA2-06, PA2-07, PA2-08, PA2-09 and PA2-10, added as P-14b, P-26, P-27, P-28 and T-1/T-2.
- **Missed by PA2:** C-1, C-3, C-4, C-6, P-1, P-2, P-3, P-4, P-5, P-7 … P-13 and P-15 … P-18. They were not contradicted, only not covered.
- **Contradictions:** none.

**Workspace change during the audit.** `lib/media/image/svg.ts` was refactored concurrently, and its SVGO config moved to `packages/shared/src/images/svgo-config.ts`. P-5 cites the current lines.

**Environment caveats.**

- All numbers come from the Windows 10 dev box, while the other auditors were running. Treat timings as relative.
- Statement and query counts do not depend on load.
- Nothing was measured on the Linux VPS.
- Versions: Bun 1.4.2, elysia 1.4.30, @elysia/cors 1.4.2, better-auth 1.7.3, better-call 1.4.0, drizzle-orm 0.45.2, PostgreSQL 18.6, SQLite 3.53.2, @aws-sdk/client-s3 3.1127.0, jsdom 30.0.1, svgo 4.1.0.

Paths are relative to `apps/back-end/`.

---

## Summary: the findings most worth doing

| #   | Finding                                                                                                                                                             | Class            | Proof                                  | Fix cost        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------- | --------------- |
| 1   | [C-1](#c-1) Refreshed `session_token` dropped on every Better Auth endpoint that uses `sessionMiddleware` (2FA settings, passkeys)                                  | cookie           | PROVEN                                 | low             |
| 2   | [C-2](#c-2) Revoked session gets a 401 without its cookies cleared on `requireSession` and Better Auth routes; the permission-route twin does clear them            | cookie           | PROVEN                                 | low             |
| 3   | [P-1](#p-1) SQLite WAL auto-checkpoint fsyncs inside a limiter call and freezes the event loop for 5–137 ms, about every 200–250 dashboard requests                 | perf             | PROVEN                                 | low–med         |
| 4   | [P-2](#p-2) PostgreSQL prepared statements are never freed; dashboard filter shapes grow backend memory without limit                                               | resource leak    | PROVEN                                 | low             |
| 5   | [P-3](#p-3) Better Auth deletes expired verifications on every lookup, partly inside our `FOR UPDATE` transactions, which serializes all users' 2FA                 | runs-too-often   | PROVEN                                 | one config line |
| 6   | [P-4](#p-4) Each image upload runs 5–7 full encodes behind one encoder slot per process (about 2.5–2.9 s for a 2048 px image); the 5th concurrent upload gets a 503 | perf             | PROVEN                                 | low             |
| 7   | [P-5](#p-5) An SVG upload blocks the event loop for up to about 0.7 s (new JSDOM per call, svgo multipass)                                                          | perf             | PROVEN                                 | low             |
| 8   | [P-6](#p-6) Password + TOTP sign-in costs 73 statements / about 85 round trips; about 40% is avoidable                                                              | runs-too-often   | PROVEN                                 | medium          |
| 9   | [C-3](#c-3) Self-rename doesn't refresh the session; the old name shows for up to 5 min                                                                             | cookie           | PROVEN                                 | trivial         |
| 10  | [P-14](#p-14) The timing floor holds successful verify/reset/complete responses for 2.5 s with no privacy gain (a full reset waits 7.5 s; 5 s of it can go)         | over-engineering | TRACED, re-checked                     | low             |
| 11  | [T-1](#t-1) Every test pays ≥ 100 ms in drain hooks (about 2 min across the 1 207 tests), and a test with stranded background work still passes green               | test quality     | PROVEN (PA2-10), re-checked            | low             |
| 12  | [P-26](#p-26) The Cloudflare purge's "25 s total budget" allows about 45 s on the request path                                                                      | budget bug       | PROVEN (PA2-07), re-checked            | low             |
| 13  | [P-27](#p-27) Maintenance passes have no time limit and hold a reserved pool connection through every R2 retry                                                      | resource         | PROVEN pool / TRACED duration (PA2-08) | medium          |

---

## 1. Cookie and caching correctness (the "dropped cache cookie" class)

The fix you found holds. It was measured end to end on remember-me, do-not-remember and 2FA-completed sessions, on dashboard reads and writes, on error responses and on `/get-session`. In each case the cache re-mints for 300 s, and the next cached request makes 0 auth queries. The defects below are siblings of it that it does not cover.

### Route table (black-box probe: 19 routes × 9 session states)

| Route class                                                                                                   | Session read via                                       | No cache cookie                  | Row past `updateAge`                    | Row deleted, cache still valid       | Cache-Control                   |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------- | --------------------------------------- | ------------------------------------ | ------------------------------- |
| Permission GETs (users, users/:id, roles, permissions, media…)                                                | `authenticatedSession` → `cachedGrants` / `liveGrants` | +session_data(300)               | +token +data                            | 200 (Known #5)                       | no-store                        |
| `users/:id/sessions`, `/openapi.json` (forceDB)                                                               | `liveGrants`                                           | +data                            | +token +data                            | 401, clears token/data/dont_remember | no-store                        |
| Permission writes, incl. upload's grant                                                                       | `authenticatedSession` + `liveGrants`                  | +data                            | +token +data (422s too)                 | 401 + clears                         | no-store                        |
| `requireSession` routes (me/preferences, me/change-*, dash/auth/reauth, upload's first gate)                  | `authenticatedSession` + `assertLiveSession`           | +data                            | +token +data                            | **401, nothing cleared**             | no-store                        |
| BA `/get-session`                                                                                             | library                                                | +data                            | +token +data                            | 200 from cache                       | no-store + pragma               |
| BA `getSessionFromCtx` (`/reauth/methods`)                                                                    | library                                                | +data (none for do-not-remember) | +token +data                            | **401, nothing cleared**             | no-store                        |
| BA `use:[sessionMiddleware]` (13 endpoints in `enrolment.ts`/`trusted-device.ts`, passkey list/delete/update) | library middleware                                     | +data (none for do-not-remember) | **row slid 24 h, token cookie dropped** | **401, nothing cleared**             | no-store                        |
| sign-in / sign-out                                                                                            | library                                                | mints token + data               | —                                       | sign-out clears all three            | no-store                        |
| OPTIONS preflight                                                                                             | —                                                      | —                                | —                                       | —                                    | none; Max-Age 600, Vary: Origin |
| 404 / 405 / 308 / anonymous 401                                                                               | —                                                      | —                                | —                                       | —                                    | no-store                        |

### <a id="c-1"></a>C-1. Better Auth endpoints that use `sessionMiddleware` keep only the last `Set-Cookie` (PROVEN)

- **Where:**
  - `node_modules/better-call/dist/context.mjs:93`.
  - The app opts in at `lib/auth/two-factor/session-endpoint.ts:17,27`.
  - Passkey endpoints: `node_modules/@better-auth/passkey/dist/index.mjs:535,584,636`.
- **Mechanism:**
  - better-call copies the middleware's response headers with `responseHeaders.set(key, value)` inside a `forEach`. For `set-cookie`, each value overwrites the previous one.
  - On the daily refresh, `setSessionCookie` writes the token and then the cache, so the row slides 24 h but the `session_token` cookie never arrives. The cookie's Max-Age is not extended.
  - `/reauth/methods` uses `getSessionFromCtx` instead of the middleware and delivers both cookies: the control case.
- **Proof:**
  - `scratchpad/cookies/headers-merge.ts` prints `middleware set: 2 after .set merge: [session_data…]`.
  - Route probe: `/two-factor/methods` and `/passkey/list-user-passkeys` show `rowSlidBy=24h set=[+session_data(300)]`. `/reauth/methods` and `/me/preferences` show `+session_token(2419200) +session_data(300)`.
- **Impact:** today low, because the next dashboard read re-slides the cookie. But any future middleware that sets more than one cookie is silently cut to one, and nothing detects it. better-call 1.4.0 is the latest release.
- **Fix:**
  - Replace `use:[sessionMiddleware]` in `session-endpoint.ts` with a handler-level `getSessionFromCtx` + 401, the `/reauth/methods` shape.
  - For the library's passkey endpoints, patch better-call to append `set-cookie`, and report it upstream.
- **Test:** age the session row, strip the cache cookie, call each middleware endpoint, and assert `session_token` is in the response.

### <a id="c-2"></a>C-2. Revoked or suspended session: the 401 does not clear its cookies on two of three paths (PROVEN)

- **Where:**
  - `lib/http/session.ts:78-86`: `requireSession` → `assertLiveSession` throws without queueing cookies.
  - `lib/auth/path-policy.ts:327-336`: `requireLiveSession` 401s in the before hook.
  - The twin that does clear: `lib/permissions/checker.ts:333-336` (`queueRefreshedSessionCookies` before `loginRequired`).
- **Mechanism:** in the "row deleted, cache still valid" state:
  - `me/preferences` GET and PUT, upload and every BA live-session path answer 401 with no `Set-Cookie`.
  - Permission writes and `/openapi.json` answer 401 with three expiries.
  - `/get-session` keeps answering 200 from the cache.
- **Impact:**
  - For up to `cookieCache.maxAge` (5 min), the client's session state says signed in while `me/*` and the 2FA settings endpoints return 401.
  - Each such request re-pays 1–2 queries for a dead session.
  - Not verified: whether the front-end loops between login and dashboard in that window.
  - This is separate from Known #5: the problem is the missing clear, not the read window.
- **Same browser, two answers (PA2-02):** delete the session row, then GET `me/preferences`: 401 with zero `Set-Cookie`. Then GET the users table with the same cookie jar: **200 from the still-valid cache**. The server found the revocation and left the browser's session in place.
- **Fix:**
  - In `requireSession`, catch the liveness 401 and call `queueRefreshedSessionCookies(ctx.headers)` before rethrowing. That is one query, on the failure path only.
  - In `path-policy.ts`, put the expiries on the `APIError`'s own `headers`. Headers set by the before hook are lost on throw: `toResponse` reads `e.headers` (`better-call/dist/to-response.mjs:125`).
- **Test:** delete the session rows, keep the cache cookie, hit `/me/preferences` and `/two-factor/methods`, and assert the token and cache cookies are expired.

### <a id="c-3"></a>C-3. Self-rename leaves the session's name stale (PROVEN)

- **Where:** `app/api/dash/users/[id]/handler.ts:209-219` → `renameSelf` (`lib/users/edit.ts:67`). There is no `refreshSessionCookies` call; the sibling change-email handlers do call it.
- **Proof:** `scratchpad/cookies/self-rename.probe.test.ts` gives `PUT 200 … set-cookie: 0`, and `get-session` afterwards still shows the old name.
- **Fix:** return `cookies: await refreshSessionCookies(ctx.headers)` on the self branch. One query.
- **Test:** the probe above.

### <a id="c-4"></a>C-4. A 401 thrown inside `getSession` becomes a 500 and its cookie expiries are lost (TRACED, rare)

- **Where:**
  - `lib/permissions/checker.ts:67` does not catch.
  - `lib/http/response.ts:153-160` maps anything that is not a `CustomError` to 500.
  - Library side: `better-auth/dist/api/routes/session.mjs`, the `!updatedSession` branch, calls `deleteSessionCookie` and then throws `UNAUTHORIZED` with the expiries attached to the error.
- **When:** the session row is deleted between `findSession` and `updateSession` on the once-a-day refresh request.
- **Fix:** in `authenticatedSession`, catch `isAPIError`, queue `e.headers` cookies and map the status to 401.

### <a id="c-5"></a>C-5. A junk `session_data` cookie switches reads to the stored permission snapshot (PROVEN; Known #15, with new evidence)

- **Where:** `lib/permissions/checker.ts:179-194` (`hasSessionCookieCache`) and `:373-376` (`resolveGrants`).
- **Already known:** Known #15 says reads skip the database whenever a cookie named like the cache is present, even an expired one.
- **New evidence:**
  - The value does not need to be expired. A literal `session_data=garbage` does it.
  - The response then hands back a freshly signed cache cookie, so it repeats indefinitely.
  - `probe3.test.ts`: with the role deactivated directly in the database after sign-in, the request answers 403 without the cookie and **200** with the junk cookie.
  - PA2-01 reproduced it separately with the _user_ deactivated, not the role. Token only: 401. With `session_data=broken`, with `session_data.0=broken` (a chunk name), or with the original cache expired by a 301 s clock advance: **200** in all three cases. The malformed cases log Better Auth's cache JSON parse failure and still get a replacement cache cookie back.
- **Not reachable through the app today:** role and user deactivation delete sessions (`app/api/dash/permissions/[id]/handler.ts:254`, `lib/users/edit.ts:485`). This is defence in depth, not a live bypass.
- **Fix:** have `authenticatedSession` report whether the answer actually came from the cache: a cache cookie was sent and no `session_data` `Set-Cookie` came back. Branch on that flag instead. Neutral on performance.
- **Test:** add a junk-cookie row to `tests/integration/permission-database-path.test.ts`.

### <a id="c-6"></a>C-6. Private media URLs change every second and objects are `no-store`, so the browser never caches them (PROVEN; possibly deliberate)

- **Where:** `lib/media/files.ts:269-275,315-319` (every row is signed on every listing), `lib/r2/client.ts:377-421`, `lib/media/headers.ts:561-562`.
- **Proof:** `scratchpad/media/bench-presign.ts`: 100 signatures cost 104.6 ms of CPU, and the same key signed 1.1 s later gives a different URL, because `X-Amz-Date` moves.
- **Impact:** every listing render or refetch downloads every private image again, up to about 200 KB each with no thumbnails. A 100-row page can mean up to about 20 MB of paid R2 reads, plus about 1 ms of signing CPU per row.
- **Fix:**
  - Round the signing time down to a window, or memoise the URL per key and window, so URLs stay identical inside it.
  - Optionally override the cache header for the signed URL with `ResponseCacheControl: private, max-age=<window>`. Not verified that R2 honours `response-cache-control`.
  - Keeping `no-store` on private media is your privacy call.
- **Test:** signing the same key twice inside one window gives the same URL.

### Clean in this class

- Cookie delivery through the table-route adapter (`withQueuedCookies`) works on success, 4xx and 401, with each cookie once.
- `new Headers()` in `localiseAuthError` and Elysia's `mergeHeaders` both keep multiple `Set-Cookie` headers in Bun 1.4.2.
- `Cache-Control: no-store` is on every JSON response, including 4xx, 5xx, 308, 404, 405 and HEAD.
- Every cookie mint and clear goes through `createAuthCookie`, so Path, Domain, SameSite and Secure match between them.
- Public images are `immutable`, which is safe because keys embed the row id and bytes never change. Unpublish and public delete purge; publish does not need to.
- The 2FA pending state leaks no live session cookie, and every 2FA completion path mints a full 300 s cache.
- Limiter 429/503 responses still go through `withQueuedCookies`.

---

## 2. Performance and resource findings

### <a id="p-1"></a>P-1. WAL auto-checkpoint fsyncs inside a request and blocks the event loop (PROVEN, Windows)

- **Where:**
  - `lib/sqlite/database.ts:29-39,72-80`: WAL with `synchronous=NORMAL`, and `wal_autocheckpoint` left at SQLite's default of 1000 pages.
  - `lib/rate-limit/store.ts:77-96`: one commit per admission.
  - Hot-path callers: `lib/http/adapters/elysia.ts:50`, `app.ts:384`, and every handler's `enforceRateLimit`.
- **Mechanism:** with NORMAL, commits do not fsync; the checkpoint does. SQLite runs the auto-checkpoint inside whichever commit pushes the WAL past 1000 pages. That commit is a synchronous `bun:sqlite` limiter call on the event loop, so every in-flight request waits for it.
- **Admissions per request:**
  - Dashboard table route: 2 (pre-auth per IP, then the per-user limiter).
  - Every `/api/auth/*` request, `get-session` included: 1.
  - Anonymous recovery and passwordless routes: 2–3.
  - Upload: 4.
- **Proof:** `scratchpad/infra/bench-variants.ts`, 30k admissions per row:

  | Config                 | ops/s | p99.9    | max      | calls > 5 ms        |
  | ---------------------- | ----- | -------- | -------- | ------------------- |
  | App config, same key   | 4 642 | 23.06 ms | 136.8 ms | 72 (1 862 ms total) |
  | `wal_autocheckpoint=0` | 6 524 | 1.39 ms  | 9.8 ms   | 4 (27 ms)           |
  | `synchronous=OFF`      | 6 693 | 1.57 ms  | —        | 9                   |
  | `FULL`                 | 284   | —        | —        | —                   |
  - Through the real `rateLimit()`: p50 0.116 ms, p99.9 26 ms, max 53–266 ms.
  - Stalls account for 29–42% of all limiter time and all of its tail.

- **Impact:** one freeze of 5–137 ms per roughly 200–250 dashboard requests on this disk; at 50 req/s, about every 5 s. The VPS figure is unmeasured: rerun `bench-variants.ts` there.
- **Fix options:**
  - (a) Drop the index in P-1b. Half the checkpoints, cheap.
  - (b) Set `wal_autocheckpoint=0` on the request connection and run `wal_checkpoint(PASSIVE)` from a Bun Worker with its own connection, with a guard so a dead worker cannot let the WAL grow without limit.
  - (c) `synchronous=OFF`. Your call: after a power loss the file can be corrupt, and the fail-closed limiter then returns 503 on auth routes until the file is deleted.
- **P-1b. The `rate_limit_expires_at` index doubles WAL writes per admission (PROVEN).**
  - Where: `lib/rate-limit/store.ts:30`; `expires_at` is always in the `SET` (`:89-92`); the index's only readers are the 15-minute sweep and the expiry probe (`:99,104-105`).
  - Mechanism: SQLite rewrites an index entry whenever an indexed column is in the `SET` list, even when the value is unchanged.
  - Proof: `scratchpad/infra/frames.ts` measured WAL frames per admission at 2.00 → 1.00 (same key) and 2.51 → 1.28 (distinct keys).
  - What the sweep loses: without the index it took 630 ms instead of 482 ms for 50k expired rows among 100k, and its empty probe takes 8 ms instead of 0.5 ms, once every 15 min.
  - Cost of the fix: a SQLite migration that bumps `RATE_LIMIT_SCHEMA_VERSION`, after which an older image can no longer boot on that volume.

### <a id="p-2"></a>P-2. Prepared statements are never freed; dashboard filters create them without limit (PROVEN)

- **Where:**
  - `db/index.ts:33`: `new SQL(DATABASE_URL, { max })` with `prepare` at its default (true) and `maxLifetime` / `idleTimeout` at 0, so backends are never recycled.
  - Producers of distinct SQL text:
    - `lib/data-table/params.ts:95-162` and `filter-columns.ts:384`: up to 20 filters × columns × operators, in any order, with `and`/`or` and 10 sort items.
    - Every `inArray` of a different length: `users/[id]/sessions/handler.ts:369`, `filter-columns.ts:265-295`.
- **Proof:**
  - `scratchpad/db/prepared-growth.ts`: 5 000 distinct texts on one connection gave `pg_prepared_statements` = 5 101, and backend memory grew from 1.5 MB to 52 MB.
  - `prepared-filters.ts`: 1 500 valid users-list requests through the real `parseDataTableParams` created 797 statements; memory grew from 1.6 MB to 32 MB, about 38 KB each.
- **Impact:** memory grows for the life of the process. One user with `users.view` at the 60/min limit can add more than 100 MB/h on a small VPS. Normal use grows it slowly.
- **Fix:** set `maxLifetime` (1800–3600 s), and probably `idleTimeout`, on the main pool. The cost is 18–38 ms of cold planning on each new backend's first queries. `prepare: false` would also work, but `db/schema.ts:83` notes jsonb encoding differs under `prepare: true`, so that needs its own check.

### <a id="p-3"></a>P-3. Better Auth's verification cleanup runs on every lookup, partly inside our locking transactions (PROVEN; found by two auditors)

- **Where:**
  - `lib/auth/index.ts:164`: `verification` has no `disableCleanup`.
  - Library: `better-auth/dist/db/internal-adapter.mjs:753`.
  - Reached from `lib/auth/two-factor/challenge.ts:102,139,286`, the last inside the transaction, and from the library's `verify-two-factor.mjs:19`, inside `runPluginVerifier`'s transaction.
- **Mechanism:** every `findVerificationValue` adds a `select … where expires_at < now limit 100` and an unbounded `delete … where expires_at < now`.
  - Extra statements: 14 per `verify-totp`, 4 per OTP send, 6 per OTP verify.
  - Two of those deletes run inside `withTwoFactorChallengeTransaction`, which holds the user's `FOR UPDATE`. So row locks on _other users'_ expired rows are held until that transaction commits.
- **Proof:** `scratchpad/credentials/otp-and-lock.test.ts`. With an expired row lock held for 1 500 ms by another transaction, `verify-totp` took 1 616 ms, against 159 ms without one.
- **Fix:** `verification: { modelName: 'verifications', disableCleanup: true }`. The nightly sweep at `lib/maintenance/database.ts:328` already removes expired rows.
  - What this relies on: every reader checks `expiresAt`. The app's readers do (`challenge.ts:104,140,292`), and so does OAuth state (`state.mjs:141`).
  - The library's own `verifyTwoFactor` does not check expiry. It is only reached after the `challenge.ts:292` check, so **that check must stay**.

### <a id="p-4"></a>P-4. Image upload: 5–7 full encodes behind one encoder slot (PROVEN)

- **Where:**
  - `lib/media/image/optimize.ts:374-488`: the quality search.
  - `:490-513`: one slot, queue limit 4.
  - `:295-309`: the source is decoded again on every attempt.
  - The browser already sends WebP at up to 2048 px, under 1 MiB, quality 0.95 (`apps/front-end/utils/images/client-image-compression.ts:22-28`).
- **Mechanism:** for a q95 WebP input over the 200 KB target, the first attempt (q95, full width) reproduces roughly the input's size and can never fit. Then come the 800 px floor and a binary search.
- **Proof:** `scratchpad/media/bench-realistic.ts`:
  - 2048×1536: 6 encodes in 2 573 ms; the first took 559 ms and produced 781 KB.
  - 2048×1365: 7 encodes in 2 905 ms.
  - Bun encodes on worker threads: 4 at once took 1 335 ms against 998 ms for 1. So the single slot is what limits throughput.
  - Event-loop lag stayed at 2–32 ms, so encoding does not block it.
- **Impact:** about 20–24 image uploads per minute per process. One user selecting 6 images gets a 503 (`processingBusy`).
- **Fix:**
  - Skip the first attempt when the input is WebP/PNG and well over the target.
  - Optionally, a better quality search (usually 2–3 encodes).
  - Optionally, 2 slots. Worst case is about 100 MB of decoded pixels per slot; that one is your call.
  - **Do not** pre-resize through a PNG intermediate. PA2 measured that variant as worse: on a 25 MP PNG, 7.456 s against 5.883 s for the current path, with a 32.6 MB intermediate.
- **Monitor:** log `iterations` and `ms` on every `optimizeImage`. Today they are logged only when the target is missed.

### <a id="p-5"></a>P-5. SVG upload blocks the event loop for up to about 0.7 s (PROVEN)

- **Where:**
  - `lib/media/image/svg.ts:33` (`sanitizeSvgServer`): a new JSDOM per call, never closed.
  - `svg.ts:14`: `optimize(data, SVGO_CONFIG)`, where `packages/shared/src/images/svgo-config.ts:8` sets `multipass: true`.
  - Called from `process.ts:126,178`.
  - Sanitising runs in `admitUpload`, before the megapixel budget, and SVGs skip the encoder slot.
- **Proof:**
  - `bench-svg.ts`: at the caps (490 elements, 374 KiB), sanitise took 284 ms and svgo 431 ms. A 13 KiB SVG still took 134 ms.
  - `bench-jsdom.ts`: `new JSDOM` costs 24.7 ms per call; parsing with a reused window costs 1.7 ms.
  - `bench-svgo-pass.ts`: multipass took 834 ms against 322 ms for one pass, with identical output.
- **Impact:** one account at its 20/min limit holds about 14 s of event loop per minute. A few accounts together stall every route, sign-in included.
- **Fix:** reuse one JSDOM window, drop or cap multipass (about 60% saved), or move both into a Bun Worker.
  - The SVGO config is now shared, and its comment says the browser runs it before upload "so both sides store the same markup". So multipass has to change in `packages/shared`, which also changes the front-end, or the parity breaks.
  - Because the browser has already optimised a legitimate upload, the server's pass over it probably settles after one pass. The 0.7 s cost is the attacker case: raw markup sent straight to the API. Not verified.
- **Startup side (P-5b, PROVEN):** jsdom and svgo load at boot (`process.ts:22` → `svg.ts:3-4`).
  - Measured: jsdom +61.6 MB RSS and 1.3–2.7 s of import warm; svgo +27.8 MB. Boot RSS is about 175 MB.
  - Importing them lazily makes `validateSvgUpload` async, which is a contract change. An import failure must then surface as a clear 500.

### <a id="p-6"></a>P-6. Sign-in is about 85 round trips; about 40% is avoidable (PROVEN counts, TRACED causes)

| Flow                              | Statements | Transactions | ~Round trips |
| --------------------------------- | ---------- | ------------ | ------------ |
| Password sign-in, no 2FA          | 13         | 2            | 17           |
| 2FA step 1 (password → challenge) | 20         | 3            | 26           |
| 2FA step 2 (`verify-totp`)        | 53         | 3            | 59           |
| **Password + TOTP**               | **73**     | **6**        | **~85**      |
| 2FA OTP send / verify             | 16 / 39    | 1 / 4        | 18 / 47      |
| `POST /api/dash/auth/reauth`      | 14         | 2            | 18           |

- **a.** The challenge is resolved twice on `verify-totp` and `verify-backup-code`: `path-policy.ts:238` → `challenge.ts:196`, then `two-factor/plugin.ts:225,268`. That is 11 duplicate statements, 7 after P-3. Fix: memoise it per request in a `WeakMap` keyed on `ctx.request`; both checks stay.
- **b.** Step 1 creates a session and then deletes it (`plugin.ts:154-188` → `issue.ts:234,304`; the same in `passwordless.ts`). That costs about 7 statements and 1 transaction, two cookies set and then cleared, and a `loginSuccess` audit row for a session nobody receives.
  - Fix: issue the challenge before the session is created.
  - The catch: `EMAIL_NOT_VERIFIED` would then be answered after 2FA instead of after the password. That is a contract change and your call.
- **c.** 4 of the 6 transactions wrap a single audit INSERT (`session/hooks.ts:520`, `issue.ts:355`, `challenge.ts:376`). See P-9.
- **d.** `readEnrolmentState` runs 4 queries in parallel (`two-factor/methods.ts:121`) on every password sign-in, including users without 2FA (`issue.ts:178`), and twice per verify. That puts up to 4 of 10 pool connections in flight for one sign-in. Fix: one statement, or check `users.two_factor_enabled` first.
- **e.** Re-reads of rows the request already holds:
  - `readVerifiedTotpSecret` (`totp-replay.ts:413`).
  - `recordPluginCompletion` re-reading the state row (`challenge.ts:416`).
  - `session.create.after` re-reading the user's email (`hooks.ts:511`).
- **f. Password recovery reads the enrolment state twice in a row (PA2-05, re-checked).** `app/api/auth/forgot-password/reset/handler.ts:130` calls `recoveryDefeatsTwoFactor`, which runs `readEnrolmentState` (`lib/auth/two-factor/methods.ts:253`). Then `:136` calls `readEnrolmentState` again in the same `tx`, with no write in between. That is 8 enrolment statements where 4 would do. Fix: let `recoveryDefeatsTwoFactor` take the state, or return it.
- **Projection:** `verify-totp` goes from 53 to about 30 statements; step 1 from 20 to about 12–16.
- **Guardrails (PA2):** reuse state only within one request, and keep the authoritative re-check inside the transaction. Do not add a cache that spans requests. The tests for method removal, deactivation and single-use proofs must stay green.

### <a id="p-7"></a>P-7. Decoding the session cookie costs 0.7–1.2 ms of CPU per authenticated request (PROVEN)

- **Proof:** a `bun:jsc` profile of 3 000 cache-hit `getSession` calls. The time goes to Better Auth's pure-JS `base64Decode`, `JSON.parse`, `structuredClone` (in `filterOutputFields`) and `importKey`, all of which scale with cookie size.
- **What inflates it:** the cookie is 1 992 bytes. Of the 1 494-byte payload, 744 bytes are `metadata`: the full 4 pages × 9 actions boolean grid, mostly `false`. It is written by `lib/auth/session/hooks.ts:248-253` and `lib/permissions/session-refresh.ts`.
- **Impact:** about 10% of one core at 100 req/s, doubled on upload (P-12).
- **Fix:** store only the granted actions (e.g. `{"media":["view","edit"]}`), and accept both shapes in `sanitizeCachedPermissions` while old cookies drain. This changes the snapshot format.
- **Context for your TODO note** ("permission checks are strict and pressure the DB"): measured auth DB cost is already small.
  - A cached read makes 0 auth queries.
  - A write makes one indexed `liveGrants` query of about 0.44 ms.
  - A cache miss happens about once per 5 min per user.
  - Loosening the checks would save almost nothing; this CPU cost is the real per-request auth cost.

### <a id="p-8"></a>P-8. Every transaction rebuilds Drizzle's relational config (PROVEN)

- **Where:** `db/transaction.ts:190`, `drizzle({ client, schema }).transaction(fn, config)`. `construct()` (`drizzle-orm/bun-sql/driver.js:15-41`) runs `extractTablesRelationalConfig` over all 36 schema exports.
- **Proof:**
  - `scratchpad/db/bench-drizzle-ctor.ts`: 171 µs with the schema, against 1 µs without.
  - `bench-tx.ts`: `withTransaction` with one statement takes 597 µs, against 397 µs when the config is built once. A plain autocommit query takes 188 µs.
- **Impact:** about 0.2 ms of synchronous CPU per transaction, pure waste. A full password + TOTP sign-in pays it 6 times.
- **Fix:** build `extractTablesRelationalConfig(schema)` and `new PgDialect()` once at module load. Per transaction, use `new BunSQLSession(client, dialect, {fullSchema, schema, tableNamesMap}).transaction(fn, config)`; `BunSQLSession` is exported. The `cutAt` / `withMembers` wrapping is unchanged.

### <a id="p-9"></a>P-9. `auditLog(tx: Tx)` forces a full transaction around a single INSERT (PROVEN cost)

- **Where:** `lib/audit/index.ts:242`. The standalone callers are `lib/auth/session/hooks.ts:157` (every sign-in), `lib/auth/session/audit.ts:21`, `lib/auth/two-factor/challenge.ts:376` (every 2FA completion) and `lib/auth/two-factor/plugin.ts:314`.
- **Same shape without an audit:** `lib/auth/two-factor/trusted-device.ts:157`, `lib/auth/path-policy.ts:178`.
- **Cost:** a connection reservation plus BEGIN, INSERT, COMMIT plus P-8, which is 3 round trips instead of 1: 597 µs against 188 µs on localhost.
- **Fix:** accept `Executor` (`db | Tx`). Mutations still pass their `tx`; standalone sites pass `db`.

### <a id="p-10"></a>P-10. Role delete locks every live member before refusing because it has members (PROVEN)

- **Where:** `app/api/dash/permissions/[id]/handler.ts:346-351` runs `FOR NO KEY UPDATE` on all members; the delete at `:373-385` then fails with `hasUsers` if any of them are live.
- **Why the lock is useless here:** locking live members protects nothing. Only soft-deleted members matter, for the restore race the comment describes.
- **Proof:** `scratchpad/db/explain-role-delete.ts`, role with 875 live members:
  - LockRows took 72.7 ms, with `shared hit=2818 dirtied=716`: real WAL writes for 875 row locks, which block concurrent sign-in `FOR UPDATE` on those users.
  - An unlocked `EXISTS(… deleted_at IS NULL)` takes 0.16 ms.
- **Relation to DB-5:** this is new beyond DB-5, which covers the RI seq scan, not this lock.
- **Fix:** check for a live member unlocked first and refuse early, then lock only the soft-deleted members. Lock order is unchanged.

### <a id="p-11"></a>P-11. Each container start loads the app twice, and production builds OpenAPI parts it never serves (PROVEN)

- **Where:**
  - The `CMD` in `Dockerfile` runs `bun scripts/build-openapi.ts && exec bun --bun server.ts`.
  - `lib/http/openapi/better-auth.ts:46-47` has top-level awaits of `generateOpenAPISchema()` and `auth.$context`, loaded statically through `routes.ts:75` → `openapi/route.ts:9` → `document.ts`. In production, `resolveOpenApiDocument` only reads the prebuilt file.
- **Proof:** the build-openapi process takes 3.6–6.6 s, against about 2–2.7 s to import `app.ts`. The generator itself takes 26–95 ms, and the OpenAPI modules 25–80 ms.
- **Fix:** dynamically import `./document` inside the memoised generator, and generate in-process before `listen` instead of in a second process. The Dockerfile `verify` stage keeps the consistency check.
- **Related, downgraded:** `/openapi.json` re-stringifies its 223 KB document on each request; the string could be cached.

### <a id="p-12"></a>P-12. One request looks up the session several times (PROVEN; found by three auditors)

- **Upload:**
  - `app/api/upload/file/handler.ts:43` calls `requireSession` (`getSession` + `assertLiveSession`).
  - `:46` then calls `requireAnyPermission` (`getSession` again + `liveGrants`, which already checks the session row).
  - A public upload adds `requirePublishGrant` (`lib/media/upload.ts:533`, `lib/media/policy.ts:66`): a third `getSession` and a second identical `liveGrants`.
  - Measured: 2 statements with a cache cookie, 4 without, 6 for a public upload without one.
  - Fix: use `authenticatedSession` at `:43`, since only the 401-first ordering is needed, and reuse the grants already returned for `media.publish`. Better still, memoise `authenticatedSession` per request `Headers` in a `WeakMap`, the pattern `queuedCookies` already uses, and keep `refreshSessionCookies` uncached.
  - Edge change: a revoked session with a cached cookie and an unknown resource would get 400 instead of 401.
- **Better Auth live-session paths:**
  - `lib/auth/path-policy.ts:276-280,347-368` runs `findSession`, which already joins the user. Then `assertLiveSession` (`session/live.ts:63`) reads the same row again, and the library middleware reads it a third time.
  - Measured: `/two-factor/methods` makes 3 statements with a valid cache, two of them the same check; `/reauth/methods` makes 5.
  - Do-not-remember sessions pay this on every request and never get a cache.
  - Fix: one live-session query by token that also checks `users.is_active`, `deleted_at` and expiry.
- **Test:** assert at most one `getSession` and one session-row query per request, using the probe's counter.

### <a id="p-13"></a>P-13. The reauth window check makes 4 queries in sequence (PROVEN)

- **Where:** `lib/auth/reauth/window.ts:74-106` plus `lib/auth/reauth/methods.ts:14-34`: two verification lookups, then an accounts query and a passkeys query that re-check the method used is still available.
- **What the last two guard:** nothing ever sets `accounts.password` to null, and factor removal already revokes windows through `revokeTwoFactorState`. What's left is a user deleting their own last non-factor passkey inside a 15-minute window they minted themselves.
- **Cost:** about 2.2 ms per reauth-gated write. `lib/users/edit.ts:147` runs the check a second time inside the edit transaction, so the lock is held longer.
- **Fix:** one query: `identifier IN (…)` with EXISTS subqueries, checking only the recorded method.

---

## 3. Over-engineering and costly race guards

### <a id="p-14"></a>P-14. The timing floor pads successful verifies (TRACED; re-checked)

- **Where:**
  - `lib/http/timing-floor.ts:96-98`: the `finally` awaits `ensureMinDelay` on every outcome once `startFloor` has run.
  - `MINIMUM_RESPONSE_MS` = 2 500 ms.
  - Callers: `app/api/auth/otp/verify/handler.ts:60`, `forgot-password/reset/handler.ts:102`, `forgot-password/complete/handler.ts:72`, and `lib/auth/passwordless.ts:216-219`.
- **Why it hides nothing:** a success needs the correct code or grant, so someone probing for accounts never sees one. Padding the _send_ routes is necessary, because their success is the generic answer. Padding _verify_ successes is not.
- **Cost:** a password reset waits 7.5 s in total, of which 5 s can go. Passwordless login waits 5 s, of which 2.5 s can go. Each held request keeps a socket and a timer, but no database connection.
- **Stale doc:** `timing-floor.ts:34-35` says `/forgot-password/complete` is "not covered", but its handler calls `startFloor()`.
- **Fix:** add a `padSuccess: false` option for the verify routes, and move `ensureMinDelay` into the `catch` in `passwordless.ts`. The invariant "a known identifier never answers later than an unknown one" still holds. `tests/integration/otp-timing-oracle.test.ts` tests only send-route padding, so it would not break.
- **Owner call:** this is a security surface. Confirm no verify success on these routes is reachable without the code, for example under `OTP_AUTO_VERIFY`, which is already flagged in should-ignore #61.

### P-14b. The anonymous _send_ floor could be lower than 2.5 s (PA2-06; tuning, measure first)

- **Where:** `lib/http/timing-floor.ts:37` (`MINIMUM_RESPONSE_MS = BUSY_TIMEOUT_MS + KNOWN_BRANCH_WORK_MS`), and the send orchestration in `lib/otp/anonymous-send.ts`.
- **Measured (PA2):** passwordless sends for unknown, known and unknown destinations answered 200 at 2 507.4, 2 503.2 and 2 504.5 ms.
- **Why it may be lowerable:** the floor is sized on the SQLite writer's full retry allowance (2 000 ms). But the limiter now waits out a held lock without blocking (`lib/rate-limit/store.ts:158`, `admitWindowWithoutBlocking`), and send issuance carries on after the response. So the send response's floor no longer has to equal the full retry budget.
- **Why not to lower it blind:** for verify routes the same constant also sets the transaction's work deadline (`floorDeadline`). Lowering it without a measured legitimate-verify p99 could refuse valid codes. There is no evidence yet for a safe number.
- **Fix:** give send routes their own floor, set from a measured pre-response p99 on the VPS. Keep known and unknown answers equal.
- **Test:** compare the known and unknown timing distributions under slow PostgreSQL and SQLite contention.

### <a id="p-15"></a>P-15. Deleting a private file purges its public URL from Cloudflare, so private deletes depend on Cloudflare (TRACED; re-checked)

- **Where:**
  - `lib/media/lifecycle.ts:137-163`: `finishDeleting` deletes the key from every enabled bucket, then purges every key the public bucket reported deleted.
  - `lib/r2/client.ts:233-261`: with `Quiet: true`, R2 reports a missing key as deleted, so every row lands in `publicGone`.
- **Why the purge is never needed for a private row:** a row's transition marker clears only after `removeObject` has deleted the opposite copy and purged it (`lib/media/visibility.ts:169-182,278,309`).
- **Impact:**
  - One Cloudflare API call per 30 private files, on the request path of DELETE and folder delete.
  - Those calls spend the 900 per 5 minutes purge allowance that the comments say must stay free for privacy deletes.
  - While Cloudflare is down or the allowance is spent, private deletes return `pending` (`:162`).
- **Fix:** purge only rows whose `bucketType === 'public'`. Keep deleting from both buckets.
- **Test:** deleting a private row with the purge configured makes no `purgeUrls` call.
- **Interaction with P-26:** a 200-file private folder delete makes 7 unneeded purge batches, and with a slow Cloudflare each can cost up to 20 s inside the route.

### <a id="p-26"></a>P-26. The purge's "25 s total budget" lets one call run about 45 s (PA2-07; PROVEN with a fake clock, re-checked)

- **Where:** `lib/cloudflare/purge.ts:25` (`TOTAL_BUDGET_MS`), `:135-137` (the deadline is checked only before a batch starts), `:70-111` (`purgeBatch`: `ATTEMPTS = 2`, each with `AbortSignal.timeout(10_000)`).
- **Callers on the request path:** `lib/media/lifecycle.ts:143` (delete, folder delete) and `:280`.
- **Mechanism:** a batch that starts at 24.9 s still gets two fresh 10 s attempts, so the worst case is about 45 s. When the overrun happens in the last batch, the `deadline reached` log never fires, because there is no later batch to abandon.
- **Proof (PA2):** the real `purgeUrls`, given 31 URLs with fetch mocked to take the full timeout, ran attempts at 0, 10 000, 20 000 and 30 000 ms, and returned `elapsedMs: 40000, failed: 31`.
- **Impact:** it stays inside the media routes' `timeoutSeconds: 120` (`routes.ts:96`). The real cost is that the documented budget is wrong, so a folder delete can hang about 45 s while Cloudflare is slow. Single-file unpublish stays within 20 s.
- **Fix:** carry the absolute deadline into `purgeBatch`, clamp each attempt's timeout to the time left, and start no attempt after the deadline. Unconfirmed URLs still go into `failed`.
- **Test:** fake clock, 31 URLs, a batch admitted near the deadline. Assert the elapsed bound and that no attempt starts after the deadline.

### P-16. The pre-auth IP limiter costs more than what it protects (PROVEN)

- **Where:** `lib/http/adapters/elysia.ts:50`, `app.ts:384`, `lib/http/pre-auth.ts:208-219`. `routes.ts:98-112` sets `preAuth: 'ip-limit'` on every dashboard route, and handlers then add a per-user limiter.
- **What it bounds:** an anonymous or forged-cookie request never reaches the database. Better Auth returns null when the HMAC fails (`better-auth/dist/api/routes/session.mjs:40-47`). So the database path the limiter really bounds is replaying a stale cookie whose signature is still valid.
- **Proof:** `scratchpad/pipeline/bench3.ts`:
  - The limiter write costs 88–104 µs p50, against 47–95 µs for `getSession` with no or a forged cookie.
  - The rest of the pipeline costs about 20 µs.
  - Each write also feeds P-1's checkpoint stalls.
- **Fix options:** charge it only when a session-token cookie is present, or keep the pre-auth counter in process memory. Either changes the admission invariant; your call.
- **Related, downgraded:** the anonymous recovery and passwordless routes carry pre-auth (120/min shared) on top of tighter per-handler IP limits (30–60/min). Their siblings `otp/send` and `otp/verify` drop pre-auth for exactly that reason (`routes.ts:160-161`).

### P-17. Smaller guards that cost about one round trip each (TRACED)

- `lib/otp/send.ts:123`: `pg_advisory_xact_lock` right after `lockUser FOR UPDATE` (`:119`), on an `ON CONFLICT` upsert. The user lock already serializes that user's sends.
- `lib/otp/verify.ts:227`: the daily-usage `SUM` re-reads the unique row already locked at `:125`. Select those columns in the first query.
- `app/api/dash/users/[id]/handler.ts:133`: `actorCoversTargetRole` re-selects `role_permissions` already loaded at `:97-103`. Pass `userData.role.rolePermissions` to `assertRowsWithinScope` instead.
- `app/api/dash/permissions/[id]/handler.ts:165`: `validateRolePermissionScope` reads the rows `FOR SHARE` and discards them; `:202-208` reads them again. The `FOR SHARE` is redundant under the role's `FOR UPDATE`.
- `lib/media/visibility.ts:249-272`: a HEAD after the COPY on publish and unpublish. The COPY response's ETag may make it unnecessary; not verified that R2 returns one. The route is limited to 10/min, so this is low. The comment at `publish/handler.ts:258` is out of date.
- `db/transaction.ts:102-116`: `cutAt` awaits `set_config` before each statement, about 150 µs per statement, on `lib/otp/verify.ts:84` only. Pipelining it is not verified for `bun:sql`.

### P-18. `lib/cache` is an unused scaffold that is still opened and swept (PROVEN; found by two auditors)

- **Where:** `lib/maintenance/sqlite.ts:37,53,67` calls `cacheSweepExpired` and `cacheHasExpiredRows` every 15 minutes. That calls `getStore()` (`lib/cache/index.ts:165-171`), which creates `cache.db` with its `-wal` and `-shm` files and keeps the connection open, although the module is marked "SCAFFOLD: no call site uses this yet".
- **Proof:** `scratchpad/infra/bench-sweep.ts` printed `cacheDbCreatedBySweep: true`.
- **Fix:** skip a store that was never opened (`lazyStore.isOpen()`), or remove the job until the cache has a caller.

---

## 4. Other resource findings

- **P-19. OAuth (PROVEN by both audits; token exchange rated Medium in PA2-03).**
  - **Google's signing keys:** `lib/auth/oauth/id-token.ts:74-76` builds a new `createRemoteJWKSet` and forces `reload()` on every callback. That throws away jose's freshness cache and its sharing of concurrent fetches.
    - Proof (PA2-04, real RS256 tokens, stub JWKS server adding 30 ms): six calls to the current verifier made **6** JWKS requests in 195.4 ms; one shared resolver made **1** in 34.0 ms.
    - Fix: one resolver at module level, without the forced `reload`. jose refetches on an unknown `kid`. Keep the distinction between an invalid token and unavailable keys, and don't cache keys forever.
  - **Token exchange:** `oauth/plugin.ts:388-389` → `@better-auth/core/dist/oauth2/validate-authorization-code.mjs:64` → `betterFetch`, with no abort signal.
    - Proof: `scratchpad/credentials/fetch-timeout.ts` was still pending after 15 s against a server that never answers. PA2 held a real harness flow's provider response for 5 500 ms, with the outgoing signal never aborted.
    - It holds the request, the outbound socket and an already-consumed state, but no database connection.
    - Fix: an abortable deadline (`AbortSignal.timeout(5000)`) that also covers reading the response body. A `Promise.race` that only returns early would leave the request running.
    - Test: one provider that never sends headers, and one that drips the body. Assert an actual abort within the bound.
- **P-20. Plain `db` reads wait for a pool connection with no time limit; transactions give up after 10 s (PROVEN).**
  - Where: `db/transaction.ts:33-60` puts a time limit only on `withTransaction` acquisition.
  - Proof: `scratchpad/db/pool-wait.ts`, pool of 2 with both reserved: the transaction got a 503 at 1 005 ms, while the plain read answered at 3 821 ms.
  - Impact: under saturation (AUTH-6 below), read routes hang instead of failing fast.
  - Separate from PG-1, which is about query duration, not waiting for a connection. There is no cheap driver-level fix: either an app-level semaphore, or fix AUTH-6 so the pool rarely saturates.
- **P-21. Cloudflare purge sends one URL per API call in the sweeps (TRACED).** `lib/media/orphaned-objects.ts:21-41` is called per row from `sweepOrphanedObjects` (`:122`) and `retryTransitions` (`visibility.ts:339-381`). A backlog of 1 000 rows can spend the 900 per 5 minutes allowance in one sweep. The API takes 30 URLs per call, so batch them.
- **P-22. One audit INSERT per row inside locked transactions (TRACED).**
  - Where: `lib/media/lifecycle.ts:244-255` (up to 200 rows, holding `FOR UPDATE`), `:366-372` (up to 200, under the global tree advisory lock), `lib/media/files.ts:203-211` (50), `lifecycle.ts:86-93`.
  - Cost: at 1 ms per round trip, the largest folder delete holds the tree lock 0.2–0.4 s longer.
  - Fix: an `auditMany` that writes one multi-row insert.
- **P-23. Minor round trips (TRACED).**
  - Entity uploads read back their own insert (`upload.ts:495-501`); use `returning`.
  - `GET /api/dash/media` runs `requireFolder`, rows and breadcrumbs in series (`app/api/dash/media/handler.ts:117,119,161`).
  - `searchFolders` runs after the files query instead of alongside it.
- **P-24. SMTP opens a new connection per OTP email (HYPOTHESIS).** `lib/smtp.ts:104,132`, `lib/otp/delivery.ts:124`. Each send pays DNS, TCP, TLS and AUTH inline on the authenticated send paths. Verify by timing against a TLS loopback with `pool: true`. A pooled transport makes the deadline's socket destroy harder to keep correct. Low priority at current volume.
- **P-25. Argon2 parameters (PROVEN, noisy; your call).**
  - `lib/auth/password/hash.ts:194` uses m=64 MiB, t=3, p=4 (library defaults): 116–327 ms per hash and 6–13 hashes/s per process.
  - OWASP alternatives: m=46 MiB, t=1, p=1 gives 31–48 hashes/s; m=19 MiB, t=2, p=1 gives 52–71 hashes/s.
  - At 16 concurrent hashes, p=1 matched or beat p=4.
  - The pepper already covers a database-only leak; lowering the cost only weakens offline guessing when the pepper leaks too.
- <a id="p-27"></a>**P-27. Maintenance passes have no time limit and keep a reserved pool connection through every remote retry (PA2-08; pool cost PROVEN, duration TRACED).**
  - Where: `lib/maintenance/election.ts:27-38` (`runElected` reserves a connection from the main pool and holds its advisory lock across `await run()`).
  - The loops inside: `lib/media/reconcile.ts:24,166` (up to 200 HEADs per bucket), `lib/media/visibility.ts:52,319` (1 000 transition retries), `lib/media/orphaned-objects.ts:15,122` (100 orphan deletes).
  - Each R2 call allows `maxAttempts: 3` × `R2_REQUEST_TIMEOUT_MS = 15 000` (`lib/r2/client.ts:50,68`).
  - Mechanism: nothing bounds the whole pass. With R2 hung, 100 failing operations × 3 × 15 s comes to about **75 min**, during which one of the 10 connections stays reserved.
  - Overlap: retention runs at 03:30 UTC and Sunday reconcile at 04:00 UTC. If retention runs past 30 minutes, the two jobs overlap and hold 20% of the pool.
  - Proof (PA2): two parked `runElected` callbacks showed two advisory locks in PostgreSQL; 8 ordinary reservations succeeded, and the 9th timed out (101.98 ms under a 100 ms abort).
  - Why health checks won't show it: `health/storage` uses the separate probe pool, so it keeps passing.
  - Fix: an elapsed budget per pass, plus a stop after N consecutive identical timeouts, leaving durable markers for the next run, and pass the abort down to the R2 calls. Optionally, a small separate pool for elections. Keep the election and transition ownership guards; removing them has no proven safe benefit.
  - Monitor: job start time and age (not only completion), connection acquisition latency, and remote timeout streaks.
- <a id="p-28"></a>**P-28. Retention reports "no backlog" after skipping locked overdue rows (PA2-09; PROVEN, re-checked).**
  - Where: `lib/maintenance/database.ts:160` (`deleted < BATCH_SIZE` → `hasMore: false`), with `.for('update', { skipLocked: true })` at `:195`.
  - Mechanism: a short batch can mean rows were skipped because they were locked, not that none were left. The same pattern covers the generic expiry sweeps and verification sessions.
  - Proof (PA2): with one expired session held `FOR UPDATE`, the real sweep returned `{status:"ok", hasMore:false, sessions:{removed:0}}` and `eligibleRemaining: 1`. A second run after the unlock removed it.
  - Impact: the work waits until the next night, and a backlog alert keyed on `hasMore` stays silent. This is a monitoring and retention gap, not unsafe deletion.
  - Fix: keep `SKIP LOCKED`. After the pass, run a bounded "any overdue left?" probe, or report the backlog as `unknown` so the job is allowed an earlier retry.

---

## 4b. Test-harness findings (merged from PA2-10)

The quality of the test harness matters for exactly the class you asked about: a bug that "nothing would have stopped from shipping".

- <a id="t-1"></a>**T-1. The drain hooks cost ≥ 100 ms per test, and a failed drain doesn't fail the test (PROVEN by PA2, re-checked).**
  - Where:
    - `tests/helpers/preload-base.ts:130-135` (`beforeEach`) and `:153-162` (`afterEach`) both call `drainAfterResponse(5000)` and ignore its boolean result.
    - `lib/http/after-response.ts:93,112-114`: even with an empty queue, it sleeps `AFTER_RESPONSE_SETTLE_MS = 50` to prove quiescence.
  - **Cost:** 100 empty drain pairs took 10 177 ms (PA2). The repo has about 1 207 `test(`/`it(` cases, which is about **2 minutes** of pure waiting per serial full run, whatever the tests assert.
  - **Gap:** a queued post-response task that never settles makes each hook use its full 5 s budget, and the test still finishes **1 pass, 0 fail** with pending work = 1 (PA2, `stranded-work.test.ts`). The mock resets (`resetEgress`/`resetMailbox`/`resetObjectStore`) then run over unfinished work, which can contaminate the next test.
  - **Fix:**
    - Fail the test when the drain returns `false`, and do not reset shared mocks over unquiesced work.
    - Give pure unit tests a cheap path: skip the 50 ms settle when no request or deferred work was created.
    - Keep the production shutdown's settle guarantee. Checking only `pendingAfterResponse() === 0` would miss work registered late.
  - **Test:** a child-process harness test with permanently pending after-response work asserts a non-zero exit; a second one covers late registration.
- **T-2. A retention test that tests nothing (re-checked).** `tests/integration/retention-sweep.test.ts:763`, "a sweep that throws is contained, logged by class, and does not reject", wraps a local throwing lambda in its own `try {} catch {}`. It never calls a scheduled production callback and never asserts a log. Replace it with a failing injected scheduled job, and assert the real failure event and that scheduling continues.

---

## 5. Known items with new evidence

These items are already in `reports/should-ignore.md` or `TODO.md`. They were not re-reported, except where something new turned up.

- **TODO C-027 / AUTH-6 (Argon2 inside the login transaction).** More sites have the same shape:
  - Dash reauth holds the user `FOR UPDATE` for 167 ms.
  - `totp/start` (via `reauth/password.ts`) for 107 ms.
  - A wrong-password attempt for 125 ms.
  - `app/api/dash/users/me/change-password/handler.ts:94` has the shape too. Its comment "Argon2 stays outside the mutation transaction" is true only of the second transaction.
  - `db/limits.ts:20-25` already records a 4.6 s hold. The planned fix should cover all of these sites.
- **Known #15:** see [C-5](#c-5). A junk value, not only an expired cookie, triggers it, and it re-mints indefinitely.
- **should-ignore #25** ("`checkMultiplePermissions` uses two DB round-trips") is out of date. It now makes one, per the session auditor's query count. The entry can be retired.
- **Known #13 (OTP budget charged under PG locks):** P-1 gives the mechanism behind the measured 2 282 ms block. Any limiter commit can be the one that runs the checkpoint, and that includes the charge made inside the OTP transaction.
- **TODO (Bun precompile / single binary).** Evidence against, for now:
  - The per-request pipeline overhead is about 20 µs.
  - Boot time goes to running jsdom, svgo, aws-sdk and better-auth, which bundling does not remove.
  - A plain `bun build --target=bun` bundle fails at runtime on css-tree's `require("../data/patch.json")`, then on `Cannot find module '../package.json'`.
  - `openApiArtifactFile()` resolves from `import.meta.dir`, which points into a virtual filesystem in a compiled binary.
  - Do P-11 and P-5b first.

---

## 6. Checked and clean

- **Pipeline:**
  - About 20 µs of overhead per request (404 p50).
  - Exactly one access-log line per request, including early 413 and HEAD.
  - Content-Length survives Elysia's response rebuild.
  - WeakMaps are keyed correctly (cookie queue, after-response queue, timing).
  - The OpenAPI document and the compiled lookups are built once.
  - `lib/env.ts`, `lib/startup.ts` and `lib/id.ts` do boot-time work only.
- **Session:**
  - A cached read makes 0 auth queries.
  - The sliding refresh writes once a day per session.
  - A role edit refreshes all of the role's sessions in one `UPDATE`; the drift-repair transaction does not run when the row is current.
  - `forceDB` does nothing on non-read actions.
- **Credentials:**
  - Library after-hooks are queued until after commit, so no second pool connection opens inside an auth transaction.
  - The pepper and OTP keyrings are parsed once.
  - Timing floors hold no connection.
  - Turnstile, SMS and WhatsApp calls have timeouts.
  - The password-proof map is bounded.
- **Database:**
  - Users list: 1–9 ms at 50k users, page 200 included.
  - Trigram search uses both GIN indexes.
  - Roles and permissions lists run under 1 ms.
  - Detail GETs are one relational query each.
  - `auditLog` takes 67 µs of CPU per call.
  - No migration runs at boot.
  - User create and admin edit hash outside the transaction.
  - The probe pool is single-flight with its own `statement_timeout`.
  - PA2 checked session timestamp precision and ruled out the suspected truncation of the `(createdAt, id)` session cursor. That is their result; I did not re-run it.
- **Media:**
  - No HEAD before PUT.
  - The S3 client is created once, with 3 s connect and 15 s request timeouts.
  - No double checksum.
  - Upload buffers are not copied: RSS stayed flat through `formData` → `arrayBuffer` → `Buffer.from`.
  - Decoding reads only headers inside the slot.
  - Office detection is bounded.
  - Folder recursion is depth-bounded.
  - No N+1 queries.
  - `health/storage` never touches R2.
  - Reconcile runs weekly and is bounded.
- **Infrastructure:**
  - Hot statements are prepared once.
  - The sweep yields; at 20k rows its longest event-loop gap was 10 ms.
  - The writer-lock and ownership machinery costs almost nothing at runtime in a single process (no owner timers). Elections are cheap while a job is idle, but not while it is stuck on remote calls: see P-27.
  - Shutdown leaks nothing.
  - Better Auth's own limiter is disabled.
  - `ipIdentifier` takes 0.35 µs per call.

---

## 7. Tests and lightweight monitoring that would catch these early

### Tests (cheap, deterministic)

1. **A query budget for each flow.** Install the statement counter from `scratchpad/credentials/counter.ts` (it patches `BunSQLPreparedQuery.execute/all` and `BunSQLSession.transaction`) in the integration harness. Pin counts per flow:
   - Cached dashboard GET: 0 auth queries.
   - Write: 1.
   - Upload: ≤ 2.
   - Password sign-in, `verify-totp`, OTP send and verify.
   - Assert that no `delete from "verifications" where "expires_at"` statement runs on a request path.

   This one test would have caught P-3, P-6, P-12 and P-13, and the original dropped-cookie bug, which showed up as a request paying the DB path every time.

2. **A route × session-state cookie matrix.** Promote `scratchpad/cookies/route-cookies.probe.test.ts` into `tests/integration`. For every route class, cover no cache, row past `updateAge` and row deleted with a valid cache. Assert which `Set-Cookie` headers come back, and that `Cache-Control: no-store` is set. Drive it through `app.handle` on the success, validation-error and authorization-refusal outcomes, with `__Secure-` cookie names (HTTPS base URL) and chunk cleanup (`session_data.N`) included (PA2). Catches C-1, C-2, C-3 and any new route that bypasses `withQueuedCookies`.
3. **A junk-cookie row** in `permission-database-path.test.ts` (C-5).
4. **WAL frames per admission** ≤ 1.3. Promote `scratchpad/infra/frames.ts` (P-1b).
5. **A prepared-statement bound:** send N distinct filter shapes on a `max: 1` pool, then assert `pg_prepared_statements` stays bounded once `maxLifetime` is in place (P-2).
6. **Timing floor:** a verify success answers in under FLOOR/2 (P-14).
7. **Private delete:** no `purgeUrls` call (P-15). And signing the same private key twice inside one window gives the same URL (C-6), if you adopt that.
8. **A media budget:** a cap-sized SVG processes in under N ms, and `optimizeImage` on a q95 2048 px WebP runs at most 3 encodes (P-4, P-5).
9. **A browser-jar revocation test (PA2):** revoke the row, hit a session-only route and get a 401, apply every returned cookie, then call a permission route and `get-session`. Assert the session is consistently gone (C-2).
10. **A cache-input matrix (PA2):** token only, valid cache, malformed value, malformed chunk (`session_data.0`), expired cache, an inactive user and an inactive role. Assert the status, which authorization source was used and the resulting cookie jar together (C-5).
11. **Outbound deadlines:** one provider that never sends headers and one that drips the body, for the OAuth token exchange. Assert an actual abort and an elapsed bound (P-19).
12. **Fake-clock total budgets:** `purgeUrls` with 31 URLs and slow retries, and a maintenance pass against a parked R2. Assert the elapsed bound, that no attempt starts after the deadline, that markers are preserved and that ordinary pool capacity stays free (P-26, P-27).
13. **A sweep under a lock:** hold an overdue row locked during the sweep, assert the backlog is still reported, then unlock and re-run (P-28).
14. **Harness self-tests:** stranded after-response work must fail the run (T-1), and the retention failure test must exercise the real scheduled callback (T-2).
15. **A JWKS fetch count:** N verifications against a shared resolver make 1 fetch (P-19).

Prefer these deterministic contract tests to full-server speed thresholds. Add timing gates only once there is a stable baseline on the Linux container.

### Monitoring (no new dependency)

1. **Event-loop lag sampler.** A `setInterval(…, 500)` that measures drift, logs a structured warning above 50 ms, and exposes p99 and max on the health endpoint. Today nothing in the app measures it; this would have surfaced P-1, P-5 and Known #13.
2. **`Server-Timing` in dev.** Add `rl;dur=` (limiter), `auth;dur=` (session plus grants), `db;desc=<count>` and `tx;desc=<count>` per request, so a regression in the query count is visible in DevTools.
3. **A cache-hit ratio for the cookie cache.** Count requests that carried `session_data` and were answered without a session query, against those that hit the database; log the ratio every 15 minutes. A ratio near 0 is exactly the dropped-cookie symptom.
4. **PostgreSQL gauges** on the periodic sweep:
   - `count(*) from pg_prepared_statements` per backend (P-2).
   - Longest `idle in transaction` time from `pg_stat_activity` (AUTH-6).
   - Pool wait time (P-20).
5. **Per-call fields:**
   - `iterations` and `ms` on every `optimizeImage` (P-4).
   - Purge calls against URLs purged per sweep (P-21).
   - A distinct `otp.budget.exhausted` event.
6. **Startup:** log boot duration and RSS after `listen` (P-11, P-5b).
7. **Background work (PA2):** the count and age of pending after-response work, the age of the oldest transition or orphan marker, maintenance job start time and age (a completion-only log can't describe a job that is still stuck), and a low-frequency overdue-row sample that doesn't rely on the job's own `hasMore` flag (P-27, P-28).
8. **Outbound providers:** duration, in-flight count, aborts and retries per provider, plus JWKS fetches per OAuth verification (P-19, P-26).
9. **Test feedback:** per-file test duration, cleanup time and the count of failed drains (T-1).

Emit these as bounded aggregates, once a minute, through the existing structured logger, with routes labelled by template. Never log cookies, tokens, OTP destinations, SQL parameters or URL lists. Alert on a provider call exceeding its declared deadline, a failed drain, or a job still running past its pass budget.

---

## 8. Not verified

- All timings on the Linux VPS. The size of P-1 depends on the disk: rerun `scratchpad/infra/bench-variants.ts` there.
- Whether the front-end loops or misbehaves in the C-2 window or on C-3's stale name.
- Whether R2 honours `response-cache-control` on signed URLs (C-6), and whether it returns an ETag on COPY (P-17).
- Whether Bun's `node:https` agent actually reuses S3 connections.
- Whether `bun:sql` pipelines `set_config` with the next statement on a reserved connection (P-17, `cutAt`).
- Bun's default fetch timeout (P-19 showed only that it is longer than 15 s), and real SMTP and Google latency.
- Seeding `ctx.context.session` from the policy hook to skip the library's third session read (P-12).
- `bun build --compile` (only a plain bundle was tried).

---

## Appendix: scratch scripts

Everything is under `%TEMP%\claude\D--apps-job-app-soft-house-dash-4-apps-back-end\1ac11d4f-5dfa-461e-9713-1b99971880d7\scratchpad\`, which is temporary and session-scoped. Copy out anything you want to keep.

| Folder         | Scripts                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline/`    | `env.sh`, `boot.ts`, `mods.ts`, `rss.ts`, `buildopenapi-time.ts`, `bench*.ts`, `parts.ts`, `hdrs.ts`, `wire.ts`, `early.ts`, `headers-probe.ts`, `logcost.ts`, `bootbundle.ts`          |
| `session/`     | `run-probe.ts`, `probe.test.ts`, `probe2.test.ts`, `probe3.test.ts` (junk cookie), `bench*.test.ts`, `agg.ts`, `prof-*.txt`                                                             |
| `credentials/` | `runner.ts`, `counter.ts`, `signin-count.test.ts`, `otp-and-lock.test.ts`, `cache-after-2fa.test.ts`, `live-path.test.ts`, `adapter-cost.test.ts`, `argon-bench.ts`, `fetch-timeout.ts` |
| `media/`       | `bench-image.ts`, `bench-rungs.ts`, `bench-realistic.ts`, `bench-svg.ts`, `bench-jsdom.ts`, `bench-svgo-pass.ts`, `bench-presign.ts`, `bench-sha.ts`, `bench-multipart2.ts`             |
| `db/`          | `mkdb.ts`, `seed.sql`, `dropdb.ts`, `explain-*.ts`, `bench-drizzle-ctor.ts`, `bench-tx.ts`, `bench-audit.ts`, `prepared-*.ts`, `pool-wait.ts`                                           |
| `infra/`       | `bench-limiter.ts`, `bench-variants.ts`, `frames.ts`, `sweep-noindex.ts`, `bench-sweep.ts`, `bench-ip.ts`                                                                               |
| `cookies/`     | `run-probe.ts`, `route-cookies.probe.test.ts`, `self-rename.probe.test.ts`, `headers-merge.ts`, `probe-output.txt`                                                                      |

Each probe database was provisioned per run and dropped afterwards. The database auditor dropped `perfaudit_db_scratch`.

**The second audit's proofs** are in `C:/Users/Administrator/AppData/Local/Temp/performance-audit-2-scratchpad/`:

| Folder              | Scripts                                       |
| ------------------- | --------------------------------------------- |
| `auth-cookies/`     | `proofs-preload.ts`, `extended-preload.ts`    |
| `data-maintenance/` | `retention-locked.ts`                         |
| `media-resources/`  | `purge-deadline.ts`, `image-ladder.ts`        |
| `root/`             | `drain-benchmark.ts`, `stranded-work.test.ts` |

The second audit's auth proofs run as an extra preload through the guarded integration runner, from `apps/back-end`:

```powershell
bun tests/helpers/run.ts integration session-cookie-delivery --preload=C:/Users/Administrator/AppData/Local/Temp/performance-audit-2-scratchpad/auth-cookies/extended-preload.ts "--test-name-pattern=cache cookie alone"
```

The second audit also ran 755 existing tests (HTTP/runtime, `session-cookie-delivery`, media validation and purge, SQLite and limiter, permission scope): all passed. That was not a full-suite run.
