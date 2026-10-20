# Back-end performance & resource audit

First audit 2026-10-01, merged with a second independent audit (PA2). Re-checked on 2026-10-16 against the Elysia 2 code on branch `http-layer`, and the recommended fixes were implemented the same day.

**What this file holds.** Only open findings, each proven by a probe, test or benchmark that was run on 2026-10-16. Everything left here is either the owner's call or deliberately postponed. P-14 and P-14b moved to `TODO.md` ("Do later"). Fixed findings have been removed: C-1 to C-4, C-6, P-2, P-3, P-5, P-8 to P-11, P-13, P-15, P-17 to P-19, P-21 to P-23, P-26 to P-29, T-1 and T-2, and the fixed parts of P-1, P-4, P-6 and P-12.

**Environment.**

- Bun 1.4.3, elysia 2.0.0-beta.27, better-auth 1.7.7, better-call 1.4.0, drizzle-orm 0.45.4, PostgreSQL 18.6, SQLite 3.53.2, @aws-sdk/client-s3 3.1150.0, jsdom 30.1.2, svgo 4.1.0, jose 6.2.12, nodemailer 10.1.0.
- All numbers come from the Windows 10 dev box under heavy load from other sessions. Read timings as relative to each other. Statement, WAL-frame, encode and connection counts do not depend on load.
- Nothing was measured on the Linux VPS. Where a VPS figure would change a decision, the finding says so.

Paths are relative to `apps/back-end/`.

---

## Summary

| Finding       | What is left                                                                                        | Decision                                                 |
| ------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [P-1](#p-1)   | A SQLite WAL checkpoint still runs inside about 1 in 650–1 050 limiter commits after the index drop | (b) checkpoint worker, or (c) `synchronous=OFF`          |
| [P-4](#p-4)   | One encoder slot per process: the 6th concurrent image upload gets a 503                            | a second slot costs up to about 100 MB of decoded pixels |
| [P-5](#p-5)   | A refused SVG still costs a full sanitise on the single SVG worker                                  | a flat budget charge before sanitising                   |
| [P-6](#p-6)   | 2FA step 1 still creates a session and then deletes it                                              | changes when `EMAIL_NOT_VERIFIED` is answered            |
| [P-12](#p-12) | Better Auth paths without a cookie cache read the session row twice                                 | both ways to one read cost more than they save           |
| [C-5](#c-5)   | A junk `session_data` cookie switches reads to the stored snapshot                                  | Known #15                                                |
| [C-7](#c-7)   | A before hook that throws after its session read loses the slid token                               | postponed; low impact                                    |
| [P-7](#p-7)   | Decoding the session cookie is the per-request auth cost                                            | postponed; changes the snapshot format                   |
| [P-16](#p-16) | The dashboard's pre-auth limiter costs more than the lookup it guards                               | changes the admission invariant                          |
| [P-20](#p-20) | Plain `db` reads wait for a pool connection with no time limit                                      | tied to AUTH-6                                           |
| [P-24](#p-24) | SMTP opens a new connection per email                                                               | postponed; latency only                                  |
| [P-25](#p-25) | Argon2 parameters                                                                                   | security/performance trade-off                           |

---

## 1. Cookies

### <a id="c-5"></a>C-5. A junk `session_data` cookie switches reads to the stored permission snapshot (Known #15, with new evidence)

- **Where:** `lib/permissions/checker.ts` (`hasSessionCookieCache`, `resolveGrants`).
- **Already known:** Known #15 says reads skip the database whenever a cookie named like the cache is present. This is an owner decision; the evidence below is what is new.
- **Proof:** `cookies/findings.probe.test.ts`, "C-5":
  - Role deactivated directly in the database: no cache → 403; `session_data=garbage` → **200**, plus a freshly signed `session_data`.
  - User deactivated: token only → 401; a malformed value, a `.0` chunk name, and an original cache expired by a 301 s clock advance → **200** in all three cases.
  - The re-minted cookie keeps answering 200 on the next request, so it repeats indefinitely.
- **Not reachable through the app today:** role and user deactivation delete sessions. This is defence in depth, not a live bypass.
- **Fix:** have `authenticatedSession` report whether the answer actually came from the cache (a cache cookie was sent and no `session_data` came back) and branch on that. It is sound: with server-side sessions `cookieRefreshCache` is off (`better-auth/dist/context/create-context.mjs:150-156`), so a genuine cache hit never sets `session_data`.
- **Test:** add a junk-cookie row to `tests/integration/permission-database-path.test.ts`, and a cache-input matrix: token only, valid cache, malformed value, malformed chunk, expired cache, inactive user, inactive role.

### <a id="c-7"></a>C-7. A Better Auth before hook that throws after its session read loses the slid token

- **Where:** `lib/auth/path-policy.ts`. `queueSessionReadCookies` runs only after `enforceTwoFactorPathPolicy` returns.
- **Proof:** `cookies/c2-extra.probe.test.ts`. `get-totp-uri` with a wrong password on an aged row slides the row 24 h, answers 401, and sends 0 `Set-Cookie`.
- **Impact:** low; the next request slides the cookie again.
- **Fix:** queue the read's cookies in a `finally` around the policy call.

### <a id="p-7"></a>P-7. Decoding the session cookie is the real per-request auth cost

- **Proof:** a `bun:jsc` profile of cache-hit `getSession` calls (`credentials/probe/session-cpu.preload.ts`). The time goes, in this order, to Better Auth's pure-JS `base64Decode`, `JSON.parse`, `structuredClone` (in `filterOutputFields`) and `importKey`, all of which scale with cookie size. Per call on a quiet box: **1.0 ms** on a cache hit, 0.1 ms with no cookie, 2.9 ms on the database path.
- **What inflates it:** the cookie value is 1 992 bytes. Of the 1 494-byte payload, 744 bytes are `metadata`, and 603 of those are the full 4 pages × 9 actions boolean grid, mostly `false`. It is written by `lib/auth/session/hooks.ts` through the shared `sanitizePermissions` (`packages/shared/src/permissions/matrix.ts`). Storing only granted actions would make `metadata` 403 bytes for an all-permissions role, and smaller for narrower roles.
- **Context for the TODO note** ("permission checks are strict and pressure the DB"): a cached dashboard GET makes 0 auth queries, a write makes one indexed `liveGrants` query, and a cache miss happens about once per 5 min per user. Loosening the checks would save almost nothing; this CPU cost is the real per-request auth cost.
- **Fix:** store only the granted actions (for example `{"media":["view","edit"]}`). Put the dual-shape parsing in `packages/shared/src/permissions/matrix.ts` (`sanitizePermissions` and `normalizeFullPermissions`), not only in `sanitizeCachedPermissions`:
  - `snapshotDrifted` (`lib/permissions/checker.ts`) compares through `permissionsEqual`, so a new-shape snapshot would read as drifted and resync on every write.
  - The front end's `lib/grants.ts` reads `metadata.permissions` through the same shared function.

### <a id="p-12"></a>P-12. Better Auth paths without a cookie cache read the session row twice

- **What was fixed:** upload and `/openapi.json` now read the session row once (`requireSession` returns the live-grant rows and the permission checks reuse them).
- **What is left:** on Better Auth live-session paths with no cache cookie (do-not-remember sessions, on every request), the library's own `findSession` reads the row, then our liveness check reads it again. `/two-factor/methods` makes 3 statements with the token only, `/reauth/methods` 4 (`credentials/probe/live-path.preload.ts`).
- **Why it was not changed:** getting to one read means either replacing Better Auth's session read, which would also bypass its sliding refresh and cache minting, or dropping our `is_active`/`deleted_at` check, which would let a user suspended out of band through. Moving our check onto a users-only query keeps the statement count the same.
- **Decision:** accept the extra indexed read per request on these paths, or own the session read.

---

## 2. Performance and resources

### <a id="p-1"></a>P-1. A WAL checkpoint still runs inside some limiter commits

- **What was fixed:** migration 3 dropped the `rate_limit_expires_at` index (`lib/rate-limit/store.ts`, `RATE_LIMIT_SCHEMA_VERSION = 3`). WAL frames per admission went from 2.00 to 1.00 (same key) and from 2.90 to 1.49 (distinct keys, realistic key names), guarded by `tests/unit/rate-limit-wal-frames.test.ts`.
- **What is left:** with NORMAL sync, SQLite runs the auto-checkpoint inside whichever commit pushes the WAL past 1 000 pages, synchronously on the event loop (`lib/sqlite/database.ts`; `wal_autocheckpoint` is never set). `infra/walstall.ts`, 20k admissions, after the index drop:

  | Run           | Checkpoints | Total stall | p99.9   | Checkpoint share of limiter time |
  | ------------- | ----------- | ----------- | ------- | -------------------------------- |
  | Same key      | 19          | 489 ms      | 19.8 ms | 12%                              |
  | Distinct keys | 31          | 917 ms      | 25.6 ms | 28%                              |

  Before the drop, those were 39 / 61 checkpoints, 1 582 / 2 579 ms of stall and a p99.9 of 38.8 / 39.7 ms. With checkpoints off entirely, the p99.9 is 2–4 ms on this box.

- **Impact:** at 2 admissions per dashboard request, one freeze of tens of ms every few hundred requests on this disk. The VPS disk will give different numbers: rerun `walstall.ts` there before deciding.
- **Options:**
  - (b) Set `wal_autocheckpoint=0` on the request connection and run `wal_checkpoint(PASSIVE)` from a Bun Worker with its own connection, with a guard so a dead worker cannot let the WAL grow without limit.
  - (c) `synchronous=OFF`. After a power loss the file can be corrupt, and the fail-closed limiter then returns 503 on auth routes until the file is deleted.

### <a id="p-4"></a>P-4. One image encoder slot per process

- **What was fixed:** the quality search is now guided, and picks the same rung as before with fewer encodes. Real 2048×1536 photos sent as the dashboard sends them now take 2–4 encodes instead of 6–7, and a PNG that fits at q95 still takes 1 (`tests/unit/upload-validation.test.ts`, "the encode search"). Every `optimizeImage` logs `iterations` and `durationMs`.
- **What is left:** `lib/media/image/admission.ts` admits one encode at a time with 4 waiting. `media/bench-slot.ts`: 6 concurrent uploads → 5 succeed and the **6th gets a 503**. Four raw encodes at once took 1 281–1 492 ms against 1 499–1 763 ms for one, so the single slot is what limits throughput.
- **Decision:** a second slot doubles throughput at a worst case of about 100 MB of decoded pixels per slot.

### <a id="p-5"></a>P-5. A refused SVG still costs a full sanitise on the SVG worker

- **What was fixed:** sanitise, svgo and the recheck run in a Bun Worker (`lib/media/image/svg-jobs.ts`, `svg-worker.ts`). The longest event-loop gap during a cap-sized SVG upload fell from 806–1 313 ms to 9–84 ms, and boot no longer loads jsdom, svgo or DOMPurify (app import RSS +131–137 MiB → +83–87 MiB).
- **What is left:** sanitising runs before the image budget is charged (`lib/media/upload.ts`, `admitUpload`), so a refused SVG at the caps still costs about 0.4–0.5 s of worker time. The worker runs one job with 4 waiting, so a few accounts sending refused SVGs can keep it busy, and other users' SVG uploads then get the busy 503. Other routes are unaffected.
- **Also:** the worker keeps about 75 MiB after its first job; stopping it when idle would win that back at the cost of a 3 s cold start.
- **Decision:** charge a flat budget before sanitising, or accept SVG-only 503s under abuse.

### <a id="p-6"></a>P-6. 2FA step 1 creates a session and then deletes it

- **What was fixed:** the duplicate challenge resolution, the four-query enrolment read, the single-INSERT transactions and the re-reads are gone. Counted with the statement counter (`credentials/probe/counter.ts`):

  | Flow                              | Statements, before → after | Transactions  |
  | --------------------------------- | -------------------------- | ------------- |
  | Password sign-in, no 2FA          | 13 → 9                     | 2 → 1         |
  | 2FA step 1 (password → challenge) | 20 → 16                    | 3 → 1         |
  | 2FA step 2 (`verify-totp`)        | 54 → 27                    | 3 → 1         |
  | **Password + TOTP**               | **74 → 43**                | **6 → 2**     |
  | 2FA OTP send / verify             | 16 / 40 → 8 / 29           | 1 / 4 → 1 / 2 |

- **What is left:** step 1 still inserts a session and then deletes it when 2FA is required (`lib/auth/two-factor/plugin.ts` → `issue.ts`; the same shape in `lib/auth/passwordless.ts`). That costs about 7 statements, two cookies set and then cleared, and a `loginSuccess` audit row for a session nobody receives.
- **Fix:** issue the challenge before the session is created.
- **Decision:** `EMAIL_NOT_VERIFIED` would then be answered after the second factor instead of after the password. That is a contract change.

### <a id="p-16"></a>P-16. The dashboard's pre-auth IP limiter costs more than the lookup it protects

- **Where:** `lib/http/pre-auth.ts`, called from the gate (`lib/http/admit.ts`) and from `server/elysia/auth-mount.ts`.
- **What it bounds on the gate:** an anonymous or forged-cookie request never reaches the database, because Better Auth returns null when the HMAC fails. So on dashboard routes the database path it really bounds is replaying a stale cookie whose signature is still valid.
- **Proof:** `infra/pipeline/bench3.ts`, two sessions: `enforcePreAuthIpLimit` p50 138–187 µs, against 98–174 µs for `getSession` with no cookie or a forged one, so the limiter costs 1.1–1.4× the lookup it guards. Each write also feeds P-1's checkpoints.
- **Where it must stay:** on `/api/auth/*` the pre-auth limiter is the only per-IP limit for Better Auth endpoints. Budgets are per path (`lib/auth/allowed-paths.ts`), and Better Auth's own limiter is off.
- **Options, gate only (never `auth-mount.ts`):** charge it only when a session-token cookie is present, or keep the gate's counter in process memory. Either changes the admission invariant.

### <a id="p-20"></a>P-20. Plain `db` reads wait for a pool connection with no time limit

- **Where:** `db/transaction.ts` (`reserveWithin`) bounds only `withTransaction` acquisition, at `POOL_ACQUIRE_TIMEOUT_MS` (10 s).
- **Proof:** `db/pool-wait.ts`, pool of 2 with both reserved and the acquire timeout set to 1 s: the transaction got its 503 at 1 033 ms, while the plain read answered only at 3 968 ms, when a connection came free. The only outer bound is the server's 60 s `idleTimeout`, which drops the socket and leaves the query queued.
- **Impact:** under saturation (AUTH-6), read routes hang instead of failing fast. Data-table list reads now run on their own pool (`dataTableDb`), so slow list scans no longer take connections from sign-in, but they have the same unbounded wait.
- **Options:** an app-level semaphore, or fix AUTH-6 so the pool rarely saturates.

### <a id="p-24"></a>P-24. SMTP opens a new connection per OTP email, on the response path of authenticated sends

- **Where:** `lib/smtp.ts`. `sendMailWithDeadline` calls `createTransport` on every send and closes it in `finally`. It is called from `lib/otp/delivery.ts` (`service: 'gmail'`, implicit TLS on 465).
- **Proof, connections** (`credentials/smtp/smtp-bench.ts`): the real `deliverOtp('email', …)` against a loopback `node:tls` ESMTP server. 20 sequential sends → **20 TCP connections, 20 TLS handshakes, 20 AUTHs**. The same options with `pool: true` → 0 new connections after the first.
- **Proof, time per send** (mean): 17.8 ms against 7.4 ms pooled with no added latency; **157.8 ms against 85.9 ms** with every server reply delayed 20 ms to stand in for a round trip.
- **Proof, placement** (`credentials/probe/smtp-placement.preload.ts`): `POST /api/auth/two-factor/otp/send` (email) answered as the mail landed. No transaction, `idle in transaction` backend or row lock was open during the send: delivery runs after commit. Anonymous sends deliver after the response.
- **Impact:** 3 SMTP round trips plus a TCP and TLS handshake to Gmail added to each authenticated email send (2FA OTP send, recovery's second factor, contact change). No lock or pool pressure, so latency is the only gain.
- **Fix:** a pooled transport. The deadline currently destroys the socket opened in `getSocket`; a long-lived pool needs its own per-message deadline that destroys only that message's connection, and a pool error must not poison later sends.

### <a id="p-25"></a>P-25. Argon2 parameters

- `lib/auth/password/hash.ts` declares m=64 MiB, t=3, p=4.
- **Proof** (`credentials/probe/argon-bench.ts`, argon2 0.45.1, quiet box; single hash / throughput at 16 in parallel):

  | Parameters                | Single hash | Hashes/s |
  | ------------------------- | ----------- | -------- |
  | Current, m=64 MiB t=3 p=4 | 70 ms       | 17.2     |
  | m=64 MiB t=3 p=1          | 178 ms      | 21.5     |
  | m=46 MiB t=1 p=1 (OWASP)  | 57 ms       | 59.2     |
  | m=19 MiB t=2 p=1 (OWASP)  | 36 ms       | 96.9     |

  At 16 concurrent hashes, p=1 beats p=4 at the same memory and time cost.

- The pepper already covers a database-only leak; lowering the cost only weakens offline guessing when the pepper leaks too.
- If you lower them: `needsRehash` compares only the pepper generation, so existing hashes keep the old cost unless the check also compares the parameters.

---

## 3. Known items with new evidence

These items are already in `reports/should-ignore.md` or `TODO.md` as owner decisions. They are listed only for the new evidence.

- **TODO C-027 / AUTH-6 (Argon2 inside a `FOR UPDATE` transaction).** All four sites go through `lib/auth/login-guard.ts` (`FOR UPDATE` → `verifyPasswordDetailed`): sign-in, dash reauth, `totp/start` and change-password's current-password branch. Measured hold times for the first transaction, quiet box / loaded box: sign-in 106 / 247–296 ms, wrong password 99 / 192–325 ms, dash reauth 100 / 118–273 ms, `totp/start` 81 / 163–293 ms, change-password 71 / 228–923 ms.
- **Known #15:** see [C-5](#c-5).
- **should-ignore #25** ("`checkMultiplePermissions` uses two DB round-trips") is out of date: it makes one. The entry can be retired.
- **Known #13 (OTP budget charged under PG locks):** any limiter commit can still be the one that runs a checkpoint (P-1), which puts a synchronous stall inside that PostgreSQL transaction. The measured 2 282 ms block is **not** a checkpoint: it matches a busy wait on a held SQLite writer lock (`infra/bench-limiter.ts`: 2 638 ms with the event loop blocked).
- **TODO.md:74-76** ("`processOtpSend` never locks the `users` row") is stale: it locks the row, and that lock is now what serializes sends.
- **TODO.md:314-319** (item 2.1, "`sendOtp()` runs inside the send transaction") is stale: delivery runs after the commit.
- **TODO line 1 (Bun precompile / single binary):** `bun build app.ts --target=bun` still fails at import on css-tree's `../data/patch.json`. A future `bun build --compile` must also list `lib/media/image/svg-worker.ts` as an extra entry point.

---

## 4. Tests and lightweight monitoring

### Tests still missing

1. **A query budget for each flow.** `tests/helpers/statements.ts` (`recordStatements()`) now exists and several flows pin their counts. Extend it to every sign-in, OTP and dashboard flow, so a new duplicate read fails a test.
2. **A cache-input matrix and a junk-cookie row** for C-5.
3. **A before hook that throws after its session read** keeps its slid token (C-7).

Prefer deterministic contract tests to speed thresholds. Add timing gates only once there is a stable baseline on the Linux container.

### Monitoring (no new dependency)

1. **Event-loop lag sampler.** A `setInterval(…, 500)` that measures drift, logs a structured warning above 50 ms, and exposes p99 and max on the health endpoint. Nothing in the app measures it today; it would surface P-1.
2. **`Server-Timing` in dev:** it already sends the total, `app;dur=` (`lib/http/response-policy.ts`). Add `rl;dur=` (limiter), `auth;dur=` (session plus grants), `db;desc=<count>` and `tx;desc=<count>` per request.
3. **A cache-hit ratio for the cookie cache,** logged every 15 minutes. A ratio near 0 is the dropped-cookie symptom.
4. **PostgreSQL gauges** on the periodic sweep: `count(*) from pg_prepared_statements` per backend, the longest `idle in transaction` time (AUTH-6), and pool wait time (P-20).
5. **Background work:** maintenance job start time and age, not only completion, and the age of the oldest transition or orphan marker.

Emit these as bounded aggregates, once a minute, through the existing structured logger, with routes labelled by template. Never log cookies, tokens, OTP destinations, SQL parameters or URL lists.

---

## Appendix: probe scripts

The probes cited above were run on 2026-10-16 and are kept under `%TEMP%\claude\d--apps-job-app-soft-house-dash-4\48d65cd4-1bcb-4fd8-ae35-c929837d0de1\scratchpad\`. The folder is temporary; copy out anything you want to keep.

| Folder         | What it holds                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cookies/`     | `run-probe.ts` (runner; start it from `apps/back-end`), `findings.probe.test.ts`, `c2-extra.probe.test.ts`                                                        |
| `media/`       | `bench-slot.ts`, `bench-svg-parts.ts`, `boot-svg-cost.ts`                                                                                                         |
| `infra/`       | `walstall.ts`, `bench-limiter.ts`, `pipeline/bench3.ts`                                                                                                           |
| `db/`          | `pool-wait.ts`                                                                                                                                                    |
| `credentials/` | `probe/counter.ts`, `probe/live-path.preload.ts`, `probe/session-cpu.preload.ts`, `probe/smtp-placement.preload.ts`, `probe/argon-bench.ts`, `smtp/smtp-bench.ts` |

Preload probes run through the guarded integration runner from `apps/back-end`, for example:

```powershell
bun tests/helpers/run.ts integration harness --preload=<scratch>/credentials/probe/live-path.preload.ts "--test-name-pattern=the fixture sends a trusted IP header"
```

Forwarded flags must use the `--flag=value` form as one argument.
