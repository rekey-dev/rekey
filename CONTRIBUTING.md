# Contributing to Rekey

Thanks for your interest in Rekey — a self-hostable, multi-tenant auth +
billing backend. This guide covers local setup, the dev loop, and how to get a
change merged.

For the system design, see [ARCHITECTURE.md](ARCHITECTURE.md). AI coding agents
should also read [AGENTS.md](AGENTS.md).

## Prerequisites

- **Node.js 22+** (matches `engines` in the root `package.json`)
- **pnpm 9+** (`corepack enable` will provide it)
- **Docker** (for Postgres + Redis; or bring your own)

## Local setup

```bash
git clone https://github.com/rekey-dev/rekey.git
cd rekey
pnpm install

# Configure — the API refuses to boot without the required secrets.
cp .env.example .env
#   Generate each with: openssl rand -hex 32 (24 for the datastore passwords)
#   Required by the API:     DATABASE_URL, JWT_SECRET (≥32), SUPER_ADMIN_KEY (≥32)
#   Required by compose:     POSTGRES_PASSWORD, REDIS_PASSWORD — then paste both
#                            into DATABASE_URL / REDIS_URL by hand
#   Required in production:  ENCRYPTION_KEY (64 hex chars)

# Start the datastores (Postgres + Redis) and apply migrations.
docker compose up -d postgres redis
pnpm db:migrate:deploy

# Run everything in watch mode.
pnpm dev
```

`pnpm db:migrate:deploy` and `pnpm dev` both read that root `.env`, and
`pnpm dev` generates the Prisma client and builds the workspace packages the
apps import from `dist/` before starting anything — a fresh clone needs no
separate build step. Running an app's own `dev` script directly (`pnpm --filter
@rekey.dev/api dev`) does none of that, and does not read `.env` either.

- API: `http://localhost:3030` — interactive docs at `/docs`
- Operator panel: `http://localhost:3031`

Redis is required infrastructure, not just a rate-limiter: the outbound-webhook
delivery queue runs on it and the API refuses to start if Redis is unreachable.

### Run the whole stack in Docker

Instead of `pnpm dev`, you can boot the full stack (Postgres + Redis + API +
panel + portal) with one command — the API auto-migrates on start:

```bash
cp .env.example .env                  # fill the required secrets
docker compose --profile full up      # add --build after changing app code
```

The `full` profile is what pulls in the API, the panel and the portal; a bare
`docker compose up` starts only Postgres and Redis, which is the right thing
when you are running the apps from your shell.

Every published port binds to `127.0.0.1` unless you set `BIND_ADDRESS`, so this
stack is not reachable from outside the machine even on a remote host.

### Create your first tenant

With the API running, use the bootstrap admin key (`SUPER_ADMIN_KEY`) to create
a Tenant and Application. See [docs/quickstart.md](docs/quickstart.md) for the
end-to-end walkthrough (boot → Tenant → Application → API key → first call).

## Dev loop

| Command | What |
|---|---|
| `pnpm dev` | run all apps in watch mode |
| `pnpm build` | build every workspace |
| `pnpm test` | run the vitest suites |
| `pnpm typecheck` | typecheck all workspaces |
| `pnpm db:migrate` | create + apply a dev migration |
| `pnpm db:studio` | open Prisma Studio |

Before opening a PR, make sure `pnpm build`, `pnpm typecheck`, and `pnpm test`
pass. The `apps/api` suite shares one Postgres + Redis in a single fork, so a
cross-file failure is sometimes transient — re-run before assuming a regression.

**There is no linter yet.** `pnpm lint` exists and every workspace's `lint`
script is `echo "(eslint not yet wired)"`, so running it proves nothing — this
guide used to list it as "lint all workspaces", which was a promise the repo
does not keep. It is deliberately not wired into CI either: a green check that
runs no rules is worse than an absent one. Formatting and style are reviewed by
humans until someone wires a real config, which is its own change.

## Pull requests

1. Fork and branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep the change focused; add or update tests next to the code you touch.
3. Conventional-commit style is appreciated (`feat:`, `fix:`, `docs:`, `chore:`).
4. Describe the change and how you verified it. Link any related issue.
5. CI runs build + typecheck + tests + the config guards on every PR.

A few invariants worth knowing before you touch auth or billing (full list in
ARCHITECTURE.md §6):

- The two auth stacks (`modules/auth` for end-users, `modules/tenant-auth` for
  operators) are parallel — a fix in one usually needs mirroring in the other.
- Every JWT carries a `typ` claim; verifiers reject the wrong type.
- Billing state transitions happen in webhook handlers, never in the request
  that starts checkout.
- Credentials are stored hashed (SHA-256) or encrypted (AES-256-GCM), never in
  the clear.

## Deploying

Rekey is a self-hostable monolith — `docker compose --profile full up` boots the
whole stack locally. For a production deployment (Traefik + TLS, env template,
migrations), see **[DEPLOY.md](DEPLOY.md)**, which uses `docker-compose.prod.yml`
rather than this file.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
