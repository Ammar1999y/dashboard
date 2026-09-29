# Unstaged changes review

## 1. Summary

- **Staged: 185 files**, all in `apps/back-end` and `packages/shared`: 154 modified, 26 new, 5 deleted. Git shows two of them as renames: `utils/startup.ts → lib/startup.ts` and `sessions/pagination.ts → lib/users/session-page.ts`. None of the staged files has unstaged changes left.
- **`bunx tsc --noEmit`** (apps/back-end): exit 0, no errors.
- **`bun run test`** (apps/back-end, unit): **1160 pass, 0 fail**, 5672 `expect()` calls, 38 files, 596 s.
- Not run: `test:integration`, `test:process`, `test:matrix`. They need the database and were not in scope.
- **Left unstaged:** 2 notes files at the root, and everything under `apps/front-end`.

I held nothing back for behaviour reasons. Every change is one of: an import or comment edit, a move, a helper extraction checked against the code it replaced, or a constant with the same value. Each changed declaration was compared against its old version, and each new helper was opened and compared check by check: same order, messages, status codes and defaults.

## 2. What still needs your review

**Front-end imports from `@app/shared/validation/two-factor` (staged, but check it).**
`TWO_FACTOR_METHODS_VAR` and `TWO_FACTOR_OTP_CHANNELS_VAR` moved to the new `@app/shared/validation/two-factor-lists`. `two-factor.ts` imports them but no longer re-exports them. All back-end callers are updated and tsc passes. I did not look inside `apps/front-end`, so a front-end file that imports either name from the old path would fail its type-check. Run the front-end type-check, or grep for those two names.

Nothing else needs a decision.

## 3. Small real changes staged anyway

- `scripts/check-password-peppers.ts`: a `null` credential password is now counted as a failure explicitly. Before, the same row failed through the thrown error. The DB constraint `chk_credential_password` makes such a row impossible anyway.
- `scripts/migrate.ts`: the `as Array<{ present: boolean }>` cast is replaced by a runtime shape check. The outcome is the same.
- `lib/auth/reauth/window.ts`: `mintAdminReauth` now takes an options object instead of positional arguments. The defaults are the same, and both callers are updated.
- `lib/media/image/svg.ts`: `sanitizeSvgServer` lost its `convertColor` option. No caller passed it, and the default was `false` both before and after.
- `lib/sqlite/driver.ts`: removed the unused `transaction` member from `SqliteConnection`. Nothing references it (tests included).
- `lib/http/openapi/consistency.ts`: removed the check "`BETTER_AUTH_KNOWN_PATHS` is missing a served path". Both sets are now built from the same `ENDPOINT_GROUPS`, so that check can no longer fail. The endpoint list itself is unchanged: same entries, same order, same gating.
- `lib/permissions/checker.ts`: removed an inner `if (!roleId)` check from `checkMultiplePermissions`. The same check still runs a few lines later, and `roleIsActive` catches a null role first.
- `lib/users/edit.ts`: deleting a custom role now goes through the shared `destroyCustomRole`, which omits `metadataFields`. That option only affects `UPDATE` audits, and this is a `DELETE`, so the audit row is identical.
- `lib/users/delete.ts`: `softDeleteUser` now also runs the system-role check through `assertTargetUserReachable`. It never fires, because the query already excludes system roles.
- `lib/http/response.ts`: `apiSuccess` defaults `data` with `?? null` instead of a parameter default, and its return type is now `T | null`. The runtime output is the same.
- `lib/users/contact-change.ts` (cosmetic): a doc comment ("Every refusal a contact change owes…") ended up between two functions, away from `authorizeContactChange`, the function it describes.

## 4. Left alone and why

- `apps/front-end/**`: that work runs in parallel. I did not read or stage anything there.
- `prompt.md`, `front-end-review.md` (repository root): notes files.
- No misplaced folders or config and tooling changes were among the unstaged changes.
