# Customer self-service billing portal (`apps/portal`)

A customer-facing Next.js app where the **end-users of any opted-in Application** sign in and manage their own subscription — without the operator building any billing UI or running their own service.

## Portal V2 — hosted, multi-app (current)

One Rekey-hosted portal serves **every** opted-in Application, resolved by the `<slug>` in the URL: `portal.rekey.dev/<slug>`. The operator turns it on per-Application in **Panel → Application → Billing → Portal** and gets the URL — no deploy, no secret key.

**Credential model.** The portal holds **no per-app secret key**. It looks up each app's public config (`GET /api/v1/portal/config/:slug` → name + **publishable key** + branding) and authorizes each customer with **their own session token**. The self-service billing routes (`subscription`, `entitlements`, `payments`, `cancel`, `checkout`) accept the publishable key + the caller's token and act only on that caller's own resources. Tokens live in httpOnly cookies **scoped to `/<slug>`**, so one app's session can't be replayed on another under the shared host.

Runs on port **3050** (`pnpm --filter @rekey.dev/portal dev`); needs only `REKEY_URL` (+ `PORTAL_BASE_URL` for checkout return links). The API must have `PUBLIC_PORTAL_URL` set to the same origin as `PORTAL_BASE_URL`, or it treats the deployment as running no hosted portal and refuses portal password resets.

**Roadmap:** custom domain per app (DNS-verified, on-demand TLS), branding, invoice PDFs, payment-method update, MFA.

## Self-hosting

`apps/portal` is the thing you deploy. It is multi-app by construction and holds no per-app secret, so self-hosting it is the same app described here pointed at your own API — see [Environment](#environment) and [Run with Docker Compose](#run-with-docker-compose) below.

There used to be a single-app V1 reference at `examples/portal` that took one Application **secret key** per deployment. The `examples/` apps were removed in #261 pending a rebuilt set, and that model is not the one to copy anyway: a per-deployment secret key is exactly what V2 exists to avoid.

## Environment

`apps/portal` reads two required variables (`apps/portal/src/lib/env.ts`) and one optional one. There is deliberately no per-app secret and no per-app display name, because both come from `GET /api/v1/portal/config/:slug` at request time. That is what lets one deployment serve every app.

| Variable | Required | Meaning |
|---|---|---|
| `REKEY_URL` | yes | Base URL of the Rekey API (e.g. `https://api.your-deployment.com`) |
| `PORTAL_BASE_URL` | **in production, yes** | Public URL of the portal itself; used for checkout success/cancel return URLs and password-reset link targets. Outside production it defaults to `http://localhost:3050`; under `NODE_ENV=production` an unset value **throws at first use** rather than defaulting, because a localhost return URL strands customers after payment. |
| `PUBLIC_PORTAL_URL` (on the **API**) | yes | Not a portal variable: the API's copy of the portal's public URL. It must be the same origin as `PORTAL_BASE_URL`. Unset means the API treats the deployment as running no hosted portal: the panel shows no portal URL, checkout readiness reports no hosted portal, and portal password resets are refused with `AUTH_URL_NOT_ALLOWED`. The root `.env.example` sets both to `http://localhost:3050`. |
| `PORTAL_TRUSTED_PROXY_HOPS` | no | How many proxies you run in front of the portal (Traefik alone = `1`). The portal then forwards the visitor's address (the entry that many from the right of `X-Forwarded-For`) on its server-side API calls, so the API's per-IP limits count each visitor rather than the portal. Unset forwards nothing, which is right when nothing sits in front: any header the portal received then came from the client. `docker-compose.prod.yml` sets `1`. Believed only together with `PORTAL_PROXY_SECRET`. See [rate-limits.md](rate-limits.md). |
| `PORTAL_PROXY_SECRET` | with the above | Your proxy sends it as `X-Rekey-Proxy-Secret` on every request (a Traefik header middleware in the compose files). The portal believes `X-Forwarded-For` only on a request that carries it, so a caller that reaches the portal around the proxy cannot choose the forwarded address. |
| `INTERNAL_CALLER_SECRET` | yes, set on the API too | Sent to the API as `X-Rekey-Caller-Secret` on every server-side call; must equal the API's value. It does two things. When the portal calls the API's public origin, it is how the API tells the portal's calls from anyone else's through the same edge (without it every visitor counts as the portal's outgoing address). And on any path, it is what makes the API believe the visitor's User-Agent and country the portal forwards on a sign-in, so the session records the visitor's browser and platform instead of the portal's own `node` and `server`. Required by `docker-compose.prod.yml`. |

```bash
# local dev
cd apps/portal
REKEY_URL=http://localhost:3030 pnpm dev
# → http://localhost:3050/<slug>
```

There is no `REKEY_SECRET_KEY` / `PORTAL_APP_NAME` here. Those belonged to the removed single-app V1 reference; V2 resolves both per request from `GET /api/v1/portal/config/:slug`.

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
`depends_on: api`, and reaches the API over the private `rekey-edge` network
(`REKEY_URL=http://rekey-api-edge:3030`) from a fixed address the API trusts
to forward visitor IPs. `PORTAL_BASE_URL` is preset to
`https://portal.rekey.dev`. Nothing else to configure — **one** deployment
serves every opted-in Application at `/<slug>`, which was the entire point of
V2; there is no per-Application service, hostname or secret to provision. Full
deploy steps: `DEPLOY.md` → "Customer portal".

## What end-users can do

The hosted portal is for paying for and managing a subscription, nothing more. It has no sign-up, no magic link and no account page: end-users create their accounts, and manage them, in the operator's own application through the SDKs. Everything below is what `apps/portal/src/app` actually serves.

- **Sign in** (`/<slug>/login`): email and password only, over `/api/v1/auth/*` with an httpOnly cookie session that refreshes itself through `/<slug>/session/refresh`. A wrong email and a wrong password share one message, so the page never says which accounts exist; a lockout (`TOO_MANY_FAILED_ATTEMPTS`) or rate limit (`RATE_LIMITED`) tells the customer roughly how long to wait, from the API's `retryAfterSeconds`, and a service or setup failure says it is not a problem with their account.
- **MFA challenge** (`/<slug>/login?step=mfa`): an end-user enrolled in two-factor is asked for their authenticator or backup code after the password. The challenge token is held in a five-minute httpOnly cookie scoped to `/<slug>`, never in the URL, and is cleared on success, when the API says the challenge is dead, and on sign-out. Without it the page sends the customer back to sign in. A backup code that was already spent is named as such (`MFA_BACKUP_CODE_USED`). Enrolment itself happens in the operator's app.
- **Password reset** (`/<slug>/forgot-password`, then `/<slug>/reset-password`): request a reset email and set a new password from its link. The link points at `<PORTAL_BASE_URL>/<slug>/reset-password?token=…`, which the API accepts without the operator registering it, see below.
- **Dashboard** (`/<slug>`), one page once signed in:
  - **Subscription**: current plan, status badge, and the renewal or end date. On an org-billed Application it shows the first team the user owns or admins.
  - **Plans**: the active plan catalogue, with **subscribe** or **switch** through hosted checkout (`billing.createCheckout`), and a "Pay with…" choice when more than one provider is on offer. Activation lands via the provider webhook, as always.
  - **Cancel**: `POST /api/v1/billing/subscription/cancel`. An **ACTIVE** subscription with a known `currentPeriodEnd` is canceled **at period end**: the row stays ACTIVE with `cancelAt` set, and is terminated on the day by the provider's webhook, or, when there is no provider, by the API expiring it on the next read. PAST_DUE subscriptions, PENDING checkouts and ACTIVE rows with no period end flip to CANCELED right away. A subscription sold through an inbound-only provider shows "managed through your billing account" instead of a cancel button. A UI that has to describe the outcome before making the call can ask `cancelsAtPeriodEnd` from `@rekey.dev/shared-types`, the same predicate the API decides from.
  - **Billing history**: the caller's twelve most recent payments via `GET /api/v1/billing/payments` (strictly caller-scoped server-side), linking to the provider receipt URL when the payment's metadata has one (`receiptUrl` / `receipt_url`, https only).
  - **Sign out**, in the header.
- **Hosted checkout** (`/<slug>/checkout/<token>`): the checkout page a `billing.createCheckout` link opens. It does not need the portal switched on, and it is covered in [billing.md](billing.md).

## Notes for operators

- **Email transport**: password reset from the portal needs the Application to have an email transport (Panel → Application → Email). Without one the reset link cannot be delivered, and the portal deliberately does **not** show the raw token (anyone could type any email).
- **Reset link destination**: nothing to register. While the portal is on, the API treats this Application's own portal pages as an allowed destination for emailed token links: `<PUBLIC_PORTAL_URL>/<slug>/...` on the shared host, and the whole origin of a verified custom domain. It is scoped to the slug, so one Application cannot mail a token into another Application's pages on the same host, and it stops when the portal is turned off. The portal's `PORTAL_BASE_URL` and the API's `PUBLIC_PORTAL_URL` must name the same origin, or resets are refused with `AUTH_URL_NOT_ALLOWED`.
- **Org-billed Applications** — if `billingConfig.billingSubject === 'org'`, checkout from the portal fails with `BILLING_ORGANIZATION_REQUIRED` (the portal surfaces a friendly message). Org plan management stays in the operator's own app for v1.
- **Scopes** — nothing to configure. The portal presents the Application's publishable key plus the end-user's own token, and `requireScope` does not apply to a publishable caller; every self-service route scopes server-side to `request.endUser.id`.
- **Branding** — the theme is neutral on purpose (no Rekey branding). Design tokens live in `apps/portal/src/app/globals.css`; per-deployment theming is a follow-up.

## API surface added for the portal

Both endpoints live in the existing public billing module (`apps/api/src/modules/billing/billing.routes.ts`), take an Application **publishable or secret** key **and** the end-user JWT (`X-Rekey-User-Token`), and are covered by `apps/api/test/billing-portal.test.ts`:

- `GET /api/v1/billing/payments?limit=&offset=` — the caller's own payments, newest first (default 50, max 100), as `{items, page}` where `page` is `{total, limit, offset, hasMore}`. Projection only: no provider correlation ids, no raw metadata; `receiptUrl` is extracted server-side and https-filtered.
- `POST /api/v1/billing/subscription/cancel` — body `{ "atPeriodEnd"?: boolean }` (default true). Idempotent for an already-scheduled cancel; emits the `subscription.canceled` outbound webhook event on immediate/local cancellation (the at-period-end path emits when the provider webhook actually terminates the sub).
