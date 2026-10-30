# Back-end audit (Opus 5.5)

Whole-codebase audit of `apps/back-end` and the `packages/shared` sources it imports, against `CLAUDE.md`. Paths are relative to `apps/back-end/`; `shared/` means `packages/shared/src/`.

Entries are numbered in one sequence: findings by severity, then improvements by gain against cost, then stale owner entries. Fixed entries are removed without renumbering, so a number always names the same entry.

## Findings

### 11. Passwordless sign-in, recovery grants and 2FA challenges can outlive a credential rotation

- **Severity:** Low.
- **Where:** `lib/auth/passwordless.ts:96-145` (`createSession` after `processOtpVerify` commits, no lock, no `authRevokedAt` check); `modules/auth/recovery.ts:260-266` (grant minted after the OTP transaction commits); `lib/auth/two-factor/issue.ts:253-274` (challenge rows written with no user lock; completion at `challenge.ts:315-334` only checks the row exists).
- **Evidence:** traced; a race of a few milliseconds. Owner entries should-ignore Known #1 and the TODO "Stale login proof…" defer the race "until session creation is project-owned". That reasoning no longer holds for these paths: passwordless is a project endpoint, and the OAuth callback already does the fix with Better Auth's own `createSession` — `withAuthTransaction`, `lockEligibleAuthUser`, refuse when `authRevokedAt >= startedAt`, create inside the same transaction (`lib/auth/oauth/identity.ts:114`, `lib/auth/oauth/plugin.ts:430-470`); the re-auth window does the same (`lib/auth/reauth/window.ts:41-48`). The planned `authVersion` already exists as `users.authRevokedAt` (`lib/auth/session/rotation.ts:161`). Only the Better Auth-owned insert in `/sign-in/email` still needs the library.
- **Failure scenario:** an attacker holding a first factor completes passwordless verify while the owner or an admin rotates the account; the session (or grant, or challenge) is created after the rotation and survives it.
- **Remediation:** take `authenticationStartedAt()` before the verify; in passwordless, run `createSession` and the challenge issue inside `withAuthTransaction` under the user lock with the `authRevokedAt` check, as OAuth does; mint the recovery grant and write challenge rows under the same lock and check.

### 14. Password re-authentication on 2FA management routes skips the shared re-auth budget

- **Severity:** Low.
- **Where:** `lib/auth/reauth/password.ts` (`verifyReauthPassword`), reached from `requireReauthPassword` (`lib/auth/reauth/grant.ts:51-67`; callers `lib/auth/two-factor/enrolment.ts:118,295,366,427,589,616`, `two-factor/otp.ts:151`) and the `/two-factor/get-totp-uri` branch (`lib/auth/path-policy.ts:326`).
- **Evidence:** `lib/auth/reauth/session.ts:20-23` says one budget covers every re-auth proof, but `enforceReauthAttemptLimit` is called only by the passkey ceremony (`reauth/plugin.ts:58,90`) and the `/api/dash/auth/reauth` binding. The eight paths above charge nothing beyond per-IP pre-auth (20–30 per minute each, no captcha).
- **Impact:** the account lockout (5 failures, 5 minutes) still bounds guessing, so a session thief gains nothing. A signed-in user who knows their own password can drive Argon2 (64 MiB, t=3) across eight paths and many IPs with no per-user cap, while sign-in requires Turnstile.
- **Remediation:** call `enforceReauthAttemptLimit(userId)` once inside `verifyReauthPassword`; both uncharged paths go through it.

### 15. Valid-looking Office files with embedded objects pass, against the published contract

- **Severity:** Low.
- **Where:** `lib/media/office/ooxml.ts:44` (`PAYLOAD_PART` matches only `embeddings/`, `activex/`, `vbaProject.bin` by name), `:46-47` (declared content types), `:377-397` (only `[Content_Types].xml` is read, never a `.rels` part); contract `shared/validation/media.docs.ts:33` ("object-embedding variants are refused").
- **Evidence:** an embedded package at `word/objects/` passes while the same part at `word/embeddings/` is refused; an `oleObject` `.bin` declared as `application/octet-stream`, an altChunk RTF with `\objdata` and an altChunk MHT all pass. What makes a part an embedded object is the relationship pointing at it, not its folder.
- **Attacker:** a signed-in holder of `media.create`; victims are staff who download the file. Not verified: that Word activates such parts (activation also needs the victim to leave Protected View and double-click).
- **Remediation:** read every `.rels` part through the existing capped `readEntry` and refuse relationship types `oleObject`, `package`, `control`, `aFChunk`, `vbaProject`, `wordVbaData`; the folder regex can then go.

### 17. Google sign-in fails if the server clock runs even a second behind Google

- **Severity:** Low.
- **Where:** `lib/auth/oauth/id-token.ts:94-116` (`verifyGoogleIdToken`).
- **Evidence:** `jwtVerify` gets no `clockTolerance`, and `exp` is re-checked by hand with none. jose 6.2.14 refuses an `iat` in the future: `iat` now+1 s and now+2 s gave `JWTClaimValidationFailed` with these options, and passed with `clockTolerance: 30`. The error is in `TOKEN_FAILURES`, so it is answered as a denial and logged as `id_token_invalid`. Better Auth's own verifier uses 30 s.
- **Impact:** a VPS clock behind Google's by more than the code-exchange latency refuses every Google sign-in, logged as a bad token. `reports/coolify-deployment.md:2485` asks for clock sync, which lowers the likelihood.
- **Remediation:** `clockTolerance: 30` on `jwtVerify`, and the same tolerance (or a presence check only) on the manual `exp` check at `:113`.

### 18. Valid captcha tokens longer than 1,000 characters are refused in the browser

- **Severity:** Low.
- **Where:** `shared/validation/auth.ts:37-40` (`loginSchema.captcha` uses `.max(1000)`).
- **Evidence:** `CAPTCHA_TOKEN_MAX_LENGTH = 2048` sits in the same file (`:32`), the server accepts 2,048 (`lib/captcha.ts:48`), and OpenAPI publishes 2,048 (`lib/http/openapi/finalize.ts:72`). The front end reuses this field in every captcha form (`apps/front-end/utils/validation/auth.ts:12,24` `captchaField = { captcha: loginSchema.shape.captcha }`, spread into sign-in, contact, code, forgot-password, Google start and account forms). `bun -e`: lengths 1,001 and 2,048 fail.
- **Failure scenario:** Turnstile issues a token of 1,001–2,048 characters (the limit Cloudflare and this repository state); the browser refuses sign-in or recovery with "captcha required".
- **Remediation:** `.max(CAPTCHA_TOKEN_MAX_LENGTH, …)`. No front-end edit needed.

### 19. The storage-URL gate accepts a trailing `?` and then every public file URL is broken

- **Severity:** Low (operator typo trigger).
- **Where:** `lib/env.server.ts:76-96` (boot validation), `lib/r2/client.ts:22` (`getPublicUrl` normalisation).
- **Evidence:** with `R2_PUBLIC_URL='https://media.example.invalid/?'` the gate accepted it (`new URL()` gives an empty `search`/`hash` for a bare `?` or `#`), and `getPublicUrl('media/k.webp')` returned `https://media.example.invalid/?/media/k.webp`. The gate's comment says it refuses a query string. The two places normalise differently (the gate trims; the client also strips trailing slashes).
- **Impact:** every public file URL and every purge URL (`lib/media/lifecycle.ts:143`, `lib/media/orphaned-objects.ts:113`) is wrong, and the boot gate that should catch it passes.
- **Remediation:** normalise once in a shared module (as `lib/r2/buckets.ts` does for bucket names): export the parsed origin, refuse anything with a `?` or `#`, and use it in both places.

### 20. R2 calls hang forever if R2 stalls after sending response headers

- **Severity:** Low.
- **Where:** `lib/r2/client.ts:41-71` (`requestTimeout` with `throwOnRequestTimeout`, no `socketTimeout`, no abort signal on most calls).
- **Evidence:** in `@smithy/node-http-handler` 4.13.0 the request timer is cleared as soon as headers arrive, and no socket timeout is set. Against a local server with the exact client options: a server that never answers fails after three attempts (6.2 s); one that sends headers then stalls the body left `ListObjectsV2`, `DeleteObjects` and `CopyObject` pending at 12 s, and `DeleteObjects` with the real 15 s timeout still pending at 330 s. `abortSignal: AbortSignal.timeout(4000)` ended it at 4.1 s; `socketTimeout: 3000` at 9.3 s (three attempts).
- **Failure scenario:** the nightly sweep's `finishDeleting` → `deleteObjectsFromR2` never settles; `runElected` keeps its advisory lock and one of the 10 pool connections; `Bun.cron` does not overlap a job with itself, so retention stops until a restart; the weekly reconcile hangs the same way. On request paths (publish copy, bulk delete) only memory is lost after the 120 s socket drop. The comment at `client.ts:41-48` and `lib/media/files.ts:64-71` assume a bounded call.
- **Outside fact:** behaviour over TLS to R2 on Linux, and how often R2 stalls mid-body, are untested here; the handler code path is the same.
- **Remediation:** set `socketTimeout` (an inactivity deadline) on the request handler, one line for every command; for a total bound that also stops a slow trickle, wrap `send` with `AbortSignal.any([callerSignal, AbortSignal.timeout(deadline)])`. Correct the two comments.

### 21. A maintenance sweep can start after shutdown has begun, forcing an unclean exit

- **Severity:** Low.
- **Where:** `lib/shutdown.ts:213-225` (`createShutdown` awaits `stopServer` first); cron handles and abort only in `stopAndDrain` (`lib/maintenance/schedule.ts:177-181`); ownership retry interval only cleared there (`lib/maintenance/ownership.ts:61-64`).
- **Evidence:** reproduced with the real `startSchedule` and `createShutdown`, a `* * * * *` job of 20 s and a `stopServer` standing in for a long request: shutdown at 0.1 s, job started at 28.3 s with shutdown already begun, forced shutdown and exit 1 at 34.3 s.
- **Failure scenario:** a deploy sends SIGTERM shortly before a cron boundary while a long upload drains (up to 135 s); the sweep starts, the drain times out, the process exits 1 with stores open and R2 work cut mid-pass. A directory-election loser can also claim ownership and start the schedule during the drain.
- **Remediation:** split the schedule handle into a synchronous `halt()` (stop handles, abort, stop retrying) called first in `shutdown`, and the existing drain afterwards.

### 22. The rate-limit store's sweep falls behind an anonymous flood and stalls the event loop

- **Severity:** Low.
- **Where:** `lib/sqlite/sweep.ts:6-9` (500 rows × 200 batches per run), `lib/maintenance/schedule.ts:31-32` (every 15 minutes); keys created before captcha at `lib/http/admit.ts:96,117` and `server/elysia/auth-mount.ts:70`.
- **Evidence:** each (scope, IP bucket) is one row, about 45 scopes per IPv4 address or IPv6 /64. An anonymous caller with one IPv6 /48 (65,536 buckets) can create about 2.9M rows through Cloudflare; above about 111 new keys per second the sweep never catches up. Measured on `bun:sqlite` with the production schema (no `expires_at` index, owner decision P-1), 10% expired: 1M rows took 200 batches, slowest 228 ms, 11.5 s of synchronous blocking per run; 3M rows took 600 batches, slowest 839 ms, 116.5 s. Each batch rescans from the start.
- **Impact:** growing disk and repeated event-loop stalls of hundreds of milliseconds for all requests during each sweep run, for as long as the flood lasts and for hours after.
- **Remediation:** a keyset cursor (`key > ?` in primary-key order) keeps P-1's no-index decision and cut total blocking at 1M rows from 11.5 s to 2.4 s; then cap each run by rows scanned, and keep going while rows remain (yielding between batches). Whether Cloudflare's zone rules throttle one /48 at this rate is outside the repository; the owner can check the zone's rate-limit rules. With no edge limit, severity rises to Medium. (Spoofing `cf-connecting-ip` direct to the origin is owner entry should-ignore #63.)

### 23. Anyone can grow the verifications table faster than the daily sweep removes rows

- **Severity:** Low.
- **Where:** `lib/maintenance/database.ts:78-79` (500 rows × 40 batches per table, once a day, `lib/maintenance/schedule.ts:36-40`); `lib/auth/index.ts:147` (`disableCleanup: true` turns off Better Auth's own cleanup, `internal-adapter.mjs:768`); writer `POST /api/auth/oauth/google/start` (`lib/auth/oauth/plugin.ts:~337`).
- **Evidence:** three start calls wrote six rows (an `auth-state:` row of about 390 characters and an `oauth-once-` row). At 20 calls per minute per IP plus Turnstile, one IP writes 57,600 rows a day against 20,000 reclaimed: a net backlog of about 37,600 rows (17.7 MB) per IP per day. Readers skip expired rows, so it is a cost, not a leak. Every credential rotation scans the table twice by `value` inside the user-locked transaction (`lib/auth/session/rotation.ts:81-89,102`): at 500k rows each delete took 660–808 ms cold, 68–72 ms warm.
- **Reachable when:** Google sign-in is enabled. The hurdle is one captcha solve per call.
- **Remediation:** sweep `verifications` on the 15-minute schedule or raise its batch ceiling (batches are already short transactions); the hash index on `value` (#99) removes the scan cost.

### 24. Looking a user up by email alone scans the users table on every password sign-in

- **Severity:** Low (performance, grows without bound).
- **Where:** `db/schema.ts:212-214` (`ux_users_email` is partial, `WHERE deleted_at IS NULL`); Better Auth 1.7.14 `findUserByEmail` (`internal-adapter.mjs:583`, email only) during `/sign-in/email` (`sign-in.mjs:317`); `lib/auth/oauth/identity.ts:107-110` (`lockEligibleAuthUser` on email without `liveUser`).
- **Evidence:** on 200k users the email-only lookup is a Parallel Seq Scan (155 ms) and the `FOR UPDATE` form a Seq Scan (11.5 ms); with a non-partial `ux_users_email` both are index scans (0.03 ms). The login guard's own lookup already adds `deleted_at IS NULL` and uses the index (`login-guard.ts:139`).
- **Remediation:** recreate `ux_users_email` without the predicate, keeping its name (`lib/http/constraint-errors.ts:53-56` maps it by name). Safe because soft delete rewrites the email to `…_del_<uuid>` (`lib/users/delete.ts:97-107`), so deleted addresses never collide. At minimum, wrap the OAuth lookup in `liveUser()`.

### 25. Deleting a role or a user with a custom role scans the users table three times

- **Severity:** Low (extends owner entry TODO DB-5 with new reach).
- **Where:** `modules/permissions/item.ts:338-343` (member lock), `:359-362` (unpin update), the FK trigger on `users_role_id_roles_id_fk`; `destroyCustomRole` (`lib/permissions/roles.ts:148,166`) called from `lib/users/edit.ts:418` and `lib/users/delete.ts:123`.
- **Evidence:** on 200k users, member lock Seq Scan 12.8 ms (17.4 ms for a 4,000-member role), unpin update 13.5 ms, FK trigger 13.0 ms; with a plain `users(role_id)` index 0.03 / 0.02 / 0.1 ms. DB-5 names only the FK scan on role delete; a standard role delete pays three scans, and every soft delete of a user with a custom role pays the FK scan under the user lock. The unpin update can never match: the only writer of `deleted_at` also nulls `role_id` in the same update (`delete.ts:107,110`).
- **Remediation:** DB-5's own fix, a plain `users(role_id)` index (or make `idx_users_role_active` non-partial), fixes all three; delete the dead unpin update or keep it as a now-cheap guard.

### 26. A resend after the daily verify cap sends a paid code that can never be accepted

- **Severity:** Low.
- **Where:** `lib/otp/send.ts:129-266` (`processOtpSend` never reads `verifyAttemptDaily`), `lib/otp/throttle.ts:72-76`, `lib/otp/verify.ts:243-249`, `shared/messages/otp.ts:28-29`.
- **Evidence:** a `forgot_password` row at daily 15 and blocked: the next send returned `nextAllowedIn: 31`, delivered a mail, charged the global budget and cleared the block; verify with that correct code answered `429 verifyBlocked` (on anonymous routes collapsed to "invalid or expired", `modules/auth/anonymous.ts:46`). The refusal text tells the user to request a new code.
- **Impact:** up to about 15–20 paid messages per row per day (the send cap's 6-hour block bounds it), each useless, and a user told to retry a loop that cannot succeed. Every caller is affected: anonymous sends, 2FA sends, contact-change sends.
- **Remediation:** in `processOtpSend`, read the daily count with its window before the upsert, charge and delivery, and raise `blockedError` with `Retry-After` at the window end when it is spent; give that refusal a message that does not promise a new code.

### 27. Regenerating backup codes can lock out a user whose only factor is backup codes

- **Severity:** Low.
- **Where:** `lib/auth/two-factor/enrolment.ts:318` (`generateBackupCodes` clears `backupCodesAcknowledgedSetId`).
- **Evidence:** until acknowledged, `backupCodesReady` is false (`methods.ts:174-177`); for a backup-code-only user the offered set is empty and sign-in answers 403 (`issue.ts:182-211`). The removal paths refuse this state through `removalStrandsTwoFactor` (`enrolment.ts:447,551`); regeneration skips the check. A backup-code-only configuration is allowed (`shared/validation/two-factor-lists.ts:49-59`).
- **Failure scenario:** the user regenerates, the acknowledgement never lands (tab closed), the session ends; the next sign-in is refused and only an admin reset recovers the account.
- **Remediation:** keep the old set usable until the new one is acknowledged (schema change); or refuse regeneration with 409 when it would strand the user (contract change: generate publishes no 409 today).

### 28. Deleting a user keeps their 2FA secrets and passkeys forever

- **Severity:** Low.
- **Where:** `lib/users/delete.ts:94-129` (`softDeleteUser`).
- **Evidence:** after `DELETE` answered 200, `two_factor_enabled` was still true and one credential, one method and one passkey row remained. The function clears sessions, proofs, trusted devices, Google links, accounts and preferences, but not 2FA enrolment. Sign-in is refused for deleted users (`lib/auth/session/hooks.ts:65-97`), so the impact is retention: an encrypted TOTP secret, backup codes and passkeys on a row that is never purged.
- **Remediation:** call `clearTwoFactorEnrolment(tx, userId, { deletePasskeys: true })` (`lib/auth/two-factor/methods.ts:389`) in the same transaction; the user lock is already held.

### 29. Granting or revoking a trusted device leaves no audit record

- **Severity:** Low.
- **Where:** `lib/auth/two-factor/trusted-device.ts:157-188` (`grantDeviceTrust`), `:210-221` (`revokeTrustedDevice`).
- **Evidence:** neither writes an audit row and no trigger covers `trusted_devices`; every sibling 2FA change is audited through `auditLifecycle`. The skip-2FA event (`issue.ts:219-228`) cannot name the device because `consumeDeviceTrust` returns only a boolean.
- **Impact:** an investigator cannot tell which device skipped 2FA or when it was trusted, for the one setting that bypasses 2FA for 30 days.
- **Remediation:** audit inside the grant transaction and on revoke; have `consumeDeviceTrust` return the row id for the skip event.

### 30. A failed passwordless 2FA step leaves an unheld session and an uncorrected login audit

- **Severity:** Low.
- **Where:** `lib/auth/passwordless.ts:149-189`; same gap in the `/sign-in/email` after-hook (`lib/auth/two-factor/plugin.ts:197`).
- **Evidence:** compensation (`recordAbandonedSession` plus `deleteSession`) wraps only `deliverSessionCookie`. A database fault in `readEnrolmentState` or `consumeDeviceTrust` (`issue.ts:176,217`) before `withdrawFirstFactorSession` leaves a live session row whose token is never delivered, and a `loginSuccess` audit row for a 2FA user who never passed the second factor. OAuth rolls back inside its transaction.
- **Impact:** a misleading audit trail and an orphan session row until it expires.
- **Remediation:** the transaction restructure in #11 fixes passwordless; the sign-in hook needs a catch that deletes the session and records the abandonment.

### 31. Sessions store IPv6 addresses cut to /64, so they never match the other audit rows

- **Severity:** Low.
- **Where:** `lib/auth/index.ts:86-89` (`ipv6Subnet: 64`), Better Auth's `getIP`.
- **Evidence:** for `2001:db8:1:2:aaaa:bbbb:cccc:dddd`, Better Auth returns `2001:0db8:0001:0002:0000:0000:0000:0000` whether the option is 64 or omitted (64 is the library default); `128` returns the full address. `sessions.ip_address`, the `loginSuccess` audit (`lib/auth/session/hooks.ts:183`) and the challenge audit (`lib/auth/two-factor/challenge.ts:424`) get the expanded /64; failed-login audits and trusted devices (`trusted-device.ts:174`) get the raw compressed address from `getClientIp`. The comment's reason (matching `ipBucket`) is moot: Better Auth's limiter is off (`index.ts:129-131`). No owner entry records /64 masking as a privacy choice.
- **Impact:** an investigator cannot join a session to the failed attempts or devices from the same IPv6 client; the session list shows a network, not an address.
- **Remediation:** `ipv6Subnet: 128` and a corrected comment; to also unify the format, set `ipAddress` from `getClientIp` in `session.create.before`. The same /64 value is sent to Turnstile as `remoteip`; whether that changes Turnstile's verdict is outside the repository.

### 32. Photos embedded in an uploaded SVG keep their GPS location and author

- **Severity:** Low (privacy).
- **Where:** `shared/images/svg-optimizer.ts:44-45` (`SAFE_DATA_URI` allows PNG/WebP), `:122-144` (canonicalisation strips only whitespace), `:1224-1225` (payload written back); svgo leaves it (`lib/media/image/svg.ts:28-39`).
- **Evidence:** an SVG whose inline PNG carried an `eXIf` GPS sentinel and a `tEXt` Author chunk went through the real sanitise and optimise workers byte for byte with both intact. `lib/media/image/optimize.ts:83-84` says the direct-raster re-encode exists precisely to strip camera EXIF "location included"; this path skips it.
- **Impact:** a published SVG serves its embedded photo's metadata for a year (immutable cache). Phone JPEGs are already refused inside SVG, which narrows it.
- **Remediation:** strip metadata in the shared, synchronous canonicaliser (PNG: rebuild from an allow-list of chunks; WebP: drop EXIF/XMP and clear the VP8X flags), reusing the chunk walker in `shared/images/raster-bytes.ts`.

### 33. Uploaded file names lose accents, vowel signs and Arabic diacritics

- **Severity:** Low.
- **Where:** `shared/filename.ts:11-14` (`sanitizeFilename` keeps `[\p{L}\p{N}\p{Zs}_\-()]`, no `\p{M}`, no NFC), used for the stored `displayName` and download name (`lib/media/upload.ts:189,232,416`).
- **Evidence:** `"हिन्दी रिपोर्ट.pdf"` → `"हनद रपरट"`; NFD `café` → `cafe`; `مُحَمَّد` → `محمد`. The rename path (`shared/validation/media.ts:46-49`) applies NFC and keeps marks, so one column is written under two rules. The `.replaceAll('..','')` at `:12` is dead (the class already removes every `.`).
- **Remediation:** NFC first, add `\p{M}` to the class, delete the dead replace. Shared with the front end, which uses it for the same names, so both stay in step. No contract change.

### 34. Tabs and line separators in names are deleted instead of becoming spaces, merging words

- **Severity:** Low.
- **Where:** `shared/validation/rules.ts:36-54` (`STRIPPED_CHARACTERS`, `sanitizeStrict`, `sanitizeStrictSingleLine`).
- **Evidence:** the collapse runs after the strip, and `\t`, `\v`, `\f`, U+2028, U+2029 and a lone `\r` are not `\p{Zs}`, so they are removed: `"Ahmed\tAli"` → `"AhmedAli"`; `selfUpdateUserBodySchema` stores that. The published `STRICT_SINGLE_LINE_DESCRIPTION` (`shared/validation/rules.docs.ts:45`) says line breaks collapse to a space.
- **Sites:** user name (`shared/validation/auth.ts:56-62`, also self-update and dev sign-up), role name and description (`shared/validation/permissions.ts:181-199`), `otpCodeSchema` (`shared/validation/otp.ts:84`), front-end settings.
- **Remediation:** before stripping, map `\r\n?`, U+2028/9 and U+0085 to `\n` and other whitespace to a space, in both sanitizers. `otpCodeSchema` currently accepts `"123\t456"` as `123456` (and rejects `"123 456"`), so give it its own whitespace removal to avoid narrowing its contract.

### 35. Invisible characters pass name validation, allowing blank display names and look-alike role names

- **Severity:** Low.
- **Where:** `shared/validation/rules.ts:36-37`.
- **Evidence:** default-ignorable letters and marks survive (U+3164, U+115F, U+1160, U+FFA0, U+034F, U+FE0F), and nothing applies NFC: `selfUpdateUserBodySchema` accepts `name: "ㅤㅤ"` (displays blank); `createPermissionSchema` accepts `"ㅤ"` and `"Admin͏"`; on the dev database `'Admin' = 'Admin͏'` and NFC = NFD are both false, so `ux_roles_role_name` lets look-alikes coexist. Media names already apply NFC for their unique index (`shared/validation/media.ts:41-49`).
- **Impact:** a user can blank their name in admin lists and audit views; an administrator can be misled by two roles that look identical. Owner entry #15 accepts case-sensitive role uniqueness; whether it also covers invisible characters is the owner's call.
- **Remediation:** in both sanitizers, `normalize('NFC')` and strip `\p{Default_Ignorable_Code_Point}` (verified in Bun to match every character above and not Arabic shadda).

### 37. One user gets three move budgets though the code promises one

- **Severity:** Low.
- **Where:** `lib/media/selection.ts:61-65` (`MOVE_LIMIT`: "one budget for every route that runs the operation"); `PUT /media/folders/:id` (`modules/media/folders.ts:65-69`, runs `prepareFolderMove` under `lockTree`, `lib/media/folders.ts:528-536`) and `PUT /media/files/:id` (`modules/media/files.ts:174-179`) each have their own 30/min budget.
- **Impact:** a `media.edit` holder gets 90 moves a minute, each taking the global tree lock. The stated guarantee is false.
- **Remediation:** correct the comment; charging `MOVE_LIMIT` on these PUTs would also charge rename-only calls (a 429 behaviour change).

### 38. A provider outage on Better Auth plugin routes is answered as bad input (400)

- **Severity:** Low.
- **Where:** `lib/auth/errors.ts:117-119` (`toAuthApiError`), via `asAuthError` (`:127-128`).
- **Evidence:** any `CustomError` of status 500 or above becomes a 400 with the generic message, though the comment says it behaves "as `handleApiError` does" (which keeps the status, `lib/http/response.ts:107-121`). With the SMS provider failing, `/api/auth/two-factor/otp/send` answered `400` while its twin `/forgot-password/second-factor/send` answered `500`. OpenAPI documents 400 there as bad input and 500 as a dependency failure. The existing test only asserts `>= 400` (`tests/integration/otp-delivery-logging.test.ts`).
- **Sites:** `lib/auth/two-factor/otp.ts:179,273,336`, `lib/auth/passwordless.ts:198`, `lib/auth/reauth/plugin.ts:79,167`, `lib/auth/reauth/password.ts:50`. `lib/auth/oauth/plugin.ts:155-162` already works around it with its own 500 branch.
- **Impact:** clients and monitoring treat an outage as a client error; the failure is invisible in status-based alerting.
- **Remediation:** in `toAuthApiError`, map 500+ to a 500 with `MSG_INTERNAL_ERROR`, then delete the OAuth workaround. No contract change: 500 is already documented on these routes. Not verified: whether `/passwordless/verify` can throw a 500 before the code matches; if it can, that route must keep collapsing it so the answer reveals nothing about the account.

### 39. Uploads declared over 12 MiB get a bare 413 with no CORS, not the documented problem

- **Severity:** Low (contract).
- **Where:** `app.ts:132` (`maxRequestBodySize: MAX_REQUEST_BODY_BYTES`), `lib/http/request.ts:22,136-139`; published 413 in `lib/http/refusals.ts:104-112` and `lib/http/openapi/merge-better-auth.ts:334-339`.
- **Evidence:** on a real server (`app.listen({port:0})`, raw sockets), `Content-Length: 12582922` on `/api/upload/file`, `/api/dash/media/files`, `/api/dash/users` and `/api/auth/sign-in/email` returned `413 Request Entity Too Large` with no headers, no body, no access-log line. A 2 MiB JSON body and a GET declaring 12 MiB+ got the app's problem 413 with security headers and CORS. Bun refuses before the app's own declared-length check runs, because both limits are the same number.
- **Failure scenario:** a user picks a 15 MB file; the cross-origin dashboard sees a network error (no CORS header) instead of `MSG_BODY_TOO_LARGE`, and the refusal leaves no log line.
- **Remediation:** set Bun's limit a margin above `MAX_REQUEST_BODY_BYTES`, so the app's head check answers every declared over-size request and the stream counter bounds chunked ones. No contract change. (Requests past the new limit, and the proxy's own 413, stay bare.)

### 40. The resend-cooldown refusal is the only 429 without `Retry-After`

- **Severity:** Low (contract).
- **Where:** `lib/otp/send.ts:173-181`.
- **Evidence:** a second `two_factor` send answered 429 with no headers; every other 429 sets `Retry-After` (`lib/otp/throttle.ts:90`, `lib/rate-limit/index.ts:253`, `lib/auth/login-guard.ts:420`) and OpenAPI says "See `Retry-After`" (`lib/http/refusals.ts:61,204`). `toAuthApiError` forwards headers, so 2FA OTP, recovery second-factor and contact-change sends are affected.
- **Remediation:** set `responseHeaders = { 'Retry-After': String(waitSeconds) }` at line 177.

### 41. Publishing an already-public file answers "busy" for up to a day after a cleanup failure

- **Severity:** Low (contract).
- **Where:** `lib/media/visibility.ts:283-284` (`transition` checked before `bucketType === to`).
- **Evidence:** with `DeleteObject` failing, the first publish answered `200 public` with `transition: 'cleanup'`; after clearing the fault, a retry answered 409 `FILE_BUSY` until the nightly `retryTransitions` (up to about 24 h). The OpenAPI text (`modules/media/files.ts:227`) promises idempotency for an already-public file. Unpublish has the same shape.
- **Remediation:** answer done when `bucketType === to` and `transition` is null or `'cleanup'`. Do not reorder for an in-flight `to_*` transition.

### 42. The sign-in contract omits the `callbackURL` field the server honours

- **Severity:** Low (contract).
- **Where:** `lib/auth/path-policy.ts:205-209` (`signInContext` merges the body), published body `lib/http/openapi/better-auth-tables.ts:300-303`, 200 descriptions `:264-274`.
- **Evidence:** Better Auth 1.7.14 sets `Location`, `redirect` and `url` from `callbackURL` and refuses a foreign one with 403 `INVALID_CALLBACK_URL`; `tests/integration/sign-in-controls.test.ts:850-862` asserts both. The published body has only email, password and rememberMe, the 200 publishes no headers, and the 403 text does not name the callback cause, while the 200's own `redirect`/`url` descriptions refer to the field and header.
- **Impact:** a generated client cannot know the field exists or why a 403 happened. The front end does not send it today.
- **Remediation (owner choice, both contract changes):** publish `callbackURL`, `Location` and the 403 cause; or strip `callbackURL` in `signInContext` and drop the two descriptions.

### 43. The published 2FA and passkey bodies advertise flags the server forces off

- **Severity:** Low (contract).
- **Where:** `lib/http/openapi/merge-better-auth.ts:414-441` (`requestBodyOf`), overrides in `lib/auth/path-policy.ts:122-133,289-293`.
- **Evidence:** the document publishes `trustDevice` on `/two-factor/verify-totp` ("trusted for 30 days"), `trustDevice` and `disableSession` on `/two-factor/verify-backup-code`, and `createSession` on `/passkey/verify-registration`; the before-hook forces each to false, which `tests/integration/two-factor-trusted-device.test.ts:301-343` and `two-factor-passkey.test.ts:639-654` prove. `/sign-out` publishes `callbackURL`, `disableRedirect`, `state` and a 200 `url`/`redirect` that need configured social providers; none are.
- **Failure scenario:** a client sends `trustDevice: true`, gets 200, and the device is silently not trusted (trusting is `POST /two-factor/trust-device`).
- **Remediation:** have `requestBodyOf` drop the forced fields using the same path sets the hook uses (`TRUST_DEVICE_STRIPPED_PATHS`, `SESSION_CREATION_STRIPPED_PATHS`), so there is one source; publish no body and no `url`/`redirect` for `/sign-out`.

### 44. The Google callback publishes `state` as optional and unconstrained

- **Severity:** Low (contract).
- **Where:** `lib/http/openapi/merge-better-auth.ts:374-378` (`parametersOf` reuses Better Auth's generated parameters); schema `shared/validation/oauth.ts:26-33`.
- **Evidence:** the document shows `state` without `required` or pattern; at runtime a missing `state` or `state=short` answers 400 and only `^[\w-]{32}$` proceeds. The same query and body schemas are restated in `lib/auth/oauth/plugin.ts:316,363` and `lib/auth/reauth/plugin.ts:85` because `pluginEndpoint` (`lib/auth/plugin-endpoint.ts:45-61`) ignores the entry's `query`/`body`.
- **Impact:** small (callers are Google redirects), but the contract is wrong and the schema lives in two places.
- **Remediation:** publish plugin query parameters from the entry's `query`, and have `pluginEndpoint` default `query`/`body` from the entry.

### 45. `Set-Cookie` is published on 3 operations but sent by many more

- **Severity:** Low (contract).
- **Where:** `tests/unit/openapi-document.test.ts:147-160` (enforces the three); `lib/permissions/checker.ts:77-85`, `server/elysia/respond.ts:80-93,136-141`.
- **Evidence:** any session-gated binding can re-mint or expire the session cookie (`tests/integration/session-cookie-delivery.test.ts:188` proves a re-mint on `GET /api/dash/users`), and Better Auth's sign-in, verify, sign-out and OAuth endpoints set cookies, none published. The unit test's statement "a success that sets cookies publishes `Set-Cookie`, and no other does" is false at runtime. `tests/helpers/document-check.ts` never compares headers.
- **Remediation:** say once on the `sessionCookie` scheme that any session read may refresh or clear the cookie; publish `Set-Cookie` on the Better Auth sign-in, verify and sign-out answers; reword the test's invariant.

### 46. Two permissions descriptions in the contract don't match what the server does

- **Severity:** Low (contract prose).
- **Where:** `updatePermission`'s OpenAPI description; `shared/responses/permissions.docs.ts:13`.
- **Evidence:** the description says a role cannot edit its own matrix (403), but `modules/permissions/item.ts:153` refuses any PUT on the caller's own role, rename and deactivate included (asserted in `id-canonicalization-guards.test.ts:146-161`). The detail doc says one entry per page the role has a grant on, but all-false pages are stored and returned (`modules/permissions/collection.ts:144-150`, `lib/permissions/roles.ts:77`).
- **Remediation:** correct both texts.

### 47. The filter documentation says a substring needs indexable letters, but "does not contain" doesn't

- **Severity:** Low (contract prose).
- **Where:** `shared/data-table/query.docs.ts:23`, `lib/data-table/column-specs.ts:27`; behaviour `shared/data-table/filter-rules.ts:225-229`, migration 011.
- **Evidence:** `notILike "!!!"` is accepted (and matched 200,000 of 200,000 rows, correct for "does not contain"), while `iLike "!!!"` gets 422; the prose says a value whose fold keys nothing matches no rows and that substring filters need letters or digits.
- **Remediation:** scope both statements to `iLike`/`startsWith`/`endsWith` and say `notILike` needs only the length floor.

### 48. The published email pattern rejects a few addresses the server accepts

- **Severity:** Low (contract).
- **Where:** `shared/validation/rules.ts:203-235` (`EMAIL_INPUT_PATTERN`, `caseInsensitiveLiteral`).
- **Evidence:** the server lowercases U+212A (Kelvin sign) to `k`, so it accepts `"Kate@gmail.com"` and `"a@outlooK.com"`, which the published pattern rejects; a scan of every code point found U+212A the only such character. `%` in both classes is dead: zod 4.6.7's email check refuses it.
- **Remediation:** add U+212A to the local-part class and to `caseInsensitiveLiteral`'s `k`; drop `%`.

### 49. An SVG with a prefixed root element is refused unless a comment mentions `<svg`

- **Severity:** Low.
- **Where:** `shared/images/svg-optimizer.ts:1123-1124` (`if (!trimmed.includes('<svg'))`).
- **Evidence:** `<s:svg xmlns:s="…svg">` is refused as "no <svg> element", although `withDefaultNamespaceRoot` (`:780-813`) handles such roots; prepending `<!-- <svg -->` makes the same file pass with identical output. The parsed-root checks (`:1148`, `:1249`) are the real guards (no security impact). `tests/unit/upload-validation.test.ts:289-304` passes whether the file is refused or accepted.
- **Remediation:** delete the text pre-check; make those tests assert the file is accepted.

### 50. Enrolling OTP as a second factor doesn't count as a proof, so "remember this device" is refused

- **Severity:** Low.
- **Where:** `lib/auth/two-factor/otp.ts:297-345` (`verifyForEnrolment`); compare `enrolment.ts:277` (TOTP enrolment calls `markTwoFactorProven`).
- **Evidence (code read):** the proof marker is written by TOTP enrolment, the sign-in verifier (`two-factor/plugin.ts:111`) and challenge completion (`challenge.ts:363`), not by OTP enrolment. After enrolling OTP, "remember this device" (`grantDeviceTrust`) answers 403 `trustRequiresProof`; after TOTP enrolment it succeeds. Fails closed.
- **Remediation:** call `markTwoFactorProven(tx, requestSession.sessionId)` in `onVerified` (`processOtpVerify` already holds the users lock it needs). Whether passkey enrolment should count too is an owner decision.

### 51. Google start refuses a failed captcha with the wrong message

- **Severity:** Low.
- **Where:** `lib/auth/oauth/plugin.ts:319-323`.
- **Evidence:** without `x-captcha-response`, `/oauth/google/start` answered 403 with `MSG_INVALID_INPUT` ("check the input"), while `/passwordless/verify` answers 403 and `/sign-in/email` 400, both with `otpMsg.captchaFailed`. No test omits the header on Google start, so dropping the check would pass the suite.
- **Remediation:** answer with `captchaRefused()` (`lib/captcha.ts:115`) through `toAuthApiError`, and add a test that a missing token is refused and writes no state rows.

### 52. A self-service email change records two different actor emails in one commit

- **Severity:** Low.
- **Where:** `lib/users/contact-change.ts:218`.
- **Evidence:** the Google-unlink audit row records the actor as `{ email: newEmail }`; the users UPDATE audit in the same transaction (`:224`) records `current.email`, and the admin path passes the actor's current email (`lib/users/edit.ts:377-382`).
- **Remediation:** pass `current.email`.

### 53. The provider-refusal message leaves out Live

- **Severity:** Low.
- **Where:** `shared/messages/validation.ts:67-68` (`MSG_EMAIL_PROVIDER_NOT_ACCEPTED`) against `shared/validation/rules.ts:185` (`live.com` accepted).
- **Remediation:** add Live to the sentence (the OpenAPI prose is already generated from the list).

### 54. Comments claim Better Auth matches credential accounts by issuer; it does not

- **Severity:** Low (wrong invariant comments).
- **Where:** `lib/auth/credential.ts:8-11`, `lib/auth/credential-account.ts:17`, `db/schema.ts:300-303,317-320,332-333`, `tests/helpers/session.ts:189-191`, `tests/integration/harness.test.ts:169-172`.
- **Evidence:** Better Auth 1.7.14 finds the credential account by `providerId === "credential" && accountId === user.id` only (`dist/api/routes/sign-in.mjs:317`). `@better-auth/core/dist/db/schema-diff.mjs:81` says the issuer column came from 1.7.0–1.7.2 and the library never writes it. The comments say a wrong issuer is a password-login outage and that the issuer index is "the uniqueness Better Auth itself assumes".
- **Impact:** a reader protects or changes the wrong thing. Also, because `provider_id` has two values and `chk_credential_issuer`/`chk_google_account` pin one issuer to each, `ux_accounts_issuer_account` duplicates `ux_accounts_provider_account`, and the check `account.issuer !== GOOGLE_ISSUER` at `lib/auth/oauth/identity.ts:132` is always false.
- **Remediation:** correct the comments (the column serves project-owned Google identity). Optionally drop the duplicate index (safe for the previous release); dropping the column needs the two-release sequence.

### 55. The folders schema comment names the wrong lock for the tree invariants

- **Severity:** Low.
- **Where:** `db/schema.ts:636-638`.
- **Evidence:** it says depth and fan-out are enforced under `FOR UPDATE` on the parent. The guard is `lockTree` (`lib/media/folders.ts:131`, `pg_advisory_xact_lock`) plus `FOR NO KEY UPDATE` (`:179`); every structural writer takes `lockTree` (`folders.ts:389,528`, `selection.ts:149,545`), the root has no parent row to lock, and `folders.ts:174-179` relies on the weaker row lock.
- **Remediation:** name `lockTree` in the comment, so the next editor protects the right thing.

### 56. Email codes only work with a Gmail account, and nothing says so

- **Severity:** Low.
- **Where:** `lib/otp/delivery.ts:44-55` (`service: 'gmail'` hard-coded); boot gate `lib/otp/config.ts:30-35,90-96` (presence only); `reports/coolify-deployment.md` §3 (~615).
- **Evidence:** a production boot with a non-Gmail `SMTP_USER` logged `server started`; readiness does not touch SMTP. SMS goes to a hard-coded `apis.deewan.sa` (`:108`) and WhatsApp to `services.rmz.one` (`:133`), a provider the runbook never names.
- **Failure scenario:** the operator configures SES or Postmark credentials; the server boots and passes health; every email OTP (verification, recovery, passwordless, 2FA by email) fails.
- **Remediation:** document that email needs a Gmail or Workspace account with an app password and `SMTP_FROM` as that account or a verified alias; name the WhatsApp provider and the egress hosts. A configurable SMTP host is an owner decision.

### 57. The published API contract is unreachable in production behind the documented routing

- **Severity:** Low.
- **Where:** `shared/api/openapi.ts:10` (`/openapi.json`, the only contract path outside `/api`), served in production by `app.ts:242-247`; `reports/coolify-deployment.md` §2 (~289-320) routes only `PathPrefix(/api)` to the back end; `apps/front-end/next.config.js` has no rewrite for it.
- **Evidence:** a production-posture boot answers `/openapi.json` with 401 and `/api/openapi.json` with 404, so the document lives only where the proxy sends traffic to Next.
- **Impact:** after deploy, `https://example.com/openapi.json` is Next's 404; §8 (~1690, "returns 401"), the §5 edge rate-limit rule (~1217), §12's production smoke (~2187) and the checklist (~2394) fail or protect a front-end path. No security impact (it fails closed).
- **Remediation:** route `Path(/openapi.json)` to the back end in §2; or move the contract to `/api/openapi.json` (a contract path change: shared entry, `server/elysia/openapi.ts`, `scripts/smoke.ts`, tests, snapshot).

### 58. The runbook's storage checks can never pass as written

- **Severity:** Low.
- **Where:** `reports/coolify-deployment.md` §8 (~1603, expected ~1633) and §5 (~1025-1026).
- **Evidence:** §8 calls the storage route without the token, which answers 401, never the expected `{"status":"ok"}`; both steps use `wget`, while the runtime stage installs only `curl` (`Dockerfile:42-44`).
- **Remediation:** use `curl -sS -H "x-maintenance-token: $SQLITE_MAINTENANCE_TOKEN"` (or the health-check script above).

### 59. The runbook misses environment variables that change auth and database behaviour

- **Severity:** Low.
- **Where:** `reports/coolify-deployment.md` "Must be absent" list and §3.3 (~826).
- **Evidence:** Better Auth 1.7.14 reads `BETTER_AUTH_TRUSTED_ORIGINS` (`dist/context/helpers.mjs:83-84`) and adds those origins to the auth mount's origin and redirect checks; the app refuses `BETTER_AUTH_SECRETS` at boot (`lib/env.server.ts:176`) but not this one. On Bun 1.4.4, `PGOPTIONS` is applied (`geqo` read `off` with `-c geqo=off`) and `PGDATABASE` overrides the database in `DATABASE_URL` (it switched `current_database()`), while §3.3 says `PGOPTIONS` is ignored.
- **Impact:** a stray platform variable widens the auth origin check or points the app at another database without any boot error. The operator is trusted, so this is a documentation gap.
- **Remediation:** list `BETTER_AUTH_TRUSTED_ORIGINS`, `PGOPTIONS` and `PGDATABASE` under "Must be absent" and correct §3.3; optionally refuse `BETTER_AUTH_TRUSTED_ORIGINS` at boot as `BETTER_AUTH_SECRETS` is.

### 60. The business timezone changes server date filters but the runbook calls it display-only

- **Severity:** Low.
- **Where:** `shared/config.ts:34` → `shared/time.ts` → `dayBounds` (`shared/data-table/filter-rules.ts:119-127`) → `lib/data-table/filter-columns.ts:129,180-192`; `reports/coolify-deployment.md` (~490, "display only"; §2's list of variables to set identically in both apps).
- **Failure scenario:** the front-end build and the back-end runtime get different `NEXT_PUBLIC_BUSINESS_TIMEZONE` values; every "this day" filter silently returns rows offset by the difference.
- **Remediation:** drop "display only" and add the variable to §2's set-identically list.

### 61. Nothing in the runbook stops an edge cache rule from caching per-user API answers

- **Severity:** Low.
- **Where:** `reports/coolify-deployment.md` §5; `lib/http/response-policy.ts:23` (`no-store` by default).
- **Evidence:** Cloudflare's "Ignore cache-control header" edge-TTL option overrides the origin's `no-store`. API and front end share one hostname, so a hostname-wide "Cache Everything" with an edge-TTL override (a natural Next speed-up) would cache per-user API responses. §2 (~319) points to a §5 "no caching of `/api/auth/*`" rule that does not exist.
- **Remediation:** a §5 cache rule "URI path starts with `/api/` → Bypass cache", a prohibition on edge-TTL overrides outside `/_next/static/*`, and a corrected §2 reference.

### 63. Security and integrity guards that no test would notice disappearing

- **Severity:** Low (missing coverage; each guard works today).
- **Gaps, each verified by searching the tests:**
  - **Privilege escalation (the riskiest):** no request-level test of the grant refusal on `POST/PUT /permissions` and on custom-matrix or standard-role assignment in `POST/PUT /users`, the `permissions.create`/`permissions.edit` gates, the deactivate-needs-`delete` gate (`modules/permissions/item.ts:188`), session revocation on role deactivation through the route, or `refreshRoleSessions` through a role edit. No integration test references `MSG_CANNOT_GRANT_UNOWNED_PERMISSIONS`; only `tests/unit/permission-scope.test.ts` exercises the scope function itself. A probe confirmed all these guards work today.
  - **Own-scope base predicate under OR filters:** own-scope tests (`tests/integration/authorization-and-audit.test.ts:193-230,514-523`) send no filters. Drizzle's `and()`/`or()` return a single condition unparenthesised, so the hand-written parentheses in text `isEmpty`/`isNotEmpty` (`lib/data-table/filter-columns.ts:51-61`) are all that keeps `base and (a or b)`; removing them would show other users' rows to a `viewOwn` actor with no failing test.
  - **Anonymous OTP sends hiding account-dependent refusals:** `tests/integration/otp-timing-oracle.test.ts:556-640` covers a plain error, but nothing compares a known address hitting cooldown, send-cap block or budget 429 with an unknown twin; narrowing the catch in `lib/otp/anonymous-send.ts:110-118` to rethrow 4xx errors would pass.
  - **Cross-user trust cookie:** nothing presents user A's trust cookie at user B's sign-in (guards `trusted-device.ts:112-120,131`).
  - **Last 2FA method under concurrency:** no test races two removals for a two-method user (`enrolment.ts:415-420`).
  - **Google callback after a credential rotation:** `proof_revoked` (`lib/auth/oauth/identity.ts:114-115`) is never reached; the only rotation test changes the email and fails earlier.
  - **Upload body budget:** nothing asserts `chargeUploadBodyBudget` (`lib/media/upload.ts:134-151`) is charged before `readFormData()` or that a chunked body pays the maximum.
  - **Object-store reconciliation:** `reconcileObjectStore` (`lib/media/reconcile.ts`) has no test (classification, `MAX_LISTED_KEYS` truncation, `MAX_HEAD_CHECKS`, keyset paging), though its report drives manual deletes; the R2 stub already implements `ListObjectsV2` for it.
  - **Migration safety refusals:** `assertJournalOrdered` and the post-run count check in `scripts/migrate.ts:205-234` have no test; a branch merge producing an out-of-order journal entry would be skipped on existing databases forever.
- **Remediation:** one test per gap, each asserting the refusal and that durable state did not change (`CLAUDE.md`: "A rejection test also asserts that durable state did not change").

### 64. The git hooks run ESLint on the machine's Node while CI runs it on Bun

- **Severity:** Low (tooling, latent).
- **Where:** root `lefthook.yml:41,53,63,113,122,241,247,251` (`bunx eslint`); claims at `lefthook.yml:1-3` and the `[run] bun = true` comment in `apps/back-end/bunfig.toml`.
- **Evidence:** `bunx eslint --env-info` reports Node v24.20.0 (the system Node); `bunx --bun eslint` and `bun run eslint` report Bun. `bunx` follows the `#!/usr/bin/env node` shebang (`bun-types/docs/pm/bunx.mdx:65`) and lefthook calls `lefthook.exe` directly, so the alias `bun run` installs is absent. No lint divergence today (both exit 0).
- **Impact:** the local gate and CI run on different runtimes; an old system Node can break pushes, and results could diverge.
- **Remediation:** `bunx --bun eslint …` at the eight sites.

### 66. The workspace secret-scan scripts ignore the repository's gitleaks config, and the front-end one fails today

- **Severity:** Low (tooling).
- **Where:** `apps/back-end/package.json:25` (`scan:secrets` = `gitleaks git .` from the workspace), `apps/back-end/.gitleaksignore`; sibling `apps/front-end/package.json:29`.
- **Evidence:** gitleaks 8.30.1 run from `apps/back-end` reports "no gitleaks config found … using default" and reads the workspace `.gitleaksignore`; the real gates (`lefthook.yml`, `.github/workflows/security.yml`) use the root `.gitleaks.toml`. The front-end script fails right now (`leaks found: 1`, `generic-api-key` at `components/editor/plugins/exit-break-kit.tsx:9`), a line the root allowlist covers.
- **Remediation:** scan the repository root with the root config (or one root script), and delete `apps/back-end/.gitleaksignore`.

### 68. Files released by private records would become visible to every media viewer

- **Severity:** Low (latent; Medium once a private source exists).
- **Where:** `lib/media/lifecycle.ts:52` (`unfiledNow`), `lib/media/files.ts:81-83` (`mediaGoverned`), `modules/media/library.ts:97-98`, `modules/media/files.ts:147`.
- **Evidence:** with a private usage source registered in a probe, a viewer with only `media.view` got 404 while the file was held; after the record released it, the unfiled list answered 200 with the file and a signed URL, and the detail route returned a download URL. Nothing records that a private record held it. Exposure lasts about 7–8 days (stamped at the nightly sweep, reaped 7 days later), or indefinitely if someone adopts it into a folder.
- **Reachable when:** a project registers its first private owner table (`USAGE_SOURCES` is empty today, `lib/media/usage-sources.ts:48`).
- **Remediation (owner choice):** a `files.private_hold` column excluded from unfiled and governed views (the unfiled listing shrinks, a contract change); or a mandatory release helper that deletes privately held files when their record lets go.

### 69. The media sweep can be starved by rows it keeps but never finishes

- **Severity:** Low (latent).
- **Where:** `lib/media/lifecycle.ts:287-291` (`doomed`: `status='deleting'`, `limit 1000`, no exclusion, oldest first in practice under `idx_files_status_created`), kept rows at `:151-157`; `reapUnfiled` (`:215-221`, `limit 100`) has the same shape.
- **Evidence:** `finishDeleting` keeps rows whose bucket is not configured; with 1,000 or more, the same rows are selected every night (`sweepFiles` runs once per night, no loop, `lib/maintenance/database.ts:397`), and newer `deleting` rows — exactly those whose request-time finish (`selection.ts:665`) failed — are never finished, so a deleted public file's object stays in R2.
- **Reachable when:** the operator unsets a bucket that still has rows (the delete route does not refuse disabled-bucket files), or 1,000 per-key failures persist.
- **Remediation:** order by `updated_at` with a cursor, or exclude rows of buckets not in `ENABLED_VISIBILITIES`.

### 70. A deferred foreign key from an owner table would turn "file in use" into a 500

- **Severity:** Low (latent).
- **Where:** `lib/media/referrer-contract.ts:52-63` (reads match and action types, never `condeferrable`/`condeferred`).
- **Evidence:** `referrerContractViolations` returned no violation for a `DEFERRABLE INITIALLY DEFERRED` referrer key; `DELETE /api/dash/media` of a referenced file then answered 500 with a raw 23503 at COMMIT (row and object intact), while the same key without deferral answered the declared 409 `FILE_IN_USE`.
- **Reachable when:** a developer writes a deferred key in a hand-written migration (the kit ships no referrer tables).
- **Remediation:** select `c.condeferrable` and report it as a violation; add a probe table to the tests.

### 71. An svgo crash on accepted SVG becomes a silent 422

- **Severity:** Low (latent).
- **Where:** `shared/images/svgo-config.ts:49-58` (`catch { return null; }`), `lib/media/image/svg.ts:30`, `lib/media/image/process.ts:147`.
- **Evidence:** an svgo exception becomes `null`, then `{ok:false, recheck:null}`, then a 422 to the user; the log line runs only when `recheck` is set, so the operator sees nothing. `lib/media/image/svg.ts` calls such a failure "our defect". No input that makes svgo throw on sanitised markup was found.
- **Remediation:** return the error class on the `null` branch from the server wrapper and log it before the 422. The front end's own handling (`apps/front-end/lib/files/prepare.ts:155`) is unaffected.

### 72. A status-less server error would be sent to the client as a 400 carrying its text

- **Severity:** Low (latent).
- **Where:** `lib/http/response.ts:87,111,115-121` (`handleApiError` → `apiError`).
- **Evidence:** `handleApiError(new CustomError('internal detail: db host x'))` returned `400` with that detail and wrote no log line: `apiError` defaults a missing status to 400, and the 5xx log skips `undefined`. `CustomError.status` is optional in `shared/error-class.ts`. No back-end code throws one today (the front end does, so the type stays optional).
- **Reachable when:** the first back-end `new CustomError(message)`.
- **Remediation:** in `handleApiError`, treat a missing status as 500 with the log.

### 73. Cache invalidation failures would be swallowed silently

- **Severity:** Low (latent).
- **Where:** `lib/cache/index.ts:136-163` (`cacheDelete`, `cacheDeletePrefix`), `lib/sqlite/store.ts:33-45` (`lazyStore.get`).
- **Evidence:** every cache catch swallows the error with no log ("a failed write is a future miss"), but a failed delete is a future stale hit; open failures are not logged either. `CLAUDE.md`: "No fallback that hides a failed operation."
- **Reachable when:** the first production caller invalidates through `cacheDelete` (the module has none today; see #78).
- **Remediation:** make invalidation throw (or log at error by class); log get/set failures by class, rate-limited.

### 74. Google sign-in hides the "verify your phone" routing code behind a generic refusal

- **Severity:** Low (latent).
- **Where:** `lib/auth/oauth/plugin.ts:164-168` (`serverFailure`) and the callback catch (`:574-591`).
- **Evidence (code trace):** an `APIError` below 500 outside state reading is logged at error level as `authentication_denied` and answered `{success:false}`/401. With `REQUIRE_PHONE_VERIFICATION` on and phone OTP available, `session.create.before` throws 403 `PHONE_NOT_VERIFIED_CODE` (`lib/auth/session/hooks.ts:115-124`), which password sign-in passes to the client; the Google user never sees it. (The email variant cannot fire: linking sets `emailVerified`.)
- **Reachable when:** the owner turns on phone verification with SMS enabled. The user can still recover through password sign-in.
- **Remediation:** carry declared routing codes through `/oauth/result` (a compatible contract extension), and log user-state refusals at warn.

### 75. A passkey counter at or above 2^31 breaks that authenticator for good

- **Severity:** Low (latent).
- **Where:** `db/schema.ts:555` (`passkeys.counter integer`, migration `0005`).
- **Evidence:** WebAuthn's signCount is an unsigned 32-bit value. `db.update(passkeys).set({counter: 2147483648})` fails with `22003 integer out of range` even when no row matches.
- **Reachable when:** an authenticator reports a count of 2^31 or more (none known to be common). Then registration and every assertion (`passkey-assertion.ts:110-114`) answer 500.
- **Remediation:** widen the column to `bigint` (mode `number`); the previous release keeps working.

## Improvements

### 77. Turnstile is checked three different ways, with three different refusals

- **Where:** Better Auth's `captcha` plugin for `/sign-in/email` only (`lib/auth/index.ts:151-158`); hand calls to `verifyTurnstileRequest` in `lib/auth/passwordless.ts:62-64` and `lib/auth/oauth/plugin.ts:319-323`; bindings through `lib/http/admit.ts:133`.
- **Now:** the plugin answers a missing token 400 `MISSING_RESPONSE`, a siteverify outage 500 after a 10 s timeout, and has no token-length cap (better-auth 1.7.14 `dist/plugins/captcha`); the project's verifier answers 403 `captchaFailed` with a 3 s timeout and `CAPTCHA_TOKEN_MAX_LENGTH`; OAuth start answers 403 `MSG_INVALID_INPUT`. The `captcha` flag on `RoutePrefixPath` drives only OpenAPI (`merge-better-auth.ts:406`): a path flagged `captcha: true` without a hand-written call would publish the header and enforce nothing. Stale TODO at `lib/auth/index.ts:156`.
- **Alternative:** in `server/elysia/auth-mount.ts`, after the pre-auth limit and before `auth.handler`, refuse with `captchaRefused()` when `known.captcha` and `verifyTurnstileRequest` fails; delete the plugin and the two hand calls. Pre-auth still runs first, so the N+1 siteverify bound holds; the IP source is the same header. **Cost:** `/sign-in/email`'s missing-token answer goes 400→403 and its outage answer 500→403 within 3 s (both statuses already published); OAuth start's message changes; passwordless's captcha refusal moves ahead of its timing floor (it reveals nothing about an account). `tests/integration/sign-in-controls.test.ts:452-532` needs updating. Closes #51.

### 78. The SQLite cache module has no production caller

- **Where:** `lib/cache/` (whole module), marked "⚠️ SCAFFOLD: no call site uses this yet".
- **Now:** `cacheGet`/`cacheSet` are used only by `tests/integration/cache-get-schema.test.ts`; `closeCacheStore` (`server.ts:79,182`) closes a store nothing opens. The module carries the `'disposable'` durability (`lib/sqlite/database.ts:15,69`), `CACHE_DB_PATH` (`lib/env.server.ts:288-289`), unit tests and fixtures, and five mentions of `cache.db` in `reports/coolify-deployment.md`. `CLAUDE.md` asks for no speculative layers.
- **Alternatives:** delete the module and everything above (re-add from git when a caller appears; this also closes #73); or keep it and record the scaffold as an owner entry in `reports/should-ignore.md`. Owner decision.

### 79. Half of the request-reader layer serves only tests

- **Where:** `lib/http/request.ts:36,67-91,218-223` (`buildRequestMeta`, `withBodyPolicy`, `safeReadJson`), `lib/http/contract.ts:16-18,30-35,46,52-54` (`HandlerInput.readJson`, `HandlerRequestMeta.query/params`), `lib/http/binding.ts:44`, `lib/http/run.ts:60,78`, `server/elysia/auth-mount.ts:70`.
- **Now:** production reads JSON bodies only through the gate's `readJsonObject` (`server/elysia/gate.ts:38-44`); `withBodyPolicy` is used in production once, at `run.ts:78`, for `.readFormData`. The JSON branch, `safeReadJson`, `readJson`, the `params` argument (no caller passes it) and the `query`/`params` meta fields (stripped at `run.ts:60`, excluded at `binding.ts:44`) are reached only from `tests/unit/request-body-policy.test.ts` and `tests/integration/upload-auth-gate.test.ts`. `auth-mount.ts:70` builds a full meta (URL parse plus IP validation) to pass two fields, while `admit.ts:97` and `server/elysia/openapi.ts:122` pass the literal. Three comments describe the old adapter (`contract.ts:30-35,52-54`, `app.ts:150`). The unit test that calls itself the only end-to-end media-type check exercises the dead reader; `readJsonObject` was probed with `Application/JSON`, `…; charset=utf-8`, `application/jsonx` and `text/plain` and behaves correctly, but no test pins that.
- **Alternative:** one multipart lazy reader taking a `Request`; drop the JSON half, the unused meta fields and the `params` argument; give `auth-mount.ts` the literal; fix the comments; point the unit test's JSON cases at `readJsonObject`. About 60 lines removed, no contract change. (The binding option `maxJsonBodyBytes` is live and stays.)

### 80. The allow-list gate keeps a server-only exemption that only tests use

- **Where:** `lib/auth/path-policy.ts:144` (`SERVER_ONLY_OPERATIONS = {'generateTOTP'}`), used at `:153-162`.
- **Now:** the allow-list hook lets Better Auth's server-only `generateTOTP` through. Only integration tests call `auth.api.generateTOTP` (`two-factor-totp`, `two-factor-management`, `two-factor-trusted-device`, `caught-database-faults`, `oauth-email-rotation`, `auth-error-localisation-second-factor`). The exemption's own comment warns it must never widen to `viewBackupCodes`.
- **Alternative:** delete `SERVER_ONLY_OPERATIONS`, `SERVER_ONLY_VIRTUAL_PATH` and the `serverOnlyEndpoint` branch. Tests compute codes with `createOTP(secret, { period: TOTP_PERIOD_S }).totp()` from `@better-auth/utils/otp`, which production already imports (`lib/auth/two-factor/totp-replay.ts:14,50`). The library endpoint does exactly that (`better-auth/dist/plugins/two-factor/totp/index.mjs:43`).
- **Gain:** the security gate has no exemption at all. **Cost:** test edits only; no contract change.

### 81. The session-liveness path list is a hand-kept copy of the allow-list

- **Where:** `lib/auth/path-policy.ts:71-102` (`LIVE_SESSION_PATHS`, `DUAL_MODE_LIVE_SESSION_PATHS`).
- **Now:** 23 hand-copied strings that today equal the `lib/auth/allowed-paths.ts` rows with `session: 'session'` / `'session-or-challenge'`. A new `session` row that is not copied skips the liveness check, so a suspended user with a valid cookie cache keeps access for up to 5 minutes, and no test would fail (`tests/integration/session-cookie-delivery.test.ts:311-317` covers two Better Auth paths).
- **Alternative:** derive both sets from `BETTER_AUTH_KNOWN_ENDPOINTS` filtered on `session`. `path-policy.ts` already imports `allowed-paths.ts`. Identical behaviour.

### 82. Index migrations have no documented path, and the obvious one fails at deploy

- **Where:** `db/schema.ts:7-9` (documents the hand-written `db/migrations/` path only for trigram indexes); `scripts/lint-migrations.ts:94-98`; drizzle-orm 0.45.4 `pg-core/dialect.js:60` (one transaction per pending batch).
- **Now:** drizzle-kit's generated `CREATE INDEX` on an existing table is refused by Squawk; a lone `CREATE INDEX CONCURRENTLY IF NOT EXISTS` in `db/drizzle/` passes Squawk but fails `db:migrate` ("cannot run inside a transaction block"). The working path (a single-statement file in `db/migrations/`, `scripts/migrate.ts:13-18`) is half-documented, and nothing says whether a btree index should also be declared in `schema.ts`. Findings #24 and #25 need this path; migration `012` followed it.
- **Alternative:** a header recipe in `db/schema.ts` (declare in `schema.ts`, strip the generated statement, add a single-statement concurrent file in `db/migrations/`); optionally make `lint-migrations` refuse `CONCURRENTLY` under `db/drizzle/`.

### 83. Folder listings count each subfolder's files by visiting every file row

- **Where:** `lib/media/folders.ts:61-71,253-263` (`FOLDER_FIGURES.fileCount` per listed subfolder), same correlated shape in `searchFolders` (`:299`) and `subtreeTotals` (`:333-353`).
- **Now:** on 200k files in 500 root folders, the root listing ran 500 bitmap heap scans, 166 ms; it grows linearly with files per folder. The count-at-scale cost itself is owner entry should-ignore #29; the index is new.
- **Alternative:** a partial covering index `files(folder_id) include (size_bytes) where status='active'` made it an index-only scan, 23.7 ms (about 7×). Cost: one additive concurrent migration and index upkeep on file writes. `libraryTotals` stays a sequential scan either way. Fix the comment at `folders.ts:61-62` that says only the details route carries an unbounded count.

### 84. Cloudflare purges are sent 30 URLs at a time though the API takes 100

- **Where:** `lib/cloudflare/purge.ts:11-12` (`PURGE_BATCH_SIZE = 30`, commented as the API's per-call ceiling); followers `lib/media/visibility.ts:460`, `lib/media/orphaned-objects.ts`.
- **Now:** Cloudflare's purge limits list 100 URLs per request on Free, Pro and Business (500 on Enterprise). A 200-file delete makes 7 sequential calls inside the 25 s budget instead of 2; the 900-call budget covers about 27k URLs per 5 minutes instead of 90k.
- **Alternative:** `PURGE_BATCH_SIZE = 100` (unit tests are parameterised on it). The owner can confirm with one real 100-URL purge against the zone.

### 85. The re-auth window accepts a missing start time and quietly weakens its revocation check

- **Where:** `lib/auth/reauth/window.ts:37-39` (`mintAdminReauth`).
- **Now:** `startedAt` is optional and falls back to the clock at mint time, which cannot see a revocation between verify and mint. Both callers pass it (`lib/auth/reauth/plugin.ts:159-163`, `modules/auth/reauth.ts:48-50`), so the fallback never runs.
- **Alternative:** make `startedAt` required and delete the fallback. The two test spies pass arguments through unchanged.

### 86. The image pipeline repeats a signature check that can no longer fail

- **Where:** `lib/media/image/process.ts:24-31,37-48,161,174-175` (`ALLOWED_IMAGE_TYPES`, `isAllowedImageType`, `validateMagicBytes`, the type guard, the `validatedSvg ?? validateSvgUpload` fallback); `lib/media/upload.ts:228-269` (`admitUpload`).
- **Now:** `admitUpload` already checks the signature through `lib/media/allowlist.ts:42-47`, the admitted type always comes from the image subset of the file table, and SVG always arrives with `validatedSvg`. So the signature branch of `validateMagicBytes` (and its `uploadMsg.contentMismatch` refusal at `upload.ts:262`), the type guard and the fallback cannot fire; only the animation check is live. Comments at `optimize.ts:2-3` and `allowlist.ts:38-39` say animation is enforced in `process.ts`.
- **Alternative:** call `isAnimatedRaster` in `admitUpload`; delete the rest; type the SVG input to require `validatedSvg`; move the unit tests that walk `ALLOWED_IMAGE_TYPES` to the file table. Keep `uploadMsg.contentMismatch` (the front end uses it). No contract change.

### 87. The role-permission matrix is written three ways

- **Where:** `writeRoleMatrix` (`lib/permissions/roles.ts:64`); hand-rolled inserts in `modules/permissions/collection.ts:144-152` and `modules/dev/sign-up.ts:53-61`; dead `input.permissions.length > 0` guards at `collection.ts:123,144,167` (`createPermissionSchema` requires at least one page).
- **Alternative:** `writeRoleMatrix(tx, id, pages, { prune: false })` at both sites (same single INSERT on a new role); drop the guards so `validatePermissionScope` runs unconditionally (strictly safer). Same statement count, no contract change.

### 88. The permission gate re-implements the re-auth window check

- **Where:** `lib/http/session.ts:51-59` (`requirePermission`).
- **Now:** line-for-line copy of `requireReauthWindow` (`lib/auth/reauth/window.ts:109-120`), same message, status and code; `session.ts` already imports `window.ts`.
- **Alternative:** `if (opts.reauth && result.allowed) await requireReauthWindow(result.userId, result.sessionId);`.

### 89. A constraint-error header argument can never carry anything

- **Where:** `lib/http/response.ts:105,128,139,160` (`handleApiError`'s `extraHeaders`), `lib/http/constraint-errors.ts:24-34,73,127` (`getErrorHeaders`).
- **Now:** the only callers pass `getErrorHeaders(error)` for a Postgres unique or foreign-key violation, whose types never define `responseHeaders`; only `CustomError`s set it. So the argument is always `undefined` and its four uses are dead.
- **Alternative:** delete `getErrorHeaders` and the parameter. No caller or test passes a third argument.

### 90. List handlers re-parse the raw URL instead of using the validated query

- **Where:** `lib/data-table/params.ts:64-69` (`parseDataTableParams`), callers `modules/users/collection.ts:58-67`, `modules/permissions/collection.ts:48-57`, `modules/media/library.ts:49-56,75-85`.
- **Now:** each handler passes `meta.url`; the function re-parses it and re-runs `assertDataTableParamKeys`. `bind()` already refuses unknown keys (`dataTableQuerySchema` is a strict object, `shared/data-table/query.ts:20`) and repeated keys (`repeatsDeclaredKey`, `lib/http/run.ts:53-58,128-140`) with the same 422, so the second check never fires through a binding. Media strips its own keys first (`dataTableUrl`) only to get past it. `DATA_TABLE_PARAM_KEYS` (`shared/data-table/parsers.ts:442-446`) is read only by `tests/unit/bindings.test.ts`.
- **Alternative:** pass the validated `query` object; delete the assert call, `dataTableUrl` and `DATA_TABLE_PARAM_KEYS` (keep `assertDataTableParamKeys` in shared for the front-end mock). Three handlers and three test files change. One value differs: a malformed escape such as `search=%E0%A4%A` stays literal in Elysia's decoder instead of becoming `U+FFFD`. No published contract changes.

### 91. The admin 2FA reset re-implements the target-reachability helper

- **Where:** `modules/users/two-factor.ts:102-119`.
- **Now:** it calls `assertTargetUserVisible`, then `validateRolePermissionScope(..., 'reachability')`, with nothing in between. That pair is `assertTargetUserReachable` (`lib/users/target-user.ts:80-92`), which `lib/users/delete.ts:84`, `lib/users/edit.ts:137` and `modules/users/sessions.ts:83` already use. (`lib/users/edit.ts:213-241` splits the pair on purpose for lock order and says so.)
- **Alternative:** one call to `assertTargetUserReachable(tx, {..., actorPermissions})`. Same queries, order and errors; one call site.

### 92. Removing a 2FA method reads the enrolled methods twice in one transaction

- **Where:** `lib/auth/two-factor/enrolment.ts:437,446` (`disableTwoFactorMethod`) and `:543,552` (`deletePasskey`).
- **Now:** `listEnrolledMethods` reads the intent rows, then `readEnrolmentState` reads them again in its `.intent`. Same ordering and mapping. One extra statement per removal.
- **Alternative:** call `readEnrolmentState(userId, tx)` once and use `state.intent` at both sites. Keep `listEnrolledMethods` for the list (`:410`) and set-default (`:489`) endpoints, which would otherwise pay for the heavier join.

### 93. A 2FA OTP availability check can never fire

- **Where:** `lib/auth/two-factor/otp.ts:125-128` (`assertOtpAvailable`), called at `:144` and `:188`.
- **Now:** the plugin is registered only when the module constant `TWO_FACTOR_OTP_AVAILABLE` is true (`lib/auth/two-factor/plugin.ts:428`; `shared/validation/two-factor.ts:59`) and its paths are allowed only then (`lib/auth/allowed-paths.ts:231`). Its comment says it answers like an unserved path, but it sends `otpMsg.invalidInput`, not `MSG_PAGE_NOT_FOUND`.
- **Alternative:** delete the function and its two calls.

### 94. Five anonymous auth routes pay a pre-auth limiter write that guards no lookup

- **Where:** the `passwordless/send`, `forgot-password/send`, `reset`, `second-factor/send` and `complete` bindings.
- **Now:** `/otp/send` and `/otp/verify` opt out of pre-auth because their per-destination budgets are tighter (`modules/auth/otp.ts:78-82,114`). These five siblings are `auth: 'public'` too, so the gate does no session lookup (`lib/http/admit.ts:185-186`), yet each request still writes the pre-auth counter (`admit.ts:96`, `lib/http/pre-auth.ts:72-83`) before the route's own limiter. The shared `preauth.auth.forgot-password` budget (120/min) sits under the sum of the four forgot-password limits (180/min).
- **Alternative:** `preAuthIpLimit: false` on the five bindings. Gain: one SQLite write per request. Cost: the combined per-IP cap on forgot-password goes. Related to owner entry P-16 but distinct: here there is no lookup to protect. Decide both together.

### 95. Over-long images are refused only after taking a place in the encoder queue

- **Where:** `lib/media/image/optimize.ts:60-67` (`measureEncodeCost` checks only area) vs `:283` (edge check inside the slot).
- **Now:** a 20000×10 PNG is charged 5 budget units, waits behind the active encode and holds one of the four queue places (where a full queue answers others 503, owner entry P-4), then gets 422 `IMAGE_TOO_LARGE`.
- **Alternative:** apply `MAX_IMAGE_EDGE` in `measureEncodeCost` from the same header read, keeping the in-slot check for direct callers. No contract change.

### 96. Search re-folds every candidate row because the folded text is not stored

- **Where:** trigram indexes on the expression `search_fold(col)` (migrations 005–010); `lib/data-table/params.ts:113` (users name/email, roles name/description, media display name), `lib/media/folders.ts:276-281` (`searchFolders`).
- **Now:** every candidate the index returns is rechecked by running `search_fold` again (13.6 µs per 20-character row, 66 µs at 160 characters). On 200k files: `report` (20k matches) 211 ms, a zero-match crafted term 163 ms, `pdf` (all rows) 1,656 ms, the 19-term OR shape 31.3 s. The expression index also misestimates rows (64 estimated against 20,000).
- **Alternative:** a stored generated column `search_fold(col)` with its own trigram index: 65 ms, 75 ms, 309 ms and 3.4 s (2.2–9.3× faster, correct estimates). **Cost:** adding a stored column rewrites the table under an exclusive lock while the old release serves; the expression indexes stay one more release, so writes maintain both; `foldedColumn` needs a per-table map; migration 004's "never change `search_fold`" rule then binds stored data too. No API change. Still linear in matches; the OR-filter refusal remains the bound for combined filters.

### 97. Signing one URL per list row costs several times what it needs to

- **Where:** `toMediaFiles` (`modules/media/library.ts`), via the SDK's `getSignedUrl`.
- **Now:** up to 100 signatures per `GET /api/dash/media`. Measured with dummy credentials, in memory: 17–85 ms per 100 keys (mostly 25–45) with `getSignedUrl`, against 3–11 ms with a reused `S3RequestPresigner`. The cost is the SDK rebuilding endpoint resolution, presigner and middleware per call.
- **Alternatives:** a reused presigner (about 30 lines that re-implement request building: the SDK adds `x-amz-checksum-mode=ENABLED` and uses extended escaping for `!*()'`, so it needs a byte-equality test against `getSignedUrl`); or, unmeasured and lower risk, cache signed URLs per (bucket, key, signing window, response params), since they are deterministic within a window.

### 98. The SVG sanitiser builds a new browser window for every call

- **Where:** `lib/media/image/svg.ts:41-47` (`sanitizeSvgServer`).
- **Now:** a new `JSDOM` per call; its comment says `runScripts: 'outside-only'` is what exposes `DOMParser`/`XMLSerializer`, which is false on jsdom 30.1.3. Medians over 60 runs: 10.6 ms with a new window, 3.2 ms with a shared parser and serializer, and each upload calls it twice (about 15 ms of worker time per upload, small beside P-5).
- **Alternative:** one module-level `JSDOM('')` with one `DOMParser` and `XMLSerializer` (outputs identical; `parseFromString` makes a fresh document each call; DOMPurify already shares one window; the worker runs one job at a time; heap flat over 6,000 calls). Delete the comment.

### 99. Credential rotation scans the verifications table twice

- **Where:** `lib/auth/session/rotation.ts:81-89,102` (`DELETE … WHERE value = userId`); `verifications.value` has no index.
- **Now:** 100k rows: sequential scans of 16.2 ms and 7.0 ms inside the user-locked rotation transaction. Live rows are about one day of ceremonies (the nightly sweep clears them), and rotations are rare.
- **Alternative:** a hash index on `value` (a btree is unsafe: passkey ceremony values have a library-decided length that can exceed btree's row limit): both deletes become 0.05–0.08 ms. Cost: index upkeep on every verification insert and delete, which is the sign-in hot path. Low value on its own; it matters more if the sweep backlog grows.

### 100. Credential rotation deletes each pending sign-in challenge in its own statement

- **Where:** `lib/auth/session/rotation.ts:84-110` (`revokeVerificationArtifacts`).
- **Now:** one DELETE per live challenge inside the transaction that holds the user's row lock: about N + 4 statements, N bounded only by the 5-minute challenge life and per-IP sign-in limits.
- **Alternative:** one `inArray` over every challenge's three keys: a constant 4. (`completeTwoFactorChallenge`'s two companion deletes go through Better Auth's adapter, which has no batch form; leave them.)

### 101. Recovery grants spend about six more round trips than needed

- **Where:** `lib/auth/recovery/grant.ts`.
- **Now (derived from the code):** `issueRecoveryGrant` wraps one multi-row INSERT in a transaction (3 round trips); `readRecoveryGrant` makes 2 SELECTs; `consumeRecoveryGrant` 3 DELETEs; `invalidateRecoveryGrant` a transaction around 3 DELETEs (5).
- **Alternative:** the bare INSERT (atomic on its own, as the sibling `spendRecoveryAttempt` already does); one `inArray` SELECT; keep the gated DELETE … RETURNING as the race election plus one `inArray` DELETE; one `inArray` DELETE. About 6 fewer per recovery flow; bounded, no behaviour change.

### 102. Long sweeps cannot stop at shutdown even though their passes already can

- **Where:** `lib/maintenance/schedule.ts:132-136` and `lib/maintenance/election.ts:21-29` (the stop signal reaches only the connection wait), `lib/maintenance/database.ts:373` (`runDatabaseSweep` takes no signal), `lib/media/orphaned-objects.ts:25,41-56` (each R2 pass has its own 10-minute budget and already stops cleanly, "markers kept; the next run takes them").
- **Now:** a deploy overlapping the 03:30 sweep or the Sunday reconcile ends in the documented forced exit (`lib/shutdown.ts:153-159`, `tests/process/schedule-drain.test.ts:121-145`), cutting R2 calls mid-flight.
- **Alternative:** combine the schedule's signal into each pass budget (`AbortSignal.any`) and check it between PostgreSQL batches. Threads through `runDatabaseSweep`, `sweepFiles`, `retryTransitions`, `sweepOrphanedObjects`, `reconcileObjectStore`; no contract or schema change.

### 103. Anyone can fill the error log through the storage health route

- **Where:** `lib/maintenance/token.ts:17-22`; route `modules/health/storage.ts:70` (`preAuthIpLimit: false`), contract `rateLimited: false`.
- **Now:** every wrong or missing token logs at error level. Each request already writes an access line, so the gain for an anonymous caller is alert noise on demand (relevant once error alerting exists, TODO "Do later 8"). `reports/coolify-deployment.md` blocks the path at the edge, which does not cover direct-to-origin requests.
- **Alternative:** log rejections at info or warn; keep error for a misconfiguration only. The failing health check is itself the operator's signal.

### 104. Maintenance election re-implements the bounded pool wait and logs a normal stop as a failure

- **Where:** `lib/maintenance/election.ts:26-29` (`db.$client.reserve({signal})`); `db/transaction.ts:65-80` (`reserveWithin`); `lib/maintenance/schedule.ts:84-90,139-140`.
- **Now:** the election's timeout surfaces as a raw `TimeoutError` DOMException, so the runbook's "look for `ConnectionTimeoutError`" misses scheduled jobs; a shutdown abort while waiting logs "scheduled sweep failed" at error.
- **Alternative:** export one `reserveConnection(signal?)` built on `reserveWithin` and use it in the election; in `schedule.ts`, log an abort caused by `stopping` as cancelled. No contract change.

### 105. A malformed id gets 404 on some routes and 422 on their siblings

- **Where:** `modules/users/two-factor.ts:56-57` (`POST /users/:id/two-factor/reset` answers 404) against the five other users `:id` routes and three permissions `:id` routes (422, the default in `lib/http/refusals.ts:184-191`); the seven media `:id` routes answer 404 by design (`FILE_ID_REFUSALS`, `FOLDER_ID_REFUSALS`).
- **Now:** two rules; inside the users module one route is the odd one out. Both answers are published and tested.
- **Alternative:** drop the override in `two-factor.ts` so it matches its siblings (contract change for one route, 404 → 422). Converging media is an owner call: its 404 carries `FILE_NOT_FOUND_CODE`.

### 106. Narrowing the email-provider list later would lock existing users out

- **Where:** `shared/validation/rules.ts:181-195,243` (`emailSchema` with the provider allowlist), used on sign-in (`lib/auth/path-policy.ts:213`), OTP and recovery sends (`shared/validation/otp.ts:117`), Google sign-in (`lib/auth/oauth/identity.ts:56`) and email change.
- **Now:** removing a provider from the list would answer 422 to that provider's existing users before any credential check, closing recovery too. `passwordSchema` carries a warning for exactly this trap (`rules.ts:327-331`); `emailSchema` has none. Distinct from owner entry Known #10, which is about who can register.
- **Alternatives:** at minimum the same warning on `emailSchema`; better, a format-only schema on lookup paths (sign-in, recovery, Google) and the allowlist only where an address is first written (create, dev sign-up, email change). The second widens the published pattern on lookup routes, which is compatible.

### 107. "List assignable roles" lists roles the server will not assign

- **Where:** `modules/users/roles.ts:12-36` (`GET /api/dash/roles`).
- **Now:** gated on `permissions.view` while assignment needs `users.create`/`users.edit`; filtered by creator under `own` scope, which assignment never checks; includes roles above the actor's own permissions, which assignment refuses with 403 (`modules/users/collection.ts:152-159`, `lib/users/edit.ts:245-253`).
- **Alternatives:** filter rows with `actorCoversTargetRole` (no contract change to the shape; the list gets shorter for narrower actors); changing the gate needs binding support for two permissions or a handler check, and would narrow access for `permissions.view`-only holders.

### 108. The "404, not 403" rule for outranking users protects nothing the detail route doesn't already show

- **Where:** `lib/permissions/scope.ts:17-29` (reachability answers 404 so a 403 cannot reveal that an account "exists and outranks me").
- **Now:** for the same outranking target, `GET /users/:id` answers 200 with the full permission matrix (owner entry should-ignore #9) while `PUT` answers 404; `authorization-and-audit.test.ts:340-361` asserts the 200. The two-mode `reachability`/`grant` concept costs a required parameter and a contract where one object is both found and not found.
- **Alternatives (owner call):** correct the rationale comment (no contract change); or answer 403 for reachability (fewer concepts; 404s on update, delete and sessions become 403); or hide outranking targets from GET (narrows the contract, revisits #9).

### 109. Custom-role helpers carry dead branches and unread fields

- `createCustomRole` (`lib/permissions/roles.ts:101-142`) is two functions behind a flag: rewrite an existing role (`lib/users/edit.ts:306`) or mint one (`edit.ts:325`, `modules/users/collection.ts:184`); its `createdBy ?? null` is dead. Split into `mintCustomRole` and `rewriteCustomRoleMatrix`.
- `RolePolicyTarget.roleName` is never read (`isProtectedSystemRole` reads only `scope`); five sites select `roles.role_name` only to pass it (`lib/users/edit.ts:127/141,202/219`, `lib/users/target-user.ts:62/74`, `modules/users/sessions.ts:70/87`, `modules/users/two-factor.ts:92/106`). Narrow the type and drop the selects (keep `lib/users/delete.ts`'s, which audits the name).
- The `ux_role_permissions_role_page` → `duplicatePagePermission` mapping (`lib/http/constraint-errors.ts:60`, `shared/messages/permissions.ts:40`) cannot fire: every write path refuses duplicate pages with 422 first and `writeRoleMatrix` upserts on that key. Delete both (not in the published contract).
- `refreshRoleSessions` restates `activeUser(...)` in raw SQL (`lib/permissions/session-refresh.ts:83-85`; same class at `lib/users/edit.ts:89-90`, `lib/users/delete.ts:76`, `modules/permissions/item.ts:368-371`, the last being owner entry should-ignore #27, now there); decide the class once. `refreshUserSessions(userId, tx?)`'s `db` fallback serves only `tests/integration/driver-contract.test.ts:553`; make `tx` required.

### 110. Session reading and cookie handling live in the permissions checker

- **Where:** `lib/permissions/checker.ts` (about 110 of 449 lines: `refusedReadCookies`, `authenticatedSession`, `refreshSessionCookies`, `expireSessionCookies`, `sessionRefused`, `queueRefreshedSessionCookies`, `hasSessionCookieCache`, `readLiveSession`).
- **Now:** session-only consumers import from the permissions module (`lib/http/session.ts:14-20`, `modules/users/contact-change.ts:23`, `modules/users/me.ts:37-40`).
- **Alternative:** move them to `lib/auth/session/` (which holds `live.ts` and `cookie.ts`; `lib/auth` imports nothing from `lib/permissions`, so no cycle). Three imports change; no behaviour change.

### 111. The data-table layer carries dead helpers, unread fields and a misleading cast

- `escapeLike` (`lib/data-table/filter-columns.ts:63`) is used only by `tests/integration/trigram-floor.test.ts:41`, whose "pattern the production code builds" no longer matches production (escaping happens in SQL since migration 011).
- `Math.min(parsed.perPage, MAX_PER_PAGE)` (`lib/data-table/params.ts:84`) is a no-op; result fields `page`, `perPage`, `buildPageCount` are unread; `searchableColumns` is `string[]` and silently skips unknown names (`:112-113`) while filters throw.
- `parseFiltersState`, `parseSortingState`, `ParseSearchParamsOptions`, `stripControlAndTrim` (`shared/data-table/parsers.ts`) and `DataTableConfig` (`shared/data-table/config.ts:7`) are exported but used only in their own file; `minSearchLength` is never set by any spec.
- `shared/data-table/config.ts:106-111` casts `'asc' as FilterOperator`, justified by a consumer that uses the value as a plain string.
- **Alternative:** delete or un-export these, point the trigram test at `search_pattern`, type `searchableColumns` against the table's keys and `sortOrders` as the sort-order type. No contract change.

### 112. Two OpenAPI tables are enforced only by a test, not by generation

- **Where:** `lib/http/openapi/better-auth-tables.ts:253` (`LIBRARY_VERIFIER_PATHS`), `:285` (`BETTER_AUTH_TRUSTED_RESPONSES`); `librarySuccess` in `merge-better-auth.ts:243-319`.
- **Now:** no production code reads either; `librarySuccess` publishes any library 200 without consulting the trusted list. Only `openapi-contract.test.ts:2043-2055` enforces it.
- **Alternative:** have `librarySuccess` throw for a path missing from the trusted list (two lines), so generation enforces it; have the test read `Object.keys(LIBRARY_VERIFIER_DESCRIPTIONS)` and delete `LIBRARY_VERIFIER_PATHS`.

### 113. The OpenAPI builder has two reference-closure walks and four copies of one lookup

- **Where:** `lib/http/openapi/merge-better-auth.ts:145-147,260-264,421-425,549-550,606-625`; `lib/http/openapi/finalize.ts:213-218,282-303`.
- **Now:** one closure walks `$ref` keys; the other runs a regex over `JSON.stringify` (which also matches a `$ref`-looking string inside a description). The ref-name pattern is written three times and the `content['application/json'].schema` walk four times.
- **Alternative:** `refName`, a tree-walk `referencedComponents` and `jsonBodySchema` in `lib/http/openapi/json-schema.ts`, which already holds `isJsonSchema`. The generated document must stay byte-identical (checked by the snapshot test). About 25 lines fewer.

### 114. Two OAuth and passkey settings never take effect

- `ceremonyIdentifier` (`lib/auth/two-factor/passkey.ts:46-51`) truncates the WebAuthn key to 160 characters, but the key is 44 characters (challenge id 31, `issue.ts:51,246`) and longer ids never pass `readChallengeState`. If it ever did truncate, rotation's untruncated delete (`lib/auth/session/rotation.ts:98`) would miss the row. Use `twoFactorWebauthnKey(...)` directly at `passkey.ts:76,120`.
- `disableSignUp: true` (`lib/auth/oauth/plugin.ts:97`) is read only by Better Auth's social routes, which read `options.socialProviders` (not configured) and are not allow-listed; the project's own plugin never creates users. Delete it, or keep it with a one-clause tripwire comment.

### 115. The 2FA challenge stores a field nothing reads

- **Where:** `lib/auth/two-factor/issue.ts:259` (write), `lib/auth/two-factor/challenge.ts:74,93` (`ChallengeState.excludeContactKind`).
- **Now:** the exclusion is enforced through the stored option ids (`challenge.ts:197-200`); `readTwoFactorChallenge` reads only options, default, first factor and remember-me.
- **Alternative:** remove the field, its write and its parse. Rows live 5 minutes and the parser reads a missing field as null, so in-flight challenges survive a deploy.

### 116. Session-gated 2FA endpoints use three spellings for the same guard

- **Where:** `lib/auth/two-factor/trusted-device.ts:227,244,272`; fallbacks in `enrolment.ts:102,408`, `two-factor/plugin.ts:329`, `two-factor/otp.ts:88`.
- **Now:** the path-policy `before` hook refuses a missing session with `sessionRequired` before any of these run, so the clients see one answer. Inside, the fallbacks differ (`challengeMissingError` vs `sessionRequired`), `trusted-device.ts:244` writes `{ use: [sessionMiddleware] }` instead of `sessionOptions()`, and `revokeTrustedDevice` hand-parses `validID(bodyRecord(ctx).id)` although its contract declares `ownedRowSchema` (`shared/api/better-auth.ts:291`) and its sibling uses `parseAuthBody`.
- **Alternative:** `sessionOptions()`, `parseAuthBody(ctx, ownedRowSchema, MSG_INVALID_INPUT)` (same 422), and `sessionRequired()` as the one fallback.

### 117. Re-trusting a browser leaves the old trusted-device row behind

- **Where:** `lib/auth/two-factor/trusted-device.ts:157-188` (`grantDeviceTrust` always inserts).
- **Now:** a browser that already presents a valid trust cookie and trusts again (every Google sign-in followed by a trust click, since Google skips trust; TOTP enrolment, `enrolment.ts:277`) gets a new row; the old one stays live for 30 days, unusable, and is listed by the unbounded `listTrustedDevices`.
- **Alternative:** verify the presented cookie for this user and delete its row in the same transaction. No contract change.

### 118. A single-file move relies on a foreign-key error that two other routes map but can never hit

- **Where:** `lib/media/files.ts:154-189` (`updateFile`: unlocked `requireFolder`, then the FK race is mapped at `modules/media/files.ts:181`); unreachable `mapError: handleFolderForeignKeyViolation` at `modules/media/library.ts:179` and `modules/media/files.ts:91`.
- **Now:** `moveSelection` takes `lockTree` and locks the destination (`selection.ts:149`, `folders.ts:456-462`), and the only folder delete runs under `lockTree` (`selection.ts:545,627`), so the two bulk-move mappers never fire. `updateFile` reads the destination without a lock, so a concurrent delete makes its insert fail the FK, and only the mapper turns that into 404. No test races `PUT /files/:id` against a folder delete (`folder-foreign-key.test.ts` only unit-tests the mapper).
- **Alternative:** take the destination `FOR KEY SHARE` in `updateFile` (matches the lock order in `selection.ts:5-9`), so the 404 is deterministic; delete the two dead mappers. (Merging the two move paths is not worth it: it would put the global `lockTree` on every rename.)

### 119. Cache headers are guessed from MIME substrings instead of the known file kind

- **Where:** `lib/media/headers.ts:3-28` (`getCacheControlHeader`), called from `objectHeaders` (`:75`), which already receives `kind`.
- **Now:** `includes('document'|'word'|'excel'|'spreadsheet')` heuristics; over every allowed type, images get the immutable year and documents 3600 s; the final `86400` branch is unreachable.
- **Alternative:** choose by `kind`. Identical output for every allowed type; callers `lib/media/upload.ts:472` and `lib/media/visibility.ts:307` already pass it.

### 120. R2 helpers return values no caller reads

- **Where:** `lib/r2/client.ts` (`uploadToR2` `{success, key}`, `deleteFromR2` `{success}`, `copyFileInR2` `{success, newKey, etag}`, `ListedObject.size`).
- **Now:** `success` is always `true` (every failure throws); `key`, `newKey`, the delete result and `size` are unread (`upload.ts:468`, `visibility.ts:316`, `orphaned-objects.ts:88`, `reconcile.ts:69`). Only `tests/integration/harness.test.ts:285` asserts the shape.
- **Alternative:** `void` for upload and delete, `{ etag }` for copy, keys only for listing; one test assertion changes.

### 121. The OTP send function takes parameters every caller derives the same way

- **Where:** `lib/otp/send.ts` (`processOtpSend`); callers `lib/otp/anonymous-send.ts:84-91`, `lib/auth/two-factor/otp.ts:114-121`, `lib/users/contact-change.ts:144-152`.
- **Now:** every caller passes `sendTo` equal to `identifier`, and `entityName = CONTACT_LABEL[contactKindOf(channel)]`, which `processOtpSend` already computes (`send.ts:108`). The returned `attemptsRemaining` (`send.ts:66,272,303`) is never read. `targetIdentifier` is set only by contact change and can be derived from the purpose.
- **Alternative:** drop `sendTo`, `entityName` and `attemptsRemaining`; derive `targetIdentifier` from the change purposes. Three production call sites and about eight test sites. No contract change.

### 122. OTP verify writes the user-row lock by hand

- **Where:** `lib/otp/verify.ts:133-137`.
- **Now:** a hand-written `select id from users … for update`, identical to `lockUser(tx, userId)` (`lib/auth/user-eligibility.ts:46-56`), which `lib/otp/send.ts` already uses.
- **Alternative:** call `lockUser`. One line.

### 123. Marking a contact verified lives in the OTP module and takes the wrong type

- **Where:** `lib/otp/contact.ts` (`markContactVerified`).
- **Now:** a users-row write plus audit entry that takes an `OtpChannel` but uses it only as a contact kind. Callers pass a fake `'sms'` (`lib/users/contact-change.ts:265`) or literal `'email'` (`:202`, `lib/auth/oauth/identity.ts:158`, where no OTP is involved). The `onMissing` handling differs: `modules/auth/otp.ts:61,164` log `*.userVanished`, `lib/auth/passwordless.ts:110` throws without a log.
- **Alternative:** move it to `lib/users/contact.ts` (which already holds `contactOf(user, kind)`) taking a `ContactKind`. Six call sites. Decide one `onMissing` behaviour.

### 124. Three OTP names and comments say the wrong thing

- `modules/auth/otp.ts:99-101`: `failureLog: 'otp.send.deliveryFailed'` logs issuance refusals (resend wait, block, budget, database fault) caught at `lib/otp/anonymous-send.ts:113-117`. Delivery is deferred and its failures log as `after-response task failed` (`lib/http/after-response.ts:78-84`). Rename to e.g. `otp.send.issueFailed`.
- `lib/captcha.ts:109-114`: the `captchaRefused` doc says handlers return it; its only caller, the gate, throws it (`lib/http/admit.ts:133-134`).
- `shared/messages/otp.ts:62-64`: `otpTextFor` says "One line", but the text contains a newline.

### 125. Three spellings for "the class of a thrown error"

- **Where:** `utils/log.ts` `errorClassOf` (fallback `'Unknown'`, 16 production sites) and `errorTypeOf` (fallback `typeof`, 8 sites); inline `'UnknownError'` at `lib/auth/login-guard.ts:352` and `lib/auth/password/hash.ts:122,138`.
- **Now:** the `errorClass` log field uses three vocabularies for non-Error throws.
- **Alternative:** one helper used everywhere. If its fallback becomes `typeof`, two test assertions change (`oauth-review-regressions.test.ts:422`, `rate-limit-log-boundary.test.ts:189`).

### 126. Three comments describe the rate limiter wrongly

- `lib/http/client-ip.ts:6-9` says the header list keeps "Better Auth's limiter" on the same source; it is disabled (`lib/auth/index.ts:129-131`).
- `lib/rate-limit/fixed-window.ts:23-27` says the log-boundary test derives the full scope set; `tests/unit/rate-limit-log-boundary.test.ts:72-121` derives only pre-auth scopes and four of six OTP surfaces, and none of the binding scopes.
- `lib/env.server.ts:288` says the cache is safe on tmpfs, but `:289` fixes its path under `SQLITE_DIR`.

### 127. Configuration keys nothing reads

- `NEXT_PUBLIC_OTP_AUTO_VERIFY` is set in both apps' `.env`; no code reads it (`shared/config.ts:78-80` says so). `docs/two-factor-flow.md:28` still says the front end reads it.
- `.github/workflows/ci.yml:28` and `:294` set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` for back-end jobs; no back-end or shared code reads it (keep `:233`, the front-end job).
- **Alternative:** delete the key from both `.env` files, fix the doc line, drop the two CI lines.

### 128. The public origin has two variable names and an untested conflict check

- **Where:** `lib/env.ts:15-47`.
- **Now:** `PUBLIC_URL` and a legacy `NEXT_PUBLIC_URL` are both accepted, with a conflict throw no test covers. Only the dev `.env` uses the legacy name; CI, `scripts/openapi-snapshot.ts:61`, `tests/process/startup-gates.test.ts` and the runbook use `PUBLIC_URL`. `tests/helpers/run.ts:230-231` must set both to dodge the conflict.
- **Alternative:** rename the dev key, delete the second name and the conflict loop, drop `run.ts:231`. A deployment that sets only the legacy name then fails at boot with a clear error. `TODO.md:43` (a dev workaround) would need the new name.

### 129. The data-table pool's stated reason is wrong on the installed Bun

- **Where:** `db/index.ts:63-68`.
- **Now:** the comment says each distinct statement stays prepared until the connection closes, "backend memory without bound". Bun 1.4.4 keeps an LRU of 1,024 per connection (`bun-types/docs/runtime/sql.mdx:1599`). Probe, one connection, 1,300 distinct texts: `pg_prepared_statements` stayed at 1,024.
- **Alternative:** state the real reason (a bounded LRU that list-query churn would evict hot statements from). No behaviour change.

### 130. A shared module throws at import time, against the shared-package rule

- **Where:** `shared/api/all.ts:35-49` (`pluginPathOf`, called while `PLUGIN_ENDPOINTS` is built).
- **Now:** root `CLAUDE.md`: "Nothing else may throw or log at load", beyond the three public-env gates. This is the only other load-time throw in shared. Only the back end imports it and the input is static, so the risk is nil.
- **Alternative:** build the map without the throw and assert the prefix in `tests/unit/plugin-entries.test.ts` (or as a type constraint on the entries' `path`); or name the exception in the rule.

### 131. Shared holds front-end-only helpers and copy, and auth messages no route can raise

- **Where:** `shared/validation/rules.ts` (`getColorSchema`, `trimed`, `slugSchema`/`slugPreprocess`/`SLUG_MAX`), `shared/messages/validation.ts` (`MSG_COLOR_INVALID`, `MSG_SLUG_*`), `shared/validation/rules.docs.ts:91-94`; `shared/messages/auth.ts:68-144` (`betterAuthMsg`).
- **Now:** the colour and slug helpers and their copy are used only by three front-end files (and one back-end unit test), against the root rule that client-only copy belongs in the front end; the slug OpenAPI prose is never published. In Better Auth 1.7.14 none of 15 mapped codes (`USER_ALREADY_EXISTS`, `SOCIAL_ACCOUNT_ALREADY_LINKED`, `ACCOUNT_NOT_FOUND`, `CREDENTIAL_ACCOUNT_NOT_FOUND`, `FAILED_TO_CREATE_USER`, `PROVIDER_NOT_FOUND`, `INVALID_TOKEN` and others), nor `SESSION_EXPIRED`, is raised by a mounted route; `USER_ALREADY_HAS_PASSWORD` is raised nowhere. `auth-error-localisation-second-factor.test.ts` already keeps unreachable codes out of the map.
- **Alternative:** move the helpers and copy to the front end (three imports, no contract change) and delete the slug docs entry; delete the 16 dead map entries and `MSG_USER_ALREADY_EXISTS`.

### 132. Small consistency fixes in shared validation and constants

- `nullableIdSchema` (`shared/validation/rules.ts:168-171`) refuses with the sentinel `0`, which `idSchema`'s own comment (`:153-154`) says not to do; same message on the wire. Use `|| ''`.
- `MAX_ID` (`shared/constants.ts`) is only `positiveInt`'s default and all four callers pass `maxValue`. Make the argument required and delete the file.
- `TWO_FACTOR_OTP_CHANNELS` (`shared/validation/two-factor.ts:34,62`) aliases the private `ENABLED_TWO_FACTOR_OTP_CHANNELS`; the codebase uses `ENABLED_*` for the configured subset and the bare name for the full list, so the alias misreads. Export the `ENABLED_` name (callers: `lib/otp/config.ts`, `tests/matrix/two-factor-configuration.test.ts`, two front-end files).

### 133. Page and action labels live in shared but only the front end uses them

- **Where:** `shared/messages/permissions.ts` (`DASHBOARD_PAGE_LABELS`, `PERMISSION_ACTION_LABELS`); `shared/messages/validation.ts:138` (`actionUnavailableForPage`).
- **Now:** only `apps/front-end` imports the labels, against the root rule that client-only copy belongs in the front end; meanwhile the one server message about pages and actions quotes raw identifiers (`"publish"`, `"home"`) inside Arabic copy.
- **Alternative:** build `actionUnavailableForPage` from the labels (one call site, `shared/validation/permissions.ts:117`, whose arguments are already typed members of those unions). That fixes the message and makes the labels server copy.

### 134. The shared auth validation file mixes user administration with sign-in

- **Where:** `shared/validation/auth.ts` (lines 53-258 user-admin CRUD; 262-297 self-service; 1-51 login, captcha, `adminReauthSchema`).
- **Now:** the dominant layout is per domain (`shared/api/users.ts`, `shared/messages/users.ts`); `reauthPasskeySchema` already lives in `validation/reauth.ts` while `adminReauthSchema` does not; `auth.docs.ts` documents only `createUserSchema`.
- **Alternative:** `validation/users.ts` (+ `users.docs.ts`) for user CRUD and self-service; `adminReauthSchema` to `reauth.ts`; login and captcha stay. Reaches four back-end files, four shared files plus the docs loader key (`lib/http/openapi/docs.ts:41`), and about 11 front-end files. No behaviour change.

### 135. The schema keeps unused relations and a duplicate transition enum

- **Where:** `db/schema.ts` `verificationSessionsRelations`, `verificationCodesRelations`, `rolesRelations.users` (no relational `with:` uses them; Better Auth's adapter queries only its own models; drizzle-kit ignores relations); `fileTransitionEnum`/`FileTransition` (`:166,1108`) duplicating `FILE_TRANSITIONS`/`FileTransition` in `shared/validation/enums.ts:58-59`, imported only by `lib/media/visibility.ts:4`.
- **Alternative:** delete the three relations (keep `rolePermissionsRelations.role`, the reverse `roles.rolePermissions` needs), write `pgEnum('file_transition', FILE_TRANSITIONS)`, delete the schema type and repoint `visibility.ts`. No migration.

### 136. The test harness budgets one connection fewer than a process opens

- **Where:** `db/index.ts:96` (probe pool `max: 1`, not in `db/limits.ts`); `tests/helpers/provision.ts:137` (`WORKER_CONNECTIONS` = 10 + 4 = 14).
- **Now:** a process can open 15; the runbook already says 15. Absorbed today by `CONNECTION_RESERVE = 25`.
- **Alternative:** `PROBE_POOL_CONNECTIONS = 1` in `db/limits.ts`, used at both sites.

### 137. "Now plus N seconds" is written out in four places beside an existing helper

- **Where:** `lib/auth/verifications.ts:51-53` (`expiresIn`) against `lib/auth/login-guard.ts:246`, `lib/otp/send.ts:43`, `lib/otp/throttle.ts:41,45`.
- **Alternative:** one small time helper in `utils/` used by all five; also removes one reason `lib/otp` imports `lib/auth`. Low value.

### 138. Generic helpers sit inside `lib/auth`

- **Where:** `lib/auth/keyring.ts` (generic secret keyring used by `password/pepper`, `password/hash`, `lib/otp/key`, `lib/otp/hash`, `oauth/plugin`, `lib/env.server.ts`); `lib/auth/user-eligibility.ts` (login eligibility plus the global users-row lock order `lockUser`/`lockActor`/`lockTargetAndActor`, used across `lib/users`, `modules/*` and `lib/otp/send.ts`).
- **Now:** `lib/otp` imports `lib/auth` and vice versa at directory level. There is no module-level cycle and no init-order hazard, so the cost is only where a reader looks for them.
- **Alternative:** `lib/crypto/keyring.ts` (6 imports) and a lock-order module (about 11 imports). No behaviour change. Low priority.

### 139. The SVG sanitiser's file is named after the optimiser

- **Where:** `shared/images/svg-optimizer.ts` exports only `sanitizeSvg`; the optimiser is `optimizeSvg` in `svgo-config.ts`.
- **Alternative:** rename to `svg-sanitizer.ts`; update `lib/media/image/svg.ts:13`, `tests/unit/upload-validation.test.ts:62`, `apps/front-end/lib/files/prepare.ts:11` and two comments.

### 140. Small cleanups in the image pipeline

- `lib/media/image/rgba.ts:96-98` is the only `Bun.inflateSync` call and needs a trap comment about `windowBits`; its input is the server's own 32 px PNG (output at most about 4 KB), so it is safe. Use `node:zlib` `inflateSync`, as `optimize.ts` does, and drop the comment (identical bytes, probed).
- `OptimizeImageResult.format` is the constant `'webp'`, read only by tests; `processImage` hard-codes the type itself (`process.ts:187`). Drop it.

### 141. Two comments say the migrator imports media files by relative path

- **Where:** `lib/media/usage-sources.ts:6`, `lib/media/referrer-contract.ts:11`.
- **Now:** `scripts/migrate.ts:52-53` imports both through `@/lib/media/...`. The real constraint, stated in the migrator's header, is that nothing here may import `@/db` or `@/lib/env.server`.
- **Alternative:** state that constraint in both comments.

### 142. The back end runs Prettier twice: once as a formatter and again inside ESLint

- **Where:** `eslint.config.mjs:271-281` (`prettier/prettier`).
- **Now:** on a 34-file subset, `prettier/prettier` was the most expensive rule (10.9 s, 37.5% of rule time) while `bun fmt --no-script --check` took 0.33 s on the same files. `bun fmt --check` already runs in pre-commit, pre-push and CI (`ci.yml:64`); the front end and shared configs don't use the rule.
- **Alternative:** remove the rule block and `eslint-plugin-prettier` (keep `eslint-config-prettier`); decide whether `arrow-body-style` and `prefer-arrow-callback`, turned off only for this plugin, come back. The formatting gate itself stays enforced. Owner memory says new lint rules get fixed, not switched off; this removes a duplicate of a gate that remains, so the owner should confirm.

### 143. The unused-files script duplicates knip, which is the stricter of the two

- **Where:** `scripts/find-unused-files.ts` (201 lines); `.github/workflows/ci.yml:131-135`; `knip.jsonc:47`.
- **Now:** with a temporary orphan in `lib/`, both reported the same set; knip's entries are narrower than the script's whole `tests/` directory, so knip is stricter. The CI comment says knip covers only `tests/`. Knip 6.43 asks to remove `check` and `fmt` from `ignoreBinaries`. The front end already uses `bunx knip` alone. (Neither covers `packages/shared`; see #65.)
- **Alternative:** make `find:unused-files` run knip; fix the CI comment and the comments in `scripts/strip-comments.ts:12`, `tests/unit/harness-layout.test.ts:44,314`, `tests/process/startup-gates.test.ts:11`. Keep `strip-comments.ts`, which tests use.

### 144. A runtime import of a dev-only package would reach production unnoticed

- **Where:** `Dockerfile` (the `verify` stage installs dev dependencies and only typechecks; the runtime image is built but never booted, `.github/workflows/ci.yml:216-219`); `ci.yml:203-205` comment.
- **Now:** no live instance (every runtime import is a production dependency or an owner-accepted hoisted transitive). Nothing would catch one.
- **Alternatives:** run `bun run smoke` in the built image in CI (CI time); or enable `import-x/no-extraneous-dependencies` (installed) with disables for the five owner-declined transitives.

### 145. Container images float on tags while Actions are pinned to commits

- **Where:** `Dockerfile:11` and front-end `Dockerfile:8,39` (`oven/bun:1.4.4`), `.github/workflows/ci.yml:266` (`postgres:18-alpine`); `renovate.json:64`.
- **Now:** `reports/engineering-hardening-plan.md` says "nothing floats" and Actions are SHA-pinned, but images are not; the Renovate description ("pinned by major only") is stale.
- **Alternative:** Renovate's `docker:pinDigests` and `@sha256:` digests; cost: more digest PRs.

### 146. A tooling script imports from the test tree, forcing a special case in the image ignore list

- **Where:** `scripts/check-coverage.ts:21,27` imports `tests/helpers/coverage`; `.dockerignore:34-39` excludes the script by name.
- **Alternative:** move the helper to `scripts/` (three imports: `check-coverage.ts`, `tests/helpers/run.ts:37`, `tests/unit/coverage-provenance.test.ts`) and delete the exclusion.

### 147. Stale ignore entries and a note file that ships in the image

- Back-end `.gitignore`: `.pnp`, `.yarn/*`, `/.next/`, `/out/`, `.vercel`, package-manager debug logs, `/components/icon/generated-icons.json`; `.prettierignore`: `package-lock.json`, `.learn`; `.semgrepignore`: `.next/`, `out/` (none match anything here). Root `.gitignore:6` has a comment ("agent instructions stay local") with no pattern while `CLAUDE.md` is tracked. Tracked `read.md` matches no `.dockerignore` pattern, so it ships in the image.

## Stale entries

### `reports/should-ignore.md`

- **148.** **#1:** `validateAssignableRole` now reads the role `FOR SHARE` inside a transaction (`lib/permissions/roles.ts:186-199`), and both callers repeat it in their transaction (`modules/users/collection.ts:171`, `lib/users/edit.ts:233`).
- **149.** **#4:** fixed. `db/drizzle/0009_sudden_human_cannonball.sql` drops the column and the `file_context_table` type; no code references it.
- **150.** **#6:** fixed. `auditFields` appears nowhere.
- **151.** **#8:** no longer true. `GET /api/health/storage` exists (`shared/api/health.ts:14-30`, `modules/health/storage.ts`), a token-gated readiness check (no anonymous liveness route).
- **152.** **#12/#13:** no longer true for grants. `[{name:'home',permissions:{}}]` passes `adminUpdatePermissionBodySchema`, and PUT upserts it and prunes every other page (`modules/permissions/item.ts:206-214`, `lib/permissions/roles.ts:84-93`), leaving a role with no grants. An empty array is still 422.
- **153.** **#14:** fixed. `emailSchema` lowercases (`shared/validation/rules.ts:237-239`), `chk_email_lowercase` enforces it (`db/schema.ts:227`), and the only email lookup passes the parsed value (`lib/auth/path-policy.ts:227`).
- **154.** **#18:** moved to `effectiveSearchTerm` (`shared/data-table/parsers.ts:166-175`, called from `lib/data-table/params.ts:105`). The title says "truncated"; the code discards (as the body says), and now also below 3 characters or when not trigram-indexable.
- **155.** **#19:** fixed. A custom role with missing or empty permissions is a 422 at `bind()` (`shared/validation/auth.ts:117-150`; `lib/users/edit.ts:343-349`).
- **156.** **#20:** changed. The count is a per-role correlated count (`modules/permissions/collection.ts:74-77`); on 200k users its plan is an index-only scan of `idx_users_role_active` (2.2 ms). It still grows with the members of the roles on the page.
- **157.** **#23:** moved to `USER_UNIQUE_CONSTRAINTS`, `lib/http/constraint-errors.ts:53-56`.
- **158.** **#25:** fixed. Both callers pass the gate's actor, so `checkMultiplePermissions` adds no statement (`lib/permissions/checker.ts:406-447`).
- **159.** **#27:** moved. The raw-SQL `standardRoleFilter` duplicate is now `modules/permissions/item.ts:368-371`.
- **160.** **#40:** moved. `handleAdminEdit` is now `editUserAsAdmin` (`lib/users/edit.ts:157`); the inner join is unchanged.
- **161.** **#45:** no longer true. `argon2` 0.45.1 hashes on a native async worker; an event-loop probe across a 70 ms hash saw every expected tick.
- **162.** **#48:** partly. The role FK now maps to 400 `roleNotFound` and the folder FK to folder-not-found (`lib/http/constraint-errors.ts:94,117-131`); other FK violations still return 500.
- **163.** **#51:** fixed. Self-edit through `PUT /users/:id` is refused (`notSelf`, `modules/users/item.ts:162,190`), self-update takes only `name`, and `changePassword` revokes other sessions and pending proofs (`modules/users/me.ts:184,190`).
- **164.** **#52:** moved to `lib/auth/password/compromise.ts:23-74`; same behaviour, except `hibp.degraded` now logs on every failed attempt.
- **165.** **#53:** fixed. `verify` calls `consumePasswordProof` (`lib/auth/index.ts:58-64`, `lib/auth/password/proof.ts:57-64`): single use, expiring, bound to the hash, failing closed.
- **166.** **#54:** fixed. Change-password compares-and-swaps on the expected hash under the account lock (`modules/users/me.ts:160-177`); change-email is a two-step OTP flow whose commit locks the user (`lib/users/contact-change.ts`).
- **167.** **#58:** moved and partly no longer true. Sends now go through `lib/otp/anonymous-send.ts:74-121`; the cited test no longer exists. The per-IP limit and the per-destination quota answer 429 before the lookup, identically for real and unknown addresses; only limits after the lookup are hidden.
- **168.** **#61:** no longer true. `OTP_AUTO_VERIFY` is a hard-coded `false` in `shared/config.ts:80`, not an environment value; `utils/config.ts` is gone. The "pre-production TODO sweep" it cites has no `TODO.md` entry.
- **169.** **#62:** moved, and the purge it calls planned exists: `database-retention-sweep` (`30 3 * * *`) deletes sessions 30 days past expiry (`lib/maintenance/schedule.ts:36-41`, `lib/maintenance/database.ts:60,392`). Paths now `lib/users/session-page.ts`, `modules/users/sessions.ts`. The index point stands.
- **170.** **#63:** partly fixed. Only `cf-connecting-ip` is trusted (`lib/http/client-ip.ts:18`), so the Vercel half is gone; development falls back to `127.0.0.1` (`:52-54`). Production still answers 503 without it, and `TODO(proxy-trust)` remains.
- **171.** **#64:** moved to `lib/rate-limit/index.ts:25-49`, unchanged.
- **172.** **#65:** moved to `lib/rate-limit/index.ts:61-79`; the header values now travel as the 503's `cause` (logged by `utils/log.ts:326-327`) and include the invalid `cf-connecting-ip` value.
- **173.** **#66:** moved. Unknown-path preflights are answered at `app.ts:171-180`, known paths by `@elysia/cors`; both skip logging through the `preflights` set (`server/elysia/respond.ts:57,187,193`).
- **174.** **#67:** the cited `bench/uuid/` and `bench/image/` no longer exist.
- **175.** **Known #1:** moved and partly fixed. `auth_revoked_at` is stamped on rotation (`lib/auth/session/rotation.ts:159-162`) and enforced by Google sign-in and re-auth windows; the reset without 2FA is atomic under the user lock (`modules/auth/recovery.ts:225-245`). Passwordless and password session insertion remain open.
- **176.** **Known #4:** moved to `modules/permissions/item.ts:253,276` and `lib/permissions/session-refresh.ts`; substance unchanged.
- **177.** **Known #7:** moved to `lib/audit/index.ts`; still no secondary sink.
- **178.** **Known #8:** moved to `utils/log.ts:292-329`; request-hook throws now log only `errorClass` (`server/elysia/errors.ts:57-66`).
- **179.** **Known #12:** moved to `lib/rate-limit/index.ts:156-168`, `fixed-window.ts:96`; the cap is now per contact kind.
- **180.** **Known #13:** partly. The per-contact advisory lock is gone; the send now takes `lockUser(tx, userId, 'no key update')` first (`lib/otp/send.ts:127`). The budget is still charged inside the transaction (`send.ts:266`).
- **181.** **Known #14:** `app.ts` has no `@knipignore`. Tags are now at `shared/data-table/config.ts:39,41`, `shared/validation/rules.ts:414,417,424`, `shared/utils.ts:18`, `lib/cache/index.ts:135,148,165,170`, `lib/r2/client.ts:465`, `lib/auth/passkey-assertion.ts:63`, `lib/http/openapi/better-auth-tables.ts:311`. The shared-side tags are read by nothing, because no knip run covers `packages/shared`.
- **182.** **2FA-2 (OTP side):** partly. "Shares no lock" is no longer true: the send takes the user row first and every removal path takes it `FOR UPDATE` first, so a send that locks first has its code deleted by the removal. Still open: a send authorised before a removal commits writes a fresh code afterwards, because neither `sendTwoFactorCode` (`lib/auth/two-factor/otp.ts:102-122`) nor `processOtpSend` re-checks enrolment. Line references drifted (`lib/auth/two-factor/methods.ts:400,434`).

### `reports/performance-audit.md`

- **183.** **Header (line 5) vs P-5:** the header lists P-5 among fixed findings removed, while the summary table (line 23) and §2 (line 100) carry it open. The code says open: `admitUpload` runs `validateSvgUpload` (`lib/media/upload.ts:264-266`) before `chargeUploadBudget`.
- **184.** **§3, "TODO line 1" (precompile):** `bun build app.ts --target=bun` now bundles (2,411 modules, 6.1 MB, no `patch.json` reference) and imports cleanly. The css-tree `../data/patch.json` failure moved to the worker: building `lib/media/image/svg-worker.ts` and importing it fails with `MODULE_NOT_FOUND`. The worker is loaded by URL, so a bundled deployment still needs it as its own entry point.

### `TODO.md`

- **185.** **"Stale login proof can issue a session after credential rotation" (two copies, about lines 61 and 302):** the second copy is obsolete (it says delivery runs inside the send transaction and cites an "item 2.1" that no longer exists). In the first, the OTP-send half is fixed: `processOtpSend` locks the user row (`lib/otp/send.ts:127`), rotation purges `verification_sessions` under that lock (`lib/auth/session/rotation.ts:153-176`), and delivery runs after commit (`send.ts:279-299`); the reset without 2FA consumes the proof and writes the password in one transaction under the user lock (`modules/auth/recovery.ts:193-245`). The session-insertion half remains (#11). The proposed `authVersion` already exists as `users.authRevokedAt` (`db/schema.ts:181`, bumped at `rotation.ts:161`), checked only at `lib/auth/reauth/window.ts:46` and `lib/auth/oauth/identity.ts:114`. Paths moved: `lib/auth.ts` → `lib/auth/index.ts`/`path-policy.ts:227`; `utils/otp.ts` → `lib/otp/send.ts`; the reset handler → `modules/auth/recovery.ts`; `lib/auth/live-session.ts` → `lib/auth/session/live.ts:32`.
- **186.** **C-001 (user creation and bulk session revocation skip re-auth):** half fixed: user creation now requires re-auth (`shared/api/users.ts:73`); `revokeUserSessions` still does not (`:133`). "No route-table test" is no longer true: `tests/unit/bindings.test.ts:40-51,118-120` freezes a `REAUTH_ROUTES` list and `tests/integration/binding-gate.test.ts:101-116` walks the routes.
- **187.** **C-025 (folder deletion and file moves not coordinated):** fixed. `deleteSelection` runs under `lockTree` with a survey and re-survey (`lib/media/selection.ts:536-592`), `moveSelection` takes `lockTree` (`:149`), and the FK race maps through `handleFolderForeignKeyViolation` (`lib/http/constraint-errors.ts:152`). `bun tests/helpers/run.ts integration media-selection "--test-name-pattern=contention"`: 8 pass.
- **188.** **10.1 (audit trail has no external sink):** still open; moved. `auditLog` is `lib/audit/index.ts:245` (insert `:248`), and a second insert now exists in `auditMany` (`:303`), so "exactly one statement" is wrong. The "TODO in place" marker is gone. The `app/api/internal/db-sweep` pattern it points to no longer exists; the equivalent is the in-process schedule (`lib/maintenance/schedule.ts`, `election.ts`).
- **189.** **Third-party `Error.message` kept verbatim:** still open; every site moved: `utils/log.ts:292-311` (`serializeErrorLike`), `lib/http/response.ts:157` (any unhandled throw in a binding), `lib/captcha.ts:88-89`, `lib/auth/password/compromise.ts:62-64`, `lib/media/upload.ts:368-369,484-486`, `lib/otp/anonymous-send.ts:113-116` (one site for all anonymous sends). Throws in the request hook now log only `errorClass` (`server/elysia/errors.ts:60-66`).
- **190.** **Bulk session operations inside the role transaction:** still open; moved to `modules/permissions/item.ts:252-276` and `lib/permissions/session-refresh.ts:26-44`. The JSONB-merge consideration is done (`|| ${patch}::jsonb`).
- **191.** **OTP-2, C-002, C-017:** still open; moved. OTP-2: block `lib/otp/send.ts:185-198`, increment `:232`, blocked verify `lib/otp/verify.ts:174-180`, swallowed error `lib/otp/anonymous-send.ts:110-117`. C-002: `lib/rate-limit/api.ts` → `lib/rate-limit/index.ts:110,156-166`; `utils/otp.ts:759` → `lib/otp/send.ts:266`. C-017: `lib/auth/two-factor-otp.ts` → `lib/auth/two-factor/otp.ts:118,262,316`; recovery `lib/auth/recovery/second-factor.ts:56`; unique key `db/schema.ts:985-989`.
- **192.** **AUTH-6 / C-027 (Argon2 under `FOR UPDATE`):** still open; moved to `lib/auth/login-guard.ts:150-152,223-226,323`. The site list is wider than stated: sign-in (`path-policy.ts:227`), dashboard re-auth (`modules/auth/reauth.ts:39`), 2FA password re-auth (`lib/auth/reauth/password.ts:35-47`), contact change (`lib/users/contact-change.ts:77`) and change-password (`modules/users/me.ts:133`).
- **193.** **USR-5 (preferences write racing a delete):** still open; moved to `modules/users/me.ts:253-261` and `lib/users/delete.ts:120-121`.
- **194.** **`@knipignore` masks dead exports (line ~27; also should-ignore Known #14):** `app.ts` has none. The named files moved to `shared/data-table/config.ts:39,41`, `shared/validation/rules.ts:414,417,424`, `shared/utils.ts:18`; new tags at `lib/cache/index.ts:135,148,165,170`, `lib/r2/client.ts:465`, `lib/auth/passkey-assertion.ts:63`, `lib/http/openapi/better-auth-tables.ts:311`.
- **195.** **F-03 and PROD-2:** still open; moved (`lib/auth/index.ts:117-121`, `lib/permissions/checker.ts:349-365`; `modules/users/me.ts:70`, `modules/users/contact-change.ts:48,116`, `lib/users/contact-change.ts`).
- **196.** **P-14, DB-5, MEDIA-3 and "Do later 7" (substance unchanged, references drifted):** P-14's auto-verify branch is now `lib/otp/verify.ts:353-361` (cited `:363-370`); DB-5's delete is `lib/permissions/roles.ts:166` inside `destroyCustomRole` (`:148`), also reached from `lib/users/edit.ts:418` and `lib/users/delete.ts:123`, schema lines `db/schema.ts:194-196,218-220`; MEDIA-3's `readStream` is `lib/media/office/cfb.ts:290-291` (call `:427-431`) and the entity lookup `lib/media/office/ooxml.ts:224`; "Do later 7"'s `utils/validation/rules.ts:112-116` is now `shared/validation/rules.ts:181-195`.
- **197.** **"Do later 6" (soft-deleted users accumulate):** the code now records the opposite decision, "deliberately NO purge sweep" (`db/schema.ts:203-207`, `lib/maintenance/database.ts:22-24`), because the `audit_logs.user_id` restrict FK would make a purge fail. The entry (and should-ignore Known #9) still says it will be fixed later; the owner reconciles the two.
- **198.** **HTTP-1:** the code still matches, but its references moved: the caller is `lib/http/admit.ts:95` (`lib/http/adapters/` is gone), case 6 is `tests/integration/cross-origin-writes.test.ts:100-103`, the `app.ts` comment is at `:62-65`.

### `reports/coolify-deployment.md`

- **199.** **Topology (line 16; also 746-747, 770):** says one pooled client and "11 per app process… 50 covers 3 app processes". The code opens three pools, 10 + 4 + 1 = 15 connections per process (`db/index.ts:45,74,95`; `db/limits.ts:17,24`); line 692 of the same document already says 15. The `max_connections` arithmetic needs redoing.
- **200.** **Line 30:** links the Elysia 1.4 deploy docs; Elysia `2.0.0-rc.1` is installed.
- **201.** **Settled decisions (36-54; §9 1806, 1843-1848, 1862):** say two in-process sweeps and that `reusePort: false` keeps them single-runner. There are three jobs (`object-store-reconcile`, `0 4 * * 0`, `lib/maintenance/schedule.ts:44-61`), and single-running comes from the writer lock (`server.ts:103-109`, `lib/sqlite/writer-lock.ts:33`), directory ownership (`lib/maintenance/ownership.ts:25-60`) and per-run election (`lib/maintenance/election.ts:21-43`). §9 lines 1866-1870 already say so.
- **202.** **Gate 1 (77-80):** cites `formatDate` in `utils/index.ts` and `utils/time.ts`; neither exists. `BUSINESS_TIMEZONE` is at `shared/config.ts:34`.
- **203.** **Gate 2 (99-116) and the §5 callout (1043-1047):** describe the Elysia 1.4 path-offset bypass in the present tense, an option (`standardHostname`) the installed Elysia lacks, and a removed sweep route; §5 still says "currently bypassable". The fix is `isRoutableHost` (`lib/http/routing.ts:212-216`, called at `app.ts:154`).
- **204.** **Gate 3 (129):** cites `bench/sqlite/FINAL-REPORT.md`, which does not exist. The gate itself is still open (no `secure_delete` in `lib/sqlite/database.ts:72`).
- **205.** **Token generation (137, 500, checklist 2371):** says `openssl rand -hex 32` "and nothing else"; the boot errors recommend `openssl rand -base64 32` (`lib/env.server.ts:194,197,310,319`). The owner picks one.
- **206.** **Migrations (191-193):** says the command applies two phases. `scripts/migrate.ts` has a third, the referrer-contract check (`:275-286`), which can exit 1 after phases 1-2 commit (`:291`), and sets `lock_timeout = '10s'` (`:250`).
- **207.** **Media deletes (213-220):** says a purge runs on private deletes too; `lib/media/lifecycle.ts:135-146` and `lib/media/orphaned-objects.ts:110-113` purge public objects only.
- **208.** **OpenAPI (269-271):** says the document is built on the first authorised request; in production it is built at boot (`server.ts:132`, `lib/http/openapi/serve.ts:56-71`).
- **209.** **Front-end API URL (302-304):** says an unset `NEXT_PUBLIC_API_URL` falls back to an IP; `apps/front-end/lib/env.js:25-26,57` now throws.
- **210.** **`--no-env-file` rationale (358-360):** both vectors it names are closed: the root `.dockerignore` excludes `**/.env*` (lines 12-13) and the image runs as `USER bun` with a root-owned `/app` (`Dockerfile:58-61`). The flag is now defence in depth only.
- **211.** **Startup refusals (391-403):** says five refusals, each a `startup rejected` line. The writer-lock claim is a sixth (`server.ts:105-109`); the environment gates throw out of `import('./app')` (`server.ts:73`) before the fault handlers exist, so they print a stack trace, not `startup rejected` (probed); an empty `PORT` defaults to 3000 (`lib/startup.ts:79`).
- **212.** **Bun pin (329 vs 411):** says the pin has "exactly one home"; it is in three `packageManager` fields (root, back end, front end; `server.ts:25` reads the back-end one) and three `FROM oven/bun:1.4.4` lines.
- **213.** **Startup log (458):** shows `"maxRequestBodyBytes": 8388608`; the value is 12582912 (`lib/http/request.ts:22`; §5 line 1056 already says 12 MiB).
- **214.** **§3.3 idle-in-transaction timeout (688, 798-811, 841-844):** has the operator set the role to 10 s and verify through `pg_roles.setconfig`. `db/index.ts:43-50` sends `idle_in_transaction_session_timeout: 60000` as a connection setting, which overrides the role (probed on PostgreSQL 18.6: value 60000, source `client`). Production runs with 60 s while the verification query shows 10 s.
- **215.** **§3.2 pepper rotation (707-709, 721-728):** describes a 500 and an account-existence oracle when a pepper id is missing. Now a missing pepper returns `valid: false` (`lib/auth/password/hash.ts:112-127`), the attempt counts normally (`lib/auth/login-guard.ts:223-242`), and OTP answers `no-code` (`lib/otp/verify.ts:208-217`).
- **216.** **Pepper revert (729-735):** says reverting only the active id is accepted silently; it is now a boot failure (`lib/auth/keyring.ts:189-201`, run at load by `lib/env.server.ts:228`).
- **217.** **Line 713:** says no event tells you rotation is done; `bun run preflight:credentials` (`scripts/check-password-peppers.ts`) answers that. The 8-key keyring cap (`lib/auth/keyring.ts:14,164`) is not documented.
- **218.** **R2 (613-629):** listed as feature-dependent and read at point of use; in production `lib/env.server.ts:131-142,219-221` refuses boot without buckets, `R2_PUBLIC_URL` for the public bucket, and credentials.
- **219.** **`PGOPTIONS` (823):** says it is ignored by `bun:sql`; on Bun 1.4.4 it is applied (probed: `work_mem` 7168 kB, source `client`).
- **220.** **Environment details:** line 490 lists `TZ` as required, but only tests read it; line 493 omits two `BETTER_AUTH_SECRET` refusals (the Better Auth default, fewer than 8 distinct characters; `lib/env.server.ts:188-189,196-197`); line 657 omits that readiness also fails on a wedged application pool (`modules/health/storage.ts:64`); the switches table (573-580) omits `PHONE_NUMBER_MODE`, `REQUIRE_EMAIL_VERIFICATION`, `REQUIRE_PHONE_VERIFICATION` and `OTP_AUTO_VERIFY` (`shared/config.ts:52,64,70,80`).
- **221.** **§4 (879-919, 890-893, 1984):** says Elysia defaults `reusePort` to true (Elysia 2's Bun adapter passes `serve` through unchanged; `app.ts:129` sets false, which is Bun's default); says `get-session` answers 500 under SQLite lock contention (it answers 503 with `Retry-After: 30` from the pre-auth limiter, probed at about 2.3 s, `lib/rate-limit/index.ts:236-244`); says "all 22 pre-auth routes" (46 of 49 production bindings run it; `otp/send`, `otp/verify`, `health/storage` opt out); says five OTP surfaces (six, `lib/rate-limit/index.ts:98-107`); lists two SQLite files (`.writer-lock.db` too, `lib/sqlite/writer-lock.ts:7,38`).
- **222.** **§5 (1037, 1105, 1115-1172, 1122-1125, 1146, 1182-1184, 1206, 1334):** `toRegisteredRoutes` is now `registeredBindings` (`modules/index.ts:32`); `Allow` is computed per sub-path and includes `HEAD` where `GET` is served (`lib/http/routing.ts:146-157`; probed); image encoding is now a guided search with `MAX_LADDER_RUNGS = 128`, `MAX_ENCODE_ATTEMPTS = 16` and an admission of one running plus four waiting (`lib/media/image/optimize.ts:108-109,373`); SVG work runs in a Worker with a 15 s timeout, not synchronously (`svg-jobs.ts:213-218`); `TODO.md` "EM-1" and "H4" do not exist; `preAuth: 'ip-limit'` is now `preAuthIpLimit?: false` (`lib/http/binding.ts:231`).
- **223.** **§6 (1254-1335):** Elysia 2 wires no process events; shutdown stops Bun's listener directly and extends grace while requests drain, with a `graceful stop still draining in-flight requests` log line the document never mentions (`lib/shutdown.ts:44-128`); `stopAndDrain` waits for the whole run, not a batch boundary (`lib/maintenance/schedule.ts:189-194`); the Dockerfile `CMD` is exec form with no `exec` (`Dockerfile:72`; also line 335); seven media bindings run at 120 s, not six; the close order also stops the pool watchdog and SVG worker and releases the writer lock last (`server.ts:174-184`).
- **224.** **§9 and §7 (1937, 1456-1459):** `removed.tempFiles.removed` does not exist, and `logRun` logs only `status`, `durationMs` and `hasMore` (`lib/maintenance/schedule.ts:63-74`); an R2 failure shows as `status: "degraded"`. The storage route also answers 503 `{"status":"error"}` (`modules/health/storage.ts:138-145`).
- **225.** **§8 and others (1549, 1569, 1590-1595, 1676, 1708, 1841):** the cheap health check runs two 2 s races in sequence (`db/index.ts:93,123-191`), so about 4 s worst case leaves little room in a 5 s timeout; §8 never asserts health status; `sharp` is not a back-end dependency and `bench/` does not exist; `TODO.md` has no sentinel entry; the verify stage runs `bun run build` → `bun check`, not `tsc --noEmit`; `lib/maintenance/sqlite.ts` has no framework statement. Line 1574's Coolify link anchor can only be checked on GitHub.
- **226.** **§15 (2531, 2538-2540, 2609-2611):** the search floor moved to `shared/data-table/parsers.ts:72-136`; since migration 011 a term the database cannot index matches nothing (`search_trigram_pattern` returns NULL, `lib/data-table/filter-columns.ts:81-83`), not a full scan; the database now folds the term, so a TypeScript/SQL fold mismatch affects only which terms are admitted.
- **227.** **§13 (2239-2240, 2256-2257, 2264):** the year-long `immutable` cache applies only to images (documents 3600 s, others 86400 s, `lib/media/headers.ts:13-27`); the purge-pair and `R2_PUBLIC_URL` format checks run in every environment, not only production (`lib/env.server.ts:76-112,129`).
- **228.** **§14 and §12 (2507, CI):** says the repository has no front-end application (`apps/front-end` exists); the CI job is `tests:` with `TZ` set job-wide and two boot smoke steps (`.github/workflows/ci.yml:143,163,256,279-281`).
- **229.** **Lines 319 and 326:** cite a §5 rule against caching `/api/auth/*` that is not in §5 (it is in §14, line 2499; the code sends `no-store` itself, `lib/http/response-policy.ts:23,84-85`); line 326 curls `/api/health/storage` from outside, which §5 line 1029 blocks at the edge.
