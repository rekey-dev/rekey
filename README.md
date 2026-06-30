# ReliPay

Self-hostable, multi-tenant auth and billing for the apps you run. User auth and provider-agnostic billing share one tenant model, behind one API, in one `docker compose up`.

> **Status:** Public beta, MIT licensed. See [PLAN.md](PLAN.md) for the roadmap.

## For AI agents

If you're an AI coding agent reading this repo, start at [AGENTS.md](AGENTS.md).

## Quick start

See [docs/quickstart.md](docs/quickstart.md) for a complete walkthrough (boot the stack → create a Tenant → create an Application → mint an API key → call from your app).

TL;DR:

```bash
pnpm install
cp .env.example .env  # fill in JWT_SECRET, SUPER_ADMIN_KEY, ENCRYPTION_KEY
docker compose up -d postgres redis
pnpm db:migrate:deploy
pnpm dev
```

API at `http://localhost:3030`. Interactive docs at `http://localhost:3030/docs`.

## Structure

Apps (each runs on a fixed dev port):

| App | Package | Port | What |
|---|---|---|---|
| `apps/api` | `@relipay/api` | 3030 | Fastify monolith — auth + billing + admin API |
| `apps/panel` | `@relipay/panel` | 3031 | Next.js admin panel (panel.relipay.dev) |
| `apps/demo` | `relipay-demo` | 3032 | Next.js example integration app |
| `apps/marketing` | `@relipay/marketing` | 3033 | Next.js marketing site (relipay.dev) |

Packages:

- `packages/shared-types` — Zod schemas shared between API and SDKs
- `packages/sdk-node` — `@relipay/node`, the server SDK
- `packages/sdk-react`, `packages/sdk-nextjs` — client SDKs
- `packages/cli` — the `relipay` CLI
- `packages/mcp` — MCP server
- `prisma/schema.prisma` — owned by `apps/api`
- `docs/` — concept primers, API key model, **end-user auth**, **billing**, **coupons**, error model, quickstart

Each module under `apps/api/src/modules/` ships its own `AGENTS.md` describing what the module is for and what an agent should not do there.

## License

MIT (planned). Not yet finalized while in Phase 0.
