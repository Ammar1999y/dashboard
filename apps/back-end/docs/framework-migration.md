# The HTTP layer

The current map of the API's HTTP layer: which layer owns what, how a request
moves through it, how to add an endpoint, and which files a move off Elysia
would touch. The decisions behind it, their costs and the record of each phase
are in `docs/http-layer-plan.md` at the repository root; the `Dn`, `Fn`, `Sn`
and `Xn` ids below are that document's.

Framework: `elysia@2.0.0-rc.0` on Bun, pinned exactly together with
`@elysia/cors@2.0.0-rc.0` and `@elysia/openapi@2.0.0-rc.0` (D2). Elysia 2 is
documented at next.elysiajs.com (`docs/elysia-llms.md`); elysiajs.com is 1.4.
Where the docs and the installed package (its types and source) disagree, the
package is the evidence.

## 1. Layers

| Layer       | Where                                       | What it holds                                                                                                                                                                                                                |
| ----------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract    | `packages/shared/src/api/*.ts`              | One `endpoint()` entry per route: method, path, `params` / `query` / `body` schemas, body kind, success status, response, `errors`, and the policy flags that decide its refusals (D1). Plain zod, shared with the front end |
| Field prose | `packages/shared/src/**/*.docs.ts`          | English OpenAPI descriptions of schema fields (`fieldDocs`, D19), loaded only when the document is first built                                                                                                               |
| Modules     | `modules/<domain>/*.ts`, `modules/index.ts` | Bindings: `bind(entry, options)` pairs a contract entry with its server options and a framework-free handler                                                                                                                 |
| Core        | `lib/http/`                                 | Admission, body reading, refusals, error mapping, the body builders, cookies, headers, routing, the after-response queue, the document finalizer and the Better Auth merge                                                   |
| Elysia      | `app.ts`, `server.ts`, `server/elysia/*.ts` | Every call into the framework: wiring, not policy                                                                                                                                                                            |

What the layout depends on:

- **Core never imports `elysia` or `@elysia/*`.** ESLint refuses it in `lib/`,
  `modules/`, `db/`, `utils/` and `packages/shared`, as a static import, an
  `import()` or an `import('…')` type, and refuses an `import()` whose module
  is not a literal. The same rules keep `*.docs` out of everything but
  `lib/http/openapi/docs.ts`. Logic that does not need the framework lives in
  core even when only Elysia calls it (the document finalizer works on a plain
  object, F41).
- **Elysia features are used where they improve the code** (native validation,
  macros, response schemas, document generation), and their calls stay in the
  Elysia layer.
- **Handlers are framework-free.** They receive
  `{ params, query, body, actor, meta }` and return
  `{ message, data, meta?, headers?, cookies? }` (or `{ raw }` on a raw entry),
  typed by `bind()` from the entry. The success status is the entry's.
- **One wire format, built in one place per body kind.** The shared
  `successBody` and `problemBody` (`packages/shared/src/api/wire.ts`) build
  every body: `run()` the successes, `apiError` in `lib/http/response.ts`
  every refusal, sent as `application/problem+json`. Under the Better Auth
  prefix the exit step adds `message` to each refusal (`toAuthProblem`).
  `apiRaw` is the raw escape hatch (`GET /api/health/storage`,
  `GET /openapi.json`).
- **`z.compile` runs only in `server/elysia/register.ts`,** on contract schemas,
  at registration (D10). `packages/shared` and the front end never call it, and
  no global `zod/compile` import is used: it would compile Better Auth's
  schemas too.
- **Refinements are pure, synchronous and cheap** (D21): a compiled schema runs
  a refinement twice on invalid input, and `tests/unit/zod-compile.test.ts`
  fails on an async one. Checks that need I/O run in handlers.

`server.ts` and `app.ts` are separate files on purpose. `app.ts` builds the
application without listening, so a route runs from a plain `Request`
(`app.handle(...)`), which every integration test relies on. `server.ts`
validates `NODE_ENV`, the port and the Bun and SQLite versions before it loads
the application by dynamic import, then listens and owns shutdown
(`lib/shutdown.ts`).

## 2. Where each capability lives

| Capability                                                                                                | Elysia side                                                         | Core side                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance options: `strictPath`, `abortSignal: false`, `precompile`, `reusePort: false`, the body cap (S1) | `app.ts` (`createBase`)                                             | `MAX_REQUEST_BODY_BYTES` in `lib/http/request.ts`                                                                                                             |
| Listen, idle timeout, shutdown                                                                            | `server.ts`                                                         | `lib/shutdown.ts`, `lib/startup.ts`                                                                                                                           |
| Request hook: start mark, security headers, host guard, declared-length ceiling, route-aware OPTIONS (S2) | `app.ts`                                                            | `lib/http/routing.ts` (404, 405 with `Allow`, 308, the per-path ceiling), `lib/http/request.ts`, `lib/http/security-headers.ts`                               |
| CORS (S3)                                                                                                 | `app.ts` (`@elysia/cors`, `CORS_POLICY`)                            | none                                                                                                                                                          |
| Registration: compiled schemas, response map, HEAD per GET, the boot hook assertion (S4)                  | `server/elysia/register.ts`                                         | `lib/http/binding.ts` (`bind`, options), `lib/http/refusals.ts` (refusals derived from policy)                                                                |
| Gate (S5)                                                                                                 | `server/elysia/gate.ts` (macro: `parse` / `transform`)              | `lib/http/admit.ts`, with `origin.ts`, `pre-auth.ts`, `session.ts`; the counted reader `readJsonObject` in `request.ts`                                       |
| Handler run, handler error mapping, success and declared-code checks, timing floor                        | called from `register.ts`                                           | `lib/http/run.ts`, `response-check.ts`, `timing-floor.ts`                                                                                                     |
| Error mapping (S6)                                                                                        | `server/elysia/errors.ts` (one `.onError()` per Elysia error class) | `bindingFailure`, `validationFailure`, `responseFailure` in `run.ts`; `apiError`, `handleApiError` in `response.ts`                                           |
| Exit step and after-response (S7, S8)                                                                     | `server/elysia/respond.ts` (`mapResponse`, `onAfterResponse`)       | `lib/http/response-policy.ts`, `cookies.ts`, `after-response.ts`                                                                                              |
| Better Auth prefix route (S9)                                                                             | `server/elysia/auth-mount.ts`                                       | `lib/auth/allowed-paths.ts`, `lib/auth/path-policy.ts`, `localiseAuthError` in `lib/auth/errors.ts`, `pre-auth.ts`, `response-check.ts`                       |
| `/openapi.json` (S10)                                                                                     | `server/elysia/openapi.ts` (`generateDocument`, `serveDocument`)    | `lib/http/openapi/` (`finalize.ts`, `merge-better-auth.ts` + `better-auth-tables.ts`, `docs.ts`, `serve.ts`, `json-schema.ts`, `tags.ts`); `modules/openapi/` |
| Scalar reference page, development only (X1)                                                              | `mountReferencePage` in `server/elysia/openapi.ts`                  | `referencePageCsp` in `lib/http/security-headers.ts`                                                                                                          |

## 3. A request, end to end

1. **`request` hook** (`app.ts`). Marks the start, writes the security headers,
   answers 404 for a host it cannot route, and 413 for a declared
   `Content-Length` over the ceiling the path's bindings or prefix declare
   (`lookupBodyCeiling`; the largest when two methods disagree), so a caller's
   `Content-Type` cannot widen it. Both answers carry the CORS headers an
   allowed origin gets everywhere else, since the plugin's own hook never runs.
   An OPTIONS on an unknown path gets its 404 or 308 here. Answers from this
   hook still pass the exit step and `afterResponse`; preflights skip both.
2. **CORS** (`@elysia/cors`). Answers preflights and sets the CORS headers.
3. **Routing.** A miss reaches `NotFound` in `errors.ts`, which answers the 308
   to the slash-free path, or 404 / 405 with `Allow` from `lib/http/routing.ts`
   (Elysia reports a wrong method and an unknown path alike).
4. **Gate** (`gate.ts` → `admit()`). A JSON-body binding is gated in the
   macro's `parse` hook, which runs before any body byte is read, and then reads
   its body through the counted reader (binding ceiling, `application/json`
   only, 413 / 400). Every other binding declares `parse: 'none'` and is gated
   in `transform`; a multipart handler reads its form lazily through
   `meta.readFormData`. `admit()` runs once per request: same-origin write →
   pre-auth IP limit → the route's own credential (`credential`, answered as
   its handler would) → session, permission and re-authentication window →
   the own-id 403 (`notSelf`) → rate limit → the other-target 403 (`orSelf`) →
   captcha.
   It throws typed errors. `runBinding` reads the gate's `actor` back and throws
   when the gate did not run, so a hook-order slip fails closed (D3).
5. **Native validation.** Elysia validates `body`, `params` and `query` against
   the compiled contract schemas. A failure becomes `validationFailure`: the
   part's refusal override (D25), else 422 with the first issue's message.
6. **Run** (`runBinding`). A key the query declares, named twice, is the
   query's refusal; then the handler runs; its own throws, and only those,
   pass the binding's `mapError`. Outside production the success is checked
   against the contract (`checkSuccess`), and every refusal's status against
   the statuses `refusalsOf` publishes and its `code` against the codes the
   entry declares or its policy implies (`responseCheckMode`: logged in
   development, recorded and answered 500 under the test runner).
7. **Answer.** The declared success, and a raw refusal the entry declares, go
   back as a plain value, so Elysia's response schema validates and strips it
   (a failure is a logged 500 that keeps none of the answer's headers or
   cookies). Every other answer is a native `Response` that core built. HEAD
   runs the GET's own registration; a `wrap` in `respond.ts` drops the body of
   every HEAD answer and keeps its length.
8. **Exit step** (`mapResponse` in `respond.ts`). Queued cookies, then the
   response policy: the security headers overwrite whatever a route or a
   library set, `Cache-Control: no-store` unless the handler set its own, and
   `Server-Timing` in development.
9. **`afterResponse`.** One access-log line with the status actually sent, then
   the after-response queue drains (audit writes, the anonymous OTP delivery).

Every hook is registered before the first route (`createBase`), because Elysia
copies the hooks a route can see when the route is registered.
`assertEveryRouteHooked` fails the boot if a route missed the error, exit or
after-response hook (F10).

The Better Auth prefix route (`/api/auth/*`, only the methods its allowlisted
paths serve, registered after every binding so explicit routes win) does not
pass the gate. It enforces the
allowlist and the pre-auth IP limit itself, bounds a chunked body by the same
ceiling as the request hook, and hands the request to `auth.handler` unread
(`parse: 'none'`).

## 4. Adding an endpoint

1. **Contract entry.** Add an `endpoint({ ... })` to
   `packages/shared/src/api/<domain>.ts`, reusing the request schemas in
   `validation/` and the response schemas in `responses/`. A new domain
   file is added to `api/all.ts` and `api/fields-are-typed.ts`;
   `tests/unit/bindings.test.ts` asserts every entry is bound once.
2. **Field prose.** Describe new fields in the `*.docs.ts` beside the schema
   file, through `fieldDocs` (a renamed field then fails to compile). A new
   docs file is added to `FIELD_DOCS_MODULES` in `lib/http/openapi/docs.ts`;
   `tests/unit/openapi-document.test.ts` holds that list to the files on disk.
   Operation text goes in the binding's `detail`, with constants interpolated.
3. **Binding.** In `modules/<domain>/<file>.ts`,
   `export const xBinding = bind(entry, { ...options, handler })`. The options
   follow the entry's policy (permission, rate limit, re-authentication,
   captcha, refusal overrides, timeout, `detail`); the types and `bind()`'s boot
   check refuse a mismatch. Contextual authorisation that a static permission
   cannot express stays in the handler (D22).
4. **Register.** List the binding in its domain's `*_BINDINGS` array
   (`modules/<domain>/index.ts`); a new domain is spread into `BINDINGS` in
   `modules/index.ts`, whose order is registration and document order.
   `tests/unit/bindings.test.ts` fails on a binding left out. A feature flag
   goes in `enabled`: a switched-off binding is neither served nor documented.

Registration, compiled validation, HEAD, the OpenAPI operation and its derived
refusals follow from the entry; nothing else is edited by hand.

A **Better Auth plugin endpoint** is served by `auth.handler`, not bound. Its
entry goes in `packages/shared/src/api/better-auth.ts`, with `response: { raw }`
holding the whole 2xx body, and its plugin builds it with
`pluginEndpoint(entry, options, handler)`, which takes the path and method from
the entry and types the handler's answer by it. Add its row to
`lib/auth/allowed-paths.ts` and its 200 description to
`BETTER_AUTH_RESPONSE_DESCRIPTIONS`; `tests/unit/plugin-entries.test.ts` holds
the entry to that row and to the mounted endpoint.

## 5. Porting off Elysia (non-binding notes)

No other framework's code lives in this repository (D26); these notes only say
where a port would start. The plan's §3 has per-capability notes from probes run
outside the repository.

Files with Elysia-specific code:

- `app.ts`: the instance and its options, the `request` hook, CORS, hook order,
  `createApp`.
- `server.ts`: `app.listen` and `app.server`.
- `server/elysia/register.ts`, `gate.ts`, `errors.ts`, `respond.ts`,
  `auth-mount.ts`, `openapi.ts`.
- `package.json`: `elysia`, `@elysia/cors`, `@elysia/openapi`.
- Tests that reach into the instance: `tests/unit/app-options.test.ts` and
  `tests/integration/route-feature-gates.test.ts`. The integration suites drive
  the app through `app.handle(Request)`, which any fetch-style framework can
  serve.

Core that is framework-free but shaped by Elysia's behaviour, and needs a second
look in a port:

- `lib/http/run.ts` reads Elysia's validation issues, including the guards for
  issue fields Elysia replaces past its 8 KiB echo budget.
- `lib/http/openapi/finalize.ts` finishes the document `toOpenAPISchema`
  generates (request bodies the `parse` hook reads, operation ids, refusal
  wording); another generator's output would need its own finishing.
- The gate's `parse` / `transform` split and the per-route hook capture are
  Elysia's lifecycle; the order they enforce (gate before any body byte, then
  validation, then the handler) is the invariant to keep.

## 6. Verifying

`bun run smoke` boots the real server and asserts, from outside the process,
storage readiness, the security headers, a problem on an unrouted path,
the Better Auth mount, and that the upload, the readiness probe and the OpenAPI
document refuse an anonymous caller. The integration,
matrix and process tiers run against `app.handle`; the plan's §12 lists the
acceptance set for any Elysia bump.
