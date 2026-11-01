# Coolify deployment: ElysiaJS, `bun:sql`, `bun:sqlite`

Updated: 2026-10-31

> **The application has never been deployed.** This is the first-deploy
> runbook and the operating manual after it: what to set, in order, and how to
> verify it. The PostgreSQL and SQLite behaviour was verified locally
> (PostgreSQL 18.6 on Bun 1.4); nothing here has been executed against a live
> Coolify instance.

## Topology

- **Runtime:** Bun 1.4.4 — runtime, package manager and TypeScript loader. No
  Node process, no bundle, no `node-gyp`.
- **Business data:** PostgreSQL via `bun:sql`. Three pools per process in
  `db/index.ts`: the application pool (`withTransaction` runs on it), the
  data-table list pool and the readiness probe's — 10 + 4 + 1 = 15
  connections (`db/limits.ts`).
- **Rate limits:** local SQLite via `bun:sqlite` on a persistent volume.
- **Ingress:** Cloudflare → Coolify/Traefik. Mandatory (§5).
- **Host size: at least 4 vCPU.** Bun runs Argon2, image encoding and every
  session-cookie HMAC on one work pool with a thread per core. The app bounds
  the first two to one job each (`withPasswordSlot` in
  `lib/auth/password/hash.ts`, `ENCODER_SLOTS` in
  `lib/media/image/optimize.ts`); on 2 vCPU those two alone fill the pool, and
  every signed-in request waits behind a sign-in plus an upload (measured: 8
  encodes on 8 threads took an HMAC from 0.15 ms to 1.1 s).
- **Process model:** one container, one `bun server.ts` process, one replica,
  one VPS. This is a hard constraint, not a default: the limiter's SQLite store
  allows one writer on one host, and a second writer is an authentication
  outage (§4). Scaling past one needs a decision first (§4).

The back-end is one workspace of a Bun monorepo (`apps/back-end`, beside
`apps/front-end` and the `packages/shared` package both import), so the build
context is the **repository root** and the image is described by
`apps/back-end/Dockerfile`, not by Nixpacks: Nixpacks with a sub-directory as
Base Directory never sees `packages/shared` or the root `bun.lock`. The
front-end is a second Coolify application on the same VPS (§2).
[Deploy Elysia to production](https://next.elysiajs.com/patterns/deploy)
(Elysia 2; the installed version is `2.0.0-rc.1`, and elysiajs.com documents
1.4)

## Settled decisions

Instructions below depend on these. Revisiting one changes the marked sections.

| Decision             | Choice                                                                 | Affects |
| -------------------- | ---------------------------------------------------------------------- | ------- |
| Scheduled jobs       | In-process `Bun.cron` (`lib/maintenance/schedule.ts`); no Coolify task | §9      |
| Expiry sweeps        | Every 15 minutes (SQLite and `verifications`)                          | §9      |
| Retention sweep      | Daily                                                                  | §9      |
| Object-store check   | Weekly, read-only                                                      | §9      |
| Power-loss RPO       | `synchronous = NORMAL` on the limiter DB, incl. the daily OTP cap      | §4      |
| Retained WAL ceiling | `journal_size_limit = 64 MiB` retained size, peak monitored            | §4, §10 |
| Update mode          | Stop-first, one replica                                                | §6      |
| Readiness            | Token-gated CMD check that includes a bounded PostgreSQL `SELECT 1`    | §7      |

## Open before production traffic

Owner decisions and checks nothing in the repository can settle.

1. **`secure_delete` is undecided.** Both SQLite databases run
   `secure_delete=OFF`, so deleted rows keep their bytes until the pages are
   reused, and those bytes are limiter keys embedding raw IPs, emails and phone
   numbers. A raw-file probe found a marker holding all three after deletion
   plus a truncating checkpoint under `OFF`, and none under `FAST`. Either set
   `secure_delete=FAST` in [`applyPragmas`](../lib/sqlite/database.ts) or record
   retention as accepted policy. The default silently chooses retention.
2. **The rate-limit RPO** (§10). With no off-host SQLite backup, host loss
   resets the daily OTP spend counter. If exact continuity is mandatory,
   single-VPS SQLite is insufficient: use durable shared storage.
3. **The application pool's `idle_in_transaction_session_timeout`**: 60 s in
   code against the role's 10 s (§3.3). Which value the application runs with
   is open.
4. **`--no-env-file`** (§2).
5. **An edge rate-limiting rule on the authentication surface** (§5, Edge
   rules). The application's limits are per IP (and per IPv6 /48) and per
   account; a distributed flood is shed by its process-wide caps, which answer
   503 to everyone until it stops.
6. **Container log rotation** (§10, Container logs). Unrotated, a flood fills
   the disk; rotated too tightly, it pushes the incident's error lines out.
7. **Host size** (Topology): confirm at least 4 vCPU before launch.
8. **The SQLite checks against real data.** Migration, busy handling, crash
   recovery and backup/restore were verified only against freshly created
   databases on a developer machine. Repeat them against a copy of the live
   volume once it holds data.

## 1. Prepare the release

- Commit and push every runtime file. Coolify builds the Git commit, not the
  working tree. Never commit `.env`, `data/`, `*.db`, `*-wal`, `*-shm`.
- CI green on that commit (`.github/workflows/ci.yml`, `security.yml`). The
  `verify` job runs the same gates as the `pre-push` hook, among them:
  - `bun run find:unused-files`: Knip twice, the full run and `--production`,
    which also fails an export only tests reach. A failure is an unreachable
    file, an unused export or type, or an undeclared dependency (`knip.jsonc`
    lists the entry points): a code fix, not broken configuration.
  - `bun run check:doc-refs` (`scripts/check-doc-references.ts`): a document
    or a comment cites a repository path that does not exist, or a line past
    its end. Cite where the file went.
  - Two boot smoke tests (development and production posture).

  The `image` job builds `apps/back-end/Dockerfile` from the repository root,
  as Coolify does, and asserts the runtime UID is 1000. A binding exported
  under `modules/` but missing from `BINDINGS` fails
  `tests/unit/bindings.test.ts`.

- **Migrate before the container starts, through a controlled workflow, not
  Coolify.** Coolify's pre-deployment command runs in the _old_ container. Run
  `bun run db:migrate` (`scripts/migrate.ts`) from a checkout of the release
  commit, anywhere `DATABASE_URL` reaches the production database; it needs no
  other variable. On the first deploy it builds the whole schema on the empty
  database; on every later release it runs while the previous release still
  serves, which every migration is written to survive (`CLAUDE.md`).

  It runs three phases under one advisory lock: the generated migrations in
  `db/drizzle/`, then the hand-written SQL in `db/migrations/` (`pg_trgm`, the
  GIN indexes, the folded search columns), then a check that every foreign key
  into `files` follows the referrer contract. Once it holds the migration lock
  (a wait for another migrator is deliberately unbounded), every lock its DDL
  waits for is bounded by `lock_timeout = '10s'`, so DDL that would queue
  behind a live transaction fails that file instead of stalling the app.
  Running the command again resumes from the ledgers. What a failure leaves:
  - phase 1 applies every pending `db/drizzle/` migration in one transaction,
    so it rolls back whole;
  - a transactional `db/migrations/` file rolls back alone, with the files
    before it committed;
  - a `CONCURRENTLY` file runs outside a transaction and can leave an INVALID
    index; the next run refuses and names it. Drop it with
    `DROP INDEX CONCURRENTLY` and migrate again;
  - the phase-3 check runs after the first two phases committed, so a failure
    there exits 1 with the schema migrated: fix the offending migration, do not
    roll the schema back.

  **It refuses before applying anything** when a ledger disagrees with the
  checkout: `drizzle.__drizzle_migrations` against
  `db/drizzle/meta/_journal.json` (an edited migration, a row this checkout
  does not have, more rows than journal entries), or
  `drizzle.__sql_migrations` (filename, sha256) against `db/migrations/` (an
  applied file edited or removed, a new file sorting before an applied one).
  The message names the file and the database is as the command found it.
  Never edit a ledger without first knowing which statements the database
  actually ran.

- **Upgrading a populated database.** On an empty database every migration is
  instant. Once tables hold data, `db/migrations/020`–`023` rewrite `users`,
  `roles`, `files` and `folders` under an `ACCESS EXCLUSIVE` lock for the
  whole rewrite (measured at about 35–45 s per 200 000 rows), during which the
  running release's queries on that table wait, sign-in included. Run such a
  migration in a quiet window; under traffic a lock wait past 10 s fails that
  file and a re-run resumes from it.
- On a release that changes `PASSWORD_PEPPER_KEYRING`, run
  `bun run preflight:credentials` with the production `DATABASE_URL` and the
  keyring about to be deployed before routing traffic (§3.2).
- Record the release commit, the Coolify environment, the PostgreSQL migration
  version and the SQLite `user_version`.

## 2. Create the Coolify applications

### The back-end application

**Configuration > General:**

| Field               | Value                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Build Pack          | `Dockerfile`                                                                                                                          |
| Base Directory      | `/` — the repository root, where `bun.lock` and `packages/` are                                                                       |
| Dockerfile Location | `/apps/back-end/Dockerfile`                                                                                                           |
| Static Site         | Off                                                                                                                                   |
| Ports Exposes       | `3000`                                                                                                                                |
| Port Mappings       | Empty                                                                                                                                 |
| Watch Paths         | `apps/back-end/**`, `packages/shared/**`, `bun.lock`, `package.json`, `bunfig.toml`, `tsconfig.base.json`, `scripts/**`, `patches/**` |

**Watch Paths are load-bearing.** A push that touches only `apps/front-end`
must not rebuild this application, and a push that touches `packages/shared`
must, because the shared validation and types are compiled into this image.
The front-end needs the mirror-image rule (below), or the two deployments
drift apart on exactly the code that was shared to stop them drifting.

**Leave the install, build and start command fields empty.** The image runs
`bun run build` (`bun check`) in a `verify` stage the runtime stage cannot be
built without, and the runtime stage's `CMD` is the exec form
`["bun", "--bun", "server.ts"]`, no shell. An override must keep the server as
PID 1 (`exec bun --bun server.ts` if it goes through a shell), never
`bun run start`, which swallows `SIGTERM` (§6), and must carry
`NODE_ENV=production` over: HSTS, the production environment validation in
`lib/env.server.ts`, the absolute-`SQLITE_DIR` rule and the dev-only endpoint
gates all key off it.

**The served OpenAPI document needs no build step.** In production the process
generates `GET /openapi.json` in memory right after it starts listening
(`prepareServedDocument`, logged as `openapi document prepared`) from the
routes it registered under its own runtime configuration, so every
environment-gated route, 2FA methods and OAuth providers included, agrees with
it. A generation fault does not stop the server: the boot logs
`openapi document generation failed`, every route still serves, and only
authorised requests to `GET /openapi.json` answer a logged 500 until a fixed
build is deployed. CI generates and validates the production-surface document
first (`tests/unit/openapi-document.test.ts`).

**Images are pinned by digest.** Both Dockerfiles' `oven/bun:1.4.4@sha256:…`
stages and their `# syntax=docker/dockerfile:1` line, and the CI
`postgres:18-alpine` service, carry a digest beside the tag, so a re-pushed
tag cannot change a build. Bump the tag with `packageManager` (Renovate's
`bun` group moves both, with the Bun types, in one PR); a digest refresh for
the same tag arrives in Renovate's weekly `container image digests` group.

**Shared configuration reads the same variables in both deployments.**
`packages/shared` derives the enabled OTP channels and two-factor methods from
`NEXT_PUBLIC_ENABLED_OTP_CHANNELS`, `NEXT_PUBLIC_ENABLED_2FA_METHODS` and
`NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS`, and the business time zone from
`NEXT_PUBLIC_BUSINESS_TIMEZONE`. Set all four identically for the back-end and
the front-end. The time zone is not display-only: the back-end uses it for the
day boundaries of every date filter (`dayBounds`,
`packages/shared/src/data-table/filter-rules.ts`), so a front-end built with a
different zone gets "this day" answered for the back-end's day. The front-end
bakes them in at **build** time, so changing one there means a redeploy, not a
restart.

**Consider adding `--no-env-file`.** Bun auto-loads `.env` from the working
directory. A real process variable wins over a `.env` entry (measured, under
`NODE_ENV=production` too), so a stray file cannot override a Coolify value,
but it can **supply** one the platform deliberately left unset, such as a
development `SQLITE_MAINTENANCE_TOKEN`. Both ways such a file could reach the
container are closed today: the root `.dockerignore` excludes `**/.env` and
`**/.env.*`, and the process runs as `USER bun` against a root-owned `/app`.
The flag is defence in depth on top of those.

### One origin: front-end at `/`, API at `/api`

Serve both applications from one hostname, `https://example.com`. The
front-end gets every path, and the back-end gets `/api/*` plus the one
contract path outside it, `/openapi.json` (`packages/shared/src/api/openapi.ts`).
Every browser write is then `Origin: https://example.com` and
`Sec-Fetch-Site: same-origin`, the only pair the origin check on the project's
own endpoints accepts (`PUBLIC_URL` in §3). On an `api.example.com` split the
browser sends `same-site` and every dashboard write is refused 403. One origin
also removes CORS preflights and makes the session cookie first-party.

| Application | Coolify domain            | Environment                                                                      |
| ----------- | ------------------------- | -------------------------------------------------------------------------------- |
| Front-end   | `https://example.com`     | `NEXT_PUBLIC_API_URL=https://example.com`, `NEXT_PUBLIC_URL=https://example.com` |
| Back-end    | `https://example.com/api` | `PUBLIC_URL=https://example.com` (an origin: no `/api`, no trailing slash)       |

- **`NEXT_PUBLIC_API_URL` is inlined at build.** Set it before the front-end's
  first build; changing it means a rebuild. Left unset,
  `apps/front-end/lib/env.js` throws and the build fails.
- **The router rule must also match `/openapi.json`.** Coolify's domain field
  takes one path, so without this step `GET /openapi.json` falls to the
  front-end and answers Next's 404. Coolify may also attach a `stripprefix`
  middleware when a domain carries a path. After the first deploy, open the
  back-end's generated Traefik labels and make its router rule
  ``Host(`example.com`) && (PathPrefix(`/api`) || Path(`/openapi.json`))``,
  with no `stripprefix` middleware. Editing generated labels may first need
  Coolify's read-only labels setting turned off. Keep the generated router,
  TLS and service labels as they are, save, and **redeploy**: labels apply only
  to a new container. Once labels are managed by hand, Coolify's documentation
  says it stops regenerating them, so a later change to the domain field must
  be mirrored in the labels by hand. None of this is verified against the
  installed Coolify version.
- **Router priority.** Traefik ranks routers by rule length, so the back-end's
  rule wins over the front-end's bare `Host` rule. If you set explicit
  `priority` labels, keep the back-end's higher.
- **The front-end must not own `/api/*` or `/openapi.json`.** It is a
  Pages-router app with no `pages/api`; one added later would be silently
  shadowed by the back-end router.
- **Cloudflare:** one proxied record for `example.com`. The §5 rules match on
  path, so they apply unchanged. Do not add a rule that caches `/api/*`: every
  API response carries `Cache-Control: no-store` from the application
  (`lib/http/response-policy.ts`).

Verify after deploy, from a browser signed in on `https://example.com`: a
dashboard save returns 2xx, not 403 `MSG_UNTRUSTED_ORIGIN`, and DevTools shows
the request going to `https://example.com/api/...` with
`Sec-Fetch-Site: same-origin`. From a shell outside the VPS:

```sh
# the back-end's 404 JSON envelope, not a Next.js HTML page
curl -s https://example.com/api/no-such-route
# 401 with a JSON body and no "paths": the contract route reaches the back-end
curl -s -w '\n%{http_code}\n' https://example.com/openapi.json
```

### The front-end application

A second Coolify application, built by `apps/front-end/Dockerfile` into Next's
standalone server.

| Field               | Value                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Build Pack          | `Dockerfile`                                                                                                                           |
| Base Directory      | `/`                                                                                                                                    |
| Dockerfile Location | `/apps/front-end/Dockerfile`                                                                                                           |
| Domain              | `https://example.com`, the bare host (the back-end keeps `/api`)                                                                       |
| Ports Exposes       | `3000`                                                                                                                                 |
| Watch Paths         | `apps/front-end/**`, `packages/shared/**`, `bun.lock`, `package.json`, `bunfig.toml`, `tsconfig.base.json`, `scripts/**`, `patches/**` |
| Health check        | HTTP, path `/robots.txt`, expect `200` (`/` redirects to `/dash`)                                                                      |

- **Every variable is a Build Variable.** `next build` inlines
  `NEXT_PUBLIC_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`,
  `NEXT_PUBLIC_BUSINESS_TIMEZONE` and the three OTP/2FA lists, which the
  Dockerfile declares as `ARG`s; a runtime-only value does nothing. The
  front-end needs no secret.
- **The health check runs inside the container.** Coolify's HTTP check is a
  generated `curl -f` (with a `wget` fallback) executed in the container, so
  the runtime image installs `curl`; a check that cannot run fails forever.
- **Leave the start command empty.** The `CMD` runs `bun server.js` as PID 1,
  so Next's own `SIGTERM` handler drains requests. An override must `exec` it.
- **Rolling updates are safe here.** The front-end holds no state. A tab
  opened on the old release that requests a chunk the new container no longer
  has gets a full reload from Next's router, so `deploymentId` is not needed
  for a single instance.

### Startup refuses to boot on six conditions, and on every environment gate

`server.ts` validates the runtime **before** importing the application. A
rejected runtime exits non-zero after one line, `{"msg":"startup rejected",…}`:
a container restart-looping with that line is misconfigured, not crashing.

The environment gates (`lib/env.server.ts`, `lib/env.ts`, the keyrings, the
shared `NEXT_PUBLIC_*` parsers) run later, when `server.ts` imports the
application, before the fault handlers exist: a refused variable exits
non-zero with Bun's own error output, a stack trace naming the variable. Read
the first lines of the container log either way.

| Condition                                                | Why fatal                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV` not exactly `development`/`test`/`production` | Every production guard is an exact string comparison, so a typo would switch off the Better Auth secret floor, the Turnstile requirement, the absolute-`SQLITE_DIR` rule and HSTS at once.                                                                   |
| `PORT` set but not a decimal integer in `1..65535`       | Bun would bind an ephemeral port while the log reported the requested one. An unset or empty `PORT` means 3000.                                                                                                                                              |
| Bun OLDER than the pinned `1.4.4`                        | Both DB drivers are compiled into the Bun binary; the pin carries PostgreSQL and TLS fixes the code relies on. Bun NEWER than the pin boots and logs `bun version ahead of the tested pin`.                                                                  |
| `packageManager` not `bun@<major>.<minor>.<patch>`       | It is the only source of the pin.                                                                                                                                                                                                                            |
| `sqlite_version()` below `3.51.3`                        | The WAL-reset floor (§6).                                                                                                                                                                                                                                    |
| `SQLITE_DIR` cannot be claimed                           | The ownership lock (`.writer-lock.db`, `lib/sqlite/writer-lock.ts`) could not be opened in the directory: missing, unwritable, not a directory. A directory merely owned by another process is not a refusal: that process serves without the schedule (§4). |

The pin lives in `packageManager` in three `package.json` files (the root,
`apps/back-end` and `apps/front-end`) and in the Dockerfile tags. Moving it
means editing all of them and `bun.lock`; `scripts/require-bun.mjs` refuses to
let the three fields disagree.

**The install runs the same guard.** `bun install` runs
`scripts/require-bun.mjs` (at the repository root) as a `preinstall` script,
so an image with an older Bun fails at install with an actionable message.
Inside the image it reaches the build through `apps/back-end/package.json`'s
own `"preinstall"`: the Dockerfile's `bun install --filter …` runs only the
selected workspaces' lifecycle scripts, not the root's (measured on Bun
1.4.2). Removing that entry as redundant would drop the Bun-floor and
pin-agreement gates from every image build. The guard would otherwise run
Bun's installer to correct an old Bun; the Dockerfile sets
`BUN_GUARD_NO_AUTO_INSTALL`, so the build fails with instructions instead and
no build-time variable is needed in Coolify.

### Startup log

```json
{
  "msg": "server started",
  "port": 3000,
  "hostname": "localhost",
  "env": "production",
  "bun": "1.4.4",
  "idleTimeoutSeconds": 60,
  "maxRouteTimeoutSeconds": 120,
  "maxRequestBodyBytes": 12582912,
  "shutdownTimeoutMs": 135000,
  "gracefulStopMs": 5000
}
```

- **`port` is the bound port**, not the requested one.
- **`hostname` reads `localhost` and is not the bind scope.** `server.ts`
  passes no hostname, so Bun binds `0.0.0.0` and `[::]`. Do not "fix" it by
  passing `hostname: '0.0.0.0'`. Confirm the real bind once on the VPS with
  `ss -ltnp | grep <port>`: a loopback-only bind makes the container
  unreachable through the proxy.
- `maxRequestBodyBytes` is the application's own body ceiling
  (`MAX_REQUEST_BODY_BYTES`). Bun's listener limit is twice that
  (`SERVER_BODY_LIMIT_BYTES`, `lib/http/request.ts`) and is not logged; §5 says
  why the proxy must not cut below it.
- Set the stop grace period from `shutdownTimeoutMs` (§6).

In production `openapi document prepared` follows shortly after.

## 3. Configure environment

Every variable below is **runtime-only**. `bun check` executes no application
code, so nothing belongs in the build scope; a build-scoped secret stays
visible in image history for no benefit. If you deliberately add a build-time
consumer, enable **Use Docker Build Secrets** first and abort if the build log
or image history shows Coolify fell back to `--build-arg`.
[Environment-variable scopes](https://coolify.io/docs/knowledge-base/environment-variables)

Use Coolify's Normal view, lock secrets, and enable **Literal** for any value
containing `$`. Never paste a local `.env` wholesale. After the build, confirm
no secret appears in the deployment log or `docker history --no-trunc <image>`;
rotate anything that does.

### Required

| Variable                               | Secret | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=production`                  | No     | Enforced at boot (§2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PUBLIC_URL=https://<domain>`          | No     | Absolute origin: scheme required, no path/query/fragment/credentials, HTTPS in production. Used for CORS, Better Auth's `baseURL`, and the origin check on every write to the project's own endpoints: a browser write whose `Origin` differs, or that is not `Sec-Fetch-Site: same-origin`, is refused 403. The back-end reads this name only; `NEXT_PUBLIC_URL` is the front-end's variable, and a back-end given only that one refuses to boot (`Missing required environment variable: PUBLIC_URL`). |
| `DATABASE_URL`                         | Yes    | PostgreSQL connection string for `bun:sql`. Put `sslmode` in the URL (§3.1).                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `BETTER_AUTH_SECRET`                   | Yes    | `openssl rand -base64 32`. Production refuses a value under 32 characters, one with surrounding whitespace, Better Auth's published default, and a placeholder with fewer than 8 distinct characters.                                                                                                                                                                                                                                                                                                    |
| `PASSWORD_PEPPER_ACTIVE_ID`            | Yes    | Must name the key with the highest `generation` in the keyring.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PASSWORD_PEPPER_KEYRING`              | Yes    | One-line JSON; retain old keys still referenced by stored hashes (§3.2).                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `OTP_HMAC_ACTIVE_ID`                   | Yes    | Must name the key with the highest `generation` in `OTP_HMAC_KEYRING`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `OTP_HMAC_KEYRING`                     | Yes    | Same shape as the pepper keyring: `{"<id>":{"generation":1,"secret":"<32 bytes, unpadded base64url>"}}`. Generate with `openssl rand -base64 32 \| tr '+/' '-_' \| tr -d '='`. Malformed is a **boot** failure.                                                                                                                                                                                                                                                                                          |
| `TURNSTILE_SECRET_KEY`                 | Yes    | Production Cloudflare secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SQLITE_DIR=/app/data`                 | No     | Absolute; no production default. A defaulted value would let an unmounted volume boot and write to the container layer, where every redeploy resets the auth, API and daily OTP counters. Boot validation cannot prove the volume is mounted; only the persistence proof in §8 can.                                                                                                                                                                                                                      |
| `SQLITE_MAINTENANCE_TOKEN`             | Yes    | Gates the WHOLE of `GET /api/health/storage`, and nothing else. Generate with `openssl rand -base64 32` and nothing else: the value is the entire control. **At least 32 characters**; a shorter one refuses to boot, and so do an absent one in production (the health check cannot pass without it, §7) and one with fewer than 8 distinct characters. Failed attempts are logged by class, never by value (`maintenance token rejected`).                                                             |
| `NEXT_PUBLIC_ENABLED_OTP_CHANNELS`     | No     | Comma list: `email`, `sms`, `whatsapp`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `NEXT_PUBLIC_ENABLED_2FA_METHODS`      | No     | Comma list: `totp`, `otp`, `backup_code`, `passkey`. Unset disables two-factor entirely and every `/two-factor/*` and `/passkey/*` path answers 404. Parsed strictly: an unknown name, a duplicate or a trailing comma is a **boot** failure.                                                                                                                                                                                                                                                            |
| `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS` | No     | Comma list from the same set as the OTP channels, deliberately a SEPARATE variable: where the second-factor codes go. Required when `otp` is in the methods list.                                                                                                                                                                                                                                                                                                                                        |

### Two-factor configuration

The boot refuses `otp` in `NEXT_PUBLIC_ENABLED_2FA_METHODS` with no
`NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS`, and, in production, an enabled 2FA OTP
channel without its provider credentials. It **warns** instead of refusing
(`twoFactor.otpOverlapsRecovery`) when every 2FA OTP channel reaches a contact
kind `NEXT_PUBLIC_ENABLED_OTP_CHANNELS` also reaches and `otp` is the only
method. **Read the warning:** password recovery proves a second factor from a
set that excludes the contact its own code arrived on, so in that
configuration recovery refuses every enrolled user, and the administrative
reset is their only way back.

**Recommended shape.** Keep `backup_code` enabled: it is the only self-service
recovery from a lost authenticator. Point `NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS`
at a DIFFERENT contact kind from account recovery (recovery on `email`, second
factor on `sms`), which is what the separate variable exists for. `totp` and
`passkey` need no delivery provider; `passkey` needs nothing beyond
`PUBLIC_URL`, whose hostname becomes the WebAuthn Relying Party id.

**Changing `PUBLIC_URL`'s hostname invalidates every registered passkey.** A
credential is scoped to the RP id it was registered under, so a domain move is
a re-enrolment for every passkey user. Leave `passkey` out of the method list
until the domain is final.

**`BETTER_AUTH_SECRET` encrypts TOTP secrets and backup codes.** There is no
keyring for it: rotating it strands every enrolled authenticator and backup-code
set. Treat it as unrotatable once users have enrolled, or plan a forced
re-enrolment. Keep it stable across a release so in-flight signed browser state
stays verifiable.

**Before NARROWING the 2FA method or channel list on a live deployment, run the
preflight:**

```bash
# inside the container, or anywhere DATABASE_URL reaches the production database
bun run preflight:two-factor -- totp,backup_code            # methods only
bun run preflight:two-factor -- totp,otp sms                # methods + 2FA OTP channels
```

Read-only. It counts the accounts that hold `two_factor_enabled` and would have
NO usable method left under the **proposed** configuration, prints a bounded
sample, and exits non-zero when that count is not zero. Removing a method or a
channel does not downgrade those accounts: their next sign-in is a hard `403`,
and each then needs `POST /api/dash/users/:id/two-factor/reset` by an
administrator. Resolve the listed accounts, then change the variable. The one
exception is emptying `NEXT_PUBLIC_ENABLED_2FA_METHODS` completely: every
enrolled account then signs in with its first factor alone, a **downgrade**
recorded per account in `audit_logs` under
`two_factor_downgraded_feature_disabled` and logged at boot.

### Optional

| Variable                        | Notes                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_BUSINESS_TIMEZONE` | Valid IANA zone; defaults to `Asia/Riyadh`. Set the same value in the front-end build (§2).     |
| `PORT`                          | Supplied by Coolify; `server.ts` defaults to 3000.                                              |
| `CLOUDFLARE_PURGE_BATCH_SIZE`   | URLs per Cloudflare purge call, 1–500, default 100. Above 100 only on an Enterprise zone (§11). |

No security decision reads the host time zone: every calendar-day conversion
uses `NEXT_PUBLIC_BUSINESS_TIMEZONE` explicitly
(`packages/shared/src/config.ts`), so `TZ` on the container is hygiene only.

### Feature-dependent

Each OTP channel's credentials are required in production once the channel is
enabled in `NEXT_PUBLIC_ENABLED_OTP_CHANNELS` or
`NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS` (`lib/otp/config.ts`). The boot checks
that they are present, not that they work: readiness never touches a provider,
so a wrong credential shows only as failed sends after the container is
healthy. Send one real code per enabled channel during first deploy (§8).

- **Email OTP:** `SMTP_USER`, `SMTP_PASS`, optional `SMTP_FROM`. The transport
  is hard-coded to Gmail (nodemailer's `service: 'gmail'`, `lib/otp/delivery.ts`:
  `smtp.gmail.com:465`, implicit TLS), so `SMTP_USER` must be a Gmail or Google
  Workspace account and `SMTP_PASS` an app password for it (2-Step Verification
  on, not the account password). Credentials for another SMTP service boot and
  pass health, then every email code fails. `SMTP_FROM` defaults to
  `SMTP_USER`; set it only to that account or to an alias verified on it
  ("Send mail as"). A configurable SMTP host is a code change.
- **SMS OTP:** `DEEWAN_SMS_TOKEN`, `DEEWAN_SENDER_NAME` — Deewan
  (`https://apis.deewan.sa/sms/v1/messages`).
- **WhatsApp OTP:** `WHATSAPP_API_KEY` — RMZ (`https://services.rmz.one/api/whatsapp/send`).
- **R2 media storage:** the bucket, credential and purge variables, checked at
  boot (§11).
- **Google sign-in:** `ENABLED_OAUTH_PROVIDERS`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET` (§12).

**Outbound connections the VPS firewall must allow** (egress):
`smtp.gmail.com:465` (email), `apis.deewan.sa:443` (SMS),
`services.rmz.one:443` (WhatsApp), each only when its channel is enabled, plus,
on 443, `challenges.cloudflare.com` (Turnstile), `api.pwnedpasswords.com` (the
breached-password check, which fails open when unreachable),
`<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` (R2), `api.cloudflare.com` (cache
purge, when configured) and, with Google sign-in, `oauth2.googleapis.com` and
`www.googleapis.com` (§12). Some VPS providers block outbound mail ports; check
465 from the host with `nc -vz smtp.gmail.com 465`.

### Must be absent

| Variable              | Why                                                                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEST_DATABASE_URL`   | The variable the destructive test harness resolves its target from. The suite truncates tables and creates and drops databases; it never runs here, and refuses to under `NODE_ENV=production`. If this appears, delete it and find out who added it. |
| `BETTER_AUTH_SECRETS` | Refused at boot in production: Better Auth would let it take over signing from `BETTER_AUTH_SECRET`.                                                                                                                                                  |
| `OTP_DELIVERY=outbox` | The test transport: every send "succeeds" into an in-memory outbox. Refused at boot under `NODE_ENV=production` (`OTP_DELIVERY=outbox is a test transport`). Leave it unset (or `provider`).                                                          |
| `PGOPTIONS`           | `bun:sql` applies it to every pool the app opens (probed on Bun 1.4.4). Leave it unset unless that is the intent; a `?options=-c …` URL parameter also works for a deliberate per-app setting.                                                        |

### Application-level switches with no environment variable

Code constants in `packages/shared/src/config.ts`; each needs a deploy to
change.

| Constant                     | Default      | What it decides                                                                                                                                                                                              |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PASSWORDLESS_ENABLED`       | `true`       | Serves `/api/auth/passwordless/*`. Turn it OFF to remove the weakest first-factor route without switching off the OTP machinery that contact verification, recovery and the second factor depend on.         |
| `HONOUR_REMEMBER_ME`         | `true`       | Whether a submitted `rememberMe: false` shortens the session. `false` pins every session to the long lifetime.                                                                                               |
| `PHONE_NUMBER_MODE`          | `'optional'` | `'required'`, `'optional'` or `'disabled'`: the phone number's role in every flow. Changing it needs a migration as well as a deploy: it gates the phone CHECK constraints and `phone_number`'s nullability. |
| `REQUIRE_EMAIL_VERIFICATION` | `false`      | A correct password alone obtains no session until the email is verified (`EMAIL_NOT_VERIFIED`).                                                                                                              |
| `REQUIRE_PHONE_VERIFICATION` | `false`      | The same for the phone number, while phone is enabled and an enabled OTP channel can verify it.                                                                                                              |
| `OTP_AUTO_VERIFY`            | `false`      | Development bypass: contact verification and contact changes commit without a code. Recovery and passwordless always send a real one. Keep it `false` wherever an OTP provider is configured.                |

### 3.1 `bun:sql` operational notes

Verified locally against PostgreSQL 18.6: transactions on one backend PID,
advisory transaction locks, `FOR UPDATE`/`FOR SHARE`, `RETURNING`, savepoints,
the `pg_trgm` indexes and the pool close. **Not verified against Coolify.**

**a. `DATABASE_URL` is proven by the health check, not at boot.** Bun opens the
pool lazily, on the first query, so a wrong or unreachable value is not a
startup rejection: the container starts. It IS a health-check failure:
`checks.postgres` runs a bounded `SELECT 1` on every poll (§7). A healthy body
says the database answered, not that the schema matches; that is
`db:migrate`'s job (§1).

**b. Put `sslmode` in the URL.** Bun honours `PGSSLMODE`, but `?sslmode=` in
the URL wins, so the environment cannot move it. `require` against a server
without TLS fails rather than silently connecting in plaintext. Same host over
the Docker network: decide deliberately. Remote: `require` or stricter.

**c. Pool size against `max_connections`.** `MAX_POOL_CONNECTIONS` in
`db/limits.ts` is the number of concurrent **transactions**:
`withTransaction` reserves a connection for the whole block. A transaction
that gets no connection within `POOL_ACQUIRE_TIMEOUT_MS` answers 503 and logs
a `ConnectionTimeoutError` whose message starts `postgres connection not
acquired in time` (a scheduled job's failure line names the class alone). The
bound also covers opening a connection, so a run of those lines is pool
exhaustion OR an unreachable database: check that the database answers before
hunting for leaked transactions. Plain `db` queries outside a transaction still
queue without a limit. A pool full of transactions waiting on something that
never comes stays full until each holder ends; §3.3's
`idle_in_transaction_session_timeout` is the server-side bound that ends them.
Confirm `max_connections` leaves headroom for a migration run and a `psql`
session on top of the app's 15.

**d. `prepare: true` is correct only against PostgreSQL directly.** Bun creates
named prepared statements on the server, which a transaction-pooling proxy
(PgBouncer in transaction mode) can split across backends. If a pooler is ever
put in front of this database, set `prepare: false` on the application pool in
`db/index.ts` (the data-table pool already runs unprepared) and change the
`jsonb` column type in `db/schema.ts` to send JSON text: unprepared, an object
parameter reaches PostgreSQL as `[object Object]` and every jsonb write fails.

### 3.2 Key retirement: the two keyrings have different horizons

Both are parsed by `lib/crypto/keyring.ts`, and in both a hash records the id
of the key that produced it. A keyring holds **at most 8 keys**; more is a boot
failure, so retire old keys rather than accumulating them. Removing a key whose
id is still referenced makes those values **unverifiable**: a password hashed
under it never verifies again (answered and counted as a wrong password, logged
as `auth.password.hash unevaluatable`), and an OTP issued under it is answered
as if no code existed (logged as `otp.verify.keyUnavailable`, spending no
attempt).

| Keyring                   | A key may be removed once…                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PASSWORD_PEPPER_KEYRING` | every stored hash has been rehashed under a newer generation. Users rehash on next successful login, so **months**. `bun run preflight:credentials` (`scripts/check-password-peppers.ts`) answers whether it is done: it fails while any stored credential names a pepper id missing from the keyring you pass it. |
| `OTP_HMAC_KEYRING`        | no unexpired OTP was issued under it. Codes live 10 minutes (`OTP_EXPIRY_MINUTES`), so **an hour of grace is ample**.                                                                                                                                                                                              |

To rotate either keyring, add the new key with a higher `generation` and point
the matching `*_ACTIVE_ID` at it in the same deploy (the active id must own the
highest generation, or the boot refuses), keeping the old key in the keyring;
then remove the old key on the horizon above. Never remove and add in one step.

**A pepper rollback is a two-variable operation in both directions.**
Reverting `PASSWORD_PEPPER_KEYRING` to a version lacking the newest generation
makes every password hashed under it unverifiable, quietly: those users get the
ordinary wrong-password answer, then the ordinary lockout, and the only trace
is `auth.password.hash unevaluatable`. Run `bun run preflight:credentials`
against the keyring you are about to deploy before any revert. Reverting
`PASSWORD_PEPPER_ACTIVE_ID` alone is a **boot failure**: the active id must own
the highest generation ("Roll the keyring and the active id together").

### 3.3 PostgreSQL server configuration

Applies to a Coolify-managed PostgreSQL 18 (`postgres:18-alpine`, Coolify's
default) on the same VPS as the app. Values were chosen for this workload: one
Bun process with three pools, 15 connections in all (`db/index.ts`,
`db/limits.ts`), short OLTP transactions, `pg_trgm` GIN indexes, and nothing
else connecting (the front-end never opens a database connection). Choose the
image variant before there is data (§13).

**Two places, on purpose.** Memory and logging settings are server-wide and go
in Coolify's **Custom PostgreSQL Configuration** (a `postgresql.conf`, applied
on database restart). Timeouts go on the application's **role**, because the
PostgreSQL 18 manual advises against `statement_timeout`, `lock_timeout` and
`transaction_timeout` in `postgresql.conf` ("it would affect all sessions"),
and a role setting is stored in the database, so it survives a Coolify
config-file regression.

#### Memory and planner, in Coolify's custom configuration

Size from the RAM you give PostgreSQL, not the VPS total: Coolify, Traefik and
the Bun app share the box. Give PostgreSQL about half of RAM.

| Setting                | VPS 4 GB (PG ≈ 2 GB) | VPS 8 GB (PG ≈ 4 GB) | Why                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared_buffers`       | `512MB`              | `1GB`                | 25 % of PostgreSQL's share. Needs a restart.                                                                                                                                                                                                                                                                                                                     |
| `effective_cache_size` | `1GB`                | `3GB`                | Planner hint only, allocates nothing: what the OS page cache can realistically hold for PostgreSQL.                                                                                                                                                                                                                                                              |
| `work_mem`             | `4MB`                | `4MB`                | Default. Per sort/hash node, per query; the data-table queries sort under `LIMIT`. Raise only on evidence (`log_temp_files`).                                                                                                                                                                                                                                    |
| `maintenance_work_mem` | `128MB`              | `256MB`              | `CREATE INDEX` on the trigram GIN indexes (`db/migrations/`) and vacuum.                                                                                                                                                                                                                                                                                         |
| `random_page_cost`     | `1.1`                | `1.1`                | SSD/NVMe only. Check `lsblk -d -o name,rota` on the host: `0` = SSD. On spinning disk keep `4`.                                                                                                                                                                                                                                                                  |
| `max_connections`      | `50`                 | `50`                 | 15 per app process + 1 per migration run + admin sessions: 17–18 for the single process this runbook deploys. PostgreSQL reserves 3 for superusers. Raise it with the process count, not before, and never to hide pool exhaustion: exhaustion here has been a code bug (a transaction asking the pool for a second connection), which more slots would not fix. |

On a 2-vCPU host also set `max_parallel_workers_per_gather = 0`: a parallel
statement occupies three backends, and on the measured data sizes it was
slower than a serial one. The data-table list pool already sets it to 0 on its
own connections (`db/index.ts`).

Keep the visibility map fresh on the two tables whose counts are index-only
(`idx_users_role_id_live`, `idx_files_folder_active`), once, as the owner:

```sql
ALTER TABLE users SET (autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE files SET (autovacuum_vacuum_scale_factor = 0.02);
```

Leave the PostgreSQL 18 defaults for `io_method` (`worker`),
`effective_io_concurrency` (`16`), `max_wal_size` (`1GB`) and
`checkpoint_completion_target` (`0.9`).

#### Logging, in the same file

```conf
log_min_duration_statement = 500ms   # evidence for the deferred statement_timeout
log_lock_waits = on                  # logs waits longer than deadlock_timeout (1 s)
log_temp_files = 0                   # a sort spilling to disk means work_mem is too small
shared_preload_libraries = 'pg_stat_statements'
```

Then, once, as a superuser: `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`.
The data-table list pool sets its own `statement_timeout` (5 s,
`DATA_TABLE_STATEMENT_TIMEOUT_MS` in `db/index.ts`; measured p99 about 0.2 s
on realistic data, 1.2 s for the deepest sorted page at 200k users), and a
statement it cancels answers 503. The application pool's default is still
deferred until p99 query durations are measured on this host
(`reports/should-ignore.md`, Known #2), and this is how they are measured. `log_lock_waits` makes a writer that misses the users →
roles lock order visible before it deadlocks (the app answers a detected
deadlock 503).

#### Timeouts, on the application role

Run once as a superuser, naming the role in the app's `DATABASE_URL` (if that
is the `postgres` superuser itself, use `ALTER DATABASE <db> SET …` instead):

```sql
ALTER ROLE app_user SET idle_in_transaction_session_timeout = '10s';
```

⚠️ **The application pool does not take this value.** `db/index.ts` sends
`idle_in_transaction_session_timeout` = 60 s (`IDLE_IN_TRANSACTION_TIMEOUT_MS`)
as a connection parameter on the application pool, and a connection parameter
outranks a role setting (probed on PostgreSQL 18.6: value 60000, source
`client`). The role setting still covers every other session on the role (the
data-table list pool, the readiness probe, `db:migrate` and `psql`), so keep
it; but `pg_roles.rolconfig` shows 10 s while the application's transactions
run under 60 s. Changing the application's value is a code change to that
constant. Which value it should be is an open owner decision.

What the timeout does, measured on the harness database:

- **It ends a pool deadlock.** Transactions that wait on something that never
  comes leave every pooled connection `idle in transaction`; without the
  timeout that was a permanent outage, with it one of the timeout's length,
  after which Bun replaced the terminated connections and new requests worked.
  The requests caught in it still fail.
- **It must stay above the longest legitimate idle gap:** 4.58 s measured,
  typically about 1 s, because password sign-in holds its transaction open
  while Argon2 runs and concurrent sign-ins queue on the CPU. The gap grows
  with CPU load: on a VPS with fewer cores than the 8 measured, check
  `pg_stat_activity` under a sign-in burst before shortening the value, and
  never set it below a few seconds.
- **Not set, deliberately:** `statement_timeout` (above), `lock_timeout` and
  `transaction_timeout` (the manual's own caution; a migration may legitimately
  hold locks longer), and `idle_session_timeout` (it would close idle pooled
  connections the app expects to reuse).

It applies to new sessions, so restart the app after changing it.

#### Container shared memory

Docker's default `/dev/shm` is 64 MB, which parallel queries use; the official
image's documentation sets `shm_size: 128mb`. In the database container run
`df -h /dev/shm`. If the logs ever show `could not resize shared memory
segment`, raise it in Coolify's database resource settings (or custom Docker
options) and record the value here.

#### Verify after every database restart

```sql
SELECT name, setting, unit, source
FROM pg_settings
WHERE source NOT IN ('default', 'override')
ORDER BY name;
SELECT rolname, rolconfig FROM pg_roles WHERE rolconfig IS NOT NULL;
-- for the ALTER DATABASE variant:
SELECT d.datname, s.setrole::regrole, s.setconfig
FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid = s.setdatabase;
```

Every value above must appear, with `source = configuration file` for the
memory and logging rows. Neither query shows the application pool's own 60 s:
it exists only on the sessions the app opens. Coolify has had bugs where a
custom configuration was not applied
([coollabsio/coolify#4455](https://github.com/coollabsio/coolify/issues/4455),
[#6230](https://github.com/coollabsio/coolify/issues/6230)), so a healthy
container is not proof the file was read. An unapplied file leaves the defaults
(`shared_buffers` 128 MB, `random_page_cost` 4, every timeout 0).

## 4. Add persistent SQLite storage

**Configuration > Persistent Storage:**

| Field            | Value                      |
| ---------------- | -------------------------- |
| Type             | Named volume (recommended) |
| Name             | `sqlite-data`              |
| Destination Path | `/app/data`                |

Coolify prefixes the actual volume name with the resource identifier. A bind
mount is valid when host backup tooling needs a fixed path; the destination
stays `/app/data`.
[Persistent Storage](https://coolify.io/docs/knowledge-base/persistent-storage)

Requirements:

- **Real local VPS disk.** No NFS, CIFS, distributed volume or second host:
  SQLite WAL requires same-host shared memory.
  [WAL restrictions](https://www.sqlite.org/wal.html)
- **Mount the directory, not the `.db` file.** SQLite creates `-wal` and `-shm`
  beside each database.
- Do not share the path with preview or staging applications.
- One replica, one Bun process. No PM2 cluster, no Swarm replica increase, no
  second VPS against this volume. `app.ts` sets `reusePort: false`, so a second
  process on this host dies with `EADDRINUSE`. That guard covers a same-host
  double start and nothing else: not a second container mounting the volume,
  not an operator's `sqlite3`, not a backup tool.

```text
/app/data/rate-limit.db    durable rate limits and the OTP global spend cap
/app/data/cache.db         disposable cache; a scaffold with no call sites yet
/app/data/.writer-lock.db  ownership marker: which process runs the schedule
```

The limiter database uses WAL with `synchronous=NORMAL`: process-crash-safe
with local durability, but host or OS failure or power loss can lose recently
committed transactions. Not a substitute for off-host backup.

### A second writer on `rate-limit.db` is a full authentication outage

`bun:sqlite` is **synchronous**, so a contended statement blocks the whole
event loop. Measured: one external process holding `BEGIN IMMEDIATE` for 4 s
made a concurrent limiter call block for **2 282 ms** (the `busy_timeout`
ceiling) and then fail, which `enforceRateLimit` answers with `503
Retry-After: 30` on every fail-closed path: sign-in, every OTP surface, every
route behind the pre-auth IP limit and every Better Auth path. For ~2.3 s per
contended statement the process serves **nothing at all**, and the same stalls
can make the health check miss its deadline. No attacker is needed; an operator
action is enough.

- Run `PRAGMA wal_checkpoint(TRUNCATE)` and any file-level SQLite work (§10)
  in a maintenance window, never on a live deployment and never on a schedule.
- Do not point a second container, a staging app, or a shell's `sqlite3` at
  `/app/data` on a running deployment.
- **Scaling to more than one replica needs a decision, not a replica count.**
  Either give each replica its own `SQLITE_DIR` volume and accept that every
  limit becomes per-replica, or move the limiter to a shared store. Sharing one
  volume does not work: across 4 processes the counters stayed exact, bought
  with the writer contention above on every request.

Startup claims an OS-backed ownership lock under `SQLITE_DIR`, and only its
holder registers the scheduled jobs. A second cooperating process on the same
directory boots and serves without them (`maintenance schedule not started`),
retrying the claim every minute, so it takes the schedule over once the owner
exits. External SQLite tools do not honour this lock.

### Permissions check

After the first container start, in the Coolify Terminal:

```sh
id
stat -c '%U:%G %a %n' /app/data
test -w /app/data
```

**The runtime UID is 1000, not root.** The runtime stage ends with `USER bun`,
the uid 1000 / gid 1000 account `oven/bun` ships; `id` must print
`uid=1000(bun) gid=1000(bun)`. The image creates `/app/data` as `bun:bun` mode
`0700`, and a new named volume inherits that. A bind mount does not: set host
ownership to `1000:1000`, never `chmod 777`. For a volume whose files are not
owned by 1000 for any other reason, fix it once, with the app stopped, over
SSH on the VPS:

```sh
docker run --rm --user 0 --entrypoint sh -v <volume>:/app/data <image> \
  -c 'chown -R 1000:1000 /app/data && chmod 0700 /app/data && find /app/data -type f -exec chmod 0600 {} +'
```

`<volume>` is the exact Coolify volume name (resolve it as §10 Restore says;
never guess from a prefix) and `<image>` the newly built one. The files hold
raw identifiers, so keep the directory at `0700` for the runtime identity; that
mode also protects newly created DB/WAL/SHM files. If the runtime identity
cannot enforce it, fix ownership or the startup umask before production.

## 5. Cloudflare ingress, edge rules and proxy limits

### Ingress

Cloudflare is mandatory. The code trusts `cf-connecting-ip` and nothing else
(`TRUSTED_IP_HEADERS`, `lib/http/client-ip.ts`); Traefik's `x-forwarded-for` is
deliberately not accepted because a client controls it whenever the origin is
reachable. Direct traffic makes every IP-protected route answer 503 and log
`missing client ip headers`. The header is trusted on syntax alone, so it is
trustworthy **only because** direct origin traffic is blocked (step 6). If
Cloudflare is ever removed, change the trust boundary first; do not simply add
`x-forwarded-for`. The sites carry a greppable `TODO(proxy-trust)`
(`reports/should-ignore.md` #63).

1. Add the domain in Coolify; do not publish a host port (§2, "One origin").
2. Create a **proxied** (orange-cloud) DNS record.
3. Use **Full (strict)** TLS with a valid Coolify origin certificate.
4. **Rules > Transform Rules > Managed Transforms:** keep _Remove visitor IP
   headers_ **off**: the code needs `CF-Connecting-IP`.
5. **Network > Pseudo IPv4:** _Off_ (preferred) or _Add Header_. Never
   _Overwrite Headers_: it replaces `CF-Connecting-IP` for IPv6 visitors and
   defeats the application's IPv6 `/64` grouping.
6. At the VPS firewall, allow 80/443 from current Cloudflare ranges and trusted
   admin sources only; block everything else.
   [Cloudflare IP guidance](https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/)
7. Confirm the original visitor address arrives in `CF-Connecting-IP` for both
   IPv4 and IPv6 clients.

[Request headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/) ·
[Managed transforms](https://developers.cloudflare.com/rules/transform/managed-transforms/reference/) ·
[Pseudo IPv4](https://developers.cloudflare.com/network/pseudo-ipv4/) ·
[Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)

### Edge rules

**Rules > WAF > Custom rules**, each _URI Path starts with_ → **Block**, or
the equivalent exclusion from the public Traefik router. Nothing in the
repository can enforce them.

- **`/api/internal/`**: no route serves this prefix. The rule costs nothing,
  and a route added under it later cannot arrive internet-reachable.
- **`/api/dev/`**: outside `NODE_ENV=development` its one endpoint,
  `/api/dev/sign-up`, is not registered (`registeredBindings`,
  `modules/index.ts`) and answers the ordinary 404. The rule keeps that true
  for any dev endpoint added outside that table.
- **`/api/health/storage`**: the container's own health check reaches it over
  loopback (§7), so nothing legitimate crosses the edge to it. Hardening on top
  of the token, which is the control.
- **A rate-limiting rule on the authentication surface** (**Rules > Security
  rules > Rate limiting rules**): `POST` with _URI Path starts with_
  `/api/auth/`, counted per IP, for example 60 requests per 10 s, then block
  for 60 s; tune it to the plan's periods and characteristics. Every captcha
  route and every password check lives under it. Behind it the application
  caps siteverify at 64 calls in flight (`lib/captcha.ts`) and password work
  at one job (`lib/auth/password/hash.ts`); past those it answers 503 with
  `Retry-After` to everyone, attacker and user alike, so a distributed flood
  is best shed here. Not verified: whether the zone's plan can count IPv6 by
  prefix; the application charges each IPv6 /48 as well as each /64.
- **During an attack**, while the access log shows a sustained 503 rate on
  `/api/auth/*` (§9), tighten that rule (a lower count, a longer block) and
  loosen it once the rate falls. **Do not** put a Managed Challenge or Under
  Attack mode on `/api/auth/*`: the dashboard calls it with `fetch`, which
  cannot show or solve the challenge page, so every sign-in would fail.
  Challenging the API needs Turnstile pre-clearance, which the front end does
  not issue today.
- **Optionally, a rate-limiting rule on `/openapi.json`.** The route already
  requires dashboard access (a live session whose role grants `view` on at
  least one page), sits behind the pre-auth IP limit, is built once per process
  and leaves `/api/dev/*` out in production; the edge rule is hardening.

These rules match on a path prefix, which holds because the `onRequest` hook in
`app.ts` answers 404 to any hostname shorter than 4 characters
(`isRoutableHost`, `lib/http/routing.ts`) before anything reads the path. The
firewall rule in step 6 stays the primary control and these the second line.

Verify, from outside the VPS (expect a Cloudflare block, not the app's 404) and
from inside the container (the image ships curl, not wget; expect the app's
own 404 JSON envelope):

```sh
curl -si https://<domain>/api/internal/x -X POST | head -1
curl -sS -i -X POST "http://127.0.0.1:${PORT:-3000}/api/internal/x"
```

### Proxy limits that must match the application

| Setting                                                        | Must be                                  | Because                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare proxy read timeout, Traefik `responseHeaderTimeout` | **> 120 s**                              | The media routes' ceiling (below). Cloudflare documents a 125 s default, configurable on Enterprise zones only, just above it; confirm the zone's value, and lower the application ceiling deliberately rather than leave it at the edge's limit.                                                                                                                                |
| Any proxy body limit (Traefik, Cloudflare)                     | **≥ 25,165,824 bytes** (24 MiB), or none | Bun's own listener limit (`SERVER_BODY_LIMIT_BYTES`, `lib/http/request.ts`), twice the application's ceiling. Between 12 MiB and 24 MiB the **application** refuses with a 413 in the API envelope and its CORS headers, and drains the unread body so a browser still uploading can read it. A proxy that cuts at or below 12 MiB answers a bare 413 the dashboard cannot show. |
| Cloudflare native upload ceiling                               | **Plan ceiling**                         | Not the application limit. The `max_upload` zone setting starts at 100 MB; an exact body-size WAF rule requires Enterprise, and then no lower than 25,165,824 bytes.                                                                                                                                                                                                             |
| Application body ceiling                                       | **12 MiB, in code**                      | `MAX_REQUEST_BODY_BYTES` (`lib/http/request.ts`): one 10 MB document plus multipart framing, checked from `Content-Length` before any body byte is read and counted again as the body streams. It reaches the two multipart routes only; images are capped at 1 MiB per file. Nothing is needed at the proxy for it.                                                             |
| JSON routes                                                    | **64 KiB, in code**                      | `MAX_JSON_BODY_BYTES` (`lib/http/request.ts`), enforced while the body streams, on the bindings and on `/api/auth/*` alike. The largest real body is a few KB. A route may raise its own with `maxJsonBodyBytes` on its binding; the published document states each route's bound. A 413 that carries the API envelope is the app's, not a proxy refusal.                        |

A proxy body limit is optional: the application and Bun already bound every
body. To refuse oversized uploads at Traefik, copy the generated
host/TLS/service settings to a higher-priority router whose rule matches both
upload routes, ``Path(`/api/upload/file`) || Path(`/api/dash/media/files`)``,
and attach only to it, through Coolify's custom labels:

```text
traefik.http.middlewares.upload-body.buffering.maxRequestBodyBytes=25165824
```

Leave the generated catch-all router in place for every other path. Coolify
controls the generated router and service names, so resolve them from the
deployment's labels rather than copying one from here, and verify the effective
labels after every proxy change. Record the value applied here once it is set.
[Traefik buffering](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/buffering/) ·
[Coolify custom middleware](https://coolify.io/docs/knowledge-base/proxy/traefik/custom-middlewares/redirects)

Through the deployed domain, test an exactly-at-limit accepted file and a
request just over 12 MiB, which must come back as the application's 413 JSON
envelope, not a proxy page, with no R2 or database work done. Above 24 MiB, do
not expect the same answer: a Traefik buffering limit answers its own 413
outside the envelope, and a local probe of Bun's listener reset the connection
instead of answering. If the application ceiling is ever raised, raise any
proxy limit with `SERVER_BODY_LIMIT_BYTES` first.

Request ceilings:

| Scope                               | Value | Where                                                      |
| ----------------------------------- | ----- | ---------------------------------------------------------- |
| Server-wide idle timeout            | 60 s  | `IDLE_TIMEOUT_SECONDS` in `server.ts`                      |
| The seven media routes listed below | 120 s | `MEDIA_ROUTE_TIMEOUT_SECONDS` in `modules/media/limits.ts` |

The seven, each of which calls R2 inside the request:

- `POST /api/upload/file`
- `POST /api/dash/media/files`
- `DELETE /api/dash/media/files`
- `DELETE /api/dash/media`
- `POST /api/dash/media/files/:id/publish`
- `POST /api/dash/media/files/:id/unpublish`
- `DELETE /api/dash/media/folders/:id`

Neither number is measured on the target VPS; they are deliberately generous.

**Capacity floor for uploads**, measured off the target host: a 25 MP image
costs ~230 MB resident. Uploads are admitted four at a time per process with
eight waiting up to 10 s and two per account (`lib/media/upload.ts`, built on
`lib/admission.ts`), and image encoding one job at a time
(`lib/media/image/optimize.ts`), so a thirteenth concurrent upload answers 503
instead of queueing CPU work; SVG work runs in a Bun Worker
(`lib/media/image/svg-jobs.ts`) with a 15 s per-job timeout and the same
admission. Re-measure latency and peak RSS on the VPS before raising either:
a second encoder slot (`ENCODER_SLOTS` in `lib/media/image/optimize.ts`)
measured about 240 MiB more peak RSS at the pixel cap
(`reports/should-ignore.md` #81), and it also takes a work-pool thread
(Topology, Host size).

**Other process-wide caps**, each answering 503 with `Retry-After` when full:
password work, one Argon2 job with 16 waiting up to 5 s
(`lib/auth/password/hash.ts`); Turnstile siteverify, 64 calls in flight with
64 waiting up to 1 s (`lib/captcha.ts`). The image sets
`BUN_CONFIG_MAX_HTTP_REQUESTS=512` (`apps/back-end/Dockerfile`): Bun runs at
most that many `fetch`es at once, in one queue every provider shares, and
the siteverify cap keeps a captcha flood to part of it. Keep the variable if
the image is ever replaced.

### HTTP behaviours a WAF or uptime check will see

- **405 with `Allow`** on a known path called with an unregistered method.
- **308 on the trailing-slash form**, every method including `OPTIONS`:
  `GET /api/health/storage/` → `308` with `Location: /api/health/storage`.
  Point monitors at the canonical path. An unknown path with a trailing slash
  is a 404.
- **`HEAD` wherever `GET` is served**, under `/api/auth` too, and `Allow` names
  it (`lib/http/routing.ts`).
- **Unknown `/api/auth/*` paths answer this API's envelope** before Better Auth
  reaches its plugins.

## 6. Single instance, update mode and shutdown

### Stop-first

Enable **Consistent Container Names** (or a custom container name) so Coolify
stops the old container before starting its replacement. Brief downtime, but no
two app versions sharing SQLite. Keep replicas at `1` and process count at `1`.
[Rolling Updates](https://next.coolify.io/docs/applications/deployments/rolling-updates)

Do not overlap releases that share `SQLITE_DIR`. Startup does not refuse a new
process while the old one holds the directory: it serves without the schedule
and takes it over within a minute of the old one exiting
(`maintenance schedule started` then appears in its log). Stop-first remains
the policy because a start-first overlap has not been exercised against
Coolify.

SQLite WAL supports same-host processes but only one writer at a time. The
boot refuses SQLite below **3.51.3**, the floor for the WAL-reset race (the fix
was backported to 3.50.7 and 3.44.6, so not every lower version is vulnerable).
The version is a property of the Bun build; §8 checks it.
[WAL-reset notice](https://www.sqlite.org/wal.html#the_wal_reset_bug)

### Stop grace period

**Set Coolify's stop grace period longer than the `shutdownTimeoutMs` in the
startup log, currently 135 s.** A shorter one kills the container mid-drain.

**Prerequisite: the server process must be PID 1.** Docker, and Coolify through
it, delivers `SIGTERM` to PID 1 only. Two ways it silently is not, both turning
every stop and redeploy into the `SIGKILL` at the end of the grace period:
starting it through `bun run start` (`bun run` does not forward signals on its
single-script path, upstream `oven-sh/bun#41478`), and a shell that waits on
the server instead of being replaced by it, hence the exec-form `CMD` in
`Dockerfile`. `--init`/`tini` does not substitute: it forwards to its direct
child, which would be the intermediate process. Verify on the built image:
`docker stop` logs `{"msg":"server stopping","signal":"SIGTERM"}` and returns in
seconds. A stop that takes the full grace period and exits **137** is this
defect, not a slow drain.

On a signal, `createShutdown` (`lib/shutdown.ts`):

1. logs `server stopping`, stops the cron so no new firing starts, and asks a
   running scheduled job to stop at its next batch or R2 call
   (`scheduled sweep cancelled`);
2. stops Bun's listener (`stopServerGracefully`), which **drains** in-flight
   requests. Each `SHUTDOWN_POLICY.gracefulStopMs` interval (table below) it
   checks again. While a request is in flight it logs
   `graceful stop still draining in-flight requests` and keeps waiting, up to
   the budget. Then it closes active connections and logs
   `graceful stop timed out, closing active connections`. Both are logged at
   `error`. The close is routine when that line carries `pendingRequests: 0`
   and `budgetExhausted: false` (a half-sent request held the stop); otherwise
   the budget expired, and a non-zero `pendingRequests` counts the requests
   that were still running and were cut;
3. waits for the scheduled job, then for queued post-response work
   (`lib/http/after-response.ts`; every anonymous OTP send enqueues its provider
   call there), both against the one deadline, `shutdownTimeoutMs`. The queue
   must stay observably empty for `AFTER_RESPONSE_SETTLE_MS` before it reports
   idle;
4. **only if both drains reported empty**: closes PostgreSQL, then the SQLite
   stores, releases the `SQLITE_DIR` ownership lock, logs `server stopped` and
   exits **0** for a signal. A store that fails to close
   (`store close failed`, then `stores did not close cleanly`), a fault at any
   point, or a failed phase makes it exit **1**;
5. **otherwise**: logs `stores left open for forced exit` and lets the
   forced-exit timer end the process at `shutdownTimeoutMs` with exit **1**.
   Deliberate: a sweep or delivery still running may touch a store.

An escaped async error (`unhandledRejection` or `uncaughtException`) logs
`unhandled fault` and takes the same path with exit **1**, so the orchestrator
restarts rather than treating it as a clean stop.

The bound is derived by `shutdownTimeoutMs()` in `lib/shutdown.ts`:
`(max(IDLE_TIMEOUT_SECONDS, MAX_ROUTE_TIMEOUT_SECONDS) + SHUTDOWN_POLICY.headroomSeconds) * 1000`.
**If a 135 s deploy window is unacceptable, the lever is the route ceilings,
not the bound**: the seven media routes at 120 s (§5), and below 75 s the 60 s
global idle timeout binds. Re-read `shutdownTimeoutMs` from the startup log
after changing either. `tests/unit/shutdown-coordinator.test.ts` asserts the
formula and drives the coordinator through each path above;
`tests/process/shutdown-lifecycle.test.ts` and
`tests/process/schedule-drain.test.ts` cover the real store close and sweep
drain.

The timing policy is `SHUTDOWN_POLICY` in `lib/shutdown.ts` plus the queue's
settle proof in `lib/http/after-response.ts`. The same unit test reads this
table and the startup-log example (§2) back, and fails when either disagrees
with the code, so prose here names the rows instead of repeating the numbers:

| Policy value                      | Current | Meaning                                                                                            |
| --------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `SHUTDOWN_POLICY.gracefulStopMs`  | 5000    | how often the listener stop re-checks; with nothing in flight it then closes half-sent connections |
| `SHUTDOWN_POLICY.headroomSeconds` | 15      | added to the longest request ceiling to form `shutdownTimeoutMs`                                   |
| `AFTER_RESPONSE_SETTLE_MS`        | 50      | how long the post-response queue must stay empty before it reports idle                            |

The derived budget depends on the routes' own timeouts as well, so it is not in
the table; the startup log is authoritative when this page disagrees.

## 7. Configure health check

**Type: CMD, not HTTP.** The route requires `x-maintenance-token` on every
request, and an HTTP-type check has no header field. A CMD check runs inside the
container with the container's environment, so it can send the token the
deployment already holds.

| Field        | Value |
| ------------ | ----- |
| Enabled      | Yes   |
| Type         | `CMD` |
| Interval     | `30s` |
| Timeout      | `5s`  |
| Retries      | `5`   |
| Start period | `30s` |

Command:

```sh
bun scripts/healthcheck.ts
```

`scripts/healthcheck.ts` reads `PORT` and `SQLITE_MAINTENANCE_TOKEN` from the
container's environment, calls the route over loopback with a 4 s deadline, and
exits 1 on anything but a 2xx, printing why.

> ⚠️ **A `curl` command with the token cannot be used here.** Coolify validates
> the command against `^[a-zA-Z0-9 \-_.\/:=@,+]+$`: the `"`, `$` and `|` a
> `curl -H "x-maintenance-token: $SQLITE_MAINTENANCE_TOKEN" … || exit 1` line
> needs are refused in the form, and at deploy time the same check falls back to
> a token-less HTTP probe, which answers 401 forever. The script's command passes
> that check.

> ⚠️ **An HTTP-type check marks the container unhealthy forever.** It sends no
> token, so every poll answers 401. A deploy that never turns healthy while the
> log shows `maintenance token rejected` with `reason: "absent"` is this
> mistake.

[Coolify health checks](https://coolify.io/docs/knowledge-base/health-checks) ·
[generator source](https://github.com/coollabsio/coolify/blob/v4.x/app/Jobs/ApplicationDeploymentJob.php#L3239-L3283)

The route opens (and on first call migrates) `rate-limit.db`, reads back its
PRAGMAs and checks PostgreSQL. It answers 200 `{"status":"ok","checks":{...}}`
only when every check holds, 503 `{"status":"degraded","checks":{...}}` when
one fails, 503 `{"status":"error"}` when the probe itself throws, and 401
`{"status":"unauthorized"}` without the token. Whatever the type, Coolify
decides health from the command's exit status; the external smoke test in §8
asserts exact statuses.

| Check               | Requires                                                          |
| ------------------- | ----------------------------------------------------------------- |
| `journalModeWal`    | `journal_mode` is `wal`                                           |
| `schemaVersion`     | `user_version` equals the running build's schema version          |
| `busyTimeout`       | `busy_timeout` is exactly `2000`, the value, not merely "set"     |
| `synchronousNormal` | `synchronous` is `1` (`NORMAL`)                                   |
| `postgres`          | a bounded `SELECT 1` answered within 2 s, and the app pool usable |

`busyTimeout` and `synchronousNormal` compare exact values because a database
opened by something else (an older build, a manual `sqlite3` session that
rewrote a persistent pragma) can be usable yet not configured the way the
limiter's latency and durability assumptions require.

Deliberately cheap enough to poll every 30 s: PRAGMA reads plus PostgreSQL. It
does not run `quick_check` and **does not write to SQLite**: either would put
the health check in write-lock contention with the limiter (§4). For the same
reason the route has no limiter of its own; the token is why it needs none. It
reports status only: no paths, schema contents or row counts.

To diagnose by hand, from inside the container (the deep variant adds
`quick_check` and a write probe, and must never be the polled check):

```bash
curl -sS -H "x-maintenance-token: $SQLITE_MAINTENANCE_TOKEN" \
  "http://127.0.0.1:${PORT:-3000}/api/health/storage"
curl -fsS -H "x-maintenance-token: $SQLITE_MAINTENANCE_TOKEN" \
  "http://127.0.0.1:${PORT:-3000}/api/health/storage?deep=1"
# {"status":"ok","checks":{...,"quickCheck":true,"writable":true}}
```

**Two blind spots.** `cache.db` is never touched, which is acceptable while the
cache has no call sites. A mounted volume is not proven: SQLite creates the same
path in the container layer just as happily. Only §8 settles that.

**The application pool, and the restart it relies on.** The `SELECT 1` runs on
the probe's own one-connection pool, which cannot see the application's. Bun's
pool can wedge when its connections are killed while it reconnects (a
PostgreSQL restart or failover, measured on Bun 1.4.3): every query then fails
at once, for good, while the probe still answers. So `postgres` also fails when
either application pool (the main one or the data-table list pool) is wedged,
and a watchdog in `server.ts` checks them every 30 s and, still wedged 5 s
later, logs `database pool unusable` and exits with code 1.

⚠️ **Recovery depends on the restart policy, not on this health check.**
Coolify only takes an unhealthy container out of Traefik's routing; it never
restarts one. Docker restarts a container that EXITS when its policy says so,
and Coolify applies `unless-stopped`. Keep a policy that restarts on a non-zero
exit; with `no`, a wedged pool becomes a stopped container. Measured, wedge to
exit took 23–28 s.

**Keep `Timeout` at 5 s and `Retries` at 5.** The cheap path runs its two
PostgreSQL checks one after the other, each raced against 2 s (`pingDatabase`,
then `applicationPoolUsable` in `db/index.ts`), so a slow but reachable database
can hold one poll for about 4 s, the script's own deadline, and SQLite writer
contention (§4) delays the poll with everything else. Five retries at 30 s mean
a single slow poll cannot flip the container.

## 8. First deploy and verification

Deploy manually. Keep auto-deploy off until the final checklist passes.

### Runtime

```sh
bun --version
bun -e 'const {Database}=require("bun:sqlite");const d=new Database(":memory:");console.log(d.query("select sqlite_version() as v").get());d.close(false)'
```

Expect Bun 1.4.4 and SQLite ≥ 3.51.3. **Record the SQLite version**: it is a
property of the Bun build, as are the WebP/PNG codecs and the image resampler.
One native addon is on the request path, `argon2`, loaded on every password
verify.

### Storage

```sh
test "$SQLITE_DIR" = /app/data
test -d /app/data
test -w /app/data
# the image ships curl, not wget; the route needs the token (§7)
curl -sS -H "x-maintenance-token: $SQLITE_MAINTENANCE_TOKEN" \
  "http://127.0.0.1:${PORT:-3000}/api/health/storage"
ls -la /app/data
bun - <<'BUN'
const { Database } = require('bun:sqlite');

if (process.env.SQLITE_DIR !== '/app/data') {
  throw new Error('SQLITE_DIR must be exactly /app/data');
}
const file = '/app/data/rate-limit.db';
// readonly implies no create, so a missing file fails here rather than being
// silently created.
const db = new Database(file, { readonly: true });
const one = (sql) => Object.values(db.query(sql).get() ?? {})[0];
try {
  console.log({
    file,
    sqliteVersion: one('select sqlite_version() as v'),
    journalMode: one('PRAGMA journal_mode'),
    userVersion: one('PRAGMA user_version'),
    quickCheck: one('PRAGMA quick_check'),
    tables: db
      .query("select name from sqlite_schema where type='table' order by name")
      .all(),
  });
} finally {
  db.close(false);
}
BUN
```

Expected: readiness `{"status":"ok"}` with every check `true`; `journalMode`
`wal`; `userVersion` `3`; `quickCheck` `ok`; tables include `rate_limit`.
WAL/SHM sidecars may exist while a connection is open. `cache.db` may be
absent. `.writer-lock.db` is present: the schedule ownership marker (§4).

### Persistence proof

Database counters cannot prove persistence: a new database recreates the same
keys. Use a sentinel file.

```sh
bun - <<'BUN'
const fs = require('node:fs');
const crypto = require('node:crypto');
const file = '/app/data/.coolify-volume-sentinel';

if (process.env.SQLITE_DIR !== '/app/data') {
  throw new Error('SQLITE_DIR must be exactly /app/data');
}
const value = crypto.randomUUID();
fs.writeFileSync(file, `${value}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
console.log(value);
BUN
```

Record the value, redeploy the same release, then:

```sh
test "$SQLITE_DIR" = /app/data
cat /app/data/.coolify-volume-sentinel
```

The exact value must survive. If it is missing or changed, stop: the volume
destination and `SQLITE_DIR` disagree, or storage is not persistent. Repeat
after changing storage, host, application UUID or the restore procedure. Keep
the sentinel and record its value with the release commit: it turns "is this
still the same volume?" into a one-command answer. Nothing reads it
automatically.

### The first administrator

Nothing else creates one in production: `/api/dev/sign-up` is registered under
`NODE_ENV=development` alone. Once, after `db:migrate` has run, open the
back-end application's **Terminal** in Coolify (it starts in
`/app/apps/back-end` with the container's environment) and run:

```sh
bun run create-admin --email=owner@gmail.com --name="Owner Name"
```

- The email must be at a provider domain `emailSchema` accepts
  (`EMAIL_PROVIDER_DOMAINS` in `shared/validation/rules.ts`).
- Add `--phone=05XXXXXXXX` when `PHONE_NUMBER_MODE` is `required`, or when
  `REQUIRE_PHONE_VERIFICATION` is on with a phone OTP channel enabled
  (`packages/shared/src/config.ts`); the script refuses without it there.
- It creates a `system` role holding every permission, an active user on it,
  the credential account and one audit row (`api_path`
  `internal/create-admin`, `actor: bootstrap`) in one transaction, under an
  advisory lock that makes a concurrent second run wait and then refuse.
- The password is generated and printed **once**, on stdout. A terminal
  command's output is not PID 1's, so it should not reach the container log
  (not verified on Coolify). Store it in a password manager, sign in, change it
  from the account page, then enrol a second factor. Nothing forces the
  change: the application has no "must change password" state.
- Contacts are stored unverified. With `REQUIRE_EMAIL_VERIFICATION` on and an
  email OTP channel enabled, the first sign-in answers `EMAIL_NOT_VERIFIED` and
  the dashboard asks for a code, so email delivery must work first.

Exit codes: `0` created; `2` invalid input, or an email or phone another user
holds; `3` an administrator already exists (any live `system` user, active or
not); `1` a configuration or database failure. `2` and `3` write nothing, so a
repeated run is safe and prints
`An administrator already exists. Nothing was changed.` A `1` from the
database can come after the commit reached it (a dropped connection while
committing): if a rerun then exits `3`, check that the `system` user is the one
you created (`internal/create-admin` in `audit_logs`), whose password was never
shown. Reset it through the dashboard's password recovery, which needs `email`
in `NEXT_PUBLIC_ENABLED_OTP_CHANNELS` and working SMTP (or a phone channel and
`--phone`); without one, recovering it is a database task.

### External smoke checks

- **PostgreSQL is reachable from the container**: `checks.postgres` in the
  health body. The endpoint proves reachability from INSIDE the container only,
  so also check it once from outside.
- **Turnstile, R2 and every enabled OTP provider work** (§3, "Outbound
  connections"). Readiness touches no provider, so send one real code through
  each enabled OTP channel (a contact verification from a test account is
  enough) and confirm it arrives. A delivery failure shows only in the log:
  `otp.provider.failed` (for email with an `smtpCode`; `EAUTH` is Gmail refusing
  the login: a wrong account or app password, or a Workspace policy that blocks
  SMTP), `otp.provider.rejected`, `otp.provider.unparsable` (a WhatsApp 2xx
  that is not JSON) or `otp.delivery.unexpectedError` (an SMS or WhatsApp call
  that failed on the network or timed out: check egress first).
- `GET /api/auth/get-session` answers exactly HTTP 200.
- `GET /openapi.json` answers **401** to an anonymous caller, with a JSON body
  and no `"paths"`. A 200 means the gate is off; an HTML 404 means the path is
  routed to the front-end (§2).
- The HTTPS certificate is valid through Cloudflare, and the origin IP is
  blocked on 80/443 when called directly.
- A protected request through the domain does not log `missing client ip
headers`.
- Sign-in, a session, and one non-delivery API flow work.
- Coolify shows exactly one running app container.

### Checks only Linux or Docker can answer

The development machine is Windows with no Docker, so these were proven only as
far as that allows. Run them once on the VPS, or on any Ubuntu 24 host with
Docker, and record the output next to the release commit.

**a. The image builds.** CI's `image` job builds `apps/back-end/Dockerfile`
from the repository root on every push; Coolify's first build is the same
proof on the VPS. By hand, from the repository root:

```sh
docker build -f apps/back-end/Dockerfile --target verify -t back-end:verify .
docker build -f apps/back-end/Dockerfile -t back-end:check .
```

**b. The process is not root.** This must print `1000`, the UID §4's ownership
rules name (CI's `image` job asserts the same):

```sh
docker run --rm --entrypoint id back-end:check -u
```

**c. A crafted `.xls` asks the parser for 4 GiB (latent).** `.doc`/`.xls` are
disabled uploads (`DISABLED_FILE_TYPES`), so this matters before either is
re-enabled. On Windows, a 2 048-byte file whose `Workbook` entry claims
`0xFFFFFFF0` bytes made `detectCompoundFile` construct
`new Uint8Array(4294967280)` and answer `container` in 2 ms with no RSS growth,
because the pages were never touched. On Linux the answer depends on
`vm.overcommit_memory` and the container's memory limit: the allocation may
succeed lazily, fail with a `RangeError`, or be OOM-killed. Inside the running
container (`/app/apps/back-end`), with `cat /proc/sys/vm/overcommit_memory`
recorded first:

```sh
cd /app/apps/back-end && bun - 4294967280 <<'BUN'
let largest = 0;
const U8 = Uint8Array;
globalThis.Uint8Array = new Proxy(U8, { construct(t, a) { if (typeof a[0] === 'number' && a[0] > largest) largest = a[0]; return Reflect.construct(t, a); } });
const { detectCompoundFile } = await import(`${process.cwd()}/lib/media/office/cfb.ts`);
const claimed = Number(process.argv.at(-1));
const b = new U8(2048), v = new DataView(b.buffer);
b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
v.setUint16(24, 0x3e, true); v.setUint16(26, 3, true); v.setUint16(28, 0xfffe, true); v.setUint16(30, 9, true); v.setUint16(32, 6, true);
v.setUint32(44, 1, true); v.setUint32(48, 1, true); v.setUint32(56, 4096, true); v.setUint32(60, 0xfffffffe, true); v.setUint32(68, 0xfffffffe, true);
for (let i = 1; i < 109; i++) v.setUint32(76 + i * 4, 0xffffffff, true);
for (let i = 0; i < 128; i++) v.setUint32(512 + i * 4, i === 0 ? 0xfffffffd : i < 3 ? 0xfffffffe : 0xffffffff, true);
const entry = (at, name, type, start, size) => { for (let i = 0; i < name.length; i++) v.setUint16(at + i * 2, name.charCodeAt(i), true); v.setUint16(at + 64, (name.length + 1) * 2, true); b[at + 66] = type; for (const o of [68, 72, 76]) v.setUint32(at + o, 0xffffffff, true); v.setUint32(at + 116, start, true); v.setUint32(at + 120, size, true); };
entry(1024, 'Root Entry', 5, 0xfffffffe, 0); entry(1152, 'Workbook', 2, 2, claimed);
const t0 = performance.now(), r0 = process.memoryUsage().rss;
let result; try { result = detectCompoundFile(b, 'excel'); } catch (e) { result = { threw: String(e) }; }
console.log(JSON.stringify({ platform: process.platform, bun: Bun.version, result, ms: Math.round(performance.now() - t0), largestAllocation: largest, rssDeltaMB: Math.round((process.memoryUsage().rss - r0) / 2 ** 20) }));
BUN
```

Windows result for comparison:
`{"result":{"ok":false,"reason":"container"},"ms":2,"largestAllocation":4294967280,"rssDeltaMB":1}`.
A `threw: RangeError…` result means an upload would escape as a 500; a killed
process (exit 137, no output) means one upload restarts the container. The fix
is `Math.min(entry.size, limit, bytes.length)` in `readStream`; after it,
`largestAllocation` must be `2048`.

**d. The anonymous OTP floor on this host.** Every anonymous OTP answer that
follows the account lookup waits until `MINIMUM_RESPONSE_MS` after it, and the
work only a known account does is cut `FLOOR_SETTLE_MS` before that (both in
`lib/http/timing-floor.ts`), so contention cannot make a known identifier
answer later, as long as the cut, the rollback and the answer fit in
`FLOOR_SETTLE_MS`. That assumes a database round trip far below it, which the
harness, with PostgreSQL on the same machine, cannot show for the VPS. Run the
timing suite on a host sized like the VPS, against a throwaway PostgreSQL of
the same version and network distance, never against the production server
(the harness creates and drops databases):

```sh
bun run test:integration otp-timing-oracle
```

It must pass. A known identifier answering late in its contention cases means
the round trip does not fit: raise `FLOOR_SETTLE_MS`.

## 9. Scheduled jobs and alerting

**There is nothing to configure in Coolify.** Every scheduled job runs inside
the application process on `Bun.cron` (`lib/maintenance/schedule.ts`). No
Coolify scheduled task and no `/api/internal/*` route exists for them.

| Job                         | Expression     | Zone | Acts on                             |
| --------------------------- | -------------- | ---- | ----------------------------------- |
| `sqlite-expiry-sweep`       | `*/15 * * * *` | UTC  | `rate-limit.db`, per volume         |
| `verification-expiry-sweep` | `*/15 * * * *` | UTC  | PostgreSQL `verifications`, elected |
| `database-retention-sweep`  | `30 3 * * *`   | UTC  | PostgreSQL and R2, elected          |
| `object-store-reconcile`    | `0 4 * * 0`    | UTC  | R2, read-only report, elected       |

The zone is passed explicitly: Bun 1.4 interprets cron expressions in local
time, and nothing pins this container's zone.

`verification-expiry-sweep` runs every 15 minutes because an anonymous caller
writes two `verifications` rows per Google sign-in start, past a captcha only,
faster than one nightly ceiling reclaims them. `object-store-reconcile` lists
each bucket under the application's key prefix, up to 200 000 keys, HEAD-checks
at most 200 suspects per bucket (`lib/media/reconcile.ts`), and logs
`object store reconciled` with its report; it deletes nothing, and each run
starts over, so its `hasMore` is read from the report, not cured by running it
more often.

**One runner per firing.** Only the process owning `SQLITE_DIR` registers the
schedule (§4). The jobs acting on PostgreSQL or R2 are elected again per firing
with a PostgreSQL session advisory lock (`lib/maintenance/election.ts`), so
replicas on separate volumes do not both run them; the loser logs
`scheduled sweep skipped`. While a shared job runs, its lock holds one of the
pool's connections. `Bun.cron` never overlaps a job with itself. On shutdown the
running job is aborted at its next batch or R2 call and drained within the
shutdown budget (§6); if it cannot drain, the process exits without closing
stores under it (`sweep drain timed out`).

### What to alert on

The log stream replaces an external scheduler's failure alerting. One line per
run:

```
{"msg":"scheduled sweep completed","job":"sqlite-expiry-sweep","status":"ok","durationMs":12,"hasMore":false}
{"msg":"scheduled sweep degraded","job":"database-retention-sweep","status":"degraded","durationMs":12,"hasMore":true}
{"msg":"scheduled sweep failed","job":"database-retention-sweep","errorClass":"..."}
{"msg":"scheduled sweep cancelled","job":"verification-expiry-sweep","reason":"shutting down"}
```

A run logs only `status`, `durationMs` and `hasMore`, not per-table counts.

- **`scheduled sweep failed`**: alert on any occurrence. `"errorClass":
"ConnectionTimeoutError"` on an elected job means it waited
  `POOL_ACQUIRE_TIMEOUT_MS` for its lock's connection: the application pool
  was exhausted or PostgreSQL unreachable (§3.1c).
- **`scheduled sweep degraded`**: alert on any occurrence. The job returned,
  but a store it was asked to sweep was not swept.
- **`hasMore: true` on consecutive runs of the same job**: alert. A single
  occurrence trips whenever a final batch happened to be exactly full.
- **No `scheduled sweep completed` for a job over its period**: alert. With
  more than one replica, aggregate across them.
- **`scheduled job lock lost`**: alert on any occurrence. The session holding a
  job's PostgreSQL lock ended mid-run, so another replica may have run the job
  at the same time.
- **`writer lock claim failed`**: alert. A process waiting to take the schedule
  over cannot open the SQLite directory.
- **`database pool unusable`**: alert; the process exits and relies on the
  restart policy (§7).
- **`otp.verify.deadlineExceeded`**: alert on a steady rate. Each line is an
  anonymous verify cut at its deadline and answered as a wrong code, possibly a
  right one: the floor leaves a real verify too little time on this host
  (§8 d). Raise `KNOWN_BRANCH_WORK_MS` (`lib/http/timing-floor.ts`), which
  moves the floor and the cut together.
- **`captcha.siteverify failed` with `errorCodes`**: alert on any occurrence.
  `invalid-input-secret` or `missing-input-secret` means `TURNSTILE_SECRET_KEY`
  is wrong, and every sign-in and OTP request is being refused.
- **`captcha.siteverify failed` with `timedOut` or `status`**: alert on a
  steady rate. Cloudflare's siteverify is slow or failing, and each such
  request answers 403 to a real user.
- **A sustained 503 rate in the access log** on `/api/auth/*` or the upload
  routes: the password, siteverify or upload caps are full. A flood (§5, the
  attack lever) or a host too small for the traffic (Topology).
- **`hibp.degraded`**: an attempt of the breached-password check failed; after
  the last one the password is accepted unchecked (`reports/should-ignore.md`
  #52).
- **`scheduled sweep cancelled`**: not an alert. Shutdown aborted the run; the
  next firing takes the rest.

`maintenance schedule started` is logged once by the owning process, at boot or
at takeover, with each job's next fire time: the fastest confirmation that a
deploy scheduled anything. `maintenance schedule not started` is expected only
while another process owns the directory.

### The ceilings behind `hasMore`

Expiry is checked on read, so a missed sweep does not resurrect expired data;
it grows stale rows and disk.

- **The SQLite sweep** walks the whole of `rate-limit.db` every run, 500 rows
  per statement, yielding between statements (`lib/sqlite/sweep.ts`). It
  reports `hasMore: true` only when shutdown cut the pass short.
- **The PostgreSQL expiry sweeps** (sessions, verification sessions and codes,
  OTP challenges, trusted devices, `verifications`) delete 500 rows per
  statement and at most 40 statements per table per run
  (`lib/maintenance/database.ts`): **20 000 rows per table per run**, which
  sustained creation can outrun. If an expiry sweep's `hasMore` trips on
  consecutive runs, raise its frequency in `lib/maintenance/schedule.ts` rather
  than waiting for the disk alert.
- **The media steps of the nightly pass**: up to 1 000 files being deleted
  (`lib/media/lifecycle.ts`), 1 000 stale visibility transitions
  (`lib/media/visibility.ts`), 100 orphaned-object demands
  (`lib/media/orphaned-objects.ts`) and unfiled files reaped 100 at a time.

### The retention sweep is the load-bearing one

**Nothing else ever deletes a temporary upload**, so unswept R2 objects
accumulate and are billed indefinitely. A failed R2 delete makes the run
report `scheduled sweep degraded` with a `media.delete objects failed` line
beside it: check the R2 credentials, not the database. Rows stay in place in
that state, so nothing is orphaned while it is broken. The sweep deliberately
does not touch `audit_logs` or user rows (recorded on those tables in
`db/schema.ts`).

**`orphaned_objects` is a work queue, and a non-empty one is an alert.** A row
there is an R2 object whose `files` row is gone and whose delete or public-URL
purge was refused. The retention pass drains it and reports `degraded` while
any row survives, so the alert above covers it; if rows persist across runs,
check the store and the Cloudflare purge token. In normal operation the table
is empty.

Do not schedule `VACUUM`, and never remove a `-wal` file by hand while the
database is open.

## 10. Monitoring, backup and restore

Enable Coolify notifications for deployment failure, container status and
**server disk usage**.
[Notifications](https://coolify.io/docs/knowledge-base/notifications/)

### Container logs: rotation and retention

The app writes one access line per request (about 85 bytes for a refusal,
`lib/http/after-response.ts`) to stdout, which Docker's `json-file` driver
keeps on the host. Unrotated, a flood at 1,000 requests a second writes about
7 GB a day; rotated at the commonly installed 10 MB × 3, the same flood pushes
the incident's error lines out within minutes. Check what applies, on the VPS:

```sh
docker inspect --format '{{json .HostConfig.LogConfig}}' <back-end container>
cat /etc/docker/daemon.json
```

Set rotation large enough to hold an incident, for example
`max-size=100m`, `max-file=5` for this container (Coolify's custom Docker
options), or ship the logs off the host and keep local rotation small. Record
the value applied here.

### Peak WAL size: `journal_size_limit` does not bound it

The 64 MiB setting bounds the size a WAL is **truncated to when a checkpoint
completes**; it is not a growth ceiling. While checkpointing is blocked the WAL
grows without limit: measured at **1.36 GB** with one connection holding an
open read snapshot, and 745–906 MB under saturating writes from several
processes. The application never holds a read transaction open, so the
realistic trigger is sustained concurrent writes, one more reason this
deployment keeps one process.

- The disk-usage notification is the backstop. Include the sidecars:
  `ls -la /app/data` and `du -sh /app/data`.
- If `rate-limit.db-wal` is _persistently_ large, a checkpoint is blocked.
  Reclaim it manually, but **this command takes the writer lock** (§4): run it
  in a maintenance window, never on a schedule and never as a reflex during an
  incident:

  ```sh
  bun -e 'const {Database}=require("bun:sqlite");const d=new Database("/app/data/rate-limit.db");console.log(d.query("PRAGMA wal_checkpoint(TRUNCATE)").get());d.close(false)'
  ```

- **Do not respond by raising `busy_timeout`.** That trades errors for longer
  synchronous event-loop stalls and adds no writer fairness.

### Limiter checkpoint stall: measure it once on this disk

`rate-limit.db` runs `synchronous = NORMAL`, so SQLite's auto-checkpoint runs
inside whichever limiter commit fills the WAL interval, on the event loop. On
the development machine that commit took tens of milliseconds, once per
650–1 000 admissions
(`reports/should-ignore.md` #80). Measure it once inside the running container,
in a quiet hour: it makes 40 000 admissions on a throwaway database in a new
directory under `/app/data`, never to the live `rate-limit.db`, and deletes the
directory afterwards.

```sh
cd /app/apps/back-end && D=$(mktemp -d /app/data/probe-wal-XXXXXX) && SQLITE_DIR="$D" bun - <<'BUN'
const { getRateLimitStore, admitWindow, closeRateLimitStore } = await import(`${process.cwd()}/lib/rate-limit/store.ts`);
const store = getRateLimitStore();
for (const synchronous of ['NORMAL', 'OFF']) {
  store.db.pragma(`synchronous = ${synchronous}`);
  store.db.exec('DELETE FROM rate_limit');
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const ms = [];
  for (let i = 0; i < 20000; i++) {
    const now = Date.now(), start = now - (now % 60000), t = performance.now();
    admitWindow(store, { key: `probe:${i}`, windowStart: start, cost: 1, expiresAt: start + 60000, limit: 1e9 });
    ms.push(performance.now() - t);
  }
  const slow = ms.filter((x) => x > 5);
  ms.sort((a, b) => a - b);
  console.log(JSON.stringify({ synchronous, p50: +ms[10000].toFixed(3), p999: +ms[19980].toFixed(1), max: +ms.at(-1).toFixed(1), over5ms: slow.length, over5msTotal: Math.round(slow.reduce((a, b) => a + b, 0)) }));
}
closeRateLimitStore();
BUN
rm -rf "$D"
```

It prints one line per setting; `over5ms` counts the stalled admissions and
`over5msTotal` sums them. Each setting starts from an empty table, so `OFF` is
the same run without fsyncs, the setting the owner declined. Two runs on the
loaded Windows development machine (2026-10-31), for comparison:
`{"synchronous":"NORMAL","p50":0.059,"p999":13.7,"max":19.8,"over5ms":26,"over5msTotal":386}`
and
`{"synchronous":"NORMAL","p50":0.058,"p999":43.3,"max":99,"over5ms":29,"over5msTotal":1309}`.
A NORMAL line far above those reopens #80.

### Backup policy

Coolify's instance backup does not include application volumes, and its managed
database backup covers database _resources_, not an arbitrary app volume.
[Backup/restore scope](https://coolify.io/docs/knowledge-base/how-to/backup-restore-coolify) ·
[Managed database backups](https://coolify.io/docs/databases/backups)

- **PostgreSQL:** back it up through whatever owns that server; self-hosted
  means a backup you own and schedule. **Schedule the restore too:**
  periodically restore the latest backup into a scratch database, run
  `bun run db:migrate` against it (its ledger checks refuse a schema the code
  does not match), and compare row counts of the core tables. Record how long
  the restore took; that is the real recovery time.
- **`cache.db`:** never back up; rebuild it.
- **`rate-limit.db`:** data expires within a day, but loss resets the paid OTP
  daily cap. Choose an explicit RPO: no backup plus OTP shutdown after host
  loss, periodic online backup, or a durable shared store.
- **Treat the limiter database, its sidecars and every backup as sensitive.**
  They contain raw IP addresses, email addresses and phone numbers. Restrict to
  the runtime/backup identity, encrypt at rest and in transit, and keep a short
  retention consistent with the rate-limit window and legal requirements.

Never copy a live `.db` alone: committed data may still be in the WAL. Mount a
restricted staging filesystem **outside** `/app/data`, expose it as the
runtime-only `SQLITE_BACKUP_DIR`, and check host capacity first. Use
`VACUUM INTO`: `bun:sqlite` has no driver backup call, and `VACUUM INTO` is
read-only with respect to the source, safe against a live writer, and produces
a standalone database with no WAL to replay. It is a **reader**, so it does not
trip the writer contention in §4, but it holds a read snapshot for its whole
duration, which blocks checkpointing: watch `/app/data` size while it runs on a
large database. It refuses to overwrite an existing file, which is what makes
the `.partial` staging safe.
[VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuuminto)

```sh
bun - <<'BUN'
const { Database } = require('bun:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.umask(0o077);

const dir = process.env.SQLITE_DIR;
const backupDir = process.env.SQLITE_BACKUP_DIR;
if (dir !== '/app/data') throw new Error('SQLITE_DIR must be exactly /app/data');
if (!backupDir) throw new Error('SQLITE_BACKUP_DIR is required');

const dataReal = fs.realpathSync(dir);
const backupReal = fs.realpathSync(backupDir);
const relative = path.relative(dataReal, backupReal);
// By path component: `..backups` is a child, not a parent.
const outside =
  relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
if (!outside) throw new Error('SQLITE_BACKUP_DIR must be outside /app/data');

const source = path.join(dir, 'rate-limit.db');

const stamp = new Date().toISOString().replaceAll(':', '-');
const suffix = crypto.randomUUID();
const destination = path.join(backupReal, `rate-limit-backup-${stamp}-${suffix}.db`);
const partial = `${destination}.partial`;

// VACUUM INTO takes a string LITERAL, not a bound parameter, so the path is
// escaped by SQL rules: a single quote is doubled.
const sqlPath = (value) => `'${value.replaceAll("'", "''")}'`;

try {
  // readonly implies no create, so a missing source fails here rather than
  // silently producing a backup of an empty database.
  const db = new Database(source, { readonly: true });
  try {
    // The logical size, WAL pages included, which is what VACUUM INTO writes;
    // the main file's size alone can miss pages still in the WAL.
    const one = (sql) => Number(Object.values(db.query(sql).get() ?? {})[0]);
    const logicalBytes = one('PRAGMA page_count') * one('PRAGMA page_size');
    const stats = fs.statfsSync(backupReal);
    const availableBytes = stats.bavail * stats.bsize;
    const requiredBytes = Math.max(logicalBytes * 2, 128 * 1024 * 1024);
    if (availableBytes < requiredBytes) {
      throw new Error(`insufficient backup space: need ${requiredBytes} bytes`);
    }
    db.run(`VACUUM INTO ${sqlPath(partial)}`);
  } finally {
    db.close(false);
  }

  const check = new Database(partial, { readonly: true });
  try {
    const row = check.query('PRAGMA quick_check').get();
    if (Object.values(row ?? {})[0] !== 'ok') {
      throw new Error('SQLite backup quick_check failed');
    }
  } finally {
    check.close(false);
  }

  fs.chmodSync(partial, 0o600);
  fs.renameSync(partial, destination);
  console.log(destination);
} catch (error) {
  fs.rmSync(partial, { force: true });
  console.error(error);
  process.exitCode = 1;
}
BUN
```

Copy the completed file off the VPS over an encrypted channel into encrypted
storage, verify its checksum, then remove the staging copy. A second volume on
the same VPS is not a disaster backup.

### Restore

Restore only from a verified standalone backup. Once the application is stopped
its Coolify Terminal is unavailable, so arrange SSH access or a reviewed
one-shot maintenance container mounting the same named volume **before**
starting. Resolve and record the exact volume/resource UUID; do not guess from a
partial Docker volume name.

1. Stop the app and confirm no process holds the volume. Stopping it drains the
   scheduled jobs (§9).
2. Archive the current `rate-limit.db`, `-wal` and `-shm` **together**. Do not
   leave stale sidecars beside the replacement.
3. Verify the backup with `quick_check`, place it as `/app/data/rate-limit.db`,
   and apply runtime UID ownership (`1000:1000`) plus mode `0600`.
4. Do not restore the cache database.
5. Start one container, run health and `quick_check`, verify `user_version`,
   then reopen traffic.

**Rolling back a release:** an image rollback reverses neither volume contents
nor the PostgreSQL schema, and there are no down migrations. Roll back only to a
release that accepts the current schemas; use stop-first; never restore an older
SQLite backup merely to roll code back. A SQLite schema change needs a
backward-compatible expand/contract design or accepted downtime: the
`user_version` guard checks only when a process opens the database, so an
already-open old process does not re-check after a new container migrates it.
After any rollback, rerun health, sign-in and session, rate-limit persistence
and the Cloudflare-header checks (§8) before reopening traffic.
[Rollbacks](https://coolify.io/docs/applications/#rollbacks)

Practice on staging. For moving named volumes between hosts, follow
[Coolify application migration](https://coolify.io/docs/knowledge-base/how-to/migrate-apps-different-host).

## 11. Object storage for the media library (Cloudflare R2)

None of this has been executed against Coolify.

### Buckets and token

Two R2 buckets, one per visibility: `dash-public` and `dash-private`. A custom
domain publishes a WHOLE bucket (Cloudflare offers no per-object or per-prefix
restriction), which is why public and private objects cannot share one.

Create an R2 API token with **Object Read & Write** on both buckets: a
read-only token lists fine and fails the first upload with `AccessDenied`
(measured). Delete the read-only token issued during development on
2026-09-04.

The library (`POST /api/dash/media/files`) needs the private bucket: a
deployment with only `dash-public` answers 422 to library uploads and accepts
uploads only through purposes declared `public` in code. Every upload goes
through the application, so neither bucket needs a CORS rule; if a later
change introduces direct-to-R2 uploads or `fetch()` downloads, add one in the
Cloudflare console (the API token cannot: measured `AccessDenied` on
`GetBucketCors`).

### Public custom domain

Attach a custom domain on the Cloudflare zone to `dash-public` and set it as
`R2_PUBLIC_URL` (scheme + host, no path, no trailing slash).

- **Not `r2.dev`.** Cloudflare documents the `r2.dev` URL as rate-limited and
  for development only; the boot logs `r2.public-url is an r2.dev development
URL` in production and otherwise accepts it.
- **Cookie-isolated from the dashboard host.** The public bucket serves
  sanitised SVG inline. Put it on a separate registrable domain, or at least a
  host that shares no cookie scope with the application origin.
- Public images are cached under
  `Cache-Control: public, max-age=31536000, immutable`, public documents under
  `public, max-age=3600` (`lib/media/headers.ts`). A deleted or unpublished
  object is always removed from the origin; an edge copy is evicted only when
  the purge below is configured, and a copy already in a browser stays readable
  until its lifetime elapses.
- **Full request body buffering on the upload routes**, where the plan offers
  it (**Rules > Configuration Rules**, _Request body buffering_: Full, for
  `/api/dash/media/files` and `/api/upload/file`). The origin then reads an
  upload at Cloudflare's speed rather than the client's, inside the app's 100 s
  body deadline (`UPLOAD_BODY_DEADLINE_MS`, `lib/media/upload.ts`). Not verified
  on this zone; without it a 10 MiB document needs about 0.8 Mbit/s of upload.
- **Ignore the query string at the edge.** A random `?x=` misses the cache and
  becomes an R2 read (billed per operation). No public URL the app issues
  carries a query, so add a Cache Rule on the public host with _Cache key:
  ignore query string_, and a rate-limiting rule on the same host for misses.

### Environment

| Variable                                                    | Value                                    | Rule                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `R2_PUBLIC_BUCKET`                                          | `dash-public`                            | Optional; enables the `public` visibility and the `publish` action.                                                                                                                                                                                                                                                                                                                                                           |
| `R2_PUBLIC_URL`                                             | `https://<custom domain>`                | Required whenever `R2_PUBLIC_BUCKET` is set in production. Must be an https origin with no path/query/credentials, in every environment.                                                                                                                                                                                                                                                                                      |
| `R2_PRIVATE_BUCKET`                                         | `dash-private`                           | Optional; enables the `private` visibility. Every upload lands here by default.                                                                                                                                                                                                                                                                                                                                               |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | from the token above                     | Required when any bucket is set.                                                                                                                                                                                                                                                                                                                                                                                              |
| `CLOUDFLARE_ZONE_ID`                                        | zone of the custom domain                | Optional. Both purge variables or neither.                                                                                                                                                                                                                                                                                                                                                                                    |
| `CLOUDFLARE_CACHE_PURGE_TOKEN`                              | API token with `Zone → Cache Purge` only | Optional. When set, deleted and unpublished public objects are purged by URL (best effort, logged).                                                                                                                                                                                                                                                                                                                           |
| `CLOUDFLARE_PURGE_BATCH_SIZE`                               | `100` (default)                          | Optional. URLs per purge call, a decimal integer from 1 to 500. Cloudflare's per-call limit is 100 on Free, Pro and Business and up to 500 on Enterprise; set above 100 only on an Enterprise zone. Nothing checks the plan: a value above it passes the boot, and every purge call carrying more URLs than the plan allows fails (`media.cache-purge failed`), leaving those deletes and unpublishes to the sweep's retries. |

Production refuses to boot with no bucket at all, with a public bucket and no
`R2_PUBLIC_URL`, or with a bucket and no credentials. Every environment refuses
to boot with one bucket under both names (a publish would copy an object onto
itself and then delete the only copy), with one purge variable without the
other, with an `R2_PUBLIC_URL` that is not an https origin, or with a
`CLOUDFLARE_PURGE_BATCH_SIZE` outside 1–500. A bucket that is configured but
WRONG is a runtime fault no boot check can catch.

**`R2_PUBLIC_URL` set with no purge pair logs `media.cache-purge is not
configured` at boot** and keeps serving. In that combination unpublish and
delete remove the origin object and answer 200, but a cached edge copy stays
readable for the whole `max-age=31536000`. Either set the pair, or confirm the
public origin is genuinely uncached (a bare `r2.dev` URL is) and treat the
warning as expected.

With the pair set, a delete or unpublish whose purge fails keeps the row in its
cleanup state and the nightly sweep retries both the object delete and the
purge; the API reports such rows as `pending` (delete) or with
`transition: "cleanup"` (unpublish). The purge covers **public** rows only and
is charged against the same outbound ceiling as every other purge.

### Operating the buckets

- **A file delete addresses every configured bucket**, not only the one the row
  names, since a stale visibility transition can leave a copy in the other:
  budget one extra `DeleteObjects` per delete batch. The purge is submitted on
  the public delete's own result, so a private-bucket outage does not hold back
  the eviction of content already gone from the origin.
- **Never unset `R2_PUBLIC_BUCKET` or `R2_PRIVATE_BUCKET` while rows still name
  that visibility.** Deleting such a file answers 200 with the id under
  `pending`, the row keeps its `deleting` marker, and the nightly sweep reports
  `scheduled sweep degraded` with `media.delete row names a bucket this
deployment cannot address` on every pass until the bucket is configured
  again. To retire a bucket, move its files to the other visibility first, then
  remove the variable.
- Verify the purge once: delete a public file and re-fetch its URL.

## 12. Google OAuth sign-in

Local behavioural tests are `tests/integration/oauth-*.test.ts` and
`tests/process/oauth-migration.test.ts`. Nothing here has been executed against
a live Google project.

### Configuration

OAuth is disabled by default. Leave `ENABLED_OAUTH_PROVIDERS` unset or empty to
omit Google from public capabilities and make its start, callback and result
routes unavailable. Password, OTP and local 2FA remain available according to
their own settings. To enable Google, set these runtime variables:

| Variable                  | Value                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `ENABLED_OAUTH_PROVIDERS` | `google`                                                                               |
| `GOOGLE_CLIENT_ID`        | The web application's Google OAuth client ID, ending in `.apps.googleusercontent.com`. |
| `GOOGLE_CLIENT_SECRET`    | That client's secret; server-only, never a public client variable.                     |

An unknown provider or missing or malformed credentials for an enabled one
refuses startup without printing the values. Keep Google credentials out of the
image, repository, browser configuration and logs. Disabling the switch is the
operational rollback; it leaves stored links and password accounts intact.

### Google project

1. Configure a Google OAuth **web application** client and its consent and
   audience setup. Register the exact redirect URI
   `https://<PUBLIC_URL host>/api/auth/oauth/google/callback`: the canonical
   HTTPS origin, not an internal container name or an alternate proxy host.
   Register development redirects separately. Use publishing status **In
   production** for the live deployment. Google documents a
   [Testing exception](https://support.google.com/cloud/answer/15549945?hl=en)
   for basic identity scopes, so the `openid`/`email` request does not require
   users to be on the test-user list.
2. Grant only `openid` and `email`. The server requests online access and no
   incremental scopes, calls no Google API and retains no provider token.
3. To make Google's MFA evidence available, enable **Authentication strength
   claims** (`amr`) through Google Auth Platform → Settings → Advanced
   Settings; Google's
   [security bundle setup](https://developers.google.com/identity/siwg/security-bundle)
   requires publishing status **In production** and verification status
   **Verified**. Without `amr` the user goes through local 2FA; the claim is
   not needed to enable Google sign-in. Google cannot be asked to reauthenticate
   a Google Account, so sensitive operations reauthenticate with a password or
   passkey (owner-approved).
4. Allow outbound HTTPS to `oauth2.googleapis.com` and `www.googleapis.com`;
   browsers navigate to `accounts.google.com`. Keep the VPS clock synchronized
   for Google token validity. Proof start and credential-revocation comparisons
   use the database clock.

### Proxy and client wiring

Configure OAuth and 2FA as runtime variables; the authenticated OpenAPI
document follows them (§2).

Preserve cookies on the full-page Google redirect and the callback. The
callback is a top-level GET with no CAPTCHA header: do not add a proxy rule
requiring one there. Keep the CAPTCHA and Origin protections on the start POST.
Do not cache `/api/auth/*`. Exclude callback query strings, authorization
headers, cookies and provider request and response bodies from proxy, APM and
error logs: callback queries carry short-lived authorization codes and state,
even though the application's own request logger records only the path.

The client must implement the capability-driven Google button, its same-origin
completion page, single-use result retrieval, the local 2FA challenge UI, and
the list of usable reauthentication choices described in
[docs/oauth-sign-in.md](../docs/oauth-sign-in.md); the dashboard in
`apps/front-end` (§2) is that client. After a local email change the client
must tell the user the email changed and sign-in is required, clear
authenticated state, and return to sign-in, because every session, the current
one included, is revoked.

### Live rollout checks

- With Google disabled, capabilities omit it and both start and callback answer 404.
- With Google enabled, sign in an administrator-created, initially unverified
  Gmail account: the existing account is linked and verified without email OTP,
  and its password still works.
- Check a local-2FA account with and without current Google MFA evidence: only
  the verified `mfa` case receives a direct session and its bypass is audited;
  ordinary Google sign-in enters local 2FA even on a trusted device.
- Password and enrolled-passkey reauthentication work with the real client;
  Google is offered only for sign-in and never opens a sensitive-operation
  reauthentication window.
- A local email change invalidates the link, all sessions and pending proof
  state. Unknown identities and changed Google emails get generic failures,
  without the provider payload in any log.

## 13. Database ctype and the search floor

**Choose the PostgreSQL image before there is data. Switching later corrupts
indexes silently.** musl's `strcoll` is byte order, glibc's `en_US` collation is
not, and musl records no collation version for PostgreSQL to warn about. Every
text btree built on Alpine (`ux_users_email`, `ux_sessions_token`,
`ux_files_r2_key`, `ux_folders_parent_name`, `ux_folders_root_name`,
`idx_files_folder_name`) and every `gin_trgm_ops` index is misordered once the
same volume runs under glibc: unique checks can admit duplicate emails and
lookups miss rows. Any change of libc, image variant or `datcollate`/`datctype`
on existing data needs a dump and restore, or `REINDEX DATABASE` before
traffic.

**Record with the deployment, next to the PostgreSQL major:** the image and
variant exactly (`postgres:18-alpine` is musl, `postgres:18` is glibc), and
`datcollate`/`datctype`. CI's `tests` job runs a digest-pinned
`postgres:18-alpine`: when the server's major or variant changes, change the CI
image in the same change, or CI's green run says nothing about the deployment.

The trigram floor in `packages/shared/src/data-table/parsers.ts`
(`isTrigramIndexable`, applied by `effectiveSearchTerm`) decides whether a
search term can be answered from the `pg_trgm` GIN index. pg_trgm classifies a
character with the DATABASE's ctype (`t_isalpha || t_isdigit`, which is the C
library's), not with Unicode, so the floor is a statement about this server,
and two images can disagree. A term the floor admits that the server cannot index matches nothing:
`search_trigram_pattern` answers NULL for a pattern the index cannot key
(`lib/data-table/filter-columns.ts`), so it is a missed result, not a table
scan.

**Required once, and again on any major upgrade, image or variant change, or
locale change:** run `tests/integration/trigram-floor.test.ts` against a
production-shaped database (never the production server) and keep it green. If
the tier cannot be run there:

```sql
select datcollate, datctype from pg_database where datname = current_database();
show server_version;
select extversion from pg_extension where extname = 'pg_trgm';
```

**Recorded for `postgres:18-alpine` (musl), 2026-09-17, derived, not run.**
Evaluated against musl's own `iswalpha` tables:

- **The tier passes.** musl is alpha for the families the floor's class was
  calibrated on (`Nl`, non-ASCII `Nd`) and for every letter the test terms use;
  where it is wider than the class, the floor only refuses a search. The image's
  `ENV LANG=en_US.utf8` is what keeps `iswalpha` in play at all: `datctype` is
  then not `C`, so PostgreSQL does not fall back to `isalpha` on the first
  byte, which would leave every non-ASCII term unindexed. Check `datctype`
  before trusting this on a variant that sets the locale differently.
- **One residual, on musl only.** musl's table predates several Unicode
  additions the floor admits, so a search for them matches nothing there: the
  BMP ranges U+0870–U+0887, U+0889–U+088F, U+08B5, U+08BE–U+08C9,
  U+0C5C–U+0C5D, U+0CDC–U+0CDD, U+0D04, U+0E2F, U+0E46, U+170D, U+171F, U+1B4C,
  U+1C89–U+1C8A, U+2C2F, U+2C5F, U+31BB–U+31BF, U+4DB6–U+4DBF, U+9FF0–U+9FFF,
  U+A7C0–U+A7C1, U+A7C7–U+A7DC, U+A7F1–U+A7F6, U+AB68–U+AB69 (Arabic
  Extended-B, recent CJK ideographs and a few Latin/Cyrillic extensions). None
  appear in this application's data or tests. `postgres:18` (glibc) has no such
  gap: deploy on it if the data will contain those scripts.

### Arabic search folding (`search_fold`)

The data-table search matches the stored `*_folded` columns, each generated from
`search_fold(column)` (`db/migrations/004`, columns `020`–`023`), through their
`*_folded_trgm` indexes (`024`–`029`); the database folds the typed term with
the same function (`011`). The `*_fold_trgm` expression indexes of `005`–`010`
are dropped again by `037`–`042`.

- **The database must be UTF8.** `search_fold` calls `normalize()`, which
  PostgreSQL refuses under any other server encoding, so migration `004` fails
  there. `postgres:18-alpine` with its `en_US.utf8` default qualifies; on any
  other image check
  `select pg_encoding_to_char(encoding) from pg_database where datname = current_database();`.
- **On a PostgreSQL major upgrade, run `tests/integration/search-fold.test.ts`
  against the upgraded server.** `normalize()` follows the server's Unicode
  version, and the folded text is **stored in the row**, so a `REINDEX` does not
  refresh it: rows written before the upgrade keep the old fold. If the test
  shows a difference that matters for the data, rewrite the stored columns with
  an `UPDATE` that assigns each source column (`UPDATE users SET name = name,
email = email`, and the same for `roles` (`role_name`, `description`), `files`
  (`display_name`) and `folders` (`name`)): PostgreSQL recomputes a stored
  generated column only when the update targets a column it depends on. It
  rewrites every row, like `020`–`023`. `search_fold` itself must never change
  (`004`): a different fold is a new function and new columns.

## Final checklist

- [ ] The open decisions at the top are decided and recorded, the first
      administrator's creation included.
- [ ] Release committed, pushed, CI green (`verify`, `image`, `tests`, and the
      Security workflow).
- [ ] `bun run db:migrate` completed against the production database before the
      first container started (§1).
- [ ] PostgreSQL image variant chosen before any data, and the variant,
      `datcollate` and `datctype` recorded; `trigram-floor.test.ts` green on a
      production-shaped database (§13). Server settings applied and verified
      after the restart; the role's `idle_in_transaction_session_timeout` set
      (§3.3).
- [ ] Install, build and start command fields empty, so the image's `verify`
      stage and `CMD` apply; `NODE_ENV=production` set as a runtime variable;
      `--no-env-file` decided (§2).
- [ ] One origin: front-end on `https://example.com`, back-end on
      `https://example.com/api` with no `stripprefix`, and its router rule also
      matching `Path(/openapi.json)`. `PUBLIC_URL` and `NEXT_PUBLIC_API_URL`
      are both `https://example.com`; a dashboard save answers 2xx, and an
      anonymous `/openapi.json` answers the back-end's 401 (§2).
- [ ] `NEXT_PUBLIC_*` lists and `NEXT_PUBLIC_BUSINESS_TIMEZONE` identical in the
      back-end and the front-end build (§2).
- [ ] Every secret scoped **runtime-only**; nothing from the "Must be absent"
      table present, especially `TEST_DATABASE_URL` (§3).
- [ ] `SQLITE_MAINTENANCE_TOKEN` and `BETTER_AUTH_SECRET` generated with
      `openssl rand -base64 32` (§3).
- [ ] Email OTP: `SMTP_USER` is a Gmail or Workspace account with an app
      password, `SMTP_FROM` unset or a verified alias; outbound 465 and the
      enabled providers' hosts open; one real code received per enabled channel
      (§3, §8).
- [ ] Named volume at `/app/data`; `SQLITE_DIR=/app/data`; directory owned by
      uid 1000 with mode `0700` (§4). One replica, one Bun process, no second
      writer on the volume (§4).
- [ ] Cloudflare proxied, Full (strict), visitor-IP removal off, Pseudo IPv4 not
      overwriting headers, and **direct origin access blocked at the VPS
      firewall**: the control that keeps `cf-connecting-ip` trustworthy (§5).
- [ ] `/api/internal/*`, `/api/dev/*` and `/api/health/storage` blocked at
      Cloudflare or Traefik; `/openapi.json` optionally rate-limited (§5).
- [ ] A rate-limiting rule on `POST /api/auth/*` in place, and how to tighten
      it during an attack known to whoever is on call (§5).
- [ ] At least 4 vCPU (Topology); on 2 vCPU, `max_parallel_workers_per_gather`
      = 0 (§3.3). The `users`/`files` autovacuum settings applied (§3.3).
- [ ] Container log rotation checked and sized for an incident, or logs
      shipped off the host (§10).
- [ ] On the public media host, a Cache Rule ignoring the query string (§11).
- [ ] Proxy read timeout > 120 s. No proxy body limit, or one of at least
      25,165,824 bytes, never 12 MiB; a request just over 12 MiB answers the
      application's 413 JSON envelope through the domain (§5).
- [ ] Stop-first; stop grace period **longer than the `shutdownTimeoutMs` in the
      startup log** (135 s today); `docker stop` logs `server stopping` and
      returns in seconds (§6).
- [ ] The health check is the **CMD** form, `bun scripts/healthcheck.ts`, with
      `Timeout` 5 s and `Retries` 5; the restart policy restarts on a non-zero
      exit (§7).
- [ ] Bun 1.4.4 and SQLite ≥ 3.51.3 recorded; readiness `ok` with
      `checks.postgres` true, and PostgreSQL also reached once from outside the
      container (§8).
- [ ] Persistence proven across a redeploy; sentinel retained and its value
      recorded (§8).
- [ ] The Linux-only checks run and recorded (§8).
- [ ] `maintenance schedule started` in the log; alerting configured on every
      line §9 names, including a MISSING `scheduled sweep completed` for each of
      the four jobs' periods.
- [ ] Disk and deploy notifications enabled; PostgreSQL and SQLite backup/RPO
      policies recorded; a restore tested on staging (§10).
- [ ] Pepper keyring and active id understood as a **two-variable** rollback
      (§3.2).
- [ ] R2: both buckets exist, the token holds Object Read & Write on both, the
      development read-only token is deleted; `R2_PUBLIC_URL` is a custom
      domain that shares no cookie scope with the dashboard host; purge pair set
      together or not at all, `CLOUDFLARE_PURGE_BATCH_SIZE` unset or within the
      zone plan's per-call limit, and the purge verified once (§11).
- [ ] Google, only when `ENABLED_OAUTH_PROVIDERS` includes `google`: publishing
      status **In production**, redirect URI registered for the canonical
      origin, and, if the local-2FA bypass is wanted, **Authentication strength
      claims** enabled with verification status **Verified** (§12).
