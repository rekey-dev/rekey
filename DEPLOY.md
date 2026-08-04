# Deploying Rekey (Dokploy)

Deploys the API + operator panel + customer self-service billing portal from
`docker-compose.prod.yml`, each on a hostname **you** supply. Postgres + Redis
are bundled in the compose.

The examples below use `api.example.com` / `panel.example.com` /
`portal.example.com`. Substitute your own throughout — nothing in the compose
file has a default hostname, and it will refuse to run until you set all three.

## 0. Prerequisites (you)
- **DNS** — A records → the Dokploy host IP, before deploying (Let's Encrypt needs them):
  - `api.example.com`, `panel.example.com`, `portal.example.com`.
- **Git source** — connect the repo to Dokploy (GitHub App or deploy key) if private.
- **Hostnames + secrets** — fill in `.env.production` (see `.env.production.example`):
  ```sh
  echo "API_HOST=api.example.com"
  echo "PANEL_HOST=panel.example.com"
  echo "PORTAL_HOST=portal.example.com"
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "REDIS_PASSWORD=$(openssl rand -hex 24)"
  echo "JWT_SECRET=$(openssl rand -hex 32)"
  echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
  echo "SUPER_ADMIN_KEY=$(openssl rand -hex 32)"
  ```
  `API_HOST` is not cosmetic: it is the origin Rekey registers with
  Stripe/PayPal as the destination for **your** payment webhooks, and the issuer
  it advertises for operator-MCP OAuth. Set it to a host you control.

## 1. Create the Dokploy project + compose service
- Project: **Rekey** (production environment).
- Add a **Compose** service:
  - Source: your fork/clone of the repo, branch `main`.
  - Compose path: `docker-compose.prod.yml`.
- Paste the hostnames and generated secrets into the service **Environment**.

## 2. Domains
On the Compose service, add domains (Dokploy wires Traefik):
| Host | Service | Port |
|---|---|---|
| `api.example.com` | `api` | 3030 |
| `panel.example.com` | `panel` | 3031 |
| `portal.example.com` | `portal` | 3050 |
HTTPS on, Let's Encrypt. (The compose also carries Traefik labels as a fallback.)

The `portal` service needs no per-app secret — it's the hosted multi-app portal
(see "Customer portal" below). If you don't want one, delete the service and its
three `PORTAL_HOST` references, as the note on it in the compose file explains.

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
- `https://api.example.com/docs` → Swagger.
- `https://panel.example.com` → panel login.
- `https://portal.example.com/<slug>` → customer portal for an opted-in
  Application (see "Customer portal" below).
- Provider webhooks auto-register at
  `https://api.example.com/api/v1/billing/webhook/<provider>/<appSlug>`
  (`PUBLIC_WEBHOOK_BASE_URL` derives from `API_HOST`). Check this before you
  connect a live Stripe account — it is the URL your payment notifications go
  to, and it is the one setting where a wrong value is silently wrong.

## 5. Close the doors first boot had to leave open

Two settings default to open because first boot needs them to, and stop being
correct the moment the deployment is reachable by anyone who isn't you. Neither
is changed for you.

**`OPERATOR_SIGNUP_MODE`** (default `open`) — anyone who can reach the API can
create an operator account and a workspace on it. Somebody has to make the first
account, and the documented path is self-serve sign-up at the panel; once yours
exists, set `invite` (a super-admin mints single-use keys at
`POST /api/v1/admin/operator-invites`) or `closed`, and redeploy. The API prints
a `[SECURITY]` warning at boot for as long as `open` and `NODE_ENV=production`
are both true — grep your logs for `[SECURITY]` after the first deploy.

**`OPERATOR_MCP_DYNAMIC_REGISTRATION`** (default `open`) — RFC 7591 registration
on the operator MCP authorization server. It has to stay open while you connect
clients by discovery (`claude mcp add --transport http`, Claude Desktop, Cursor),
because that is how they obtain a `client_id` at all. Registration hands out no
data and no token — an operator still has to approve at the panel — but it does
allowlist a **`redirect_uri` of the registrant's choosing**, which is the one
ingredient a consent-phishing link is otherwise missing. Set `disabled` once your
clients are connected: they keep working (they already hold a `client_id`), new
registrations answer `403 CLIENT_REGISTRATION_DISABLED`, and
`registration_endpoint` disappears from the RFC 8414 metadata rather than being
advertised and refused. See [docs/mcp.md](docs/mcp.md).

Also worth setting here: `ADMIN_IP_ALLOWLIST`, which gates `/api/v1/admin/*` by
source address *before* the key is examined, so a leaked `SUPER_ADMIN_KEY` alone
is not enough. Behind Traefik that needs `TRUSTED_PROXIES` too, or every request
looks like it came from the proxy.

## Super-admin dashboard (local-only, not deployed)
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
- **The session cookie is `Secure` unless the request is loopback.** See
  "Session cookies and `Secure`" below — this is decided per request, not from
  `NODE_ENV`. Serve the admin app over HTTPS, or run it on `localhost`.

## Session cookies and `Secure`

**Applies to every web app in this repo** — panel, portal, admin, marketing, and
`@rekey.dev/nextjs` in your own app. (`apps/api` sets no cookies; it is
bearer-token only, so nothing here applies to it.)

As of 2.0.0-rc.3, `Secure` is decided **per request**, not from `NODE_ENV`:

1. `REKEY_COOKIE_SECURE=true` or `=false` wins outright, if set.
2. Otherwise the first hop of `X-Forwarded-Proto` decides — `https` ⇒ `Secure`.
3. With no forwarded proto, the `Host` decides: loopback (`localhost`,
   `127.0.0.1`, `::1`, `*.localhost`) ⇒ not `Secure`; **anything else ⇒
   `Secure`**.

It replaces a build-time answer to a request-time question. `NODE_ENV` unset, or
`staging`, or anything Next did not inline as exactly `"production"`, used to
emit session cookies with no `Secure` flag while the deployment looked entirely
healthy.

**Rule 3 is fail-secure, and that is a real trade you should know about before
you deploy.** A public hostname served over **plain HTTP** now gets its session
cookies marked `Secure`, which means the browser will not send them back and
sign-in silently does nothing. That is the intended failure: it is loud,
immediate, and one environment variable to fix, as against a cleartext session
credential that fails silently and permanently. A wrong guess should cost a
login, not a session.

The Traefik + Let's Encrypt setup on this page needs nothing — Traefik sets
`X-Forwarded-Proto: https` and rule 2 answers. Set `REKEY_COOKIE_SECURE`
explicitly only in two cases:

- `=true` — you terminate TLS somewhere that does not set `X-Forwarded-Proto`
  and the apps therefore cannot observe it. (Rule 3 already gets this right for
  any non-loopback host, so this is belt-and-braces.)
- `=false` — you deliberately serve over plain HTTP on a non-loopback host and
  accept that session cookies travel in the clear. There is no other way to get
  an insecure session cookie on a real hostname, which is the point.

`docker-compose.prod.yml` passes `REKEY_COOKIE_SECURE` through to the `panel`
and `portal` services. If you add an `admin` or `marketing` service to a compose
file of your own, add the variable to its `environment:` block — those blocks
are allowlists, and a variable that is not listed is silently not passed.

## Customer portal (portal.example.com)
Lives at `apps/portal` — the **hosted, multi-app** customer billing portal where
the end-users of **any opted-in** Application sign in to manage their
subscription. Builds via the `portal-runtime` Dockerfile target and ships in
`docker-compose.prod.yml` as the `portal` service (port 3050).

**One deployment, every Application.** The portal holds **no per-app secret
key**. Each app is reached at `portal.example.com/<slug>`; the portal fetches
that app's public config (`GET /api/v1/portal/config/:slug` → publishable key +
branding) and authorizes each customer with their own session token. Its only
env is `REKEY_URL` (private API URL) + `PORTAL_BASE_URL`.

Operators turn it on per-Application in **Panel → Application → Billing →
Portal** — no deploy, no key wiring. Nothing to set in Dokploy for a new app.

> The API needs `PUBLIC_PORTAL_URL` (derived from `PORTAL_HOST` in the `api`
> service env) so publishable-key calls from the portal origin are allowed.

Operators who want to **self-host** their own single-app portal should follow
`docs/portal.md`. (A worked reference app previously lived at
`examples/portal`; the examples were removed pending a rebuild.)

## Backup, restore, and getting your data out

Everything that matters is in Postgres. Redis holds queue state, rate-limit
counters and lockouts — all TTL'd or reconstructible, none of it a system of
record — so a backup plan is a Postgres backup plan.

The mechanics are below. How often you run them, how long you keep them, and
how fast you need to be back are yours to decide; this page does not pretend to
have decided them for you.

Every command in this section assumes the **bundled** `postgres` service from
`docker-compose.prod.yml`. If you pointed `DATABASE_URL` at a managed database
instead (Neon, RDS, Cloud SQL), there is no container to `exec` into: drop the
`docker compose … exec -T postgres` prefix and run `pg_dump "$DATABASE_URL"`
from a host with a matching client version, or use the provider's own snapshots.
The rest — what is in the dump, why `ENCRYPTION_KEY` has to be backed up
separately, how to restore — is unchanged.

### Dump

```bash
# Custom format (compressed, restores selectively) — recommended.
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U rekey -d rekey -Fc > rekey-$(date +%F).dump

# Plain SQL, if you would rather read it.
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U rekey -d rekey > rekey-$(date +%F).sql
```

Two details that bite: `-T` matters, because without it compose allocates a TTY
and the dump lands corrupted; and running `pg_dump` **inside** the container
(rather than from your laptop) keeps client and server on the same Postgres
version, which is what stops a newer client emitting settings the older server
rejects on restore.

Store the result somewhere that is not the same host, and treat it as
credential material — it contains encrypted provider secrets, password hashes
and session rows.

**A dump alone is not a restorable backup.** The provider credentials, OAuth
client secrets, TOTP seeds and RS256 signing keys inside it are encrypted with
`ENCRYPTION_KEY`, which lives in your environment, not in the database. Back
that key up separately and treat losing it as losing those rows — there is no
recovery path.

Verify what you captured before you need it:

```bash
pg_restore --list rekey-2026-08-01.dump | head
```

### Restore

Into a fresh, empty database:

```bash
# 1. Stop the API so nothing writes during the restore.
docker compose -f docker-compose.prod.yml stop api

# 2. Recreate the database.
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U rekey -d postgres -c 'DROP DATABASE IF EXISTS rekey;'
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U rekey -d postgres -c 'CREATE DATABASE rekey OWNER rekey;'

# 3. Load the dump.
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U rekey -d rekey --no-owner < rekey-2026-08-01.dump
# (plain SQL dump: psql -U rekey -d rekey < rekey-2026-08-01.sql)

# 4. Start the API. `prisma migrate deploy` runs on boot and is a no-op when
#    the dump already carries the current schema.
docker compose -f docker-compose.prod.yml up -d api
```

Put `ENCRYPTION_KEY` back to the value that was in force when the dump was
taken, or the credentials restored with it will not decrypt.

Practise this against a scratch database. A restore you have never run is a
hypothesis.

### Exporting your data

**Self-hosted:** there is nothing to ask anyone for. It is your Postgres, the
schema is in `prisma/schema.prisma`, and `pg_dump` above is the whole answer —
in the open `-Fc` or plain-SQL formats, readable by any Postgres. Want a subset
rather than everything? `pg_dump -t end_users -t subscriptions …`, or query it
directly:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U rekey -d rekey -c "\copy (SELECT * FROM end_users WHERE application_id = 'app_…') TO STDOUT WITH CSV HEADER" \
  > end-users.csv
```

That is the concrete form of the sovereignty claim: no export API stands
between you and your rows, because there is no need for one.

**On Rekey Cloud:** export is support-mediated. Ask us, tell us what you want
and in what shape, and we produce it. There is no self-serve export button, and
that is a deliberate choice rather than a missing feature — the Cloud database
is shared across workspaces, so a bulk extract is something a human scopes and
checks rather than an endpoint anyone can point at a tenant boundary.

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
