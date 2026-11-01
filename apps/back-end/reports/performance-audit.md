# Performance and resource-abuse audit, pre-production (2026-10-31 to 2026-11-01)

What was found, what changed, and what still waits on the owner. The work:

- a load test of a production-mode server, with real users, hostile users and protocol abuse;
- four area audits (auth, media, database, HTTP/runtime);
- two independent GPT reviews (Codex, `gpt-6.1-sol`, xhigh);
- a validation re-run of the load test against the fixed tree.

## How it was measured

- **Server:** `NODE_ENV=production bun --bun server.ts` (Bun 1.4.4), its own PostgreSQL 18 database and `SQLITE_DIR`. A development server with `OTP_DELIVERY=outbox` was used for the anonymous OTP flows.
- **Data:** 20,000 users across 60 roles, 50,000 files in 500 folders, 300,000 audit rows; 200,000 users and 500,000 files for the scale probes.
- **Traffic:** real sign-ins, with Cloudflare's always-pass Turnstile secret, so siteverify was a real network call.
- **Host:** a 4-core / 8-thread laptop that also ran the load generator. Windows Defender scanned the writes and the CPU throttled over hours. **Absolute numbers are relative**: decisions rest only on same-conditions, back-to-back comparisons. Nothing was measured on the VPS.
- **Tools:**
  - closed-loop Bun virtual users with per-route percentiles;
  - a 404 canary every 200 ms;
  - per-second server CPU, memory and handles, and `pg_stat_activity`;
  - `oha` for raw throughput, raw sockets for protocol abuse;
  - `EXPLAIN (ANALYZE, BUFFERS)` on seeded databases.

## Before and after

| Scenario                                                                                                                                | Before                                                                            | After (2026-11-01 re-run)                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Dashboard `get-session` p50 while about 16 captcha-solved sign-in attempts a second hit the server (100 users browsing, 1 s think time) | 9.8 ms idle → **1,706 ms** under attack; dashboard 190 → 60 req/s                 | 2.5 ms idle → **5.5 ms** under attack; dashboard 52.8 → 52.9 req/s; excess attempts get a fast 503 |
| Same, `GET /api/dash/users/:id` p50                                                                                                     | 11 → 1,769 ms                                                                     | 3.5 → 7.1 ms                                                                                       |
| Server CPU / private memory under that attack                                                                                           | 669% / 1,072 MB                                                                   | 352% / 532 MB                                                                                      |
| 14 `notILike` filters of 500 characters, one `users.view` account                                                                       | 8.1 s a request at 200k users; 4 in flight took a normal list from 5 ms to 849 ms | 422 in 7 ms; the worst allowed shape costs 61 ms; normal lists p50 10 ms with 8 attacking accounts |
| 30 simultaneous small image uploads                                                                                                     | 5 stored, 25 × 503                                                                | 12 stored (4 in flight + 8 queued), 18 × 503                                                       |
| One SVG with a 200 KB path                                                                                                              | 25.8 s, worker killed at 15 s                                                     | 0.34 s                                                                                             |
| A 2 KiB `.xls` claiming a 4 GiB stream                                                                                                  | allocates 4,294,967,280 bytes                                                     | allocates at most the file's size                                                                  |
| Media list `scope=all` at 500k files                                                                                                    | full scan, 225 ms                                                                 | 0.4 ms (new partial index)                                                                         |
| Per-role member counts, page of 100 roles at 200k users                                                                                 | 132 ms                                                                            | about 15 ms (new partial index)                                                                    |

## Fixed in code

Each fix has a test that fails with the fix reverted (checked one by one), unless noted.

**Overload admission** (`lib/admission.ts`): one primitive with slots, a bounded queue, a wait deadline that also catches waiters expired during a thread stall, an injected refusal and an idempotent release. The busy refusal is `serviceBusy(retryAfterS)` in `lib/http/response.ts`, which also replaced three hand-built 503s.

- **Password work.**
  - One Argon2 job at a time, 16 waiting up to 5 s (`withPasswordSlot`, `lib/auth/password/hash.ts`).
  - Sign-in holds the slot over the failed-attempt charge and the one Argon2 call only. The charge runs under a 3 s transaction deadline, so a locked user row cannot stall everyone else's sign-ins, and a refusal charges nothing (`lib/auth/login-guard.ts`).
  - Change-password hashes the replacement before verifying, so a refusal never follows a recorded verification (`modules/users/me.ts`).
  - Why it was needed: Argon2 and every session-cookie HMAC share Bun's work pool (one thread per core), which is what turned sign-in floods into a dashboard outage.
  - Tests: `tests/unit/{admission,password-slot}.test.ts`; `sign-in-controls.test.ts` (saturated slot, locked row); `self-service-credentials.test.ts`; `credential-concurrency.test.ts`, widened on purpose.
- **Turnstile siteverify.**
  - At most 64 calls in flight, 64 waiting up to 1 s, then a 503 instead of a "captcha failed" 403. The 3 s timeout starts after admission.
  - Why it was needed: junk tokens each cost a call, and Bun runs at most 256 `fetch`es a process in one queue shared with SMS, WhatsApp, HIBP and Google. The image sets `BUN_CONFIG_MAX_HTTP_REQUESTS=512`.
  - Failures are now logged (status, error class with `timedOut`, allowlisted Cloudflare codes), so a wrong `TURNSTILE_SECRET_KEY` is no longer silent (`lib/captcha.ts`).
- **Uploads.**
  - Process-wide: 4 in flight from body read to stored row, 8 waiting up to 10 s, at most 2 per account (429), and a 100 s deadline on reading the body, just under the route ceiling, so a trickle cannot hold a slot (`lib/media/upload.ts`, `readWithin` in `lib/http/request.ts`). The `readWithin` deadline has a unit test only.
  - Why it was needed: bodies are buffered whole (about 4× their size in RSS), and the old per-account budgets let many accounts add up.

**Parsers and workers**

- **svgo 4.1.0's quadratic path writer**, patched: `patches/svgo@4.1.0.patch`, with a README; `tests/unit/svg-optimize-cost.test.ts` fails if an update drops the patch. svgo 4.1.0 is the latest release.
- **`sanitizeFilename`** scans at most 1,024 code units (`packages/shared/src/filename.ts`).
- **CFB (`.doc`/`.xls`)** streams are capped at the file's size (former TODO MEDIA-3).
- **OOXML `[Content_Types].xml`** gets a token budget, and end tags, comments and processing instructions are no longer free (`lib/media/office/ooxml.ts`).

**Database**

- **Search-operator filters**: at most 3 per request, folded terms 200 characters together, else 422. Documented in the published `filters` text.
- **List pool** (`dataTableDb`): `statement_timeout` 5 s and no parallel workers; a cancelled statement (57014) answers 503 (`db/index.ts`, `db/errors.ts`).
- **Read-only media aggregates** (folder figures, folder search, library totals) moved off the auth pool onto the list pool.
- **Indexes:**
  - `idx_files_active_created` and `idx_users_role_id_live` added, concurrently, in `db/migrations/043`–`044`;
  - the unused `idx_files_folder_name` dropped (`045`);
  - Drizzle snapshot `0023`.
- **Variable-length `IN (...)` lists** on the prepared pool now bind one array (`inList`/`anyUuid`, `db/arrays.ts`), so list lengths no longer mint prepared statements (`tests/integration/list-parameters.test.ts`).
- **Deleting-file sweep** no longer starves behind rows it keeps failing on (`lib/media/lifecycle.ts`). The presign cache evicts its oldest link instead of clearing (`lib/media/signing.ts`).

**HTTP**

- **JSON body ceiling** 1 MiB → **64 KiB**, on bindings and `/api/auth/*` alike. Better Auth parses before its session check, so this was anonymous CPU; the published document changed.
- **IPv6 limiting**:
  - every per-IP limit is also charged on the client's /48 at 8× (`enforceIpRateLimit`, `lib/rate-limit/index.ts`);
  - keys come from parsed hextets, so case, leading zeros and dotted or hex tails no longer mint extra budgets;
  - mapped (`::ffff:`) and NAT64 (`64:ff9b::`) addresses key as their IPv4 host;
  - the old "pinned defect" tests now assert the fixed behaviour.

**Accounts**

- **Trusted devices**: at most 20 live per account, least recently used evicted and audited; the list is bounded.
- **Passkeys**: a best-effort threshold of 20 per account (registrations that overlap at it can each pass, should-ignore #90), refused 409 before the grant is spent; the published 409 text says so.

**Test harness** (`tests/helpers/`)

- The response check now refuses an empty body where the document publishes one.
- A failed worker-database clone drops its siblings.
- Runs renew a lease, so stale-database reclamation no longer kills a live long run.
- `run.ts` refuses a space-separated value for a value-taking flag instead of reading it as a file filter.
- A process test races six processes on one limiter key in three variants.

## Infrastructure

All of this is in `reports/coolify-deployment.md`; the final checklist there gained the matching items.

- **At least 4 vCPU** (Topology); on 2 vCPU, `max_parallel_workers_per_gather = 0` (§3.3).
- **A Cloudflare rate-limiting rule on `POST /api/auth/*`**, tightened during an attack. Never a Managed Challenge on the API, which `fetch` cannot solve (§5).
- **Full request body buffering on the upload routes**, where the plan offers it (§11).
- **Alerting** on `captcha.siteverify failed` (codes, timeouts) and on sustained 503 rates (§9).
- **Container log rotation** sized for an incident, or logs shipped off the host (§10).
- **A Cache Rule ignoring the query string** on the public media host (§11).
- **`autovacuum_vacuum_scale_factor = 0.02`** on `users` and `files`, and the list pool's `statement_timeout` recorded (§3.3).

## Decisions waiting on the owner

1. **Splitting the daily OTP delivery budget** (TODO C-002). Nine known addresses can still drain the shared 2,000-a-day email pool, after which recovery and email second factors deliver nothing. The remediation reserves pools per purpose, which needs product numbers (how to split 2,000).
2. **Recovery reset and complete hash before checking the code** (`modules/auth/recovery.ts`). Each captcha-solved reset buys one HIBP call and one Argon2 hash whatever the email or code; it is bounded per IP (15/min) and by the password slot. Checking the code first removes the cost, but changes the timing-floor design (P-14). Not changed.
3. **The application pool's `statement_timeout`** (TODO PG-1, updated with the measurements). A 30 s backstop clears every measured statement; it needs the VPS's own p99.
4. **`IPV6_PREFIX_LIMIT_MULTIPLIER = 8`.** A whole /48 gets 160 sign-in attempts and 960 pre-auth requests a minute. Fine for a small office; unmeasured for campus or carrier networks. GPT's view: keep the /48 at 8× for anonymous password and recovery work, and give ordinary dashboard pre-auth traffic its own, larger coarse budget rather than the same multiplier everywhere; a /56 would just hand back 256 buckets per /48. No evidence here supports a better universal number.
5. **Encoder slots against cores** (#81, corrected): encoder slots plus the one password slot must stay below the core count.
6. **Storage quotas.** Library files have no per-account total, and pending uploads can outrun the daily sweep (about 28,800 a day from one account against a 1,000-row sweep). Quotas are a product choice. Alerting on stored bytes and pending age is suggested.
7. **Audit retention.** `audit_logs` grows with lockouts and verifications, and should-ignore says it is never swept. List it in the retention plan.
8. **Front-end retry of the busy 503.** The front end retries 429 only. Encoder, upload, password and siteverify refusals all carry `Retry-After`, so an automatic retry would hide bursts from users. This is front-end work.
9. **A 408 for an upload body that outlives its deadline.** It answers the busy 503 today because 408 is not in the published responses. 408 is the accurate status (RFC 9110); adding it means a contract and snapshot change, which GPT rates an improvement, not a blocker.

## Not fixed, by decision or rule

- **should-ignore #89:** an upload already queued is not re-authorised. Harmless race; the effect is additive.
- **should-ignore #90:** registrations overlapping at the passkey threshold each pass it, so the overshoot is however many the owner runs in parallel. Harmless race.
- **`?disableCookieCache=true`**, or a missing cache cookie, forces one indexed session read, limited per IP and /48. It is a published parameter, and dropping the cookie has the same effect, so stripping the parameter would narrow the contract without stopping it.
- **`reapUnfiled`** can starve the same way the deleting sweep did. It is inert while no usage sources are registered, and both obvious fixes change visible timestamps.
- **Multipart part count.** `formData()` parses every part before the single-file check; 100,000 tiny parts in 10 MB cost about 56 MiB and 70 ms. That is now bounded by the 4 upload slots; a streaming parser is 1–2 days.
- **A missing `CF-Connecting-IP`** writes about 630 B of error log per request, unthrottled. It is reachable only past the origin firewall (§5, step 6).
- **The pool size.** Raising the list pool from 4 to 8 bought nothing (lists p50 3.3 s against 3.5 s, back to back). The list cost was PostgreSQL plans, now fixed above.

## Testing review

The unit, integration, process and matrix tiers cover the functional surface well: every auth and second-factor flow, permission scopes, credential races, media lifecycle and driver faults. These were gaps:

- **No overload or saturation coverage.** Added in this pass for every new cap: admission, password slot, siteverify, uploads, list filters and timeouts, parser bounds, limiter races.
- **CI builds the runtime image but never boots it.** Suggested: boot the image against disposable PostgreSQL with persistent SQLite in production mode, and run one authenticated read and write, a password rotation, one second factor and one upload (1–2 days).
- **Proxy and browser behaviour is simulated by constructed headers.** Suggested: a small HTTPS and Traefik smoke test, and checking real Cloudflare ingress in staging (about a day).
- **Load testing.** These runs used closed-loop clients, which slow down with the server and understate overload. Suggested: keep the Bun harness for scripted flows, add **k6 arrival-rate scenarios** for capacity runs from a separate machine against the VPS shape, and track success throughput, refusals, latency by outcome and recovery (1–2 days, then scheduled).
- **Property and fuzz tests.** Suggested: **fast-check** for filters, IP normalisation and the bounded parsers, with replayable seeds (1–3 days). **Schemathesis** nightly against the OpenAPI document with authenticated fixtures (2–3 days). Pact adds little in a monorepo.
- **CI gates.** Keep the contract, schema and migration gates. Add the image smoke as a required check. Keep timing gates out of PR CI until there is a Linux baseline.
- **Remaining harness items:** a deterministic held-writer test for the limiter's timer retry, and independent kill deadlines for child-process fixtures.

## Held up under attack

- **Forged session tokens, random `/api/auth/*` paths, random ids:** refused at 1.3k–3.9k req/s with PostgreSQL untouched.
- **Body and header ceilings, request smuggling, and deeply nested or very wide JSON:** all refused correctly.
- **Slowloris:** 3,000 sockets closed within 10 s; idle sockets within 30 s.
- **Limiters under a simultaneous burst:** admit exactly their budget, across processes too.
- **Anonymous OTP timing floor:** equal for known and unknown addresses (p50 2958 against 2960 ms) under DB saturation.
- **10-minute soak:** no memory or handle growth.

## Notes outside the application

- **Bun 1.4.1–1.4.4 build features.** None removes a patch in `scripts/build-binary.ts`; the speed-ups already apply. `compile.autoloadDotenv` defaults to true for the evaluation binary. Production is unaffected: it is not bundled, and `.dockerignore` excludes `.env*`.
- **`audit_logs.user_id` has no index** behind its `RESTRICT` foreign key. A manual hard delete of users scans `audit_logs` once per user. No code path hard-deletes users.
