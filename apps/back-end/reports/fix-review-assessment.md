# Assessment of the `fix-review.md` implementation (index → working tree)

Baseline: the git index (`git show :<path>`) is the code before the agent ran. Line numbers refer to the working tree.

Status labels:

- **CONFIRMED:** a probe was run, or the code was read and the effect is unambiguous.
- **Read:** traced through the code and not executed.
- **PLAUSIBLE:** the mechanism is real but was not reproduced.

## Defects

### [Medium] `<use>` blow-up bypasses the rendered-node cap; the new id renaming bails out silently and lets it through

- **Where:**
  - `packages/shared/src/images/svg-optimizer.ts:285`: `resolve` in `renderedNodeCount` uses `safeDecodeURI`, which decodes twice.
  - `packages/shared/src/images/svg-ids.ts:51-58`: `fragmentId` decodes once, as the renderer does.
  - `svg-ids.ts:159-160`: `renameReferencedIds` renames nothing at all if any reference can't be restated.
- **Problem:**
  - The renderer resolves `href="#%254C0"` to id `%4C0`. The counter resolves it to `L0`. A cheap `<g id="L0"/>` decoy therefore undercounts every level.
  - The new renaming would hide this, except that one extra element switches it off: `<rect fill="url('#%254C0') /**/ url(https://x.example/a)"/>`. The `/**/` makes `restateCss` return null, the plan is skipped, and the sweep strips that `fill` anyway. The document is accepted.
- **Evidence:**
  - Probe: 20 levels of `<g id="%4Ck">`, each with two `<use href="#%254C(k-1)">`, plus the `L*` decoys.
  - Without the extra element, the upload is refused ("expands to more than 5000").
  - With it, `sanitizeSvgServer` returns valid and the svgo output keeps the chain, about 2²⁰ instances.
  - Not checked in a browser.
- **Scope:** `resolve` is unchanged from the index. But this is the MEDIA-1 class (decoding a reference differently from the renderer), and the new rename step adds a silent failure mode on top of it.
- **Status:** CONFIRMED by probe (server side).
- **Fix:**
  - Resolve fragments in `renderedNodeCount` (and `markerReference`, `:232`) with `fragmentId`, so the renamer, the counter and the renderer model share one decoder.
  - When a rename plan can't be applied, refuse the document instead of skipping it.

### [Medium] New CSS converter writes invalid declarations and ignores overriding shorthands

- **Where:** `packages/shared/src/images/svg-style.ts:366` (declaration conversion), `:639` (attribute writes), `svg-optimizer.ts:618` (integration).
- **Problem:**
  - The converter checks property names but not values. It then writes the winning declaration over any existing presentation attribute.
  - It ignores the `all` and `font` shorthands while applying the longhands they override.
  - CSS drops an invalid declaration before the cascade is decided ([css-cascade-5 §filtering](https://www.w3.org/TR/css-cascade-5/#filtering)). The converter doesn't, so the stored file renders differently from what was uploaded.
- **Evidence (probe through `sanitizeSvgServer`):**

  | Input | Stored | Renders as authored | Renders stored |
  | --- | --- | --- | --- |
  | `<rect fill="blue" style="fill:bogus"/>` | `fill="bogus"` | blue | black |
  | `style="fill:red;fill:bogus"` | `fill="bogus"` | red | black |
  | `style="opacity:.4;opacity:bogus"` | `opacity="bogus"` | 0.4 | 1 |
  | `<style>rect{fill:red} *{all:initial!important}</style><rect/>` | `fill="red"` | black | red |
  | `<text style="font-size:12px;font:20px serif">` | `font-size="12px"` | 20px | 12px |

  The last two columns follow from the CSS rules and were not checked in a browser.
- **Status:** CONFIRMED by probe (stored output).
- **Fix:** drop declarations whose value is invalid for the property before choosing winners, and account for `all` and `font`. Where an exact conversion can't be established, refuse the upload clearly instead of applying a partial cascade.

### [Medium] Any declaration containing `var()` deletes the authored attribute

- **Where:** `packages/shared/src/images/svg-style.ts:374` (`var(` → `null`) and `:635` (a `null` removes the attribute).
- **Problem:** fallbacks and defined custom properties are not resolved. A declaration that uses `var()` erases the presentation attribute it would override.
- **Evidence (probe):**
  - `<rect fill="blue" style="fill:var(--missing, red)"/>` is stored as `<rect width="1" height="1"/>`. The authored SVG renders red ([css-variables-1 fallback](https://www.w3.org/TR/css-variables-1/#using-variables)); the stored one renders black.
  - `<rect fill="blue" style="--c:green;fill:var(--c)"/>` is also stored with no `fill`.
- **Status:** CONFIRMED by probe.
- **Impact:** ordinary exporter or theme output loses explicit colours.
- **Fix:** resolve custom properties and their fallbacks (with inheritance and cycle handling), or refuse the conversion explicitly. Never erase an authored attribute just because the declaration contains `var()`.

### [Medium] Browser preprocessing still deletes SVG definitions, and the new converter widens it

- **Where:**
  - `apps/front-end/utils/images/config.ts:13-16`: `cleanupIds` `minify: true`.
  - `apps/front-end/utils/images/client.ts:22-25`: shared `sanitizeSvg`, then `svgo/browser` `optimize`.
  - Server side: `apps/back-end/lib/media/image/svg.ts:19-24`, where `minify` is now `false`.
- **Problem:**
  - The svgo `cleanupIds` bug (the double `.replace` in `svgo/plugins/cleanupIds.js:240-242`) was disabled on the server only.
  - The shared sanitizer now turns `style="filter:url(#f) url(#fx)"` into a presentation attribute in the browser. The browser optimizer then rewrites it to `filter="url('#a') url('#ax')"` and deletes the `#fx` definition.
  - The server keeps the dangling `#ax`. The back-end fix can't restore a definition the client already dropped.
- **Who hits it:** every normal upload, through `components/shared/file-upload/file-upload.tsx:129` and `components/editor/hooks/use-upload-file.ts:76`. Uploads lose authored effects permanently, and server-only tests can't detect it.
- **Rule broken:** consumer tracing and one implementation per concern. `packages/shared` runs in both consumers.
- **Status:** CONFIRMED by probe with the front-end config. Plain-attribute references were already affected before this change.
- **Fix:** one optimizer policy shared by browser and server (`minify: false` on both), plus a test of the full browser → server pipeline with several references and overlapping ids. The front-end edit belongs to the front-end session.

### [Medium] A verify cut by the deadline tells a user with a correct code that it is wrong, and nothing logs it

- **Where:** `db/transaction.ts:191-193` and `lib/otp/verify.ts:79-89`.
- **Problem:**
  - A `statement_timeout` (57014), or a check that finds no time left, is replaced by a new `TransactionDeadlineError`. That error carries no `cause` and writes no log line. `transactionWithin` maps it to `invalidOrExpiredCode()`, a 400.
  - `handleApiError` logs only 5xx, so the event is invisible. Only the pool-acquisition branch (`:43`) logs.
- **Failure scenario:**
  1. A verify waits behind a send for the same user that is held in the SQLite budget charge (up to about 2 s).
  2. The verify hits its 2250 ms deadline.
  3. The user is told "invalid or expired, request a new code". The operator gets no signal.
  - The agent's own test (`otp-timing-oracle.test.ts:548-620`) shows a seeded correct code refused this way.
- **Rule broken:** "Fail clearly. No fallback that hides a failed operation." The generic answer is right for the threat model; hiding the failure from the operator is not.
- **Status:** Read.
- **Fix:** keep the generic 400. Before rethrowing, log once (route/purpose, elapsed time, no identifier), and keep the original error as `cause`.

### [Low] `indisvalid` scoping fails open on Unicode whitespace and on `\r`-terminated comments

- **Where:** `db/migration-ledger.ts:152` (`CONCURRENT_INDEX`) and `:111-114` (`withoutSqlComments`).
- **Problem 1 (Unicode whitespace):**
  - With the `u` flag, `\s` matches U+00A0, U+2000–200A, U+3000 and U+FEFF. PostgreSQL treats every byte ≥ 0x80 as an identifier character.
  - So `create unique index concurrently if not exists <NBSP>idx on t (k)` builds the index `" idx"`, while the matcher scopes the check to `idx`.
  - The comment at `:147-148` notes the NBSP problem after the name only.
- **Problem 2 (comments):** `withoutSqlComments` ends a `--` comment at `\n` only, but PostgreSQL also ends one at `\r`. `create unique index --x\rconcurrently "Real" on t (k) where k::text <> '\ncreate index concurrently decoy on\n'` scopes the check to `decoy`.
- **Failure scenario:**
  1. The build fails and leaves an INVALID index.
  2. On the next run, `IF NOT EXISTS` skips it, and `invalidIndexes` filters on the wrong name.
  3. The file is recorded as applied. This is the permanent trap DB-2 exists to prevent; the database-wide check it replaced could not miss it.
- **Status:** the JS side is CONFIRMED by probe. The PostgreSQL side was read from its lexer rules and not run.
- **Fix:**
  - Spell every gap in the pattern as `[ \t\n\r\f\v]+`, as the delimiter after the name already does.
  - End line comments at `\r` too.
  - Add an NBSP-before-name row to the failed-build-then-retry `test.each`.
- The agent's claim that "anything else falls back… so it fails closed" is therefore false for these inputs.

### [Low] DB-2 still unresolved for quoted index names

- **Where:** `db/migration-ledger.ts:152`.
- **Problem:** a quoted name such as `CREATE INDEX CONCURRENTLY IF NOT EXISTS "Ledger_Quoted" …` is not scoped. It falls back to the database-wide check, so an unrelated invalid index (a failed `REINDEX CONCURRENTLY`, or a build in progress elsewhere) still blocks the deploy. That is the nuisance DB-2 asked to remove. The agent's test `tests/process/sql-migration-ledger.test.ts:311` asserts the refusal.
- **Status:** CONFIRMED (read; the test pins it).
- **Fix:** parse quoted identifiers (with `""` escapes, exact case) and scope to them. Keep the fallback only for syntax that is genuinely unsupported.

### [Low] An expired transaction deadline can still commit

- **Where:** `db/transaction.ts:183-193`.
- **Problem:** the deadline is checked before the transaction and before each statement (`cutAt`), but not after `fn` returns and before COMMIT. There are two gaps:
  - **A callback that awaits non-database work after its last statement** commits past the deadline.
  - **A callback that catches a cut** commits. A pre-statement `TransactionDeadlineError` (the "no time left" check) leaves the transaction un-aborted. A nested cut that is caught after `ROLLBACK TO` has restored it, so the earlier writes commit.
- **Effect:** the docblock's guarantee, "runs for at most `deadline` plus the rollback", is false.
- **Status:** Read.
  - The independent review reports PostgreSQL probes committing at about 1241 ms and 775 ms against a 500 ms deadline. Those probes were not re-run here.
  - No current caller is affected: the `onVerified` callbacks in `otp/verify`, `forgot-password/reset` and `passwordless` issue only database statements and catch nothing inside the transaction.
- **Fix:**
  - Check the deadline inside the outer transaction callback, after awaiting `fn` and before returning to COMMIT.
  - Remember that a cut happened, so that swallowing one can't permit the outer commit.
  - Add both cases to the deadline tests.

### [Low] Google token exchange has no timeout

- **Where:** `lib/auth/oauth/plugin.ts:388-398`: `googleProvider.validateAuthorizationCode(...)`.
- **Problem:** `@better-auth/core` 1.7.3 calls `fetchRefusingRedirects(tokenEndpoint, { method, body, headers })` with no `timeout` (`validate-authorization-code.mjs:64-68`). `@better-fetch/fetch` 1.3.1 arms its abort timer only when `timeout` is set (`dist/index.js:373-374`). A stalled Google token endpoint therefore holds the callback request for as long as the runtime allows.
  - Bun's default fetch timeout was not checked.
  - The independent review reports a transport still pending at 5.5 s; not re-run here.
- **Scope:** this already existed in the index version, but the agent rewrote this call site, and CLAUDE.md requires sweeping outbound calls without a timeout. The new 5 s JWKS bound doesn't cover the request before it.
- **Fix:** run the exchange with an abort signal that actually cancels the transport, keeping PKCE, client authentication and redirect refusal. Racing a promise against a timer leaves the request running.

### [Low] ID-token verifier reports an unsupported `crit` header as a signing-key outage

- **Where:** `lib/auth/oauth/id-token.ts:33-42` (`TOKEN_FAILURES`) and `:91-94`.
- **Problem:** jose 6.2.12 throws `JOSENotSupported` for an unrecognised `crit` parameter (`lib/validate.js:76-78`). `JOSENotSupported` is not in `TOKEN_FAILURES`, so a token with `{ crit: ['probe'], probe: true }` becomes `GoogleProviderFault('signing_keys_unavailable')`: a 500 and an error-level "key outage" line, where the library verifier answered `null` (401).
- **Reachability:** the token arrives only through the Google exchange; no route accepts an ID token directly.
- **Status:** read from source. The independent review reports a probe.
- **Fix:** refuse a token with any `crit` header as an identity refusal before verification. Don't map every `JOSENotSupported` to a refusal, because that would hide real key-format faults.

### [Low] OTP send now holds the user row `FOR UPDATE` across the SQLite busy wait

- **Where:** `lib/otp/send.ts:119` (`lockUser`), held across `:264` → `lib/rate-limit/store.ts:160-173` (a retry loop of up to `BUSY_TIMEOUT_MS`).
- **Problem:** every send, including one the cooldown is about to refuse, now locks the user row first and can keep it for about 2 s. `FOR UPDATE` conflicts with `FOR KEY SHARE`, so these all queue behind it for that user:
  - the sign-in session insert (foreign key);
  - every audit row (foreign key);
  - `lockEligibleAuthUser`;
  - verifies of every purpose.
- **Failure scenario:** a `forgot_password` verify queues behind a `verify_contact` send, trips its deadline, and lands in the Medium entry above.
- **What the agent's report missed:** its "Cost" note names only the busy timeout.
- **Status:** Read. No lock cycle was found; every writer of verification rows that was checked takes the user first.
- **Fix:** lock with `FOR NO KEY UPDATE`. It still serialises with verify's `FOR UPDATE` but lets foreign-key inserts through.

### [Low] `statement_timeout` introduced against a documented owner deferral; the deferral comment is now false

- **Where:**
  - `db/transaction.ts:112`: `set_config('statement_timeout', …, true)`.
  - `db/index.ts:26-31`: "No `statement_timeout`, deliberately…".
  - `reports/should-ignore.md` known issue #2.
- **Problem:** anonymous verify transactions now run under a ceiling of about 2.25 s. That turns a slow request into a failed one, which is exactly what the deferral warns against. The agent's report doesn't mention the conflict.
- **Status:** CONFIRMED (code and comment read).
- **Fix:** get the owner's sign-off. Then add one clause to `db/index.ts` and to issue #2 that names the scoped exception.

### [Low] `REAUTH_REQUIRED` 401 published on table routes only, not on the Better Auth endpoints that throw it

- **Where:** `lib/http/openapi/better-auth-tables.ts:49-50` and `lib/http/openapi/better-auth.ts:338-347`. Only `/two-factor/totp/confirm` gets a per-path detail.
- **Problem:** these endpoints can answer 401 `REAUTH_REQUIRED` (via `reauthenticationRequired()`, called from `enrolment.ts` and `otp.ts:164`):
  - `/two-factor/get-totp-uri`
  - `/two-factor/totp/start`
  - `/two-factor/generate-backup-codes`
  - `/two-factor/backup-codes/acknowledge`
  - `/two-factor/methods/disable`
  - `/two-factor/disable`
  - `/two-factor/passkey/grant`
  - `/two-factor/otp/send`

  Their published 401 still reads "Credentials refused, or the session … not allowed to exist". The review's fix was "derived from the route's `reauth` flag so the whole class gets it", and `docs/two-factor-flow.md` §6 is about exactly these endpoints.
- **Status:** Read.
- **Fix:** add the 401 detail for every path in `BETTER_AUTH_PASSWORD_LOCKOUT_PATHS`, and add an assertion to `openapi-contract.test.ts`.

### [Low] `url()` tokenizer doesn't model CSS comments; only an svgo-compatibility step blocks the bypass

- **Where:** `packages/shared/src/images/config.ts:198-267` (`urlFunctionSpans`) and `:277-282` (`isDangerousValue`).
- **Problem:**
  - Take `fill="/*url('#*/url(https://evil.example/x)/*')*/"`. CSS reads a comment, then a real `url(https://evil.example/x)`.
  - The tokenizer opens a string at the `'` inside the comment and reads one local target, `#*/url(…)/*`.
  - `isDangerousAttribute` returns `false`. The document is refused only because `canonicalLocalUrls` (strict, `:450-454`) returns null. That step exists for svgo compatibility, covers presentation attributes only, and is not documented as a security boundary.
- **Status:** CONFIRMED by probe (`isDangerousAttribute('fill', v) === false`).
- **Fix:** skip `/* … */` outside strings and url tokens in `urlFunctionSpans`, or at minimum state at `canonicalLocalUrls` that its strictness is what blocks this.

### [Low] HTTP-2 sweep incomplete: two sites still log twice for one 5xx

- **Where:**
  - `lib/media/upload.ts:390-396` (`settleKeyCollision`): `logSanitized('error', …)`, then `throw new CustomError(mediaMsg.storeFailed, 500)` with no `cause`.
  - `db/transaction.ts:43-59`: the unbounded pool-timeout branch calls `logLine('error')`, then throws a 503 with no `cause`.
- **Problem:** `handleApiError` adds a second "server error response" line in both places. The review's fix for the upload path ("pass `cause` and drop the separate log calls") was applied to three sites, not this fourth one.
- **Status:** CONFIRMED (read).
- **Fix:**
  - `settleKeyCollision`: throw with `cause` and drop the `logSanitized` call.
  - Pool timeout: same on the unbounded branch only. The bounded branch keeps its line, because no 5xx follows it.

### [Low] #57 kept as a stub, against the owner's instruction to delete it

- **Where:** `reports/should-ignore.md:132-133`: "57. **Retired.** …".
- **Problem:**
  - `fix-review.md` records the owner's decision: "Delete #57 from `should-ignore.md`".
  - The agent's stated reason (keeping later numbers stable) doesn't require a stub: the list numbers are literal in the source, and references are made by literal number.
  - The departure is not listed in `fix-review-disagreements.md`.
- **Fix:** delete lines 132-133.

### [Low] Known issue #15 expanded with a more serious consequence and filed as accepted

- **Where:** `reports/should-ignore.md:273-274`.
- **Problem:** the edited entry now says a session that only reads "keeps a revoked read grant until it expires, not for #5's 5 minutes". If that is true, revoked access can last a whole session. It was filed under owner-accepted issues without an owner decision. `fix-review.md` did not ask for this edit.
- **Status:** the cookie-name-only check (`checker.ts:179-194`) supports the claim. "Until it expires" was not verified.
- **Fix:** revert the expansion and raise it with the owner as an open finding.

### [Low] Stale or false documentation left by the change

- **`reports/coolify-deployment.md:1720-1735` (§8d):**
  - It names a test, "stays under the floor", that doesn't exist.
  - It describes a margin model that `floorDeadline` replaced ("about 200 ms of margin"; raise `KNOWN_BRANCH_WORK_MS` "until it passes").
- **`lib/http/timing-floor.ts:11`:** "Measured in `otp-timing-oracle.test.ts`" is false. No test measures `KNOWN_BRANCH_WORK_MS`.
- **`docs/oauth-sign-in.md:144-146` and `:158-159`:** they still say the plugin uses the library's ID-token verifier, and that JWKS failures collapse to a null verdict. With `id-token.ts`, a JWKS failure answers a logged 500 (`signing_keys_unavailable`).
- **Fix:** rewrite §8d around the current tests and the real open question (database round trip versus `FLOOR_SETTLE_MS` on the VPS), drop "Measured in", and update both oauth doc passages.

### [Low] Published grant description promises a session binding the server doesn't enforce

- **Where:** `packages/shared/src/validation/two-factor.ts:164, 170`. It is published on the `/passkey/delete-passkey` body.
- **Problem:** `mintReauthGrant` stores `value: userId`, and `consumeReauthGrant` checks only that (`lib/auth/reauth/grant.ts:28-31, 46`). So a grant minted in session A is accepted from any other session of the same user. The review's wording made the same mistake.
- **Also:** "valid for 10 minutes" repeats `REAUTH_GRANT_MAX_AGE_S` as a literal, and `max(200)` matches nothing real (a grant is always 32 base64url characters).
- **Fix:** say "bound to this account" and derive the bounds and lifetime from the source constants. Binding the grant to the session for real would be a separate, deliberate change.

### [Low] `route-auth-flags.test.ts` is a source grep with blind spots, and the agent's claim overstates it

- **Where:** `tests/unit/route-auth-flags.test.ts:20-23, 36-47, 71-111`.
- **Problem:** each of these lets a route go undeclared silently:
  - Code above the first export is attributed to no method. For example, `users/[id]/sessions/handler.ts:46` (`authorizeSessionAccess`) calls `requirePermission`; adding `reauth: true` there would not fail the test.
  - Code after the last export is attributed to the last method.
  - The primitive-caller check matches only `requireReauthWindow|verifyLoginAttempt`. A new lib module calling `verifySessionPassword`, `verifyReauthPassword`, or `requirePermission(…, { reauth: true })` is not flagged.
  - The Better Auth check sees only direct calls inside a `createAuthEndpoint('…'` slice.
- **Effect:** the claim "a new indirect caller fails until it is listed" does not hold.
- **Fix:** make `reauth`/`checksPassword` required on `RouteDefinition`, or widen the primitive list and attribute pre-export helpers to every method that calls them.

### [Low] OAuth state pattern comment overclaims; a signed-in user can force a 500 with two error-level lines

- **Where:** `lib/auth/oauth/plugin.ts:345-347`: `^[\w-]{32}$`, "can never name one of this application's verification rows".
- **Problem:** Better Auth's passkey challenge rows use a 32-character `[A-Za-z0-9_-]` identifier (`@better-auth/passkey/dist/index.mjs:185,193`).
- **Failure scenario:**
  1. A signed-in user calls `generate-register-options`.
  2. They pass the value of their own `better-auth-passkey` cookie as `state` to `/oauth/google/callback`.
  3. `stateDataSchema.parse` throws a `ZodError`, not a `StateError`, so `isLostState` is false.
  4. The answer is a 500, logged twice at `error` (`oauth.signIn.failed` plus "Failed to parse state"). Nothing is deleted.
- **Status:** PLAUSIBLE (read from the installed source; not executed).
- **Fix:** answer a `parseState` failure that isn't a database fault as a refusal, or correct the comment and accept the gap.

### [Low] Writer-lock startup gate: weak test, and the failure bypasses the gate's own error path

- **Where:** `tests/process/startup-gates.test.ts:338-346` and `server.ts` (the claim before `listen`).
- **Problem:**
  - The test asserts only `exitCode !== 0` and that "server started" is absent, so any unrelated boot failure passes it.
  - A claim failure (for example, a directory at `.writer-lock.db` makes `openConnection`, `writer-lock.ts:31`, throw a raw `SQLITE_CANTOPEN`) ends the process with an uncaught top-level throw. Every other gate in `server.ts` logs `startup rejected` through `fail()`.
- **Fix:**
  - Assert the cause in the test (`SQLITE_DIR` or the SQLite open error).
  - Route the claim failure through `fail()`.

### [Low] MEDIA-5: the grant check now runs after the admission charge and the visibility check

- **Where:** `app/api/upload/file/handler.ts:56-68` → `lib/media/upload.ts:533`.
- **Problem:** a caller without the publish grant:
  - spends `UPLOAD_ADMISSION_LIMIT` before getting the 403;
  - gets 422 `visibilityDisabled` instead of 403 when the public bucket is off.
- **Impact:** no effect today, because `UPLOAD_PURPOSES` is empty.
- **Fix:** export a `requireTargetGrant` that routes call before admission and `acceptUpload` re-asserts, or document the new order.

### [Low] New per-element attribute limit counts `=` in text content

- **Where:** `packages/shared/src/images/svg-optimizer.ts:472-486, 561-564`.
- **Problem:** counting runs from `<` to the next `<`, so text and quoted values are counted.
- **Evidence (probe):**
  - A `<text>` holding 300 `a = b;` is refused with "an element in the SVG has 300 attributes (max 256)".
  - `<text>` followed by 257 `=` is refused the same way, and so is the `<metadata>` variant. The index version accepts both.
- **Status:** CONFIRMED by probe.
- **Fix:** count only inside opening tags (up to their `>`), outside quoted values, comments, CDATA and processing instructions, in one bounded linear scan.

### [Low] Passkey re-auth: the new deadlock 503 invites a retry that cannot succeed

- **Where:** `lib/auth/reauth/plugin.ts:146-149` (the challenge is consumed outside the transaction) and `:205` (`isDeadlock` → `databaseContended`). The published text for the 503 is "retry after `Retry-After`".
- **Problem:** a 40P01 inside the transaction answers 503. The retried assertion finds the challenge already consumed and gets 401, so the user has to restart at `/reauth/passkey/options`. The comment at `:202` ("any other failure is a denial") is also no longer accurate.
- **Status:** PLAUSIBLE.
- **Fix:** consume the challenge inside the transaction, or say in this path's 503 text that the ceremony must restart.

### [Low] Redundant in-transaction check, and comments attached to the wrong code

- **`app/api/dash/users/[id]/two-factor/handler.ts:102-108`:** the in-transaction `assertTargetUserVisibleUnlocked` repeats the prefilter at `:75-97`, with only `getAuditMeta` between them. Both checks are unlocked, so it adds a round trip and no protection. The comment above it ("Locked first, keeping the canonical order…") describes the `lockTargetAndActor` call, not this one.
- **`app/api/dash/users/[id]/sessions/handler.ts:198-205`:** "The self case too…" sits on `if (!isSelf) await assertTargetUserVisibleUnlocked(...)`, which skips the self case. The comment belongs on `lockTargetAndActor` at `:206`.
- **`lib/http/openapi/better-auth.ts:144-160`:** `withDescription` was inserted between `withAlternativeJsonBody` and its JSDoc. The `anyOf`, never `oneOf` invariant now documents the wrong function.
- **Fix:**
  - Drop the duplicate check in the two-factor handler.
  - Move the sessions comment to `:206`.
  - Move `withDescription` above or below the documented function.

### [Low] Comments that are false, or not corrected as asked

- **`lib/otp/throttle.ts:112-118`:** "None depends on whether the account exists" also covers 500 and 503. Only a known account reaches a fault inside `processOtpVerify`'s transaction, and that includes the new 40P01 → 503. The comment should claim only 429, 422, and 5xx raised before the lookup.
- **`lib/auth/index.ts:116-117`:** the review asked for this comment to be corrected. It is byte-identical to the index version and still doesn't say that the library's `error` level carries caller-triggered refusals, which the callback demotes.
- **Rules broken (comments):**
  - `config.ts:395`: "`encodeURIComponent` leaves the apostrophe alone" describes language behaviour.
  - `rate-limit/index.ts:66-67`: "one line, not two" is a change note.
  - `lib/auth/oauth/id-token.ts:48-59`: the docblock lists the checks, which restates the code. Only the first sentence and the `kid` trap are worth keeping.
  - `plugin.ts:521` and `:559-560`: the same Location comment appears twice.

### [Low] Tests that no longer test the shipped path

- `tests/integration/oauth-review-regressions.test.ts:589-604` still imports Better Auth's `verifyGoogleIdToken` and asserts it accepts a token without `exp`. The callback no longer calls that function.
- **Fix:** assert against `lib/auth/oauth/id-token.ts`, or drop the library half.

### [Low] `cutAt` Proxy is typed as the full client but serves only three members

- **Where:** `db/transaction.ts:73-138`.
- **Problem:** the Proxy is typed as `C` but intercepts only `unsafe().then`, `.values()` and `savepoint`. If Drizzle (pinned at 0.45.2) starts using another member:
  - a tagged-template call runs without the deadline;
  - `.raw()` throws a `TypeError`, which becomes a 500 on anonymous verify.
- **Rule broken:** "Earn every invented type." One test is the only guard.
- **Fix:** narrow the declared type to the members it serves, or add an exhaustive member test.

### [Low] Duplicated logic introduced against "one implementation per concern"

- There are three `url()` parsers that disagree with each other:
  - `urlFunctionSpans` (`config.ts:198`);
  - `markerReference` (`svg-optimizer.ts:219-234`);
  - `stringEnd`/`bareUrlEnd` (`svg-style.ts:159-187`).

  `markerReference` reads `url(\22#m\22)` as local `#m`, where `urlTargets` reads it as external. It also double-decodes, so `marker-start="url(#%2561)"` is stored retargeted when renaming is off. No breakage today, because the sweep runs first.
- `tests/process/sql-migration-ledger.test.ts:119-128` copies `runMigrate`'s spawn-and-collect (`:63-76`).
- `db/migration-ledger.ts:219-225` repeats the `to_regclass(...) is not null` probe from `scripts/migrate.ts:127-134`.
- `config.ts:136-137` and `:167-168` write the same padding-trim loop twice.
- `lib/auth/passwordless.ts:68, 96, 117, 216-218` hand-rolls `startFloor`/`floorDeadline`/pad instead of sharing `withTimingFloor`'s logic.
- **Fix:**
  - Build `markerReference` on `urlFunctionSpans` plus `fragmentId`.
  - Extend `runMigrate` to return stderr.
  - Export one `tableExists(client, name)`.

## Claims in `fix-review-disagreements.md` that do not hold

- **"JWKS fetch failure" open item:** stale. The agent's own `id-token.ts` already separates a JWKS failure (500) from a bad token (401). Delete it.
- **"Limit: the bound is per statement, not cumulative":** wrong. `cutAt` resets `statement_timeout` to the time left before every statement, so the bound is cumulative.
- **"The contention test now times the known branch itself":** stale. The test now asserts floored answers and eventual issuance.
- **"Cost: `processOtpSend` holds the user row across the SQLite budget charge":** incomplete. See the `FOR UPDATE` entry above.
- **indisvalid "fails closed" for anything not read in full:** false for Unicode whitespace and `\r` comments.
- **Re-auth flags: "a new indirect caller fails until it is listed":** overstated. See the `route-auth-flags.test.ts` entry.
- **#57 "its number is kept, so the later entries … still point where they did":** keeping the number doesn't require keeping a stub. The owner said delete.
- **"You also chose to convert `style=` to presentation attributes":** can't be checked against `fix-review.md`, which never asks for it. See the out-of-scope table.

## Out-of-scope changes (not required by `fix-review.md`)

| File | Change | Impact | Keep / revert |
| --- | --- | --- | --- |
| `lib/otp/anonymous-send.ts:57-129`, `lib/http/timing-floor.ts:51-53` | Sends answer at the floor; issuance finishes after the response | Known and unknown sends take the same time even with unbounded PostgreSQL waits. Issuance failures were already swallowed into the generic success in the index version. | Keep |
| `lib/http/after-response.ts:19-40` | A task enqueued after the queue drained now runs at once and is tracked for shutdown; such tasks were silently dropped before | Required by the row above; its only caller is the anonymous send | Keep |
| `db/transaction.ts` (deadline, `cutAt`, `TransactionDeadlineError`), `lib/otp/verify.ts:79-89` | Verify transactions are cut at the deadline and answered as an unknown identifier | Rolled back with no attempt charged; `set_config(…, true)` is transaction-local; savepoints covered. Overrides the `statement_timeout` deferral. | Keep after the logging, owner sign-off and typing fixes above |
| `lib/otp/send.ts:76, 119` | `lockUser` first in send and refund | Users-first order; foreign-key inserts block (see entry) | Keep, using `FOR NO KEY UPDATE` |
| `lib/rate-limit/store.ts:148-173`, `fixed-window.ts`, `index.ts:167`, `lib/sqlite/database.ts:51-64`, `driver.ts:66-75` | The global budget charge retries on a timer instead of a blocking busy wait; `isSqliteBusy` is shared | Required by the cut-off | Keep |
| `db/transaction.ts:53-58`, `db/limits.ts:29` | Pool 503 now carries `Retry-After: 2` | Additive contract change | Keep |
| `lib/maintenance/database.ts:190-195` (`sweepExpired`, called at `:323-334`) | Candidate subquery gains `FOR UPDATE SKIP LOCKED` for every caller: `verification_codes`, `verifications`, `trusted_devices` and `sessions`, not only the OTP proof rows the contention work needed | Locked expired rows survive until a later run; a batch below `BATCH_SIZE` can end the loop with `hasMore: false` while rows remain | Keep; document `hasMore` as "nothing deletable right now" and rely on the periodic sweeps |
| `lib/maintenance/database.ts:259-296` (`sweepVerificationSessions`) | A transaction that takes `FOR NO KEY UPDATE OF users SKIP LOCKED` on up to 500 owners | The nightly sweep briefly blocks sign-in and writes for those users. Correct only if every `verification_sessions` writer locks the user first (not verified for all). | Keep only together with the verify-deadline rework |
| `package.json:52`, `bun.lock`, new `lib/auth/oauth/id-token.ts` | Google ID tokens verified in-house with `jose`, replacing `verifyGoogleIdToken` | Same checks as Better Auth 1.7.3, and nonce is now always required. A JWKS outage becomes 500 instead of 401. Duplicate matching keys, or a token with no `kid`, are refused instead of trying every candidate key. An unsupported `crit` is misread as an outage (see entry). Security-sensitive code is now owned here; `jose@6.2.12` was already installed as a transitive dependency. | Owner decision. Keep only if the owner wants its own verifier; otherwise revert. |
| `lib/auth/oauth/plugin.ts:153-187, 388-398` | `invalid_grant` → 401 refusal at `warn`; other token-endpoint errors and 5xx → 500 | Misconfiguration (`invalid_client`) no longer reads as a refused sign-in | Keep |
| `lib/auth/oauth/plugin.ts:118-143, 519-537` | Infrastructure faults classified first: 500/503 with no `Location`, even when a `callbackURL` exists | A browser hitting a transient fault now lands on raw JSON at the callback (the REC-3 symptom), where before it was redirected | Keep the classification; the owner decides whether faults need a landing page |
| `lib/auth/errors.ts:43-53`, `response.ts:136-145`, `reauth/plugin.ts:205` | 40P01 → 503 with `Retry-After` at every boundary | The lock-order backstop. A deadlock in the OAuth path logs two `error` lines. | Keep |
| `lib/auth/oauth/plugin.ts:347` | `state` narrowed from 1-128 characters to `^[\w-]{32}$` | A malformed state answers 400 JSON with no lost-state redirect | Keep; fix the comment |
| `lib/auth/oauth/plugin.ts:375-385` | Named refusal reasons; a user cancelling at Google logs `warn`, not `error` | Log level only | Keep |
| `lib/auth/index.ts:47-71` | "Failed to parse state" demoted by `StateError` code | Same class as AUTH-1, narrowly matched | Keep |
| `oauth-review-regressions.test.ts` | Two tests flipped (302 → 500, 401 → 500) | Follows the fault classification | Keep with it |
| `packages/shared/src/images/config.ts` | `%` read literally in `url()`; escaped quotes open no string | `url(%23a)` and `url(\22#a\22)` are now stripped (both are relative fetches in CSS) | Keep |
| `svg-optimizer.ts:711-724` | Tokenizer plus `canonicalLocalUrls` refusal | New 400s for inputs accepted before (`fill="url(#a"`, or a comment next to `url(`) | Keep (load-bearing for the comment-bypass entry) |
| `config.ts:31-32`, `svg-style.ts:55-64` | New limits: 10,000 attributes per document, 256 per element, 2M style offers, plus 1,000 selectors and 4,000 selector parts or entries per sheet | Attribute and offer limits refuse the upload. A sheet over its selector or entry limits is silently not converted, so its styling is dropped. The per-element count is wrong (see entry). | Keep with the counting fix; refuse an over-limit sheet clearly instead of dropping its styling |
| new `svg-style.ts` (644 lines; runs in the browser too) | `style=` and `<style>` converted to presentation attributes, where the index version stripped them | Exporter colours survive, but the converter writes invalid values, ignores `all`/`font` and erases attributes on `var()` (the three Medium entries above). Probes found no URL bypass. | Revert until those defects are fixed and verified, unless the owner confirms they asked for it; `fix-review.md` did not |
| new `svg-ids.ts` | Non-plain referenced ids renamed to `sid-N`, and local `href`/`url()` references rewritten | Stored ids differ from the upload; the silent bail-out enables the Medium bypass | Keep with the refuse-on-bail-out fix; document the stored-id contract |
| `lib/media/image/svg.ts:19-24`, `config.ts:433` (`canonicalLocalUrls`) | svgo `cleanupIds` `minify: false`; local `url()` references parsed and restated in a canonical spelling | Stored ids and attribute text change. The svgo bug is real. Extends the raster canonicalisation the review asked for to every local reference. | Keep; apply the same policy on the front end (see the browser-preprocessing entry) |
| `svg-optimizer.ts:404-428, 787` | `withDefaultNamespaceRoot`: the root is rebuilt in the default namespace and redundant `svg:` prefix bindings are dropped | Inkscape files with `xmlns:svg` are accepted again; serialised namespace declarations differ from the upload | Keep; namespace-specific sanitizer checks must still run on the original form |
| `rate-limit/index.ts:63-81`, `tests/unit/client-ip.test.ts:229-230` | `ipIdentifier` context moved into the 503's `cause` | Logged once; every caller reaches `handleApiError` | Keep |
| `permissions/[id]/handler.ts:346-351` | Member lock is unconditional and id-ordered (previously only under `REQUIRE_ROLE_FOR_LOGIN`) | More rows locked when the flag is off | Keep |
| `lockActor` in role PUT, role DELETE and user POST | The actor's row is held `FOR KEY SHARE` for the whole transaction | The actor's own sign-in and self-service writes wait behind that admin write | Keep (it is what makes users → roles hold) |
| `users/[id]/sessions/handler.ts:206` | Self revocation now takes `FOR SHARE` on the caller's row | Waits behind the same user's sign-in or password change; closes a real cycle | Keep |
| `lib/auth/session/rotation.ts:202-209` | `forUserId` added to the unlink audit metadata | Audit row shape changes | Keep (needed for 2FA-5) |
| `reports/should-ignore.md` #15 | Entry rewritten with a new, more serious consequence | Files an open security question under accepted issues | Revert; raise with the owner |
| `reports/coolify-deployment.md:1720-1735` (§8d) | New VPS measurement step | Routing is right; content is stale | Keep the step, rewrite the content |
