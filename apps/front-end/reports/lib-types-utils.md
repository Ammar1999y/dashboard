# `lib/`, `types/`, `utils/` — refactor report

Area: every file under `lib/`, `types/` and `utils/`, their ecosystem (mocks, file handling, error messages), and the shared/back-end code they copied or now share.

Two passes:

- **2026-10-01:** five read-only reviewers mapped the area, an independent reviewer attacked the diff, then fixes.
- **2026-10-02:** five new reviewers audited the result against the brief, five workers fixed the verified findings, and a final pass converged the rest. The orchestrator checked each reviewer's evidence against the code before counting it as a finding.

Owner decisions applied:

- The tested shared/back-end logic wins. Where the front-end or the mocks needed back-end logic, the pure part **moved** into `@app/shared` and the back-end imports it (move/import-only edits, behaviour unchanged).
- Uploads follow the back-end contract.
- The environment decides mock mode.
- Pages with no back-end follow the users/roles contract.

## Layout now

| Root                    | Holds                                                                                                                                                                                                                                                            | Enforced (lint)                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `lib/api/`              | `client.ts` (`api()`, the one typed call and parser), `fetch.ts` (`refusalOf`, the one problem reader; `fetchOnline`, the one offline mapping; `retryAfterMs`), `mutation.ts`, `query.ts`, `query-cache.ts`                                                      | may not import `components/`, `mocks/`         |
| `lib/files/`            | `accept.ts` (`resolveFileType`, accept maps from `@app/shared/validation/media-types`), `prepare.ts` (`prepareFile`, `FileError` with a `reason`), `upload.ts` (`uploadFile`, the server's `MediaFile`), `download.ts` (`downloadBlob`/`openBlob`/`downloadUrl`) | same                                           |
| `lib/`                  | `env.js`, `auth/` (client, `use-session.ts`), `zod-locale.ts`, `toast-error.ts`, `dialogs.ts`, `history.ts`, `motion.ts`, `data-table/query.ts`, `utils.ts`                                                                                                      | same                                           |
| `utils/`                | pure functions: `validation/*`, `color-converter.ts`, `generate-id.ts`, `number.ts`, `format-bytes.ts`, `validate-redirect-path.ts`                                                                                                                              | may not import `lib/`, `components/`, `mocks/` |
| `types/`                | API payloads, derived from schemas (`z.output<…> & StoredRow`)                                                                                                                                                                                                   | may not import `components/`, `lib/`, `mocks/` |
| `constants/messages.ts` | every message the client writes itself, `MSG_*` like shared                                                                                                                                                                                                      | same as `types/`                               |

Moved into `@app/shared` in the second pass (back-end now imports these directly):

| Module                                                                                                         | What                                                                                                                                   | Used by                                                |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `data-table/filter-rules.ts`, `column-specs.ts`, `filterable-columns.ts`, `parsers.ts` (`effectiveSearchTerm`) | filter validation, value and bound rules, column specs, quick-search rule                                                              | back-end params, mock `queryTable`, client `queryRows` |
| `permissions/matrix.ts`, `scope.ts`, `roles.ts`                                                                | matrix normalisation, action scope (`own`), grant-scope checks, `custom-` role-name rule                                               | back-end checker, mock permission gate                 |
| `images/svg-refusal.ts`, `optimizeSvg`, `SVG_MIME_TYPE`                                                        | SVG reason→message mapping, the optimize step with each app's SVGO entry                                                               | back-end `validateSvgUpload`, `prepareFile`            |
| `filename.ts`                                                                                                  | `sanitizeFilename`                                                                                                                     | back-end upload, `prepareFile`, mock upload            |
| `validation/rules.ts`                                                                                          | `localizedIssueMessage`, `PASSWORD_RULES`/`checkPasswordRules`, `nullableIdSchema`, `getColorSchema({ alpha })`                        | server and form messages, password meter, forms        |
| `api-messages.ts`, `media-messages.ts`                                                                         | messages both sides show (`MSG_LOGIN_SUCCESS`, `MSG_CANNOT_EDIT_OWN_ROLE`, `MSG_CUSTOM_ROLE_PREFIX_FORBIDDEN`, upload admission texts) | both apps                                              |

No client-visible back-end text changed: the moved messages were compared value by value with HEAD.

## Findings fixed

### Shared and back-end sync

- **Pass 1: stale copies of shared** (`CustomError`, `config`, `time`, `utils`, validation schemas, the SVGO config that corrupted SVGs) were deleted in favour of shared.
- **Mock 422s now read like the server's.** The global Arabic zod locale had produced different wording, with no field name. `lib/zod-locale.ts` installs the shared `localizedIssueMessage`, so form, mock and server give the same text.
- **The password meter copied the rule and disagreed with it.** It showed full strength for a 129-character password and missed NFKC folding. It now runs the shared `checkPasswordRules`.
- **Front-end-only rule removed.** `optionalIdSchema` was a separate front-end rule and now wraps the shared `nullableIdSchema`. Unused shared schemas (`fileUploadSchema`, `datePreprocess`) were deleted.
- **`trimed` and `getColorSchema` coerced non-strings to `''`** (`link: 123` was accepted). They now pass non-strings through to the schema.

### Transport and errors

- **A committed write could be submitted again.** Two cases:
  - Pass 1: the cache update failed after the save.
  - Pass 2: a 2xx arrived with an unreadable body.

  Both now surface the committed code, and forms treat it as saved.

- **`Retry-After` is kept on the error.** Query retries honour it, and a wait over the cap fails at once. `gcTime` (20 min) was shorter than `staleTime` (30 min), so a revisit was a cold load; both are now 30 min.
- **A failed session check showed sign-in, as if signed out.** The layout and the sign-in page now show `ErrorState` with retry. A 401 still means signed out.
- **One offline mapping.** better-auth's raw `TypeError` showed a generic message; the auth client now goes through `fetchOnline` (`customFetchImpl`).
- **Non-envelope failures use the shared texts:**
  - 413 → `MSG_BODY_TOO_LARGE`
  - 429 → `MSG_TOO_MANY_REQUESTS`
  - 502, 503, 504 → `MSG_SERVICE_UNAVAILABLE`
- **Failed loads no longer read as "no results"** in the form, section and font comboboxes: an inline error with retry. The font list is validated with zod.
- **Updates now refresh server-paged tables:** `cacheUpdated` marks them stale, as `cacheCreated` does.
- **A two-factor account gets a clear message** instead of "try again".
- **`lib/env.js` throws on an API URL with a path.** Before, the path was dropped silently. The mock public URL also matches the port `start:mock` uses.
- **`/dash/sign-up` returns 404 in a real production build.** Its endpoint exists only in development and in the mocks.

### Files and uploads

- **Pass 1:** one pipeline (`prepareFile` → `uploadFile`) on the real `POST /api/upload/file` contract; per-kind limits; the compressed output is checked against the server's ceiling.
- **Animated PNG/WebP are refused,** as the server does. Before, the canvas re-encode silently flattened them to one frame. The format is read from the bytes, not the declared type.
- **One resolved type per file:**
  - The declared type is used, normalised the server's way, with the extension as the fallback.
  - The file is re-wrapped with that type.
  - An empty-typed PNG is no longer refused as "not an image", an empty-typed `.docx` is sent typed, and a PNG named `.svg` no longer goes to the sanitizer.
- **SVG refusals read the same on client and server** (shared mapping), and the optimize step is shared.
- **No double compression:** a file `prepareFile` produced is not re-compressed by `uploadFile`.
- **Contract restored.** `FileUpload` accepts stored `MediaFile`s again, with URL preview and download.
- **Per-kind limits and help text:**
  - Photos 5 MB, SVG 0.4 MB, documents 10 MB. The UI used to show 5 MB for SVG.
  - One "too large" message.
  - "Not allowed here" for a media type the editor has disabled.
- **One object-URL helper set,** with a delayed release. The export print path leaked the URL before.
- **A pre-aborted compression hung forever;** the signal is now checked before each attempt.

### Validation and types

- **Update schemas for categories, projects and sections are strict, and `isActive` is required.** Before, an omitted `isActive` reactivated a row. Every edit form now uses a body schema plus `record.id`, as users do.
- **Optional texts accept `null`/absent,** following the role `description` pattern.
- **List rows must be filled in and unique.** Blank rows are refused, as are duplicate `id`s and keys; `order` is derived from position. Settings has no body `id`; it is a singleton.
- **Return paths keep a literal `%` in the query.** Strict decoding stays on the path part: 24 cases in `tests/redirect-path.test.ts`.
- **Response types are derived from the schemas.** One `RoleSummary`; `PagePermission` is derived from the shared schema.
- **`colorFormatter` and `hexToRgb` fail clearly** instead of returning the input or black, and keep alpha. `primaryColor` refuses alpha.
- **Duplicates removed:** `numberOr`, `hslToHex`, the key rule (now `slugSchema`), the social/contact schema and row factory, the slug tooltip, `FONT_SCALE_RANGE`.
- **Dates and wording:** the settings date uses the app locale and `BUSINESS_TIMEZONE`, and category texts say "التصنيف".

### Data-table query (client tables and the mock)

`queryRows`/`queryTable` now apply the server's semantics, from shared code:

- **Ranges:** one-sided and reversed ranges work, and an empty range is skipped. One-sided ranges used to return nothing, and the filter UI sends them by design.
- **Empty cells behave like SQL NULL.**
- **Case:** text `eq`/`ne`/`inArray` compare exactly; only the substring operators ignore case.
- **Sorting:** NULLS LAST ascending, NULLS FIRST descending, with an `id desc` tie-breaker.
- **Search:** one quick-search rule, `effectiveSearchTerm`.
- **422s:** the mock answers the server's 422 for an unknown key, a repeated key, a bad page, an unknown column and a short filter. The table shows it in its error state.

### Mocks

- **Inactive roles are enforced.** A deactivated role, or a missing one, is refused at sign-in and on every request, as the server does. Before, a third of the seeded users kept full access.
- **Grant authority follows the server:**
  - custom-role assignment needs `permissions.create`;
  - you can't grant more than you hold;
  - you can't edit your own role;
  - deactivating needs `delete`;
  - an outranking role → 404;
  - the `custom-` name prefix is refused;
  - switching to custom with no permissions is refused;
  - an unknown or inactive role → 404.
- **Own-record permissions** (`viewOwn`/`editOwn`/`deleteOwn`) filter on `createdBy`.
- **Phones:** seeded in the stored format, so a name edit no longer un-verifies the phone, and they are unique (409).
- **Content entities:** duplicate slug → 409; unknown category → 404; deleting a record in use → 400; settings save → 200.
- **Status order matches the server:** malformed id → 422, malformed JSON → 400, body checked before existence. Role names are unique case-sensitively. The sign-in error body is `{ code, message }`.
- **Thrown handler errors answer the API envelope.** Upload admission follows the server's order and messages.
- **Mock sign-in works offline:** no Turnstile script in mock mode.
- **Missing `crypto.randomUUID`** (Chrome 88–91, Safari 15.0–15.3) shows the clear mock-start error, where before every call failed as offline.
- **Seeds:** the settings seed persists, seed ids can't collide, and keys from older seed versions are removed.
- **A real build contains no mock code** (`MockCaptcha` was the last piece kept in by `memo` side effects).

## Verification (2026-10-02)

- **Front-end:** `bun run lint` passes (tsc, ESLint with the import-direction rules, CSS support). `bun test tests`: 236 pass, 0 fail, across 18 files. New tests cover:
  - `api-fetch`, `auth-client`, `query-cache`;
  - `table-query`, `prepare-file`, `password-rules`, `color-converter`;
  - six `mocks-*` suites running the real handlers under `msw/node`.
- **Shared:** `bun run lint` passes.
- **Back-end:** `bun run lint` passes. `bun run test` (unit tier): 1642 pass, 0 fail, after every move including the final import rewrite. Integration tests for auth, media and sign-in were run by a worker after the shared validation changes; the full integration tier was not run.
- **Browser, mock mode** (`dev:mock` and `build:mock` + `start:mock`, headless Edge over CDP; harness in the session scratchpad, not in the repo):
  - **Start:** the worker starts; signed out, `/dash` goes to sign-in; no hydration warnings.
  - **Sign-in:** no request to Cloudflare. Admin signs in; the inactive-role user gets the server's 401.
  - **Pages:** all 18 dashboard pages render with no console errors or failed requests.
  - **Forms:**
    - A category create lands in the list and survives a reload; an invalid title shows its field error.
    - A name-only user edit keeps the phone verified.
    - A duplicate section slug gets 409.
    - A blank settings row shows field errors and is not saved.
  - **Tables:**
    - A 2-character quick search is ignored.
    - A 2-character name filter shows the server's 422 in the table.
    - One-sided date ranges on client tables return rows.
  - **Session check failing:** shows the error state with retry, not a redirect.
- **Real build** (`NEXT_PUBLIC_API_URL=https://api.example.invalid bun run build`): succeeds. The client bundle contains no MSW, worker, mock origin or mock storage keys.

**Not verified:**

- In a real browser: animated-image flattening, HEIC decoding, Safari behaviour, and whether 60 s is long enough before an object URL is released.
- The calendar-picker path for date ranges: tested through the URL.
- The data-table lab scenarios.
- A real-mode browser run: there is no back-end to connect to.

## Open — owner decisions

1. **Re-auth.** The server answers `REAUTH_REQUIRED` on user and role writes; the dashboard has no password prompt and the mock never issues the code. User/role writes against the real server cannot succeed until this exists.
2. **Pending entities' list contract and gates.** Categories, projects and sections load whole lists client-side, while every back-end list is server-paged. They have no permission gate, because `DASHBOARD_PAGE_NAMES` has no entry for them: adding one needs a shared constant and a migration. Today the editor role can edit them in the mock.
3. **`_app` imports `mocks/with-api-mocking`,** so deleting `mocks/` breaks the build. `instrumentation-client` cannot hold back the first render, so the hook is justified. The alternative is a bundler alias to a no-op.
4. **Editor uploads** store the presigned URL, not the file `id`. The URL expires and the unclaimed file gets swept. This is latent while editor media is disabled.
5. **Front-end-only helpers in `@app/shared`:** `richTextSchema`, `getColorSchema`, `slugPreprocess`, `humanReadableNumber`, `extractIdFromUrl` (unused). This conflicts with "keep front-end-only code out of shared".
6. **Cross-tab freshness.** A write in one tab shows in another only after a refresh or reload. `staleTime` is 30 min, which predates this work, and focus refetch applies only to stale data. The same is true against the real server.
7. **Shared routing codes** (`EMAIL_NOT_VERIFIED_CODE`, `PHONE_NOT_VERIFIED_CODE`, `TWO_FACTOR_UNAVAILABLE_CODE`): the server's message is shown, but there is no routing UI and no two-factor screen.
8. **Mock-only gaps:**

- any password signs in;
- uploads are stored as `data:` URLs in localStorage (IndexedDB would avoid the quota);
- other users' sessions are not modelled.

## Outside this area — reported

- **Lazy `UrlSync` drops the first table change from the URL.** It is loaded lazily and skips its first render, so a filter applied before its chunk arrives is not written until the next change.
- **The colour input's swatch covers the value's first characters.** The `dir='ltr'` padding sits on the opposite side from the RTL swatch (`components/ui/color-picker.tsx`).
- **`/dev/editor-lab` renders in production;** the other labs 404. The data-table README points to `/dev/data-table-lab` under `start:mock`, where it 404s.
- **`components/dev/editor-lab/fixture.ts` uses `structuredClone`,** newer than the browser targets.
- **Unused dependencies:**
  - the carousel chain and `embla-carousel*`;
  - `vaul`, `lenis` and `@radix-ui/react-accordion`;
  - one of the two file-picker libraries.
- **Per-endpoint response schemas:** most responses validate only the envelope.
- **`'image/svg+xml'` literals** remain in the back-end's media code and allowlist table.
- **`styles/base.css`** has an uncommitted `inert` fallback that is not from this work and is not Prettier-formatted. It was left untouched.
- **`prebuild` rewrites `public/manifest.json`'s `theme_color` in uppercase** (`#02CAAF`), because `constants/theme.ts` now uses the front-end colour converter (`utils/color-converter.ts`). The file was restored after each verification build; the next build rewrites it.
- **Both builds warn that `tailwind.config.ts` can't resolve `@/constants/breakpoints` and `@/constants/theme`.** The same imports exist at HEAD, and this work only reordered them. The built CSS still has the custom breakpoints and `--primary`.

**Local dev:** `bun run dev` (not mock) needs `NEXT_PUBLIC_API_URL` in `apps/front-end/.env`.
