# AGENTS.md — ReliPay

For AI coding agents (Claude Code, Cursor, Codex, …) working in this repo.
Humans: start with [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

A self-hostable, multi-tenant **auth + billing** backend for SaaS / B2C apps.
One deployment serves many Tenants → Applications → EndUsers, behind one API,
in one `docker compose up`. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full
system map.

## Setup

```bash
pnpm install
cp .env.example .env            # fill JWT_SECRET, SUPER_ADMIN_KEY, ENCRYPTION_KEY
docker compose up -d postgres redis
pnpm db:migrate:deploy
pnpm dev                        # API on :3030, panel on :3031
```

## Commands

| Command | What |
|---|---|
| `pnpm dev` | run all apps in watch mode (turbo) |
| `pnpm build` | build every workspace |
| `pnpm test` | run the vitest suites |
| `pnpm lint` / `pnpm typecheck` | lint / typecheck all workspaces |
| `pnpm db:migrate` | create + apply a dev migration |
| `pnpm db:migrate:deploy` | apply pending migrations (no prompt) |
| `pnpm db:studio` | open Prisma Studio |

The API container also runs `prisma migrate deploy` on boot, so a fresh DB is
migrated automatically under `docker compose up`.

## Conventions (do not violate without explicit instruction)

1. **Multi-tenant from line 1.** Every domain row carries `applicationId`.
   There is no "default" application — operations always name one.
2. **Provider-agnostic billing.** Stripe / PayPal / Razorpay sit behind the
   `BillingProvider` interface. Top-level types express the *intersection*;
   provider-specific data lives in `metadata: Json`.
3. **The two auth stacks are parallel, not shared.** End-user auth
   (`modules/auth`) and operator auth (`modules/tenant-auth`) are physically
   duplicated against different models (`EndUser` vs `TenantUser`). A fix in
   one almost always needs mirroring in the other — see the file map in
   ARCHITECTURE.md §3.
4. **`typ` JWT claim is load-bearing.** End-user and operator JWTs share
   `JWT_SECRET`; the `typ` claim is the only thing stopping cross-tier
   impersonation. Always set and verify it.
5. **Billing state transitions live in webhook handlers only**, never in the
   API request that initiates checkout (which writes a `PENDING` row).
6. **Credentials at rest:** hash-only (SHA-256) for tokens/keys; AES-256-GCM
   (`lib/secrets.ts`) for secrets whose cleartext is needed later.
7. **Side-effects (email, webhooks) are fire-and-forget** and must never block
   the user-facing response.

## Tests

Vitest, per-workspace. The `apps/api` suite shares one Postgres + Redis in a
single fork — cross-file failures are often transient; re-run before assuming a
regression. Add tests next to the module you touch.
