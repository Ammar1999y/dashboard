# syntax=docker/dockerfile:1

# Built from the REPOSITORY ROOT, not from this directory: the workspace
# lockfile and `packages/shared` live there. Coolify: Build Pack `Dockerfile`,
# Base Directory `/`, Dockerfile Location `/apps/back-end/Dockerfile`.
#
# The image tag is the second home of the Bun pin. `scripts/require-bun.mjs`
# refuses an image whose Bun is older than `packageManager`, and `server.ts`
# logs when it is newer, so a forgotten bump here fails the build or shows in
# the boot log rather than passing silently.
FROM oven/bun:1.4.3 AS manifests
WORKDIR /app
# The install guard would otherwise try to repair the toolchain over the
# network; inside a build the image IS the toolchain.
ENV BUN_GUARD_NO_AUTO_INSTALL=1
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY scripts/require-bun.mjs scripts/
# Bun validates every `patchedDependencies` file even when the patched package
# belongs to a workspace the `--filter` below leaves out.
COPY patches patches
COPY apps/back-end/package.json apps/back-end/
COPY apps/front-end/package.json apps/front-end/
COPY packages/shared/package.json packages/shared/

# Development dependencies too: the typecheck includes tests and tooling that
# import them. No application code runs here, so the stage needs no environment.
#
# `--filter` runs the selected workspaces' lifecycle scripts and NOT the root's,
# so the Bun guard reaches this build through `apps/back-end/package.json`'s
# own `preinstall`, and the root `prepare` (lefthook, no git here) never runs.
FROM manifests AS verify
RUN bun install --frozen-lockfile --filter @app/back-end --filter @app/shared
COPY packages/shared packages/shared
COPY apps/back-end apps/back-end
WORKDIR /app/apps/back-end
RUN bun run build && touch /verified

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
# BuildKit skips a stage the target does not copy from, so this empty stamp is
# what makes the runtime stage wait for `verify` to pass. Nothing reads it.
COPY --from=verify /verified /verified
# `SQLITE_DIR` as `reports/coolify-deployment.md` §4 sets it; the two must
# agree. A new named volume inherits this owner and mode; one created while the
# process ran as root needs the one-time `chown` described there.
RUN install -d -o bun -g bun -m 0700 /app/data
WORKDIR /app/apps/back-end
ENV NODE_ENV=production
EXPOSE 3000
# `oven/bun` creates this user (uid 1000) but does not switch to it. Everything
# above stays root-owned, so code run through an upload parser cannot rewrite
# the application or its `node_modules`.
USER bun
# The exec form, and the server invoked directly rather than through
# `bun run start`: both are required for `SIGTERM` to reach the handlers in
# `server.ts`, which every graceful-shutdown guarantee in
# `reports/coolify-deployment.md` depends on — Docker signals PID 1 and nothing
# else. `bun run <script>` SPAWNS the script and does not forward signals on its
# single-script path (oven-sh/bun#41478; only `--filter`/`--parallel` do), and
# a shell form would make `sh` PID 1 unless it `exec`s.
#
# `NODE_ENV=production` is the `ENV` above, which is what `start` also sets; if
# that script gains anything else, this line has to gain it too.
CMD ["bun", "--bun", "server.ts"]
