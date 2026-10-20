# Plan: Phase 4 — the wire-format switch and the front-end migration

Status: **done, 2026-10-16** (§14 records what was built and where it departs from this spec). Written for an implementing agent that has the repository but none of the conversations behind it. Phase 4 of `docs/http-layer-plan.md` (called "the main plan" below; its IDs `Dn`, `Fn`, `Rn`, `Qn`, `Pn` keep their meaning). This plan's own IDs carry a `P4-` prefix. §3 describes the state before the phase.

**Nothing here is absolute.** Each decision states its reason. Rows marked **author decision** fill a gap the main plan left; a reviewer or the owner may overturn them. Before you dispute a fact, re-run the check that produced it.

---

## 0. Rules for the implementer

Read these first. They override habit.

1. **Read the standards.** Root `CLAUDE.md`, `apps/back-end/CLAUDE.md`, `apps/front-end/CLAUDE.md` (and `apps/front-end/.claude/skills/frontend/SKILL.md` for React work). They apply unchanged.
2. **The front end is worked on in parallel by others.** Touch only the files a step needs. Run `git status` before you start and before every step. Any diff you did not make is someone else's: never revert, reformat or "fix" it. If a file you must change already has someone else's edits, change only your lines.
3. **Do not commit** unless the owner asks. When asked, commit only your own hunks (the repository has a recipe for this: a temporary `GIT_INDEX_FILE` with content-matched hunks, then patch the real index).
4. **No browser.** Never launch the app or drive the UI to verify. Proof is lint, type checks and the test suites.
5. **Run test tiers one at a time.** Concurrent runs flake. Long tiers (integration, matrix, process) run in the background. Other sessions' probe files can break lint or a test with `ENOENT`: rerun alone, never delete their files. The back-end runner takes flags only as `--flag=value`.
6. **Each step leaves the app working.** Every step ends with its acceptance checks green. Do not start the next step on a red tier.
7. **Report** after each step: what changed, commands run with results, what you could not run, any temporary test code left.

## 1. Purpose

Phase 4 does two things the main plan deferred (D18):

1. **Switch the wire format.** Errors become RFC 9457 problem details (`application/problem+json`). Successes lose the `success` flag.
2. **Move the front end onto the shared endpoint contract.** One typed client, `api(entry, input, options)`, typed and parsed from `packages/shared/src/api/*`. Typed mocks. Then retire what only existed for the old way: the old registries `REQUEST_BODIES` and `RESPONSE_DATA`. (The self-rename branch of `PUT /api/dash/users/:id` and its handler-side body validation are already gone from the back end; the front end catches up in S1.)

## 2. Owner priorities that shape this phase

From the main plan §1.1, applied here:

- **P1.** Framework-independent code only with a valid reason (performance, security, control). Zod was chosen so that the back end and the front end share schemas and validation. Phase 4 is where that pays: the front end parses with the same schema objects the server validates with.
- **P2.** Use Elysia features that help, even if a later move to Hono gets harder.
- **P3.** Keep Elysia-specific code in `apps/back-end/server/elysia/*`. Nothing in this phase adds Elysia code outside it. The new body builders are core (framework-free).
- **P4.** Never restrict the design for Hono's sake.

## 3. Current state (verified 2026-10-10)

### 3.1 Back end, as built (uncommitted on branch `http-layer`)

- **Contract entries:** 50 `endpoint()` entries in `packages/shared/src/api/`: `permissions.ts` 5, `users.ts` 17, `media.ts` 17, `auth.ts` 8, `dev.ts` 1, `health.ts` 1, `openapi.ts` 1. Each carries method, path, params, query, body and body kind, success status, response (`schema`, `{ data, meta }` for a list, or `{ raw }`), `errors` (statuses and codes), and `policy` (`auth`, `captcha`, `reauth`, `rateLimited`, `checksPassword`). See `api/endpoint.ts` (`endpoint()`, `declaredCodes()`, `PathParams`).
- **Bindings:** `apps/back-end/modules/<domain>/*.ts`, one `bind(entry, options)` per entry. Core in `apps/back-end/lib/http/` (`admit.ts`, `binding.ts`, `run.ts`, `refusals.ts`, `request.ts`, `response.ts`). Elysia wiring in `apps/back-end/server/elysia/` (`register.ts`, `gate.ts`, `errors.ts`, `respond.ts`, `auth-mount.ts`, `openapi.ts`).
- **The wire format is built in one place.** `lib/http/response.ts`:
  - `successBody(message, data, meta?)` → `{ success: true, message, data, meta? }`.
  - `errorBody(message, code?, data?)` (module-private) → `{ success: false, message, data: data ?? null, code? }`. Note: it takes **no status**; `apiError({ message, code, data, status, headers })` adds the status around it.
  - Every error answer goes `apiError` / `handleApiError` → `toWebResponse` (which uses `Response.json`, so `application/json;charset=utf-8`). Verified call sites: `app.ts` (request-hook 413), `server/elysia/{errors,register,auth-mount}.ts`, `lib/http/{run,routing,response-check,constraint-errors}.ts`, `modules/auth/{anonymous,recovery}.ts`.
- **Better Auth** (`/api/auth/*` prefix route, `server/elysia/auth-mount.ts`): `localiseAuthError` (`lib/auth/errors.ts`) rewrites only error bodies whose `code` it localises, to `{ message, code }` as `application/json`. Unmapped codes pass through untouched. The prefix route's own refusals (pre-auth limit, 413, route miss) use `toWebResponse(handleApiError(…))`, the envelope.
- **Better Auth plugin successes** (our own plugin endpoints) answer `{ data }`, `{ message, data }` or `{ message }`, **without `success`** since 2026-10-10 (owner decision, P4-D6), built in 25 places under `lib/auth/**`, typed by `BETTER_AUTH_RESPONSES` and `pluginBody()` / `pluginBodyWithMessage()` / `pluginMessage()` in `packages/shared/src/responses/better-auth.ts`. The runtime check (`checkBetterAuthResponse`) refuses a stray `success` as an unknown key, and the document publishes the new shapes. Better Auth's **library** endpoints are unchanged (`POST /api/auth/sign-out` still answers its own `{ success: true }`).
- **Response validation (D8):** a success failing its schema becomes a logged 500 with no `code` (`responseFailure` and the `checkSuccess` branch in `lib/http/run.ts`; `checkBetterAuthResponse` in `lib/http/response-check.ts`).
- **The document:** `lib/http/openapi/finalize.ts` + `merge-better-auth.ts`; errors are still published as `application/json` (F26, finalizer step 5 deferred). The error schema is `errorEnvelopeSchema`, described by `packages/shared/src/response-contract.docs.ts`.
- **Self-rename (D22), done in the back end 2026-10-10 (owner decision):** `PUT /api/dash/users/me` (`updateSelf`, `modules/users/me.ts`, `renameCaller` in `modules/users/self.ts`) is the only self-rename. `PUT /api/dash/users/:id` (`updateUserBinding`, `modules/users/item.ts`) takes `adminUpdateUserBodySchema` alone, validated natively (compiled) like every other binding, and declares `permission: { users, edit, notSelf: 'id', handlerAsksReauth: true }`. The gate answers a well-formed id equal to the caller's **403 `MSG_INSUFFICIENT_PERMISSIONS`** (the existing message; no new copy), right after the grant check, so before the limiter and before the body is read: order 401 → 403 (no grant, or own id) → 429 → 400/413/422 → handler. `handlerAsksReauth` keeps the re-authentication window the handler's, asked only for a sensitive change (`editUserAsAdmin`). `handlerValidatesBody`, `parseOrThrow` and the registry's multi-shape support are deleted. `GET /api/dash/users/:id` and `GET`/`DELETE …/:id/sessions` keep their self access (`orSelf: 'id'`).
- **Tests:** unit 58 files, integration 74, process 11, matrix 1. New tests read bodies through `tests/helpers/expect-body.ts` (`expectData(response, entry)`, `expectError(response, status, message?)`; 91 uses in 7 files). About **100 lines in about 40 test files** still name `success` on a body (Turnstile and egress fakes, Better Auth's library bodies such as `/sign-out`, and parse results excluded; plugin-body assertions already dropped `success`). More tests read a refusal's `message`. The main plan's "134 in 48 files" predates Phases 2–3.
- **Smoke:** `apps/back-end/scripts/smoke.ts` asserts "unknown route returns the API envelope" (`success: false`).

### 3.2 Front end, as is

Counts by `grep` over `apps/front-end/{components,lib,pages}` (definitions in `lib/api/*` excluded; `.next/` excluded).

**Request layer** (`lib/api/`):

- `fetch.ts`: `fetchOnline` (offline → `CustomError`), private `apiFetch` (base `API_URL`, `credentials: 'include'`), `apiRequest(path, { schema })` which parses the envelope (`success`, `message`, `code`, `data`, `meta`), `failure()` (status, code, media `data`, `Retry-After`), `INVALID_RESPONSE_CODE = 'invalid_response'`, `retryAfterMs`, `failureMessage`.
- `mutation.ts`: `mutate({ href, method, data, schema, headers, signal, onSuccess, onUnreadAnswer })`. Every write runs in `withReauth` (single-use when a captcha header is present), maps a client-side `invalid_response` to `committedError()` (`COMMITTED_CODE = 'committed'`), and runs `withBookkeeping`.
- `query.ts`: `useQueryData`, `queryDataQuery`, `useServerPage`, `serverPageQuery`, `useServerPages`, `serverPagesKey`, `useServerDataTable`.
- `reauth-retry.ts`: `retryAfterReauth` (only `401 REAUTH_REQUIRED` retried; single-use → `REAUTH_PROVEN_RESUBMIT`).
- `components/app/react-query-provider.tsx`: queries retry only 5xx, never `invalid_response`.

**Calls to our bindings: 44 call sites in 22 files.**

| Kind                                                                                             | Sites | Files                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mutate(`                                                                                        | 27    | email-change 2, phone-change 2, account/tabs/password 1, auth/contact-form 1, auth/forgot-password 3, auth/sign-up 1, auth/verify-contact 1, settings/index 1, shared/row-actions 1, shared/use-entity-mutations 2, theme-customizer/preferences-sync 1, lib/files/upload 1, lib/media/actions 6, lib/media/upload 1, lib/users/rename 1, lib/users/security 2 |
| `apiRequest(`                                                                                    | 4     | preferences-sync, lib/auth/reauth-proof, lib/media/queries, lib/users/security                                                                                                                                                                                                                                                                                 |
| `useQueryData(`                                                                                  | 8     | account/use-account, settings/index, shared/edit-record, form/form-combobox, ui/data-table/data-table, lib/media/queries 3                                                                                                                                                                                                                                     |
| `queryDataQuery` / `useServerPage` / `useServerPages` / `serverPageQuery` / `useServerDataTable` | 5     | lib/media/queries 4, ui/data-table/data-table 1                                                                                                                                                                                                                                                                                                                |

Notes:

- Generic CRUD components take an `href` from `defineEntity({ api })` (`components/dash/shared/entity.ts`; used by `permissions/entity.ts`, `users/entity.ts`): `data-table.tsx`, `edit-record.tsx`, `row-actions.tsx`, `use-entity-mutations.ts`, `form-combobox.tsx` (with `ROLE_OPTIONS_HREF`).
- Paths live in `lib/media/api.ts`, `lib/files/upload.ts` (`UPLOAD_PATH`), `theme-customizer/preferences.ts`, `lib/users/security.ts`, and literals in components.
- `/api/dash/settings` (2 calls in `components/dash/settings/index.tsx`) **exists only in the mocks** (`mocks/handlers/content.ts`). No back end serves it.
- Front-end-called entries: 45 of 50. Not called: the two raw entries (health, `/openapi.json`), `PUT /api/dash/users/me`, and the two deprecated `PUT`/`DELETE /api/dash/media/files`.
- Some callers pass a schema narrower than the contract: `lib/media/queries.ts` (`listingSchemas[scope]`), `lib/files/upload.ts` (a one-element tuple).

**Request-body types from the old registry:** `RequestBody<'…'>` or `REQUEST_BODIES[…]` in 14 files (account email/phone/password, auth contact-form, forgot-password, second-factor/options, verify-contact, permissions/edit, users/edit, lib/auth/reauth-proof, lib/media/actions, lib/media/queries, lib/users/rename, lib/users/security).

**Better Auth calls (stay on the Better Auth client; Phase 5, D16):** `authRequest(` 25 sites in 8 files, `authFetch(` 3 (lib/auth/reauth-proof), `authClient.` 7 sites in 5 files. `lib/auth/client.ts` `toAuthError` reads `status`, `message`, `code` from better-fetch's error object. `lib/auth/request.ts` reads plugin successes through `pluginEnvelope` (`success: z.literal(true)`), which refuses every plugin success the back end now sends (§3.4).

**Mocks (MSW 2.15.0):** 85 handlers in 14 files under `mocks/handlers/` (plus 2 in `mocks/controls.ts`):

| Kind               | Handlers | Files                                                                                                                                                               |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Our bindings       | 47       | account 5, auth 2 (`/api/dash/auth/reauth`, `/api/dev/sign-up`), media-library 16, media 1 (upload), otp-flows 7, permissions 6, preferences 2, sessions 3, users 5 |
| Better Auth        | 34       | auth 6, otp-flows 1 (`/passwordless/verify`), oauth 3, sign-in-challenge 6, two-factor 18                                                                           |
| Mock-only settings | 2        | content                                                                                                                                                             |
| Catch-alls         | 2        | index (latency, 401 on `/api/dash/*`)                                                                                                                               |

`mocks/lib/http.ts` builds bodies (`ok`, `okPage`, `fail`, `errorResponse`, `pluginOk`, `asPlugin`) and wraps every handler with `withApiErrors`, which checks each 2xx against `responseIssues` (keyed by `RESPONSE_DATA`) or the Better Auth tables, and throws under `bun test`. No mock exists for `PUT /api/dash/users/me`. Front-end tests: 43 `*.test.ts`; about 48 lines in 14 test files plus `mocks/lib/http.ts` name `success` on a body.

**Other:** `lib/zod-locale.ts` sets only `customError`; `pages/_app.tsx` imports it after the CSS imports. `next.config.js` sends no CSP (`const headers = true ? [] : …`). `eslint.config.mjs` has no `*.docs` rule; an all-files block (`ignores: ['mocks/**']`) forbids runtime imports of `@app/shared/response-contract`. Scripts: `bun run lint` (tsc, ESLint, `audit:css`), `bun run test` (`bun test tests`).

### 3.3 Who imports the old registries

| File                                                                                                                                                         | Importers outside `packages/shared`                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contract.ts` (`REQUEST_BODIES`, `RequestBody`, `BETTER_AUTH_BODIES`, `BetterAuthBody`, `Assert`, `UnknownFieldsOf`)                                         | front end: the 14 files above, `lib/auth/request.ts` (Better Auth types), 9 mock files; back end: `lib/auth/passkey-assertion.ts` (`Assert`), `lib/http/openapi/merge-better-auth.ts` (`BETTER_AUTH_BODIES`), tests `bindings`, `filter-and-input-edges`, `zod-compile`                                                                                      |
| `response-contract.ts` (`RESPONSE_DATA`, `responseIssues`, `isResponseRoute`, `successEnvelope`, `errorEnvelopeSchema`, `BETTER_AUTH_RESPONSES` and helpers) | front end: `mocks/lib/http.ts`; back end: `lib/http/{binding,run,response-check,response-coverage}.ts`, `lib/auth/plugin-endpoint.ts`, `lib/http/openapi/{merge-better-auth,better-auth-tables}.ts`, `server/elysia/register.ts`, `tests/helpers/expect-body.ts`, tests `bindings`, `openapi-contract`, `response-check`, `response-contract`, `zod-compile` |

Both files also hold the **Better Auth** tables, which keep consumers until Phase 5.

### 3.4 What the 2026-10-10 back-end changes broke in the front end

Accepted by the owner until S1 lands. Nothing here was changed in `apps/front-end`.

- **Plugin successes.** `authFetch` (`lib/auth/request.ts`) parses every non-`plain` answer with `pluginEnvelope`, whose `success: z.literal(true)` no plugin success carries any more: each `authRequest` / `authFetch` call on a plugin path (two-factor management, passwordless and OAuth results, re-authentication methods and passkey options, trusted devices, capabilities) fails as an unreadable answer (`invalidResponse()` on a GET, `committedError()` on a POST). The doc comments on `plain` (`request.ts`, `lib/auth/query.ts`) name `{ success, data }`.
- **Plugin mocks.** `pluginOk` (`mocks/lib/http.ts`) still emits `success: true`; the mock 2xx check reads `BETTER_AUTH_RESPONSES`, whose JSON-Schema read-back refuses the unknown key, so every handler answering through `pluginOk` throws under `bun test`. Literal plugin bodies in handlers (`mocks/handlers/*.ts`) and tests that read them raw follow. `lib/account/schemas.ts` (`messageOnlySchema = pluginMessage()`) follows the shared helper by itself.
- **Self-rename.** `renameSelf` (`lib/users/rename.ts`) sends `{ name }` to `PUT /api/dash/users/:id` with the caller's id: the server answers 403 `MSG_INSUFFICIENT_PERMISSIONS`, and `RequestBody<'PUT /api/dash/users/:id'>` is now the administrative body, so `{ name }` no longer type-checks. The users mock (`mocks/handlers/users.ts`) still renames through `/:id` and has no `PUT /api/dash/users/me`.
- **Front-end `tsc` (`bunx tsc --noEmit` in `apps/front-end`, 2026-10-10): two errors, both the self-rename.** `lib/users/rename.ts(44,9)` TS2739: `{ name }` is not `RequestBody<'PUT /api/dash/users/:id'>` (now the administrative body: `email`, `roleId`, `isActive` missing). `mocks/handlers/users.ts(62,7)` TS2488: `const [adminUpdateBody, selfUpdateBody] = REQUEST_BODIES['PUT /api/dash/users/:id']` destructures what is now one schema. The plugin change raises no type error (the shapes are parsed at runtime); its fallout shows in `bun run test` (mock contract check) and in the browser. Front-end tests were not run for this record.

## 4. Target state

- Every error the API sends is a problem (`application/problem+json`): bindings, mapped framework errors, request-hook refusals, route misses, and everything under the Better Auth prefix. Successes are `{ message, data, meta? }`.
- A response-validation 500 carries `code: "invalid_response"`; clients never retry it, and a write maps to "saved, not shown".
- The front end calls bindings only through `api(entry, …)` and the new query hooks. Paths, params, query, body and response types come from the entry. Responses are parsed by the entry's schema.
- Mocks for bindings are `mock(entry, resolver)` and keep the 2xx contract check.
- `z.config({ jitless: true })` runs before any zod schema is built in the browser.
- Front-end lint forbids importing `*.docs.ts`.
- Self-rename goes through `PUT /api/dash/users/me` (back end done; the front end moves in S1). `PUT /api/dash/users/:id` validates its admin body natively and refuses the caller's own id 403 (done).
- Plugin successes are read without `success` (back end done; the front end moves in S1).
- `REQUEST_BODIES`, `RESPONSE_DATA` and everything keyed by them are gone.

## 5. Wire formats

### 5.1 Content types

| Answer                                                    | Before                                              | After                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Success (bindings)                                        | `application/json;charset=utf-8`                    | unchanged                                                                                         |
| Error (bindings, mapped errors, request hook, route miss) | `application/json;charset=utf-8`                    | `application/problem+json` (exactly this value)                                                   |
| Better Auth error (prefix route)                          | `application/json` (localised) or Better Auth's own | `application/problem+json`                                                                        |
| Better Auth plugin success                                | `{ success: true, … }` JSON                         | `{ data }`, `{ message, data }` or `{ message }` JSON; **already live** (2026-10-10, P4-D6, §5.8) |
| Raw entries (`/api/health/storage`, `/openapi.json`)      | raw                                                 | unchanged                                                                                         |

### 5.2 Success

Before:

```json
{
  "success": true,
  "message": "تم التحديث بنجاح",
  "data": { "updatedAt": "2026-10-10T09:15:00.000Z" }
}
```

After (`PUT /api/dash/permissions/:id`, 200):

```json
{
  "message": "تم التحديث بنجاح",
  "data": { "updatedAt": "2026-10-10T09:15:00.000Z" }
}
```

### 5.3 List with meta

After (`GET /api/dash/permissions?page=1`, 200). Before: the same plus `"success": true`.

```json
{
  "message": "تم جلب البيانات بنجاح",
  "data": [
    {
      "id": "…",
      "roleName": "…",
      "description": null,
      "isActive": true,
      "createdAt": "…",
      "updatedAt": "…",
      "usersCount": 3
    }
  ],
  "meta": { "page": 1, "perPage": 10, "total": 1, "pageCount": 1 }
}
```

`meta` appears exactly on entries whose `response` is `{ data, meta }`.

### 5.4 Refusal with code and data

Before (`PUT /api/dash/media`, 409; key order was part of the frozen format):

```json
{
  "success": false,
  "message": "الملف قيد المعالجة، حاول مرة أخرى بعد قليل",
  "data": { "fileIds": ["…"] },
  "code": "FILE_BUSY"
}
```

After:

```json
{
  "type": "about:blank",
  "title": "Conflict",
  "status": 409,
  "detail": "الملف قيد المعالجة، حاول مرة أخرى بعد قليل",
  "code": "FILE_BUSY",
  "data": { "fileIds": ["…"] }
}
```

Members:

| Member     | Rule                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`     | always `"about:blank"` (D5, F23). No other type URIs                                                                                                                       |
| `title`    | the RFC 9110 reason phrase of `status`, English (RFC 9457 §4.2.1). Omitted for a status the shared map does not list (only Better Auth can send one). Never shown to users |
| `status`   | the HTTP status, same number                                                                                                                                               |
| `detail`   | the localised message (the old `message`). The only text a client shows                                                                                                    |
| `code`     | optional, as today. Clients branch on it                                                                                                                                   |
| `data`     | optional. Present only when a media refusal names ids (P4-D3). Was `null` otherwise                                                                                        |
| `instance` | not used                                                                                                                                                                   |

Headers are unchanged: `Retry-After` on 429 and 503, `Set-Cookie`, security headers.

### 5.5 Validation 422

Before (`PUT /api/dash/users/me` with `{ "name": "" }`):

```json
{ "success": false, "message": "الاسم مطلوب", "data": null }
```

After:

```json
{
  "type": "about:blank",
  "title": "Unprocessable Content",
  "status": 422,
  "detail": "الاسم مطلوب"
}
```

Overrides (D25) keep their status and message: for example the data-table lists still answer 422 `أحد عوامل التصفية غير صالح، أعد ضبط التصفية`.

### 5.6 Better Auth error

Before (`POST /api/auth/sign-in/email`, wrong password, 401, localised by `localiseAuthError`):

```json
{ "message": "البيانات المدخلة غير صحيحة", "code": "__" }
```

After:

```json
{
  "type": "about:blank",
  "title": "Unauthorized",
  "status": 401,
  "detail": "البيانات المدخلة غير صحيحة",
  "code": "__",
  "message": "البيانات المدخلة غير صحيحة"
}
```

`message` duplicates `detail` on every answer of the prefix route, so the Better Auth client keeps working: `@better-fetch/fetch@1.3.1` parses any JSON error body and returns `error = { ...body, status: response.status, statusText }` (`node_modules/@better-fetch/fetch/dist/index.js`, error path). RFC 9457 §3.2 tells clients to ignore unknown members. `code` keeps today's value (a routing code, or `CUSTOM_AUTH_CODE` `"__"`).

### 5.7 Response-validation failure (F14)

```json
{
  "type": "about:blank",
  "title": "Internal Server Error",
  "status": 500,
  "detail": "حدث خطأ في الخادم",
  "code": "invalid_response"
}
```

### 5.8 Better Auth plugin success (already live)

Before (`POST /api/auth/two-factor/methods/default`, 200):

```json
{ "success": true, "data": { "defaultMethod": "otp:phone" } }
```

Since 2026-10-10:

```json
{ "data": { "defaultMethod": "otp:phone" } }
```

The three shapes are `{ data }`, `{ message, data }` and `{ message }`, per path in `BETTER_AUTH_RESPONSES`. Better Auth's library endpoints keep their own bodies.

## 6. Decision register (Phase 4)

Every row is **Decided**. "Author" marks a decision this plan makes where the main plan left a gap; a reviewer may overturn it.

| #      | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Reason                                                                                                                                                                                                                                                                                      |                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| P4-D1  | **Migration strategy: tolerant client first, one flip, then migrate per domain** (§7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the format is global, so the back end flips in one step; a client that reads both formats lets the flip land without touching call sites, and survives deploy skew                                                                                                                          | Author                                          |
| P4-D2  | Problem members as §5.4; `type: "about:blank"`; `title` from a shared status map, omitted when unmapped; no `instance`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | D5, F23, RFC 9457 §4.2.1                                                                                                                                                                                                                                                                    | `title`/`instance`: Author                      |
| P4-D3  | `data` only when a refusal names ids; omitted, not `null`, otherwise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `null` carries nothing; clients already treat it as optional (`refusalData` in `fetch.ts`)                                                                                                                                                                                                  | Author                                          |
| P4-D4  | `message` member on **every** answer of the Better Auth prefix route (Better Auth's errors, localised or not, and the route's own refusals); never on bindings                                                                                                                                                                                                                                                                                                                                                                                                                               | F34 (better-fetch reads `message`); one rule tied to one route; our bindings under `/api/auth/otp/*` etc. are read by our client                                                                                                                                                            | scope: Author                                   |
| P4-D5  | Success `{ message, data, meta? }` (D6). Problem content type `application/problem+json` exactly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | D5, D6, F26                                                                                                                                                                                                                                                                                 |                                                 |
| P4-D6  | **Done in the back end (owner, 2026-10-10): plugin successes carry no `success`**: `{ data }`, `{ message, data }` or `{ message }` (§5.8). The front end follows in S1: `pluginEnvelope` in `lib/auth/request.ts` drops `success`, mocks stop emitting it                                                                                                                                                                                                                                                                                                                                   | `success` duplicated the status and was our own convention: neither the Better Auth client (`better-auth@1.7.3`, `dist/client/**`) nor `@better-fetch/fetch@1.3.1` reads it, and no server-side hook, plugin or check of ours did (§13). One success rule for bindings and plugins after S2 | Owner                                           |
| P4-D7  | **F14 code = `invalid_response`**: move the front end's existing `INVALID_RESPONSE_CODE` to `@app/shared/error-codes`; the server puts it on **every** response-validation 500 (all methods, bindings and Better Auth plugin checks)                                                                                                                                                                                                                                                                                                                                                         | the client already maps that code to `committedError()` on writes and to no-retry on queries (`mutation.ts`, `react-query-provider.tsx`), so no new client branch; one meaning: "the server did the work, its answer broke the contract"                                                    | Author                                          |
| P4-D8  | **One builder per body kind, in shared:** `packages/shared/src/api/wire.ts` holds `successBody`, `problemBody`, `successSchemaOf(entry)` (moved from `lib/http/binding.ts`), `problemSchema`, `authProblemSchema`, `PROBLEM_MEDIA_TYPE`. Back-end `response.ts` and the mocks call them                                                                                                                                                                                                                                                                                                      | D18's "one function per body kind" now has four consumers (back end, mocks, front-end client, test helpers); pure functions, no runtime API                                                                                                                                                 | Author                                          |
| P4-D9  | **One client function `api(entry, input, options)`** replaces `apiRequest` and `mutate`. Re-auth retry only when `entry.policy.reauth`; `captcha` option required exactly when `entry.policy.captcha`; bookkeeping and the committed mapping on writes only; **no client-side request validation** (forms already validate with the same schemas; the server decides)                                                                                                                                                                                                                        | the policy flags are in shared precisely so the client can type the refusals they imply (main plan §6.3); `declaredCodes` plus the §9.6 development check guarantee only `reauth: true` entries answer `REAUTH_REQUIRED`                                                                    | Author                                          |
| P4-D10 | The client **always parses with the entry's response schema**. Optional `narrow` schema (input = the entry's output) for callers that need a stricter view (media listing per scope, single upload)                                                                                                                                                                                                                                                                                                                                                                                          | one parse rule; the narrow case exists today                                                                                                                                                                                                                                                | Author                                          |
| P4-D11 | New hooks under new names (`useEndpointQuery`, `endpointQuery`, `useEndpointPage`, `endpointPageQuery`, `useEndpointPages`, `useEndpointTable`) coexist with the old ones until the last caller moves; same cache keys and behaviour                                                                                                                                                                                                                                                                                                                                                         | old and new can live side by side during per-domain steps                                                                                                                                                                                                                                   | Author                                          |
| P4-D12 | `mock(entry, resolver)`: method, path and success status from the entry; the request body parsed **lazily** by the entry's schema (`await body()`), so a mock can refuse 401/403 before reading it, as the server's gate does; success built by `successBody`, refusals by `problemBody`; 2xx checked against the entry. Better Auth mocks stay raw MSW and emit auth problems                                                                                                                                                                                                               | typed mocks (main plan §6.2 item 4) without breaking refusal order                                                                                                                                                                                                                          | Author                                          |
| P4-D13 | **`z.config({ jitless: true })` in a module that imports only `zod`** (`lib/zod-jitless.ts`), imported first by `lib/zod-locale.ts`, which becomes the first JS import of `pages/_app.tsx`                                                                                                                                                                                                                                                                                                                                                                                                   | **correction of main plan Z11:** zod runs its `new Function` probe when the **first `z.object` is built**, not at first parse (probe in §13). `zod-locale.ts` imports `validation/rules.ts`, whose imports build schemas before the module body runs                                        | Author (placement)                              |
| P4-D14 | Front-end `*.docs` rule: add the pattern to the existing all-files `@typescript-eslint/no-restricted-imports` block, plus a `mocks/**` block with the same rule and only that pattern                                                                                                                                                                                                                                                                                                                                                                                                        | the folder blocks use `no-restricted-imports` and would override each other; the all-files block ignores `mocks/`                                                                                                                                                                           |                                                 |
| P4-D15 | `/api/dash/settings`: a **front-end-local** `endpoint()` entry beside the settings page (`components/dash/settings/endpoint.ts`), used by the page and its mock. Move it to shared when a back end serves the route                                                                                                                                                                                                                                                                                                                                                                          | the client takes any entry; no back end exists, so shared must not claim it                                                                                                                                                                                                                 | Author                                          |
| P4-D16 | **D22 completed, done in the back end (owner, 2026-10-10).** `PUT /api/dash/users/:id`: entry body `adminUpdateUserBodySchema`; native, compiled validation; `permission: { users, edit, notSelf: 'id', handlerAsksReauth: true }`. A well-formed id equal to the caller's → **403 `MSG_INSUFFICIENT_PERMISSIONS`** (existing message, no new copy), refused by the gate right after the grant check, before the limiter and the body. `handlerValidatesBody`, `parseOrThrow` and the registry's multi-shape support deleted. The front end renames through `PUT /api/dash/users/me` from S1 | the admin path could change the caller's own role or active state (`editUserAsAdmin` was never built for a self target); self edits belong to `/me`. Order: 401 → 403 (no grant, or own id) → 429 → 400/413/422 → handler                                                                   | Owner (403 and message); gate placement: Author |
| P4-D17 | **D29 completed, partly.** Delete `REQUEST_BODIES`, `RESPONSE_DATA` and everything keyed by them (`RequestBody`, `RequestRoute`, `ResponseData`, `ResponseRoute`, `isResponseRoute`, `PAGINATED_ROUTES`, `responseEnvelope`, `responseIssues`, `RequestFieldsAreTyped`). `contract.ts` and `response-contract.ts` stay, holding only the Better Auth tables and the generic checks (`contractIssues`, `UnknownFieldsOf`, `Assert`), until Phase 5 removes their last consumers                                                                                                               | D29 says "until their last consumer moves"; the Better Auth halves have consumers until Phase 5. Renaming the files now would move them twice                                                                                                                                               | Author                                          |
| P4-D18 | **D23 re-decided: keep 400** `MSG_INVALID_INPUT` for a wrong media type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | no client sends another type; the CSRF layer needs a refusal, not a specific one; 415 would need per-route decisions where two routes collapse unreadable bodies to 400 (audit fix 2). Cost of keeping: less precise status for developers                                                  | Author                                          |
| P4-D19 | **Data-table `sort`/`filters` stay out of the query schema**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | the client sends strings built by `writeTableQuery` either way; parsing in the schema needs a request `.transform()` (unverified under `z.compile` and the document generator) and a per-route column map; every refusal reads `MSG_INVALID_FILTER` regardless (main plan §9.5)             | Author                                          |
| P4-D20 | **D17 narrowed:** tests broken by the flip move to `expectData`/`expectError` (gate). Moving other feature tests to a typed test client is not a Phase 4 gate; new tests use the helpers                                                                                                                                                                                                                                                                                                                                                                                                     | hundreds of tests, churn without behaviour gain; the helpers already isolate the wire. Cost: tests keep raw path strings                                                                                                                                                                    | Author                                          |
| P4-D21 | Turning on the CSP in `next.config.js` is **not** in Phase 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | D12 only requires `jitless` before the CSP; the CSP itself is the front-end owner's change                                                                                                                                                                                                  |                                                 |
| P4-D22 | Delete the unused `ApiEnvelope` (`packages/shared/src/types/api.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | no importer                                                                                                                                                                                                                                                                                 |                                                 |

## 7. Migration strategy

### 7.1 Options

| Option                                           | How                                                                                                                                                             | For                                                                                                                                            | Against                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Single cut-over                               | back end, every call site and every mock in one change                                                                                                          | no transition code                                                                                                                             | about 60 front-end files plus ~40 back-end test files in one change, while others edit the front end; one long red window; old bundles break at deploy |
| B. Tolerant client first (**chosen**)            | S1 teaches the existing parser both formats; S2 flips the back end, the shared envelope schemas and the mock builders together; call sites then move per domain | every step is green and small; call sites untouched by the flip; a deployed old bundle that already has S1 keeps working when the server flips | ~10 lines of transition code, removed in S9                                                                                                            |
| C. Back-end dual format (negotiated by `Accept`) | server emits both                                                                                                                                               | front end could move at leisure                                                                                                                | adds a format switch to core; the main plan rejected a dual-format layer (§14.3)                                                                       |
| D. Per-domain flip                               | flip one domain at a time                                                                                                                                       | —                                                                                                                                              | impossible: `errorBody`/`successBody` are global, and Better Auth and the mapped framework errors have no domain                                       |

### 7.2 Why B, and what "tolerant" means

The success side needs no dual logic: a plain `z.object({ message, data, meta? })` ignores an old `success` key. The error side needs one rule: read `detail`, else `message`. The client branches on `response.ok`, never on a `success` flag (D6: the flag duplicates the status).

The mocks cannot stay on the old format after the flip: the mock contract check reads the shared envelope schema, whose JSON-Schema read-back refuses unknown keys. So S2 changes the mock builders in the same step as the back end.

Deploy order in a real deployment: ship S1 before S2.

## 8. Steps

Order: S0 → S1 → S2 → S3 → S4 → S5, then S6, S7, S8 in any order (disjoint files), then S9 → S11. S10 (the back end's half of D22) is already done. S11 needs S4–S9. S1 comes first for a second reason now: it repairs what the 2026-10-10 back-end changes broke (§3.4).

### S0. Baseline (no code)

- `git status`; note every existing diff (others' work).
- Run and record: front end `bun run lint`, `bun run test`, and the time of `bun run typecheck` (R2); `packages/shared` `bun run lint`; back end the full acceptance set (§10). Record front-end first-load JS sizes from `bun run build` if it builds offline (P4-R6). Take a fresh timing baseline when changing the checker; earlier TypeScript timings are not a Bun baseline.

### S1. Front end reads both formats, and catches up with the 2026-10-10 back end (no back-end change)

Changes 7 and 8 repair what is broken today (§3.4); the rest prepares S2. Putting the repair here rather than in S5 is an author decision: it ends the broken window at the first step.

Changes:

1. `packages/shared/src/error-codes.ts`: add `INVALID_RESPONSE_CODE = 'invalid_response'`. `lib/api/fetch.ts` imports it instead of declaring it (same value).
2. `lib/api/fetch.ts`: the body schema reads `message?`, `detail?`, `code?`, `data?`, `meta?`; the error text is `detail ?? message ?? failureMessage(status)`; success is decided by `response.ok` alone; a 2xx needs `message` and `data`.
3. `lib/auth/client.ts` `toAuthError`: `message ?? detail`.
4. `lib/auth/request.ts` `authFetch`: a `POST` whose error carries `INVALID_RESPONSE_CODE` rejects as `committedError()` (F14 for plugin endpoints; inert until S2).
5. `jitless` (P4-D13): new `lib/zod-jitless.ts` (`import * as z from 'zod'; z.config({ jitless: true });`); first line of `lib/zod-locale.ts` imports it; move `import '@/lib/zod-locale'` to the first line of `pages/_app.tsx` (it is not CSS, so the cascade is unchanged). Tests need no change: Bun sends no CSP.
6. `eslint.config.mjs` (P4-D14): forbid `**/*.docs` and `**/*.docs.ts` everywhere, mocks included, message: field docs never reach the browser.
7. **Plugin successes without `success` (P4-D6).** `lib/auth/request.ts`: `pluginEnvelope` becomes `z.object({ message: z.string().optional(), data: z.unknown() })` (no `success` member; a stray one from an old server is ignored, not required); fix the `plain` comments there and in `lib/auth/query.ts`. `mocks/lib/http.ts`: `pluginOk` stops emitting `success`; sweep literal plugin bodies in `mocks/handlers/*.ts` (`grep -n "success: true" mocks`) and the front-end tests that read them raw. The 2xx mock check already holds mocks to the new shapes (`BETTER_AUTH_RESPONSES`).
8. **Self-rename through `PUT /api/dash/users/me` (D22).** `lib/users/rename.ts` `renameSelf`: `href` `/api/dash/users/me`, body typed `RequestBody<'PUT /api/dash/users/me'>`, cache bookkeeping unchanged (still keyed by the caller's id). `mocks/handlers/users.ts`: add a `PUT /api/dash/users/me` mock (rename; 403 `MSG_INSUFFICIENT_PERMISSIONS` for a missing or inactive role; 404 when gone), and make the `/:id` mock refuse the caller's own well-formed id with 403 `MSG_INSUFFICIENT_PERMISSIONS` before reading the body, and parse the administrative body only. S5 later moves `renameSelf` onto `api(updateSelf, …)`.

Tests:

- `tests/api-fetch.test.ts`: a problem body maps to `CustomError(detail, status, code, data)` with `Retry-After`; the old envelope is still read; a 2xx without `success` is read; a non-JSON 502 uses `failureMessage`.
- `tests/auth-client.test.ts`: a problem body with `message` maps as before.
- New `tests/zod-jitless.test.ts`: spawns `bun` on a fixture under `tests/fixtures/` that proxies `globalThis.Function`, imports `@/lib/zod-locale` and then a schema-heavy module (`@app/shared/api/users`), and prints the construct count; assert 0. Mutation check: without the jitless import the count is 1.
- Lint mutation check: a temporary import of a `*.docs` file in `components/` and in `mocks/` fails lint; remove it.
- `authFetch` (new cases in `tests/auth-client.test.ts`, or a new `tests/auth-request.test.ts`; only `reauth-retry.test.ts` drives it today): a plugin body without `success` is read (`data`, `message`); `{ message }` alone is read; a body with `success: true` still reads (old server); a body without `data` where a schema asks for it is unreadable.
- Users mocks: `PUT /api/dash/users/me` renames; `PUT /api/dash/users/:id` with the caller's id answers 403 with the existing message.

Acceptance: front end lint + test (the `tsc` errors listed in §3.4 are gone); `packages/shared` lint; back end `bun run lint` (shared changed).

### S2. The flip (shared + back end + mock builders, in one step)

**Shared**

- `api/wire.ts` (P4-D8): `PROBLEM_MEDIA_TYPE`, `problemSchema` (lenient object: `type`, `title?`, `status`, `detail`, `code?`, `data?` = `mediaRefusalDataSchema`), `authProblemSchema` (+ `message`), `successEnvelope(data, meta?)` (moved here, new shape, no `success`), `successSchemaOf(entry)` (moved from `apps/back-end/lib/http/binding.ts`), `successBody`, `problemBody(status, detail, code?, data?)`.
- `http-status.ts`: `HTTP_STATUS_TITLES` for every status in `HTTP_STATUS` (400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 405 Method Not Allowed, 409 Conflict, 413 Content Too Large, 422 Unprocessable Content, 429 Too Many Requests, 500 Internal Server Error, 503 Service Unavailable; 2xx/3xx need none).
- `response-contract.ts`: imports `successEnvelope` from `wire.ts`; delete `errorEnvelopeSchema` (replaced by `problemSchema`).
- Docs: move `response-contract.docs.ts` to `api/wire.docs.ts`, describing `problemSchema` (`detail`, `code`, `data`) and `authProblemSchema.message`. Update the loader list in `apps/back-end/lib/http/openapi/docs.ts` (its test checks the list against the files on disk).
- `api/endpoint.ts` `declaredCodes`: at 500, every entry implies `INVALID_RESPONSE_CODE`.
- `types/api.ts`: delete `ApiEnvelope` (P4-D22).

**Back end**

- `lib/http/response.ts`: `successBody` and the private `errorBody` call the shared builders; `errorBody` now takes the status (`apiError` passes it). `toWebResponse` sets `content-type: application/problem+json` on error outputs.
- `lib/http/contract.ts`: `SuccessBody` loses `success`; `ErrorBody` becomes the problem type.
- `lib/http/run.ts`: `responseFailure` and the `checkSuccess` 500 answer with `INVALID_RESPONSE_CODE` (one helper). The undeclared-code 500 of `declared()` stays code-less (a refusal bug, not a committed answer). `lib/http/response-check.ts`: the Better Auth response-check 500 carries the code too.
- `server/elysia/register.ts`: refusal response schemas use the compiled `problemSchema`.
- `lib/auth/errors.ts`: replace `localiseAuthError` with one function (for example `toAuthProblem(response)`): any non-2xx, non-3xx answer whose body is a JSON object becomes `authProblemSchema` with `application/problem+json`. A Better Auth `{ code, message }` is localised as today (`localisedAuthBody`), else its own message is the `detail`. A body that is already a problem gains `message`. Anything else passes through. `server/elysia/auth-mount.ts` sends every answer it produces through it, its catch path and route misses included (P4-D4).
- `lib/http/openapi/finalize.ts`: step 5 (F26): 4xx/5xx content `application/problem+json` with `problemSchema`; the 500 lists `Codes: invalid_response`. `merge-better-auth.ts`: Better Auth refusals publish `authProblemSchema` with the same media type.
- Sweep published prose (`detail` texts in `modules/**`, `*.docs.ts`) for "envelope" wording.
- `scripts/smoke.ts`: "unknown route returns the API envelope" → "unknown route returns a problem" (404, `application/problem+json`, `status: 404`).

**Back-end tests**

- `tests/helpers/expect-body.ts`: `expectError` parses `problemSchema`, asserts the content type, compares `message` to `detail`, returns the problem. `expectData` needs no logic change (its schema is the new envelope). Update `tests/helpers/response-fixtures.ts`.
- Convert every envelope assertion through the helpers. Find them by `grep -rn "\bsuccess\b\|\.message\|data: null" tests` and by the failing run. Turnstile/egress fakes (`{ success: true }` from Cloudflare) and Better Auth's library bodies (`/sign-out` answers `{ success: true }`) are not envelopes: leave them. Plugin successes already carry no `success` (P4-D6).
- New cases: every `HTTP_STATUS` has a title; the builders' output; the content type and problem shape on one refusal of each kind (binding refusal, validation 422 and an override, Elysia parse error, route miss 404 and 405, request-hook 413, Better Auth localised and unmapped, the prefix route's own 429/413); a write and a GET whose success breaks its schema answer 500 `invalid_response`; Better Auth problems keep `code` and `message`.
- `openapi-document.test.ts`, `openapi-contract.test.ts`: error media type and schema; the 500 code.

**Front-end mocks (same step)**

- `mocks/lib/http.ts`: `ok`, `okPage`, `fail`, `errorResponse` use the shared builders, with `application/problem+json` on refusals. `asPlugin` emits `authProblemSchema` bodies. `pluginOk` unchanged here (it lost `success` in S1, P4-D6). MSW keeps an explicit `Content-Type` (`HttpResponse.json` sets one only when absent; verified in `msw@2.15.0`).
- Check body literals in handlers (`mocks/handlers/auth.ts`, `oauth.ts`).
- Front-end tests that read raw mock bodies (about 48 lines, 14 files) follow.

Front-end call sites are **not** touched: S1's parser reads the new format.

Acceptance: the full back-end set (§10) incl. both smoke postures; `packages/shared` lint; root `check:deps`; front end lint + test.

### S3. Typed client, hooks and `mock()` (infrastructure, no call sites)

**`lib/api/client.ts`:**

```ts
api<E extends ClientEndpoint>(entry: E, input: CallInput<E>, options?: CallOptions<E>): Promise<Answer<E>>
```

- `CallInput<E>`: `params` (keyed by `PathParams<E['path']>`, `z.input` of the params schema) when the path has `:name` segments; `query?` (`z.input` of the query schema) when declared; `body` = `z.input` of the body for JSON, the form object (`z.input` of the form schema, converted to `FormData`) for multipart; nothing else. `input` is optional when empty.
- `CallOptions<E>`: `signal?`; `captcha` (required when `entry.policy.captcha`); `narrow?`; on writes `onSuccess?`, `onUnreadAnswer?`.
- `Answer<E>`: `{ message, data }` (`z.output` of the response), plus `meta: PaginationMeta` on a paged entry. Raw entries are not accepted by the type (no caller).
- URL: `encodeURIComponent` per param; query keys with `undefined` dropped; base `API_URL`; `credentials: 'include'`; `fetchOnline`.
- Reading: 2xx → `successSchemaOf(entry)` then `narrow`; a mismatch logs paths and codes (`logInvalidResponse`) and fails as `invalidResponse()`. Non-2xx → `problemSchema` → `CustomError(detail, status, code, data)` with `Retry-After`; anything else → `failureMessage(status)`. Aborts rethrow as is.
- Writes: `withReauth` only on `entry.policy.reauth` (single-use when `captcha` is set); `INVALID_RESPONSE_CODE` (client- or server-raised) → `committedError()`; `withBookkeeping`. Captcha: header `CAPTCHA_HEADER`; the token is recorded as sent, so `takeSentCaptcha` keeps working (adapt `withCaptcha` in `lib/auth/captcha.ts` to hand back the token instead of headers).
- `BodyOf<E>` replaces `RequestBody<'…'>` for form payload types.
- Keep in `fetch.ts`: `fetchOnline`, `failureMessage`, `retryAfterMs`, `invalidResponse`, `logInvalidResponse`, `hasErrorCode`, `hasErrorStatus`. Keep in `mutation.ts`: `committedError`, `isCommitted`, `withBookkeeping` (used by `authRequest`).

**`lib/api/endpoint-query.ts`** (P4-D11): `endpointQuery(entry, input, { queryKey })` → `{ queryKey, queryFn }`; `useEndpointQuery(entry, input, { queryKey, enabled? })`; `endpointPageQuery` / `useEndpointPage(entry, input, { queryKey, state, toPage, enabled? })` for a paged entry (query from the `TableQuery` through `writeTableQuery`, search through `effectiveSearchTerm`, `keepPreviousData`); `useEndpointPages` (infinite); `useEndpointTable` (data = rows). Cache keys are exactly the old ones.

**`mocks/lib/endpoint.ts`** (P4-D12):

```ts
mock(entry, async ({ params, query, body, request }) => ({ data, message?, meta? }))
```

- `params`: the raw strings, typed by `PathParams`; `query`: `URLSearchParams`; `body(message?)`: reads JSON (400 for a non-object, as `readJson`), parses with `entry.body` (422 with the issue message, or `message`).
- Returns `z.input` of the response; built by `successBody` with the entry's status. A thrown `CustomError` becomes a problem; anything else a 500.
- Checks the 2xx against the entry: export a by-entry check (for example `endpointIssues(entry, body)`, using `contractIssues` and `successSchemaOf`) from `packages/shared/src/response-contract.ts`. Each handler is checked once: `withApiErrors` passes `mock()` handlers through.

Tests: type-level cases with `@ts-expect-error` (missing params, wrong body, missing `captcha` on a captcha entry, `meta` only on paged entries); `api()` cases (re-auth retry only on re-auth entries, captcha resubmit, abort, problem mapping, `invalid_response` → committed on a write and plain on a GET, `narrow`); a `mock()` case (lazy body, contract check throws under test).

Acceptance: front end lint + test; `bun run typecheck` time against S0 (R2).

### S4–S8. Per-domain migration

For each domain: call sites → `api()` / new hooks; `RequestBody<…>` and `REQUEST_BODIES[…]` → `BodyOf<typeof entry>` / `entry.body`; its mocks → `mock()`; its tests updated. Path constants that only built hrefs go; cache keys stay.

| Step | Domain                                                  | Entries                                                                                                                                                                                                           | Call-site files                                                                                                                                                                                                                                                                  | Mock files                                                                                                                 |
| ---- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| S4   | Dashboard CRUD (generic components serve both entities) | `listPermissions`, `createPermission`, `getPermission`, `updatePermission`, `deletePermission`, `listRoles`, `listUsers`, `createUser`, `getUser`, `updateUser`, `deleteUser`                                     | `components/dash/shared/{entity,edit-record,row-actions,use-entity-mutations}.ts(x)`, `components/ui/data-table/data-table.tsx`, `components/form/form-combobox.tsx`, `components/dash/permissions/{entity,list,edit}`, `components/dash/users/{entity,list,edit,role-combobox}` | `permissions.ts`, `users.ts` (CRUD)                                                                                        |
| S5   | Own record, sessions, preferences                       | `updateSelf` (already on `/me` since S1; now through `api()`), `getUser` (account), `listUserSessions`, `revokeUserSessions`, `resetUserTwoFactor`, `getPreferences`, `updatePreferences`                         | `lib/users/{rename,security}.ts`, `components/dash/account/use-account.ts`, `components/theme-customizer/{preferences,preferences-sync}.ts(x)`                                                                                                                                   | `sessions.ts`, `preferences.ts`, `users.ts` (the `PUT /api/dash/users/me` mock added in S1 moves to `mock(updateSelf, …)`) |
| S6   | Account self-service                                    | `changeEmail`, `verifyEmailChange`, `changePassword`, `changePhone`, `verifyPhoneChange`                                                                                                                          | `components/dash/account/{email-change,phone-change,tabs/password}.tsx`                                                                                                                                                                                                          | `account.ts`                                                                                                               |
| S7   | Anonymous auth, re-auth, dev sign-up                    | `sendOtp`, `verifyOtp`, `sendPasswordlessCode`, `sendPasswordResetCode`, `resetPassword`, `sendRecoverySecondFactorCode`, `completePasswordReset`, `reauthenticate` (never prompts: `reauth: false`), `devSignUp` | `components/dash/auth/{contact-form,forgot-password,verify-contact,passwordless,sign-up}.tsx`, `components/dash/auth/second-factor/options.ts`, `lib/auth/reauth-proof.ts`                                                                                                       | `otp-flows.ts` (7), `auth.ts` (2), `mocks/lib/otp.ts`                                                                      |
| S8   | Media and uploads                                       | the 15 entries of `api/media.ts` the front end calls (all but the two deprecated; `uploadRecordFile` included)                                                                                                    | `lib/media/{api,actions,queries,upload}.ts`, `lib/files/upload.ts`                                                                                                                                                                                                               | `media-library.ts` (16, the two deprecated routes included), `media.ts`                                                    |

Example (S4):

```ts
// before
mutate({
  href: entity.itemHref(id),
  method: 'PUT',
  data: payload,
  schema: updatedAtSchema,
  onSuccess,
  onUnreadAnswer,
});
// after
api(
  entity.endpoints.update,
  { params: { id }, body: payload },
  { onSuccess, onUnreadAnswer }
);
```

`defineEntity` gains the entity's entries (list, create, get, update, delete) and drops `api`/`href`/`itemHref`. `contact-form.tsx` takes one of the three send entries instead of an href union.

Acceptance per step: front end lint + test (mock contract tests included). No back-end change, so no back-end tier.

### S9. Settings, and removal of the old client

- `components/dash/settings/endpoint.ts` (P4-D15); `settings/index.tsx` and `mocks/handlers/content.ts` use it.
- Delete `apiRequest` and the tolerant reading (problems need `detail`); `mutate`; `useQueryData`, `queryDataQuery`, `useServerPage`, `serverPageQuery`, `useServerPages`, `useServerDataTable` (keep `serverPagesKey` only if a caller still reads it); `ok`, `okPage` and the `RESPONSE_DATA` branch of `checkAnswer` in `mocks/lib/http.ts` (Better Auth checks stay).
- `grep` proves no front-end import of `REQUEST_BODIES`, `RequestBody`, `RESPONSE_DATA`, `responseIssues`, `isResponseRoute` is left.
- Update `apps/front-end/mocks/README.md` (how to write a mock).

Acceptance: front end lint + test + `bun run find:unused-files` (knip); `bun run typecheck` time and first-load JS against S0.

### S10. Back end: `PUT /api/dash/users/:id` without self-rename (P4-D16) — done 2026-10-10

Done ahead of the front end (owner decision), recorded in the main plan's §12 ("2026-10-10 owner decisions"). For reference, what changed:

- `packages/shared/src/api/users.ts` `updateUser`: body `adminUpdateUserBodySchema`; `REQUEST_BODIES['PUT /api/dash/users/:id']` the same schema object (D29), and the registry no longer accepts several shapes per route.
- `modules/users/item.ts`: no self branch, no `orSelf`, no `handlerValidatesBody`, no `parseOrThrow`; `permission: { users, edit, notSelf: 'id', handlerAsksReauth: true }`. `modules/users/self.ts` serves `/me` only.
- Core: `PermissionOption.notSelf` (the gate's own-id 403, `lib/http/admit.ts`; its document wording in `lib/http/refusals.ts`) and `handlerAsksReauth` (`gateAsksReauth`); `handlerValidatesBody` and `bind`'s third type parameter deleted (`lib/http/binding.ts`, `server/elysia/register.ts`); `parseOrThrow` deleted (`lib/http/input.ts`).
- Tests: `bindings.test.ts`, `binding-gate.test.ts` (own-id walk), `user-bindings.test.ts`, `authorization-and-audit.test.ts`, `id-canonicalization-guards.test.ts`, `session-role-field.test.ts`, `openapi-contract.test.ts`, `zod-compile.test.ts`.

Nothing is left for Phase 4 here beyond S1's item 8.

### S11. Registries, records

- Delete what P4-D17 lists from `contract.ts` and `response-contract.ts`. Re-key by entry: `lib/http/binding.ts` (drop the "no `RESPONSE_DATA` entry" check), `lib/http/run.ts` and `lib/http/response-check.ts` (check `successSchemaOf(entry)` instead of `responseIssues(key)`), `lib/http/response-coverage.ts` (union sites from the bindings' entries; the integration gate must still report the same coverage, 82/84 at the last run), tests `bindings`, `filter-and-input-edges`, `zod-compile`, `response-check`, `response-contract`, `openapi-contract`.
- Keep the guarantee of `RequestFieldsAreTyped` and `ResponseFieldsAreTyped`: a type-only file in `packages/shared/src/api/` (`import type * as …` of each domain, no runtime import) asserts `UnknownFieldsOf` is `never` for every entry's body input and response output.
- Front-end ESLint: keep the `response-contract` runtime-import rule (Better Auth tables remain).
- Records: add a Phase 4 record to `docs/http-layer-plan.md` §12 (what was built, deliberate changes, test files changed, tier results); mark D5, D6, D12, D23, F14, F26, F34 done; note Z11's correction; fix `README.md` line about `contract.ts`.

Acceptance: back-end set (§10); `packages/shared` lint; front end lint + test; root `check:deps`; back-end `bun run find:unused-files`.

## 9. Deliberate behaviour changes

Each needs a test. Any other difference is a defect.

| Change                                                                                                                                                                                                                                                                                                                                                   | Step | Why         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------- |
| Every error body is a problem with `application/problem+json` (bindings, mapped errors, request hook, route misses, Better Auth prefix)                                                                                                                                                                                                                  | S2   | D5          |
| Success bodies of bindings have no `success` key (plugin successes lost it already, 2026-10-10)                                                                                                                                                                                                                                                          | S2   | D6          |
| `data` omitted when it names nothing (was `null`); new `type`, `title`, `status`; `message` renamed `detail` (kept as `message` too under `/api/auth/*`)                                                                                                                                                                                                 | S2   | P4-D2–D4    |
| Better Auth errors whose code is not localised are problems too (were passed through)                                                                                                                                                                                                                                                                    | S2   | D5, F34     |
| A response-validation 500 carries `code: "invalid_response"`                                                                                                                                                                                                                                                                                             | S2   | F14, P4-D7  |
| The document: error media type, problem schemas, the 500 code                                                                                                                                                                                                                                                                                            | S2   | F26         |
| Smoke: "unknown route returns a problem"                                                                                                                                                                                                                                                                                                                 | S2   | follows     |
| Front end renames through `PUT /api/dash/users/me`; its mocks answer as the back end (own id on `/:id` → 403)                                                                                                                                                                                                                                            | S1   | D22         |
| Front end reads plugin successes without `success`; `pluginOk` emits none                                                                                                                                                                                                                                                                                | S1   | P4-D6       |
| **Already in the back end (2026-10-10, owner):** `PUT /api/dash/users/:id` naming the caller's own well-formed id → 403 `MSG_INSUFFICIENT_PERMISSIONS` before the limiter and the body, any caller (was a 200 rename with no grant); body validated natively against the administrative schema only; the document publishes that body and the own-id 403 | done | D22, P4-D16 |
| **Already in the back end (2026-10-10, owner):** plugin successes are `{ data }`, `{ message, data }` or `{ message }` (was `{ success: true, … }`); runtime check and document follow                                                                                                                                                                   | done | P4-D6       |

**Not changes:** statuses, messages, codes, overrides, `Retry-After`, cookies, other headers, Better Auth's library endpoints, raw entries, cache keys and query behaviour in the front end.

## 10. Acceptance commands

Run one at a time; integration, matrix and process in the background.

| Where             | Command                                                                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/front-end`  | `bun run lint`; `bun run test`; `bun run find:unused-files` (S9, S11)                                                                                                                                                                                                                                   |
| `packages/shared` | `bun run lint`                                                                                                                                                                                                                                                                                          |
| `apps/back-end`   | `bun run lint`; `bun run test` (unit); `bun run test:integration`; `bun run test:matrix`; `bun run test:process`; `bun run smoke`; the production-posture smoke as `.github/workflows/ci.yml` runs it ("Boot smoke test (production posture)", with its environment); `bun run find:unused-files` (S11) |
| root              | `bun run check:deps`                                                                                                                                                                                                                                                                                    |

Known flakes (main plan records): a media DIFAT timing test under load, and setup-hook timeouts under parallel integration load. Rerun the file alone before calling it a defect.

## 11. Risks

| #      | Risk                                                                                                       | Mitigation                                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P4-R1  | Deploy skew: a browser on an old bundle meets the flipped server                                           | ship S1 before S2 (P4-D1)                                                                                                                                                                                  |
| P4-R2  | A body built outside the builders keeps the old shape                                                      | every error site goes through `apiError`/`handleApiError` (§3.1, verified); S2's per-kind content-type test                                                                                                |
| P4-R3  | better-fetch or the Better Auth client depends on a member we change                                       | `message` and `code` kept; better-fetch's own `status` equals ours; `tests/auth-client.test.ts` with a problem body                                                                                        |
| P4-R4  | Next.js evaluates a page module before `_app`, so a schema is built before `jitless`                       | **not verified.** Pages-router entry scripts run in document order (`_app` first) as far as known. S1's test proves module order inside the graph only. Check when the CSP goes on (it reports violations) |
| P4-R5  | Type-check cost of the typed client (main plan R2)                                                         | measure `bun run typecheck` at S0, S3, S9; report                                                                                                                                                          |
| P4-R6  | Bundle growth: per-domain entries import every schema of their domain                                      | most are imported today; compare first-load JS at S0 and S9; split an entry file only on evidence                                                                                                          |
| P4-R7  | Conflicts with parallel front-end work                                                                     | small steps; only listed files; others' diffs untouched; isolated commits                                                                                                                                  |
| P4-R8  | Mocks drift from the server's refusal order                                                                | lazy `body()` in `mock()` (P4-D12)                                                                                                                                                                         |
| P4-R9  | The tolerant parser outlives the migration                                                                 | S9 deletes it; a test then asserts an old error envelope is unreadable                                                                                                                                     |
| P4-R10 | Coverage gate lost while re-keying `response-coverage.ts`                                                  | S11 requires the same coverage figure as before                                                                                                                                                            |
| P4-R11 | `title` (English) shown to users                                                                           | clients read `detail` only; covered by the client tests                                                                                                                                                    |
| P4-R12 | The settings entry diverges from a future back end                                                         | P4-D15: moves to shared with the route; the mock is its only implementation today                                                                                                                          |
| P4-R13 | Two success shapes until S2: bindings `{ success: true, … }`, plugins without `success` (since 2026-10-10) | S1 makes `authFetch` read plugins without requiring `success`; S1's tolerant `apiRequest` ignores it on bindings; S2 removes it from bindings                                                              |
| P4-R14 | The front end is broken against the current back end (plugin reads, self-rename) until S1 (§3.4)           | owner-accepted while in development; S1 first; no deployment of the back end without S1                                                                                                                    |

## 12. Open questions

| #     | Question                                                              | Who             |
| ----- | --------------------------------------------------------------------- | --------------- |
| P4-Q1 | When does the CSP go on (D12, P4-D21)? It is also the check for P4-R4 | front-end owner |
| P4-Q4 | Adopt a typed back-end test client broadly (D17, P4-D20)?             | owner           |
| P4-Q5 | A back end for `/api/dash/settings`                                   | owner           |
| P4-Q6 | Closed 2026-10-16: `authRequest` refusals keep `Retry-After` (§14.4)  | done            |

Closed by the owner on 2026-10-10: P4-Q2 (no new message: the caller's own id answers 403 with the existing `MSG_INSUFFICIENT_PERMISSIONS`) and P4-Q3 (plugin successes dropped `success` now, not in Phase 5; P4-D6).

## 13. Evidence and references

**zod's eval probe runs at the first object construction** (corrects main plan Z11). `node_modules/zod/v4/core/schemas.js` (`$ZodObjectJIT`) reads `globalConfig.jitless` and `util.allowsEval.value` when a schema is built; `allowsEval` (`zod/v4/core/util.js`) runs `new Function("")` once unless `jitless` is set. Probe (zod 4.6.5, Bun 1.4.2), counting `Function` constructions:

```js
globalThis.Function = new Proxy(Function, {
  construct(t, a) {
    probes++;
    return Reflect.construct(t, a);
  },
});
// jitless set before z.object(): 0 after construction, 0 after parse
// jitless set after  z.object(): 1 after construction, 2 after parse
// never set:                      1 after construction, 2 after parse
```

**Nothing reads `success` on a plugin success** (P4-D6, verified 2026-10-10). `better-auth@1.7.3`: no property read of `success` in `dist/client/**` or in any plugin client (`dist/plugins/*/client.mjs`); the server-side reads in `dist/plugins/**` are its own captcha providers' and access-control results, never an endpoint's answer. `@better-fetch/fetch@1.3.1` (`dist/index.js`): a 2xx returns the parsed body as `data`; `successContext` is a local name. Our back end: `localiseAuthError` and `checkBetterAuthResponse` read `code`/`message` and the schema, `response-coverage.ts` matches union members, the after-hooks and mailers read no answer body. The one `success` left in `lib/auth` is the OAuth flow's internal refusal marker `{ success: false }` (`lib/auth/oauth/plugin.ts`), stored for `GET /oauth/result` and never answered; outcomes no longer carry `success`, so `isRefusal` still tells them apart.

| Reference                                                                                                                                                                      | Used for                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `docs/http-layer-plan.md` §0 (D1, D5, D6, D12, D16–D18, D22, D23, D29), §5.7 (F14, F23, F26, F34), §6, §9.5–9.9, §11, §12 (phase records), §14, §15                            | the decisions this phase completes |
| RFC 9457 §3.1 (members), §3.2 (extension members, ignore unknown), §4.2.1 (`about:blank`, title = status phrase): https://www.rfc-editor.org/rfc/rfc9457.html                  | problem format                     |
| RFC 9110 §15 (reason phrases)                                                                                                                                                  | `HTTP_STATUS_TITLES`               |
| `node_modules/@better-fetch/fetch/dist/index.js` (1.3.1): error object = parsed body spread + `status`, `statusText`; `JSON_RE` accepts `+json`                                | P4-D4, P4-R3                       |
| `node_modules/msw/lib/core/HttpResponse.mjs` (2.15.0): `json()` keeps an explicit `Content-Type`                                                                               | S2 mocks                           |
| `node_modules/zod/v4/core/util.js` (`allowsEval`), `schemas.js` (`$ZodObjectJIT`)                                                                                              | P4-D13                             |
| `packages/shared/src/api/{endpoint,permissions,users,media,auth,dev,health,openapi}.ts`                                                                                        | the contract                       |
| `packages/shared/src/{contract,response-contract,response-contract.docs,error-codes,http-status}.ts`, `types/api.ts`, `responses/better-auth.ts`                               | registries, codes, plugin bodies   |
| `apps/back-end/lib/http/{response,contract,run,binding,refusals,request,input,response-check,response-coverage}.ts`                                                            | builders and checks                |
| `apps/back-end/server/elysia/{register,errors,respond,auth-mount}.ts`, `lib/auth/errors.ts`                                                                                    | wiring, Better Auth errors         |
| `apps/back-end/lib/http/openapi/{finalize,merge-better-auth,docs}.ts`                                                                                                          | document                           |
| `apps/back-end/modules/users/{item,self}.ts`                                                                                                                                   | D22                                |
| `apps/back-end/tests/helpers/{expect-body,response-fixtures}.ts`, `scripts/smoke.ts`                                                                                           | test helpers, smoke                |
| `apps/front-end/lib/api/{fetch,mutation,query,query-cache,reauth-retry}.ts`, `lib/auth/{client,request,captcha,reauth,reauth-proof}.ts`, `lib/zod-locale.ts`, `pages/_app.tsx` | client today                       |
| `apps/front-end/components/app/react-query-provider.tsx`                                                                                                                       | query retry policy                 |
| `apps/front-end/mocks/lib/http.ts`, `mocks/handlers/*.ts`, `tests/mocks-harness.ts`, `tests/api-fetch.test.ts`, `tests/mocks-contract.test.ts`                                 | mocks and their checks             |
| `apps/front-end/eslint.config.mjs`, `next.config.js`                                                                                                                           | lint rules, CSP                    |

## 14. Record (2026-10-16)

Every step is done, uncommitted, on the working tree of branch `http-layer`.

### 14.1 Where the build departs from the spec

| Spec                                                                      | Built                                                                                                                                                                                                           | Why                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1's tolerant reader (both formats) before the S2 flip                    | Skipped: the client reads only the new format                                                                                                                                                                   | It existed for a deployed old bundle meeting a flipped server between two releases (P4-R1). Nothing deployed between the steps, and S9 would have deleted it. Cost: a browser holding a bundle from before this change reads every answer as unreadable until reloaded. |
| S1 item 8 (self-rename on `/me`)                                          | Already done before the phase; the `/:id` mock's own-id 403 was still after the body read, now before it                                                                                                        | Matches the gate's order (P4-D16).                                                                                                                                                                                                                                      |
| `message` on Better Auth prefix answers, added where the mount sends them | Added once, in the exit step (`server/elysia/respond.ts`, `toAuthProblem`, `routing.servedByPrefix`)                                                                                                            | The request hook's 413, route misses and the error hook answer prefix paths before or outside the mount. Bindings under the prefix are excluded by path.                                                                                                                |
| `api()` options `signal`, `captcha`, `narrow`, bookkeeping                | Also `table` on a paged entry (the table state, encoded by `writeTableQuery`); `readEndpoint` / `readPage` for reads through any method                                                                         | A query reads, even through a POST (the delete preview), so it never maps to "saved, not shown".                                                                                                                                                                        |
| `narrow` typed by the entry's output                                      | `z.ZodType<N>`                                                                                                                                                                                                  | Zod's input variance refuses a `.pick()` view typed that way.                                                                                                                                                                                                           |
| Mocks parse lazily with `await body()`                                    | As specified; refusals are thrown, never returned; a contract break escapes the registration wrapper (`ContractBreak`), so a test that ignores the answer still fails                                           | Without that, the wrapper answered the break as an ordinary 500.                                                                                                                                                                                                        |
| `defineEntity` gains the entity's entries                                 | Generic CRUD components type each entry by a structural constraint (`components/dash/shared/entity.ts`); `DataTable` takes `endpoint` and picks server or client paging from it (the `serverSide` prop is gone) | Calls resolve without casts; the feature keeps its exact bodies and rows.                                                                                                                                                                                               |
| S11: keep `RequestFieldsAreTyped` / `ResponseFieldsAreTyped`              | `packages/shared/src/api/fields-are-typed.ts` (type-only, JSON bodies and non-raw answers of every entry); the Better Auth half stays in `response-contract.ts`                                                 | Mutation-checked: an `unknown` field in `updatedAtSchema` fails it.                                                                                                                                                                                                     |
| —                                                                         | `packages/shared/src/api/all.ts` (`ENDPOINTS`): every entry, for the coverage gate and the bindings test; front-end lint refuses a runtime import                                                               | The coverage gate runs in the test runner's parent, which must not load `@/modules`.                                                                                                                                                                                    |
| —                                                                         | `LIBRARY_UPLOAD_FIELD` / `RECORD_UPLOAD_FIELD` in `validation/media.ts`, used by the form schemas, the back-end handlers and the mocks                                                                          | The field names were literals in three places.                                                                                                                                                                                                                          |

### 14.2 Defects found and fixed on the way

- `mocks/handlers/auth.ts` `createAdmin` stored a user without `phoneNumber` / `phoneNumberVerified`, so its detail broke the contract; `MockUser` was typed by the cache's `UserClient` (detail fields optional) and now by the stored fields.
- The users list mock built rows with a nullable `roleId` / `role` the published row never has.
- `PUT /api/dash/users/:id` mock: own-id 403 after the body read (above).
- Back-end harness: the document check ran inside the exit step, so it judged Better Auth refusals before they became problems (`tests/helpers/preload-document-check.ts`). `integration/application-pool-readiness.test.ts` terminated connections without the harness database guard.

### 14.3 Checks (2026-10-16)

- Front end: `bun run lint` clean; `bun run test` 828 pass, 0 fail (from 758 pass, 55 fail at S0); `bun run typecheck` 2.3–4.5 s against 2.65 s at S0 (P4-R5). `bun run find:unused-files` fails on findings that also fail at `HEAD`; none left from this phase.
- `packages/shared`: lint and format clean.
- Back end: see the main plan's Phase 4 record.
- First-load JS (P4-R6), gzip, against a build of `HEAD`: every dashboard page is 5.5 to 16.8 KiB smaller (`/dash/users` 512.1 → 502.5, `/dash/media` 686.5 → 676.7), `_app` 0.1 KiB larger (`jitless`), `/dev/file-upload-lab` 2.8 KiB larger. `bun run build` passes and `prebuild` changed no committed file; the tailwind `@/constants/theme` warning is the same at `HEAD`.
- Deliberate breaks: a mock answer with a wrong field type fails with `PUT /api/dash/users/me/preferences answered outside its contract: data.updatedAt invalid_type`; the zod `Function` probe counts 0 with the app's first import and more than 0 without it.

### 14.4 Owner decisions after the phase (2026-10-16)

- **Current password on the email, phone and password forms: optional.** The back end takes the password or an open re-authentication window, so the forms send it only when typed (`apps/front-end/utils/validation/account.ts`). Left empty with the window closed, the re-auth prompt opens; the captcha that attempt spent makes the form ask for a second submit.
- **Editing your own row from the users page ends back on that page.** The own row links to `/account?from=<list URL with its table state>`; `/users/<own id>/edit` redirects there with the list as `from`. The account page shows a back link, a rename returns automatically, and an email change (which ends every session) saves the account URL for sign-in to return to. The account page gained a sessions tab, which the removed self view of the users page used to show. The self view's own two-factor reset is gone; an owner turns two-factor off from the account page's two-factor tab.
- **Phase 5 (Better Auth plugin calls on the typed client)** was then done the same day, on the owner's go-ahead; its spec and record are in the main plan's Phase 5 section. Its one functional gap, P4-Q6, is closed: `authFetch` sends through `fetchOnline` and reads refusals with `refusalOf`, so every `authRequest` failure carries `Retry-After`; the `authClient.*` calls (sign-in, sign-out, session) still go through better-fetch.
