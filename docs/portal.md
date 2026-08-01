# Customer self-service billing portal (`apps/portal`)

A customer-facing Next.js app where the **end-users of any opted-in Application** sign in and manage their own subscription — without the operator building any billing UI or running their own service.

## Portal V2 — hosted, multi-app (current)

One Rekey-hosted portal serves **every** opted-in Application, resolved by the `<slug>` in the URL: `portal.rekey.dev/<slug>`. The operator turns it on per-Application in **Panel → Application → Billing → Portal** and gets the URL — no deploy, no secret key.

**Credential model.** The portal holds **no per-app secret key**. It looks up each app's public config (`GET /api/v1/portal/config/:slug` → name + **publishable key** + branding) and authorizes each customer with **their own session token**. The self-service billing routes (`subscription`, `entitlements`, `payments`, `cancel`, `checkout`) accept the publishable key + the caller's token and act only on that caller's own resources. Tokens live in httpOnly cookies **scoped to `/<slug>`**, so one app's session can't be replayed on another under the shared host. See [specs/hosted-portal.md](specs/hosted-portal.md).

Runs on port **3050** (`pnpm --filter @rekey.dev/portal dev`); needs only `REKEY_URL` (+ `PORTAL_BASE_URL` for checkout return links).

**Roadmap:** custom domain per app (DNS-verified, on-demand TLS), branding, invoice PDFs, payment-method update, MFA.

## Self-hosting (single-app reference)

Operators who want to run their **own** portal (own infra/domain today, heavy UI forking) can use the single-app reference at [`examples/portal`](../examples/portal) — it authenticates with one Application **secret key** per deployment, the original V1 model.

## Environment

`apps/portal` reads exactly two variables (`apps/portal/src/lib/env.ts`) — there is deliberately no per-app secret and no per-app display name, because both come from `GET /api/v1/portal/config/:slug` at request time. That is what lets one deployment serve every app.

| Variable | Required | Meaning |
|---|---|---|
| `REKEY_URL` | yes | Base URL of the Rekey API (e.g. `https://api.your-deployment.com`) |
| `PORTAL_BASE_URL` | no | Public URL of the portal itself; used for checkout success/cancel return URLs and magic-link targets. Defaults to `http://localhost:3050`. Set it in production. |

```bash
# local dev
cd apps/portal
REKEY_URL=http://localhost:3030 pnpm dev
# → http://localhost:3050/<slug>
```

The single-app reference at `examples/portal` is the one that still takes `REKEY_SECRET_KEY` (or `REKEY_SECRET`) and an optional `PORTAL_APP_NAME` — see its own README.

## Run with Docker Compose

The portal is containerized like the panel: a `portal-runtime` stage in the
root `Dockerfile` (Next standalone output, runs as the unprivileged `node`
user, port **3050**) plus a `portal` service in both compose files.

**Local stack** (`docker-compose.yml`, behind the `full` profile like
api/panel):

```bash
docker compose --profile full up --build portal
# → http://localhost:3050/<slug>  (talks to the api service at http://api:3030)
```

**Production** (`docker-compose.prod.yml`, Dokploy/Traefik): the `portal`
service is routed at `portal.rekey.dev`, `restart: unless-stopped`,
`depends_on: api`, and reaches the API over the private network
(`REKEY_URL=http://api:3030`). `PORTAL_BASE_URL` is preset to
`https://portal.rekey.dev`. Nothing else to configure — **one** deployment
serves every opted-in Application at `/<slug>`, which was the entire point of
V2; there is no per-Application service, hostname or secret to provision. Full
deploy steps: `DEPLOY.md` → "Customer portal".

## What end-users can do

- **Sign in** — email + password, or a magic link (`/api/v1/auth/*`, httpOnly cookie session with one-shot refresh via `@rekey.dev/nextjs`'s `auth()`). No sign-up: accounts are created through the operator's own application. MFA-enrolled users can't sign in to the portal yet (v1 limitation).
- **Subscription** (`/subscription`) — current plan, status badge, period end, included entitlements (`billing.getEntitlements`: features, quantities, credit balance).
- **Billing history** (`/billing`) — their own payments via `GET /api/v1/billing/payments` (strictly caller-scoped server-side; never another user's rows). Rows link to the provider receipt URL when present in the payment's metadata (`receiptUrl` / `receipt_url`, https-only) — "receipts-lite".
- **Change plan / subscribe** (`/plans`) — the public plan catalogue with hosted checkout via the existing `billing.createCheckout` flow. Activation lands via the provider webhook, as always.
- **Cancel** (`/subscription`) — `POST /api/v1/billing/subscription/cancel`. Provider-backed ACTIVE subscriptions are canceled **at period end** (the row stays ACTIVE with `cancelAt` set until the provider webhook terminates it); PENDING checkouts and subscriptions with no provider-side record flip to CANCELED locally right away. `{"atPeriodEnd": false}` forces immediate cancellation.
- **Account** (`/account`) — email + verification state, password change (revokes all refresh tokens; the portal session signs out too), sign out.

## Notes for operators

- **Email transport** — magic links and a good password-reset story require the Application to have an email transport configured (see EMAIL_TRANSPORTS.md). Without one the portal still accepts magic-link requests but the link cannot be delivered; the raw token is deliberately **not** shown in the UI (anyone could type any email).
- **Org-billed Applications** — if `billingConfig.billingSubject === 'org'`, checkout from the portal fails with `BILLING_ORGANIZATION_REQUIRED` (the portal surfaces a friendly message). Org plan management stays in the operator's own app for v1.
- **Scopes** — nothing to configure. The portal presents the Application's publishable key plus the end-user's own token, and `requireScope` does not apply to a publishable caller; every self-service route scopes server-side to `request.endUser.id`.
- **Branding** — the theme is neutral on purpose (no Rekey branding). Design tokens live in `apps/portal/src/app/globals.css`; per-deployment theming is a follow-up.

## API surface added for the portal

Both endpoints live in the existing public billing module (`apps/api/src/modules/billing/billing.routes.ts`), take an Application **publishable or secret** key **and** the end-user JWT (`X-Rekey-User-Token`), and are covered by `apps/api/test/billing-portal.test.ts`:

- `GET /api/v1/billing/payments?limit=` — the caller's own payments, newest first (default 50, max 100). Projection only: no provider correlation ids, no raw metadata; `receiptUrl` is extracted server-side and https-filtered.
- `POST /api/v1/billing/subscription/cancel` — body `{ "atPeriodEnd"?: boolean }` (default true). Idempotent for an already-scheduled cancel; emits the `subscription.canceled` outbound webhook event on immediate/local cancellation (the at-period-end path emits when the provider webhook actually terminates the sub).
