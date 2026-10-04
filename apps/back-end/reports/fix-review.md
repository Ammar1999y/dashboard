# Review of the audit fixes (working tree vs `HEAD` 3df2019)

SVG findings and their original evidence have moved to [svg-processing-plan.md](svg-processing-plan.md#original-svg-findings-moved-from-reviews), which also records current status and planned disposition.

### [Medium] `?grant=` removed, so the stock Better Auth passkey client can no longer register a passkey

- **Where:** `lib/auth/path-policy.ts:382-386` (`grantToken`). At `HEAD` it read `bodyRecord(ctx).grant ?? ctx.query.grant`; now it reads the body only. The grant is checked on `REAUTH_GRANT_PATHS` (`path-policy.ts:98-101`): `/passkey/verify-registration` and `/passkey/delete-passkey`.
- **Problem:** enrolment is three steps (`docs/two-factor-flow.md` §5ج):
  1. Prove the password or use the re-auth window at `/two-factor/passkey/grant` to get a grant (10 min, single use).
  2. `GET /passkey/generate-register-options`.
  3. `POST /passkey/verify-registration` carrying the grant.
- **Why the stock client needs the query form:** `authClient.passkey.addPasskey()` runs steps 2 and 3 itself (`registerPasskey`, `node_modules/@better-auth/passkey/dist/client.mjs:69-100`). For step 3 it writes a fixed body `{ response, name, createSession }` after spreading `fetchOptions`, so a caller's `body.grant` is overwritten. `fetchOptions.query.grant`, which becomes `?grant=`, was the only way to deliver the grant. Deletion is unaffected: the caller controls the `delete-passkey` body, so the grant fits there.
- **Failure scenario:** passkey enrolment built on `addPasskey({ fetchOptions: { query: { grant } } })` always gets 401 at step 3, and the user can never add a passkey. The only way round it is re-implementing the WebAuthn registration ceremony with `@simplewebauthn/browser`. Nothing breaks today, because the front-end has no passkey enrolment yet. The new tests in `two-factor-passkey.test.ts` (around `:302` and `:772`) lock the narrowing in.
- **Why the stated reason doesn't hold:** the new comment ("a query string lands the token in proxy logs and browser history") doesn't justify the change:
  - A `fetch` POST never enters browser history.
  - The app's access log records only the path.
  - The grant is single-use, lasts 10 minutes, and is bound to the session that minted it, so a proxy-logged copy has almost no value.
  - The `HEAD` comment was also wrong: it said "`?grant=` on the GET ceremony route", but both grant routes are POSTs.
- **Fix:** restore the query fallback for `/passkey/verify-registration` (the body stays preferred). Keep `delete-passkey` body-only if wanted. Reword the comment to the real constraint: the stock client cannot put the grant in the registration body. Flip the two tests.

### [Medium] A new regression test fails the required lint gate

- **Where:** `tests/integration/session-snapshot-resync.test.ts:96`; `.github/workflows/ci.yml:53` (the lint step).
- **Evidence:** `bunx eslint tests/integration/session-snapshot-resync.test.ts` → `96:39 error Do not access a member directly from an await expression unicorn/no-await-expression-member`, from `expect((await listUsers(session)).status)`. `bun run lint` exits 1.
- **Impact:** the change set can't pass CI or the pre-push hook. The implementer's verification claims did not include a lint run (CLAUDE.md "Verification").
- **Fix:** await the response into a local, then assert its `status`. Rerun `bun run lint`.

### [Medium] Phase-2 migration-ledger refusal runs after phase 1 has already committed

- **Where:** `scripts/migrate.ts:242` (phase 1 `migrate(...)`), then `:249` → `db/migration-ledger.ts:177-179`.
- **Problem:** the same file (`migrate.ts:182-187`) sets the rule that "a refusal that has let the pending set commit first is not a refusal", and phase 1 follows it with a check before running. Phase 2's check runs only afterwards. `reports/coolify-deployment.md:208` claims the refusal happens "before anything runs".
- **Failure scenario:** a commit edits an already-applied `001_add_trgm_indexes.sql` and also adds a Drizzle migration dropping `roles.description`. Phase 1 commits the DROP COLUMN, then phase 2 exits 1. The deploy fails, but the schema has already moved on under the old release.
- **Evidence:** a second review ran the real runner from a temporary checkout against an isolated database. The checkout had a pending generated migration dropping a probe table, plus an edited `001_add_trgm_indexes.sql`. The runner exited 1 with `001_add_trgm_indexes.sql has changed since it was applied`, but the generated ledger row had committed and the probe table was gone.
- **Impact:** a refused deploy can leave irreversible schema or data changes behind. `tests/process/sql-migration-ledger.test.ts` tests the helper, not the runner's refusal order.
- **Fix:** under the existing migration lock, hash the files and run `assertLedgerPrefix` (when `drizzle.__sql_migrations` exists) before phase 1, and apply after it. Add a runner-level test showing pending generated DDL stays unapplied when the handwritten history is invalid.

### [Low] OTP-4 floor still doesn't cover the known-account branch, and no measurement was made

- **Where:** `lib/http/timing-floor.ts:5-10` (`MINIMUM_RESPONSE_MS = 2500`, "Must stay above `BUSY_TIMEOUT_MS`"), `lib/sqlite/database.ts:47-49`.
- **Problem:**
  - The floor is counted from handler start, so the shared pre-lookup work uses up its headroom: the per-IP limiter, Turnstile siteverify (timeout 3000 ms) and the surface-quota write.
  - The known-account branch then adds its own cost: the global-budget SQLite charge inside the PostgreSQL transaction (`lib/otp/send.ts:254`). Known issue #13 measured that charge alone at 2282 ms.
  - The real rule is: floor ≥ worst shared latency + worst known-only latency. "Above `BUSY_TIMEOUT_MS`" is not that rule.
  - The remediation said "from measurement", but no measurement was made or recorded.
  - The old "TODO: Measure…" was deleted.
  - The coupling to `BUSY_TIMEOUT_MS` exists only as two matching comments; no assertion enforces it.
- **Failure scenario:** under writer contention, siteverify takes 300 ms and the charge waits 2.2 s. A known identifier answers in about 2.55 s and an unknown one in 2.50 s.
- **Fix:**
  - Start the floor's clock at the account lookup instead of at handler start.
  - Size the floor from a measurement.
  - Assert `MINIMUM_RESPONSE_MS > BUSY_TIMEOUT_MS`.
  - Put the TODO back until the measurement exists.

### [Low] Timing floor now also applied to captcha refusals and every `/passwordless/verify` outcome (unrequested)

- **Where:** `lib/http/timing-floor.ts:36-40` (the `finally`), `lib/auth/passwordless.ts:213-215`. Captcha returns at `app/api/auth/otp/send/handler.ts:87-88`, `forgot-password/send/handler.ts:29-30` and `forgot-password/reset/handler.ts:71-72`.
- **Problem:** at `HEAD`, these outcomes skipped the floor on purpose: `withTimingFloor`'s doc, `passwordless.ts`, and `otp-admission-before-body.test.ts` all say so. Now every captcha failure, disabled-feature 404, 422 and pre-lookup 429 waits 2.5 s. None of them depends on the account, so there is no security gain. The cost:
  - A real user who fails the captcha waits 2.5 s.
  - Every bot request without a token holds a connection and a timer for 2.5 s.
  - The admission test had to be rewritten into concurrent batches to stay under its timeout.
- **Fix:** let the captcha and other account-independent early returns skip the floor again, or get the owner to accept the policy change.

### [Low] Writer-lock claim now runs after `app.listen`

- **Where:** `server.ts:106` (listen), then `:122` (claim).
- **Problem:** at `HEAD`, a broken `SQLITE_DIR` threw before listen. Now the port is bound and "server started" is logged, and then an uncaught top-level throw ends the process. The `uncaughtException` handler (`:183`) is not registered yet at that point.
- **Fix:** call `tryAcquireWriterLock` before `app.listen` and pass the result to `scheduleWhenOwner`.

### [Low] REC-3 is not fully closed: an expired OAuth state still lands on raw 401 JSON

- **Where:** `lib/auth/oauth/plugin.ts:259-261, 420-427`.
- **Problem:** `parseState` throws before `destination` is known, so the catch still reaches `throw authenticationDenied()`. Setting the constant to 300 s only shortens the once-marker row. The audit's remediation did not cover this scenario.
- **Failure scenario:** a user spends more than 5 minutes at Google, returns, and sees the 401 JSON body instead of being sent to `callbackURL`.
- **Fix:** when the state is missing or expired, redirect to a fixed origin page such as login with search/query params to show the user propel message.

### [Low] Cookie-cache plugin re-mints the cache on the response that clears an expired session

- **Where:** `lib/auth/session/cookie-cache.ts:102-110`.
- **Problem:** the `!returned` guard assumes that "no session" is `null`. On the HTTP route, better-call returns `{ body: null, _flag: 'json' }` (`better-call/dist/context.mjs:70-77`), so the guard passes. For an expired row, `pending === 'expired'` and `remintCache` runs.
- **Failure scenario:** a "don't remember" row past its expiry gets `GET /api/auth/get-session`. The response clears the token and the marker, but plants a fresh 300 s `session_data` cookie.
- **Status:** read from source, not executed.
- **Fix:** check the JSON body as well as the raw value, or return early when the session has expired.

### [Low] `resyncUserSessions` takes locks in the opposite order to role DELETE; fix it together with #57

- **Where:** `lib/permissions/session-refresh.ts:126-148` against `app/api/dash/permissions/[id]/handler.ts:310, 343-348`. The #57 pair is `lib/users/delete.ts:61-70` against the same role DELETE.
- **Problem:** three writers lock the same `users` and `roles` rows in two orders:
  - **Role DELETE:** `roles` FOR UPDATE, then `users WHERE role_id` FOR UPDATE (under `REQUIRE_ROLE_FOR_LOGIN`, which defaults to `true`).
  - **Resync:** `users` FOR SHARE, then `roles` FOR SHARE.
  - **User DELETE (#57):** one statement, `FOR UPDATE OF u FOR SHARE OF r` over a join. The plan decides the row order, which is users first in practice but not guaranteed. The TODO at `delete.ts:53` says this was never tested.
  - The resync docblock calls "users → roles" the canonical order, but role DELETE already runs roles → users, so no single order exists.
- **Failure scenario:** a member's write that detects drift runs while an admin deletes that role. PostgreSQL aborts one side with `40P01`. If it aborts the DELETE, the admin gets an unmapped 500. Drift is most likely right after a role edit, which is exactly when an admin is working on that role.
- **Status:** PLAUSIBLE; lock order read from the code, not reproduced.
- **Why fixing resync alone isn't enough:** it removes the new participant, but user DELETE still runs opposite to role DELETE, so #57 stays open.
- **Owner decision:** fix #57 in the same change and delete its `should-ignore.md` entry once the fix lands.
- **Fix:**
  - **One order everywhere: roles → users.** Resync and user DELETE learn the role only after reading the user, so both use one shared helper:
    1. Read the user's `roleId` without a lock.
    2. Lock the role row.
    3. Lock the user row and check `roleId` is unchanged.
    4. If it changed, start again.
  - **Handle `40P01` as a backstop:** retry the transaction once, or answer a "try again" error instead of an unmapped 500. This covers any future participant that misses the order.
  - Correct the resync docblock so "canonical" describes the order the code actually uses.
  - Resolve the `delete.ts:53` TODO by testing the new lock order.
  - Delete #57 from `should-ignore.md`.

### [Low] Resync rewrites every live session row when only the cookie is stale

- **Where:** `lib/permissions/checker.ts:264-277, 341-349`.
- **Problem:** on a cache hit, `snapshotDrifted` compares the cookie's copy of the snapshot. After a role edit, `refreshRoleSessions` has already updated the rows. Each member's next write still runs a transaction with two share locks and an `UPDATE` of all their sessions, only to fix the cookie. The class doc also calls the row stale when it isn't.
- **Fix:** select `sessions.metadata` in the existing `liveGrants` query. Resync the row only when the row itself has drifted; when only the cookie has, just queue `refreshSessionCookies`.

### [Low] AUTH-1: logger enabled at `error` lets anonymous callers write error-level lines

- **Where:** `lib/auth/index.ts:72-83`.
- **Problem:** the comment says client refusals are logged at `warn`. They aren't: `better-auth/dist/api/middlewares/origin-check.mjs:56, 78, 114, 143` logs `Invalid origin: <caller text>` at `error`. Reproduced in development mode with `POST /api/auth/sign-out` and `Origin: https://evil.example/attacker-text`: the result is a 403 plus an error-level `betterAuth` line containing that text. It is sanitised and capped, so this is alert noise, not injection. The harness can't see it, because test mode skips the origin check.
- **Fix:** demote the origin and CSRF messages to `warn` in the `log` callback, matching on the message prefix since the library gives no error code here. Correct the comment.

### [Low] AUTH-3: the new locked-account 429 is missing from OpenAPI, or published in the wrong body shape

- **Where:** `lib/auth/login-guard.ts:359-360`.
- **Problem:** the new 429 is not published correctly in either family of routes:
  - **Better Auth paths (wrong shape).** These paths now answer the Better Auth shape `{ message, code: '__' }`, but the document publishes the envelope 429:
    - `/two-factor/get-totp-uri`, `/two-factor/totp/start`
    - `/two-factor/generate-backup-codes`, `/two-factor/backup-codes/acknowledge`
    - `/two-factor/methods/disable`, `/two-factor/disable`
    - `/two-factor/passkey/grant`
  - **Table routes (no 429 at all).** `/api/dash/users/me/change-password`, `change-email` and `change-phone` answer an envelope 429, but `routes.ts:236-268` declares no 429 for them.
- **Fix:** add the seven Better Auth paths to `BETTER_AUTH_LOCAL_THROTTLE_PATHS` (`lib/http/openapi/better-auth-tables.ts:121`) or a sibling set, and declare a handler 429 on the three table routes.

### [Low] HTTP-1: the new origin 403 is missing from the published OpenAPI

- **Where:** `lib/http/adapters/elysia.ts:49` (the refusal); `lib/http/openapi/route-operations.ts:250-258` (`commonResponses` adds 403 only when `entry.auth === 'permission' || entry.captcha`).
- **Problem:** every unsafe-method table route can now answer 403 `MSG_UNTRUSTED_ORIGIN` before its handler runs, but routes without permission or captcha publish no 403 at all. Examples: `POST /api/dash/auth/reauth` publishes `200, 400, 401, 413, 429, 500, 503`, and `POST /api/dev/sign-up` has the same gap. Where a 403 is published, its description names only authority or captcha.
- **Evidence:** a second review confirmed the runtime 403 and the missing documented 403 with a temporary unit test.
- **Fix:** add the origin 403 for every non-GET/HEAD/OPTIONS table route in `commonResponses`, keeping the authority and captcha wording where those also apply. Extend the consistency check to cover adapter-level refusals.

### [Low] 2FA-5 not swept: admin-driven Google unlinks are still audited as the target's own action

- **Where:** `lib/auth/session/rotation.ts:198-211` (`unlinkGoogle`), called from `lib/users/edit.ts:362` and `lib/users/delete.ts:109`.
- **Problem:** the row's `userId` and `userEmail` are the target's, and the function has no actor parameter.
- **Failure scenario:**
  - An admin changes a Google-linked user's email: the unlink row names the target as the actor.
  - On soft delete, the email is anonymised first (`delete.ts:88`), so the row names neither the admin nor the real address.
- **Fix:** add an `actor` parameter. Self-service callers pass the user and admin callers pass the admin.

### [Low] USR-6 not swept: `requirePermission`'s re-auth guard still fails open on empty ids

- **Where:** `lib/http/session.ts:53` (`if (opts.reauth && result.allowed && result.userId && result.sessionId)`).
- **Problem:** `userId` and `sessionId` can never be empty (`checker.ts:75-76, 102-105` throw first), so the extra conditions are dead code. They have the same shape as the guards USR-6 removed: if a future change returns `''`, the re-auth window is skipped silently on all six `reauth: true` routes. There is also a leftover at `edit.ts:59, 146`: `EditActor.sessionId: EntityID | null` with `?? ''`.
- **Fix:** `if (opts.reauth && result.allowed)`, then call `hasAdminReauth(result.sessionId, result.userId)` directly. Make `EditActor.sessionId` an `EntityID` and drop the `?? ''`.

### [Low] USR-4 fix accepts a custom role's raw id as "no role change"

- **Where:** `lib/users/edit.ts:214-219` (`assignsStandardRole = !isCustomRole && input.roleId !== lockedUser.roleId`).
- **Problem:** take a target on a custom role, and a `PUT` that sends that role's uuid (published as `role.id`, `roles.ts:243`) instead of `'custom'`. `HEAD` answered 404; the working tree answers 200. There is no privilege gain, because no matrix is written, but the input contract says custom roles are addressed as `'custom'`, and it has widened.
- **Status:** read from code, not run on the harness.
- **Fix:** `if (!isCustomRole && (input.roleId !== lockedUser.roleId || isCurrentlyCustom)) await validateAssignableRole(...)`.

### [Low] MEDIA-5: the publish grant is enforced in the route, not at the shared `acceptUpload` boundary

- **Where:** `app/api/upload/file/handler.ts:56`; the doc on `lib/media/upload.ts:524-527`.
- **Problem:** `policy.ts` says a public purpose "takes `requirePublishGrant` like every other way in". But `acceptUpload` neither checks the grant nor lists it among the checks callers must make first.
- **Failure scenario:** the next route that calls `acceptUpload` with a public target reintroduces MEDIA-5.
- **Rule broken:** "Fix at the shared boundary".
- **Fix:** call `requirePublishGrant(ctx.headers)` inside `acceptUpload` when `target.visibility === 'public'`.

### [Low] HTTP-2: new 5xx log line doesn't identify the failure and duplicates existing logs

- **Where:** `lib/http/response.ts:105-111`; `lib/media/upload.ts:377-379, 414-417, 480-483`; `lib/otp/delivery.ts:104`; `lib/rate-limit/index.ts:68`.
- **Problem:** the line is `{msg:'server error response', status, errorClass:'CustomError', cause}`. Most 5xx sites pass no `cause`, so the line only says "a 500 happened". Sites that already `logSanitized` before throwing now produce a second, emptier line. The upload path mixes both styles in the same pipeline, since `toUploadError` now uses `cause`.
- **Fix:** add `message: error.message` to the line (it is always a fixed product string). In the upload path, pass `cause` and drop the separate log calls.

### [Low] DB-6: pool-timeout log line and doc blame pool exhaustion for an unreachable database

- **Where:** `db/transaction.ts:23-36`; `reports/coolify-deployment.md:614`.
- **Problem:** the abort signal also covers the time spent connecting. Measured: `reserve()` against an unreachable host rejected with the signal's `TimeoutError` after 1047 ms.
- **Failure scenario:** during a database outage, every transaction logs "pool acquisition timed out", and the operator goes hunting for leaked transactions.
- **Fix:** word both as "no connection within the bound (pool exhausted or database unreachable)".

### [Low] DB-2: the `indisvalid` check covers the whole database, not the file's own indexes

- **Where:** `db/migration-ledger.ts:138-147`, used at `:189-194`.
- **Problem:** any invalid index anywhere refuses every `CONCURRENTLY` file. Examples: a `_ccnew` index left by an operator's failed `REINDEX CONCURRENTLY`, or an index another session is building at that moment. It fails closed, so this is a nuisance rather than a hole.
- **Fix:** limit the check to index names the file creates.

### [Low] 2FA-1: the Google refusal audit row describes a session that never committed

- **Where:** `lib/auth/two-factor/issue.ts:190-206` (`recordRefusal`: `oldData: { loginSuccess: true }`, `sessionAbandoned: true`).
- **Problem:** on the Google path the row is now written after the rollback, so it references a session `recordId` that never existed. It also omits `firstFactor`, which its challenge and trusted-device siblings record.
- **Fix:** when the record is deferred, omit `loginSuccess`/`sessionAbandoned` (or set `sessionRolledBack: true`), and add `firstFactor`.

### [Low] 2FA-3: `withOtpSendHints` still defaults its executor to the pool

- **Where:** `lib/auth/two-factor/issue.ts:61-65` (`executor: Executor = db`).
- **Problem:** this default is what caused 2FA-3. The same change made `spendBackupCode`'s executor required, but this default stays in place for the next caller.
- **Fix:** make the executor required, and pass `params.transaction ?? db` at `:287-291`.

### [Low] OpenAPI doesn't describe two of the new refusals

The published document is the contract clients are built from, so every new refusal has to be in it.

- **USR-1 (and every other `reauth: true` route):**
  - `POST /api/dash/users` now says "This operation requires re-authentication" (`lib/http/openapi/route-tables.ts:244`).
  - But its 401 is still the generic "No session, or the session row is no longer live." (`lib/http/openapi/route-operations.ts`, `commonResponses`).
  - Nothing says that a 401 with code `REAUTH_REQUIRED` means "open the window at `POST /api/dash/auth/reauth`, then retry". That code is what a client branches on (`docs/two-factor-flow.md` §6).
  - This gap already existed on the other re-auth routes. The fix only added one more.
- **2FA-2:**
  - `/two-factor/totp/confirm` now refuses 400 `totpEnrolmentExpired` once 600 s have passed since `start` (`lib/auth/two-factor/enrolment.ts:79, 208-221`).
  - The document publishes only the generic 400 "Required request input was absent or invalid for this endpoint." (`lib/http/openapi/better-auth-tables.ts:48, 87`).
  - So the deadline, and the need to call `start` again, appear nowhere.
- **Fix:**
  - Give re-auth routes a 401 description that names `REAUTH_REQUIRED` and the re-auth endpoint, derived from the route's `reauth` flag so the whole class gets it.
  - Add the 10-minute enrolment deadline to the `/two-factor/totp/confirm` operation.
  - The locked-account 429 is covered by the AUTH-3 entry above.

### [Low] AUTH-2 warning is placed on the consumers, not where the policy is edited

- **Where:** `packages/shared/src/validation/auth.ts:30-31, 46`, `rules.ts:321-322`.
- **Problem:** the audit's scenario is someone raising `PASSWORD_MIN` (`validation/constants.ts:34`) or editing `passwordSchema` (`rules.ts:290`). Neither place carries the warning, so the person making that edit won't see it.
- **Fix:** move one clause to `passwordSchema` or `PASSWORD_MIN`, and drop the three copies.

### [Low] Missing or ineffective tests for the fixes

- **2FA-4:** `tests/integration/two-factor-totp.test.ts:762-833` compares the count against a regenerated set, so it still passes if `spendBackupCode` is deleted. No test asserts N → N−1 after a single backup-code sign-in.
- **2FA-2:** both refusal tests (`two-factor-management.test.ts:296, 383`) stop at the pending check. Deleting the secret overwrite in `clearCapabilityFor` fails no test.
- **REC-2:** only the email variant is tested (`password-reauth-guard.test.ts:271-315`). The phone variant, the paid-SMS case the audit reproduced, has no test.

### [Low] Trimmed comments lost the only statement of a cross-file constraint

Each needs one clause restored:

- `lib/auth/transaction.ts:23-28` lost two facts:
  - `internalAdapter` is already bound to the transaction, which is what tells the next person when the Proxy is needed.
  - The direct-adapter call "writes the credential row the caller may hold a lock on". That is a hang one request can cause on its own, and `POOL_ACQUIRE_TIMEOUT_MS` does not bound it.
- `lib/auth/passwordless.ts:69-70` lost why limiter calls must stay inside the `try`: outside it, a `CustomError` becomes Better Call's empty 500.
- `lib/otp/throttle.ts:112` says "None depends on whether the account exists" directly above a set that includes 429. That holds only because `collapseProofThrottle` runs first (`:126`), and the verify handler's second guard (OTP-6) is gone.
- `lib/otp/verify.ts:229-262` lost "every path that reaches a code comparison charges", which is the brute-force bound.
- `lib/auth/login-guard.ts:273-274` lost: "the role is the only generic-401 gate; a new one must be added to `eligible`". Without it, a correct guess could reset the lockout.
- `lib/auth/session/rotation.ts:1-5` lost "adding work at the END of that order cannot introduce a cycle".
- `lib/auth/session/hooks.ts:182-186` lost "a session id is never reused", which is why orphaned `verifications` rows are harmless.
- `lib/auth/session/hooks.ts:87-88` lost that enabling OTP makes existing unverified users verify at their next login.
- `lib/media/folders.ts:105-114` (`lockTree`) lost two facts:
  - It must not import the file lifecycle, or the two would form an import cycle.
  - One tree-wide lock is a deliberate choice.
- `lib/media/lifecycle.ts` (`sweepFiles`) lost "a `pending` row can have no referrer, so it cannot hit the composite FK".
- `lib/media/upload.ts` (`storeUpload`) lost the audit contract: an entity upload is audited twice, a library upload once.
- `lib/users/edit.ts` (the `HEAD` audit row, `:472`) lost "both sides of every mutated field" for fields added later.
- `lib/users/contact-change.ts:131-132` lost "the provider calls are bounded, so the wait is too".

### [Low] Comments that are now false or break the Comments rule

- `lib/permissions/checker.ts:80` (`refreshSessionCookies`): "the caller's work committed" is false for two of its three callers (`:283`, `:328`).
- `tests/integration/retention-sweep.test.ts:105-109`: the comment about the removed `byText` helper now sits on `interface Pass`.
- Audit finding IDs and a section banner in comments:
  - `tests/fixtures/_sqlite-semantics-child.cjs:203` (`// ---- OTP-3 regression ----`)
  - `tests/integration/pool-acquisition.test.ts:3` ("audit DB-6")
  - `tests/process/sql-migration-ledger.test.ts:2` ("audit DB-2")
  - `reports/coolify-deployment.md` ("audit 2FA-3", "audit OPS-1", "audit OPS-2")

  The audit report is transient, so these references will rot. Describe the behaviour instead.
