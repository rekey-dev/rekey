# Contributing to ReliPay

Thanks for your interest in ReliPay — a self-hostable, multi-tenant auth +
billing backend. This guide covers local setup, the dev loop, and how to get a
change merged.

For the system design, see [ARCHITECTURE.md](ARCHITECTURE.md). AI coding agents
should also read [AGENTS.md](AGENTS.md).

## Prerequisites

- **Node.js 20+**
- **pnpm 9+** (`corepack enable` will provide it)
- **Docker** (for Postgres + Redis; or bring your own)

## Local setup

```bash
git clone https://github.com/relipay-dev/relipay.git
cd relipay
pnpm install

# Configure — the API refuses to boot without the required secrets.
cp .env.example .env
#   Generate each with: openssl rand -hex 32
#   Required: JWT_SECRET (≥32 chars), SUPER_ADMIN_KEY (≥32 chars)
#   Required in production: ENCRYPTION_KEY (64 hex chars)

# Start the datastores (Postgres + Redis) and apply migrations.
docker compose up -d postgres redis
pnpm db:migrate:deploy

# Run everything in watch mode.
pnpm dev
```

- API: `http://localhost:3030` — interactive docs at `/docs`
- Operator panel: `http://localhost:3031`

Redis is required infrastructure, not just a rate-limiter: the outbound-webhook
delivery queue runs on it and the API refuses to start if Redis is unreachable.

### Run the whole stack in Docker

Instead of `pnpm dev`, you can boot the full stack (Postgres + Redis + API +
panel) with one command — the API auto-migrates on start:

```bash
cp .env.example .env   # fill the required secrets
docker compose up      # add --build after changing app code
```

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
| `pnpm lint` | lint all workspaces |
| `pnpm typecheck` | typecheck all workspaces |
| `pnpm db:migrate` | create + apply a dev migration |
| `pnpm db:studio` | open Prisma Studio |

Before opening a PR, make sure `pnpm build`, `pnpm typecheck`, and `pnpm test`
pass. The `apps/api` suite shares one Postgres + Redis in a single fork, so a
cross-file failure is sometimes transient — re-run before assuming a regression.

## Pull requests

1. Fork and branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep the change focused; add or update tests next to the code you touch.
3. Conventional-commit style is appreciated (`feat:`, `fix:`, `docs:`, `chore:`).
4. Describe the change and how you verified it. Link any related issue.
5. CI runs build + typecheck + tests on every PR.

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

ReliPay is a self-hostable monolith — `docker compose up` boots the whole
stack. For a production deployment (Traefik + TLS, env template, migrations),
see **[DEPLOY.md](DEPLOY.md)**.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
