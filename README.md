# app

A Bun-workspaces monorepo: an Elysia API, a Next.js dashboard, and the package
of validation, types and constants both of them import.

| Workspace         | Package          | What it is                                                  |
| ----------------- | ---------------- | ----------------------------------------------------------- |
| `apps/back-end`   | `@app/back-end`  | Elysia API on Bun; PostgreSQL via `bun:sql`, local SQLite   |
| `apps/front-end`  | `@app/front-end` | Next.js dashboard (Pages Router)                            |
| `packages/shared` | `@app/shared`    | Code both apps compile: schemas, types, contract, constants |

## Prerequisites

Bun, at the exact version in the root `package.json`'s `packageManager` field.
Nothing here needs Node: `bun install` runs `scripts/require-bun.mjs`, which
refuses any other package manager, an older Bun, a foreign lockfile in any
workspace, and a workspace whose `packageManager` disagrees with the root's.

## Commands

Install from the root only. There is one `bun.lock`; a lockfile inside a
workspace is a mistake the guard rejects.

```sh
bun install

# one workspace
cd apps/back-end && bun run dev
bun run --filter @app/front-end dev

# every workspace that defines the script, plus the root-level files
bun run typecheck       # all three workspace tsconfigs, using bun check
bun run lint
bun run format:check
bun run test            # the back-end unit tier
```

Each app's own `package.json` lists its full script set (`test:all`, `smoke`,
`db:generate`, `check:schema-drift`, …). Git hooks come from the root
`lefthook.yml` and run each job inside the workspace it names; `bun run verify`
inside `apps/back-end` runs the whole pre-push set by hand.

Type checking uses [Bun's built-in checker](https://bun.com/docs/runtime/check).
Run `bun check -p apps/back-end` from the root to check one workspace.
TypeScript stays installed for Next.js, ESLint and editor support.

Tests and app startup do not run type checking automatically. Run
`bun run typecheck` separately when needed.

Current commands and deployment instructions use `bun check`. Historical
review results retain the TypeScript commands that actually produced them.

## Bun 1.4.4 adoption

The [release notes](https://bun.com/blog/bun-v1.4.4) were checked against the
runtime, tooling and database integrations. The workspace runtime pins and both
Dockerfiles use this release; CI reads the root pin automatically.

| Feature                                                        | Project decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun fmt`                                                      | Formatting scripts and Git hooks use the native formatter with the existing Prettier configs and ignore files; its output matched Prettier's on every tracked file. Both configs group Bun imports explicitly. Prettier and its plugins stay installed: back-end ESLint runs `prettier/prettier`, and the front-end scripts `build-icons`, `generate-manifest` and `sync-community-themes` call Prettier's API with the project config. `bun fmt --doctor`'s removal list does not see those uses. |
| `bun check` improvements                                       | All workspaces already use the native checker, so the upgrade supplies the improvements without changing tsconfig boundaries or introducing project references.                                                                                                                                                                                                                                                                                                                                    |
| SQL and SQLite fixes                                           | Supplied by the runtime upgrade. Keep transaction deadlines, the separate list/probe pools, pool watchdog and shutdown draining until re-measured; three fixes bear on recorded findings and are the ones to re-test: `idleTimeout`/`maxLifetime` no longer close a busy connection (the reason `reports/performance-fixes.md` set them aside), a pool that lost connections grows back, and TCP keepalive fails a query whose server vanished (`reports/review-findings.md` #1).                  |
| Arrays in `Bun.SQL`                                            | A JavaScript array now binds as a PostgreSQL array, so the two-factor preflight and the media id lists pass arrays directly instead of building literals or one parameter per id.                                                                                                                                                                                                                                                                                                                  |
| `minimumReleaseAge` units and per-version exclusions           | The policy stays in seconds: Bun before 1.4.4 refuses `"3d"` and would stop before the runtime guard explains why. An urgent release inside the window is exempted alone with `--minimum-release-age-excludes=…,<name>@<version>` (`bunfig.toml`).                                                                                                                                                                                                                                                 |
| Coverage reporting                                             | A whole-tier run keeps its full report while focused configuration reruns still execute. Narrowed runs retain their own coverage. Coverage thresholds are unchanged. Each focused row writes its own JUnit file the same way.                                                                                                                                                                                                                                                                      |
| libc-filtered Linux installs                                   | Applies only to lockfile entries that carry a `libc` field, and none does yet; Renovate updates add it package by package. Not regenerated wholesale.                                                                                                                                                                                                                                                                                                                                              |
| Install retry, hoisted linker, Headers and stream improvements | Automatic where applicable. Keep the hoisted linker and frozen lockfile.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `query.cancel()`                                               | Available for explicit PostgreSQL cancellation, but it does not replace server-enforced transaction deadlines or the final check before commit.                                                                                                                                                                                                                                                                                                                                                    |
| `bun pm fetch`                                                 | The Dockerfiles already cache dependency installs before copying source; no additional fetch/offline layer is needed for the current build.                                                                                                                                                                                                                                                                                                                                                        |
| SQL transforms, COPY streams and SQLite functions/hooks        | No current application requirement. Keep Drizzle's column mapping and the existing bounded cache/rate-limit operations.                                                                                                                                                                                                                                                                                                                                                                            |

`@types/bun@1.4.4` was not published when this update was made; both apps retain
the latest published wrapper, `@types/bun@1.4.3`, and its matching `bun-types`.
Renovate continues to group Bun runtime, Docker and type updates.

### Earlier adoption

The [release notes](https://bun.com/blog/bun-v1.4.3) were checked against the
current integrations and deployment:

| Feature                                                       | Project decision                                                                                                                                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Bun.FetchSession`                                            | Adopted in `themes:sync`: at most six idle connections, matching the existing request batch size, disposed on success or failure. Request deadlines remain in place.                         |
| Server CPU/HTTP, TLS, PostgreSQL and SQLite fixes             | Supplied by the runtime/image upgrade. Existing transaction deadlines, error handling and graceful-shutdown safeguards still serve separate purposes.                                        |
| `crypto.randomInt`, rejected promises and CSS bundling fixes  | Existing OTP/backup-code generation, theme discovery and `build-editor-css.ts` already use these operations. No API migration is needed.                                                     |
| Proxy matching and install tarball pruning                    | Automatic when applicable. Preserve the deployment's proxy environment and CI's frozen lockfile; neither needs a new setting.                                                                |
| `CompressionStream` levels and `If-Range`                     | No application compression stream or local-file download service to migrate. Media downloads use R2 URLs.                                                                                    |
| Native S3 streaming fixes                                     | Keep the AWS SDK: R2 requires checksum readback, conditional creation, copy metadata and batch deletion. Equivalent native-client behaviour has not been established.                        |
| Code-generation restriction                                   | A probe confirmed that blocking strings makes `z.compile` fall back to interpreted validation; strict compilation throws. Enabling it would remove the fast path used by route registration. |
| `Bun.ModuleGraph`                                             | No multi-instance host here. Retain the existing test harness and its database/process ownership guards.                                                                                     |
| Compiled bytecode profiles, JIT tuning and wider chunk hashes | The API runs from source; Next.js builds the dashboard. Revisit if introducing a compiled API image or split Bun JavaScript bundles, with startup/memory measurements.                       |

## The shared package

`packages/shared/src` is imported by package name — `@app/shared/validation/rules`,
`@app/shared/contract`, `@app/shared/types` — never by a relative path across
workspaces. It ships TypeScript source: Bun runs it as is, and the front-end
lists it in `transpilePackages`.

Everything in it runs in Bun **and** in the browser bundle, and every consumer
type-checks it inside its own program. Hence the rules:

- No `@/` alias, no import from either app, no Bun- or Node-only API, no
  server-only environment variable.
- Environment is read by literal name (`process.env.NEXT_PUBLIC_X`). Next
  inlines only literal reads; a dynamic lookup is `undefined` in the browser.
- A gate over a **server-only** value — anything read from a secret or a
  non-`NEXT_PUBLIC_` variable — belongs in `apps/back-end`; see
  `apps/back-end/lib/otp/config.ts`. A gate over a **public** (`NEXT_PUBLIC_*`)
  value may throw at load here, and three do: `config.ts` on an unknown IANA
  zone, `validation/otp.ts` and `validation/two-factor.ts` on a malformed or
  incoherent channel/method list. That is the intended outcome — the value is
  inlined at build, so a typo fails `next build` and the back-end's boot instead
  of resolving to a silent default in production. Do not add a load-time throw
  for anything else.
- Written to the back-end's strictness (`noUncheckedIndexedAccess`), the
  stricter of the two consumers.

What lives there and why:

- `validation/*` — the Zod schemas the API parses requests with. The front-end
  validates forms against the same schemas.
- `api/*` — one `endpoint()` entry per route: method, path, params, query,
  body, response, refusals and policy. The server binds a handler to it, the
  front end calls it with `api(entry, …)`, the mocks answer it with
  `mock(entry, …)`, and the OpenAPI document is generated from it.
  `api/wire.ts` builds and parses every body: successes, and errors as RFC
  9457 problems (`application/problem+json`).
- `contract.ts`, `response-contract.ts` — the Better Auth request and
  response tables, keyed by the path under `/api/auth`, and the generic
  field and contract checks.
- `auth-fields.ts` — the Better Auth `additionalFields`, so the server's
  `betterAuth()` and the client's `inferAdditionalFields()` share one
  declaration.
- `types/`, `permissions/constants`, `config`, `messages/*`, `http-status`,
  `error-codes`, `error-class`, `data-table/*`, `images/*`, `utils`, `time` — the
  isomorphic modules that used to be copied between the two apps.

## Dependencies

Bun installs this workspace with the **hoisted** linker (`bunfig.toml`), the
flat `node_modules` layout the applications were written against. A three-day
release-age floor applies to every install (`minimumReleaseAge`); Renovate's
security alerts bypass it, and an urgent fix inside the window is installed
once with `--minimum-release-age=0`.

A package declared in more than one manifest carries the **same specifier** in
each. `bun run check:deps` (`scripts/check-dependency-parity.mjs`) enforces it
at commit, push and CI: one `bun.lock` still resolves two specifiers to two
copies, nested under the workspace that asked for the second, and
`bun dedupe --check` cannot collapse two majors. To add a package another
workspace already declares, install it with that workspace's specifier —
`bun add zod@4.6.5` inside the app — or run the check and copy what it prints.
Bun catalogs will replace the script once Renovate can update them; the
script's header says when and how.

## Deployment

The back-end ships as a container built from `apps/back-end/Dockerfile` with the
**repository root** as build context, because the lockfile and `packages/shared`
live there. Coolify settings, environment, storage, health checks and the
operational runbook are in `apps/back-end/reports/coolify-deployment.md`.

On Coolify the front-end is a second container, from `apps/front-end/Dockerfile`
with the same build context; the same file has its settings. Whatever hosts the
front-end (Coolify, Vercel, Cloudflare) must build from the
repository root with `apps/front-end` as the project directory, and must rebuild
when `packages/shared` changes: the shared schemas are compiled into both
deployments, and the `NEXT_PUBLIC_*` configuration they read must be set
identically for both.

## Layout of a change

- Something both apps need → `packages/shared`.
- An endpoint → its contract entry in `packages/shared/src/api`, field prose in
  the `*.docs.ts` beside its schema, and a `bind()` in
  `apps/back-end/modules/<domain>`. The steps are in
  `apps/back-end/docs/framework-migration.md`.
- Server-only behaviour, database, auth internals → `apps/back-end`.
- Engineering standards for each app are in its own `CLAUDE.md` / `AGENTS.md`.
