# syntax=docker/dockerfile:1

# Built from the REPOSITORY ROOT, not from this directory: the workspace
# lockfile and `packages/shared` live there. Coolify: Build Pack `Dockerfile`,
# Base Directory `/`, Dockerfile Location `/apps/front-end/Dockerfile`.
#
# The Bun tag moves with `packageManager` and with `apps/back-end/Dockerfile`.
FROM oven/bun:1.4.4 AS build
WORKDIR /app
# The install guard would otherwise try to repair the toolchain over the
# network; inside a build the image IS the toolchain.
ENV BUN_GUARD_NO_AUTO_INSTALL=1
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY scripts/require-bun.mjs scripts/
COPY patches patches
COPY apps/back-end/package.json apps/back-end/
COPY apps/front-end/package.json apps/front-end/
COPY packages/shared/package.json packages/shared/
# `--filter` skips the root's `prepare` (lefthook, no git here).
RUN bun install --frozen-lockfile --filter @app/front-end --filter @app/shared
COPY packages/shared packages/shared
COPY apps/front-end apps/front-end

# `next build` inlines these, so they are build arguments: changing one means
# a rebuild. In Coolify, tick "Build Variable" on each. The OTP and 2FA lists
# must match the back-end's (`reports/coolify-deployment.md` §2).
ARG NEXT_PUBLIC_URL
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ARG NEXT_PUBLIC_BUSINESS_TIMEZONE
ARG NEXT_PUBLIC_ENABLED_OTP_CHANNELS
ARG NEXT_PUBLIC_ENABLED_2FA_METHODS
ARG NEXT_PUBLIC_ENABLED_2FA_OTP_CHANNELS
ENV NEXT_STANDALONE=true \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/apps/front-end
RUN bun run build

FROM oven/bun:1.4.4 AS runtime
# Coolify's HTTP health check runs `curl -f` INSIDE the container.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# The standalone output mirrors the monorepo, so the server sits at
# `apps/front-end/server.js`; static assets and `public/` are not traced.
COPY --from=build /app/apps/front-end/.next/standalone ./
COPY --from=build /app/apps/front-end/.next/static apps/front-end/.next/static
COPY --from=build /app/apps/front-end/public apps/front-end/public
WORKDIR /app/apps/front-end
# Docker sets HOSTNAME to the container id; the server binds to it.
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
USER bun
# Exec form, the server as PID 1: Next's own SIGTERM handler drains requests.
CMD ["bun", "server.js"]
