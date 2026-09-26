# syntax=docker/dockerfile:1

# Built from the REPOSITORY ROOT, not from this directory: the workspace
# lockfile and `packages/shared` live there. Coolify: Build Pack `Dockerfile`,
# Base Directory `/`, Dockerfile Location `/apps/back-end/Dockerfile`.
#
# The image tag is the second home of the Bun pin. `scripts/require-bun.mjs`
# refuses an image whose Bun is older than `packageManager`, and `server.ts`
# logs when it is newer, so a forgotten bump here fails the build or shows in
# the boot log rather than passing silently.
FROM oven/bun:1.4.2 AS manifests
WORKDIR /app
# The install guard would otherwise try to repair the toolchain over the
# network; inside a build the image IS the toolchain.
ENV BUN_GUARD_NO_AUTO_INSTALL=1
COPY package.json bun.lock bunfig.toml ./
COPY scripts/require-bun.mjs scripts/
# Bun validates every `patchedDependencies` file even when the patched package
# belongs to a workspace the `--filter` below leaves out.
COPY patches patches
COPY apps/back-end/package.json apps/back-end/
COPY apps/front-end/package.json apps/front-end/
COPY packages/shared/package.json packages/shared/

# Development dependencies too, so `bun run build` can type-check. A route
# table inconsistent with its request schemas fails the image build here
# instead of the first authorised request in production.
#
# `--filter` runs the selected workspaces' lifecycle scripts and NOT the root's,
# so the Bun guard reaches this build through `apps/back-end/package.json`'s
# own `preinstall`, and the root `prepare` (lefthook, no git here) never runs.
FROM manifests AS verify
RUN bun install --frozen-lockfile --filter @app/back-end --filter @app/shared
COPY packages/shared packages/shared
COPY apps/back-end apps/back-end
WORKDIR /app/apps/back-end
# `bun run build` loads the application graph, and `lib/env.server.ts` refuses
# to load without these. The same throwaway values the CI `verify` job uses:
# shaped to pass validation, unreachable, and confined to this stage. Nothing
# here is a credential, and nothing here reaches the runtime image.
ENV NODE_ENV=development \
  PUBLIC_URL=http://localhost:3000 \
  NEXT_PUBLIC_ENABLED_OTP_CHANNELS=email \
  NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA \
  TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA \
  DATABASE_URL=postgres://ci:ci@db.example.com/ci?sslmode=require \
  BETTER_AUTH_SECRET=ci-placeholder-better-auth-secret-000000 \
  SQLITE_DIR=/tmp/verify-sqlite \
  PASSWORD_PEPPER_ACTIVE_ID=ci \
  PASSWORD_PEPPER_KEYRING='{"ci":{"generation":1,"secret":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}' \
  OTP_HMAC_ACTIVE_ID=ci \
  OTP_HMAC_KEYRING='{"ci":{"generation":1,"secret":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}'
RUN bun run build

FROM manifests AS runtime
# Coolify's HTTP health check runs `curl -f` (with a `wget` fallback) INSIDE the
# container; a slim base image is not guaranteed to carry either, and a
# container whose check can never pass restart-loops with nothing in its logs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
RUN bun install --frozen-lockfile --production --filter @app/back-end --filter @app/shared
COPY packages/shared packages/shared
COPY apps/back-end apps/back-end
# Copied only so this stage cannot be built without `verify` passing; the
# served document is regenerated at start from the runtime configuration.
COPY --from=verify /app/apps/back-end/build /app/apps/back-end/build
WORKDIR /app/apps/back-end
ENV NODE_ENV=production
EXPOSE 3000
# `exec`, and the server invoked directly rather than through `bun run start`.
# Both halves are required for `SIGTERM` to reach the handlers in `server.ts`,
# which every graceful-shutdown guarantee in `reports/coolify-deployment.md`
# depends on — Docker signals PID 1 and nothing else:
#
#  - `bun run <script>` SPAWNS the script and does not forward signals on its
#    single-script path (oven-sh/bun#41478; only `--filter`/`--parallel` do), so
#    as PID 1 it would swallow every stop.
#  - without `exec`, `sh` would wait on that child instead of being replaced.
#    (Debian's `/bin/sh` is dash, which already execs the last command of an
#    `&&` list, so this is belt and braces — but the image's shell is not this
#    file's to assume.)
#
# `NODE_ENV=production` is the `ENV` above, which is what `start` also sets; if
# that script gains anything else, this line has to gain it too.
CMD ["sh", "-c", "bun scripts/build-openapi.ts && exec bun --bun server.ts"]
