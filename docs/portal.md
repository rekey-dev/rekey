# Customer self-service billing portal (`apps/portal`)

A customer-facing Next.js app where the **end-users of any opted-in Application** sign in and manage their own subscription — without the operator building any billing UI or running their own service.

## Portal V2 — hosted, multi-app (current)

One ReliPay-hosted portal serves **every** opted-in Application, resolved by the `<slug>` in the URL: `portal.relipay.dev/<slug>`. The operator turns it on per-Application in **Panel → Application → Billing → Portal** and gets the URL — no deploy, no secret key.

**Credential model.** The portal holds **no per-app secret key**. It looks up each app's public config (`GET /api/v1/portal/config/:slug` → name + **publishable key** + branding) and authorizes each customer with **their own session token**. The self-service billing routes (`subscription`, `entitlements`, `payments`, `cancel`, `checkout`) accept the publishable key + the caller's token and act only on that caller's own resources. Tokens live in httpOnly cookies **scoped to `/<slug>`**, so one app's session can't be replayed on another under the shared host. See [specs/hosted-portal.md](specs/hosted-portal.md).

Runs on port **3050** (`pnpm --filter @relipay/portal dev`); needs only `RELIPAY_URL` (+ `PORTAL_BASE_URL` for checkout return links).

**Roadmap:** custom domain per app (DNS-verified, on-demand TLS), branding, invoice PDFs, payment-method update, MFA.

## Self-hosting (single-app reference)

Operators who want to run their **own** portal (own infra/domain today, heavy UI forking) can use the single-app reference at [`examples/portal`](../examples/portal) — it authenticates with one Application **secret key** per deployment, the original V1 model.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `RELIPAY_URL` | yes | Base URL of the ReliPay API (e.g. `https://api.your-deployment.com`) |
| `RELIPAY_SECRET_KEY` | yes | The Application's secret key (`rp_live_…` / `rp_test_…`). Server-only — never exposed to the browser. (`RELIPAY_SECRET` is accepted as a fallback spelling for parity with `@relipay/nextjs`.) |
| `PORTAL_BASE_URL` | no | Public URL of the portal itself; used for checkout success/cancel return URLs and magic-link targets. Defaults to `http://localhost:3050`. Set it in production. |
| `PORTAL_APP_NAME` | no | Display name in the header. Defaults to the Application's name from the API. |

```bash
# local dev
cd apps/portal
RELIPAY_URL=http://localhost:3030 RELIPAY_SECRET_KEY=rp_test_… pnpm dev
```

## Run with Docker Compose

The portal is containerized like the panel: a `portal-runtime` stage in the
root `Dockerfile` (Next standalone output, runs as the unprivileged `node`
user, port **3050**) plus a `portal` service in both compose files.

**Local stack** (`docker-compose.yml`, behind the `full` profile like
api/panel):

```bash
# RELIPAY_SECRET_KEY must be the secret key of the Application the portal
# serves (defaults to a placeholder that will fail API calls until replaced).
RELIPAY_SECRET_KEY=rp_test_… docker compose --profile full up --build portal
# → http://localhost:3050  (talks to the api service at http://api:3030)
```

**Production** (`docker-compose.prod.yml`, Dokploy/Traefik): the `portal`
service is routed at `portal.relipay.dev`, `restart: unless-stopped`,
`depends_on: api`, and reaches the API over the private network
(`RELIPAY_URL=http://api:3030`). Set `RELIPAY_SECRET_KEY` in the Dokploy
Compose **Environment** (see `.env.production.example`); the deploy fails API
calls without it. `PORTAL_BASE_URL` is preset to `https://portal.relipay.dev`.
To serve several Applications, deploy one portal service per Application
(separate hostname + its own `RELIPAY_SECRET_KEY`). Full deploy steps:
`DEPLOY.md` → "Customer portal".

## What end-users can do

- **Sign in** — email + password, or a magic link (`/api/v1/auth/*`, httpOnly cookie session with one-shot refresh via `@relipay/nextjs`'s `auth()`). No sign-up: accounts are created through the operator's own application. MFA-enrolled users can't sign in to the portal yet (v1 limitation).
- **Subscription** (`/subscription`) — current plan, status badge, period end, included entitlements (`billing.getEntitlements`: features, quantities, credit balance).
- **Billing history** (`/billing`) — their own payments via `GET /api/v1/billing/payments` (strictly caller-scoped server-side; never another user's rows). Rows link to the provider receipt URL when present in the payment's metadata (`receiptUrl` / `receipt_url`, https-only) — "receipts-lite".
- **Change plan / subscribe** (`/plans`) — the public plan catalogue with hosted checkout via the existing `billing.createCheckout` flow. Activation lands via the provider webhook, as always.
- **Cancel** (`/subscription`) — `POST /api/v1/billing/subscription/cancel`. Provider-backed ACTIVE subscriptions are canceled **at period end** (the row stays ACTIVE with `cancelAt` set until the provider webhook terminates it); PENDING checkouts and subscriptions with no provider-side record flip to CANCELED locally right away. `{"atPeriodEnd": false}` forces immediate cancellation.
- **Account** (`/account`) — email + verification state, password change (revokes all refresh tokens; the portal session signs out too), sign out.

## Notes for operators

- **Email transport** — magic links and a good password-reset story require the Application to have an email transport configured (see EMAIL_TRANSPORTS.md). Without one the portal still accepts magic-link requests but the link cannot be delivered; the raw token is deliberately **not** shown in the UI (anyone could type any email).
- **Org-billed Applications** — if `billingConfig.billingSubject === 'org'`, checkout from the portal fails with `BILLING_ORGANIZATION_REQUIRED` (the portal surfaces a friendly message). Org plan management stays in the operator's own app for v1.
- **API key scopes** — the portal needs `billing:read`, `billing:write`, and the auth scopes; a default-scoped secret key works.
- **Branding** — the theme is neutral on purpose (no ReliPay branding). Design tokens live in `apps/portal/src/app/globals.css`; per-deployment theming is a follow-up.

## API surface added for the portal

Both endpoints live in the existing public billing module (`apps/api/src/modules/billing/billing.routes.ts`), require the Application API key **and** the end-user JWT (`X-Relipay-User-Token`), and are covered by `apps/api/test/billing-portal.test.ts`:

- `GET /api/v1/billing/payments?limit=` — the caller's own payments, newest first (default 50, max 100). Projection only: no provider correlation ids, no raw metadata; `receiptUrl` is extracted server-side and https-filtered.
- `POST /api/v1/billing/subscription/cancel` — body `{ "atPeriodEnd"?: boolean }` (default true). Idempotent for an already-scheduled cancel; emits the `subscription.canceled` outbound webhook event on immediate/local cancellation (the at-period-end path emits when the provider webhook actually terminates the sub).
