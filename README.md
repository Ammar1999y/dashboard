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
bun run lint
bun run format:check
bun run test            # the back-end unit tier
```

Each app's own `package.json` lists its full script set (`test:all`, `smoke`,
`db:generate`, `check:schema-drift`, …). Git hooks come from the root
`lefthook.yml` and run each job inside the workspace it names; `bun run verify`
inside `apps/back-end` runs the whole pre-push set by hand.

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
- `contract.ts` — `REQUEST_BODIES` and `BETTER_AUTH_BODIES`, keyed
  `METHOD /path`: the registry the OpenAPI generator publishes and the type
  source for a client (`RequestBody<'POST /api/dash/users'>`).
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

Whatever hosts the front-end (Coolify, Vercel, Cloudflare) must build from the
repository root with `apps/front-end` as the project directory, and must rebuild
when `packages/shared` changes: the shared schemas are compiled into both
deployments, and the `NEXT_PUBLIC_*` configuration they read must be set
identically for both.

## Layout of a change

- Something both apps need → `packages/shared`.
- A request body → its schema in `packages/shared/src/validation`, an entry in
  `contract.ts`, and the route in `apps/back-end/routes.ts`. The OpenAPI build
  refuses a `body: 'json'` route without an entry, and an entry without a route.
- Server-only behaviour, database, auth internals → `apps/back-end`.
- Engineering standards for each app are in its own `CLAUDE.md` / `AGENTS.md`.
