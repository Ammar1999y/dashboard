# CLAUDE.md

Monorepo root. Bun workspaces, one `bun.lock`, installed from here only.

| Workspace          | Package           | What it is                         |
| ------------------ | ----------------- | ---------------------------------- |
| `apps/back-end`    | `@app/back-end`   | Elysia API on Bun                  |
| `apps/front-end`   | `@app/front-end`  | Next.js dashboard                  |
| `packages/shared`  | `@app/shared`     | Code both apps import              |

Each app's own `CLAUDE.md` holds the engineering standard for work inside it and applies unchanged. Read it before editing that app.

## `packages/shared`

Its sources run in Bun AND in the browser bundle, and every consumer type-checks them with its own `tsconfig`. Rules that follow from that:

- No `@/` alias, no import from either app, no Bun- or Node-only API, no server-only environment variable. A startup gate over a **server-only** value belongs in `apps/back-end` — see `apps/back-end/lib/otp/config.ts`. A gate over a **public** (`NEXT_PUBLIC_*`) value may throw at load here, and three do (`config.ts`, `validation/otp.ts`, `validation/two-factor.ts`): the value is inlined at build, so a typo fails `next build` and the back-end's boot rather than resolving to a silent default. Nothing else may throw or log at load.
- Environment is read by literal name, `process.env.NEXT_PUBLIC_X`. Next inlines only literal reads; a dynamic lookup is `undefined` in the browser.
- Consumers import by package name (`@app/shared/validation/rules`), never by a relative path across workspaces. Subpaths map to `src/*.ts` through the `exports` field; `@app/shared/types` is the one directory index.
- Written to the backend's strictness (`noUncheckedIndexedAccess`), which is the stricter of the two consumers.
- User-facing copy the server says lives only in `src/messages/<domain>.ts`, as whole sentences so another language can be added per file later. Client-only copy goes in the front-end's `constants/messages.ts`. Logs and operator errors stay English and never quote a message. OpenAPI field prose is developer copy: English, in the `*.docs.ts` beside its schema, imported only by the back end's document loader so none reaches the browser.
- Refinements stay pure, synchronous and cheap, and nothing here calls `z.compile`: the back end compiles the contract schemas itself, which runs a refinement twice on invalid input, and the browser parses them plain.

## Commands

- `bun install` at the root. Nested lockfiles are a mistake.
- A package declared in several workspaces carries one specifier; `bun run check:deps` (`scripts/check-dependency-parity.mjs`) refuses drift at commit, push and CI. Add a package another workspace already has with that workspace's specifier, not the registry default. Bun catalogs replace the script once Renovate can update them; the script header says when.
- The root `bunfig.toml` pins the **hoisted** linker. Both apps import packages they reach only through their dependencies (better-auth's internals, Next's `styled-jsx`), so Bun's isolated default breaks them; switching to isolated means declaring those imports first, which the owner has declined.
- Per workspace: `cd apps/back-end && bun run <script>`, or from here `bun run --filter @app/back-end <script>`.
- Git hooks come from the root `lefthook.yml`; jobs run inside the workspace they name.
