# syntax=docker/dockerfile:1.7
#
# Multi-stage build for Rekey (api + panel + portal + admin).
#
# Stages:
#   base    — pnpm + corepack on a slim node image
#   deps    — installs ALL workspace deps (including dev) for building
#   build   — compiles api (tsc) + panel + portal + admin (next build)
#   runtime — copies built artifacts + production-only deps into a fresh
#             slim image. Each app is its own runtime stage; pick with `--target`.
#
# Build:
#   docker build -t rekey-api .                          (default = api)
#   docker build -t rekey-panel --target=panel-runtime \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com \
#     --build-arg NEXT_PUBLIC_APP_URL=https://panel.example.com .
#   (NEXT_PUBLIC_* have no defaults — they compile into the bundle, so a default
#    would be a Rekey URL nobody could override at runtime. Marketing REQUIRES
#    both and its build fails without them, deliberately.)
#   docker build -t rekey-portal --target=portal-runtime .
#
# Or use docker-compose.yml which builds each with shared build cache.
#
# The api image runs `prisma migrate deploy` on start (idempotent) before
# booting the server, so a fresh database is migrated automatically.

ARG NODE_VERSION=24.15.0

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
RUN pnpm --filter @rekey.dev/api exec prisma generate --schema ../../prisma/schema.prisma
RUN pnpm --filter @rekey.dev/shared-types build
# SDK packages must be built before the apps that import them from dist: the
# hosted portal imports @rekey.dev/react; @rekey.dev/nextjs (examples) depends on
# node + react. panel and portal use raw fetch, so they need none of these.
# Order matters: nextjs depends on node + react.
RUN pnpm --filter @rekey.dev/node build
RUN pnpm --filter @rekey.dev/react build
RUN pnpm --filter @rekey.dev/nextjs build
RUN pnpm --filter @rekey.dev/api build
# NEXT_PUBLIC_* are baked into client bundles at BUILD time, so they must be
# declared before any Next.js app builds (they once sat after the panel build,
# so only marketing ever saw them).
#
# None of these has a default, deliberately. A default here is a Rekey-owned
# value compiled into the bundle, which cannot then be overridden at runtime —
# the self-host compose passes no build args, so a default silently shipped
# `api.rekey.dev` into every self-hosted panel and made the "unset" handling in
# the app unreachable. Our own deploy supplies them in
# docker-compose.{panel,marketing}.yml; self-hosters pass their own or get the
# app's explicit unconfigured state.
ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_APP_URL=
# No defaults for these two, deliberately. NEXT_PUBLIC_GA_MEASUREMENT_ID must
# never default to Rekey's own property (a self-hosted panel would ship its
# operators' behaviour to us), and NEXT_PUBLIC_PORTAL_URL must never default to
# Rekey's hosted portal (a self-hoster would be shown someone else's origin as
# the place to send THEIR customers). Our own deploy sets both explicitly in
# docker-compose.panel.yml.
ARG NEXT_PUBLIC_GA_MEASUREMENT_ID=
ARG NEXT_PUBLIC_PORTAL_URL=
ARG NEXT_PUBLIC_CHATWOOT_TOKEN=
ARG NEXT_PUBLIC_AHREFS_KEY=
# Names the "Continue with …" button when this deployment signs operators in
# against one of its own Applications. No default: a self-hoster's button must
# not say "Rekey.dev", and the app falls back to a generic label when unset.
ARG NEXT_PUBLIC_PANEL_OAUTH_REKEY_LABEL=
RUN NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_GA_MEASUREMENT_ID=$NEXT_PUBLIC_GA_MEASUREMENT_ID \
    NEXT_PUBLIC_PORTAL_URL=$NEXT_PUBLIC_PORTAL_URL \
    NEXT_PUBLIC_PANEL_OAUTH_REKEY_LABEL=$NEXT_PUBLIC_PANEL_OAUTH_REKEY_LABEL \
    pnpm --filter @rekey.dev/panel build
RUN pnpm --filter @rekey.dev/portal build


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
    pnpm install --frozen-lockfile --filter @rekey.dev/api... --filter @rekey.dev/shared-types \
 && pnpm --filter @rekey.dev/api exec prisma generate --schema ../../prisma/schema.prisma \
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
CMD ["sh", "-c", "pnpm --filter @rekey.dev/api exec prisma migrate deploy --schema ../../prisma/schema.prisma && exec node apps/api/dist/index.js"]

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
# <slug> in the URL (portal.rekey.dev/<slug>). It holds NO per-app secret key:
# it identifies each app by its publishable key + authorizes users with their
# own token. Needs only REKEY_URL (+ PORTAL_BASE_URL). See docs/portal.md.
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



