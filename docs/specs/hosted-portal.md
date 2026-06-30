# Spec — Hosted multi-app customer portal (Portal V2)

Status: **Phase 1 BUILT** (2026-06-29, 474 api tests green, 19/19 typecheck, portal Next-builds) · Owner: platform · New public host + money-path auth + live-deploy migration → PR, auto-merge OFF, human review.

Phase 1 delivered: self-service billing tier (publishable key + own user token on subscription/entitlements/payments/cancel/checkout, gated by the §7 self-scope audit — PASSED), `GET /api/v1/portal/config/:slug`, schema fields + migration, portal-origin auto-allow (pub-key origin check + CORS union), tenant `PATCH /:id/portal`, panel Portal tab, SDK self-service + refresh/signOut methods on `RelipayBrowserClient`, **the rebuilt `apps/portal`** (slug-resolved, server-rendered, publishable-key + httpOnly-cookie-per-slug; routes `/`, `/[slug]`, `/[slug]/login`), and `examples/portal` (single-app self-host reference, renamed `relipay-portal-selfhost-example`).

**Deploy: WIRED (2026-06-29).** Dockerfile already builds `@relipay/react` before the portal (line 63→67) — comments updated to V2. `docker-compose.prod` + `docker-compose.yml`: dropped the now-unused `RELIPAY_SECRET_KEY` from the portal service; added `PUBLIC_PORTAL_URL` to the `api` service (prod `https://portal.relipay.dev`, local `http://localhost:3050`) so publishable-key calls from the portal origin pass CORS + the per-app origin check; added `portal.relipay.dev` to prod `CORS_ALLOWED_ORIGINS`. `DEPLOY.md` updated to the V2 model. Dokploy auto-deploys from merge — no per-app deploy step for a new app's portal (operator just toggles it in the panel).

## 1. Problem

Portal V1 (`apps/portal`) is **single-app-per-deploy**: the Application is fixed at startup by `RELIPAY_SECRET_KEY` env, so an operator with N apps must deploy the portal N times and hand-wire N secret keys. That's the V1 gap. It also holds a secret key per deploy — the heaviest possible credential for an end-user-facing surface.

Goal: **one ReliPay-hosted portal** that serves the customers of **any** opted-in Application, resolved per-request, auto-configured (no deploy, no secret-key wiring), that the operator turns on from Application settings.

## 2. Decisions (locked 2026-06-29)

- **Model B + panel opt-in.** One hosted portal; operator enables it per-Application in panel settings and gets a URL. (Panel = where you opt in / copy URL / brand; it does NOT host the customer-facing pages — panel is operator-authed.)
- **URL: path-default + optional custom domain.** Default `portal.relipay.dev/<slug>` (no provisioning). Operators may later bind their own domain (`billing.theirsaas.com`), restricted to their one Application, with DNS that "works magically" (verification + on-demand TLS).
- **Current `apps/portal` becomes a reference example** (`examples/portal`) — but only as part of the migration below, not a standalone break (it's live).

## 3. The crux — credential model (no per-app secret key)

The hosted portal cannot hold every app's secret key. It uses the **publishable key** (resolved per-app) to identify the app, and the **end-user's own JWT** to authorize self-service actions. This is the direct consumer of the publishable-key work just shipped.

Today the user-scoped billing routes are **secret-key + user-session** gated and reject `rp_pub_` (kept secret-only on purpose, decisions 2026-06-29 11:30). Portal V2 needs them reachable with **publishable key + the caller's own user token**. The insight: those routes *already* require `requireUserSession` and *already* operate only on the caller's own subscription — so the **user token is the real authorization**; the secret key was only proving "trusted server." Swapping in the publishable key is safe **iff** each route strictly scopes to `request.endUser.id` (must be audited, not assumed).

### 3a. New self-service billing tier

Add a `PORTAL_SELF_SERVICE` route set guarded by `requirePublishableOrSecretKey` + `requireUserSession`, covering ONLY caller-owned operations:

| Route | Op | Self-scope guarantee to verify |
|---|---|---|
| `GET /billing/subscription` | read own sub | resolves sub by `endUser.id` |
| `GET /billing/entitlements` | read own entitlements | by `endUser.id` (+ active org membership re-check, already present) |
| `GET /billing/payments` | read own payments | filtered by `endUser.id` |
| `POST /billing/subscription/cancel` | cancel **own** sub (at period end) | target sub must belong to `endUser.id` → else 403 |
| `POST /billing/checkout` | start checkout for **self** | subject = `endUser.id`; org checkout requires membership (already enforced) |

**Stays secret-only (NOT in the tier):** usage/record, credits/consume, license issuance, org management writes, anything acting on *another* user, `billing/providers`, `GET /me`. The money-path wall moves from "all billing writes" to "billing writes **on resources you don't own**."

This is the security-sensitive change — §7 is the audit checklist that must pass before it ships.

## 4. App resolution

Request → Application, two mechanisms:

1. **Path (default):** `portal.relipay.dev/<slug>` → look up Application by `slug` (immutable, unique). Portal fetches that app's publishable key (server-side, via an internal/admin read or a new public `GET /api/v1/portal/config/:slug` returning name + publishableKey + branding + enabled flag) and drives the browser client with it. Reject if the app hasn't opted in (`hostedPortalEnabled`).
2. **Custom domain (opt-in, phase 2):** host header → `Application.portalDomain` lookup → same flow. One domain ↔ one Application (unique), so a custom domain can never resolve to another tenant's app.

Cookie isolation: path-based shares the `portal.relipay.dev` origin across apps, so **scope session cookies by path** (`/<slug>`) or name them per-slug, so app A's portal session can't be replayed on app B. Custom domains get natural origin isolation.

## 5. Schema + settings (panel opt-in)

On `Application`:
- `hostedPortalEnabled Boolean @default(false)` — master toggle.
- `portalDomain String? @unique` — optional custom domain.
- `portalDomainVerifiedAt DateTime?` — set after DNS verification.
- `portalBranding Json @default("{}")` — logo, colors (reuse the existing tokens-based theming from `@relipay/react`).

Panel: a **Portal** tab in the per-Application nav — toggle on/off, show the live `portal.relipay.dev/<slug>` URL (copy button), custom-domain form (shows DNS records to add + verify button + status), branding fields. Endpoints under `/api/v1/tenant/applications/:id/portal` (OWNER/ADMIN).

## 6. Migration / transition (don't break the live deploy)

The current portal is live at `portal.relipay.dev` (docker-compose.prod, Dokploy, Dockerfile `portal-runtime` target). Sequence to avoid an outage:

1. **Copy** current `apps/portal` → `examples/portal` (the manual-wiring single-app reference; sits beside `examples/nextjs-saas`). Update its README to "single-app reference — for the hosted product see Portal V2." Keep `apps/portal` building meanwhile.
2. **Rebuild `apps/portal` in place** as the hosted multi-app portal — reuse the existing Dockerfile target, compose service, and `portal.relipay.dev` domain (no Dokploy/domain churn). Swap the env model: drop per-deploy `RELIPAY_SECRET_KEY`; add app-resolution + publishable-key client.
3. Update docs (`portal.md`, `ASSESSMENT.md`, `ENTERPRISE-ROADMAP.md`, `DEPLOY.md`) to the V2 model; keep an "examples/portal = self-host reference" pointer.

Net: `examples/portal` is the reference; `apps/portal` is the product; the live domain never points at nothing.

## 7. Security audit checklist (gate before §3a ships)

- [ ] Every `PORTAL_SELF_SERVICE` route operates **only** on `request.endUser.id` / their org membership — no route accepts a target user/sub/org id from the request body that isn't ownership-checked.
- [ ] `subscription/cancel` 403s if the sub isn't the caller's.
- [ ] `checkout` can't set another user/org as the billing subject without membership (already enforced — re-confirm under pub-key auth).
- [ ] Publishable key still rejected on usage/credits/license-issuance/org-write/providers/`/me`.
- [ ] Cross-app: a session/token for app A cannot drive app B's portal (cookie scoping + the per-app derived-key JWT already binds tokens to the app).
- [ ] Origin: portal pages send `Origin: portal.relipay.dev` (or the custom domain) — fold into the app's CORS allowlist automatically when the portal is enabled, so the publishable key works from the portal host without the operator hand-adding it.
- [ ] Custom domain can only map to ONE app (`@unique`); verification proves control before activation.
- [ ] Rate limits on the self-service routes (reuse existing per-route limits; checkout/cancel are sensitive).

## 8. Phasing

- **Phase 1** — path-based hosted portal: app resolution by slug, `hostedPortalEnabled` + panel toggle, the §3a self-service API tier (+ §7 audit + tests), `examples/portal` copy, rebuild `apps/portal`. Ships the core value.
- **Phase 2** — custom domain: `portalDomain` + DNS verification + on-demand TLS, host-header resolution, panel custom-domain UI.
- **Phase 3** — branding/themes, invoice PDFs, payment-method update (provider-hosted), MFA in portal (carried from V1 follow-ups in ENTERPRISE-ROADMAP).

## 9. Open questions

1. **Portal config read.** New public `GET /api/v1/portal/config/:slug` (returns name + publishableKey + branding + enabled) vs. the portal server holding a single low-priv internal credential to read app config. Public-config endpoint is simpler and leaks nothing secret (publishable key is public). Lean: public endpoint, gated on `hostedPortalEnabled`.
2. **Custom-domain TLS.** On-demand TLS via the edge/proxy (Caddy/Cloudflare) vs. ACME in-app. Infra-dependent — decide with the Dokploy/edge setup. Phase 2.
3. **Cookie strategy for path-based multi-app.** Per-slug cookie name vs. path-scoped cookie. Path-scoped is cleaner; confirm Next.js cookie `path` honors `/<slug>` under a single host.
4. **Reversing the 11:30 "all billing writes secret-only" stance** for self-service — this spec narrows it to "writes on resources you don't own." Confirm that's the intended security posture before building §3a.
