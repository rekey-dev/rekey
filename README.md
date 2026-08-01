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
cp .env.example .env             # fill POSTGRES_PASSWORD, REDIS_PASSWORD,
                                 #      JWT_SECRET, SUPER_ADMIN_KEY, ENCRYPTION_KEY
                                 # then paste the datastore passwords into
                                 # DATABASE_URL/REDIS_URL — compose does not do it for you
docker compose --profile full up # Postgres + Redis + API (:3030) + panel (:3031)
```

Prefer to run from source (watch mode)? Start just the datastores in Docker:

```bash
pnpm install
cp .env.example .env             # same five values as above
docker compose up -d postgres redis
pnpm db:migrate:deploy
pnpm dev
```

Both paths read that one root `.env`. `pnpm dev` generates the Prisma client
and builds the workspace packages the apps import before starting anything, so
a fresh clone needs no separate build step.

API at `http://localhost:3030`, interactive docs at `/docs`, operator panel at
`http://localhost:3031`.

Then bootstrap the first Tenant, Application and API key in one command:

```bash
export REKEY_URL=http://localhost:3030
export SUPER_ADMIN_KEY=$(grep ^SUPER_ADMIN_KEY .env | cut -d= -f2)

npx @rekey.dev/cli init --tenant-name "Acme Co" --owner-email ops@acme.example \
                        --app-name "Acme Prod" --app-slug acme-prod
```

See [docs/quickstart.md](docs/quickstart.md) for the full walkthrough (boot →
bootstrap → call from your app → sign up an end-user), and
[DEPLOY.md](DEPLOY.md) to run it in production (Traefik + TLS).

## Structure

Apps (each runs on a fixed dev port):

| App | Package | Port | What |
|---|---|---|---|
| `apps/api` | `@rekey.dev/api` | 3030 | Fastify monolith — auth + billing + admin API |
| `apps/panel` | `@rekey.dev/panel` | 3031 | Next.js admin panel (panel.rekey.dev) |
| `apps/admin` | `@rekey.dev/admin` | — | Read-only super-admin dashboard (admin.rekey.dev) |
| `apps/portal` | `@rekey.dev/portal` | 3050 | Hosted customer portal V2 (portal.rekey.dev) |

`examples/` is currently empty: the previous demo apps were removed in #261
because they had drifted from the API they demonstrated, and a rebuilt set has
not landed yet. Until it does, the worked integrations are
[docs/quickstart.md](docs/quickstart.md) and
[docs/react-components.md](docs/react-components.md), both of which are checked
against a running stack.

Packages:

- `packages/shared-types` — Zod schemas shared between API and SDKs
- `packages/sdk-node` — `@rekey.dev/node`, the server SDK
- `packages/sdk-react`, `packages/sdk-nextjs` — client SDKs
- `packages/cli` — the `rekey` CLI
- `packages/mcp` — MCP server
- `prisma/schema.prisma` — owned by `apps/api`

Docs (`docs/`):

| Doc | What |
|---|---|
| [quickstart.md](docs/quickstart.md) | Fresh clone → running API → first Application → first end-user |
| [concepts.md](docs/concepts.md) | Tenant / Application / EndUser data model |
| [api-keys.md](docs/api-keys.md) | The three credential types, and environments |
| [api-key-rotation.md](docs/api-key-rotation.md) | Leaked-key drill + rotation cadence |
| [auth.md](docs/auth.md) | End-user auth: tokens, MFA, passkeys, OAuth |
| [react-components.md](docs/react-components.md) | The drop-in React component library |
| [billing.md](docs/billing.md) · [billing-providers.md](docs/billing-providers.md) · [coupons.md](docs/coupons.md) | Plans, checkout, providers, discounts |
| [webhooks.md](docs/webhooks.md) | Outbound events, signature verification, retries |
| [portal.md](docs/portal.md) | Hosted customer self-service billing portal |
| [errors.md](docs/errors.md) | Error envelope + the complete code reference |
| [jwks.md](docs/jwks.md) · [oidc-provider.md](docs/oidc-provider.md) · [tenant-auth.md](docs/tenant-auth.md) · [mcp.md](docs/mcp.md) · [data-erasure.md](docs/data-erasure.md) | Everything else |

## Billing providers

Stripe, PayPal, and Razorpay ship in the box, all behind one `BillingProvider`
interface with geographic routing (Razorpay for India, Stripe elsewhere, by
default — configurable per Application). Need a different processor? Providers
are self-describing modules — one directory describes checkout, webhook
verification, and event mapping, and the registry wires up the rest. See
[docs/billing-providers.md](docs/billing-providers.md) for the how-to.

Billing is **off** on a new Application (`billingConfig.enabled` defaults to
`false`) — every billing endpoint answers `403 BILLING_DISABLED` until an
operator turns it on in Panel → Application → Billing.


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
