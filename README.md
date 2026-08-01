# Rekey

Self-hostable, multi-tenant auth and billing for the apps you run. User auth and provider-agnostic billing share one tenant model, behind one API, in one `docker compose --profile full up`.

> **Status:** Public beta. [MIT licensed](LICENSE).
>
> **ReliPay is now Rekey.** Packages moved to `@rekey.dev/*` (the old `@relipay/*` packages are deprecated), environment variables renamed `RELIPAY_*` → `REKEY_*` (as of 2.0.0 the old names are no longer read — set `REKEY_*`), and relipay.dev (the old domain) will redirect to rekey.dev once the domain migration completes.

## For AI agents

If you're an AI coding agent reading this repo, start at [AGENTS.md](AGENTS.md).

## Quick start

The whole stack boots with one command — the API auto-migrates on start:

```bash
cp .env.example .env             # fill POSTGRES_PASSWORD, REDIS_PASSWORD, JWT_SECRET, SUPER_ADMIN_KEY
                                 # (see .env.example — the datastore passwords also go in DATABASE_URL/REDIS_URL)
docker compose --profile full up # Postgres + Redis + API (:3030) + panel (:3031)
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
| `apps/api` | `@rekey.dev/api` | 3030 | Fastify monolith — auth + billing + admin API |
| `apps/panel` | `@rekey.dev/panel` | 3031 | Next.js admin panel (panel.rekey.dev) |
| `apps/admin` | `@rekey.dev/admin` | — | Read-only super-admin dashboard (admin.rekey.dev) |
| `apps/portal` | `@rekey.dev/portal` | 3050 | Hosted customer portal V2 (portal.rekey.dev) |

Examples (integration references — not deployed; each ships a `.env.example`):

| Path | Package | Port | What |
|---|---|---|---|

Packages:

- `packages/shared-types` — Zod schemas shared between API and SDKs
- `packages/sdk-node` — `@rekey.dev/node`, the server SDK
- `packages/sdk-react`, `packages/sdk-nextjs` — client SDKs
- `packages/cli` — the `rekey` CLI
- `packages/mcp` — MCP server
- `prisma/schema.prisma` — owned by `apps/api`
- `docs/` — concept primers, API key model, **end-user auth**, **billing**, **coupons**, error model, quickstart

## Billing providers

Stripe, PayPal, and Razorpay ship in the box, all behind one `BillingProvider`
interface with geographic routing (Razorpay for India, Stripe elsewhere, by
default — configurable per Application). Need a different processor? Providers
are self-describing modules — one directory describes checkout, webhook
verification, and event mapping, and the registry wires up the rest. See
[docs/billing-providers.md](docs/billing-providers.md) for the how-to and
[#184](https://github.com/EtherLabZ/Rekey/issues/184) for rollout status.


## Known dev-only behaviours

Things that are deliberately unsafe outside local development, documented here
rather than left for you to discover. None are enabled by default.

**`REKEY_DEV_ECHO_AUTH_TOKENS=true`** makes the operator password-reset and
magic-link endpoints return the raw token in the API response, and the panel
then puts that token in a URL query string (`?demoToken=…`) to render a working
link. Query strings land in browser history, `Referer` headers, and access logs,
so a token that reaches one is best treated as disclosed.

The flag exists because those endpoints are unauthenticated by necessity — you
cannot require a session to recover a forgotten password — so with no mail
transport configured there is otherwise no way to complete the flow locally.

Guards: the API **refuses to boot** if the flag is set with
`NODE_ENV=production`, and the token is withheld unless `NODE_ENV` is exactly
`development`. Unset or unknown values withhold it. We chose to leave the
query-string hand-off in place rather than re-engineer a dev convenience, and to
document it instead — if this turns out to bite someone, the fix is a one-shot
httpOnly cookie and we'll take it.

## Contributing

Setup, the dev loop, and PR conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).
AI coding agents should read [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE).
