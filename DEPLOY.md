# Deploying Rekey (Dokploy)

Deploys **api.rekey.dev** (API) + **panel.rekey.dev** (operator panel) +
**portal.rekey.dev** (customer self-service
billing portal) from `docker-compose.prod.yml`. Postgres + Redis
are bundled in the compose.

## 0. Prerequisites (you)
- **DNS** — A records → the Dokploy host IP, before deploying (Let's Encrypt needs them):
  - `api.rekey.dev`, `panel.rekey.dev`, `rekey.dev`, `portal.rekey.dev`.
- **Git source** — connect `EtherLabZ/Rekey` to Dokploy (GitHub App or deploy key) if private.
- **Secrets** — generate values for `.env.production` (see `.env.production.example`):
  ```sh
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "REDIS_PASSWORD=$(openssl rand -hex 24)"
  echo "JWT_SECRET=$(openssl rand -hex 32)"
  echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
  echo "SUPER_ADMIN_KEY=$(openssl rand -hex 32)"
  ```

## 1. Create the Dokploy project + compose service
- Project: **Rekey** (production environment).
- Add a **Compose** service:
  - Source: the `EtherLabZ/Rekey` repo, branch `main`.
  - Compose path: `docker-compose.prod.yml`.
- Paste the generated secrets into the service **Environment**.

## 2. Domains
On the Compose service, add domains (Dokploy wires Traefik):
| Host | Service | Port |
|---|---|---|
| `api.rekey.dev` | `api` | 3030 |
| `panel.rekey.dev` | `panel` | 3031 |
| `portal.rekey.dev` | `portal` | 3050 |
HTTPS on, Let's Encrypt. (The compose also carries Traefik labels as a fallback.)

The `portal` service needs no per-app secret — it's the hosted multi-app portal
(see "Customer portal" below).

## 3. Deploy + migrate
- **Deploy.** Migrations run automatically — the `api` container runs
  `prisma migrate deploy` on start (idempotent), so a fresh database is migrated
  on first boot. No manual step needed for a **new** deployment.
- ⚠️ **Upgrading an existing deployment is different.** Because migrations
  self-apply on container start, a migration that needs an operator decision
  will have already run by the time you notice. Read
  [Upgrading: Application environments](#upgrading-application-environments)
  **before** you deploy a version that contains it.
- Bootstrap the first tenant via `/api/v1/admin/*` using `SUPER_ADMIN_KEY`, or sign up at the panel.

## 4. Verify
- `https://api.rekey.dev/docs` → Swagger.
- `https://panel.rekey.dev` → panel login.
- `https://portal.rekey.dev/<slug>` → customer portal for an opted-in
  Application (see "Customer portal" below).
- Provider webhooks auto-register at `https://api.rekey.dev/api/v1/billing/webhook/<provider>/<appSlug>` (PUBLIC_WEBHOOK_BASE_URL is already set to the prod API origin).

## Super-admin dashboard (local-only, not deployed)
- The super-admin UI (`apps/admin`) is deliberately not part of the deployed
  stack. Run it locally against the production API when needed:
  `REKEY_URL=https://api.rekey.dev SUPER_ADMIN_KEY=<key> pnpm --filter @rekey.dev/admin dev`
  (decision logged in decisions.md, 2026-07-28).
- Read-only — surfaces tenants, applications, end-users, orgs, subscriptions,
  payments, MRR, webhook health, services, audit log, request log.
- Auth: paste `SUPER_ADMIN_KEY` on the login form. The container compares
  via `timingSafeEqual` and mints a 12-hour sliding opaque session id; the
  cookie carries only the id, never the key.
- Brute-force throttled at 5 attempts / 5 min / IP (in-memory).
- The admin app needs the same `SUPER_ADMIN_KEY` env value as the api
  service (locally, in your shell or a .env.local). If it is missing, the
  login page says so explicitly rather than rejecting the key you paste — no key
  can work until the container has one.

### Two operational quirks worth knowing
- **Sessions live in memory, so a restart signs everyone out.** The admin app
  keeps its opaque session ids in a process-local map. Redeploying or restarting
  the container invalidates every session and operators paste the key again.
  Acceptable for a single-replica read-only dashboard, and the reason it is not
  Redis-backed is that adding a dependency to the tool you open *when Redis is
  broken* is the wrong trade. If you ever run more than one admin replica this
  becomes a real problem: sessions are not shared, so requests would bounce
  between replicas and appear to sign you out at random. Run one replica.
- **The session cookie is `Secure` whenever `NODE_ENV=production`.** If you build
  with `NODE_ENV=production` but serve the admin app over plain HTTP, the browser
  will refuse to send the cookie and login will appear to silently do nothing.
  That failure is visible rather than dangerous, but it is confusing if you have
  not seen it before. Serve the admin app over HTTPS.

## Customer portal (portal.rekey.dev)
Lives at `apps/portal` — the **hosted, multi-app** customer billing portal where
the end-users of **any opted-in** Application sign in to manage their
subscription. Builds via the `portal-runtime` Dockerfile target and ships in
`docker-compose.prod.yml` as the `portal` service (port 3050).

**One deployment, every Application.** The portal holds **no per-app secret
key**. Each app is reached at `portal.rekey.dev/<slug>`; the portal fetches
that app's public config (`GET /api/v1/portal/config/:slug` → publishable key +
branding) and authorizes each customer with their own session token. Its only
env is `REKEY_URL` (private API URL) + `PORTAL_BASE_URL`.

Operators turn it on per-Application in **Panel → Application → Billing →
Portal** — no deploy, no key wiring. Nothing to set in Dokploy for a new app.

> The API needs `PUBLIC_PORTAL_URL=https://portal.rekey.dev` (set in the `api`
> service env) so publishable-key calls from the portal origin are allowed.

Operators who want to **self-host** their own single-app portal should follow
`docs/portal.md`. (A worked reference app previously lived at
`examples/portal`; the examples were removed pending a rebuild.)

## SDK publish
`@rekey.dev/node` (+ `@rekey.dev/shared-types`) publish to npm on a GitHub Release
via `.github/workflows/release.yml`. Add an `NPM_TOKEN` repo secret (npm org
`rekey`, automation token) and publish a release tagged `sdk-vX.Y.Z`.

## Upgrading: Application environments

**Applies to:** any deployment upgrading across the `app_environments_drop_data_mode`
migration (`prisma/migrations/20260729184644_…`). **Read this before deploying**
— the migration self-applies when the `api` container starts, so there is no
prompt and no confirmation step.

Two things change under you.

**1. Every existing Application becomes `DEVELOPMENT`.** The new
`applications.environment` column is additive with a `DEVELOPMENT` default, so
that going live is always a deliberate act rather than the fallback. That
default also lands on your existing rows, including the ones serving real
customers. While an Application is `DEVELOPMENT`:

- newly minted API keys carry the `rp_test_` prefix (existing keys are
  untouched and keep working — the prefix is descriptive, nothing branches on
  it).

Correct your live applications immediately after the deploy, **in SQL**:

```sql
UPDATE applications SET environment = 'PRODUCTION' WHERE slug IN ('your-app', …);
```

There is no API for this, deliberately: `environment` is write-once at creation
and no endpoint updates it (see `docs/api-keys.md` → Environments). That rule is
right for steady-state operation — going live is "create a PRODUCTION
Application" — but it has no answer for *this* one-time case, where a migration
default landed on applications that already existed and are already serving real
customers. Recreating them is not on the table, so the migration is the one
place where writing the column directly is the intended path. Do it once, right
after upgrading, and check the result:

```sql
SELECT slug, environment FROM applications ORDER BY created_at;
```

**2. Revenue numbers move.** The `mode` column is dropped from `end_users`,
`subscriptions` and `payments`, and the per-Application billing stats
(Billing Overview / revenue dashboard) no longer filter to `LIVE` — because
there is no longer a mode to filter on. If your database contains rows that
were stamped `TEST`, they now count toward MRR, active-subscription counts,
30-day revenue and the 12-month series for their Application. Nothing is lost
or double-counted; the totals simply include what they previously excluded.
Expect a one-time step in the dashboard, and reconcile against the provider
rather than against last week's screenshot.

If that matters to you, capture the old figures before upgrading:

```sql
SELECT application_id, count(*), sum(amount)
FROM payments WHERE mode = 'TEST' AND status = 'SUCCEEDED'
GROUP BY application_id;
```

The `mode` values are not recoverable after the migration runs.

## Upgrading: rename `RELIPAY_*` env vars to `REKEY_*`

**Applies to:** any deployment still setting the pre-1.1.2 variable names.

1.1.2 renamed every environment variable `RELIPAY_*` → `REKEY_*` and kept the
old name as a fallback read. 2.0.0 removes the fallback: `RELIPAY_URL`,
`RELIPAY_SECRET`, `RELIPAY_OPERATOR_TOKEN`, `NEXT_PUBLIC_RELIPAY_URL` and
`NEXT_PUBLIC_RELIPAY_PUBLIC_KEY` are no longer read by the panel, the admin app,
the portal, `@rekey.dev/nextjs`, the CLI or the MCP server.

Rename the variable in every `.env` file, compose file and hosting dashboard
before deploying. The values do not change — only the key.

```bash
# check every env file for stragglers
grep -rn 'RELIPAY_' --include='.env*' .
```

This one fails loudly rather than quietly: the panel returns
`PANEL_API_URL_MISSING`, the admin app `ADMIN_API_URL_MISSING`, the portal and
`@rekey.dev/nextjs` throw on first use, and the MCP server exits with a message
naming `REKEY_URL`. If you miss it, you get a refusal — not a service pointing
at the wrong host.

## Upgrading: `end_users` lockout columns dropped

**Applies to:** any deployment upgrading across
`prisma/migrations/20260729215440_drop_end_user_lockout_columns`. Self-applies on
`api` container start, like every other migration.

`end_users.failed_sign_in_attempts` and `end_users.locked_until` are dropped. No
action is needed and no lockout state is lost: account lockout has lived in Redis
(`bf:lock:eu:login:<appId>:<email>`, `apps/api/src/lib/brute-force.ts`) for
several releases, so every value in those columns was already a stale zero/null.
The operator panel's end-user lock badge was reading them and consequently
reported *every* account as unlocked; it now reads the limiter and is correct.

The one thing to check is **your own** tooling. If you have BI queries, retention
jobs, or dashboards that `SELECT locked_until FROM end_users`, they will error
after this migration — and if they were reporting on it, they were reporting
zeros. Repoint them at `GET /api/v1/admin/metrics/locked-accounts` (super-admin),
which enumerates the live Redis locks.

Locked accounts are, as before, invisible after a Redis flush: the locks are
TTL'd keys, not rows. That is unchanged by this migration, but worth knowing if
you flush Redis as part of a deploy — you are releasing every active lockout.

## Upgrading an existing deployment: required datastore passwords

`docker-compose.yml` used to default Postgres to `POSTGRES_PASSWORD: rekey`
and publish both Postgres and Redis on `0.0.0.0`. That put a known-credential
database on the public internet for anyone running on a VPS without a host
firewall. Both are now bound to `127.0.0.1`, `POSTGRES_PASSWORD` and
`REDIS_PASSWORD` are **required with no fallback**, and Redis runs with
`requirepass`.

If you already have a running deployment, read this before upgrading — it is
not a drop-in.

**Redis** needs nothing but the new variable: it has no persistent auth state,
so setting `REDIS_PASSWORD` and updating `REDIS_URL` (note the leading colon,
`redis://:PASSWORD@host:6379` — Redis AUTH has no username) is enough. In-flight
webhook-retry jobs survive via the AOF volume; the DB poller backstops any gap.

**Postgres will not pick up a new password on its own.** The official image only
applies `POSTGRES_PASSWORD` when it *initialises* an empty data directory, so
your existing volume keeps the old `rekey` password and compose will start
while the API fails to authenticate. Change it inside the database instead — no
dump/restore, no downtime beyond a restart:

```bash
# 1. Generate and record the new password in .env (POSTGRES_PASSWORD),
#    and update DATABASE_URL to match.
NEW_PW=$(openssl rand -hex 24)

# 2. Rotate it in the running database, using the OLD credentials.
docker compose exec postgres \
  psql -U rekey -d rekey -c "ALTER USER rekey WITH PASSWORD '$NEW_PW';"

# 3. Put $NEW_PW into POSTGRES_PASSWORD and DATABASE_URL in .env, then:
docker compose --profile full up -d
```

Verify with `curl -sf localhost:3030/health` — it is now dependency-aware and
returns 503 naming the unreachable dependency if either credential is wrong,
instead of the old unconditional `{"status":"ok"}`.

**Health endpoints changed.** Point container/liveness probes at
`/health/live` (never touches a dependency — restarting the API cannot fix a
database outage) and load-balancer checks at `/health` or `/health/ready`.

**Behind a reverse proxy?** `X-Forwarded-For` is no longer trusted by default.
Set `TRUSTED_PROXIES` to a hop count or an IP/CIDR allowlist, or `request.ip`
— and everything keyed off it, including rate limits and lockout — will see
your proxy instead of the real client.
