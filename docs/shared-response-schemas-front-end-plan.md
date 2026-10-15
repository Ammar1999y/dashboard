# Front-end plan: switch to the shared response schemas

For the agent working in `apps/front-end`. This is Phase 2 plus Phase 3 step 4 of `docs/shared-response-schemas-plan.md`. Read that plan's "Schema rules" section first.

## Where things stand

The back-end and `packages/shared` are done:

- Every server success response now has one zod schema in `packages/shared/src/responses/*.ts`.
- The back-end is type-checked against those schemas, and validated against them at runtime under its test runner.
- The OpenAPI document is generated from them.

The front-end still parses with its own hand-written copies. Your job is to replace those copies with the shared schemas, without making the client stricter than it is today, except where noted below.

## Rules

- **Edit only `apps/front-end`.** If a shared schema looks wrong, report it instead of editing `packages/shared` or the back-end. The server's checks and the document depend on those schemas.
- **Before you start,** commit or finish your own in-flight front-end work, so this swap is a separate, reviewable change. Don't stage partially: a lefthook bug in this repo resets partially staged files.
- **Shared schemas are wire types:**
  - Dates, ids and URLs are strings. Their `format`/`pattern` is metadata, not enforced on parse.
  - Objects strip unknown keys.
  - There are no transforms in shared.
- **Keep client-only behaviour local:**
  - A `.transform()`, for example unwrapping `{ methods }` to an array, or tagging a media listing with `scope`, goes on top of the shared schema at the call site or in your schema module.
  - A stricter local rule is added with `.extend()`.
  - A call that reads only some fields narrows with `.pick()`, keeping today's tolerance for the rest.
- **Trap:** `userDetailSchema` is refined, and zod throws at load on `.pick()`, `.omit()` or `.partial()` of a refined object. Use `userDetailBaseSchema` for those; `.extend()` is fine on both.
- **`@app/shared/response-contract` is type-only in app code.** Its registries pull in every schema. Import schemas from `@app/shared/responses/<domain>`. `mocks/**` and `tests/**` may import it at runtime.
- **Follow `apps/front-end/CLAUDE.md` and the `frontend` skill.** Never drive a browser to verify; use lint and the test suites only.

## 1. Replace the copies

### Table routes (`@app/shared/responses/*`)

| Front-end today                                                                                                                               | Shared replacement                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `types/api.ts`: `createdResponseSchema`, `updatedResponseSchema`, `noDataResponseSchema` / `deletedResponseSchema`                            | `common`: `createdIdSchema`, `updatedAtSchema`, `noDataSchema`. These also serve the pending entities through `use-entity-mutations.ts`. `storedRowSchema` stays front-end, because it is pending-only                                     |
| `types/user.ts`: `userRowsSchema`, `userDetailSchema`, `sessionsPageSchema`, `revokedSessionsSchema`                                          | `users`: same names, plus `userDetailBaseSchema`                                                                                                                                                                                           |
| `types/permission.ts`: `roleSummarySchema`, `roleSummariesSchema`, `permissionRowsSchema`, `permissionDetailSchema`, `permissionMatrixSchema` | `permissions`: same names                                                                                                                                                                                                                  |
| `lib/account/schemas.ts`: `contactChangeStartedSchema`                                                                                        | `users`: `contactChangeStartedSchema` (now `z.xor`; `'otpSent' in data` still narrows)                                                                                                                                                     |
| `lib/account/schemas.ts`: `contactChangeCommittedSchema`                                                                                      | `auth`: `verifiedSchema`                                                                                                                                                                                                                   |
| `theme-customizer/preferences.ts`: `storedPreferencesSchema`, `savedPreferencesSchema`                                                        | `users`: `storedPreferencesSchema`; `common`: `updatedAtSchema`                                                                                                                                                                            |
| `lib/media/schemas.ts`: `libraryFileSchema`, `fileDetailSchema`, the breadcrumb/folder/hit/usage schemas                                      | `media`: `mediaFileSchema` (its `url` is already lenient), `mediaFileDetailsSchema`, `mediaFolderSchema`, `mediaFolderHitSchema`, `mediaUsageSchema`                                                                                       |
| `lib/media/schemas.ts`: `listingSchemas.folder` / `.all` / `.unfiled`                                                                         | `media`: `folderListingSchema`, `searchListingSchema`, `unfiledListingSchema`, each with your local `scope` transform                                                                                                                      |
| `lib/media/schemas.ts`: the updated/moved/deleted file and created/updated/deleted folder schemas                                             | `media`: `updatedFileSchema`, `movedFilesSchema`, `deletedFilesSchema`, `createdFolderSchema`, `updatedFolderSchema`, `deletedFolderSchema`                                                                                                |
| `lib/files/upload.ts`: `mediaFileSchema` (6 fields) and the upload tuple                                                                      | `media`: `mediaFileSchema.pick({ id, kind, displayName, mimeType, sizeBytes, url }).extend({ url: z.string().min(1) })` inside a one-element array. This keeps today's 6-field tolerance and the non-empty url                             |
| `hooks/use-resend-cooldown.ts`: `otpSentSchema`                                                                                               | `auth`: `anonymousOtpSentSchema` for `/api/auth/{otp,passwordless,forgot-password}/send`; `ladderOtpSentSchema` for `/api/auth/forgot-password/second-factor/send` and the plugin's `/two-factor/otp/send`. Both have the same client rule |
| `components/dash/auth/schemas.ts`: `verifiedSchema`, `recoveryResultSchema`, `resetDoneSchema`                                                | `auth`: same names                                                                                                                                                                                                                         |
| `lib/auth/reauth-proof.ts`: `grantSchema`                                                                                                     | `auth`: `reauthGrantSchema`, for both `/api/dash/auth/reauth` and the plugin's `/reauth/passkey/verify`                                                                                                                                    |
| `components/dash/auth/sign-up.tsx`: no schema today                                                                                           | `common`: `createdIdSchema`                                                                                                                                                                                                                |

### Our Better Auth plugin endpoints (`@app/shared/responses/better-auth`)

The registry entries are whole bodies. For a call through `authRequest`/`authFetch` **without** `plain`, the transport already checks the envelope, so pass the **data** schema below. With `plain`, pass the whole-body schema.

| Front-end today                                                                                                                                                                                                                                          | Shared replacement                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/dash/auth/schemas.ts`: `twoFactorChallengeSchema`, and the option schemas                                                                                                                                                                    | `twoFactorChallengeSchema`. It now **requires `twoFactorMethods`**, which the server always sends. Derive the option type as `z.output<typeof twoFactorChallengeSchema>['twoFactorOptions'][number]` |
| `components/dash/auth/schemas.ts`: `loggedInSchema`                                                                                                                                                                                                      | `loggedInSchema`                                                                                                                                                                                     |
| `components/dash/auth/schemas.ts`: `signInResultSchema` (plain, one schema for two routes)                                                                                                                                                               | `passwordlessResultSchema` for `/passwordless/verify`, where the session body carries `message`; `oauthOutcomeSchema` for `/oauth/result`, where it does not                                         |
| `components/dash/auth/schemas.ts`: `trustedSchema`, `capabilitiesSchema`, `oauthStartSchema`                                                                                                                                                             | `deviceTrustedSchema`, `capabilitiesSchema` (keep your transform), `oauthStartedSchema` (http(s)-only, as today)                                                                                     |
| `lib/auth/reauth-proof.ts`: `methodsSchema`                                                                                                                                                                                                              | `reauthMethodsSchema`                                                                                                                                                                                |
| `lib/account/schemas.ts`: `methodsSchema` / `enrolledMethodSchema`                                                                                                                                                                                       | `enrolledMethodsSchema` / `enrolledMethodSchema` (keep your array transform)                                                                                                                         |
| `lib/account/schemas.ts`: `totpStartedSchema`, `totpEnabledSchema`, `otpEnabledSchema`, `backupCodesSchema`, `removedMethodSchema`, `defaultMethodSchema`, `passkeyDeletedSchema`, `trustedDevicesSchema` / `trustedDeviceSchema`, `deviceRevokedSchema` | same names (keep the `devices` transform)                                                                                                                                                            |
| `lib/auth/passkey.ts`: `passkeyGrantResponseSchema`                                                                                                                                                                                                      | `passkeyGrantedSchema`                                                                                                                                                                               |
| `lib/auth/passkey.ts`: `requestOptionsSchema` (`z.looseObject({ challenge })`), and the two options calls that pass no schema (`reauth-proof.ts:44`, `challenge.tsx:77`)                                                                                 | `passkeyRequestOptionsSchema`, passed at both calls and used in `authenticateWithPasskey`. It mirrors the library's full options type, so nothing the browser needs is stripped                      |
| `lib/account/two-factor.ts:236` (`/two-factor/backup-codes/acknowledge`) and `:281` (`/two-factor/disable`): no schema today                                                                                                                             | `pluginMessage()` with `plain: true`. These bodies have no `data` key                                                                                                                                |

**Out of scope:** the Better Auth library's own shapes keep their front-end schemas. That covers `signedInSchema`, `creationOptionsSchema`, `storedPasskeySchema`, `passkeysSchema` and `grantsSchema`.

Then delete the replaced copies. Keep the exported **type names** in `types/*.ts` and the schema modules, as aliases derived from the shared schemas, so their importers don't move.

## 2. Transport

- **Pagination meta:** in `lib/api/fetch.ts`, `envelopeSchema`'s `meta` becomes `paginationMetaSchema` from `@app/shared/responses/common`.
- **Skew diagnostics:** when a 2xx body fails its schema, log the href plus each issue's path and code, never values. The sites are `lib/api/mutation.ts:142`, which today logs a fixed line, `lib/api/fetch.ts:180`, which logs nothing, and the matching branch in `lib/auth/request.ts`.
- **Anything else in `lib/api/*` and `lib/auth/request.ts`** stays unchanged.
- **Stale comment:** the comment above `envelopeSchema` (`lib/api/fetch.ts:48`) names `ApiEnvelope`. Update it; the type will be deleted from shared after this pass.

## 3. Mocks: hold every answer to the server's contract

- **In `withApiErrors` (`mocks/lib/http.ts:135`),** which wraps every mock handler, check each 2xx JSON answer. `handler.info` gives the method and path pattern; strip the API origin from the path. Then:
  - a table route (`isResponseRoute(`${method} ${path}`)`): `responseIssues(key, body)`;
  - a plugin route (`/api/auth` + a `BETTER_AUTH_RESPONSES` key): `betterAuthResponseIssues(subPath, body)`;
  - any other 2xx carrying `twoFactorRedirect`, such as `/sign-in/email`: `twoFactorChallengeIssues(body)`;
  - anything else (pending entities, library routes): skip.
- **On issues:** under `bun test`, throw. In browser mock mode, `console.error` the key and each issue's path and code.
- **Fix the drift this exposes.** Every answer must match the full published shape. In particular, the upload mocks must answer complete `MediaFile` rows, and the challenge mocks must send `twoFactorMethods`.
- **Resend delay:** replace the literal `30`s in `mocks/lib/otp.ts:44` and `mocks/handlers/otp-flows.ts:81` with `OTP_BASE_RESEND_DELAY_S` from `@app/shared/validation/constants`.

## 4. Lint rule

Add `@typescript-eslint/no-restricted-imports` with `allowTypeImports` for `@app/shared/response-contract` (installed 8.70.0). Give it its own rule name, so it doesn't override the existing per-folder `no-restricted-imports` blocks. Exempt `mocks/**` and `tests/**`.

## Intended client changes

These are the only ways the client may become stricter:

- the two-factor challenge requires `twoFactorMethods`;
- the `/passwordless/verify` session body requires `message`;
- `z.xor` unions refuse a body matching two branches (contact change, the `/two-factor/otp/verify` data);
- the WebAuthn options are parsed in full instead of as `{ challenge }` plus pass-through.

Anything else that parses differently from today is a regression. Report it.

## Verification

1. `bun run lint` in `apps/front-end` (`bun check`, ESLint, `audit:css`).
2. `bun test tests`, the local, git-ignored suite. Update tests that imported the removed schemas. Every 2xx mock answer now goes through the wrapper check.
3. **Deliberate break:** change one mock answer's field type and confirm a test fails with the route key and the issue path; then revert it.
4. `bun run build` once at the end. `prebuild` regenerates committed assets, so report any resulting diff in them.
5. Read-only: `cd apps/back-end && bun run typecheck` stays clean. You changed nothing there; this confirms it.

## Report back

1. Each section above: done or not, with the files changed.
2. Every place a parse became stricter or looser than today, and why.
3. Mock drift found and fixed.
4. Anything in `packages/shared` that looks wrong (don't edit it), and any problem or idea for the coordinator.
5. Checks run, with results, and checks not run.
