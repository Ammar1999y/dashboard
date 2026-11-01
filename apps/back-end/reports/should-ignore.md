# Not Real Issues / Ignored

<!-- 1: removed, fixed: `validateAssignableRole` reads the role `FOR SHARE` inside the caller's transaction (`lib/permissions/roles.ts`), and both callers repeat it there. The entries after it keep their numbers. -->

2. **JSONB Permissions No DB-Level Shape Constraint** — `db/schema.ts` — The
   `permissions` JSONB column accepts any valid JSON; direct DB writes can
   insert malformed data
3. **Session Token Stored Plaintext** — `db/schema.ts`

<!-- 4: removed, fixed: `db/drizzle/0009_sudden_human_cannonball.sql` drops the column and the `file_context_table` type. -->

5. **Only First Zod Error Returned** — All POST/PUT handlers

<!-- 6: removed, fixed: `auditFields` no longer exists. -->

7. **No API Versioning** — All endpoints at `/api/dash/*` with no version prefix
8. **No Anonymous Health Check Endpoint** — the only health route,
   `GET /api/health/storage` (`modules/health/storage.ts`), is a token-gated
   readiness check; there is no anonymous liveness route
9. **User GET Exposes Role Permissions Without `permissions:view`**
10. **Multi-Tenant Boundary Not Present** — Conditional, depends on future
    requirements
11. **Dont add any new checks for user email & password in the schema**
12. **An Empty Permissions List Cannot Clear a Role** — By design; frontend
    sends all permissions as `false`. An empty `permissions` array is still a 422. A PUT naming one page with no actions upserts that page and prunes
    every other one, which leaves the role with no grants
    (`modules/permissions/item.ts`, `writeRoleMatrix` in
    `lib/permissions/roles.ts`)
13. **Permissions UPDATE Refuses an Empty Permissions Array** — see #12

<!-- 14: removed, fixed: `emailSchema` lowercases, `chk_email_lowercase` enforces it, and the email lookup passes the parsed value (`lib/auth/path-policy.ts`). -->

15. **roleName Uniqueness Is Case-Sensitive**
16. **TOCTOU: Permission Scope Validation Outside Transaction (POST Handlers)**
    — Low probability; no real harm
17. **Missing DB-Level Minimum Length Constraints on Text Columns**
18. **Search Input Over 200 Characters Silently Discarded** —
    `effectiveSearchTerm` (`packages/shared/src/data-table/parsers.ts`), applied
    in `lib/data-table/params.ts` — a term is discarded rather than truncated
    or refused; the same happens below 3 characters and to a term the trigram
    index cannot key on. Both bounds are measured on the folded term

<!-- 19: removed, fixed: a custom role with missing or empty permissions is a 422 at `bind()` (`refineUserPayload`, `packages/shared/src/validation/users.ts`). -->

20. **Role List User Count Grows With the Roles' Members** —
    `modules/permissions/collection.ts` — a correlated count per listed role,
    on `idx_users_role_id`. Not re-measured since that index replaced the
    partial `idx_users_role_active` (migrations 016–017)
21. **Role Reactivation Bypasses `delete` Permission Gate** —
    `modules/permissions/item.ts` (`updatePermissionBinding`)
22. **`ROLE_NAME_MIN = 1` Is Extremely Permissive** —
    `packages/shared/src/validation/constants.ts`
23. **`USER_UNIQUE_CONSTRAINTS` maps both user unique constraints** —
    `lib/http/constraint-errors.ts` — the earlier note called `ux_users_phone_number`
    nonexistent; it does exist (`db/schema.ts`, a partial unique index on
    `phone_number WHERE deleted_at IS NULL AND phone_number IS NOT NULL`), so
    the mapping is live and correct, not dead code. Kept as a record that the
    question was asked and settled.
24. **`chk_size_bytes_positive` Allows Zero-Byte Files** — `db/schema.ts`

<!-- 25: removed, fixed: both callers pass the gate's actor, so `checkMultiplePermissions` (`lib/permissions/checker.ts`) adds no statement. -->

26. **Dynamic Configuration Coupling in Schema** — `db/schema.ts` —
    `chk_active_user_has_role` tied to runtime flag
27. **`standardRoleFilter` Duplicated in Raw SQL** —
    `modules/permissions/item.ts` (the role delete's raw `DELETE`)
28. **`sessions.metadata` Has No DB-Level Type Constraint** — `db/schema.ts`
29. **`count(*)` Bottleneck in Paginated Endpoints** — At scale only
30. **Hardcoded Provider String in Schema Constraint** — `db/schema.ts` — Uses
    `'credential'` instead of `CREDENTIAL_PROVIDER_ID`
31. **Custom Role Deletion Without Exclusivity Check** —
    `lib/users/delete.ts` (`softDeleteUser`, through `destroyCustomRole` in
    `lib/permissions/roles.ts`)
32. **`chk_active_user_has_role` Enforces Stronger Invariant Than Documented** —
    `db/schema.ts`
33. **`users.edit` Can Suspend/Reactivate Accounts Without `users.delete`** —
    `modules/users/item.ts` (`updateUserBinding`), `editUserAsAdmin` in
    `lib/users/edit.ts`
34. **`REQUIRE_ROLE_FOR_LOGIN` Flag Creates Silent Behavior Divergence** —
    Controls 4 behaviors with no documentation
35. **GIN Indexes Built Without `CONCURRENTLY`** —
    `db/migrations/001_add_trgm_indexes.sql`
36. **Roles Dropdown Has Silent 1000-Row Ceiling**
37. **Missing Table Partitioning on `sessions` and `audit_logs`**
38. **Audit Logs Missing `created_at` Index**
39. **List Endpoints Skip the Role-Matrix Reachability Check** —
    `modules/users/collection.ts`, `modules/permissions/collection.ts` — both
    lists apply the `viewOwn` filter (`createdBy` is the caller when their
    scope is `own`) and leave out system roles and their users. What they
    skip is the reachability check the writes run
    (`validateRolePermissionScope(…, 'reachability')`,
    `lib/permissions/scope.ts`), so a list can show a user or role whose grants
    exceed the caller's own matrix
40. **`editUserAsAdmin` Inner Join Hides Roleless Users** —
    `lib/users/edit.ts` — Not a real issue;
    roleless users are not dashboard users
41. **Schema Does Not Enforce Custom Role Ownership** — Not a real issue; custom
    roles are inherently per-user
42. **Final Administrator Lockout** — `modules/users/item.ts`,
    `assertTargetUserVisible` in `lib/users/target-user.ts` —
    Dashboard owner has `system` role with full access; system role cannot be
    deleted
43. **OFFSET Pagination Bottleneck** — `modules/users/collection.ts`,
    `modules/permissions/collection.ts` — Acceptable at current scale
44. **Repeated `validateRolePermissionScope` Calls** —
    `lib/users/edit.ts` (`editUserAsAdmin`) — every edit checks reachability of
    the target's current role; the grant check on the new role runs only when
    a different standard role is assigned; a password change adds one more
    reachability check before the transaction (`assertTargetEditable`), so a
    refused request never reaches the breached-password lookup or the hash.
    Up to three role-matrix reads per admin edit; merging them is unnecessary
    optimization complexity

<!-- 45: removed, no longer true: `argon2` 0.45 hashes on a native async worker; an event-loop probe across a 70 ms hash saw every tick. -->

46. **`pageName` PostgreSQL Enum Blocks Schema Evolution** — `db/schema.ts` —
    Acceptable trade-off for current page set
47. **GDPR Email in Audit Logs** — `lib/users/delete.ts` (`softDeleteUser`) — Email in
    `audit_logs.old_data` needed for investigation; not applicable yet
48. **FK Violation Handler Falls Through to 500** —
    `lib/http/constraint-errors.ts` — the expected ones are mapped: the role FK
    to 400 `roleNotFound` (`handleUserForeignKeyViolation`) and the folder FK to
    folder-not-found (`handleFolderForeignKeyViolation`). Any other FK
    violation is still a 500, which is correct; unexpected FK violations are
    code bugs that should be prioritized in monitoring
49. **Destructive Soft-Delete Prevents Recovery** —
    `lib/users/delete.ts` (`softDeleteUser`) — Email preserved in
    `audit_logs.old_data`; practical emails < 100 chars; `accounts` hard-delete
    is a security feature
50. **Session Revocation UUID Validation Gate** —
    `modules/users/sessions.ts` (`revokeUserSessionsBinding`), `deleteSessionsSchema`
    in `packages/shared/src/validation/sessions.ts` — Session ID type is fixed throughout the
    app; `validID` maintained to support current and future formats

<!-- 51: removed, fixed: `PUT /users/:id` refuses the caller's own id (`notSelf`, `modules/users/item.ts`), self-update takes only `name`, and `changePassword` revokes other sessions and pending proofs (`modules/users/me.ts`). -->

52. **HIBP check fails open silently** — `lib/auth/password/compromise.ts` —
    `checkPasswordCompromise` makes up to 3 attempts, logs `hibp.degraded` on
    every failed one, and on exhaustion ACCEPTS the password. Deliberate and documented in the
    function's own comment: a third party being down must not take account
    creation, password reset and credential rotation down with it, and a
    breached password that slips through is still subject to the length floor,
    argon2id + pepper, lockout and the per-IP limits. Alert on `hibp.degraded`.
    The timeout half of this entry is obsolete: each attempt now carries an
    `AbortController` with `HIBP_ATTEMPT_TIMEOUT_MS = 1000` plus 75/150 ms
    backoff, so the worst case is ~3.2 s, not the 10–30 s stall recorded here.

<!-- 53: removed, fixed: Better Auth's `verify` calls `consumePasswordProof` (`lib/auth/index.ts`, `lib/auth/password/proof.ts`): single use, expiring, bound to the hash, failing closed. -->

<!-- 54: removed, fixed: change-password compares and swaps on the expected hash under the account lock (`modules/users/me.ts`); change-email is a two-step OTP flow whose commit locks the user (`lib/users/contact-change.ts`). -->

55. **`audit_logs` Missing `user_id` Index** — `db/schema.ts` — "All actions by
    user X" forensic query full-scans the table; slow only at 1M+ rows.
56. **Phone-number CHECK Regex Hardcodes Saudi Format** — `db/schema.ts` —
    `chk_phone_number_format` enforces `^9665[0-9]{8}$`; future international /
    non-mobile support would require a migration. Acceptable for current local
    launch (does not contradict #11, which is about email/password checks).

<!-- 57: deleted at the owner's request; the entries after it keep their numbers. -->

58. **OTP Send Collapses 429 to Generic 200 (by design)** —
    `lib/otp/anonymous-send.ts` (`sendAnonymousOtp`, shared by every anonymous
    send) — masking `TOO_MANY_REQUESTS` is a deliberate privacy contract: the
    endpoint returns an identical `200 + nextAllowedIn:30` for every case after
    the account lookup (real / fake / verified / throttled) so timing and
    status leak nothing. The limits checked BEFORE the lookup — the per-IP
    limit and the per-destination quota — do answer 429, identically for real
    and unknown addresses, so they reveal nothing either. The client already
    gets a constant `nextAllowedIn` for its countdown. Surfacing the hidden 429
    would break this contract — not worth the UX gain.
59. **Explicit Empty Filter Array Treated As "No Filter"** —
    `lib/data-table/filter-columns.ts` — chosen UI semantics, not a SQL
    identity: `col IN ()` matches nothing, so this is a deliberate reading of an
    empty selection as "chip not filled in yet" rather than "match nothing". The
    literal reading shows an empty table for a chip the user has not used, and a
    422 turns it into an error. Not the dropped-predicate case the strict filter
    contract exists for — there a real condition vanished; here none was
    expressed, and the caller's base authorization predicate is untouched either
    way.
60. **Filter `variant` Not Bound To The Column Descriptor** —
    `lib/data-table/column-specs.ts` — `variant` describes how the client
    renders a control; it is validated for membership then never read, so it
    reaches no SQL. Binding it would make the server an authority on UI
    rendering, and a boolean column rendered as a multiSelect is legitimate.
61. **`OTP_AUTO_VERIFY` Has No Environment Guard** —
    `packages/shared/src/config.ts` — a code constant, `false` today, not an
    environment value; turning it on is a code change and a deploy. A
    development bypass for a deployment with no OTP provider. Never reaches
    `passwordless_login` / `forgot_password` (both always issue a real code), so
    the blast radius is contact-verification and the authenticated
    contact-change commits.
62. **Session Pagination Has No Matching Index** — `db/schema.ts`,
    `lib/users/session-page.ts`, `modules/users/sessions.ts` — the
    `(createdAt, id)` keyset cursor is correct; only the index shape is
    questioned. More than 50 live sessions per user is unrealistic for an admin
    dashboard, and the `database-retention-sweep` already deletes sessions 30
    days past expiry (`lib/maintenance/database.ts`). Add
    `(user_id, created_at, id)` only if a real query plan justifies it.
63. **Trusted IP Header Is Not Yet Pinned To The Deployment** —
    `lib/http/client-ip.ts`, `lib/rate-limit/index.ts` — `TRUSTED_IP_HEADERS`
    is `cf-connecting-ip` alone, so the Vercel half of this entry is gone.
    Development falls back to `127.0.0.1` when the header is absent;
    production still answers 503 on every IP-protected route, which is
    intended and diagnosable (it keeps its own status and message, and the
    missing headers are logged). What remains is that the header is trusted on
    syntax alone: nothing checks the socket peer is the edge. Settled by
    enforcing the ingress boundary for the target deployment. Already flagged
    by the `TODO(proxy-trust)` above every such site; belongs on the
    pre-production checklist.
64. **Custom IPv6 `/64` Bucketing in `ipBucket`** —
    `lib/rate-limit/index.ts` — manual `::` expansion; verified correct for
    all valid inputs and `getClientIp` blocks malformed ones upstream. The only
    proposed remedy adds the `ip-address` dependency — supply-chain/maintenance
    risk with no real defect fixed. Leave as-is.

65. **`ipIdentifier`'s Failure Log Emits Present, IP-Bearing Headers** —
    `lib/rate-limit/index.ts` — When `cf-connecting-ip` is absent or fails
    `IP_SCHEMA`, the 503 carries the VALUES of `x-forwarded-for`, `host`,
    `user-agent` and the invalid `cf-connecting-ip` as its `cause`, which the
    error log writes (`utils/log.ts`); in exactly that case `x-forwarded-for`
    is the header most likely to carry the real client address. The one-line alternative is to log
    the header NAMES that were absent instead of their values. Not applied: the
    logs are internal, the branch is unreachable in production
    (`cf-connecting-ip` is always injected by the edge), and the diagnostic
    value of seeing what the proxy actually sent is worth more here than the
    theoretical exposure. Revisit if logs ever leave the host — the same trigger
    as #8.

66. **OPTIONS Requests Produce No Access-Log Line** — `app.ts`,
    `server/elysia/respond.ts` — an unknown path's preflight is answered in
    the `onRequest` hook in `app.ts` and a known path's by `@elysia/cors`; both
    are marked as preflights and skipped by the access log, so preflight volume
    and OPTIONS-based path scanning are invisible in the log.
    An observability gap, not a correctness defect: nothing is mis-handled.
    No application limiter counts that scanning: a preflight is answered before
    the gate and reaches no rate limit, and the gate charges the pre-auth IP
    limit on a signed-in route only when the request carries a session-token
    cookie (`lib/http/admit.ts`), so a cookie-less request to one is not
    counted either. Both are cheap: a preflight is a route lookup, and a
    cookie-less signed-in request is refused before any database read.
    Path-prefix tricks still meet the hostname floor in `app.ts`. Adding a log
    call to a hook that runs before every request — including every preflight —
    to record requests that carry no application semantics is not a trade worth
    making at this size.

67. **Benchmark Dependencies (`uuid`, `sharp`) Removed from Root Manifest** —
    `knip.jsonc` — Benchmark-only comparison packages were removed to avoid
    root dependency bloat, and the `bench/uuid/` and `bench/image/` harnesses
    are gone too. Key decision measurements are already recorded; if
    benchmarks need to be re-run, the harness and its dependencies can be
    recreated on demand and removed.

68. **Sign-In Racing a Deactivation Keeps Read Access** —
    `lib/auth/session/hooks.ts` (`session.create.before`),
    `modules/permissions/item.ts` (role deactivation) — a sign-in whose
    eligibility read lands a millisecond before an admin deactivates the user
    or role leaves a session the deactivation missed, and the cookie cache keeps
    serving reads from it. Rare and almost impossible to hit, and the user
    already held that read access, so keeping it longer costs nothing real.
    Writes are still refused. (Audit opus-5.5 #10.)

69. **A Passkey Deleted Mid-Sign-In Still Completes the Second Factor** —
    `lib/auth/two-factor/passkey.ts` — an assertion in flight while the owner
    deletes that passkey can still mint a session. A millisecond race, and it
    gains nothing: a sign-in a moment earlier yields the same session, and
    deleting a passkey never revoked existing sessions. (Audit opus-5.5 #12.)

70. **User Detail Shows Session IPs for Up to 5 Minutes After `users.edit` Is
    Removed** — `modules/users/item.ts` (`getUser`) — the detail route reads
    grants from the cookie cache, so an admin who just lost `users.edit` keeps
    seeing other users' session IPs and user agents until the cache expires.
    They already had that view; another few minutes of it is no real exposure.
    Same reasoning as Known #5. (Audit opus-5.5 #13.)

71. **Two Correct Second Factors Racing Can Make a "Don't Remember Me" Session
    Persistent** — `lib/auth/two-factor/challenge.ts` (`invalidateChallenge`)
    — the losing request of two simultaneous correct completions clears the
    winner's `dont_remember` marker. Rare, and it only lengthens the
    legitimate owner's own session. (Audit opus-5.5 #16.)

72. **Sign-Out Can Deadlock With an Admin 2FA Reset of the Same User** —
    `lib/auth/path-policy.ts` (`revokeSignedOutSession`),
    `modules/users/two-factor.ts` — the two delete session rows and their
    artifacts in opposite orders. Needs both at the same millisecond; one side
    gets a retryable 503 and nothing is gained or lost. (Audit opus-5.5 #36.)

73. **The SQLite Cache Module Has No Production Caller** — `lib/cache/`,
    `cache.db` — a deliberate scaffold, kept for later use: `cacheGet` and
    `cacheSet` are reached only from tests, and the store is closed at shutdown
    without being opened. Owner decision; audits do not report it as unused.
    (Audit opus-5.5 #78.)

74. **Narrowing the Email-Provider List Later Would Lock Existing Users Out** —
    `emailSchema` (`packages/shared/src/validation/rules.ts`) — removing a
    provider would answer that provider's existing users 422 on sign-in,
    recovery and Google sign-in before any credential check. The provider
    allowlist on `emailSchema` stays as it is. Owner decision: never raise this
    again. (Audit opus-5.5 #106.)

75. **No Index on `verifications.value`** — `lib/auth/session/rotation.ts`
    — credential rotation deletes a user's verification rows by `value` with a
    sequential scan. Measured: a hash index (a btree is unsafe on the passkey
    ceremony values) saves about 1 ms per rotation at realistic table sizes,
    and its cost on the sign-in insert path could not be measured. Rotations
    are rare, and `verification-expiry-sweep` clears expired rows every 15
    minutes.
    (Audit opus-5.5 #99.)

76. **The Forgot-Password Bindings Keep the Pre-Auth IP Write** — the
    `forgot-password/send`, `reset`, `second-factor/send` and `complete`
    bindings — each request writes the pre-auth counter before its own limiter
    although the route makes no session lookup. Kept: their shared
    `preauth.auth.forgot-password` cap (120/min) binds below the sum of their
    own limits (180/min), so it is the combined per-IP bound on the flow.
    `passwordless/send` shares that scope with no sibling and dropped it
    (`preAuthIpLimit: false`). They are public routes, so they kept the charge
    when the gate stopped charging requests to signed-in routes that carry no
    session-token cookie (performance audit P-16). (Audit opus-5.5 #94.)

77. **A Password Sign-In Racing a Credential Rotation Can Still Get a
    Session** — `/sign-in/email`, `twoFactorSignInGuard`
    (`lib/auth/two-factor/plugin.ts`) — Better Auth inserts the session after
    the password check and outside any user lock, so a sign-in that verified
    the old password milliseconds before a rotation can create a session after
    the rotation revoked every existing one. Owner decision: never fix, never
    report again. Nothing is lost (no data, money or uptime), the user already
    had access, and the fix (a check of `users.auth_revoked_at` under the user
    lock after Better Auth's insert) only adds complexity. Every other path is
    covered: each rotation stamps `users.auth_revoked_at` and deletes pending
    OTP proofs and two-factor challenge state under the user lock
    (`revokePendingProofs`, `lib/auth/session/rotation.ts`); passwordless and
    Google sign-in, recovery grants and reauthentication refuse a proof that
    started before that stamp (`rotatedSince`, and the same comparison in
    `lib/auth/oauth/identity.ts`); the OTP send locks the user row
    first (`lib/otp/send.ts`); and the reset without 2FA consumes its proof and
    writes the password in one transaction under that lock
    (`modules/auth/recovery.ts`). `assertLiveSession`
    (`lib/auth/session/live.ts`) runs before a mutation's transaction, so it
    does not close this race either. (Audit opus-5.5 #11; formerly Known #1.)

78. **A Junk `session_data` Cookie Makes Reads Use the Stored Permission
    Snapshot** — `hasSessionCookieCache` (`lib/auth/session/read.ts`),
    `resolveGrants` (`lib/permissions/checker.ts`) — reads skip `liveGrants`
    whenever a cookie NAMED like the cache is present, whatever its value, and
    `getSession` then re-mints a valid cache from the session row. Measured
    (performance audit C-5, 2026-10-16): after a role or a user was
    deactivated directly in the database, `session_data=garbage`, a valid `.0`
    chunk name carrying a malformed value, or an expired cache answered reads
    200, repeatedly. Reachable
    only through an out-of-band database edit: the application's own role and
    user deactivations delete the sessions. Owner decision: the session and
    permission cache stays, and an out-of-band database edit is not a code
    defect. Writes still check the database. The in-app race that can leave a
    stale snapshot is Known #15.

79. **CodeQL, Snyk Code and SonarQube Are Not Run** —
    `.github/workflows/security.yml` — excluded on purpose when the scanners
    were chosen; do not re-propose them. CodeQL is free only for public
    repositories (a private one needs GitHub Code Security, paid per active
    committer), and its deep interprocedural taint analysis is more than a
    codebase this size needs. Snyk Code and SonarQube overlap Semgrep OSS and
    the ESLint security plugins without adding a distinct signal at this size.
    What runs instead: Semgrep OSS and gitleaks (`security.yml`), `bun audit`
    (the `audit` job in `.github/workflows/ci.yml`) and Renovate's
    vulnerability alerts.

<!-- 80–88 come from the performance audit (2026-10-16, retired 2026-10-31) and its re-measurement on 2026-10-31. Every figure is from the Windows development machine under load from other sessions: read timings as relative, not as deployment expectations. Nothing was measured on the VPS. -->

80. **A SQLite WAL Checkpoint Stalls One Limiter Commit Every Few Hundred
    Requests** — `lib/sqlite/database.ts` (`synchronous = NORMAL`),
    `lib/rate-limit/store.ts` — SQLite runs the auto-checkpoint inside the
    commit that pushes the WAL past `wal_autocheckpoint` pages, synchronously
    on the event loop: tens of milliseconds (p99.9 14–30 ms) once per
    650–1 000 admissions, which at two admissions per dashboard request is
    every 300–500 requests (Windows dev box; the procedure to measure it on
    the VPS is in `reports/coolify-deployment.md` §10). Owner
    decision: keep `synchronous = NORMAL`. `OFF` removes the stall, but a power
    loss can then corrupt `rate-limit.db`, which holds the OTP spend cap, and
    the fail-closed limiter answers 503 on auth routes until the file is
    deleted. A background checkpoint worker was measured and rejected: under
    sustained writes a passive checkpoint never catches up, so the WAL grows
    without bound exactly under load. The related defect is fixed: the driver's
    `get` runs a statement to completion (`lib/sqlite/driver.ts`); before that,
    admissions never checkpointed, the WAL grew without limit and the next
    statement to finish paid for the backlog (1.4 s measured). Guarded by
    `tests/unit/rate-limit-wal-frames.test.ts`. (Performance audit P-1.)

81. **One Image Encoder Slot per Process** — `lib/admission.ts`,
    `ENCODER_SLOTS` in `lib/media/image/optimize.ts` — one encode at a time.
    Uploads reach it through the process-wide upload slot (`UPLOAD_SLOTS` in
    `lib/media/upload.ts`: four in flight, eight waiting up to 10 s, two per
    account), so a thirteenth concurrent upload gets the busy 503. The front
    end uploads two files at a time per tab
    (`apps/front-end/lib/media/upload-queue.ts`). A second slot doubles throughput and costs about
    240 MiB more peak memory at the 25 MP pixel cap (measured 239 MiB with one
    slot, 477 MiB with two). Kept at one; `ENCODER_SLOTS` is the one place to
    change it, after measuring RSS on the VPS (`reports/coolify-deployment.md`
    §5, "Capacity floor for uploads"). Cores bound it too (measured
    2026-11-01): an encode holds one thread of Bun's work pool, which has one
    per core and also runs Argon2 and every session-cookie HMAC, so encoder
    slots plus the one password slot must stay below the core count.
    (Performance audit P-4.)

82. **A Refused SVG Still Costs a Full Sanitise** — `admitUpload`
    (`lib/media/upload.ts`), `lib/media/image/svg-jobs.ts` — the SVG is
    sanitised before the image budget is charged, so one the budget then
    refuses has still cost about 0.4–0.5 s on the single SVG worker, and other
    users' SVG uploads can meet the busy 503 meanwhile; other routes are
    unaffected. Accepted: the upload request limit (`UPLOAD_ADMISSION`,
    `modules/media/limits.ts`, 20 a minute per account, charged before the
    body is read) already caps refused sanitises at 20 a minute per account.
    The worker also kept about 75 MiB after its first job (measured
    2026-10-16); stopping it when idle would trade that for a 3 s cold start.
    (Performance audit P-5.)

83. **2FA Step 1 Creates a Session, Then Withdraws It** —
    `twoFactorSignInGuard` (`lib/auth/two-factor/plugin.ts`),
    `lib/auth/two-factor/issue.ts`, the same shape in `lib/auth/passwordless.ts`
    — when a second factor is due, the session Better Auth inserted after the
    first factor is deleted again: about five statements, a session cookie set
    and cleared, and a `loginSuccess` audit row for a session nobody receives.
    Owner decision: keep the flow. Issuing the challenge before the session
    would answer `EMAIL_NOT_VERIFIED` after the second factor instead of after
    the password, which changes the contract. Accepted with it: the throwaway
    session counts toward `MAX_SESSIONS_PER_USER` (`lib/auth/session/cap.ts`,
    expired rows included), which `session.create.after`
    (`lib/auth/session/hooks.ts`) enforces on insert. So someone holding the
    password but not the second factor, against a victim already at the cap,
    evicts one of the victim's sessions per step-1 attempt, up to k with k
    attempts in flight; expired rows go first. Nothing is lost but a forced
    sign-out, and the attacker already holds the password. The fix, never
    inserting the throwaway session (or enforcing the cap only where a session
    is delivered), is the flow change above and was rejected; do not report
    it again. (Performance audit P-6.)

84. **Decoding the Session Cookie Is the Per-Request Auth Cost** — the
    cookie-cache read behind `authenticatedSession`
    (`lib/auth/session/read.ts`), the snapshot `lib/auth/session/hooks.ts`
    writes through `sanitizePermissions`
    (`packages/shared/src/permissions/matrix.ts`) — a cache hit costs
    400–800 µs, mostly fixed work (key import, HMAC, cookie parsing); the
    cookie's size moves only about 12 µs, so storing only the granted actions
    saves nothing measurable. Accepted: the array shape would also change the
    published `Session.metadata.permissions` schema and read as all-false in
    the old release during a swap or a rollback. A cached dashboard read makes
    no auth query; a write makes one indexed `liveGrants` query.
    (Performance audit P-7.)

85. **Better Auth Paths Without a Cookie Cache Read the Session Row Twice** —
    the 2FA, passkey and re-auth management paths: with no cache cookie (a
    "do not remember" session, on every request) Better Auth's `findSession`
    reads the row and our liveness check (`liveSessionCondition`,
    `lib/auth/session/live.ts`) reads it again, one extra indexed read.
    Accepted: one read means owning Better Auth's session read, which would
    also bypass its sliding refresh and cache minting; dropping our check would
    let a user suspended out of band through. (Performance audit P-12.)

86. **Plain `db` Reads Wait for a Pool Connection With No Time Limit** —
    `db/transaction.ts` — `reserveWithin` bounds only `withTransaction`'s
    acquisition, at `POOL_ACQUIRE_TIMEOUT_MS`; a plain query waits until a
    connection frees. Bun SQL (1.4.4) has no acquire timeout for plain
    queries, and reserving a connection per query to bound it cost 2.3–3.6×
    throughput. Accepted: the main cause of saturation, Argon2 inside the
    login transaction, is fixed (`lib/auth/login-guard.ts`), and a pool-wait
    gauge is in `TODO.md`'s monitoring entry. (Performance audit P-20.)

87. **SMTP Opens a New Connection per OTP Email** — `sendMailWithDeadline`
    (`lib/smtp.ts`), called from `lib/otp/delivery.ts` — every send pays a
    TCP and TLS handshake and an AUTH. Accepted: OTP mail goes out minutes
    apart, and the 5 s socket timeout (`PROVIDER_TIMEOUT_MS`) closes an idle
    pooled connection anyway, so a pool would almost always be cold. Keeping
    one warm needs a longer socket timeout and a per-message deadline the pool
    does not expose. (Performance audit P-24.)

88. **Argon2 Parameters Stay at m=64 MiB, t=3, p=4** — `ARGON2_OPTIONS`
    (`lib/auth/password/hash.ts`), RFC 9106's second recommended profile.
    Owner decision: keep them. p=1 or OWASP's minimum profiles give more
    hashes a second under concurrency, the latter at 4–5× less offline margin
    once the pepper leaks too. Any change also opens a sign-in timing oracle
    until every hash is upgraded: the timing guard would hash with the new
    parameters while accounts not yet rehashed verify at the old ones, and
    `needsRehash` compares only the pepper generation. Revisit with a
    measurement at the VPS's real vCPU count if sign-in bursts become real
    load. (Performance audit P-25.)

89. **An Upload Queued for the Encoder Is Not Re-Authorised** —
    `admitUpload` / the pending-row insert (`lib/media/upload.ts`) — both
    upload routes authorise in the gate, then wait for the encoder slot
    (`createAdmission`, `lib/media/image/optimize.ts`) and write the pending
    row and the R2 object with that earlier actor. A session revoked, a user
    suspended or a grant removed during the wait does not stop that one
    upload. Not an issue under the harmless-race rule: the actor held the
    upload grant when it was checked, and the effect is additive and private,
    one more library file per request already in flight, which any media editor
    can delete. The wait is short in practice: the process-wide upload slot
    (`lib/media/upload.ts`) queues for at most 10 s and reads the body for at
    most 100 s, and the encoder queue behind it held about 10 s of 6 MP encodes
    on 2026-10-31, though that queue has no deadline of its own. Raised by the
    2026-10-31 load-test review. Revisit if `queueLimit` grows, an upload
    purpose becomes public, or revocation must stop work already admitted.

90. **Two Racing Passkey Registrations Can Pass the Per-Account Cap** —
    `assertPasskeyRoom` (`lib/auth/path-policy.ts`) — the limit
    (`MAX_PASSKEYS_PER_USER`, 20) is counted before the plugin inserts, outside
    its transaction, so it is a best-effort threshold: N registrations that
    overlap at 19 credentials leave 19 + N. Not an issue under the
    harmless-race rule: each registration needs the account owner's own
    re-authentication grant and a completed WebAuthn ceremony, so the overshoot
    is whatever the owner runs in parallel, and the limit exists to stop
    thousands accumulating over time, which it still does. Making it exact
    means owning the plugin's insert transaction. Raised by the 2026-11-01
    review.

# Known Issues — Will Be Fixed Later

<!-- 1: moved to "Not Real Issues" #77 by owner decision (2026-10-31). The entries after it keep their numbers. -->

2. **No Default Application-Pool `statement_timeout` Configured**
   - **Locations:** `db/index.ts`, `db/transaction.ts`, `lib/http/timing-floor.ts`
   - **Summary:** The application pool has no default `statement_timeout`; runaway or unindexed queries outside transactions given a deadline can hold pooled connections indefinitely. A general ceiling remains deferred until p99 query durations are measured on the deployment host.
   - **Accepted scoped limits:** The owner authorized transaction deadlines. Transactions given a deadline set a transaction-local `statement_timeout` for each statement from the remaining budget, including anonymous OTP verification. The readiness probe uses a separate pool with its own timeout.

3. **No Optimistic Locking on Concurrent Entity Updates**
   - **Locations:** All admin update endpoints (`PUT /api/dash/*`)
   - **Summary:** Entity updates lack version/timestamp checks (`updatedAt`). If two administrators concurrently modify the same user or role, the last write silently overwrites the previous write without conflict detection.

4. **Bulk Session Invalidation Inside Transaction Holds Role Lock**
   - **Locations:** `modules/permissions/item.ts`, `lib/permissions/session-refresh.ts`
   - **Summary:** Role deactivation and permission metadata updates run bulk session deletions/updates inside the main transaction while holding an exclusive `FOR UPDATE` lock on the role row. At scale, this increases lock contention; planned mitigation moves bulk session operations post-commit or adopts timestamp-based staleness checks.

5. **Stale Cookie Cache Extends Read Access Post-Deactivation**
   - **Locations:** `lib/auth/index.ts`, `lib/auth/session/read.ts`, `lib/permissions/checker.ts`
   - **Summary:** Better Auth caches session cookies for up to 5 minutes (`maxAge: 300`). While write/mutation paths strictly verify live database sessions (`assertLiveSession`), read-only endpoints evaluate against the cookie cache, allowing deactivated users up to 5 minutes of read access until cache expiration.

6. **Missing Out-of-Band Security Alert on Credential Rotation**
   - **Locations:** `modules/users/me.ts` (change-password), `modules/users/contact-change.ts`, `lib/users/contact-change.ts`
   - **Summary:** Changing passwords or primary email addresses does not send an out-of-band security notice to the previous email address. In a session hijack scenario, the legitimate owner is not alerted when credentials change.

7. **Audit Logs Stored Exclusively in Primary Application Database**
   - **Locations:** `lib/audit/index.ts`, `db/schema.ts`
   - **Summary:** Audit logs reside solely in the application PostgreSQL database under the same database role with no secondary append-only sink (e.g. S3 Object Lock, CloudWatch). An attacker with direct database access could tamper with logs without an off-host immutable audit record. Planned asynchronous export via scheduled maintenance tasks.

8. **Third-Party `Error.message` Retained Verbatim in Internal Server Logs**
   - **Locations:** `utils/log.ts` (`serializeErrorLike`), `lib/http/response.ts`
   - **Summary:** The log serializer strips sensitive fields from structured objects but keeps raw `error.message` text from third-party libraries (e.g., S3 SDK, fetch calls). While logs are strictly internal and known libraries do not leak secrets in messages, unmapped future errors could theoretically expose un-sanitized context. A throw in a request hook now logs only its `errorClass` (`server/elysia/errors.ts`).

9. **Soft-Deleted Users Accumulate Without Automated Cleanup**
   - **Locations:** `db/schema.ts`
   - **Summary:** Soft-deleted user records (`deletedAt IS NOT NULL`) are retained indefinitely in the database without an automated maintenance cron job to archive or purge them after a defined retention window.

10. **Email Validation Provider Allowlist Restricts Custom Domains**
    - **Locations:** `packages/shared/src/validation/rules.ts` (`emailSchema`)
    - **Summary:** The validation schema enforces an allowlist of consumer email domains (e.g. Gmail, Outlook), blocking business and custom domain email addresses until domain policy requirements are finalized for general launch.

11. **Audit Logs Missing Dedicated Forensic Query Indexes**
    - **Locations:** `db/schema.ts`
    - **Summary:** The `audit_logs` table currently lacks composite indexes for specialized forensic queries (e.g., filtering all historical actions by a specific user across time ranges), to be added when log volume warrants optimization.

12. **Daily OTP Spend Breaker Allows 2x the Budget Across a Window Boundary**
    - **Locations:** `lib/rate-limit/index.ts` (`enforceOtpGlobalSendBudget`), `lib/rate-limit/fixed-window.ts`
    - **Summary:** `OTP_GLOBAL_SEND_CAP_PER_DAY` (one cap per contact kind) uses a FIXED 24h window anchored on UTC midnight (`windowStart = now - (now % windowMs)`), so 2000 charges at `23:59:59.999Z` and 2000 more at `00:00:00.000Z` dispatch 4000 paid messages inside one second and leave the whole of day two at zero. A cap that can be doubled in a burst is not a strict daily cap. Deferred: the fix is a sliding window, which is a change to the shared limiter primitive rather than to this one budget. See `TODO.md`.

13. **The Global OTP Budget Is Charged From Inside the PostgreSQL Transaction**
    - **Locations:** `lib/otp/send.ts` (`processOtpSend`), `lib/rate-limit/index.ts` (`enforceOtpGlobalSendBudget`)
    - **Summary:** `enforceOtpGlobalSendBudget` is the last statement inside `withTransaction`. It no longer blocks the thread (`yieldWhenBusy` retries on timers), but under SQLite writer contention it still waits up to `BUSY_TIMEOUT_MS` (a held writer lock was measured at 2 282 ms) while the transaction holds the user's row (`FOR NO KEY UPDATE`, taken first by `lockUser` in `lib/users/lock-order.ts`; the per-contact advisory lock is gone), the proof and code rows, and one of `MAX_POOL_CONNECTIONS` (10). For that wait every other locker of the user's row queues behind it: password sign-in and sign-in admission, credential rotation, and a verify of any purpose, which on the anonymous routes can reach its floor deadline and answer as an unknown identifier (logged as `otp.verify.deadlineExceeded`). A write that only references the user (an audit row, a session insert) does not wait. It is the one limiter call in the codebase made while holding PostgreSQL locks; provider delivery was moved after the commit for the same reason. Secondarily, the charge is not atomic with the commit: a successful charge followed by a failed COMMIT permanently burns one unit of the daily budget with nothing sent, and there is deliberately no refund primitive. Deferred: moving it out needs a decision about what happens between the charge and the commit, which is the same problem the absent refund primitive describes. See `TODO.md`.

14. **`@knipignore` Masks Dead Exports and Unused Helpers**
    - **Locations:** `packages/shared/src/data-table/config.ts`, `packages/shared/src/utils.ts`, `lib/cache/index.ts`, `lib/r2/client.ts`, `lib/auth/passkey-assertion.ts`, `lib/http/openapi/better-auth-tables.ts`, `knip.jsonc`
    - **Summary:** `@knipignore` tags mask several unused exports and dormant helpers. Dead export cleanup and knip suppression pruning will be handled upon project completion. The `lib/cache` tags cover the scaffold kept on purpose (#73 above). The tags under `packages/shared` are read by nothing: no knip run covers that package.

15. **Sign-in Racing a Role Edit Can Persist a Stale Permission Snapshot**
    - **Locations:** `lib/auth/session/hooks.ts` (sign-in snapshot), `lib/permissions/session-refresh.ts` (`refreshRoleSessions`), `lib/permissions/checker.ts` (`resolveGrants`), `lib/auth/session/read.ts` (`hasSessionCookieCache`)
    - **Summary:** The sign-in hook reads the role's permissions, then a role edit commits `refreshRoleSessions` before the new session row exists, and the row is saved with the pre-edit snapshot. Nothing locks the two against each other. The window is a few milliseconds between the hook's read and the session insert, so it is rare. Reads can continue using that stale snapshot beyond #5's 5-minute cookie-cache window: reads skip `liveGrants` whenever a cookie named like the cache is present, even an expired one, and `/api/auth/get-session` can re-mint the cache from the stale row. This does not mean access persists forever or necessarily until session expiry. A database permission check (`liveGrants`, used by every permission-checked write and checks with `forceDB`) detects drift and attempts to resync the session; a later role edit refreshes existing session snapshots, and relevant user edits refresh or revoke sessions inside their own transactions. This race is the only known source of a drifted row. A junk cache cookie reaches the same read path after an out-of-band database edit (#78 above, accepted).
    - **Owner decision:** The current read behaviour is accepted for now. Keep this under known issue #15 and defer implementation until the owner chooses to address it. Planned fix: make the snapshot read and the session insert atomic against role edits, so a concurrent edit waits for the new row and then refreshes it.

### [Medium] 2FA-2 (OTP side): a concurrent OTP send can restore a proof that method removal just revoked

- **Where:** `lib/otp/revoke.ts` (`revokePendingTwoFactorCodes`), called from `lib/auth/two-factor/methods.ts` (`clearTwoFactorEnrolment`, `removeMethodIntent`); `lib/otp/send.ts` (`processOtpSend`); `lib/auth/two-factor/otp.ts` (`sendTwoFactorCode`, `verifyForEnrolment`).
- **Problem:** a send authorised before a method is removed can still commit a usable code after the removal:
  - The two paths now share the user-row lock: the send takes it first (`lockUser`, `lib/users/lock-order.ts`), and every removal path takes it `FOR UPDATE` first. A send that locks first has its code deleted by the removal that follows.
  - What remains: the send authorises the challenge before its transaction starts, and neither `sendTwoFactorCode` nor `processOtpSend` re-checks enrolment once it holds the lock. A send authorised before the removal commits therefore waits for it, then writes a fresh code.
  - The enrolment verifier accepts that `two_factor` proof without a password and re-enrols the removed method.
- **Evidence:** a second review reproduced it on the harness DB. Setup: email and phone OTP enrolled, an existing phone verification session, an ordinary sign-in challenge, and the code insert delayed 3 s. Result:
  - The concurrent phone-method removal answered 200 in 180 ms.
  - The send answered 200 after 3055 ms and left one code row.
  - Verifying that code from the surviving session, with no password, answered 200 and restored the phone method.
  - The existing removal tests only cover codes committed before the removal.
- **Failure scenario:** the stolen-device scenario from 2FA-2, through the OTP method instead of TOTP.
- **Status:** not a regression, since `HEAD` had no revocation at all. The fix closes only the committed-before case, and the race was not swept.
- **Fix:**
  - The shared lock is in place (the user row, above).
  - Re-check challenge and enrolment authorisation inside the issuance transaction after acquiring the lock. Locking alone does not refuse a send authorised before the removal.
  - Alternatively, bind each proof to an enrolment generation and check it on consume.
  - Cover an in-flight resend against both method removal and full 2FA disable.
