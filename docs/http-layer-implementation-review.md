## 1. [P2] Three OTP routes turn a legitimate 429 throttle into a 500 outside production

**Where**

- The contract entries:
  - `packages/shared/src/api/auth.ts:96-104`: `completePasswordReset`, declares `errors: { 400: {} }`.
  - `packages/shared/src/api/users.ts:164-172`: `changeEmail`, declares `{ 404, 409 }`.
  - `packages/shared/src/api/users.ts:195-203`: `changePhone`, declares `{ 404, 409 }`.
- The guard: `apps/back-end/lib/http/run.ts:33-34, 165-180`.

**What is wrong**

- These handlers reach `otp_proof_throttle` at 429:
  - `complete`: through `verifyRecoveryFactor` → `processOtpVerify` (`lib/otp/verify.ts:347-350`), on a blocked proof row or the daily cap.
  - `changeEmail` / `changePhone`: through `processOtpSend` (`lib/otp/send.ts:186-199`), on an exhausted send slot.
- None of the three entries declares the code. Outside production, `declared()` therefore replaces the answer with a logged `binding.code.undeclared` and a generic 500. The code, the block message and `Retry-After` are all lost.
- The sibling routes declare the code (`sendRecoverySecondFactorCode`, `verifyEmailChange`, `verifyPhoneChange`), so the gap is a sibling inconsistency.
- `completePasswordReset` also reaches 404 `codeNotSent` (no proof row yet). It does not declare 404, although the baseline document listed one.

**Baseline**: 429 with the code and `Retry-After` in every environment, through `withTimingFloor` → `handleApiError` and `withApiErrors`.

**Evidence**

- `probes-auth/complete.probe.test.ts`:

  | Request                                  | Answer                |
  | ---------------------------------------- | --------------------- |
  | `BLOCKED complete`                       | 500, no `retry-after` |
  | `CAP complete`                           | 500                   |
  | `NO-CODE complete`                       | 404                   |
  | `second-factor/send`, blocked (declared) | 429, code present     |

- `probes-users/codes.probe.test.ts` and `codes2.probe.test.ts` (send session seeded with `attemptNumber: 5`): `change-email` and `change-phone` both answer 500, each with a `binding.code.undeclared … status:429` log line.
- The other reviewer reproduced all three independently (`blocked-recovery-probe.ts` under `%TEMP%/http-layer-review-acd17d4/`).
- No existing test reaches any of these paths. `two-factor-management.test.ts` asserts only `.not.toBe(200)` for the no-code completion.

**Fix**

- Declare `429: { codes: [OTP_PROOF_THROTTLE_CODE] }` on all three entries, and `404: {}` on `completePasswordReset`.
- Add one integration case per route that asserts status, code and `Retry-After` together, plus the completion's missing-proof 404.

## 2. [P2] The declared-refusal guard checks the wrong thing and enforces in the wrong environment

`lib/http/run.ts:165-180` (`declared()`) is the only runtime check that a binding's answers match its contract entry. It has three defects that together let #1 ship and hide a whole class.

**Defect 1: it compares only `code`, never status.**

- A handler that throws a `CustomError` at a status `refusalsOf(binding)` does not list answers that status. Nothing logs it and nothing fails.
- Reachable, unpublished refusals found this way:

  | Route                              | Refusal           | Source                                                                         |
  | ---------------------------------- | ----------------- | ------------------------------------------------------------------------------ |
  | `POST /api/dash/users`             | 404               | `validateAssignableRole`, `lib/permissions/roles.ts:198`; pre-existing         |
  | `POST …/me/change-email/verify`    | 404 `codeNotSent` | pre-existing; its phone twin declares it                                       |
  | `POST`/`PUT /api/dash/permissions` | business 400      | `assertStandardRoleName`, `custom-` prefix                                     |
  | `changeEmail`, `changePhone`       | business 400      | wrong password, or the same contact                                            |
  | Both contact verifies              | business 400      | wrong or expired code                                                          |
  | `createUser`                       | business 400      | HIBP rejects the password                                                      |
  | `updateUser`                       | business 400      | password on an SSO account, `edit.ts:445`                                      |
  | 19 bodyless operations             | 413               | from the request hook's declared-length check (`app.ts:146-151`); pre-existing |

- For the business 400s:
  - The baseline document described every JSON route's 400 as "…or violates a handler-level business rule".
  - `lib/http/refusals.ts:96-100` now adds that clause only where `errors[400]` is declared, which only `changePassword` and `deleteUser` do.
  - So those routes now publish their 400 as malformed-body only.
- Evidence: `probes-media-perm/refusals.ts` and `perm.probe.test.ts`; `probes-openapi/runtime-vs-doc.ts`; `probes-users/cmp*.ts` against the generated documents.

**Defect 2: it enforces in development, the opposite of the response-contract check.**

- `checksCodes = NODE_ENV !== 'production'`. The development server therefore answers 500 where production answers the real refusal (`probes-core/p9-codes.ts`: development 500 with no `Retry-After`; production 429 with `Retry-After: 30`).
- `responseCheckMode()` (`lib/http/response-check.ts:42-52`) uses the opposite policy. It only logs in development, and enforces and records under the runner (`recordResponseMismatch`).

**Defect 3: under the runner it records nothing.**

- A wrong 500 fails a test only if that test happens to assert the status.

**Fix**

- Route `declared()` through `responseCheckMode()`:
  - in `log` mode, log and leave the answer unchanged;
  - in `enforce` mode, record a mismatch and answer 500.
- Extend it to statuses: a refusal status absent from `refusalsOf(binding)` is a mismatch.
- Declare the statuses above, including `400: {}` wherever a handler raises a business 400.
- Either publish 413 on every binding or skip the declared-length check on bodyless paths.

## 3. [P2] The published document makes 10 nullable enum fields reject `null`

**Where**: `apps/back-end/server/elysia/openapi.ts:32` calls `toOpenAPISchema`. The installed `@elysia/openapi@2.0.0-beta.4`, `dist/openapi.mjs:388-404` (`normalizeNullableSchemaForOAS31` → `rewriteNullUnion`), folds `anyOf: [{type:'string', enum}, {type:'null'}]` into `{type: ['string','null'], enum: [...]}` without adding `null` to `enum`. `enum` is checked independently, so a real `null` value fails the document. `lib/http/openapi/finalize.ts` does not correct this.

**Sites**

- `transition` (`packages/shared/src/responses/media.ts:28`), in:
  - `GET /api/dash/media`, three branches;
  - `POST /api/dash/media/files` 201;
  - `GET /api/dash/media/files/{id}`, `…/publish` and `…/unpublish`;
  - `POST /api/upload/file` 201.
- `options[].contactKind` and `options[].channel` on `POST /api/auth/forgot-password/reset` 200.

**Baseline**: the correct `anyOf` form, with 0 sites. The plan's A13 finding ("identical to today") holds only for schemas without `enum`/`const`.

**Evidence**

- `probes-openapi/ajv-null-enum.ts` reports `accepts null: false (keyword enum)`.
- Re-checked by walking `probes-openapi/out/new-full-development.json`: 10 hits, against 0 in `base-full-development.json`.
- The unit tier stays green because its validators check the document's own validity, not real responses against it.

**Fix**

- In the finalizer, wherever `type` includes `"null"`:
  - add `null` to `enum`;
  - rewrite `const: x` as `enum: [x, null]`.
- Add a document walk test that asserts no `type: [..,'null']` node has an `enum`/`const` lacking `null`.
- Report the bug upstream.

## 4. [P2] The test pinning re-authentication on six permission routes became circular

**Where**: `apps/back-end/tests/unit/route-auth-flags.test.ts:65-73`, `apps/back-end/lib/http/admit.ts:77-81`.

**What is wrong**

- The baseline held each route's `reauth` flag against an independent oracle: whether the handler's code reaches the window check.
- Now the test adds `'window'` to the reached gates whenever `gateAsksReauth(binding)` is true. It then asserts `policy.reauth === gates.has('window')`. `gateAsksReauth` itself requires `policy.reauth`, so for gate-asked bindings the assertion compares the flag with itself.
- The affected bindings:
  - `POST /api/dash/permissions`
  - `PUT`/`DELETE /api/dash/permissions/:id`
  - `POST /api/dash/users`
  - `DELETE /api/dash/users/:id`
  - `POST /api/dash/users/:id/two-factor/reset`
- Runtime cover:
  - Only `POST /api/dash/users` has a runtime 401 `REAUTH_REQUIRED` test (`user-admin-surface.test.ts:103`).
  - `binding-gate.test.ts` has no re-auth walk.
  - `openapi-contract.test.ts:2103` derives its wording from the same flag.
- Result: setting `reauth: false` in the shared policy of any of the other five silently removes the re-authentication requirement on a destructive admin route, and every test stays green.

**Fix**

- Freeze the set of `reauth: true` keys in `bindings.test.ts`, as `CREATED_ROUTES` freezes statuses.
- Add an integration walk over that set: a session without the window gets 401 `REAUTH_REQUIRED`, and the body is not read.

## 5. [P3] The duplicate-query-key refusal runs too early and too broadly

**Where**: `apps/back-end/lib/http/admit.ts:148-151` (inside the gate, before params validation and before the handler).

**`GET /api/health/storage`**

- The whole route requires `x-maintenance-token`, checked in the handler "before any answer".
- A repeated key now answers a 422 **envelope** before the token check. That includes keys the schema does not declare, which the plan keeps non-strict so that "an extra parameter on a probe URL cannot fail the deployment's health check".

| Request                    | Baseline | Now                                                                           |
| -------------------------- | -------- | ----------------------------------------------------------------------------- |
| no token, `?deep=1&deep=1` | raw 401  | 422 envelope                                                                  |
| valid token, `?a=1&a=2`    | 200      | 422 envelope, with no top-level `status` (the field the deployed probe reads) |

- Evidence: `probes-media-perm/perm.probe.test.ts`.

**`DELETE /api/dash/media/folders/:id`, and every binding with both params and a query**

- `…/folders/not-an-id?recursive=true&recursive=true` answers 422 `MSG_INVALID_INPUT` instead of the malformed-id 404 `FOLDER_NOT_FOUND`.
- A single unknown key still gets the 404, because params validate before the query.
- §12 of the plan does not list this order change.
- Evidence: `probes-media/order.test.ts`.

**Untested**: no test covers the health row of the "deliberate behaviour changes" table (see #14).

**Fix**

- Refuse duplicates only for keys the query schema declares.
- Run the refusal at the query-validation stage, after params, so a route's own earlier answers (the health token, the malformed-id 404) keep their precedence.
- Add a health case and a params-plus-duplicate case.

## 6. [P3] Every refusal of every route now publishes and accepts media ids in `data`

**Where**

- `packages/shared/src/response-contract.ts:171-176`: `errorEnvelopeSchema.data` is `mediaRefusalDataSchema.nullable()`.
- `apps/back-end/server/elysia/register.ts:23,32-34`: one compiled envelope for every refusal status.
- `apps/back-end/lib/http/openapi/merge-better-auth.ts:61,537`.

**What is wrong**

- The baseline published `data: null` (`ErrorEnvelope`). It used `MediaRefusalEnvelope` only at media statuses whose codes carry ids.
- Now 390 refusal responses on 50 operations publish `{ fileIds?, folderIds? } | null`, including 401/403/429/503 on users and auth routes.
- The 390 inline copies are 61% of the document's compact bytes, where the baseline used one `$ref`.
- The baseline test "every media refusal status … under the envelope its codes need" (HEAD `openapi-contract.test.ts:1074-1102`) was rewritten into a loose shape assertion (`:836-846`).
- The plan's deliberate-changes table lists only the Better Auth widening.

**Fix**

- Register `data: null` unless the entry declares an id-bearing code at that status.
- Publish both envelopes as components referenced by `$ref`.
- Restore the per-status assertion.

## 7. [P3] HEAD validates its answer with a second implementation that already disagrees with GET

**Where**: `apps/back-end/server/elysia/register.ts:94-109`, against `register.ts:84-90` → `server/elysia/respond.ts:111-125` → Elysia's response validation → `server/elysia/errors.ts:43-49`.

**What is wrong**

- GET values are validated by Elysia against the whole per-status `response` map. HEAD returns a native `Response`, so `register.ts` re-validates with `success.safeParse`, and only at the success status. The two methods differ in three ways:
  - A raw refusal body is stripped on GET but sent unstripped on HEAD, so `Content-Length` differs. That breaks the RFC 9110 rule `head-method.test.ts` exists for.
  - A refusal body failing its schema is a 500 on GET but passes through on HEAD.
  - On GET, the response-validation 500 carries the handler's `set.headers`. On HEAD it does not.
- Carrying a success's headers onto a 500 is itself a hazard: a future `Cache-Control: public` would be cached on the error.
- Evidence: `probes-core/p8-head-raw.ts`:
  - `GET /probe/raw-refusal` → 401, `len=25`; `HEAD` → 401, `len=52`.
  - `GET /probe/bad-success` → 500 with `x-handler=set`; `HEAD` → 500 with `x-handler=null`.
- The other reviewer reproduced it independently, through `app.handle` and a live Bun listener (`head-refusal-probe.ts`):
  - an extra field on a raw 401 gives GET 25 bytes and HEAD `Content-Length: 51`;
  - an invalid refusal body gives GET 500 and HEAD 401.
- Latent today: the only raw refusals are `GET /api/health/storage`'s, and they match the schema exactly. No handler returns headers yet.
- This is two implementations of one concern (CLAUDE.md "One implementation per concern").

**Fix**

- Validate the success in core, inside `runBinding`, with the same compiled schema already built in `routeOptions`, for every status answered as a value.
- Return a native `Response` for every answer, and drop the handler's headers on a validation 500.
- This removes `answerValue`, the `valued` set, `applyResponsePolicyToBag` (a second writer of the response policy) and the dependence on Elysia carrying `set.headers` onto its 500.
- This revises plan §1.2 item 3 / D8 ("native validation"). Elysia's validator does nothing here that the compiled schema in core cannot do.

## 8. [P3] The development `/openapi` page is registered by hand, outside `bind()` and routing

**Where**: `apps/back-end/server/elysia/openapi.ts:63-84` uses `app.get`. `apps/back-end/app.ts:210-213` builds `createRouting` from bindings and prefixes only.

**What is wrong**

- `apps/back-end/CLAUDE.md` says "Nothing registers a route by hand". The page also breaks D14 (a HEAD route per GET), the 405/308 behaviour, and the per-IP pre-auth limit every binding runs.
- `probes-core/p7-refpage.test.ts`:

  | Request            | Answer          |
  | ------------------ | --------------- |
  | `GET /openapi`     | 200             |
  | `HEAD /openapi`    | 404             |
  | `OPTIONS /openapi` | 404             |
  | `GET /openapi/`    | 404, no 308     |
  | `POST /openapi`    | 404, no `Allow` |

- The CDN script it loads has no `integrity` attribute. The CSP pins the path, but a substituted file would run on the API origin with the developer's session.
- Development only, so the impact is low.

**Fix**

- Add the page's route shape to `createRouting` and give it a HEAD twin through the helper bindings use. Alternatively, record it in `apps/back-end/CLAUDE.md` as the one sanctioned exception, with the reason (an HTML page cannot be a contract entry).
- Add SRI to the Scalar script.

## 9. [P3] English OpenAPI prose ships in browser-bundled shared files, and the rewrite added one sentence

**Where**

- Added: `packages/shared/src/validation/auth.ts:176-177` (`userPayloadRules()`, in `.meta({ allOf })` on `createUserSchema` and `adminUpdateUserBodySchema`, both imported by the front end): "Phone input is disabled; omit this field or clear it."
- Left in files the change touched:
  - `validation/rules.ts`: 81, 85, 177/191, 298, 323/408, 416, 453, 472, 538
  - `validation/media.ts`: 86/104, 122, 182/208, 229
  - `validation/permissions.ts`: 196, 207
  - `validation/auth.ts`: 66
  - `validation/two-factor.ts`: 194

**What is wrong**

- Root `CLAUDE.md`: field prose belongs in `*.docs.ts`, imported only by the back end's loader, "so none reaches the browser". The refine-area rule makes touched files fully compliant.
- The lint rule against importing `*.docs` works, but nothing guards inline `.meta({ description })` or `.describe()`.
- Evidence: a minified `Bun.build` of `validation/auth.ts` for the browser contains the sentence.

**Fix**

- Move the sentences into the `*.docs.ts` files. Let a docs entry target a bare reused instance such as `idSchema`.
- Add a `no-restricted-syntax` rule for `description` in `.meta()` and for `.describe()` outside `*.docs.ts`.

## 10. [P3] The document now gives wrong or missing text

**Wrong 403 reason**

- `lib/http/refusals.ts:124-128` words any declared 403 on a non-permission route as "The caller lacks the grant this request needs."
- On `POST /api/auth/forgot-password/reset` (anonymous), the declared 403 is `recoveryBlockedByTwoFactor` (`modules/auth/recovery.ts:194-198`). "Grant" collides with the recovery grant this same response issues.

**Dropped without being listed in §12**

- The description of the `POST /api/dash/users` body field `permissions`. `userRoleSchema` uses `permissionsArraySchema.optional()`, an instance the docs file does not reach.
- The description of `POST /api/upload/file` 201 `data[].url`. `responses/media.ts:54-56` creates an instance no docs entry can reach.
- The `sort` example on the three data-table lists, and the `deep` example on the health probe.
- `dependentRequired` on `GET /api/dash/users/{id}`. The plan calls it "not representable", which is wrong: `.meta()` cannot carry it, but the finalizer already post-processes operations and could add it.

**Wrong prose**

- `packages/shared/src/responses/permissions.docs.ts:13-16` says an action the page does not offer is "always false". The key is actually absent (probe `probes-media-perm/detail.probe.test.ts`: `{"view":true}`).
- `packages/shared/src/validation/otp.docs.ts:10` hard-codes "six digits" beside `OTP_CODE_LENGTH`, which `otp.ts:107` already interpolates.

**A query form the server accepts is not published** (pre-existing)

- `GET /api/dash/media`: `mediaListQuerySchema` (`packages/shared/src/validation/media.ts:237-244`) accepts `folder=''` as the root, as its own comment states.
- The published `folder` parameter is only the UUID pattern (`^\s*<uuid>\s*$`), so a client validating against the document rejects a request the server serves (`?folder=` answers 200 in `media-bindings`). Checked in `probes-openapi/out/new-full-development.json`.
- The other reviewer's matching claim about the sessions `cursor` is not a defect. The cursor is opaque and server-issued, and `validation/sessions.ts:58-61` deliberately publishes only its canonical form.

**Fix**

- Add `detail.responses[403]` on the reset binding, or a per-status description on `errors`.
- Publish `folder` as the UUID pattern or the empty string (`.meta({ anyOf })`), and add a document-versus-schema case for it.
- Restore the dropped text through docs entries, `.meta({ examples })` or `detail.parameters`.
- Correct the two sentences, interpolating `OTP_CODE_LENGTH`.

## 11. [P3] Request bodies are converted with `unrepresentable: 'any'`

**Where**: `apps/back-end/lib/http/openapi/finalize.ts:98-101`, and `merge-better-auth.ts:381` for Better Auth bodies.

**What is wrong**: a request field zod cannot represent would be published silently as `{}`. The response side uses `'throw'`.

**Evidence**: `probes-openapi/unrep.ts` converts every binding body, every `publishedBody` and every `BETTER_AUTH_BODIES` entry with `'throw'`, and none throws, so the switch costs nothing today.

**Fix**: use `'throw'`.

## 12. [P3] Guards that the rewrite's own safety relies on have bypasses

**Binding scanner**

- `scripts/find-unused-files.ts:171` (`EXPORTED_BINDING`) recognises only `export const X = bind(`. The baseline matched every declaration form.
- `probes-shared-tooling-tests-tooling/fu-tree/` shows four forms of an unlisted binding passing silently:
  - `export const X: T = bind(`
  - `const X = bind(…); export { X }`
  - `bind<T>(…)`
  - `(bind(…))`

**Lint rules**

- `no-restricted-imports` (`apps/back-end/eslint.config.mjs:158-201`, `packages/shared/eslint.config.mjs:33-42`) ignores dynamic imports, so `import('elysia')` and `import('…/users.docs')` lint clean.
- `docs/framework-migration.md` §1 states that ESLint refuses them.
- No lint-gate test asserts either rule.

**Refusal overrides**

- A `refusals.body` / `refusals.params` override on a binding without that part compiles and is silently inert (`lib/http/binding.ts:216`; `assertAgrees` at `:325-364` has no such rule).
- The baseline refused this (`openapi-contract.test.ts:316-334`). The plan's R7 claim "structural now" is not true.

**`mutating-route-authorization.test.ts:40`**

- It decides that a session route is permission-gated from `entry.errors?.[403]`, which is document metadata.
- A route that forgets to declare its 403 drops out of the 403 walk.

**Fix**

- Check registration at runtime: every exported `bind()` value under `modules/*/*.ts` must be in `BINDINGS`.
- Add `no-restricted-syntax` on `ImportExpression` for `elysia`, `@elysia/*` and `*.docs`, exempting `lib/http/openapi/docs.ts`, with lint-gate cases.
- Add the override rule to `assertAgrees`.
- Read the auth kind from the policy, not from `errors`.

## 14. [P3] Tests that prove less than they claim

**`tests/unit/zod-compile.test.ts:182-203`** (the compiled-versus-plain differential behind D10)

- 81 of its 207 schemas never receive an input the plain parse accepts. These include every request body and every `:id` params schema (`probes-shared-tooling-tests-unit/zc-probe.ts`). A compiled clone that mis-accepts or mis-transforms valid input is therefore undetectable.
- Its `inputs.length > 3` guard cannot fail.
- The compiled error envelope and the raw refusal schemas are not in the list.

**Deliberate changes with no test** (the plan requires one each)

- Health: a repeated key gives 422, and an unknown key is ignored.
- `POST /api/dash/media/files`: an unknown key, or a repeated `folder`, gives 422.
- `GET /api/dash/users/:id/sessions` on an unreachable target: 422 before the 404.
- `PUT /api/dash/media/folders/:id`: the body is checked before the malformed-id 404.
- `PUT /api/dash/users/me` with the re-authentication window closed. Every `/me` test signs in with it open.

**`tests/helpers/expect-body.ts:41-57`**

- `expectData` / `expectError` parse with non-strict objects and return the parsed output. No new test can see an extra or leaked body field.
- Several calls assert status only: `user-bindings:78,216`, `binding-gate:283`, `media-bindings:150,361`, `auth-bindings:351`.

**Vacuous walks in `tests/integration/binding-gate.test.ts:64,112,174`**

- The 401, security-header, 403 and captcha walks are `describe.each` over filtered lists with no length guard. An empty `describe.each` passes on Bun 1.4.2 (`probes-shared-tooling-tests-integ/empty/`).

**`tests/integration/head-method.test.ts:16`**

- It covers two paths. The socket half compares only `content-length`, and it never sends HEAD to a refusal.

**Assertions weakened against the baseline**

- `openapi-contract.test.ts:437`: `toEqual` became `toMatchObject`.
- The exact `SPENT_INPUT_REMEDIES` key list (HEAD `:749-753`) became per-route text checks.
- `response-check.test.ts:40-145` now asserts only that `checkSuccess` returns `false`. The step that turns it into a 500 (`run.ts:85-90`) has no direct test.
- The "generated once / failure cached" cases (HEAD `:412-449`) have no replacement for `lib/http/openapi/serve.ts`.
- `contract-types.test.ts` lost its real-entry cases (HEAD `response-contract.test.ts:229-358`) to synthetic schemas.
- `_route-feature-gates-child.ts:33-38` builds the expected answer itself, so the test can no longer detect drift.

**Captcha flag**

- It is no longer held against an independent oracle for the `/me` `SELF_SERVICE` routes. The flag, gate, document and walk all derive from `policy.captcha`, and `bindings.test.ts:157-170` is a substring search.

**Branch never exercised**

- `user-bindings.test.ts:126-139` returns early under the shipped `REQUIRE_ROLE_FOR_LOGIN=true`.

**Document coverage**

- The document is never generated under the matrix tier's six two-factor configurations, though the Better Auth half depends on them. The boot-time generation that used to catch this is gone.

**Fix**

- Give every compiled schema at least one hand-written valid fixture.
- Add the missing deliberate-change cases.
- In `expectData`, compare the wire body with `toEqual(parsed.data)`; in `expectError`, parse with a `.strict()` copy.
- Add a length assertion to each walk.
- Widen `head-method` to refusals and to `/openapi.json`.
- Restore the exact assertions.
- Generate and validate the document in `tests/matrix/two-factor-configuration.test.ts`.

## 15. [P3] Code that misleads the next reader

**Gate `derive`**

- `server/elysia/gate.ts:50-52` produces an `actor` that nothing reads. The handler's actor comes from `actorOf(request)` in `lib/http/run.ts:42`.
- The header comment (`gate.ts:6-7`) calls `derive` the hand-off.
- Fix: drop the `derive`, or pass `context.actor` into `runBinding` and remove the second `actorOf`.

**Dead role checks**

- In new files:
  - `modules/users/self.ts:19-21`
  - `modules/users/item.ts:53-56`
  - `modules/users/sessions.ts:49-54`
- `Grants.roleId` is always set, because both grant producers throw 403 first (`lib/permissions/checker.ts:183-184, 267-268`). Yet the comments present these checks as the guard.
- `self.ts` now has a single caller (`me.ts:54`).
- Fix: delete the checks and fold `self.ts` into `me.ts`.

**Inaccurate or forbidden comments**

- `packages/shared/src/error-codes.ts:23-27` and `response-contract.docs.ts:11` say `otp_proof_throttle` never reaches an anonymous route. `second-factor/send` and `complete` are public and answer it.
- `packages/shared/src/validation/two-factor.ts:134-155`: `OTP_NEEDS_CONTACT_KIND` was inserted between `twoFactorMethodOptionSchema`'s JSDoc and the schema, orphaning the doc.
- Change history and plan ids the reader cannot resolve: `modules/media/upload.ts:24,30` ("as the legacy parser answered", "(D22)") and `packages/shared/src/api/media.ts:305`.
- `tests/unit/lint-security-gate.test.ts:54-57`: the comment misdescribes what runs and quotes a measured value.
- `tests/unit/openapi-document.test.ts:1-4`: the header says "Not served yet". `:443-451` skips a missing path with no guard.
- `tests/helpers/session.ts:~326`: says the dev route answers 403 under `NODE_ENV=test`; it answers 404 (unregistered).

**Stale reference docs**

- `apps/back-end/reports/test-strategy.md` still describes `routes.ts`, `route-manifest.ts`, `assertHandlersRegistered` and `app/api/**/handler.ts` (lines 211, 228, 261-265, 297, 389, 651, 1018, 1116, 1124-1127, 1192, 1202, 1356).
- The lefthook job is still named `routes` (`lefthook.yml:139`).

## 16. [P3] Duplication the rewrite introduced

**Data-table query keys**

- They are spelled three times:
  - `packages/shared/src/data-table/query.ts:16-24`, literal keys;
  - `parsers.ts:404-426`, `DATA_TABLE_PARAMS` / `DATA_TABLE_PARAM_KEYS`;
  - `filter-rules.ts:23-26`.
- Only `bindings.test.ts:268-270` holds them together.
- Fix: key the schema's shape from `DATA_TABLE_PARAMS`, typed so a missing key fails to compile.

**Contract literals**

- The permission policy object and `z.object({ id: idSchema })` are each declared three times:
  - `api/media.ts:59-67`
  - `api/permissions.ts:21-28`
  - `api/users.ts:39-57`
- None of these carries field docs, so the one-description-per-instance rule does not force separate copies.
- Fix: export one policy and one id-params schema from `api/endpoint.ts` or a sibling file, and set `reauth` per entry.

**Server-only tunables moved into shared**

- `packages/shared/src/validation/constants.ts:35-42` now holds `SIGNING_WINDOW_S`, `SIGNED_LINK_MIN_LIFETIME_S`, `ABANDONED_UPLOAD_MINUTES` and `FOLDER_SEARCH_LIMIT`.
- They moved into a browser-shipped module only so that `*.docs.ts` files can interpolate them. Plan §6.3 keeps server-only values server-side.
- Owner decision: accept, or let the back-end docs loader interpolate them.

## 17. [P3] Defects the rewrite carried into its new files (pre-existing)

**`POST /api/dev/sign-up`, a repeated email**

- `modules/dev/sign-up.ts:36-44` inserts the `system-${email}` role before the user. A second sign-up with the same email therefore hits `ux_roles_role_name`, which `handleUserUniqueViolation` does not map, and answers a logged 500.
- The entry (`packages/shared/src/api/dev.ts:12`) promises 409.
- Evidence: `probes-media-perm/perm.probe.test.ts`, `dev-dup`.
- Fix: map that constraint in the binding's `mapError`, or name the role by user id. Add a twice-registered test.

**Early answers from the `request` hook carry no CORS headers**

- The declared-length 413 (`app.ts:146-151`) and the unroutable-host 404 (`app.ts:135-136`) return before the CORS plugin runs. A cross-origin dashboard therefore sees a network error instead of `MSG_BODY_TOO_LARGE`.
- Evidence: `probes-core/p5-cors.test.ts`. Every other answer carries `Access-Control-Allow-Origin` and `Vary: Origin`; the early 413 has neither.
- Matters only if the API and the dashboard are served from different origins (not verified for the Coolify deployment).
- Fix: add the CORS headers for an allowed origin in `answerEarly`, and add a case to `request-body-ceiling.test.ts`.
