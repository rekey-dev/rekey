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
  **before** you deploy a version that contains it. For 2.2.0, read
  [Upgrading: 2.2.0 migrations and rollback](#upgrading-220-migrations-and-rollback)
  first. It also lists the three proxy secrets `docker-compose.prod.yml`
  requires from 2.2.0 on, without which the stack will not start.
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
is not enough. Behind a proxy that **requires** `API_PROXY_SECRET` (the proxy
presents it, and only then is the forwarded client address believed). Without
it the API sees the proxy's own address, shared by everyone behind it, so a
list naming it would admit them all; rather than do that, a configured
allowlist refuses every such request with `403 ADMIN_IP_UNVERIFIABLE` and the
API says so once at boot. Set the proxy secret, or clear the allowlist. See
[docs/rate-limits.md](docs/rate-limits.md).

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

## Database load: connection pool and caches

### Sizing `DATABASE_POOL_SIZE`

Each API process holds up to `DATABASE_POOL_SIZE` Postgres connections (default
**20**), applied to `DATABASE_URL` as `connection_limit`. A request that finds
every connection busy waits `DATABASE_POOL_TIMEOUT_SECONDS` (default 10) and
then fails. The same pool serves the HTTP handlers, the outbound-webhook worker
(up to 10 jobs at once) and the periodic jobs, so keep it above 10 with room
for requests.

The ceiling is the database, not the API:

```
replicas x DATABASE_POOL_SIZE  <=  max_connections - reserved - headroom
```

- `max_connections` is whatever the server reports: run `SHOW max_connections;`
  against the database the API uses. On Neon it follows the compute size, so
  check it again after resizing, and read it on the endpoint in `DATABASE_URL`
  (a `-pooler` endpoint accepts far more clients than the compute behind it).
- `reserved` is `superuser_reserved_connections` (3 by default), plus any
  connections your provider keeps for itself.
- `headroom`: leave about 10 for migrations on deploy, `psql`, backups and
  anything else that connects (a second app, a BI tool).

Example: `max_connections = 100`, 2 API replicas: `(100 - 3 - 10) / 2 = 43`, so
the default of 20 per replica is safe and there is room to raise it. With 4
replicas on the same server, 20 is the most you can give each.

Raising the pool past that line does not add capacity; it moves the queue from
Prisma into Postgres, which then refuses new connections outright.

The default stays at 20. The requests that used to need the most connections at
once were the per-application stats tile (13 queries in parallel, now 1) and
the super-admin lists (3 to 5 queries per listed row, up to 1,500 at once on a
computed sort, now 3 to 5 in total). What remains fits the default with the
webhook worker busy.

### What is cached, and for how long

| Cache | Where | Lifetime | Invalidated by |
|---|---|---|---|
| Operator session, membership, grants | each API process (memory) | `OPERATOR_AUTH_CACHE_TTL_MS`, default 5s | every sign-out, session revoke, password change or reset, role, scope, grant or membership change, at once in the writing process and over Redis pub/sub in the others |
| Application to workspace | each API process (memory) | life of the process | never changes |
| Per-application overview stats (`rk:stats:app:<id>`) | Redis | 60s | billing on/off toggle; the counts may lag up to a minute |
| Super-admin overview (`rk:admin:overview`) | Redis | 60s | nothing; the rollup may lag up to a minute |

Set `OPERATOR_AUTH_CACHE_TTL_MS=0` to turn the operator cache off. The TTL is a
backstop only: it bounds how long a process that MISSED an invalidation (a
publish lost while Redis was failing) can keep admitting a revoked operator
session. A process whose subscriber is disconnected serves nothing from the
cache until it reconnects.

## Why Valkey, not Redis

The `redis` service in every compose file runs the `valkey/valkey:8.1-alpine`
image, not a Redis image. The service name and the `REDIS_URL` /
`REDIS_PASSWORD` variables are unchanged, and the URL still uses the
`redis://` scheme, because Valkey speaks the same wire protocol and none of
that is Redis-specific — only the container image changed.

Redis moved its own license off-open-source: 7.4 shipped under
RSALv2/SSPLv1, and the floating `redis:7-alpine` tag this repo used to pin
now resolves to a 7.4.x image, silently pulling a source-available license
into every fresh deploy and CI run. Valkey is the Linux Foundation's fork of
Redis 7.2, kept under BSD-3-Clause, and is protocol-compatible with ioredis
and BullMQ, which is all this codebase talks to. Nothing in `apps/api` changed
to make this work.

**Upgrading an existing self-hosted deployment starts the store empty — this
is deliberate, not a bug.** Valkey 8.x loads an RDB/AOF file written by Redis
7.2 without any conversion, but refuses to start on one written by Redis
7.4 — verified directly: Valkey 8.1 boots against a real Redis 7.2 AOF file,
and refuses a real Redis 7.4 one with `Can't handle RDB format version 12`.
Since the floating `redis:7-alpine` tag has been resolving to 7.4 since Redis
published it, most existing self-hosted volumes are already in the format
Valkey refuses, and the API refuses to boot without a reachable Redis — so
pointing Valkey at the existing volume turns this upgrade into an outage for
most installs, not a graceful in-place read.

To avoid that, the compose files mount Valkey on a **new** volume
(`rekey_valkey` in `docker-compose.yml` and `docker-compose.prod.yml`)
instead of the old `rekey_redis` volume. The old volume is declared nowhere in these files after
this change — Docker never touches it, so there is nothing for a stale RDB
format to crash. Pulling this update and restarting the stack always gets you
a clean, empty Valkey, on every install, with no version check to run first.

This datastore is a cache, queue and lockout store, not a system of record
(see the backup section below), so starting empty is safe. Concretely, on
first boot after this upgrade you lose:
- **In-flight BullMQ webhook-delivery retries** — the delayed retry jobs
  living in Redis's queue disappear. This is not permanent data loss: Postgres
  is the source of truth for webhook deliveries, and a periodic poller
  (`processDueWebhookDeliveries`, registered in `apps/api/src/app.ts`)
  re-attempts any `PENDING` row whose `nextAttemptAt` has passed — see the
  comment on `apps/api/src/modules/webhooks/webhook.service.ts` describing it
  as "the crash backstop for a row orphaned by a Redis flush". Deliveries are
  redelivered, just later than they would have been.
- **Every active account lockout** — an account mid-lockout gets a clean
  slate; the next bad attempt starts counting from zero.
- **Current rate-limit windows** — limits reset to zero for a moment.
- **In-flight PKCE state for OAuth/OIDC sign-ins** — a sign-in mid-flow when
  you restart has to be retried from the start; there is no partial-flow data
  to lose.

Nothing in Postgres is affected by any of this.

Once you've confirmed the deploy is healthy on the new volume, the old one is
safe to remove:

```bash
docker volume rm rekey_redis
```

It is not removed automatically — compose never deletes a volume it no longer
declares, so it just sits there unused until you clean it up.

## Backup, restore, and getting your data out

Everything that matters is in Postgres. Redis holds queue state, rate-limit
counters and lockouts — all TTL'd or reconstructible, none of it a system of
record — so a backup plan is a Postgres backup plan.

The mechanics are below. How often you run them, how long you keep them, and
how fast you need to be back are yours to decide; this page does not pretend to
have decided them for you.

Every command in this section assumes the **bundled** `postgres` service from
`docker-compose.prod.yml`. If you pointed `DATABASE_URL` at a managed database
instead (Azure Database for PostgreSQL, Neon, RDS, Cloud SQL), there is no
container to `exec` into: drop the
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

## Upgrading: 2.2.0 migrations and rollback

**Applies to:** any deployment upgrading from 2.1.x to 2.2.0. The migrations
self-apply on `api` container start, like every other release.

**Set these three before you redeploy, or the stack will not start.**
`docker-compose.prod.yml` now requires `PANEL_PROXY_SECRET`, `API_PROXY_SECRET`
and `PORTAL_PROXY_SECRET`, each with no fallback, and compose refuses to render
the file while any of them is unset or empty. They are how the panel, the API
and the portal recognise the Traefik in front of them, and so the whole reason
a per-IP rate limit counts a visitor rather than a container. An empty value
used to be accepted and turned those limits off for public traffic, with one
line in the boot log as the only sign, so they are required rather than
defaulted. Generate a separate value for each:

```bash
printf 'PANEL_PROXY_SECRET=%s\nAPI_PROXY_SECRET=%s\nPORTAL_PROXY_SECRET=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env
```

`docker-compose.yml`, the development stack, still starts with none of them set.

Every OTHER new setting in this release is optional and unset keeps the
previous behaviour. Read the 2.2.0 section of `CHANGELOG.md` for what changes
for operators, in particular that erasing an end-user is now workspace-owner
only.

### Before you deploy: count the rows

Most migrations in this release add a column with a constant default or a new
table, and finish instantly. The ones below rewrite existing rows or build
indexes, and hold locks while they do. Their cost depends on how big these tables are:

```sql
SELECT 'license_activations' AS t, count(*) FROM license_activations
UNION ALL SELECT 'refresh_tokens', count(*) FROM refresh_tokens
UNION ALL SELECT 'tenant_refresh_tokens', count(*) FROM tenant_refresh_tokens
UNION ALL SELECT 'security_events', count(*) FROM security_events
UNION ALL SELECT 'email_logs', count(*) FROM email_logs
UNION ALL SELECT 'webhook_deliveries', count(*) FROM webhook_deliveries;
```

With under roughly 100,000 rows in each, deploy normally. Above that, plan a
short maintenance window.

| Migration | What it does | Blocked while it runs |
|---|---|---|
| `20260902120000_devices` | Backfills `license_activations.application_id`, makes it NOT NULL, adds a device foreign key to `refresh_tokens` | Licence activation, and sign-in and refresh while the foreign key is checked |
| `20260912100000_security_event_subject` | Backfills `subject_end_user_id` on every security event, then builds an index | Inserts into `security_events` |
| `20260914100000_log_retention_indexes` | Builds three indexes | Writes to `security_events`, `email_logs` and `webhook_deliveries` |
| `20260915100000_refresh_token_session_id` | Backfills `session_id` on every row of both refresh-token tables, makes it NOT NULL, builds indexes | Sign-in and refresh, for end-users and operators |
| `20260915120000_refresh_token_session_head_index` | Builds a unique partial index on `session_id` (live rows only) on both refresh-token tables, then drops the plain `session_id` indexes | Sign-in and refresh, for end-users and operators |
| `20260915160000_email_logs_to_address_index` | Builds an index on `email_logs (application_id, to_address)` for erasure | Writes to `email_logs`, which every sent mail records |
| `20260919143000_dashboard_hot_path_indexes` | Builds indexes on `security_events (application_id, type, created_at)`, `subscriptions (application_id, status)`, and `created_at` on `end_users`, `api_request_logs` and `webhook_deliveries` | Writes to each of those tables while its own index builds (end-user sign-up, every API request log flush, webhook delivery, security events). Reads are not blocked. See [Building the five dashboard indexes by hand](#building-the-five-dashboard-indexes-by-hand) |

`20260906110000_request_log_admitted_scope` adds one column to
`api_request_logs`. The change itself is instant, but it has to wait for a lock
on a table every request writes to, and writes queue behind it while it waits.
Deploy at a quiet moment if your API is busy.

If your deploy keeps the old `api` container serving while the new one runs
its migrations, the old container cannot create refresh tokens once
`session_id` is NOT NULL, so sign-ins and refreshes fail until the new
container takes over. A failed refresh does not spend the token, so clients
recover on their next attempt.

### Building the five dashboard indexes by hand

`20260919143000_dashboard_hot_path_indexes` is the one migration in this
release whose cost is the index build itself rather than a row rewrite.

`prisma migrate deploy` cannot build indexes `CONCURRENTLY` (it sends the file
as one batch, which Postgres runs as a transaction). If any of the five tables
named in that row is past roughly 100,000 rows, build the indexes by hand
first, without blocking writes, then deploy normally. The migration uses `IF NOT EXISTS`, so it skips
every index you already built and nothing needs marking as applied:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "security_events_application_id_type_created_at_idx"
  ON "security_events" ("application_id", "type", "created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "subscriptions_application_id_status_idx"
  ON "subscriptions" ("application_id", "status");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "end_users_created_at_idx"
  ON "end_users" ("created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "api_request_logs_created_at_idx"
  ON "api_request_logs" ("created_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_deliveries_created_at_idx"
  ON "webhook_deliveries" ("created_at");
```

Run them one at a time (each `CONCURRENTLY` must be its own statement, outside
a transaction). If one fails part way it leaves an `INVALID` index behind:
`DROP INDEX CONCURRENTLY` it and run that line again.

These five indexes need nothing on a rollback: the 2.1.x API ignores them.

### Rolling back

Three new columns are NOT NULL with no default, and the 2.1.x API never writes
them. **Before starting a 2.1.x image against a migrated database, run:**

```sql
ALTER TABLE refresh_tokens ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE tenant_refresh_tokens ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE license_activations ALTER COLUMN application_id DROP NOT NULL;
```

Without the first two, every sign-in and refresh fails on the old API. Without
the third, activating a licence on a new machine fails. Everything else in the
new schema is ignored by the old code.

**Before upgrading to 2.2.0 again**, fill in what the old API left empty and
restore the constraints, since `prisma migrate deploy` will not re-run a
migration it has already recorded:

```sql
UPDATE refresh_tokens SET session_id = id WHERE session_id IS NULL;
ALTER TABLE refresh_tokens ALTER COLUMN session_id SET NOT NULL;
UPDATE tenant_refresh_tokens SET session_id = id WHERE session_id IS NULL;
ALTER TABLE tenant_refresh_tokens ALTER COLUMN session_id SET NOT NULL;
UPDATE license_activations AS la SET application_id = l.application_id
  FROM licenses AS l WHERE l.id = la.license_id AND la.application_id IS NULL;
ALTER TABLE license_activations ALTER COLUMN application_id SET NOT NULL;
```

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
your proxy instead of the real client. The compose files trust only the panel
and portal by address, and recognise Traefik by `API_PROXY_SECRET`, which you
set (required by `docker-compose.prod.yml`). [docs/rate-limits.md](docs/rate-limits.md) explains
each setting and when to change it.

## Upgrading: the panel's forwarded client IP

The panel tells the API which client IP each operator request came from, and
the API rate-limits operator sign-in and token refresh on that address. The
panel used to forward whatever `X-Forwarded-For` it received, so anything that
reached it directly (a browser on a published port, another container on the
same Docker network) could choose that address and rotate it for a fresh
budget per attempt. It now believes the header only from a proxy that proves
itself with a shared secret.

Two panel variables decide it:

- `PANEL_TRUSTED_PROXIES`: how many proxies append to `X-Forwarded-For` in
  front of the panel. `0` (default) means the panel is reached directly and
  reports the connection address. `1` for one Traefik, nginx or Caddy. `2` for
  a CDN such as Cloudflare in front of that proxy.
- `PANEL_PROXY_SECRET`: a random value your proxy sends on every request as the
  `X-Rekey-Proxy-Secret` header. The header is believed only when it matches.
  Generate one with `openssl rand -hex 32`.

**`PANEL_PROXY_SECRET` is now required by `docker-compose.prod.yml`.** `docker compose up` (and a Dokploy deploy) fails
until it is set. That is deliberate: with a hop count and no secret, the panel
cannot tell the proxy from anything else, believes no header, and reports the
proxy's address for every operator, so all of them share one sign-in and
refresh limit. The panel logs a warning at startup when it sees that
combination.

What your proxy has to do:

- **Traefik (the bundled compose files):** nothing by hand. The panel service
  carries a `headers.customRequestHeaders` middleware label that sets
  `X-Rekey-Proxy-Secret` from `PANEL_PROXY_SECRET`. Setting the header also
  overwrites any copy a client sent.
- **nginx:** in the `location` that proxies to the panel, set (not append) the
  header, and keep appending the client to `X-Forwarded-For`:

  ```nginx
  proxy_set_header X-Rekey-Proxy-Secret "<same value as PANEL_PROXY_SECRET>";
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  ```

- **Caddy:** `reverse_proxy` already sends `X-Forwarded-For`. Add the secret:

  ```caddyfile
  reverse_proxy panel:3031 {
      header_up X-Rekey-Proxy-Secret "<same value as PANEL_PROXY_SECRET>"
  }
  ```

  Caddy only passes along an incoming `X-Forwarded-For` from addresses in its
  `trusted_proxies`. Leave that unset unless something sits in front of Caddy.

In every case the proxy must be the only way to reach the panel. Do not publish
the panel port on a public interface.

**Cloudflare in front of Traefik (the hosted panel, `PANEL_TRUSTED_PROXIES=2`).**
Two hops is only correct if Traefik trusts Cloudflare's address ranges on its
`websecure` entrypoint
(`entryPoints.websecure.forwardedHeaders.trustedIPs`, set to the list at
https://www.cloudflare.com/ips/). Traefik then keeps the client address
Cloudflare wrote and appends Cloudflare's edge after it. Without that setting,
Traefik replaces the header with the edge address, the chain is one entry
long, and the panel falls back to reporting Traefik's own address: safe, but
every operator shares one limit again. Check it after deploying by signing in
and confirming the API logs your real address.
