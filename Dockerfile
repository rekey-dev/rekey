# syntax=docker/dockerfile:1.7
#
# Multi-stage build for ReliPay (api + panel + portal + admin).
#
# Stages:
#   base    — pnpm + corepack on a slim node image
#   deps    — installs ALL workspace deps (including dev) for building
#   build   — compiles api (tsc) + panel + portal + admin (next build)
#   runtime — copies built artifacts + production-only deps into a fresh
#             slim image. Each app is its own runtime stage; pick with `--target`.
#
# Build:
#   docker build -t relipay-api .                          (default = api)
#   docker build -t relipay-panel --target=panel-runtime .
#   docker build -t relipay-portal --target=portal-runtime .
#   docker build -t relipay-admin --target=admin-runtime .
#
# Or use docker-compose.yml which builds each with shared build cache.
#
# The api image runs `prisma migrate deploy` on start (idempotent) before
# booting the server, so a fresh database is migrated automatically.

ARG NODE_VERSION=20.10.0

# ─── base ─────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ─── deps ─────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY prisma ./prisma
COPY apps/api/package.json apps/api/
COPY apps/panel/package.json apps/panel/
COPY apps/portal/package.json apps/portal/
COPY apps/admin/package.json apps/admin/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/sdk-node/package.json packages/sdk-node/
COPY packages/sdk-react/package.json packages/sdk-react/
COPY packages/sdk-nextjs/package.json packages/sdk-nextjs/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ─── build ────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
# Generate Prisma client + build everything via turbo
RUN pnpm --filter @relipay/api exec prisma generate --schema ../../prisma/schema.prisma
RUN pnpm --filter @relipay/shared-types build
# SDK packages must be built before the apps that import them from dist: the
# hosted portal imports @relipay/react; @relipay/nextjs (examples) depends on
# node + react. panel/admin use raw fetch, so they need none of these.
# Order matters: nextjs depends on node + react.
RUN pnpm --filter @relipay/node build
RUN pnpm --filter @relipay/react build
RUN pnpm --filter @relipay/nextjs build
RUN pnpm --filter @relipay/api build
RUN pnpm --filter @relipay/panel build
RUN pnpm --filter @relipay/portal build
RUN pnpm --filter @relipay/admin build

# ─── api-runtime ──────────────────────────────────────────────────────
FROM base AS api-runtime
ENV HOST=0.0.0.0
ENV PORT=3030
WORKDIR /app

# Install the api + shared-types dependency closure. We do NOT pass --prod and
# we set NODE_ENV=production only AFTER installing, so pnpm keeps the api's
# devDependencies — specifically the `prisma` CLI, needed to (a) generate the
# client and (b) run `migrate deploy` at boot. (`prisma generate` auto-tries
# `pnpm add prisma -D` when prisma is absent from devDependencies, which fails
# inside a workspace — so prisma must be a present devDependency, as in build.)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
COPY apps/api/package.json apps/api/
COPY packages/shared-types/package.json packages/shared-types/
# Install deps, generate the Prisma client, and prune dev-only tooling — all in
# ONE layer. Reasons:
#   * No --prod / NODE_ENV unset here so pnpm keeps `prisma` (a devDependency),
#     needed to generate the client and run `migrate deploy` at boot. (`prisma
#     generate` auto-runs `pnpm add prisma -D` when prisma is missing from
#     devDependencies, which fails inside a workspace — so it must be present.)
#   * Generating here (not COPYing from build) avoids the pnpm peer-hash skew
#     that leaves a cross-stage client where the runtime symlink can't see it
#     ("@prisma/client did not initialize").
#   * The TypeScript/test/build toolchain (vitest, typescript, tsx, esbuild,
#     @types) is the heaviest devDep weight and the runtime never imports it.
#     Deleting it in the SAME RUN as the install keeps it out of the layer
#     entirely (a delete in a later layer wouldn't shrink the image). Prisma +
#     its engines stay.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @relipay/api... --filter @relipay/shared-types \
 && pnpm --filter @relipay/api exec prisma generate --schema ../../prisma/schema.prisma \
 && rm -rf \
      node_modules/.pnpm/typescript@* node_modules/.pnpm/@types+* \
      node_modules/.pnpm/vitest@* node_modules/.pnpm/@vitest+* \
      node_modules/.pnpm/vite@* node_modules/.pnpm/vite-node@* node_modules/.pnpm/jsdom@* \
      node_modules/.pnpm/tsx@* node_modules/.pnpm/esbuild@* node_modules/.pnpm/@esbuild+* \
      node_modules/.pnpm/rollup@* node_modules/.pnpm/@rollup+* \
      node_modules/.pnpm/turbo@* node_modules/.pnpm/@turbo+* \
      node_modules/.pnpm/lightningcss* node_modules/.pnpm/tailwindcss@* node_modules/.pnpm/@tailwindcss+*

# Built artifacts
COPY --from=build /app/packages/shared-types/dist packages/shared-types/dist
COPY --from=build /app/apps/api/dist apps/api/dist

ENV NODE_ENV=production
EXPOSE 3030
# Drop root — the runtime only reads node_modules/dist (world-readable) and
# writes nothing to disk (migrations go to the DB over the network). The `node`
# user (uid 1000) ships in the base image.
USER node
# Apply any pending migrations (handles a fresh DB on first boot; idempotent),
# then start. `prisma` CLI ships in node_modules, so this needs no network.
# `exec node …` so the node process REPLACES the shell and becomes PID 1 — it
# then receives the orchestrator's SIGTERM directly. Without `exec`, the shell
# is PID 1 and doesn't forward the signal, so the API's graceful-shutdown
# handler never fires and the final request-log batch is lost on every deploy.
CMD ["sh", "-c", "pnpm --filter @relipay/api exec prisma migrate deploy --schema ../../prisma/schema.prisma && exec node apps/api/dist/index.js"]

# ─── panel-runtime ────────────────────────────────────────────────────
FROM base AS panel-runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3031
WORKDIR /app

# Next standalone output: a self-contained server.js plus only the traced
# node_modules. No pnpm install, no full dependency tree. The bundle is rooted
# at the workspace root (outputFileTracingRoot), so it lands at /app as-is.
COPY --from=build --chown=node:node /app/apps/panel/.next/standalone ./
# Static assets + the server's runtime chunks aren't part of standalone — copy
# them to the path Next expects. (panel has no public/ dir.)
COPY --from=build --chown=node:node /app/apps/panel/.next/static apps/panel/.next/static

EXPOSE 3031
# Run as the unprivileged `node` user. --chown above gives it ownership of the
# app tree so Next can write its runtime cache.
USER node
CMD ["node", "apps/panel/server.js"]

# ─── portal-runtime ───────────────────────────────────────────────────
# Hosted multi-app customer portal (Portal V2) at port 3050. Same Next
# standalone pattern as panel-runtime — copies the traced bundle in, no pnpm
# install. ONE deployment serves every opted-in Application, resolved by the
# <slug> in the URL (portal.relipay.dev/<slug>). It holds NO per-app secret key:
# it identifies each app by its publishable key + authorizes users with their
# own token. Needs only RELIPAY_URL (+ PORTAL_BASE_URL). See docs/portal.md.
FROM base AS portal-runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3050
WORKDIR /app

# Next standalone output (see panel-runtime). Bundle is rooted at the
# workspace root, so it unpacks to /app directly.
COPY --from=build --chown=node:node /app/apps/portal/.next/standalone ./
# Static assets aren't part of standalone — copy them to the path Next
# expects. (portal has no public/ dir, same as panel.)
COPY --from=build --chown=node:node /app/apps/portal/.next/static apps/portal/.next/static

EXPOSE 3050
# Run as the unprivileged `node` user. --chown above gives it ownership of the
# app tree so Next can write its runtime cache.
USER node
CMD ["node", "apps/portal/server.js"]

# ─── admin-runtime ────────────────────────────────────────────────────
# Super-admin read-only dashboard at admin.relipay.dev. Same Next standalone
# pattern as panel-runtime — copies the traced bundle in, no pnpm install.
# Auth = SUPER_ADMIN_KEY at the env layer; cookie carries an opaque session id.
FROM base AS admin-runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3034
WORKDIR /app

COPY --from=build --chown=node:node /app/apps/admin/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/admin/.next/static apps/admin/.next/static
COPY --from=build --chown=node:node /app/apps/admin/public apps/admin/public

EXPOSE 3034
USER node
CMD ["node", "apps/admin/server.js"]

