## 1. [High] Device trust can still be granted against a removed factor: the proof is minted outside the user lock

**Where:**

- Proof issuers, each after its transaction has committed:
  - `lib/auth/two-factor/plugin.ts:350`: the after-hook, for `/two-factor/verify-totp` and `/two-factor/verify-backup-code`;
  - `lib/auth/two-factor/enrolment.ts:283`: TOTP enrolment;
  - `lib/auth/two-factor/challenge.ts:348`: `completeTwoFactorChallenge`, for `/two-factor/otp/verify` and `/two-factor/passkey/verify`.
- `lib/auth/two-factor/trusted-device.ts:53-64`: `markTwoFactorProven` is a best-effort insert. It takes no lock and records no revocation generation.
- `lib/auth/session/rotation.ts:104-112`: method removal deletes only the proofs that exist when it runs.
- `lib/auth/two-factor/trusted-device.ts:160-171`: `grantDeviceTrust` checks only that a proof exists for a live session.

**Status:** CONFIRMED on two paths, with temporary integration tests through the real endpoints that were deleted afterwards:

- sign-in completed with a backup code;
- TOTP enrolment.

`completeTwoFactorChallenge` has the same shape. It was read, not executed.

**Problem:**

- The latest fix for the trust race put the proof's consume and the trust insert under the user lock that method removal takes (`grantDeviceTrust`).
- Issuing the proof is the other half of the same race. It still happens after the transaction that accepted the factor has committed, and without that lock.
- A removal that commits in that gap finds no proof to delete, so the proof written after it survives.
- Nothing ties a proof to the methods it was earned against, so `grantDeviceTrust` accepts it. That is the bypass `revokeTwoFactorState` exists to stop: "Trust granted against the removed factor would bypass it" (`enrolment.ts`).
- The regression test ("a trust request racing a method removal leaves no trust behind") pauses after the consume, so it never exercises the issue.

**Failure scenario, sign-in path:**

1. A user has TOTP and backup codes. A second browser signs in with the password and is challenged.
2. It completes the challenge with a backup code. The completion commits, but the after-hook has not yet written `2fa-proven-<session>`.
3. From the first session, the owner removes the backup-code method, and the request answers 200. The removal deletes the trusted devices and the proofs that exist; this one does not exist yet.
4. The proof is written. `POST /two-factor/trust-device` from the second browser answers 200, and a trust row exists.
5. The next password sign-in from that browser answers 200 with a session and no `twoFactorRedirect`. The remaining factor, TOTP, is skipped.

**Failure scenario, enrolment path:**

1. A signed-in user has acknowledged backup codes and starts TOTP enrolment.
2. `/two-factor/totp/confirm` commits, but the proof is not yet written.
3. From the same session, TOTP is removed, and the request answers 200.
4. The proof is written. `/two-factor/trust-device` answers 200, and a trust row exists.
5. The next password sign-in answers 200 with no `twoFactorRedirect`. The remaining backup-code factor is skipped.

**Fix:**

- Issue the proof inside the transaction that accepts the factor, after its user lock:
  - in `runPluginVerifier`, once the delegated verifier has succeeded;
  - in the enrolment transaction;
  - in `completeTwoFactorChallenge`.

  Removal then serialises with the issue, as it now does with the consume. The issue stops being best-effort there: a failed insert fails the request instead of leaving trust unredeemable.

- Taking the lock only around the delayed write is not enough. By then the removal may already have committed, and nothing is left for the write to wait for.
- Alternatively, bind the proof to a revocation generation, or to the method set it was earned under, and have `grantDeviceTrust` re-check that binding under the lock.
- Add a regression test for each issuer. It should pause before the proof is written, complete the removal, and require that no trust is created and that the next sign-in is challenged.

---

## 2. [High] A recursive folder delete can delete a file that was moved out of the folder while it ran

**Where:**

- `lib/media/lifecycle.ts:302-344`: `deleteFolderTree` commits its plan, then passes the captured file ids to `deleteFiles`.
- `lib/media/lifecycle.ts:194-262`: `deleteFiles` re-checks scope, status and eligibility, but not that a file is still inside the tree.
- `lib/media/files.ts:143-217`: `updateFile` and `moveFiles` take no tree lock.

**Status:** Traced by reviewer `codex` on 2026-10-06, then verified against the code. Not reproduced with a live race.

**Problem:**

- A file moved to a surviving folder between the plan and the delete is deleted from its new folder.
- Moving a whole subfolder out of the tree in that gap has the same effect on its files.
- The folder phase's tree comparison runs only after the objects are gone, so it cannot recover them.

**Fix:** plan and mark the files `deleting` in one transaction, with the file rows locked and their membership re-read once the locks are held. This is item 4 of Phase 3 in `docs/media-file-manager-plan.md`.

---

## 3. [Medium] The REINDEX option list is not read as PostgreSQL reads it, so ordinary DDL can commit without its ledger row

**Where:**

- `db/migration-ledger.ts:426-445`: `optionEnables`.
- `db/migration-ledger.ts:447-465`: `reindexIsConcurrent`.
- `db/migration-ledger.ts:92`, and the string branches of the lexer: a string token keeps no text.
- `db/migration-ledger.ts:659-676`: a file with a concurrent form runs outside a transaction, and its ledger row is written afterwards.

**Status:** CONFIRMED on the harness PostgreSQL with a temporary process test, deleted afterwards.

**Problem:**

- How PostgreSQL decides:
  - It reads a REINDEX option list in order, and the last `concurrently` element wins.
  - The positional `CONCURRENTLY` keyword is appended after the list (`gram.y`), so it wins over the list.
  - `defGetBoolean` accepts `true`, `false`, `on` and `off` as words or as string constants, and `0` or `1`.
- How the ledger decides:
  - `optionEnables` answers "on" if any element enables it (`.some()`).
  - It reads every string value as off.
  - Its comment says it reads values "as `defGetBoolean` reads it", which is false.
- **Duplicate options commit DDL without a ledger row.** Take this file:

  ```sql
  reindex (concurrently true, concurrently false) index rp_idx;
  create table rp_unrecorded (n integer);
  ```

  - PostgreSQL accepts that REINDEX inside a transaction block, so it is not concurrent.
  - The ledger reads it as concurrent, so the file runs outside a transaction.
  - With the ledger insert refused by a trigger, `applySqlMigrations` rejects, but `rp_unrecorded` is committed and the ledger has no row.
  - A retry then fails on "already exists". That is the failure the transaction dispatch exists to prevent.

- **A quoted boolean is refused.**
  - `reindex (concurrently 'true') index rp_idx` succeeds when sent directly, outside a transaction.
  - As a migration, the ledger keeps it in a transaction, and PostgreSQL refuses it: "REINDEX CONCURRENTLY cannot run inside a transaction block".
  - At `HEAD`, which matched the word anywhere, this file applied. The refusal fails closed, but it narrows what a migration may spell.

**Fix:**

- Read the list in order: the last `concurrently` element decides, with `defGetBoolean`'s values, and the positional keyword overrides it. This needs the lexer's string token to carry its text.
- A value the reader still cannot read keeps the transaction, as now.
- Correct the comment.
- Tests:
  - the duplicate list with a failing ledger insert, asserting that the DDL rolls back;
  - quoted `'true'`, which must run alone;
  - quoted `'false'`, which must keep its transaction.

---

## 4. [Medium] A database fault reading the session still answers "sign in first" on grant routes, and picks the wrong branch on dual-mode routes

**Where:**

- `lib/auth/session/request.ts:20-35`: `resolveRequestSession` calls `getSessionFromCtx`.
- Better Auth 1.7.3 in `node_modules/better-auth/dist/api/routes/session.mjs`:
  - `:246-263`: `getSessionFromCtx` answers any failure of `getSession` with `null`;
  - `:229-233`: `getSession` logs a non-`APIError` and throws a generic 500 in its place, which drops the SQLSTATE.
- `lib/auth/path-policy.ts:241-254`: on a grant path, `null` becomes `sessionRequired()`. On a dual-mode path (`/two-factor/otp/send`, `/two-factor/otp/verify`), `null` selects the sign-in branch.
- Other callers that read `null` as "no session":
  - `lib/auth/reauth/session.ts:13`;
  - `lib/auth/reauth/grant.ts:57`;
  - `lib/auth/two-factor/enrolment.ts:100`;
  - `lib/auth/two-factor/challenge.ts:201`;
  - `lib/auth/two-factor/otp.ts:159` and `:218`;
  - `lib/auth/two-factor/plugin.ts:360` and `:375`.

**Status:** CONFIRMED with a temporary integration test, deleted afterwards.

- A signed-in `POST /api/auth/passkey/delete-passkey?disableCookieCache=true`, with a real `40P01` driver error injected into `internalAdapter.findSession`, answered 401 "قم بتسجيل الدخول أولاً".
- It sent no `Retry-After`. The only line logged was the library's own.
- The dual-mode effect below was read, not executed.

**Problem:**

- This was deferred as an owner decision ("session reads"), and it is still open.
  - The last round only removed the app's own redundant `.catch` from `request.ts`, so the touched file still reads a fault as a refusal.
  - That breaks the rule the round applied everywhere else: a caught database fault is never a refusal.
- The effects:
  - On a grant route, a live session's contention answers 401, and the client is told to sign in again.
  - On a dual-mode route, an enrolling user's fault routes to the sign-in branch, which then refuses for a missing challenge.
- The cost of fixing it: calling `getSession()` directly is not enough, because its own catch already turns the fault into a generic 500.

**Fix:**

- Resolve the session through one shared resolver that keeps the fault.
  - The codebase already has a capture pattern for this: `recordingFaults` in `lib/auth/two-factor/plugin.ts`. Moved to a shared module and wrapped around `getSessionFromCtx`, it would record a `findSession` fault so the resolver can rethrow it, while keeping the library's memoisation, cookie handling and response headers.
  - Map only an absent, expired or revoked session to a refusal.
- Sweep the callers listed above.
- Tests: contention (503 with `Retry-After`), a closed connection (500), and a genuinely missing session (401), on one grant route and one dual-mode route.

---

## 5. [Medium] Open: a request waiting on a user's row lock stalled in full test runs, and the cause is unknown

**Where:**

- `lib/auth/reauth/plugin.ts:154-168`: the passkey re-authentication verify, which waits in `lockUser` and then deletes the ceremony.
- `tests/integration/oauth-reauthentication.test.ts:236-274`: "a ceremony that expires while the verify waits for the user lock opens no window".

**Status:** reported by the implementing agent and not reproduced by this review. The root cause is not verified.

**What was observed:**

- In two full integration runs (`TEST_WORKERS=2`), that test timed out.
- Every later test in the same worker hung too: its `TRUNCATE` queued behind a transaction left `idle in transaction`, still holding the user's row lock.
- `pg_stat_activity` showed that the stuck transaction was the waiting request's own.
  - Its `lockUser` statement waited about 2 s, then completed on the server once the holder committed.
  - The request never sent its next statement, the DELETE.
- Everything between those two statements is synchronous code, so the likeliest cause is the driver (Bun 1.4.2's SQL client). That is unproven.
- It did not reproduce in isolation:
  - The file alone passed every time.
  - Adding a trace line or a timestamp made most paired runs pass.
  - A standalone script running 80 lock waits through one pool did not stall.
- The test now replaces the real lock wait with a `lockUser` spy, so no test waits on a real lock on that path.

**Problem:**

- If this is a driver race, a production request waiting on a user's row lock can stall in the same way. Its transaction would then hold that user's lock, and its pool connection, until the process restarts, blocking every write for that user.
- `idle_in_transaction_session_timeout` on the application's connections (for example 60 s) would bound the damage: PostgreSQL ends such a session and releases the lock.
  - No legitimate transaction here sits idle that long.
  - It is not applied, because it changes production behaviour on an unproven cause. That is the owner's decision.

**Fix:**

- Decide on `idle_in_transaction_session_timeout`.
  - If it is set on the server, record it in `reports/coolify-deployment.md`.
  - If it is set on the pool, set it in `db/index.ts`.
- Re-check the stall on the next Bun release, with a test that waits on a real lock.

---

## 6. [Medium] An R2 or purge failure during a recursive delete leaves the folders behind, undeletable until the nightly sweep

**Where:**

- `lib/media/lifecycle.ts:115-184`: in `finishDeleting`, a row whose object R2 or the purge refused stays `deleting` and keeps its `folder_id`.
- `lib/media/lifecycle.ts:346-374`: the folder phase counts that row and returns `folders: 0`.
- `lib/media/lifecycle.ts:328-329`: a retry refuses with `folderBusy`, because a `deleting` row is not `active`.

**Status:** Traced by reviewer `codex` on 2026-10-06, then verified against the code.

**Problem:**

- The folders stay listed although their files are gone.
- Deleting them again answers `FOLDER_BUSY` until the nightly sweep has removed the row.
- The user guide (§7) describes `folders: 0` only for a tree that changed during the delete.

**Fix:** detach every row from its folder (`folder_id = null`) when it is marked `deleting`, and delete the folders in the same transaction. No constraint ties `folder_id` to `status`.

- The sweep's expiry of `pending` rows (`sweepFiles`, `lib/media/lifecycle.ts:473-476`) has the same cause and gets the same rule. An abandoned upload whose object R2 refused otherwise stays `deleting` inside its folder.
- This is in Phase 3 of `docs/media-file-manager-plan.md`.

---

## 7. [Low] The route-flag hook's 120 s budget has far less headroom than was reported

**Where:** `tests/unit/route-auth-flags.test.ts:45-91`: the `beforeAll`, with `}, 120_000)` at `:91`. The budget was kept on a measured worst hook of about 18 s, a 6.6× margin.

**Status:** CONFIRMED by measurement with `bun tests/helpers/run.ts unit route-auth-flags --reporter=junit`. The hook's time is the file's time minus its two `describe` blocks.

| Condition                                                                         | File   | Hook   |
| --------------------------------------------------------------------------------- | ------ | ------ |
| No other test or lint process running                                             | 23.8 s | ≈ 18 s |
| Three `eslint .` runs (one of them this review's) and another session's unit tier | 74.6 s | ≈ 66 s |

**Problem:**

- Under the second condition, the hook used 55 % of its budget, not 15 %. That is close to an 85.5 s whole-file run reported earlier and dismissed as not reproducible.
- Several agent sessions linting and testing at once is how this repository is worked. A heavier mix can still push the hook past 120 s.
- When the hook fails, every case in the file fails. The pre-push `test` job runs this tier, so `git push` is refused: the failure that precomputing the analysis in one hook was meant to remove.

**Fix:**

- Take the analysis out of the push path: run this file in a tier that `pre-push` does not run, and keep it in CI.
- Otherwise, size the budget from a measurement taken while other lint and test runs are active.

---

## 8. [Low] An untracked probe file fails the type check, so `bun run lint` cannot pass on this tree

**Where:** `tests/integration/__review-proof-race.test.ts`. It is untracked and was created on 2026-10-06 at 11:50 by a review session.

**Status:** CONFIRMED. `bunx tsc --noEmit` exits 2 with eight TS2339 and TS2551 errors, all in this file:

- It reads `owner.password`, `owner.userId` and `owner.email`.
- `signedInUser` returns `{ user, cookie, setCookie }` (`tests/helpers/session.ts:214-219`).

**Problem:**

- Any agent that runs the lint gate on this working tree sees a failure that its own change did not cause.
- The file's assertions expect the insecure outcome of #1: a trust row, and an unchallenged sign-in. Even with the type errors fixed, it would pass only while #1 is unfixed.

**Fix:** delete it, or rewrite it as the regression test for #1, asserting that no trust row exists and that the next sign-in is challenged.

---

## 9. [Low] Integration files on Bun's 5 s default time out under load, and a timed-out case corrupts the cases after it

**Where:** `tests/integration/caught-database-faults.test.ts`.

- Every case except two (`:319` and `:589`, which set 30 s) runs under Bun's 5 s default.
- Each case seeds a user and signs in with Argon2id before it starts.

**Status:** CONFIRMED.

- With the full unit tier running alongside (`bun tests/helpers/run.ts integration caught-database-faults`): 8 pass, 7 fail. Five cases timed out at 5 s, and sign-ins took up to 8.2 s.
- The same command with nothing else active: 15 pass, with sign-ins under 0.4 s.
- **The same class in other files** (2026-10-06, observed during the shared-response-schemas Phase 1 work; not reproduced separately):
  - Four full `bun run test:integration` runs each had one to three 5 s timeouts, in `upload-auth-gate` (setup), `id-canonicalization-guards`, `oauth-email-rotation` and `session-role-field`.
  - The same run of HEAD from a scratch copy had 12 such timeouts across six files.
  - Each file passes alone. `oauth-email-rotation` takes 2.5 s alone and 5.7–6.4 s in the full tier.
  - A unit-tier timing assertion fails the same way under load: `media-allowlist` has a 20 ms limit and measured 45 ms, and passes alone.

**Problem:**

- Bun does not stop a timed-out case. Its body keeps running into the next case, after `beforeEach` has truncated the tables and `afterEach` has disarmed its triggers.
- The next case then fails on something it did not do:
  - "sign-in returned 401 for a correct password": the tables were truncated under the earlier body's sign-in;
  - 503 where 500 was expected: an earlier body armed its 40P01 trigger late, during the next case.
- This file is the main evidence that caught database faults no longer read as refusals. When it fails this way, the next agent reads the failures as a regression in those fixes.
- `tests/integration/self-service-credentials.test.ts:133-139` documents the same trap and sets `setDefaultTimeout(45_000)` for it.

**Fix:** give every sign-in-heavy file a whole-file timeout, as `self-service-credentials.test.ts` does, sized from a full-tier run rather than a lone one. Alternatively, lower the integration tier's worker count.

---

## 10. [Low] The route-gate analyzer still reads two reachable shapes as "no gate" instead of failing

**Where:** `tests/helpers/route-gates.ts`.

- `:299-302`: a declaration whose initializer is a function is followed through that initializer and nothing else.
- `:336-341`: later assignments are read only for a `let` declared without an initializer.
- `:355-360`: a literal-key element call looks up a declared property. An array's numeric index has none, so nothing is followed and nothing throws.

**Status:** CONFIRMED with a temporary fixture run through `createRouteGateAnalyzer`, deleted afterwards. Both of these exports answered `[]`:

```ts
let action = async () => {};
action = async () => {
  await requireReauthWindow('user', 'session');
};
export const reassignedFunction = () => action();

const actions: Array<() => unknown> = [];
actions.push(() => requireReauthWindow('user', 'session'));
export const indexedCollection = () => actions[0]?.();
```

**Problem:**

- The analyzer's stated contract, in the header of `route-gates.ts`, is that what it cannot follow throws, naming the site.
- This is the third round to find shapes that read as "no gate" instead. The general rule was already asked for: a workspace callee the analyzer cannot read throws. These two paths return before that rule is reached.
- The gap is latent: no current handler uses either shape.

**Fix:**

- Follow every assignment of a non-`const` binding, its initializer included, or throw for one.
- When a literal-key element call resolves to no declared property on a value that holds workspace callables, throw.
- Add both shapes to `tests/fixtures/_route-gates-handler.ts`.

---

## 11. [Low] Six code comments cite review reports that no longer exist

**Where:**

- `tests/unit/route-auth-flags.test.ts:89-90` and `tests/integration/oauth-reauthentication.test.ts:254-257` cite `reports/remaining-issues-fix-review-resolution.md`.
- `tests/unit/upload-validation.test.ts:680`, `:936` and `:3335` cite `fix-review-assessment.md`, and `:3299` cites `fix-review.md`.

**Problem:**

- Those reports have been removed. The comments now point at nothing, which is why transient reports were already kept out of comments.
- The `route-auth-flags` comment also does not parse on its own: "Several times this hook's cost measured with the integration tier running alongside".

**Fix:** make each comment state its own reason, without a report name:

- the oauth test: why it uses a spy rather than a real lock holder (#5);
- the route-flag hook: how its budget was chosen (#7);
- the four upload-validation comments: the behaviour each regression guards.

---

## 12. [Low] New comments break the app's comment rules

**Where:**

- `db/transaction.ts:92`: "Drizzle's Bun driver (0.45)" puts a version in a comment.
- `tests/unit/route-auth-flags.test.ts:38-39`: "whichever case ran first used to pay for every file its handler reaches, and timed out under load" is change history.
- `lib/auth/oauth/plugin.ts:663-665`: "a fault between two separate consumes left the result unreadable" is change history. The reason can be stated as what separate consumes would do.
- `db/migration-ledger.ts`: several one-line docblocks restate a helper's signature. For example:
  - `:619`, "Whether the schema-qualified `name` resolves to a table.", on `tableExists`;
  - `:311`, "`tokens` split at each `;`, empty statements dropped.", on `statementsOf`;
  - the same at `:253` and `:529`.

**Fix:**

- Drop the version and the restating docblocks.
- Reword the two history notes as the constraint they protect.

---

## 13. [Low] One logging rule, three copies

**Where:**

- `utils/log.ts:464-472`: `logServerErrorResponse`.
- `lib/http/after-response.ts:79-82`.
- `lib/auth/oauth/plugin.ts:187-188`: the `CustomError` branch of `faultDetail`.

**Problem:**

- All three build the same fields to log a `CustomError` with: `thrownAt` and `cause`.
  - Two of the copies were added in the last round.
  - The after-response comment even says "as `logServerErrorResponse` does".
- The last round was asked for one rule for exactly this. A field added to one copy, such as `status`, will not reach the others.

**Fix:** export that field set once from `utils/log.ts`, and use it at all three sites.

---

## 14. [Low] Open decision: a 503 after a single-use input was spent cannot be retried

**Where:**

- The published remedies:
  - `BETTER_AUTH_SPENT_INPUT_REMEDIES` in `lib/http/openapi/better-auth-tables.ts`;
  - `SPENT_INPUT_REMEDIES` in `lib/http/openapi/route-tables.ts`.
- The attempt budgets:
  - `lib/auth/two-factor/otp.ts:298`: "No restore", before `completeTwoFactorChallenge`;
  - `lib/auth/two-factor/passkey.ts:178`: `settled = true`;
  - `app/api/auth/forgot-password/complete/handler.ts`: after a matched factor.

**Status:** Read. The published 503 texts match the behaviour; what remains open is the behaviour itself.

**Problem:**

- These flows spend a single-use input, then complete in a later transaction that can answer 503:

  | Flow                                      | What is spent                |
  | ----------------------------------------- | ---------------------------- |
  | `/passwordless/verify`                    | the OTP                      |
  | `POST /api/auth/forgot-password/reset`    | the OTP                      |
  | `POST /api/auth/forgot-password/complete` | the attempt counter          |
  | `/two-factor/otp/verify`, signing in      | the attempt counter          |
  | `/two-factor/passkey/verify`              | the ceremony and the counter |
  | `/two-factor/verify-totp`                 | the TOTP step                |
  | `/passkey/delete-passkey`                 | the enrolment grant          |
  | `/oauth/google/callback`                  | the state and Google's code  |

- Each flow now publishes what its retry needs: a new code, a new sign-in, or account recovery again. So the contract is honest, but a user who meets a database fault at that moment must start over.

**Options (the owner's call):**

- Keep the current behaviour.
- When the completing transaction throws, give back the attempt with `attempt.restore()` in `two-factor/otp.ts`, `two-factor/passkey.ts` and `forgot-password/complete`.
  - The answer was correct and its input is already spent, so the refund gives an attacker nothing.
  - The texts can then name the remedy for each method: request an OTP, wait for the next TOTP code, or use another backup code.
- Make each spend atomic with the work that completes the flow. That reshapes each flow, and it is impossible for the OAuth callback, because Google's code is single-use.

---

## 15. [Low] An upload into a folder deleted mid-upload answers 500

**Where:**

- `app/api/dash/media/files/handler.ts`: `POST` passes no `mapError`.
- `lib/media/upload.ts`: `storeUpload` inserts the row after processing the image, outside any wrapper.

**Status:** Read by reviewer `claude` on 2026-10-06, then verified against the code.

**Problem:**

- The folder is checked before the image is processed, and the row is inserted seconds later.
- If the folder is deleted in between, the insert fails its foreign key. The failure reaches `handleApiError`, which answers 500 `uploadFailed`.
- `PUT /files` and `PUT /files/:id` map the same violation to 404 through `handleFolderForeignKeyViolation`.

**Fix:** pass `handleFolderForeignKeyViolation` to the upload route. This is in Phase 1 of `docs/media-file-manager-plan.md`.

---

## 16. [Low] A folder move loads its whole subtree under the library-wide lock

**Where:** `lib/media/folders.ts:171-209` (`subtreeFolders`, `subtreeOf`) and `:389` (`updateFolder`).

**Status:** Read by both reviewers on 2026-10-06, then verified against the code.

**Problem:**

- The cycle check loads every folder row of the moved subtree, only to answer one membership question and read one height.
- It holds `lockTree` meanwhile, and every folder write waits on that lock.
- A depth of 10 and 500 children per folder do not bound the row count.

**Fix:** walk up from the destination, at most `FOLDER_MAX_DEPTH` + 1 rows, and read the height as an aggregate. This is in Phase 6 of `docs/media-file-manager-plan.md`.

---

## 17. [Low] The recursive delete loads every folder and file row of the subtree before it checks the 200 cap

**Where:** `lib/media/lifecycle.ts:305-325`.

**Status:** Read on 2026-10-06.

**Problem:** a tree far over the cap is read in full, only to be refused.

**Fix:** a bounded walk of at most cap + 2 folders and cap + 1 files. This is in Phase 3 of `docs/media-file-manager-plan.md`.

---

## 18. [Low] A failed library upload blocks deleting its folder for up to 24 hours, while the folder lists as empty

**Where:**

- `lib/media/folders.ts:443-450`: the empty-folder delete counts rows of any status.
- `lib/media/lifecycle.ts:328-329`: the recursive delete refuses on non-active rows.
- `lib/media/lifecycle.ts:39`: `PENDING_FILE_TTL` is 24 hours.

**Status:** Read by reviewer `claude` on 2026-10-06, then verified against the code.

**Problem:** a `pending` row is never listed. Even so, the empty-folder delete answers `FOLDER_NOT_EMPTY` and the recursive one `FOLDER_BUSY` until the sweep reaps the row.

**Fix:** a library upload inserts and activates its row within one request, and R2's worst case is under a minute: 3 × (3 s + 15 s), per `lib/r2/client.ts`. So a `pending` row in a folder that is older than 10 minutes is abandoned, and it is deleted with its folder, object included.

- That is the same reasoning and the same bound as `TRANSITION_STALE_AFTER` (`lib/media/visibility.ts:41`), and the two will share one constant.
- A fresh upload still answers `FOLDER_BUSY`.

This is in Phase 3 of `docs/media-file-manager-plan.md`.

---

## 19. [Low] Usage lookups return every referrer row (dormant)

**Where:** `lib/media/usages.ts:35-45` (`usageQuery`), `:66` (`referrers`) and `:89-101` (`usedBy`).

**Status:** Read by reviewer `codex` on 2026-10-06, then verified against the code. It is dormant while `USAGE_SOURCES` is empty.

**Problem:** the query has no limit and no aggregation. A file with many referrers returns them all to the server: in file details, and again in every refused delete.

**Fix:** `EXISTS` for whether a file is used, SQL aggregates for counts, and a capped list in file details. This is in Phase 2 of `docs/media-file-manager-plan.md`.
