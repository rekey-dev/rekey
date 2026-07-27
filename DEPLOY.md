# Deploying Rekey (Dokploy)

Deploys **api.relipay.dev** (API) + **panel.relipay.dev** (operator panel) +
**admin.relipay.dev** (super-admin dashboard, read-only) +
**portal.relipay.dev** (customer self-service
billing portal) from `docker-compose.prod.yml`. Postgres + Redis
are bundled in the compose.

## 0. Prerequisites (you)
- **DNS** — A records → the Dokploy host IP, before deploying (Let's Encrypt needs them):
  - `api.relipay.dev`, `panel.relipay.dev`, `admin.relipay.dev`, `portal.relipay.dev`.
- **Git source** — connect `EtherLabZ/Rekey` to Dokploy (GitHub App or deploy key) if private.
- **Secrets** — generate values for `.env.production` (see `.env.production.example`):
  ```sh
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "REDIS_PASSWORD=$(openssl rand -hex 24)"
  echo "JWT_SECRET=$(openssl rand -hex 32)"
  echo "SESSION_SECRET=$(openssl rand -hex 32)"
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
| `api.relipay.dev` | `api` | 3030 |
| `panel.relipay.dev` | `panel` | 3031 |
| `admin.relipay.dev` | `admin` | 3034 |
| `portal.relipay.dev` | `portal` | 3050 |
HTTPS on, Let's Encrypt. (The compose also carries Traefik labels as a fallback.)

The `portal` service needs no per-app secret — it's the hosted multi-app portal
(see "Customer portal" below).

## 3. Deploy + migrate
- **Deploy.** Migrations run automatically — the `api` container runs
  `prisma migrate deploy` on start (idempotent), so a fresh database is migrated
  on first boot. No manual step needed.
- Bootstrap the first tenant via `/api/v1/admin/*` using `SUPER_ADMIN_KEY`, or sign up at the panel.

## 4. Verify
- `https://api.relipay.dev/docs` → Swagger.
- `https://panel.relipay.dev` → panel login.
- `https://admin.relipay.dev` → super-admin login (paste `SUPER_ADMIN_KEY`).
- `https://portal.relipay.dev/<slug>` → customer portal for an opted-in
  Application (see "Customer portal" below).
- Provider webhooks auto-register at `https://api.relipay.dev/api/v1/billing/webhook/<provider>/<appSlug>` (PUBLIC_WEBHOOK_BASE_URL is already set to the prod API origin).

## Super-admin dashboard (admin.relipay.dev)
- Read-only — surfaces tenants, applications, end-users, orgs, subscriptions,
  payments, MRR, webhook health, services, audit log, request log.
- Auth: paste `SUPER_ADMIN_KEY` on the login form. The container compares
  via `timingSafeEqual` and mints a 12-hour sliding opaque session id; the
  cookie carries only the id, never the key.
- Brute-force throttled at 5 attempts / 5 min / IP (in-memory).
- The admin container needs the same `SUPER_ADMIN_KEY` env value as the api
  service (set once in Dokploy → service → Environment). If it is missing, the
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

## Customer portal (portal.relipay.dev)
Lives at `apps/portal` — the **hosted, multi-app** customer billing portal where
the end-users of **any opted-in** Application sign in to manage their
subscription. Builds via the `portal-runtime` Dockerfile target and ships in
`docker-compose.prod.yml` as the `portal` service (port 3050).

**One deployment, every Application.** The portal holds **no per-app secret
key**. Each app is reached at `portal.relipay.dev/<slug>`; the portal fetches
that app's public config (`GET /api/v1/portal/config/:slug` → publishable key +
branding) and authorizes each customer with their own session token. Its only
env is `RELIPAY_URL` (private API URL) + `PORTAL_BASE_URL`.

Operators turn it on per-Application in **Panel → Application → Billing →
Portal** — no deploy, no key wiring. Nothing to set in Dokploy for a new app.

> The API needs `PUBLIC_PORTAL_URL=https://portal.relipay.dev` (set in the `api`
> service env) so publishable-key calls from the portal origin are allowed.

Operators who want to **self-host** their own single-app portal can use the
reference at `examples/portal` (secret-key, one app per deploy). See
`docs/portal.md`.

## SDK publish
`@rekey.dev/node` (+ `@rekey.dev/shared-types`) publish to npm on a GitHub Release
via `.github/workflows/release.yml`. Add an `NPM_TOKEN` repo secret (npm org
`rekey`, automation token) and publish a release tagged `sdk-vX.Y.Z`.

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
