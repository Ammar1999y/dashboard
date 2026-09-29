# Back-end Audit — Opus 5.5

Scope: `apps/back-end` working tree (2026-09-27) plus the `packages/shared` sources it imports. Issues documented in `reports/should-ignore.md` are excluded unless new evidence changes them.

## Findings

### [High] 2FA-1 — A Google sign-in offers the email OTP as its second factor, delivered to the mailbox Google just proved

- **Where:** `lib/auth/oauth/plugin.ts:332-340` (`issueTwoFactorChallenge({ …, firstFactor: 'google' })` with no `excludeContactKind`); the rule it skips is at `lib/auth/two-factor/methods.ts:186-220` (`offeredMethods(state, excludeContactKind)`).
- **Evidence:** `offeredMethods` drops the contact kind the first factor already proved, and passwordless passes it (`lib/auth/passwordless.ts:185`, `excludeContactKind: contactKindOf(channel)`). Google is accepted only when Google is authoritative for the mailbox (`lib/auth/oauth/identity.ts:71`: `gmail.com` or a hosted domain). The account email must equal the Google email (`identity.ts:103`), and the email is then marked verified (`identity.ts:149`). The OTP target for `otp:email` is `challenge.user.email`, so the second code goes to the mailbox the first factor just proved.
- **Failure scenario:** a user has enrolled `otp:email` and has no Google MFA (`amr` lacks `mfa`, so no bypass). An attacker who controls the Google account completes Google sign-in, is offered `otp:email`, reads the code in the same inbox, and gets a full session. One compromised account defeats both factors.
- **Impact:** 2FA reduces to one factor on the Google path for every `otp:email` enrolment, which is exactly the compromise 2FA exists to contain. It also bypasses the recovery invariant: the same attacker is stopped on forgot-password, because `recoveryOptions` excludes the recovered contact (`lib/auth/recovery/grant.ts`: "no single possession may satisfy both…"). Google is the only first factor with no exclusion. Reproduced with `bun -e` (`NEXT_PUBLIC_ENABLED_2FA_METHODS=otp NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS=email`): `offeredMethods(state)` → `[otp:email]`; `offeredMethods(state, 'email')` → `[]`.
- **Remediation:** pass `excludeContactKind: 'email'` when `firstFactor === 'google'`. When nothing else remains, the existing refusal branch already records `two_factor_excluded_by_first_factor`, and password sign-in is unaffected.
- **Reproduced (harness DB, integration tier):** a user enrolled with `otp:email` only (2FA on, no `amr`) completes the Google callback and gets `200 {"twoFactorRedirect":true,"twoFactorOptions":[{"id":"otp:email",…}],"defaultMethod":"otp:email"}`. `POST /two-factor/otp/send {option:"otp:email"}` → 200, and the mail stub recorded one mail to the Google token's address. `/two-factor/otp/verify` with that code → `200 {"data":{"loggedIn":true}}`, with a live session row. Control of the Google mailbox alone yields a full session.
- **Missing test:** every Google 2FA case in `tests/integration/oauth-sign-in.test.ts` enrols `otp:sms` only.

### [High] OPS-1 — Every Docker image build fails at the `verify` stage: `tsconfig.base.json` is never copied

- **Where:** `apps/back-end/Dockerfile`, `manifests` stage (`COPY package.json bun.lock bunfig.toml ./`), then `verify` stage `RUN bun run build` (`bun scripts/build-openapi.ts && tsc --noEmit`).
- **Evidence:** `apps/back-end/tsconfig.json` and `packages/shared/tsconfig.json` both `"extends": "../../tsconfig.base.json"`, that is `/app/tsconfig.base.json`, which no stage copies (`.dockerignore` does not exclude it, and nothing adds it). A scratch reproduction of a tsconfig extending a missing file gives `tsc` exit 2, `TS5083: Cannot read file …`. Bun still resolves `@/` from the local `paths`, so only the `tsc` half fails. `runtime` does `COPY --from=verify`, so it cannot build either. No CI job builds the image, and the `.dockerignore` note "verified by reproducing the verify stage locally" ran on a checkout where the file exists.
- **Failure scenario:** Coolify builds with context `/` (as the Dockerfile header prescribes). The `verify` stage exits 2 and no image is produced.
- **Impact:** the back-end cannot be deployed.
- **Remediation:** `COPY package.json bun.lock bunfig.toml tsconfig.base.json ./` in `manifests`, and a CI job running `docker build -f apps/back-end/Dockerfile .` (or `--target verify`), so a broken stage fails CI.
- **Reproduced (stage simulation, no Docker on this machine):** the `manifests` and `verify` stages were rebuilt file-for-file in a scratch directory. Only what the Dockerfile `COPY`s was copied, with `.dockerignore` honoured. `bun install --frozen-lockfile --filter @app/back-end --filter @app/shared` succeeded, then `bun run build` was run with the stage's exact `ENV`. `build-openapi` succeeded (`openapi.built … paths: 37`), and `tsc --noEmit` exited 2 with `error TS5083: Cannot read file '…/app/tsconfig.base.json'`, plus 176 cascading errors from the lost base options (for example `TS2307: Cannot find module 'gel'` in `node_modules`, which the base config's `skipLibCheck` suppresses). Control: the same tree plus `tsconfig.base.json` → exit 0, 0 errors. A real `docker build` on Linux is listed in `reports/coolify-deployment.md` §8 ("Checks only Linux or Docker can answer").

### [High] 2FA-3 — Ten overlapping Google sign-ins with an OTP option deadlock the connection pool permanently

- **Where:** `lib/auth/two-factor/issue.ts:311` (`withOtpSendHints(params.userId, options)`, whose executor defaults to `db`, `issue.ts:65-69`).
- **Evidence:** the Google caller runs inside `withAuthTransaction` and passes `transaction: tx`, which the rest of the issuer uses (`issue.ts:175, 193, 377`). This read alone checks out a second connection. The codebase names the hazard at `methods.ts:127-130`, `totp-replay.ts:124-127` and `lib/auth/transaction.ts:30-33`.
- **Failure scenario:** `MAX_POOL_CONNECTIONS` (10) or more concurrent Google sign-ins by users with an OTP option each hold one connection and wait for a second that never frees.
- **Reproduced (harness DB, `tests/helpers/google.ts`):** 14 concurrent Google callbacks → all 14 timed out at 45 s. All 10 connections sat "idle in transaction" (ClientRead), each with `insert into "verifications"` as its last statement, which is the write just before `withOtpSendHints` asks the pool for a connection. An unrelated transaction afterwards did not finish in 10 s, and **the process never recovered**: the next test (5 flows) hung until its 300 s timeout. In a fresh process, 5 and 9 concurrent callbacks completed in 172 ms and 150 ms.
- **Impact:** a process-wide, permanent outage of every database-backed route, triggered by ordinary login concurrency (or by anyone holding ~10 accounts with an OTP option). It needs a restart to clear.
- **Re-measured with timing:** without a server timeout, the same 10 backends were still `idle in transaction` at 31, 35, 60 and 120 s, and all 12 callbacks were still pending at 125 s. No waiter failed at Bun's 30 s `connectionTimeout` (see DB-6). With `idle_in_transaction_session_timeout = 10s` on the database, all 12 failed with 401 at 10.3 s, and the process recovered (next `select 1` in 213 ms, a new Google sign-in 200 in 96 ms).
- **Remediation:** `withOtpSendHints(params.userId, options, params.transaction ?? db)`. The server-side timeout in `reports/coolify-deployment.md` §3.3 bounds this class of failure but does not fix it: requests caught in it still fail.

### [Medium] OTP-1 — The SQLite writer lock makes every second process or thread fail at boot, so multi-process needs a startup redesign

- **Where:** `server.ts:92` (`acquireWriterLock(SQLITE_DIR)` before `startSchedule()` at `server.ts:127`); `lib/sqlite/writer-lock.ts:30-50` (`busy_timeout = 0` + `BEGIN EXCLUSIVE`, throw on contention); `lib/maintenance/schedule.ts:86-91`.
- **Evidence:** the lock exists to elect the single owner of the scheduled sweeps, but losing the election is fatal. `acquireWriterLock` throws, and `server.ts` awaits it at top level before `app.listen`. The lock is scoped to a local directory, while the jobs it guards (`database-retention-sweep`, `object-store-reconcile`) act on shared PostgreSQL and R2. The code documents them as "none is safe to run twice concurrently".
- **Failure scenario:** start N `server.ts` processes with `reusePort` (the stated multi-process target). Processes 2…N die with "Another application instance already owns the SQLite directory". A Bun `Worker` in the same process is refused too (reproduced with `bun -e`). Two containers with separate volumes both win their own lock and both run the PostgreSQL/R2 sweeps.
- **Impact:** the multi-process/multi-thread runtime target cannot be reached without redesigning startup. The API's serving capacity is coupled to sweep ownership.
- **Measured (harness DB), what double-running actually does:** 5 rounds of 2–4 parallel `runDatabaseSweep` calls over seeded expired sessions, verification sessions, verifications, trusted devices, pending files and orphaned objects produced no errors and no double effects on PostgreSQL tables. Removals summed exactly to what was seeded, and losers of a batch got 0 rows and stopped early. `sweepOrphanedObjects` did double up: 30 orphans produced 44–113 `DeleteObject` calls per round, `removed` summed to 113, and `hasMore` came back true with nothing left. R2 deletes are idempotent, so the cost is duplicate billable calls and wrong metrics, not data loss. `retryTransitions` was not exercised. So the schedule comment's "none is safe to run twice" overstates the database jobs, and the concrete cross-container hazard is the R2 job.
- **Remediation:** make the claim non-fatal: the winner calls `startSchedule()`, and the others serve without sweeps. Elect PostgreSQL/R2 jobs with a PostgreSQL advisory lock (`pg_try_advisory_lock` per job on a dedicated connection), so the election covers the resource the job mutates. If the second-container refusal is still wanted, keep it as a separate, explicit check.
- **Verification:** `bun test tests/process/sqlite-writer-lock.test.ts` → 4 pass, including "a second acquirer in another process is refused, loudly". Missing test: a second worker starts and serves without a schedule.

### [Medium] 2FA-2 — A removed TOTP authenticator can be re-enabled from any live session without the password

- **Where:** `lib/auth/two-factor/enrolment.ts:730-739` (`clearCapabilityFor('totp')` sets only `verified: false`, keeping the encrypted secret); `enrolment.ts:189-271` (`/two-factor/totp/confirm` needs only a session and a matching code); `lifecycle.ts:48-56` (`enableMethod` revokes every other session).
- **Evidence:** the password gate for TOTP is on `/two-factor/totp/start`. Because removal leaves the old secret in the row, `confirm` succeeds with no `start`, using a code from the old authenticator. The codebase's own rule is at `enrolment.ts:394-397`: "a hijacked session must not be able to turn the feature on and sign the owner out of every device with one unauthenticated call". Every other enabling transition calls `requireReauthPassword`.
- **Failure scenario:** a user's phone (session and authenticator app) is stolen. From their laptop they remove TOTP. Removal keeps sessions (`enrolment.ts:517-520`), so the thief's session survives. The thief posts `/two-factor/totp/confirm` with a code from the stolen app. TOTP is live again on a device the thief holds, the owner's other sessions are revoked, and the thief keeps theirs.
- **Remediation:** on TOTP removal, overwrite the secret with an unusable random value (as the backup-code path does at `enrolment.ts:342-352`), or delete the row, so `confirm` always requires a fresh `start`.
- **Reproduced (harness DB):** sessions A and B, with TOTP and `otp:sms` enrolled. A: `methods/disable {method:"totp", password}` → 200, and the credential row becomes `verified:false` with the secret unchanged. B: `/two-factor/totp/confirm {code}` from the old secret, with no `start` and no password → `200 {"data":{"method":"totp"}}`. Afterwards A's session is gone, B's is live, and the credential is `verified:true` again.
- **Missing test:** remove TOTP, then confirm with a code from the old secret, expecting a refusal.

### [Medium] USR-1 — `POST /api/dash/users` confers permissions and a caller-chosen password without the re-auth window every sibling requires

- **Where:** `app/api/dash/users/handler.ts:131-135` (`requirePermission(ctx, { resource: 'users', action: 'create' })`, no `reauth`).
- **Evidence:** `reauth: true` guards `POST /permissions` (`permissions/handler.ts:113`), `PUT` and `DELETE /permissions/:id` (`:123`, `:297`), user `DELETE` (`users/[id]/handler.ts:250`), the admin 2FA reset (`two-factor/handler.ts:57`), and role or matrix changes in `editUserAsAdmin` (`lib/users/edit.ts:378-386`). `POST /users` with `roleId: 'custom'` runs `createCustomRole`, the same operation `POST /permissions` performs, and also sets the password of a new login. `lib/http/session.ts:32-35`: "Set it on the whole class or on none of it."
- **Failure scenario:** a hijacked session (no fresh password) holding `users.create` + `permissions.create` posts `{roleId:'custom', permissions:[everything the actor holds], password:'known'}` and gets 201. That is a durable login at the actor's privilege level. The same session is refused `REAUTH_REQUIRED` when it tries to change an existing user's role.
- **Reproduced (harness DB, one session, no re-auth window):** `POST /api/dash/users {roleId:'custom', permissions:[users.*, permissions.*], password}` → 201, and the new login signs in → 200. On the same session, a role-change `PUT /users/:id` → 401 `REAUTH_REQUIRED`, and so does `POST /permissions`.
- **Impact:** the re-auth boundary that protects privilege-conferring actions is bypassable through account creation.
- **Remediation:** add `reauth: true` to the `POST` gate, so it matches the class.
- **Missing test:** `POST /users` without an open re-auth window is refused.

### [Medium] AUTH-1 — Unexpected errors on Better Auth routes are printed raw to the console, bound query parameters included (session tokens) (only remove from the error message the things that are need to be deleted or any sensitive data. Not the whole error)

- **Where:** `lib/auth/index.ts:71-73` (`logger: { disabled: true }`, no `onAPIError`); `node_modules/better-auth/dist/api/index.mjs:193-212` (router `onError` returns `undefined` when the logger is disabled); `node_modules/better-call/dist/router.mjs:84-97` (better-call 1.4.0: no `throwError` → `console.error('# SERVER_ERROR: ', error)` + empty 500); `app.ts:399` (`auth.handler` returns that response, so the sanitizing `handleApiError` catch never sees the error).
- **Evidence:** every Drizzle driver failure is a `DrizzleQueryError` whose message is `Failed query: …\nparams: <values>` (`node_modules/drizzle-orm/errors.js:10-13`). The project's serializer withholds exactly this (`utils/log.ts:112-193`, `QUERY_ERROR_MARKERS`: "query errors echo bound parameters"), but this path bypasses the serializer entirely. It applies to every non-`APIError` thrown under `/api/auth/*`, including the project's own `throw new Error(…)` in `lib/auth/path-policy.ts` and `lib/auth/login-guard.ts`.
- **Failure scenario:** a pool timeout or database restart during `GET /api/auth/get-session` fails `findSession(token)`, and stdout, the Coolify log, receives `params: <live session token>`. `/sign-in/email`, `/passwordless/verify` and `/two-factor/*` leak their parameters the same way. Reproduced by the auditor with a better-call router whose endpoint throws `DrizzleQueryError` with a param `LIVE_SESSION_TOKEN_abc`: the output contained the token.
- **Reproduced (harness DB, via DB-1):** `console.error` received `# SERVER_ERROR:  Error: Failed query: insert into "sessions" … params: <sessionId>,<expiresAt>,VmXx7bEK…(new session token),203.0.113.7,UUUU…,<userId>,…`, and the response was a 500 with an empty body. The token, IP and user id were printed. An email in the output was not reproduced on this path; it depends on which query fails. AUTH-7's 500s go through the same raw print.
- **Impact:** bearer credentials and personal data readable by anyone with log access. This is distinct from known issue #8, which concerns the serializer keeping a third-party `message`; here the serializer never runs.
- **Remediation:** set `onAPIError: { throw: true }` in the Better Auth options. `APIError`s still become their normal responses in better-call (`router.mjs:88`). Everything else reaches `app.ts`'s catch → `handleApiError` → `logSanitized` and the standard 500 envelope.
- **Missing test:** a Better Auth route hitting a database fault emits no bound parameters.

### [Medium] AUTH-2 — Sign-in and re-auth validate the submitted password against the creation policy, so tightening the policy locks out existing passwords

- **Where:** `packages/shared/src/validation/auth.ts:30` (`loginSchema.password: passwordSchema`, used at `lib/auth/path-policy.ts:226-235`); `auth.ts:45` (`adminReauthSchema`); `packages/shared/src/validation/rules.ts:321` (`reauthPasswordSchema = passwordSchema.optional()`, used for `currentPassword` in change-password, change-email and change-phone).
- **Evidence:** `passwordSchema` (`rules.ts:290-298`) enforces `PASSWORD_MIN` and the four character-class rules. `bun -e`: `loginSchema.safeParse({ email: 'a@gmail.com', password: 'alllowercase1!', captcha: 'x' })` fails with "تحقق من صحة كلمة المرور". So do `adminReauthSchema` and `changePasswordSchema` for the same current password.
- **Failure scenario:** a project built on the kit raises `PASSWORD_MIN` from 8 to 12. Every stored password under 12 characters then gets 422 on `/sign-in/email`, 401 on admin re-auth, and 422 on change-password, the one route meant to migrate it. Only forgot-password recovers, and nothing signals the operator.
- **Remediation:** just add a comment in the schema so any future changes should be in mind (This solution from the owner)

### [Medium] HTTP-1 — Body-less POST routes have no Origin check, so a same-site sibling origin can trigger them with the admin's cookie

- **Where:** `routes.ts:356-360` `POST /api/dash/users/:id/two-factor/reset`, `routes.ts:446-450` `POST /api/dash/media/files/:id/publish`, `routes.ts:454-458` `POST /api/dash/media/files/:id/unpublish` (all `body: 'none'`), plus the two multipart routes `routes.ts:398-402` and `:496-500`. The defence is described at `app.ts:114-135`.
- **Evidence:** the comment's three layers are Better Auth's origin check (only under `/api/auth/*`), `SameSite=Lax`, and "JSON routes require `application/json`, which is not CORS-simple". A POST with no body is CORS-simple, like multipart, so layer 3 does not apply. The comment names only multipart. Nothing on table routes reads `Origin` or `Sec-Fetch-Site` (grep over `app/`, `lib/`, `app.ts`). `SameSite=Lax` withholds the cookie cross-_site_, but sends it on a same-site, cross-origin request (a sibling subdomain, such as the R2 public media host, a marketing site or a preview deploy).
- **Failure scenario:** a page on a sibling subdomain runs `fetch('https://app.example.com/api/dash/users/<id>/two-factor/reset', {method:'POST', credentials:'include'})` while an admin is signed in and inside their re-auth window. The browser sends the Lax cookie and the target's 2FA is removed. Publish/unpublish need no re-auth at all. The auditor confirmed with in-process `app.handle` that such a request (`Origin: https://evil.example.com`, `Sec-Fetch-Site: same-site`) reaches the handler (it answered the session check's 401, not an origin refusal).
- **Reproduced end to end (harness DB):** a real sign-in with an open re-auth window sent the session cookie with `Origin: https://evil.example.com`, `Sec-Fetch-Site: same-site` and no body. `POST /api/dash/media/files/:id/publish` → **200**, and the row moved from `private` to `public`. `POST /api/dash/users/:id/two-factor/reset` → **200**, and the target's `two_factor_methods` went from `['totp']` to `[]`. The responses carry no `access-control-allow-origin`, so the attacker cannot read them, but the side effects land. Control: the same headers on `POST /api/auth/sign-out` → 403 from Better Auth's origin check. Both cookies are `HttpOnly; SameSite=Lax`.
- **Impact:** a gap in the documented CSRF defence, not mentioned by it, on a destructive admin action.
- **Remediation:** one check in the adapter (`lib/http/adapters/elysia.ts`) for non-safe methods: refuse 403 when `Sec-Fetch-Site` is present and not `same-origin`, or when `Origin` is present and not `PUBLIC_ORIGIN`. Non-browser callers send neither header, so no contract narrows. Then correct `app.ts:129-134` to name body-less POSTs.
- **Missing test:** a cross-origin request to a table route is refused.

### [Medium] OPS-2 — The runtime container runs as root

- **Where:** `apps/back-end/Dockerfile` `runtime` stage: no `USER`; `CMD ["sh", "-c", "bun scripts/build-openapi.ts && exec bun --bun server.ts"]`.
- **Evidence:** `oven/bun` ships a `bun` user (uid 1000) but does not switch to it. `reports/coolify-deployment.md:740-743` and `:1747` restrict `SQLITE_DIR` to "the runtime UID" at `0700`/`0600`, which protects nothing when that UID is 0, and the document never says the process is root.
- **Failure scenario:** any code-execution bug in the upload parsers (jsdom, svgo, the CFB/OOXML parsers) runs as uid 0. It can overwrite `/app` code and `node_modules`, and owns every file on the mounted volume.
- **Remediation:** `USER bun` after `bun install` in `runtime`, and `chown bun:bun /app/apps/back-end/build` (the CMD rewrites `build/openapi.json` at start). Make sure the `SQLITE_DIR` mount is owned by uid 1000, and record the one-time `chown` for existing volumes in the deployment document.

### [Medium] MEDIA-1 — An SVG document inside a `url(data:…)` attribute passes every SVG guard unexamined

- **Where:** `packages/shared/src/images/config.ts:98-105` (`hasExternalUrlReference` accepts any `url()` target starting with `data:`), called from `isDangerousValue` (`config.ts:162-173`), which the attribute sweep at `svg-optimizer.ts:627-630` relies on.
- **Evidence:** the raster-only rule for inline data (`SAFE_DATA_URI` + `analyzeInlineRaster`, `svg-optimizer.ts:37, 103`) is applied to `<image>` only. `renderedNodeCount`, the animation refusal, the element limit and the `javascript:`/`<script` substring checks never look inside a base64 payload. The file's own rule, that inline data may only be an admitted raster type "so an SVG cannot store a format or an animation the upload route refuses", is broken. `<image href="data:image/svg+xml…">` is refused (`invalid-inline-raster`), while the same payload under `mask=`, `filter=` or `clip-path=` is kept byte for byte (verified with `sanitizeSvgServer` + `svgOptimizerServer`). The inner document uploaded on its own is refused as `animated`.
- **Failure scenario:** a user with media create/edit uploads `<rect mask="url(data:image/svg+xml;base64,…)"/>` whose inner document is a 2³⁹ `<use>` expansion with `<animate>`. It is stored and served inline as `image/svg+xml` (on the public origin once published), and bypasses `SVG_MAX_RENDERED_NODES`, the guard that exists to stop exactly that blow-up in the viewer's browser.
- **Reproduced in a real browser (headless Microsoft Edge 154, Chromium engine):** each payload was run through the production pipeline first (`sanitizeSvgServer` → `svgOptimizerServer`, `lib/media/image/svg.ts`). All were accepted and stored with the inner base64 byte-identical, while the same inner documents uploaded alone were refused (`animated`, and the `<use>` bomb). The stored files, served as `image/svg+xml`, behaved as follows:
  - **The inner document is rendered.** A static inner mask covering half the canvas hid exactly half the outer rect (20 000 of 40 000 red pixels) in both `<img>` and direct-document mode.
  - **The refused animation runs.** Opened as a document, as a public media URL opened in a tab is, the masked area grew 10 800 → 22 600 → 35 200 → 40 000 px over 1.5 s. In `<img>` mode only the first frame showed.
  - **The node-count guard is bypassed with real cost.** `<use>` depth 16 (65 536 nodes) took **23.6 s** to decode in `<img>`. Depth 22 and 26 did not finish within **60 s** in `<img>` or document mode (the tab stayed busy).
  - **No script or network.** The inner `<script>fetch(…)` and external `<image href="http://…/beacon">` produced zero requests to the beacon server in either mode.
- **Impact:** any user with media create/edit can store a file that freezes the tab of every dashboard user who views it, and every public visitor once it is published, and can bypass the animation refusal. No script execution or data exfiltration was observed.
- **Remediation:** in `hasExternalUrlReference`, accept a `data:` target only when it passes the same `SAFE_DATA_URI` + `analyzeInlineRaster` check `<image>` gets, and refuse anything else as `invalid-inline-raster`. No admitted raster reference is narrowed.
- **Missing test:** `data:image/svg+xml` inside `url()` in a presentation attribute.

### [Medium] DB-1 — A `User-Agent` longer than 512 characters makes every sign-in fail

- **Where:** `db/schema.ts:279` (`sessions.user_agent varchar(USER_AGENT_MAX = 512)`); `node_modules/better-auth/dist/db/internal-adapter.mjs:264` (1.7.3: `userAgent: headers?.get("user-agent") || ""`); `lib/auth/session/hooks.ts` (`session.create.before` passes `...session` through unbounded).
- **Evidence:** the two other `user_agent` columns are bounded before insert (`lib/audit/index.ts:25`, and `trusted_devices` via `authAuditMeta` → `boundedAuditMeta`). The session path is not. In a rolled-back transaction, a 600-character value gave `22001 value too long for type character varying(512)`.
- **Failure scenario:** any client with a longer UA (some in-app webviews and custom clients) fails `INSERT sessions` on password, passwordless, OAuth and 2FA completion. It can never sign in, and the failure is an unmapped 500 on a Better Auth path, so it is printed raw with its bound parameters (new session token, user id, IP), which makes it a deterministic trigger for AUTH-1.
- **Remediation:** in `databaseHooks.session.create.before`, return `userAgent: session.userAgent?.slice(0, USER_AGENT_MAX)`.
- **Reproduced (harness DB):** a 512-character UA → 200. 513 and 600 characters → 500 with an empty body, no cookie and no session row (`value too long for type character varying(512)`).
- **Missing test:** sign-in with a UA over 512 characters.

### [Medium] DB-6 — Waiting for a pooled connection has no time limit, so any pool exhaustion is permanent

- **Where:** `db/index.ts:31` (`new SQL(DATABASE_URL, { max: MAX_POOL_CONNECTIONS })`, no acquire bound); `lib/auth/transaction.ts` / `withTransaction` (reserve a connection per block); `reports/coolify-deployment.md` §3.1c (claimed "callers beyond 10 queue, then fail on Bun's 30 s `connectionTimeout`").
- **Evidence:** Bun 1.4.2 `bun-types/sql.d.ts:278-327` and `docs/runtime/sql.mdx` define `connectionTimeout` as the "maximum time in seconds to wait when establishing a connection". `reserve()` "waits until one frees up", with an `AbortSignal` as the only way out. Measured: a `max: 1, connectionTimeout: 2` pool with its connection reserved left a second query pending at 6 s with no error. In the 2FA-3 deadlock, nothing timed out in 125 s. The PostgreSQL server has `idle_in_transaction_session_timeout = 0` (no bound) by default, and neither the code nor the deployment document set it.
- **Failure scenario:** any code path that holds a transaction while waiting on something that never arrives (2FA-3 is the confirmed one; a future second-connection read or a hung await inside `withTransaction` is the same shape) fills the pool. Every later database request then waits forever, and the health check's separate probe pool may still answer, so the orchestrator does not restart the container.
- **Impact:** a single bug of this class turns into a permanent, silent outage instead of failed requests. The operations document tells the operator the opposite.
- **Remediation:** set `idle_in_transaction_session_timeout` on the application role (added as `reports/coolify-deployment.md` §3.3, measured safe at `10s`; the §3.1c claim is corrected). Optionally bound acquisition in code as well: pass an `AbortSignal.timeout(…)` to `reserve()` inside `withTransaction`, so a waiter fails with a mapped 503 instead of hanging.
- **Verified:** with `idle_in_transaction_session_timeout = 10s`, the deadlock ended at 10.3 s and the process recovered. `credential-concurrency.test.ts` (3/3) and `media-files.test.ts` (50/50) passed under it. The longest legitimate idle-in-transaction gap was 4.58 s, a 20-way sign-in burst with Argon2 inside the transaction (AUTH-6).

### [Low] OTP-3 — The rate-limit upsert moves the window backwards when a stale caller commits late, re-granting a full budget

- **Where:** `lib/rate-limit/store.ts:68-79` (`SQL_CONSUME`: `WHERE rate_limit.window_start <> excluded.window_start` → `count = excluded.count`, `window_start = excluded.window_start`); window computed at `lib/rate-limit/fixed-window.ts:80-81`.
- **Evidence:** the rollover branch treats any different `window_start` as newer. A caller holding an older window (computed before a boundary, then delayed by the SQLite busy handler in another process, or after a backwards wall-clock step) rewrites the row to the old window. The next current-window caller then "rolls over" again, starting from `count = cost`.
- **Failure scenario:** reproduced with `bun -e` against the exact SQL (Bun 1.4.2, SQLite 3.53.2). With a limit of 5, 5 were admitted in W1 and the 6th refused. One stale W0 call wrote `{count: 1, window_start: W0}`, after which 5 more W1 requests were admitted.
- **Impact:** over-admission at window boundaries on every limiter once several processes share the store, including the global OTP send budget. That adds up to another full cap on top of the documented 2× (#12).
- **Remediation:** roll over only when `excluded.window_start > rate_limit.window_start`. A stale caller then matches no row and is refused with `retryAfter ≥ 1`. Add the stale-window case to `tests/fixtures/_sqlite-semantics-child.cjs`.

### [Low] OTP-4 — The anonymous timing floor is shorter than the SQLite busy timeout on a branch only real accounts reach

- **Where:** `lib/http/timing-floor.ts:8` (`MINIMUM_RESPONSE_MS = 1500`, marked TODO); `lib/sqlite/database.ts:48` (`BUSY_TIMEOUT_MS = 2000`); `lib/otp/send.ts` (global-budget charge, reached only after `findRecipient` returns a user).
- **Evidence:** the floor pads fast responses but caps nothing. Under writer contention, the known-account branch's SQLite write can wait up to 2 s (#13 measured 2 282 ms) and still return the generic 200, but later than the floor. An unknown identifier always answers at ~1.5 s.
- **Failure scenario:** during SQLite writer contention, an attacker times `/forgot-password/send` for candidate identifiers. Responses slower than ~1.5 s mark existing accounts.
- **Impact:** an account-existence oracle on the anonymous surfaces the floor exists to protect. Known issue #13 records the lock-hold cost of the same charge, not this oracle. `tests/integration/otp-timing-oracle.test.ts` covers only a slow provider.
- **Remediation:** raise the floor above the worst-case busy wait from measurement.

### [Low] OTP-5 — OTP limit constants are coupled to other definitions without being derived from them or flagged

- **Where:** `lib/otp/send.ts:32` (`crypto.randomInt(100_000, 1_000_000)`) vs `packages/shared/src/validation/constants.ts:39` (`OTP_CODE_LENGTH = 6`, enforced by `validation/otp.ts:84`); `lib/otp/limits.ts:10` (`OTP_MAX_DAILY_VERIFY_ATTEMPTS`), baked into `chk_verify_attempt_daily_max` (`db/schema.ts:1002-1003`) without the "⚠️ Baked into…" note its two siblings on lines 1-6 carry.
- **Failure scenario:** raising `OTP_CODE_LENGTH` to 8 makes every issued code fail schema validation, so nobody can verify. Raising the daily cap without a migration turns the 16th charge into a raw CHECK violation (500). `ANONYMOUS_VERIFY_SURFACED` passes that 500 through on anonymous verify, and only an existing account can produce it.
- **Verified (harness DB):** `db/drizzle/0000_panoramic_quicksilver.sql` has `CHECK (verify_attempt_daily <= 15)`, and writing 16 fails with `violates check constraint "chk_verify_attempt_daily_max"`. `lib/otp/verify.ts:273` refuses only when `dailyUsed >= constant`, so a raised constant reaches that raw error.
- **Remediation:** derive the generator range from `OTP_CODE_LENGTH` (`randomInt(10 ** (n-1), 10 ** n)`), and add the same migration warning above `OTP_MAX_DAILY_VERIFY_ATTEMPTS`.

### [Low] OTP-6 — Dead and duplicated OTP verify paths

- **Where:** `lib/otp/hash.ts:13, 20, 51, 85-90` (legacy `p1:` argon2 branch and its `verifyPassword` import); `app/api/auth/otp/verify/handler.ts:104-108` (inner `try/catch` calling `collapseProofThrottle`).
- **Evidence:** the legacy branch's own removal condition, "once no deployment can hold a `p1:` code", is already met: there is no deployment yet, and codes expire after 10 minutes. While the branch remains, a malformed `p1:` row throws `PasswordHashFormatError`, a 500 that only an existing account can produce on anonymous verify. The handler's inner catch repeats what its rewrite hook `collapseAnonymousVerifyError` (`lib/otp/throttle.ts:163-168`) already does first. The sibling `app/api/auth/forgot-password/reset/handler.ts` uses the hook alone.
- **Remediation:** delete the `p1:` branch and import, and drop the inner catch in the verify handler.

### [Low] 2FA-4 — The backup-code counter can drift low, the direction its own contract rules out

- **Where:** `lib/auth/two-factor/plugin.ts:379-386` (`spendBackupCode(userId).catch(() => {})` in an after-hook, outside the verifier transaction and the user lock); `lib/auth/two-factor/backup-codes.ts:63-83` (the comment asserts a lost decrement can only leave the count too high).
- **Failure scenario:** a backup-code sign-in commits the plugin's rewritten code blob. A concurrent `/two-factor/generate-backup-codes` commits under the user lock and sets `backupCodesRemaining = 10`. The earlier sign-in's after-hook then decrements the new set to 9. Repeated, the count reaches 0 while valid codes remain, `backupCodesReady` turns false, and the method is no longer offered.
- **Reproduced (harness DB):** a trigger delaying the first after-hook's insert by 2 s forced the ordering. The plugin's rewritten blob committed (9 codes, counter 10), a concurrent `generate-backup-codes` → 200 (counter 10), then the after-hook decremented. Final state: counter 9, blob of 10 new codes.
- **Remediation:** decrement inside the verifier's transaction on the bound executor that holds the user lock, not in the after-hook.

### [Low] 2FA-7 — Disclosing the TOTP secret via `/two-factor/get-totp-uri` leaves no audit record of the disclosure

- **Where:** `lib/auth/allowed-paths.ts:153` (the library's `/two-factor/get-totp-uri`, allowlisted), gated by the re-auth window or a password proof.
- **Evidence (harness DB):** with no password and no window → 401 `REAUTH_REQUIRED`. With the password → 200 `{totpURI: "…secret=…"}`, and the only new audit row is the password proof (`purpose: "reauth_two_factor"`, `apiPath "/two-factor/get-totp-uri"`), with nothing recording that the secret left the server. Inside an open admin re-auth window, with an empty body → 200 with `secret=` and **no audit row at all**. The other sessions stay live throughout.
- **Impact:** the one operation that silently clones the second factor has no forensic trace. Every neighbouring 2FA transition (enable, disable, start, reset) is audited.
- **Remediation:** write an audit event (`twoFactorSecretDisclosed`) in an after-hook on this path. Whether the endpoint should exist post-enrolment is a product decision and out of scope here.

### [Low] 2FA-5 — The admin 2FA reset is audited as an action by the target, not the admin

- **Where:** `app/api/dash/users/[id]/two-factor/handler.ts:143-156` (`userId: targetId, userEmail: target.email`, with the actor only in `newData.resetBy`).
- **Evidence:** every other admin mutation records the actor as `userId` and the subject in `recordId` / `forUserId`: `lib/users/delete.ts:124-133`, `app/api/dash/users/[id]/sessions/handler.ts:226-230`, `lib/users/edit.ts`, `app/api/dash/permissions/*`. `resetBy` is not a `metadataFields` entry, so it also appears as a changed column.
- **Impact:** "actions by admin X" misses every 2FA reset, and the reset is attributed to the account that lost its second factor.
- **Reproduced (harness DB):** the reset wrote `userId`/`userEmail` = target, `newData: {"resetBy":<adminId>,…}`, `changedFields: ["twoFactorEnabled","twoFactorReset","resetBy"]`. An admin `DELETE /users/:id` wrote `userId` = admin.
- **Remediation:** `userId: actorUserId` with the actor's email, `recordId: targetId`, and `forUserId: targetId` passed through `metadataFields`, matching `lib/users/delete.ts`.

### [Low] 2FA-6 — The rollout preflight certifies a configuration the server refuses to boot on

- **Where:** `scripts/check-two-factor-rollout.ts:52-65`; the coherence rule exists only at load in `packages/shared/src/validation/two-factor.ts:68-78`, not in `two-factor-lists.ts`, which the script imports.
- **Evidence:** the script's header promises it will never "certify a configuration the deployment rejects". Verified with `bun -e`: `parseTwoFactorMethods('totp,otp')` + `parseTwoFactorOtpChannels(undefined)` → `["totp","otp"] []`, no error, while loading `validation/two-factor.ts` with the same values throws "enables "otp" but … names no channel".
- **Failure scenario:** an operator sizes `totp,otp` with no channels, or `sms` only with phone disabled. The script reports 0 stranded and exits 0, then the deploy fails to boot.
- **Remediation:** move the "otp needs a channel" rule into `two-factor-lists.ts` as a pure function taking the parsed lists, call it from both `two-factor.ts` and the script, and apply it after the script's `PHONE_ENABLED` filter.

### [Low] USR-2 — The permission checker's cookie-cache test never matches under https, so production and the tests run different read paths

- **Where:** `lib/permissions/checker.ts:43-47` (`/(?:^|;\s*)better-auth\.session_data=/`), used at `checker.ts:191-192` and `checker.ts:304-305`.
- **Evidence:** better-auth 1.7.3 prefixes cookie names with `__Secure-` whenever `baseURL` starts with `https://` (`node_modules/better-auth/dist/cookies/index.mjs:20-32`), and chunks large values as `.0`, `.1` (`:279-291`). `baseURL` is `PUBLIC_ORIGIN`, which `lib/env.ts:88-93` requires to be https in production, and `lib/auth/index.ts` sets no `useSecureCookies` / `cookiePrefix` override. `bun -e`: `__Secure-better-auth.session_data=b` → `false`, `better-auth.session_data=b` → `true`, `better-auth.session_data.0=b` → `false`.
- **Impact:** in production every `view`/`viewOwn` check takes the DB branch. That is safe, but the cache branch, its comments (`app/api/dash/users/[id]/handler.ts:69-72`), and the stale-read window of known issue #5 exist only on http development, and the integration tests exercise a path production never runs. This changes known issue #5: in production there is currently no 5-minute stale read.
- **Remediation:** take the name from the library, as `lib/http/openapi/better-auth.ts:45` already does (`(await auth.$context).createAuthCookie('session_data').name`), and match it plus its `.N` chunks.

### [Low] USR-4 — An admin cannot edit, suspend or reset the password of a user whose role was deactivated without also moving them to another role

- **Where:** `lib/users/edit.ts:232` (`if (!isCustomRole) await validateAssignableRole(input.roleId, tx)`, run even when `input.roleId === lockedUser.roleId`); `lib/permissions/roles.ts:195-208` requires `isActive = true`.
- **Failure scenario:** `PUT /permissions/:id {isActive:false}` leaves members' `role_id` on the inactive role. `GET /users/:id` returns that `roleId`, and the edit form sends it back with a new name or `isActive:false`. The `PUT` answers 404 for the user the `GET` just returned.
- **Reproduced (harness DB):** a target on an inactive role: `GET /users/:id` → 200 with its `roleId`. Sending it back on `PUT`: rename → 404, suspend → 404, password reset → 404, and the row is unchanged. A control user on an active role renames → 200.
- **Remediation:** validate assignability only when the role is actually changing (`input.roleId !== lockedUser.roleId`). This widens behaviour and narrows nothing.

### [Low] USR-6 — Authority guards that can never be false are typed as if they could, so a future `undefined` silently skips every scope check

- **Where:** `if (actorPermissions)` / `actorPermissions: ActorPermissions | undefined` at `lib/users/target-user.ts:53, 57, 72, 76` (`actorCoversTargetRole` returns `true` for `undefined`), `lib/users/edit.ts:234`, `app/api/dash/users/handler.ts:153, 163, 181`, `app/api/dash/permissions/handler.ts:131`, `app/api/dash/permissions/[id]/handler.ts:147, 160, 328`, `app/api/dash/users/[id]/sessions/handler.ts:97`, `app/api/dash/users/[id]/two-factor/handler.ts:128`. The same shape appears at `lib/permissions/checker.ts:264, 307`: `validID(…) ?? null`, where `validID` returns `''` and never nullish.
- **Evidence:** `checkUserPermission` always returns an object (`sanitizePermissions` yields `{}` at worst), so every guard is dead code. Verified on the harness DB for users with full, no and own-only grants, on both the cache (`view`) and DB (`create`) branches: `permissions` was always an object. Every `actorPermissions` source in `app/` and `lib/` is `requirePermission`. The optional type still admits `undefined`, and the guards fail open for it.
- **Failure scenario:** a new caller passes `undefined` (a helper returning early, a destructuring typo). Grant and reachability checks are skipped without a type error, which is privilege escalation.
- **Remediation:** make `actorPermissions` a required `ActorPermissions`, delete the guards and the `undefined → true` branch, and drop the `?? null`.

### [Low] AUTH-3 — An anonymous sign-in lockout blocks the signed-in owner's re-auth and tells them their correct password is wrong

- **Where:** `lib/auth/login-guard.ts:192-196` (`reject_locked`, applied on the `userId` path too), reached from `app/api/dash/users/me/change-password/handler.ts:98`, `lib/users/contact-change.ts:118` and `lib/auth/reauth/password.ts:19`; mapped to `userMsg.currentPasswordIncorrect` (`lib/users/current-password.ts:10`) or `MSG_INVALID_CREDENTIALS`.
- **Failure scenario:** an attacker who knows the email sends 5 captcha-solved bad sign-ins every lockout period. The owner, holding a live session, cannot change password, email or phone, open the admin re-auth window, or manage 2FA, which are exactly the responses to the attack. Each attempt tells them the correct password is wrong.
- **Remediation:** for authenticated purposes (everything except `sign_in`), answer a distinct "temporarily locked" message.
- **Reproduced (harness DB):** after 5 bad sign-ins from other IPs (`lockedUntil` set), the owner's live session sending the correct password gets `/api/dash/auth/reauth` → 401 invalid credentials (the same body as a wrong password), `change-password` → 400 "current password incorrect", and `/two-factor/totp/start` → 401 invalid credentials.
- **Missing test:** re-auth with the correct password while the account is locked.

### [Low] AUTH-4 — Every re-auth password proof is audited as `reauth_two_factor`, including the admin re-auth window

- **Where:** `lib/auth/reauth/password.ts:26` (hard-coded `purpose: 'reauth_two_factor'`), called from `app/api/dash/auth/reauth/handler.ts:36` and `lib/auth/path-policy.ts:346`. `mintAdminReauth` (`lib/auth/reauth/window.ts:35-72`) writes no audit row of its own. `PasswordProofPurpose` (`lib/auth/login-guard.ts:40-45`) has no admin value.
- **Impact:** the only record that the admin re-auth window was opened is mislabelled as a 2FA re-auth, so forensic queries for either purpose are wrong.
- **Remediation:** take `purpose` as a parameter of `verifyReauthPassword` and add `reauth_admin`, as the `contact-change.ts` callers of `verifyLoginAttempt` already do. 2FA callers keep their current label.

### [Low] AUTH-5 — `/sign-in/email` without a challenge leaves a stale "don't remember" marker

- **Where:** `lib/auth/two-factor/plugin.ts:238` (`if (outcome.kind === 'proceed') return;`); `lib/auth/two-factor/issue.ts:190, 196, 245` return `proceed` before `carryRememberChoice` (`issue.ts:249`). `node_modules/better-auth/dist/cookies/index.mjs:167-178`: `setSessionCookie(…, false)` never clears the marker.
- **Evidence:** every other issuance clears it: `deliverSessionCookie` (`lib/auth/session/cookie.ts:10-16`) for passwordless, OAuth and challenge completion, and `carryRememberChoice` at challenge issue.
- **Failure scenario:** a user signs in with `rememberMe:false`. The session is revoked server-side and the client returns to login without `/sign-out`. The user signs in again with `rememberMe:true` and no 2FA (or a trusted device). The marker survives, so Better Auth skips the sliding refresh for that browser session.
- **Reproduced (harness DB):** sign-in with `rememberMe:false` set `session_token`, `dont_remember` and `session_data`. After the session rows were deleted, a second sign-in with `rememberMe:true` on the same cookie jar set only `session_token` and `session_data`, and the jar still held `better-auth.dont_remember`.
- **Remediation:** on `proceed`, expire `authCookies.dontRememberToken` when `submittedRememberMe(ctx.body)` is true, the same step `deliverSessionCookie` performs.

### [Low] AUTH-7 — `verifyPasswordDetailed` throws on a malformed PHC string, breaking its own "unevaluatable → `valid:false`" contract

- **Where:** `lib/auth/password/hash.ts:138` (`argon2.verify` outside the `try` at `:119-136`); `parsePasswordHash` checks only the `$argon2id$` prefix.
- **Evidence:** the docblock at `hash.ts:101-110` promises that malformed hashes answer `valid:false`, because a thrown fault is an account-existence oracle. A stored value must pass `chk_password_hash_length` (≥ 50), so a malformed value has to be at least that long.
- **Reproduced (harness DB):** stored `$argon2id$garbage` padded to 50+ characters → sign-in 500 (`TypeError: Cannot destructure property 'm'…`). A valid hash with `m=abc` → 500 (`Error: Memory cost is too small`). A hash truncated by 12 characters → the normal 401. A wrong password on the malformed account also gets 500, while an unknown email gets 401, which is the oracle the docblock rules out. The throw rolls back the transaction, so the failed-attempt counter never increments and the lockout never engages for that account.
- **Failure scenario:** a corrupted stored hash makes `/sign-in/email` return 500 for that account, for any password (logged raw, see AUTH-1), instead of the wrong-password answer, and leaves it without lockout protection.
- **Remediation:** wrap `argon2.verify` in the same catch, log `auth.password.hash unevaluatable`, and return `{ valid: false, needsRehash: false, costPaid: true }`.

### [Low] AUTH-8 — `/passwordless/verify` stays allowlisted and published when passwordless is disabled

- **Where:** `lib/auth/allowed-paths.ts:85-122` (group `enabled: true`); the only gate is inside the handler at `lib/auth/passwordless.ts:82`.
- **Evidence:** every other feature-dependent Better Auth path (Google, each 2FA method) is gated by its allowlist group's `enabled`. With `OTP_ENABLED` or `PASSWORDLESS_ENABLED` off, this path still appears in OpenAPI, spends the pre-auth budget and runs `formCsrfMiddleware` before answering 404.
- **Remediation:** give it its own group with `enabled: OTP_ENABLED && PASSWORDLESS_ENABLED`. The disabled answer stays the same 404.

### [Low] REC-2 — The "this change strands your second factor" refusal comes only after the paid code is sent

- **Where:** `lib/users/contact-change.ts:139-173` (`authorizeContactChange`, the send-side gate) never calls `assertContactChangeKeepsFactor`. Its only callers are the commit path (`contact-change.ts:77`) and `lib/users/edit.ts:398`.
- **Evidence:** the docblock at `contact-change.ts:131-133` says this function holds "every refusal a contact change owes before its code is sent".
- **Failure scenario:** a user whose only factor is `otp:phone` asks to change phone. An SMS goes to the new number, verify answers 409 `contactChangeStrands`, and each retry repeats the paid send.
- **Reproduced (harness DB, email variant):** a user whose only factor is `otp:email` → `change-email` 200 `{otpSent:true}`, with 1 mail to the new address. Verify → 409 `contactChangeStrands`, email unchanged. Retrying the initiate → 200, and another mail was sent.
- **Reproduced (harness DB, phone variant, `NEXT_PUBLIC_ENABLED_OTP_CHANNELS=email,sms`, SMS provider stubbed at the egress boundary):** a user whose only factor is `otp:sms` → `change-phone` to `966500000002` → 200 `{otpSent:true}`, with SMS #1 to the new number. Verify with that code → 409 `contactChangeStrands`, phone and enrolment unchanged. An immediate retry → 429 (30 s resend delay). After 31 s → 200, SMS #2, verify → 409 again. A further retry → 200, SMS #3. Each retry is a paid SMS, paced only by the growing resend delay and the route's per-user limit.
- **Remediation:** also call `assertContactChangeKeepsFactor(db, userId, [kind])` in `authorizeContactChange`, keeping the commit-time check for races.

### [Low] REC-3 — Google sign-in failures in redirect mode can never be read back; the state cookie lives 300 s, not the 600 s the flow assumes

- **Where:** `lib/auth/oauth/plugin.ts:410-416` stores `{ success: false }`, but `oauthResultSchema` (`plugin.ts:110-113`) accepts only `success: true` or `twoFactorRedirect: true` (`bun -e`: `safeParse({success:false}).success === false`). `plugin.ts:57` sets `OAUTH_STATE_MAX_AGE_S = 600`, while `generateState` in better-auth 1.7.3 (`dist/state.mjs:72`, the `database` strategy that `create-context.mjs:137` selects when a database is configured) sets the signed state cookie with `maxAge: 300`.
- **Failure scenario:** every failed redirect-mode sign-in reaches `/oauth/result` as a 401 after both rows are consumed, instead of returning the stored failure envelope. This contradicts `plugin.ts:453-457`: "every envelope the callback can store has to be a branch of the union". A user who spends more than 5 minutes at Google (account chooser plus 2-step) fails `parseState` before `destination` is known, and lands on raw 401 JSON instead of their `callbackURL`.
- **Reproduced (harness DB):** a redirect-mode success → 302 to `callbackURL`, and `/oauth/result` → 200. A failure (`email_verified:false`) → 302 to `callbackURL` with stored value `{"success":false}`, then `/oauth/result` → 401, with both verification rows consumed (2 → 0). The start response sets `better-auth.state=…; Max-Age=300`, while the state and once-marker rows live 600 s. A callback without the state cookie → 401 invalid-credentials JSON (carrying a `Location: …/api/auth/error?error=state_mismatch` header but status 401), and no redirect to `callbackURL`.
- **Remediation:** add `z.looseObject({ success: z.literal(false) })` to the union, and set `OAUTH_STATE_MAX_AGE_S` to the cookie's 300 s.
- **Missing test:** no test drives `callbackURL` through `/oauth/result`.

### [Low] HTTP-2 — 5xx `CustomError`s are returned without a log line, and the image path discards the only trace of a library fault

- **Where:** `lib/http/response.ts:103-115` (`handleApiError` returns any `CustomError` unlogged; only other errors reach `logSanitized` at `:124`). Sites that throw a 5xx `CustomError`: `app/api/dash/users/handler.ts:214`, `app/api/dash/permissions/handler.ts:148`, `app/api/dash/users/me/preferences/handler.ts:73`, `app/api/dev/sign-up/handler.ts:46, 69`, `lib/media/folders.ts:370`, `lib/media/image/optimize.ts:57` (`toUploadError`, which drops the original `Bun.Image` error), `lib/media/image/optimize.ts:153` (which also sends an English internal message, `optimizeImage: <name> must be a positive finite number`, to the client).
- **Impact:** server-side invariant failures and library faults are invisible to monitoring. The client gets a 500 and the log shows only the access line.
- **Reproduced (harness DB):** a temporary `BEFORE INSERT … RETURN NULL` trigger on `folders` made `POST /api/dash/media/folders` throw `CustomError(updateError, 500)`. It answered 500, and the only console output (log, warn, error and info were all captured) was the access line. Non-`CustomError` 500s on the same run were logged with `errno`.
- **Remediation:** in `handleApiError`, log `{ status, errorClass, cause }` through `logSanitized` when `error.status >= 500`, leaving the response unchanged. Pass the original error as `cause` in `toUploadError`, and throw a plain `Error` for the programmer-error guard at `optimize.ts:153`.

### [Low] HTTP-3 — `Server-Timing` publishes precise server duration on the anonymous auth surfaces

- **Where:** `lib/http/response-policy.ts:58-59`, applied to every response via `app.ts:106-112`.
- **Evidence:** a probe returned `server-timing: app;dur=50.5` on an anonymous request. The anonymous OTP and reset routes rely on an unmeasured 1500 ms floor (see OTP-4), and Better Auth sign-in paths have no floor.
- **Impact:** removes network jitter from any residual enumeration timing signal, which makes OTP-4 and any unfloored auth path easier to measure.
- **Remediation:** omit `Server-Timing` outside development. The access log keeps `durationMs`.

### [Low] HTTP-4 — The access log drops the host guard's 404 and the declared-length 413, and logs the raw client path through `logLine`

- **Where:** `app.ts:241` (unroutable host → 404) and `app.ts:251-252` (declared `Content-Length` over the ceiling → 413) answer from `onRequest`, and Elysia 1.4.30 (`compose.mjs:1084-1085`) returns before `afterResponse` is scheduled. `lib/http/after-response.ts:46-68` passes `summary.path` to `logLine`, whose contract (`utils/log.ts:374-380`) reserves it for fields "this codebase chose itself".
- **Evidence:** #66 excuses OPTIONS because preflights "carry no application semantics". A refused upload and a tripped host guard do carry semantics, so they fall outside that entry.
- **Remediation:** log from `finish()` whenever `onRequest` short-circuits with a non-OPTIONS answer, and pass `path` through `clampLogString` (or log the matched route template).

### [Low] HTTP-5 — `cacheGet` returns `JSON.parse(...) as Value`, an unverified assertion the types rule forbids

- **Where:** `lib/cache/index.ts:98`.
- **Evidence:** `apps/back-end/CLAUDE.md` "Types": an unverified `as` on an assumed shape is the same as `any`. The file's SCAFFOLD note (`:12-16`) leaves validation undecided, and there are no callers yet.
- **Remediation:** before the first caller, take a schema (`cacheGet(key, schema)`) and return `null` when parsing fails.
- **Same class:** `scripts/smoke.ts` (`runChecks`) casts `await health.json()` to `{ status?: string; checks?: Record<string, boolean> }` and `await missing.json()` to `{ success?: boolean }`, then gates on `every(Boolean)`. Parse both bodies as `unknown` and check their shape.

### [Low] OPS-3 — The deployment checklist prescribes a start command that swallows SIGTERM

- **Where:** `reports/coolify-deployment.md:263` and `:1987` (`bun scripts/build-openapi.ts && bun run start`); `:1986` expects "Bun 1.4.0 in the build log", while the pin is `bun@1.4.2`.
- **Evidence:** the same document (`:1064-1076`) and the `Dockerfile` CMD comment say that starting through `bun run start` means SIGTERM never reaches `server.ts` (oven-sh/bun#41478). The Dockerfile correctly uses `exec bun --bun server.ts`.
- **Failure scenario:** an operator copies the checklist's start command into Coolify. Every stop and redeploy ends in SIGKILL after the grace period, and `lib/shutdown.ts` never drains.
- **Remediation:** change both lines to `bun scripts/build-openapi.ts && exec bun --bun server.ts` (or say to leave the start command empty so the image CMD applies), and correct the Bun version.

### [Low] OPS-4 — CI never type-checks the front-end consumer of `@app/shared`, and shared-only commits skip both consumers' pre-commit typechecks

- **Where:** `.github/workflows/ci.yml:51-59` (back-end `bun run lint` and `packages/shared`'s own lint; no front-end step); `lefthook.yml` pre-commit (`front-end typecheck` / `back-end typecheck` have `root:` set to their app, so a commit touching only `packages/shared/**` runs only `shared typecheck`).
- **Evidence:** root `CLAUDE.md`: "every consumer type-checks them with its own `tsconfig`". The front-end compiles shared under a different target and without `noUncheckedIndexedAccess` (`tsconfig.base.json` header).
- **Failure scenario:** a shared change that passes shared's and the back-end's `tsc` but breaks the front-end merges green. Only the local pre-push hook catches it, and `--no-verify` or a web edit skips that.
- **Remediation:** a CI step running the front-end's `tsc --noEmit`, and pre-commit consumer typecheck jobs that also trigger on staged `packages/shared/**`.

### [Low] OPS-5 — Outside production, a leftover `build/openapi.json` silently overrides the live route table

- **Where:** `lib/http/openapi/route.ts:57-78` (`resolveOpenApiDocument`: `if (prebuilt) return prebuilt;` regardless of `NODE_ENV`).
- **Evidence:** the docblock says the artefact is absent in development and test "where regenerating from the live table makes an edit visible". Any artefact left by one `bun run build` (one exists locally: `apps/back-end/build/openapi.json`, 2026-09-26) wins instead. It was generated with that build's configuration and without `/api/dev/*`.
- **Failure scenario:** after a build, the dev server's `/openapi.json` ignores later route and schema edits. `tests/integration/openapi-access.test.ts` serves the file instead of exercising generation under the tier's Google/2FA configuration.
- **Remediation:** read the artefact only when `production` is true, and generate otherwise.
- **Missing test:** development with an artefact present still generates. `tests/unit/openapi-contract.test.ts:348-365` covers only production-absent and dev-null.

### [Low] OPS-6 — The OpenAPI document publishes responses some routes cannot return

- **Where:** `lib/http/openapi/route-operations.ts` (`commonResponses` adds 422 to every path containing `:`). Unreachable at `GET /api/dash/media/files/:id` (`requireId(…, HTTP_STATUS.NOT_FOUND)`, `app/api/dash/media/files/[id]/handler.ts:32-36`), `POST /api/dash/users/:id/two-factor/reset` (same, `two-factor/handler.ts:38-42`; body `none`). On `POST /api/dash/auth/reauth`, schema failure is 401 (`reauth/handler.ts:31-34` passes `status: UNAUTHORIZED`), and the published 401 text ("No session, or the session row is no longer live") does not cover a wrong password. `lib/http/input.ts:50-54` documents that media and 2FA routes answer malformed ids with 404.
- **Impact:** generated clients carry dead 422 branches and misread the re-auth 401.
- **Remediation:** a per-route override table (like `BODYLESS_BAD_REQUEST_ROUTES`, already policed by `openApiConsistencyProblems`) for id-as-404 and overridden schema statuses, and a reworded re-auth 401 description.

### [Low] OPS-7 — CI, Renovate and tooling gaps around the pins and gates

- **Where / evidence:**
  - `renovate.json` groups only `@types/bun`/`bun-types`. Nothing ties `packageManager: bun@…` to the Dockerfile's `FROM oven/bun:1.4.2`, "the second home of the Bun pin". A split bump fails the image build (`require-bun.mjs`: older than required) or boots with a version warning.
  - `.github/workflows/ci.yml:97-102` runs `bun scripts/find-unused-files.ts`, then `bun run find:unused-files`, which runs the same script again before knip.
  - No job sets `timeout-minutes`, so a hung process or integration test holds a runner for the 360-minute default.
  - `scripts/check-schema-drift.ts` has no test for its "drift detected" path, although the script documents a Windows trap that reads as "no drift".
  - The production CMD's `bun scripts/build-openapi.ts` under `NODE_ENV=production` never runs in CI: the Build step runs as `development`, and the production-posture smoke starts `server.ts` directly.
  - `.dockerignore` lists prose to keep out of the image (`**/reports`, `**/docs`, `**/TODO.md`, `**/i18n-db.txt`), but not `apps/back-end/prompt-refactor.md` and `prompt-report.md`. The OPS-1 stage simulation shows both copied into `/app/apps/back-end`, and the runtime stage copies the same workspace.
- **Remediation:** a Renovate rule grouping `bun`, `oven/bun`, `@types/bun` and `bun-types`; delete the duplicate CI step; per-job `timeout-minutes`; a drift test on a `db/drizzle` copy with one migration removed (expect exit 1); run `build-openapi.ts` in the production-posture job.

### [Low] MEDIA-4 — Files of a known but disabled type download without their extension

- **Where:** `lib/media/files.ts:272-280` (`downloadFilename` → `fileTypeFor` → the upload allowlist `FILE_TYPES`), used by `downloadUrl` (`:302`) and the transition copy's `Content-Disposition` (`lib/media/visibility.ts:302`).
- **Evidence:** `DISABLED_FILE_TYPES` promises "rows that already carry one keep working". `fileTypeFor('application/msword')` is `undefined`, so a `.doc` renamed `report` downloads as `report`, breaking the documented "renamed `report` still downloads as `report.pdf`" rule for every type disabled after files of it exist.
- **Reproduced (harness DB):** a stored file with `mime_type='application/msword'` and `display_name='report'` got a `downloadUrl` with `attachment; filename="report"`, while a PDF control named `report2` got `filename="report2.pdf"`. Publishing it wrote the public copy with `Content-Disposition: attachment; filename="report"`.
- **Remediation:** look the extension up in `FILE_TYPE_TABLE`, as `lib/media/image/process.ts:211` already does.

### [Low] MEDIA-5 — Linking a file to a public purpose publishes it without the `publish` grant

- **Where:** `lib/media/link.ts:60-73, 158-173` (`promoteForLink` → `transitionFile(…, { authorizedByOwner: true, scope: 'all' })` for a caller holding only create/edit on the owner resource); `packages/shared/src/permissions/constants.ts` (`PERMISSION_ACTIONS.publish`: moving a file to the public bucket needs its own grant, checked with `forceDB` on the media routes).
- **Evidence:** `link.ts` calls this "publication by linkage, not an escalation". The permission's own definition says otherwise. The two documented contracts conflict.
- **Impact:** latent: `UPLOAD_PURPOSES` and `USAGE_SOURCES` are empty. It becomes live the first time a project declares a public purpose, and a user without `media.publish` can then make any private file public.
- **Remediation:** require `media.publish` (scope-checked) in `promoteForLink`, or state the exception in `PERMISSION_ACTIONS.publish` and the purpose declaration so the owner makes the choice consciously.

### [Low] DB-2 — Hand-written migrations in `db/migrations/` re-run on every deploy with no ledger or hash check

- **Where:** `scripts/migrate.ts:266-275` (`client.unsafe(statements)` for every file, every run; idempotency assumed at `:13-17`). Phase 1 refuses an edited journal entry (`assertLedgerPrefix`, `:169-174`), and phase 2 has no equivalent. The drift gate never reads these files.
- **Failure scenarios:** (1) editing `idx_users_name_trgm` in `001_add_trgm_indexes.sql` silently diverges, because existing databases skip it via `IF NOT EXISTS` while fresh ones get the new definition. (2) A later Drizzle migration dropping or renaming `roles.description` or `users.name` drops the dependent trigram index. The next run of 001 then fails with "column does not exist" on every deploy and fresh install, and `003` is tied to `sessions.metadata`, the `'media'` enum label and `scope='system'` in the same way. (3) Following the header's own advice (`CONCURRENTLY` in its own file), a failed concurrent build leaves an INVALID index that every later `IF NOT EXISTS` skips, so it is never rebuilt and never reported.
- **Reproduced (harness DB):** two re-runs of `scripts/migrate.ts` on a migrated database exited 0 (idempotent as written). After `ALTER TABLE roles DROP COLUMN description`, PostgreSQL silently dropped `idx_roles_description_trgm`, and the next run exited **1**: `applying 001_add_trgm_indexes.sql ... FAILED: column "description" does not exist`, with phase 1 passing.
- **Remediation:** a `(filename, sha256)` ledger for phase 2, applied once per file with the same prefix and hash refusal as phase 1, plus an `indisvalid` check after any `CONCURRENTLY` file.

### [Low] DB-3 — The audit redactor records every `Date` as `{}`

- **Where:** `lib/audit/index.ts:141-158` (`redactValue`: a `Date` has no own enumerable keys, so it becomes an empty object). Live site: `lib/auth/login-guard.ts:211` (`oldData: { lockedUntil: user.lockedUntil }`). The sibling at `login-guard.ts:255` works around it with `.toISOString()`.
- **Evidence:** reproduced on the harness DB. An expired lock cleared by a sign-in wrote `oldData: {"lockedUntil":{},"failedLoginAttempts":5}`, `newData: {"lockedUntil":null,"lockoutCleared":true,…}`.
- **Impact:** the lockout-cleared event loses the time the account was locked until, and any future `Date` in audit data is silently erased.
- **Remediation:** return `value.toISOString()` for `Date` in `redactValue` before the object branch.

### [Low] DB-4 — A lone UTF-16 surrogate in a media name answers 500, or is stored as a different name than the one validated

- **Where:** `packages/shared/src/validation/media.ts` (`FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cf}/\\]/u`, no `\p{Cs}`; user and role names are safe because `sanitizeStrict` strips surrogates); audit of raw input at `lib/media/folders.ts:376`; `lib/http/response.ts:117` maps 22021 but not 22P02. Latent second site: `lib/audit/index.ts:105` slices JSON text by code unit.
- **Evidence:** `displayNameSchema` and `folderNameSchema` accept `'abc\uD83D'`. The `varchar` stored `616263efbfbd` (`abc` + U+FFFD), and the `jsonb` audit insert failed with `22P02 invalid input syntax for type json` (rolled-back transaction).
- **Failure scenario:** creating a folder named `"a\ud83d"` rolls back with 500. Renaming a file or folder stores `a�`, so two distinct inputs can collide on `ux_folders_*`.
- **Reproduced (harness DB):** folder create `"a\ud83d"` → 500 (`22P02`, no row). Folder rename to `"b\ud83d"` → 200, stored `62efbfbd`. With `"c�"` present, renaming another folder to `"c\ud83d"` → 409 "a folder with this name exists". File rename to `"d\ud83d"` → 200, stored `64efbfbd`.
- **Remediation:** add `\p{Cs}` to `FORBIDDEN_NAME_CHARACTERS` (or reject `!isWellFormed()`), and slice the audit preview by code point.

### [Low] CONS-1 — Existing helpers and constants are reimplemented inline

- **Where / evidence (each copy can drift from its source):**
  - The Turnstile secret choice (always-pass key + `NODE_ENV === 'development'` switch) is written in both `lib/auth/index.ts:111-114` and `lib/captcha.ts:16, 31-33`.
  - Password NFKC normalisation exists in `lib/auth/password/hash.ts:42-44` and `packages/shared/src/validation/rules.ts` (`normalizePasswordInput`). The shared docblock requires both to see the same form, or policy/HIBP checks and the stored hash split.
  - `app/api/dash/auth/reauth/handler.ts:23-28` inlines `enforceReauthAttemptLimit` (`lib/auth/reauth/session.ts:24-31`, same scope, identifier and limit) on a shared budget.
  - `lib/http/request.ts:118-122` (`mediaTypeEssence`) repeats `normalizeMimeType` (`packages/shared/src/validation/media-types.ts:73-76`).
  - `lib/permissions/roles.ts:135` hard-codes `` `custom-${…}` ``, while `chk_custom_prefix_scope` (`db/schema.ts:903`) and `assertStandardRoleName` derive the prefix from `CUSTOM_ROLE_VALUE`. Changing the constant makes every custom-role insert fail the CHECK.
  - `handleFolderForeignKeyViolation` (`lib/http/constraint-errors.ts:139-146`) maps any FK violation to "folder not found", unlike its sibling `handleUserForeignKeyViolation` (`:94-113`), which checks the constraint name.
- **Reference:** `apps/back-end/CLAUDE.md` "Consistency": reimplementing inline what a helper provides is a defect even when it works.
- **Remediation:** export one Turnstile secret resolver from `lib/captcha.ts`; import `normalizePasswordInput` in `hash.ts`; call `enforceReauthAttemptLimit`; use `normalizeMimeType`; derive the role prefix from `CUSTOM_ROLE_VALUE`; match the folder FK constraint by name.

### [Low] CONS-2 — Divergent idioms where the codebase has one dominant form

- **Where / evidence:**
  - `lib/media/image/process.ts:140` is the only `console.error` in `lib/` (113 `logSanitized`/`logLine` calls elsewhere). It logs every user-caused SVG refusal as unstructured error-level text.
  - `lib/auth/oauth/plugin.ts:34` imports `readEnrolmentState as readEnrollmentState`, the only file using the alias.
  - `scripts/migrate.ts` imports `../lib/…` and `../utils/text`, while its sibling scripts use `@/…`.
  - `lib/auth/two-factor/trusted-device.ts:95-96` says `@better-auth/utils/hmac` is avoided as an undeclared transitive dependency, while `totp-replay.ts:25`, `enrolment.ts:35` and `passkey-assertion.ts:12-15` import undeclared `@better-auth/utils/otp` and `@simplewebauthn/server`, which root `CLAUDE.md` accepts under the hoisted linker.
- **Remediation:** `logSanitized` with a stable `msg` at `warn` for client-caused refusals; drop the alias; `@/` imports in `migrate.ts`; pick one rule for hoisted-only imports and fix the stale rationale.

### [Low] CMT-1 — Comments that state false facts about the code

- **Where / evidence:**
  - `db/index.ts:6` claims "`SET LOCAL` throughout this codebase"; no `SET LOCAL` exists (grep over `lib`, `db`, `app`, `scripts`).
  - `packages/shared/src/config.ts:49` names a `chk_phone_required` constraint that does not exist.
  - `lib/users/edit.ts:310`: "an unchanged matrix is not rewritten, which would reset `created_at`". `writeRoleMatrix`'s upsert-and-prune preserves `created_at` (`lib/permissions/roles.ts:68-72, 122-125`).
  - `lib/auth/recovery/grant.ts:23-24` describes a method-set "fingerprint" that does not exist; the code narrows options instead (`:163-184`).
  - `server.ts:113` "the kernel may choose it": `lib/startup.ts:74-92` refuses port `0`.
  - `lib/http/openapi/route-tables.ts` (`QUERY_VALIDATION_ROUTES`): "`recursive` is either `true` or absent". The handler also accepts `''` and `'false'`, and `routes.ts` publishes `enum: ['true','false']`.
  - `lib/auth/two-factor/backup-codes.ts:63-73` (see 2FA-4), `lib/auth/oauth/plugin.ts:453-457` (see REC-3) and `lib/users/contact-change.ts:131-133` (see REC-2) are contradicted by the code.
  - `db/migrations/002_media_trgm_indexes.sql:1-9` narrates the history of a superseded index and drops `idx_files_display_name_trgm`, which no migration in this repository creates.
- **Reference:** `apps/back-end/CLAUDE.md` "Comments" (no change history; a comment must say what the code cannot).
- **Remediation:** delete or correct each. The three tied to other findings are fixed with them.

### [Low] CMT-2 — Paragraph-length comments conflict with CLAUDE.md's comment standard across the auth and media modules

- **Where (samples of a pervasive pattern):** `lib/auth/two-factor/plugin.ts:133-153, 314-327`, `totp-replay.ts:33-46`, `enrolment.ts:5-19`, `issue.ts:161-173`, `lib/auth/recovery/grant.ts:1-33`, `app/api/auth/forgot-password/reset/handler.ts:50-68`, `lib/media/visibility.ts:120-151, 207-232`, `lib/media/lifecycle.ts:115-139`, `lib/media/upload.ts:104-113, 406-417`. About 25–30% of the lines in `lifecycle.ts`, `visibility.ts` and `upload.ts` are comments.
- **Evidence:** `apps/back-end/CLAUDE.md`: "Length scales with the cost of ignoring it. A trap gets a clause; nothing gets a paragraph." Many of these blocks restate the flow the code already shows alongside the one trap worth keeping.
- **Impact:** maintainability. This is a documented conflict between the standard and the existing code, not a behaviour defect.
- **Remediation:** when a module is next touched, cut each block to the non-local constraint or trap it guards.

### [Low] DEAD-1 — Configuration and branches nothing can reach

- **Where / evidence:**
  - `app.ts:146-151` advertises `Authorization` and `X-Maintenance-Token` in CORS `allowedHeaders`. No bearer or API-key auth exists, and only the container probe (not a browser on `PUBLIC_ORIGIN`) sends the maintenance token (`app/api/health/storage/handler.ts:60`).
  - `lib/media/image/process.ts:202-212` is a branch its own comment calls "Unreachable".
  - `lib/media/image/optimize.ts:373-375` excludes `image/gif`, which is not in the type table.
- **Remediation:** remove them. Nothing that works today changes.
