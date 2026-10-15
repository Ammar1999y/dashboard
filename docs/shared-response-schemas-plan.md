# Plan: shared zod response schemas

Status: **Phases 0 and 1 done** (2026-10-06).

- **What exists:** all 42 table routes are keyed and checked; the hand-written success schemas and every bridge are gone.
- **Checks that pass:** lint, unit, matrix and process tiers, the build, and the integration coverage gate (45 of 47 answers seen, 2 allowlisted).
- **One open item:** the integration tier has timeouts that predate this work (`apps/back-end/reports/review-findings.md` #7).
- **Next:** Phase 2 waits for the front-end commit. Phase 3 starts with its mapping.

Phase 3 back-end and shared parts (steps 2, 3 and 5) are also done (2026-10-06):

- **What exists:**
  - 25 plugin endpoints in `BETTER_AUTH_RESPONSES`, typed through `pluginEndpoint(path, …)`;
  - the runtime check at the Better Auth prefix route;
  - the persisted OAuth result, parsed at write and read;
  - the coverage gate at 76 of 78, with the same 2 allowlisted;
  - the leftover-keyword check, with a permanent test.
- **Deviations, accepted:**
  - the route-gate analyzer recognises `pluginEndpoint`;
  - plugin coverage ids carry no method, because each path has one;
  - the two new components are always published;
  - the 200 descriptions live in `BETTER_AUTH_RESPONSE_DESCRIPTIONS`.
- **Remaining:**
  - Phase 2, together with Phase 3 step 4, the front-end swap. Until then the front-end parses with its own copies, while the server and the document already publish the stricter shapes.
  - The option-id enum on the recovery result (`POST /api/auth/forgot-password/reset`), to be folded into that pass.
  - The front-end agent's instructions are in `docs/shared-response-schemas-front-end-plan.md`.
  - After that pass, two shared follow-ups for the coordinator:
    - delete `ApiEnvelope` from `packages/shared/src/types/api.ts`;
    - add the option-id enum on the recovery result.

Phase 1 deviations, accepted:

- **The coverage gate runs on the integration tier only.** The matrix tier reaches 4 of 47 answers, all also reached by integration; it still enforces the check.
- **`consistency.ts` reports a missing key as a named problem** instead of throwing while it builds the operation.
- **Two more document differences:**
  - the ladder's `exclusiveMinimum: 0`, the client's own rule;
  - `MediaFileDetails.usedBy.items` as `$ref MediaUsage`, whose body is identical.

Known limits:

- A mismatch inside a test's child process fails that test only through the status the child checks.
- The leftover-keyword check has no permanent test yet; its map is private.

Owner decisions taken 2026-10-06:

- **Scope:** the 42 routes in `routes.ts` first, then our own Better Auth plugin endpoints.
- **Front-end binding:** a call keeps building its href and imports the shared schema. There is no typed route-key client.

Reviews: three external reviews on 2026-10-06. Every finding was checked against the code or with a probe on the installed zod 4.6.5 before it was applied. Two findings were narrowed:

- the `Date`-in-any-string limit is kept and documented;
- the MIME "mismatch" was not one.

## Context

A route's success response is described three times today, and nothing checks the three copies against each other:

| Copy                        | Where                                                                                                                                                                                                                                                           | Checked by                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| What the handler returns    | `apiSuccess({ data })` in `app/api/**/handler.ts`; `T` is erased by `Handler` (`lib/http/contract.ts:93`). Back-end wire types such as `MediaFile` (`lib/media/files.ts:230`) are a fourth copy                                                                 | nothing                                        |
| What the document publishes | hand-written JSON Schema: `SUCCESS_DATA_SCHEMAS` (`lib/http/openapi/success-schemas.ts`, 565 lines, 42 keys) plus `components.ts`                                                                                                                               | `consistency.ts` checks only that a key exists |
| What the front-end parses   | hand-written zod in `types/{api,user,permission}.ts`, `lib/media/schemas.ts`, `lib/files/upload.ts`, `lib/account/schemas.ts`, `components/dash/auth/schemas.ts`, `hooks/use-resend-cooldown.ts`, `theme-customizer/preferences.ts`, `lib/auth/reauth-proof.ts` | the front-end's own copy only                  |

No test compares a real response with the document, and `build/openapi.json` is git-ignored, so there is no drift gate either. Request bodies already have the target pattern: `REQUEST_BODIES` in `packages/shared/src/contract.ts`, parsed by the server and typed on the client with `RequestBody<K>`.

The goal is one zod schema per response in `packages/shared`, from which four things follow:

- the front-end parses with it and gets its types from it;
- the back-end's handler output is checked against it at compile time;
- in tests and mock mode, every real answer is also checked against the published contract;
- the document's success schemas are generated from it.

## Design

### One source, two strictness levels

- **The shared schema is the client's parse rule:** exactly what the front-end enforces today, field by field, no stricter and no looser.
  - Clients tolerate what may legitimately change between deploys: new keys, a new MIME type, a changed resend delay.
  - Mock mode keeps working with its `data:` URLs.
- **The published contract adds public structural metadata on top,** set with `.meta()`: `format`, `pattern`, an `enum` or `const` the client does not enforce, `uniqueItems`.
- **The strict check validates real answers against the published contract,** in tests and mock mode, never in production. It is two pure-zod steps:
  1. The shared parse catches refinements.
  2. `z.fromJSONSchema` over the shared schema's own conversion catches everything published. `additionalProperties: false` rejects extra keys at any depth, and `oneOf` rejects a body that matches two branches.
  - **Probed:**
    - Rejected: an extra nested key, a bad UUID, a bad date, an enum or `const` that exists only as metadata, duplicate ids, a body matching both union branches.
    - Accepted: a valid body, and `data:` URLs.
  - **No new dependency.** `fromJSONSchema` is marked semi-experimental, but zod is pinned, and the check's own test (Phase 1) catches a behaviour change on upgrade.

### Where things live

- **`packages/shared/src/responses/<domain>.ts`:** the schemas, as named exports, split into `common`, `auth`, `users`, `permissions` and `media`. The front-end imports per domain, so a page ships only its own schemas.
- **`packages/shared/src/response-contract.ts`:**
  - `RESPONSE_DATA`, keyed `'METHOD /api/path/:id'` like `REQUEST_BODIES`, plus `ResponseRoute` and `ResponseData<K>`.
  - The paginated-route set, moved from `PAGINATED_SUCCESS_ROUTES` in `lib/http/openapi/route-tables.ts`.
  - The envelope builder: `success: true`, `message`, `data`, and `meta`, which is required on paginated routes.
  - `responseIssues(key, body)`: the strict check, with validators built lazily and cached. It is the single implementation, shared by the back-end wrapper and the front-end mocks.
  - A separate file because `contract.ts` is imported at runtime by `contact-form.tsx` and `second-factor/options.ts`.
  - Front-end app code imports it **type-only**, enforced by `@typescript-eslint/no-restricted-imports` with `allowTypeImports` (installed 8.70.0) under its own rule name. `mocks/**` is exempt.

### Schema rules

- **`data` only in the registry.** The envelope comes from the builder. The front-end transport (`envelopeSchema` in `lib/api/fetch.ts`) keeps its own envelope check.
- **Plain `z.object`.** Parsing drops unknown keys. Converted with `io: 'output'`, it publishes `additionalProperties: false`, as today.
- **Format helpers** live in `responses/common.ts`: `uuid()`, `dateTime()`, `uri()`, `email()`.
  - They are factories, so each field is its own instance.
  - Each one is `z.string()` plus format metadata (`pattern: UUID_V7_PATTERN` for ids), unless the front-end enforces more today.
- **Existing front-end rules are preserved:**
  - the OAuth start `url` is http(s)-only, because it is passed to `location.assign` (`components/dash/auth/schemas.ts:63`, `google-start.tsx:54`);
  - `roleId` is a UUIDv7 or the custom-role value;
  - enums the front-end already parses with `z.enum` (`FILE_KINDS`, `BUCKET_TYPES`, `FILE_TRANSITIONS`, …).
- **Lenient rules stay lenient, with the strict value as metadata:**
  - `mimeType` is `z.string().meta({ enum: KNOWN_MIME_TYPES })`;
  - `nextAllowedIn` is `z.number().positive()`, plus `const 30` (anonymous sends) or `minimum 30` (the ladder) as metadata;
  - the server's exactness comes from types (`as const`, mismatch 2).
- **A shared component takes the most lenient rule any of its consumers applies today.** A stricter consumer adds its rule locally with `.extend()`, the way it adds a `.transform()`.
  - Example: `MediaFile.url` is a plain string for the listing (`lib/media/schemas.ts:12`, "a listing must not fail on it"), and the upload answer extends it with `.min(1)`.
  - In the document, the upload element is mapped to `$ref MediaFile`, so the document is unchanged. The shared parse and the strict check still enforce the non-empty url.
- **A registry entry always describes the full shape.** The strict check derives `additionalProperties: false` from it, so a subset would refuse the server's real answer.
  - A front-end call that reads only some fields narrows locally with `.pick()`, which keeps today's tolerance for the fields it ignores. Example: the upload call reads 6 of `MediaFile`'s 16 fields (`lib/files/upload.ts:16`).
- **Unions:**
  - `z.discriminatedUnion` where a literal discriminant exists (`reset`);
  - `z.xor` otherwise (contact change, media listing), which publishes `oneOf` as today and rejects a two-branch body on both sides;
  - the media listing members are also exported one by one, because the front-end picks the member by `scope`.
- **Invariants:**
  - Unique id arrays (`revoked`, `deleted`, `pending`, `visibilities`) carry `uniqueItems` metadata and are enforced by the strict check.
  - The user detail's session trio (all three present or none) is a shared `.refine()`, because `fromJSONSchema` throws on `dependentRequired`. The document's `dependentRequired` is added by the back-end converter.
  - Trap: zod throws at load on `.pick()`, `.omit()` and `.partial()` of a refined object (probed; `.extend()` works). Export the unrefined base beside the refined schema.
- **No prose in shared.** `GET /openapi.json` is gated behind dashboard access (`lib/http/openapi/route.ts:102`), but the front-end bundle is public. Descriptions stay on the back-end.
- **Never reuse a request schema or field that preprocesses, transforms or carries `.meta()`.**
  - A sanitizer would rewrite response data on parse.
  - Request metadata would leak into responses: `idStringSchema` (`validation/rules.ts:166`) publishes a whitespace-tolerant input pattern and request prose. The folder name, display name and email fields have the same problem.
  - Reuse their constants and enums instead.
  - The preferences document is the case to check: the front-end today wraps `preferencesSchema.shape` in a plain object.
- **Constants come from shared.** `OTP_BASE_RESEND_DELAY_S` (30, now in `lib/otp/throttle.ts`) moves to shared. The mocks' copies of it (`mocks/lib/otp.ts:44`, `mocks/handlers/otp-flows.ts:81`) then import it.
- **Pagination meta is defined once.** A shared `paginationMetaSchema` replaces:
  - the `PaginationMeta` interface;
  - `PAGINATION_META_SCHEMA` in `components.ts`;
  - the `meta` shape in the front-end `envelopeSchema`.
- **No `z.unknown()` or `z.any()` field** without a named exemption. Reuse the request side's `UnknownFieldsOf` assertion (`packages/shared/src/contract.ts:197`) for the response registry.

### Generating the document (back-end)

`lib/http/openapi/success-schemas.ts` becomes a small converter. It extends the existing `toJsonSchema` (`json-schema.ts:22`) with an output mode, instead of adding a second converter.

- **Per-route conversion with zod's default metadata,** so the shared `format`/`pattern` metadata survives. Passing a custom `metadata` registry drops it (both reviewers probed this, and so did I).
- **One `override`** does two jobs, both keyed by schema instance:
  - it attaches the back-end `Map` of prose and document-only keywords (`description`, `dependentRequired`);
  - it replaces any non-root component instance (`MediaFile`, `MediaFileDetails`, `MediaFolder`, `MediaFolderHit`, `MediaUsage`) with `$ref: '#/components/schemas/<name>'`.
- **Components and routes:**
  - Components are converted once, as roots, into `components.schemas`.
  - A route whose data _is_ a component gets the `$ref` directly.
  - The names are unchanged; `openapi-contract.test.ts:1029` pins them.
  - Probed: formats, prose and nested or repeated `$ref`s come out right, with no registry ids, no `$defs` hoisting and no ref rewriting.
- **The envelope** is converted from the shared builder too, replacing `successEnvelopeSchema` in `envelope.ts`.
- **Consumers to repoint:** `document.ts:122` (it spreads `COMPONENT_SCHEMAS`) and `schemaCollisionProblems` (`consistency.ts:218`) read the generated components.
- **Leftover check:** the `override` records which map entries it used, and `consistency.ts` reports an unused entry, as it already does for every route-keyed table.
- **Pattern divergence, deliberate:** request-side keywords are patched per route key (`request-bodies.ts:262`), while this map is keyed per schema instance. Components are shared across routes, and per-route patches would repeat their prose.
- **Failure at container start:** `unrepresentable: 'throw'` also runs there (`Dockerfile:95`). The CI build step and `openapi-contract.test.ts` must convert every entry first.
- **`components.ts` keeps only non-response helpers:** id, date and nullable helpers for path parameters, request bodies and `better-auth.ts`, plus `ErrorEnvelope` and the captcha header.

### Compile-time check (back-end)

- **The route key becomes the first argument of the two existing wrappers.** All 42 envelope handlers use one of them: 36 `withApiErrors`, 6 `withTimingFloor`. The call becomes `export const GET = withApiErrors('GET /api/dash/users', msg, async (ctx) => …)`.
  - The key types the handler's return through context, so a wrong field is reported inside the handler file and literals such as `verified: true` stay literal.
  - The wrapped handler carries its key. `consistency.ts` checks that each `routes.ts` row's handler key equals the row's `method` and `path`, so a mis-wired row fails the unit tests.
  - This replaces the plan's earlier union over the `routes.ts` rows. One reviewer modelled that union in `tsc`: its errors named the wrong route.
- **`lib/http/contract.ts`:**
  - Separate envelope success, error and raw output types. An envelope handler cannot return `apiRaw` (today `HandlerOutput<never>` fits any route).
  - A paginated key requires `meta`.
  - `ServerValue<T> = T extends string ? (string extends T ? T | Date : T) : …`, recursive. A `Date` is accepted only where the wire type is plain `string`, so literal and enum fields keep their check.
- **`lib/http/response.ts`:**
  - `apiSuccess` overloads: with data → `T`; without → `null`.
  - `withApiErrors` and `handleApiError` keep the handler's full output union.
  - `withTimingFloor` (`timing-floor.ts`) does the same.
- **Response-only back-end types derive from the shared schemas through `ServerValue`,** so a mismatch shows in the mapper (`toMediaFile`). That covers `MediaFile` (`lib/media/files.ts:230`), `FolderHit` and `FolderDeleteOutcome` (`lib/media/folders.ts:37-51`). Internal models such as `OfferedOption` stay.
- **Known limit:** a `Date` can stand in for a plain-`string` field such as a name. It still goes out as a string; in a formatted field (a UUID), the strict check rejects it.

### Runtime check (tests and mock mode; never production)

- **Back-end:**
  - One wrapper, applied where the registered table is built (`toRegisteredRoutes`, `lib/http/route-manifest.ts`).
  - For each 2xx envelope route, it serialises the body and runs `responseIssues(key, body)`.
  - It also checks the status: 201 for the `CREATED_ROUTES`, otherwise 200.
  - It logs the route key and each issue's path and code, never values.
- **What happens on a mismatch depends on the mode:**
  - **Under the test runner,** the check answers 500 and records the mismatch. A dedicated variable that `tests/helpers/run.ts` sets for every tier switches this on.
    - Only the unit tier runs as `test`. The integration, process and matrix tiers run as `development` (`run.ts:132`, `:156`, `:170`, passed to child processes at `:340`).
  - **Failing the right test:** an `afterEach` in the test preload fails the test that caused a recorded mismatch. Otherwise a test that ignores the response would pass on a 500; there are 21 such calls, for example `two-factor-management.test.ts:703`.
  - **Development without the variable:** log only. A write has already committed, and a 500 would invite a duplicate retry.
  - **Production:** off, and the variable is ignored there.
- **Coverage:**
  - The wrapper also records each route key it checked and, for a union, the member that matched.
  - After the integration and matrix tiers, the runner lists unseen keys and members, and fails on any not in an allowlist.
  - Each allowlist entry needs a reason. For example, `autoVerified` is dormant while `OTP_AUTO_VERIFY` is the hard-coded `false` (`packages/shared/src/config.ts:80`).
  - Known gap to close with a test: no test gets a 2xx from `change-phone` or `change-phone/verify`. CI enables only the email channel (`ci.yml:247`). Add a child-process test with `email,sms`, the way `_contact-change-strand-child.ts` does.
- **Front-end mocks:**
  - The same `responseIssues` runs in the committed mock wrapper (`withApiErrors` in `mocks/lib/http.ts:135`), which wraps every mock handler (`mocks/handlers/index.ts:47`).
  - The wrapper knows each handler's method and `:id` path, so it covers every answer, uploads included.
  - Under `bun test` it throws; in browser mock mode it logs.
  - Mocks for the pending entities have no key and are skipped.
  - This replaces the plan's earlier harness-only check. `apps/front-end/tests/**` is git-ignored (`.gitignore:55`), and its helper missed direct `fetch` uploads.

### Front-end (same change set as the back-end, per the shared-changes rule)

- **Precondition:** the front-end's in-flight work is committed by its owner first.
  - 151 uncommitted changes, including several Phase 2 targets: `components/dash/auth/schemas.ts` and `theme-customizer/preferences.ts` are untracked; `types/*.ts` and `lib/files/upload.ts` are modified.
  - Until then, "someone else's diff" can't be told apart with git.
- **Transport:** `lib/api/*` is unchanged. Each call site swaps its local schema for the shared one.
  - The inventory covers **calls**, not only schema definitions. That includes calls that pass no schema today: dev sign-up (`sign-up.tsx:33`) gets `createdIdSchema`.
- **Skew diagnostics:** `mutation.ts:142` and `fetch.ts:180` log the href plus each issue's path and code, never values. Today one logs a fixed line and the other logs nothing.
- **`types/*.ts`** keeps its type names as aliases derived from the shared schemas, so the roughly 30 importing files don't move.
- **Pending entities** (categories, projects, sections, settings) stay front-end-only and mock-only. They reuse the shared building blocks (`createdIdSchema`, `updatedAtSchema`).

## Phases

### Phase 0: spike (gate before the rest)

1. **Write the shared schemas** for these routes:
   - `PUT /api/dash/users/:id` and `GET /api/dash/media` (xor);
   - `POST /api/dash/media/files` (data is a component);
   - `POST /api/upload/file` (an array of one, which extends `url`);
   - the three routes that share the OTP-sent schema;
   - `POST /api/auth/otp/verify` (literal);
   - `POST /api/auth/forgot-password/reset` (discriminated);
   - `POST /api/dash/users/me/change-email` (xor);
   - one paginated list.
2. **Key their wrappers** and type them.
3. **The gate holds when:**
   - a wrong field is a compile error inside the handler file;
   - a mis-wired row fails `consistency.ts`;
   - the literal and union outcomes compile, and a wrong discriminator fails;
   - a wrong enum value, or a `Date` in an enum field, fails `bun check`;
   - a paginated route without `meta` fails `bun check`;
   - an envelope route returning `apiRaw` fails `bun check`;
   - `MediaFile.id` keeps `format` and `pattern` in the document, and every emitted `$ref` resolves;
   - the strict check rejects the probe's negative cases and accepts the positive ones;
   - the generated schemas equal today's document, apart from the expected differences listed under Verification;
   - `bun run typecheck` time on the back-end does not grow noticeably (measure it).

### Phase 1: shared + back-end, table routes

1. Add `responses/*.ts` and `response-contract.ts`, covering every key in today's `SUCCESS_DATA_SCHEMAS` under the schema rules.
2. Move `OTP_BASE_RESEND_DELAY_S` and the paginated-route set to shared. Add `paginationMetaSchema` and derive `PaginationMeta` from it.
3. Rewrite `success-schemas.ts` as the converter, with the prose map, the component overrides, the converted envelope and the leftover check. Trim `components.ts`. Repoint `envelope.ts`, `document.ts`, `consistency.ts` and `route-operations.ts`.
4. Key the 42 wrappers. Add the contract typing and the derived back-end types. Settle the mismatches below.
5. Add the runtime wrapper, its runner variable, the `afterEach` failure and the coverage report. Add its one test, covering:
   - every probe case;
   - a wrong status;
   - development logs only;
   - production skips the check.
6. Add `@ts-expect-error` cases:
   - a wrong data shape;
   - `apiRaw` from an envelope route;
   - a paginated route without `meta`;
   - a wrong enum value.
7. Add the change-phone 2xx test.

### Phase 2: front-end swap

1. Check the precondition (front-end committed).
2. Replace each real-route response schema with the shared one, and give the schema-less calls theirs.
   - Keep local `.transform()`s and stricter local `.extend()`s.
   - Delete the front-end copies.
3. Derive the `types/*.ts` aliases. Point the envelope's `meta` at `paginationMetaSchema`.
4. Add the mock-wrapper check, the two diagnostic log lines and the type-only lint rule. Point the mocks' resend literals at the shared constant.
5. **Real routes only.** Our plugin endpoints wait for Phase 3; Better Auth library endpoints are out of scope.

### Phase 3: our Better Auth plugin endpoints

1. **Map first.** These are the roughly 25 `createAuthEndpoint` routes: reauth, two-factor, passkey grant and delete, trusted devices, passwordless, OAuth. Inventory calls, including those without a schema today.
   - **Bodies are not uniform.** Two have no `data` (`/two-factor/backup-codes/acknowledge`, `/two-factor/disable`), and several answer either the plugin envelope or the two-factor challenge. Decide per endpoint.
   - **Carry over every front-end constraint,** the OAuth start URL's http(s) rule first.
   - **WebAuthn options** (`/reauth/passkey/options`, `/two-factor/passkey/options`) get a complete shared schema.
     - Today both calls pass no schema and parse later with `z.looseObject({ challenge })` (`lib/auth/passkey.ts:91`), which a plain object would strip to `challenge` alone.
     - Check it against the library's exported options type.
     - Give externally extensible fields (`extensions`) a named exemption from the plain-object and no-`unknown` rules.
2. **Shared:**
   - A `BETTER_AUTH_RESPONSES` registry keyed by sub-path, the twin of `BETTER_AUTH_BODIES`.
   - The two-factor challenge as one shared schema, including `twoFactorMethods` (`lib/auth/two-factor/issue.ts:290`), which today's front-end parser omits.
3. **Back-end:**
   - Document these responses in the document builder (`lib/http/openapi/better-auth.ts`), not in plugin metadata. Better Call's metadata type rejects wide JSON (`lib/auth/plugin-openapi.ts:12-13`).
   - Replace the hand-written option and challenge schemas (`better-auth.ts:188`) and the appended challenge alternatives (`:364-380`), so each union is emitted once.
   - Type `ctx.json` bodies through one helper.
   - Add the runtime check at the Better Auth prefix route in `app.ts`, next to `localiseAuthError`.
   - Reuse the shared OAuth outcome at the persisted-result boundary (`lib/auth/oauth/plugin.ts:261`), keeping its failure marker and one-shot behaviour.
4. **Front-end:** swap the schemas in `lib/account/schemas.ts`, `components/dash/auth/schemas.ts`, `lib/auth/reauth-proof.ts` and `lib/auth/passkey.ts` that describe our endpoints.

**Mapping done (2026-10-06).** 27 `createAuthEndpoint` routes: 25 with our own bodies, and 2 that pass the library's verifier body through. Decisions taken:

1. **The two pass-through verifiers** (`verify-totp`, `verify-backup-code`) stay out of the registry. The back-end override keeps documenting them, renamed `LIBRARY_VERIFIER_RESPONSES`, because the shared registry takes the name `BETTER_AUTH_RESPONSES`.
2. **A 200 carrying `twoFactorRedirect` on any auth path** is checked against the shared challenge schema. That includes our hook's body on the library's `/sign-in/email`. Other library bodies stay unchecked.
3. **WebAuthn `extensions`** mirrors the library's closed type, `PublicKeyCredentialRequestOptionsJSON` in simplewebauthn 13.3.x, which has four optional keys. This replaces the planned opaque exemption: an open record cannot type-check against the library's interface, and the server never sets `extensions`. The type checker checks the schema against the library's type in both directions.
4. **The challenge requires `twoFactorMethods`.** The server always sends it, and a registry entry describes the full shape. This is a deliberate client tightening.
5. **Each entry is the whole 2xx body.** It states `message` exactly as the endpoint sends it. The two no-data bodies (`backup-codes/acknowledge`, `two-factor/disable`) have no `data` key.
   - Client tightening is limited to fields the server always sends; the two `plain` paths are where it shows.
6. **Server guarantees published as metadata:**
   - `userVerification` as `enum: ['required']` (not `const`, which the strict check silently ignores on top of an enum);
   - `allowCredentials` with `minItems: 1`;
   - http(s) and `otpauth://totp/` patterns on the OAuth URL and `totpURI`;
   - the option-id enum on `id`, `defaultMethod` and `removedMethod`. `optionId` (`lib/auth/two-factor/methods.ts:59`) moves to shared, so the list derives from one implementation.
   - The backup-code pattern and count are skipped.
7. **The persisted OAuth result** is parsed when it is written (in `completeResponse`) as well as when it is read. It uses the shared session and challenge bodies plus a back-end-only `{ success: false }` marker. Reads stay one-shot.
8. **`ctx.json` typing:** a keyed endpoint wrapper, proven first on three endpoints, including the OAuth callback's redirect branch and a no-data body. If Better Call's types refuse it, fall back to `satisfies` on each `ctx.json`.
9. **The document gains two components,** `TwoFactorChallenge` and `PasskeyRequestOptions`. The hand-written schemas (`better-auth.ts:188-246`), `envelopeResponse` and every plugin's `metadata.openapi` are deleted. Only `/sign-in/email` keeps an appended alternative, because its other branch is the library's body.
10. **Coverage:** the callback's 302 counts as its own member. Each id a test doesn't reach gets a test, or an allowlist entry with its reason.
11. **Verify:**
    - run `bun run test:matrix`, and confirm its children receive the runner variable;
    - extend the document diff to the Better Auth paths.

## Mismatches the typing will surface (settle in Phase 1)

Rule: narrow the server type to what the code already guarantees, or widen the schema where the server really sends more. Never add an unchecked cast.

| #   | Mismatch                                                                                                   | Settle by                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Every date is a `Date` in the handler and a `string` on the wire                                           | `ServerValue<T>` (Design above)                                                                                                                                                                                           |
| 2   | `ANONYMOUS_SEND_DATA` is typed `{ nextAllowedIn: number }`; the document says `const 30`                   | Optional hardening (`as const`). The client rule stays a positive number and `const 30` is metadata, so the type checker no longer requires it; the strict check enforces it                                              |
| 3   | `OfferedOption.method` includes `passkey`; the recovery-option enum does not                               | Optional hardening (a type predicate on `recoveryOptions`, `lib/auth/two-factor/methods.ts:239`). The client keeps today's `z.enum(TWO_FACTOR_METHODS)` and the 3-value list is metadata, which the strict check enforces |
| 4   | Users list: `publicRoleFields` returns a nullable `roleId`/`role`; the document says non-null (inner join) | type `publicRoleFields` so a non-null role gives a non-null result; select the non-null join column for the list                                                                                                          |
| 5   | `PUT /api/dash/media/files/:id`: `unfiledAt` is `Date \| null`; the document says `null`                   | confirm `filedInto` clears it, then return the literal `null`, as the bulk move route already does                                                                                                                        |
| 6   | Folder search and `renameSelf` rows are `any` (raw SQL)                                                    | parse each raw row as `unknown` with a back-end row schema at the mapping, per CLAUDE.md's types rule. Typing `execute<T>` alone does not check columns (reviewer probe)                                                  |

`mimeType` is **not** a mismatch. `KNOWN_MIME_TYPES` is typed `readonly string[]` (`packages/shared/src/validation/media-types.ts:68`), so the type is `string` either way. Its enum is now metadata, enforced by the strict check.

## Open choices for the owner

- **Type the mock answers per route.** The front-end's only CI check is `bun check`; front-end tests run only locally.
  - Benefit: mock drift fails CI.
  - Cost: every mock answer site uses a keyed `ok()`.
  - Not in the plan unless you ask.
- **Move the error envelope into shared.** It is described three times today: `components.ts:65`, the front-end transport, and the mocks' `fail()`.
  - Benefit: the runtime check could cover error bodies too.
  - Cost: a separate change. Keep `code` a plain string.

## Not doing

- **Typed route-key client:** the owner chose per-call schemas.
- **Better Auth library endpoints** (`sign-in/email`, `get-session`, passkey registration and listing, `verify-totp`, `verify-backup-code`): they are the library's shapes.
- **Dates as `Date` objects** (zod codecs): that would change every front-end consumer and cache patch.
- **A literal `KnownMimeType` through the upload pipeline:** the strict check covers the enum.
- **A committed `openapi.json` drift gate:** separate decision.
- **A deploy-order rule in `reports/coolify-deployment.md`:** values that can change between deploys are lenient on the client now. The remaining risk, a new value of an enum the client already enforces, exists today and is not added here.

## Verification

Each phase ends with:

- **Lint:** `bun run lint` in `packages/shared`, `apps/back-end` and `apps/front-end`.
- **Back-end:**
  - `bun run test` (unit);
  - `bun run test:integration` and `bun run test:matrix` through the real runner, which sets the variable and writes the coverage report;
  - `bun run build`.
- **Document diff,** in Phase 1, before `success-schemas.ts` is deleted: generate both documents into a scratch folder and diff every `2xx` response and `components.schemas`. Expected differences:
  - zod adds `type` next to `const`, and safe-integer bounds on integers;
  - the reset outcome changes from `anyOf` to `oneOf` (discriminated);
  - a nullable field with constraints uses `anyOf` where today's document uses `type: [x, 'null']` (`width`, `height`, the cursor);
  - permission actions stay an object of optional booleans (not `partialRecord`, which would publish `propertyNames`);
  - accepted in Phase 0, because they publish rules clients already enforce or are equivalent spellings:
    - `exclusiveMinimum: 0` on the anonymous sends' `nextAllowedIn`;
    - `minLength: 1` on the reset `grant`;
    - `type: ['string', 'null']` for the reset `defaultMethod`;
  - in Phase 1, the ladder's `nextAllowedIn` needs `.meta({ type: 'integer', minimum: 30 })`, or it would change from integer to number.
  - Any other difference is a regression to fix or a deliberate change to list.
- **Deliberate-break probes,** each reverted after it fails as expected:
  - the Phase 0 type cases;
  - a nested extra key, a bad UUID and a missing `meta`, each failing an integration test through the runner;
  - a removed registry key and a mis-wired row failing `consistency.ts`;
  - a wrong mock answer failing `bun test tests` in `apps/front-end`.
- **Front-end:** `bun test tests`, plus `bun run build` once after Phase 2, to check the browser and server module graph and the bundle size.
- **Afterwards:** update the project memory note on front-end ↔ back-end sync, and delete scratch probes.

## Risks

- **`fromJSONSchema` is semi-experimental.** Zod is pinned (4.6.5); the check's own test runs every probe case, so an upgrade that changes it fails there first.
- **Coverage allowlist creep.** Every entry needs a reason, and dormant branches are listed explicitly.
- **The front-end is edited in parallel.** Phase 2 waits for the front-end commit, and then touches only the schema files, their imports, the mock wrapper and two log lines.
