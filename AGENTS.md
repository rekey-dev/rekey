# AGENTS.md — Rekey

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
cp .env.example .env            # fill POSTGRES_PASSWORD, REDIS_PASSWORD, JWT_SECRET,
                                # SUPER_ADMIN_KEY, ENCRYPTION_KEY — then paste the two
                                # datastore passwords into DATABASE_URL / REDIS_URL
docker compose up -d postgres redis
pnpm db:migrate:deploy
pnpm dev                        # API on :3030, panel on :3031
```

Then bootstrap in one call:

```bash
REKEY_URL=http://localhost:3030 SUPER_ADMIN_KEY=<from .env> \
  npx @rekey.dev/cli init --tenant-name Acme --owner-email ops@acme.example \
                          --app-name "Acme Prod" --app-slug acme-prod --json
```

## Commands

| Command | What |
|---|---|
| `pnpm dev` | generate the Prisma client, build workspace deps, run all apps in watch mode (loads `.env`) |
| `pnpm build` | generate the Prisma client, then build every workspace |
| `pnpm test` | run the vitest suites |
| `pnpm lint` / `pnpm typecheck` | lint / typecheck all workspaces |
| `pnpm db:generate` | generate the Prisma client |
| `pnpm db:migrate` | create + apply a dev migration |
| `pnpm db:migrate:deploy` | apply pending migrations (no prompt) |
| `pnpm db:studio` | open Prisma Studio |

The `db:*` scripts run Prisma from the repo root, which is what makes them read
the root `.env`. Running them from `apps/api` reads `apps/api/.env` instead —
a file this repo does not ship.

The API container also runs `prisma migrate deploy` on boot, so a fresh DB is
migrated automatically under `docker compose --profile full up`.

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
8. **Name things for what they are, not how they came to be.** A file, a test,
   a `describe` title or an identifier says what it holds or what behaviour it
   covers, never which review, audit, round, phase, fix list, issue or pull
   request produced it: `sign-in-lockout.test.ts`, not `audit-3.test.ts`;
   `provider-amount-scale.test.ts`, not `money-v2-wire-scale.test.ts`. A name
   like `review-fixes` tells the next reader nothing and stops meaning
   anything once the review is forgotten. Split a grab bag by behaviour
   instead of renaming it. `node .github/scripts/check-file-names.mjs` fails
   CI on a process word in a source or test path; real product vocabulary (the
   audit log, the plan review page) goes on its allowlist with a reason.
9. **Rekey is an independent project.** Code, docs, tests and commit messages
   name Rekey and its public pieces only: no employer, hosting account,
   private repository, personal email address or coding-agent attribution.
   The release check rejects them.

## Tests

Vitest, per-workspace. The `apps/api` suite shares one Postgres + Redis in a
single fork — cross-file failures are often transient; re-run before assuming a
regression. Add tests next to the module you touch.
A test is added when a plausible change would break behaviour that nothing else
catches. A new test that duplicates existing cover is not added.
