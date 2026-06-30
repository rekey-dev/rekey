# ReliPay

Self-hostable, multi-tenant auth and billing for the apps you run. User auth and provider-agnostic billing share one tenant model, behind one API, in one `docker compose up`.

> **Status:** Public beta. [MIT licensed](LICENSE).

## For AI agents

If you're an AI coding agent reading this repo, start at [AGENTS.md](AGENTS.md).

## Quick start

The whole stack boots with one command — the API auto-migrates on start:

```bash
cp .env.example .env   # fill JWT_SECRET + SUPER_ADMIN_KEY (openssl rand -hex 32 each)
docker compose up      # Postgres + Redis + API (:3030) + panel (:3031)
```

Prefer to run from source (watch mode)? Start just the datastores in Docker:

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres redis
pnpm db:migrate:deploy
pnpm dev
```

API at `http://localhost:3030`, interactive docs at `/docs`, operator panel at
`http://localhost:3031`.

See [docs/quickstart.md](docs/quickstart.md) for the full walkthrough (boot →
create a Tenant → create an Application → mint an API key → call from your app),
and [DEPLOY.md](DEPLOY.md) to run it in production (Traefik + TLS).

## Structure

Apps (each runs on a fixed dev port):

| App | Package | Port | What |
|---|---|---|---|
| `apps/api` | `@relipay/api` | 3030 | Fastify monolith — auth + billing + admin API |
| `apps/panel` | `@relipay/panel` | 3031 | Next.js admin panel (panel.relipay.dev) |
| `apps/admin` | `@relipay/admin` | — | Read-only super-admin dashboard (admin.relipay.dev) |
| `apps/portal` | `@relipay/portal` | 3050 | Hosted customer portal V2 (portal.relipay.dev) |

Examples (integration references — not deployed; each ships a `.env.example`):

| Path | Package | Port | What |
|---|---|---|---|
| `examples/demo` | `relipay-demo` | 3032 | Minimal Next.js auth demo via `@relipay/node` |
| `examples/nextjs-saas` | `relipay-nextjs-saas` | 3040 | Full SaaS boilerplate — auth + billing + teams |
| `examples/portal` | `relipay-portal-selfhost-example` | 3050 | Single-app self-host portal |
| `examples/qr-saas` | `qr-saas` | 3000 | Metered QR product end-to-end |

Packages:

- `packages/shared-types` — Zod schemas shared between API and SDKs
- `packages/sdk-node` — `@relipay/node`, the server SDK
- `packages/sdk-react`, `packages/sdk-nextjs` — client SDKs
- `packages/cli` — the `relipay` CLI
- `packages/mcp` — MCP server
- `prisma/schema.prisma` — owned by `apps/api`
- `docs/` — concept primers, API key model, **end-user auth**, **billing**, **coupons**, error model, quickstart


## Contributing

Setup, the dev loop, and PR conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).
AI coding agents should read [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE).
