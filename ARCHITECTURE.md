# ReliPay — Architecture

A self-hostable auth + billing backend for SaaS / B2C apps. One ReliPay
deployment serves many **Tenants** (your customers), each owning many
**Applications** (their products), each owning many **EndUsers** (their
end-users) and many **Plans/Coupons/Licenses/UsageMeters/etc.** Two
parallel auth pillars: *operators* (humans using the ReliPay panel) and
*end-users* (people signing into Applications via SDKs).

This document is the single source of truth for the system's shape. For
the running journal of decisions and why each one was made, see
[`decisions.md`](decisions.md).

---

## 1. System diagram

```
                                                        ┌──────────────────────┐
                                                        │  Stripe / PayPal /   │
                                                        │  Razorpay (provider) │
                                                        └─────────▲────────────┘
                                                                  │
                                                  3a. provider-signed webhook
                                                                  │
                                                                  ▼
┌─────────────┐      ┌────────────────────────────────────────────────────────┐
│   Operator  │      │                       ReliPay API                       │
│  (you, the  │      │                                                          │
│   tenant    │      │   ┌──────────────────────┐  ┌───────────────────────┐   │
│   admin)    │      │   │  Operator surface    │  │  End-user surface     │   │
│             │◀────▶│   │  /api/v1/tenant/*    │  │  /api/v1/auth/*       │   │
│  Panel      │ 1.   │   │  /api/v1/admin/*     │  │  /api/v1/users/me/*   │   │
│  (Next.js)  │      │   │                      │  │  /api/v1/billing/*    │   │
└─────────────┘      │   │  Auth: TenantUser    │  │  Auth: Application    │   │
                     │   │  JWT (typ=to_access) │  │  API key (rp_live_…)  │   │
                     │   │  with `tid` + `rol`  │  │  + end-user JWT       │   │
                     │   │                      │  │  (typ=eu_access)      │   │
                     │   └─────────┬────────────┘  └─────────┬─────────────┘   │
                     │             │                          │                 │
                     │             └──────────┬───────────────┘                 │
                     │                        │                                 │
                     │             ┌──────────▼───────────┐                     │
                     │             │ Postgres (Prisma)    │                     │
                     │             │                      │                     │
                     │             │ Tenants ─┬─ Apps     │                     │
                     │             │          ├─ EndUsers │                     │
                     │             │          ├─ Plans    │                     │
                     │             │          ├─ Subscriptions / Payments       │
                     │             │          ├─ Coupons + CouponRedemptions    │
                     │             │          ├─ Licenses + Activations         │
                     │             │          ├─ UsageMeters + UsageRecords     │
                     │             │          ├─ ApiKeys (hash-only)            │
                     │             │          ├─ RefreshTokens (hash-only)      │
                     │             │          ├─ PasswordResetTokens (hash)     │
                     │             │          ├─ EmailVerificationTokens (hash) │
                     │             │          ├─ OAuthIdentities                │
                     │             │          ├─ MfaCredentials (encrypted)     │
                     │             │          ├─ EmailTemplates                 │
                     │             │          ├─ WebhookEndpoints + Deliveries  │
                     │             │          └─ WebhookEvents (inbound idem.)  │
                     │             └──────────────────────┘                     │
                     │                                                          │
                     │   ┌──────────────────────────────────────────────────┐   │
                     │   │ Outbound side-effects (fire-and-forget)          │   │
                     │   │                                                  │   │
                     │   │  emailService.dispatch ──▶ Resend  (BYO / pool)  │──▶ 4a. transactional email
                     │   │                                                  │
                     │   │  webhookService.emit  ──▶ HMAC-signed POST       │──▶ 4b. customer's webhook URL
                     │   └──────────────────────────────────────────────────┘
                     └──────────────────────────────────────────────────────────┘
                                                  ▲
                                                  │ 2. SDK call
                                                  │    (Application secret key +
                                                  │     optional X-Relipay-User-Token)
                                                  │
                          ┌───────────────────────┴───────────────────────┐
                          │                                                │
                  ┌───────▼───────┐                                ┌───────▼───────┐
                  │  Customer's   │                                │  Customer's   │
                  │   server      │  3b. fetch on browser →        │   browser     │
                  │  (Next.js,    │      @relipay/react sends      │  app          │
                  │   etc.)       │      X-Relipay-User-Token      │               │
                  │               │      direct from JWT cookie    │               │
                  │  @relipay/    │                                │  @relipay/    │
                  │  node /       │                                │  react        │
                  │  nextjs       │                                │               │
                  └───────────────┘                                └───────────────┘

  Lifecycle event happens here ──┐
  (user.created, mfa.enabled,    │
   password.changed,             ├─▶ emailService.dispatch (transactional email)
   session.revoked, ...)         │
                                 └─▶ webhookService.emit    (HMAC-signed delivery
                                                              with 5-attempt
                                                              backoff retry)
```

**Numbered flows:**

1. **Operator panel** signs in via `/api/v1/tenant/auth/sign-in`, gets
   `{tid, rol}` JWT + refresh, cookies in browser. MFA-enrolled
   operators go through `/tenant/auth/mfa-verify` before getting tokens.

2. **End-user SDK calls** carry the Application secret key
   (`Authorization: Bearer rp_live_…`) and, for per-user endpoints, an
   end-user JWT (`X-Relipay-User-Token`). The middleware checks (a) the
   secret key resolves to an Application, (b) the key's `scopes`
   permit the route, (c) the user JWT's `applicationId` claim matches.

3a. **Inbound billing webhook** from Stripe etc. is signature-verified,
   inserted into `WebhookEvent` for idempotency, dispatched to
   handler. State transitions live here, NEVER in the API request
   path.

3b. **Browser SDK** talks to the customer's server (with cookies); the
   server forwards to ReliPay via `@relipay/node`. Browser never holds
   the secret key.

4a. **Outbound transactional email** via Resend — either BYO per
   Application or the ReliPay-managed pool. Six events:
   password_reset, email_verification, workspace_invitation, welcome,
   mfa_enabled, password_changed. Falls back to "return raw token to
   API caller" when no transport configured.

4b. **Outbound webhooks** notify the customer's server of user-lifecycle
   events (`user.created`, `mfa.enabled`, `password.changed`,
   `session.revoked`, `email.verified`, etc.). HMAC-SHA256 signed in
   Stripe-style `X-Relipay-Signature: t=<unix>,v1=<hex>`. 5 attempts
   with exponential backoff (30s / 2m / 10m / 1h / 4h).

---

## 2. Trust boundaries (auth tiers)

| Tier | Credential | Issued by | Used by | Scope |
|---|---|---|---|---|
| **Bootstrap admin** | `SUPER_ADMIN_KEY` env | the deployer | `relipay` CLI, first-time Tenant + Application bootstrap | global; access to `/api/v1/admin/*` only |
| **Operator session** | `to_access` JWT + 30-day refresh | `/api/v1/tenant/auth/sign-in` | the panel | scoped to a Tenant (`tid` claim) + role (`rol`) |
| **Application secret key** | `rp_live_*` / `rp_test_*` | operator via panel | customer's server (`@relipay/node`) | scoped to one Application; `scopes` array gates which routes |
| **Application public key** | `rp_pub_<slug>_*` | auto on Application create | customer's browser (`@relipay/react`) | identifier only — never carries privilege |
| **End-user session** | `eu_access` JWT + 30-day refresh | `/api/v1/auth/sign-in` (or OAuth callback after MFA, if any) | customer's server forwards to ReliPay | scoped to one EndUser within one Application |
| **MFA challenge token** | `eu_mfa_challenge` / `to_mfa_challenge` JWT (5 min) | sign-in path when MFA enrolled | exchange at `/auth/mfa-verify` | NOT a session; bound to (user, application, time) |
| **Magic-link token** | 32-byte CSPRNG, SHA-256 in DB (15 min) | `/auth/magic-link/request` | exchange at `/auth/magic-link/verify` | single use; auto-creates user on consume when sign-up enabled; captures email at issue |
| **Passkey credential** | WebAuthn-issued credential id + COSE public key, in `WebAuthnCredential` | registered via `/auth/passkey/register/*` from an authenticated session | authenticate via `/auth/passkey/authenticate/*` | scoped to Application's `rpId` + `rpOrigins`; counter advanced monotonically per assertion |
| **Impersonation token** | `eu_access` JWT with extra `imp` claim (5 min, no refresh) | `/tenant/applications/:id/end-users/:euid/impersonate` (OWNER/ADMIN) | end-user-side routes accept it identically to a real session | every minting writes an `ImpersonationAudit` row with operator id + reason + UA/IP |
| **Password reset / email verify token** | 32-byte CSPRNG, SHA-256 in DB | `/auth/forgot-password`, `/auth/send-verification` | single use; password-reset 1 h, email-verify 24 h | scoped to (user, application); email-verify also captures email at issue |
| **Invitation token** | 32-byte CSPRNG, SHA-256 in DB | `/api/v1/tenant/invitations` | accept once | scoped to (Tenant, email, role) |
| **OAuth state** | caller-supplied, round-tripped | customer's server | CSRF guard | customer owns the verification |
| **Webhook signing secret** | 32-byte hex, plaintext in DB (one per `WebhookEndpoint`) | endpoint creation in panel | inbound HMAC verification by the customer | scoped to one endpoint; rotatable |

Cross-tier confusion is **defended at the `typ` JWT claim**: every JWT
carries `typ` and verifiers refuse the wrong value. End-user and operator
tokens use the same `JWT_SECRET` but cannot impersonate each other.

---

## 3. The two parallel auth flows (intentionally duplicated)

End-user (`modules/auth`) and operator (`modules/tenant-auth`) auth
share primitives (argon2id, JWT, refresh token, password-reset, MFA)
but are physically duplicated — each has its own service, routes, libs,
and DB tables. We've kept them parallel rather than parameterising over
"audience" because:

- They authenticate to different DB models (`EndUser` vs `TenantUser`)
  with different schemas, indexes, and lifecycle (Application-scoped vs
  global-but-multi-Tenant).
- The JWT claim shapes diverge (`{sub, applicationId}` vs `{sub, tid,
  rol}`).
- Different rate-limiting / audit posture is likely in the future.
- The duplication is small and stays auditable.

When a fix lands in one, a periodic diff sanity-check ensures the other
mirrors it (see refresh-token family revocation, MFA enforcement,
sessions list — all applied to both surfaces during Phase 1 + 2).

Files involved:

| Concern | End-user | Operator |
|---|---|---|
| Service | `modules/auth/auth.service.ts` | `modules/tenant-auth/tenant-auth.service.ts` |
| Routes | `modules/auth/auth.routes.ts` | `modules/tenant-auth/tenant-auth.routes.ts` |
| Middleware | `middleware/user-session.ts` | `middleware/tenant-session.ts` |
| JWT lib | `lib/jwt.ts` | `lib/tenant-jwt.ts` |
| Refresh token | `lib/refresh-tokens.ts` | `lib/tenant-refresh-tokens.ts` |
| Password reset | `lib/password-reset.ts` | `lib/tenant-password-reset.ts` |
| MFA | `modules/mfa` | `modules/tenant-mfa` |
| Table prefix | `end_users` / `refresh_tokens` / etc. | `tenant_users` / `tenant_refresh_tokens` / etc. |

---

## 4. Billing state machine

A `Subscription` carries the full purchase lifecycle. State transitions
happen in **webhooks only** — the API request that initiates checkout
creates a `PENDING` row but does NOT activate it.

```
                       ┌─────────┐
   POST /billing/      │ PENDING │
   checkout    ───────▶│         │
                       └────┬────┘
                            │
       checkout.session.completed
                            │
                            ▼
                       ┌─────────┐
                       │ ACTIVE  │◀─────────┐
                       └────┬────┘          │
                            │               │ invoice.paid
            invoice.        │               │ (when previously PAST_DUE)
            payment_failed  │               │
                            ▼               │
                       ┌─────────┐          │
                       │ PAST_DUE│──────────┘
                       └────┬────┘
                            │
            customer.subscription.deleted
                            │
                            ▼
                       ┌─────────┐
                       │CANCELED │
                       └─────────┘
```

`EXPIRED` exists for incomplete-and-abandoned states from Stripe's
`incomplete` / `incomplete_expired`. The mapping lives in
`webhooks/stripe.handler.ts > mapStripeSubStatus`.

**Coupon redemption** is recorded ONCE at `invoice.paid` time, never at
checkout creation (Audit-2 2026-05-19). Idempotency: `CouponRedemption`
has a unique index on `(couponId, paymentId)` so webhook replays land
on the same row.

**License auto-issue** happens at `checkout.session.completed` for
plans of `kind = LICENSE`. Idempotent on `(applicationId, endUserId,
planId)` — webhook replays don't double-issue.

**Per-Application BYO billing credentials**: `BillingCredentials` table
keyed by `(applicationId, provider)`. Each Application can have any
subset of `{stripe, paypal, razorpay}` configured and one becomes the
default per country. Encrypted ciphertext at rest (AES-256-GCM via
`lib/secrets.ts`).

---

## 5. Outbound side-effects model

Every auth flow that mutates user state fires two parallel signals:

1. **Transactional email** via `emailService.dispatch(...)`. Six events,
   each with a per-Application override (`EmailTemplate` row) or a
   built-in default. Resend transport: BYO encrypted Resend key per
   Application → `RESEND_DEFAULT_*` env fallback → return raw token to
   caller (legacy mode for self-hosters).
2. **Webhook** via `webhookService.emit(...)`. Up to 5 attempts with
   exponential backoff. HMAC-SHA256 signed. Per-endpoint subscription
   list (`["*"]` for all).

Both are `void … .catch(() => undefined)` — neither blocks the
user-facing response. Auth flows that emit:

| Flow | Email event | Webhook event |
|---|---|---|
| Password sign-up | `welcome` | `user.created` |
| OAuth new user | `welcome` | `user.created` |
| Password reset (consume token) | `password_changed` | `password.changed` |
| Authenticated change-password | `password_changed` | `password.changed` |
| MFA confirm | `mfa_enabled` | `mfa.enabled` |
| MFA disable | — | `mfa.disabled` |
| Email verify (consume token) | — | `email.verified` |
| Forgot-password issue | `password_reset` | — |
| Send verification | `email_verification` | — |
| Workspace invitation | `workspace_invitation` (system pool) | — |
| `DELETE /sessions/:id` | — | `session.revoked` |

---

## 6. Security posture summary (what guards each surface)

| Surface | Auth | Cross-tenant guard | Rate limit | CORS |
|---|---|---|---|---|
| `/api/v1/auth/*` (public, unauth) | Application secret key + scope `auth:write` | `applicationId` claim on JWT | global 100/min/IP | strict allowlist |
| `/api/v1/auth/*` (authenticated end-user) | Secret key + `eu_access` JWT | Both `applicationId` claims must match | global 100/min/IP | strict allowlist |
| `/api/v1/users/me/*` | Secret key + `eu_access` JWT | same as above | global | strict allowlist |
| `/api/v1/billing/*` | Secret key + (optional) `eu_access` JWT | same | global | strict allowlist |
| `/api/v1/billing/webhook/*` | Provider HMAC signature | `metadata.applicationId` on event | global | n/a (server-to-server) |
| `/api/v1/tenant/*` | `to_access` JWT | `tid` claim + membership re-check from DB | global | strict allowlist |
| `/api/v1/admin/*` | `SUPER_ADMIN_KEY` constant-time compare | n/a (bootstrap only) | global | strict allowlist |

**`typ` JWT claim** is load-bearing. Every JWT carries one of
`eu_access`, `eu_mfa_challenge`, `to_access`, `to_mfa_challenge`, and
verifiers refuse mismatched types — an end-user JWT can never
impersonate an operator JWT even though they share `JWT_SECRET`.

**Refresh-token family revocation** is the response to reuse-detection:
a replayed (already-revoked) token triggers `revokeAllForEndUser` /
`revokeAllTenantRefreshTokensForUser`, killing every live session for
that account. Concurrent rotation races map to the same code path
(Audit-2 2026-05-19).

**OAuth auto-link** requires `emailVerified: true` from the provider.
Unverified emails are refused with `OAUTH_EMAIL_NOT_VERIFIED` —
account-takeover via unverified-email provider accounts is closed.

**MFA enforcement** at sign-in: enrolled users get
`{mfaRequired: true, mfaChallengeToken}` (5-min lifetime, typ-gated)
instead of session tokens. Exchange via `/auth/mfa-verify`.

**API key scopes** are enforced via `requireScope(scope)` hierarchy:
`*` ⊃ everything, `auth:write` ⊃ `auth:read`, `billing:write` ⊃
`billing:read`. Leaf scopes (e.g. `webhooks:read`) must be granted
explicitly.

**Outbound webhook SSRF guard**: `isWebhookUrlSafe` rejects
loopback/private/link-local/CGNAT IPs and non-HTTP schemes at
endpoint-create time. Opt-in via `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`
for self-hosted intra-VPC deployments. Tests flip it via
`test/global-setup.ts`.

**Race-safe billing state mutations** (Audit-2 2026-05-19):
- License seat allocation uses `SELECT … FOR UPDATE` on the license
  row → atomic count+upsert.
- Coupon redemption uses `SELECT … FOR UPDATE` on the coupon row →
  atomic limit re-check + insert. Plus a `(couponId, paymentId)`
  unique index for webhook-replay idempotency.
- Refresh token rotation uses `updateMany WHERE revokedAt = null` →
  the loser of a race gets count=0 and the caller maps that to
  `REFRESH_TOKEN_REUSED` + family revocation.
- Workspace invitation acceptance catches `P2002` on the unique
  membership index → idempotent re-accept.

**Amount validation in billing webhooks**: Stripe payment amounts are
clamped to `MAX_PAYMENT_AMOUNT = 10_000_000_000` (USD-equiv $100M).
Anything beyond is logged and refused — almost certainly a provider
unit mismatch (dollars vs cents).

---

## 7. Top-level file layout

```
apps/
  api/                       Fastify backend (this is the audited core)
    src/
      app.ts                 — Fastify build, plugin registration, CORS, raw-body
      config/env.ts          — t3-env schema (single source of truth for env)
      lib/                   — primitives (no business logic)
        jwt.ts               — end-user JWT (typ-discriminated)
        tenant-jwt.ts        — operator JWT (typ-discriminated)
        refresh-tokens.ts    — end-user refresh + sessions list + revoke
        tenant-refresh-tokens.ts — same for operators
        password-reset.ts    / tenant-password-reset.ts
        email-verification.ts
        passwords.ts         — argon2id hash + verify
        keys.ts              — API key generation + SHA-256
        license-keys.ts
        mfa.ts               — TOTP + backup codes (shared by end-user + operator MFA)
        secrets.ts           — AES-256-GCM encrypt/decrypt (BYO billing creds, MFA secrets, OAuth secrets, Resend keys)
        email-transport.ts   — Resend BYO + default pool + system-level dispatch
        webhook-signing.ts   — HMAC sign / verify + SSRF URL safety
        tenant-invitations.ts
        prisma.ts            — Prisma client singleton
        error.ts             — RelipayError + Fastify error handler
        swagger.ts
      middleware/
        api-key-auth.ts      — Application secret key + requireScope
        user-session.ts      — eu_access JWT verification + applicationId guard
        tenant-session.ts    — to_access JWT verification + workspace re-check
        admin-auth.ts        — SUPER_ADMIN_KEY constant-time compare
      modules/
        auth/                — end-user auth (sign-up / in / refresh / reset / verify)
        tenant-auth/         — operator auth (parallel)
        oauth/               — OAuth providers + handleCallback + link/unlink
          providers/         — google, github, microsoft, discord, gitlab, slack, oidc
        mfa/ tenant-mfa/     — TOTP enroll / confirm / challenge / disable
        api-keys/            — API key CRUD + scopes
        end-user-roles/      — per-Application RBAC catalog (default-role enforcement)
        tenants/             — bootstrap admin Tenant CRUD
        applications/        — bootstrap admin Application CRUD
        tenant-applications/ — tenant-scoped Application + plan + coupon + api-key CRUD
        tenant-workspaces/   — workspace members + invitations
        billing/             — plans listing + checkout + provider selection
          providers/         — stripe-real, stripe-stub, paypal, razorpay
          webhooks/          — inbound Stripe webhook handler
        plans/ coupons/ licenses/ usage/  — billing-tier surfaces
        email/               — template registry, render, transport, tenant routes, Unlayer-driven editor on panel side
        webhooks/            — outbound webhook endpoint CRUD + delivery + retry
      routes/                — top-level glue (health, me, users-me)
    test/                    — vitest suites; 143 tests across 14 files
  panel/                     — Next.js operator panel (App Router, server actions, Tailwind)
packages/
  shared-types/              — Zod schemas + types shared between API and SDKs
  sdk-node/                  — server SDK (Application secret key)
  sdk-react/                 — browser SDK (public key)
  sdk-nextjs/                — Next.js server-action + middleware helpers
  cli/                       — relipay CLI
  mcp/                       — Model Context Protocol surface
prisma/
  schema.prisma              — single Prisma schema for the whole monorepo
  migrations/                — 15 migrations as of 2026-05-19
```

---

## 8. Operator-time configuration (env)

| Variable | Purpose | Required where |
|---|---|---|
| `DATABASE_URL` | Postgres | always |
| `REDIS_URL` | reserved | optional |
| `JWT_SECRET` | signs end-user + operator + MFA-challenge JWTs | always |
| `ENCRYPTION_KEY` | AES-256-GCM for BYO secrets at rest | required in production |
| `SUPER_ADMIN_KEY` | bootstrap admin path | always |
| `STRIPE_API_KEY` | optional — falls back to stub provider when unset | when accepting Stripe |
| `RESEND_DEFAULT_API_KEY` + `RESEND_DEFAULT_FROM` (+ `..._NAME`) | hosted Resend pool for tenants without BYO Resend creds | hosted ReliPay only |
| `CORS_ALLOWED_ORIGINS` | comma-separated allowlist for browser callers | always (dev permits localhost regardless) |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS` | opt-in escape from the SSRF guard for intra-VPC webhook URLs | self-hosters only |

---

## 9. Decision index

Every architectural / product / security decision lives in
[`decisions.md`](decisions.md) as a chronologically-appended log.
The index below points at the load-bearing ones.

**Foundational (Phase 0)**:
- `2026-05-06 17:39 · Schema · One Prisma schema, single shared DB, no per-tenant schema`
- `2026-05-06 17:39 · Auth primitives · argon2id + JWT HS256 + opaque CSPRNG refresh`
- `2026-05-06 17:39 · Encryption at rest · AES-256-GCM for BYO secrets`
- `2026-05-06 18:47 · Auth · Hand-rolled, NOT better-auth`

**Multi-tenancy + ops surface**:
- `2026-05-06 02:15 · OAuth · Pluggable per-Application providers`
- `2026-05-06 02:26 · Panel auth · Two cookies + cookie-aware api()`

**Phase 1 security (2026-05-19 03:10 batch)**:
- JWT `typ` claim (`eu_access` / `eu_mfa_challenge` / `to_access` / `to_mfa_challenge`)
- Refresh-token family revocation on reuse-detection
- MFA enforcement at sign-in (end-user + operator + OAuth) via challenge token
- OAuth auto-link gated on provider `email_verified`
- CORS env-driven allowlist (kills reflective `origin: true`)
- Cookie `secure` env-branched
- API key scope hierarchy + per-route enforcement
- SDK `SignInOutcomeDto` discriminated union

**Phase 2 features (2026-05-19 04:00–04:45 batch)**:
- Per-Application transactional email pipeline (Resend BYO + hosted default)
- Email verification flow with stale-email + cross-app guards
- Lifecycle events fan out to email + outbound webhooks
- OAuth account linking with verified-email + lockout guards
- Sessions list + per-device revoke (UA/IP captured at issue)
- Outbound user-lifecycle webhooks (HMAC-SHA256 signing, 5-attempt backoff)
- Wildcard `["*"]` subscription receives all + future events
- Panel Email + Webhooks tabs (Unlayer email builder embed)

**Audit-2 (2026-05-19 05:50–06:00 batch)**:
- Stripe webhook amount validation (`MAX_PAYMENT_AMOUNT` clamp)
- Coupon redemption deferred to `invoice.paid` (closes abandon-checkout abuse)
- Coupon redemption atomic with `SELECT … FOR UPDATE` + unique `(couponId, paymentId)` index
- License seat-allocation atomic with `SELECT … FOR UPDATE` on the license row
- Password reset wraps revoke-all + hash-update in a single transaction
- Wrapped billing-credential decryption fail-loud on bad ciphertext
- Outbound webhook SSRF guard (private/loopback IP refusal, opt-in escape)
- Workspace invitation acceptance handles `P2002` race idempotently
- Refresh-token rotation race surfaces as `REFRESH_TOKEN_REUSED` (was 500)
- Coupon `planSlugs` normalised to lowercase on storage

**Audit-3 + market-driven feature additions (2026-05-19 06:30–07:05 batch)**:
- `MARKET.md` — competitive matrix vs Clerk / better-auth / Auth0 / WorkOS / Supabase / Stripe Billing / Paddle / Lago
- `UX-AUDIT.md` — heuristic review of the operator panel (48 findings)
- **Modal a11y**: trigger replaced with semantic `<button>`, `aria-labelledby` + `aria-describedby` wired
- **MFA setup secret out of URL** into a short-lived HttpOnly cookie (`relipay_mfa_setup`, path-scoped, 5-min TTL)
- **Orphan unauth `accept` action removed** from `accept-invite/page.tsx`
- **Banner a11y sweep**: `role="alert"` on red banners, `aria-live="polite"` on emerald banners (42 sites)
- **Magic-link sign-in**: new `MagicLinkToken` table + `/auth/magic-link/{request,verify}` + SDK methods + `magic_link_signin` email event + welcome side-effects for new-user consume
- **HIBP Pwned Passwords breach check** at sign-up / change-password / reset, gated per-Application + env kill-switch
- **Per-user account lockout** (`EndUser.failedSignInAttempts` + `lockedUntil`) — 10 failures → 15-min lockout → 429 + Retry-After
- `RelipayError.retryAfterSeconds` + error-handler header support

**Audit-4 (2026-05-19 13:30–13:40 batch)**:
- **Passkeys / WebAuthn** shipped: new `WebAuthnCredential` table, `lib/webauthn.ts` (SimpleWebAuthn wrapper), four routes (register/start + register/complete + authenticate/start + authenticate/complete) plus list + delete, per-Application `authConfig.webauthn.{rpId, rpOrigins, rpName}`, SDK helpers, MFA-bypass-on-authenticate (passkey is itself a strong factor).
- **Operator impersonation** shipped: new `ImpersonationAudit` table, `imp` claim on `eu_access` JWT, `lib/jwt.ts > issueImpersonationToken` (5-min lifetime, NO refresh), `POST /tenant/applications/:id/end-users/:euid/impersonate` (OWNER/ADMIN-only). Every minting creates an audit row with operator id + reason + UA/IP.
- **Panel UX HIGH sweep**: `SubmitButton` client component using `useFormStatus()` for in-flight pending state, color-contrast pass replacing `text-neutral-400/500` with `text-neutral-600 dark:text-neutral-{400,500}` so light-mode body text clears WCAG AA.
- Test suites: `audit-4.test.ts` (passkeys + impersonation, 8 tests, SimpleWebAuthn verifiers mocked).

**Audit-5 (2026-05-19 14:00–14:05 batch)**:
- **End-user Organizations** shipped: new `Organization` + `OrganizationMembership` + `OrganizationInvitation` tables + `OrganizationRole` enum (`OWNER` / `ADMIN` / `MEMBER`). `modules/organizations` service + two route plugins: `organizationsAuthenticatedRoutes` at `/api/v1/users/me/organizations` and `organizationsAcceptInvitationRoutes` at `/api/v1/auth/organizations`. Role hierarchy enforced by `canManage` ladder; last-OWNER guard prevents org from going OWNER-less via remove / leave / role-downgrade. Invitations 7-day single-use; idempotent on concurrent accept via P2002 on `(organizationId, endUserId)`. Cross-Application invitation refusal. Per-Application gating via `authConfig.organizationsEnabled` (default false).
- **Panel: end-user detail page** shipped at `/applications/[id]/end-users/[euid]`: profile, impersonate form (OWNER/ADMIN-only, reason captured), passkeys table, recent impersonations table. Backed by new `GET /tenant/applications/:id/end-users/:euid` returning `{ endUser, passkeys, recentImpersonations }`. Impersonation token revealed via short-lived HttpOnly cookie `relipay_impersonate_reveal` (6-min, path-scoped) — token never on URL, never in browser history.
- **Details link** on end-users list page row actions points to the new detail page.
- Test suite: `audit-5.test.ts` (organizations, 9 tests — create, list, member-cap on canManage, last-OWNER guard via remove/leave/role-set, cross-Application invitation refusal, P2002 idempotency on concurrent accept).

**Audit-6 (2026-05-19 16:30–16:45 batch)**:
- **Operator passkeys** shipped: new `TenantWebAuthnCredential` table + `lib/tenant-webauthn.ts` (SimpleWebAuthn wrapper, panel-RP config from env) + `modules/tenant-passkeys` service + route plugins under `/api/v1/tenant/auth/passkeys`. Register (auth) + Authenticate (public, usernameless) + List + Delete. Panel UI at `/account/passkeys` driving ceremony via `@simplewebauthn/browser` + new `PasskeyRegisterButton` client component. Sign-in via passkey bypasses TOTP MFA (passkey is itself a strong factor).
- **UX HIGH + MEDIUM sweep** (10 items): `TypedConfirmButton` for highest-stakes destructive ops, `lib/flash.ts` + `FlashBanner` (read-once cookie pattern), `lib/date.ts` (locale-stable formatting), `ErrorBanner` + `requestId` surface on every API error envelope + `X-Request-Id` header, `Modal.size` prop (sm/md/lg/xl), `BillingModeAutodetect` (prefix → live/test), `CouponAmountPreview` (live $X.XX), Stripe webhook URL refusal when `RELIPAY_URL` unset, `Tab` scrollIntoView + nav gradient mask, sign-out button promoted, workspace danger-zone de-escalated. SlugAvailabilityField switched from `querySelector` to `form.elements.namedItem` + ARIA. All `<th>` action cells use `<span class="sr-only">Actions</span>` instead of `&nbsp;`.
- Test suite: `tenant-passkeys.test.ts` (5 tests — auth required, empty list, env-gated registration error, options when configured, cross-operator delete refusal).

**Audit-6 (2026-05-19 17:00 SDK + regressions batch)**:
- **SDK parity** with the API: new `OrganizationsClient` + `LicensesClient` + `UsageClient`, expanded `AuthClient` (`sendVerificationEmail`, `verifyEmail`), `RelipayError.requestId`. Standalone `verifyWebhookSignature` helper for inbound HMAC verification.
- **SDK integration test suite** (`sdk.test.ts`, 12 tests) drives the real `ReliPay` class against the in-process app via a fetch shim — every public route has a contract test.
- **Audit-6 regression tests** (`audit-6.test.ts`, 4 tests): error envelopes carry `requestId` + `X-Request-Id` header; magic-link replay returns `MAGIC_LINK_USED`; cross-Application detail-route refusal.
- **Total suite: 20 files, 191 tests, all green.**

---

## 10. Cross-cutting invariants

- **Hash-only credentials at rest.** API keys, refresh tokens, password
  reset tokens, email verification tokens, license keys, invitation
  tokens, MFA backup codes — all stored as SHA-256 hashes. Raw values
  are shown once at issue, never queryable.
- **Encrypted secrets at rest.** Anything where the cleartext is needed
  later (Stripe API keys, OAuth client secrets, Resend API keys, MFA
  TOTP secrets) is AES-256-GCM-encrypted via `lib/secrets.ts`. `v1.…`
  prefix lets us rotate the algorithm without breaking old rows.
- **No `===` on credentials.** Constant-time compare via `timingSafeEqual`
  in `lib/keys.ts` and `middleware/admin-auth.ts`. SHA-256 lookup on an
  indexed column is already constant-time at the DB level.
- **Cross-tenant guard at every authenticated entry point.** End-user
  JWT carries `applicationId`; operator JWT carries `tid`. The
  resolving middleware refuses mismatched claims.
- **Webhook idempotency via DB unique constraints**, not application-
  layer cache. `WebhookEvent.(provider, providerEventId)` for inbound;
  `Payment.providerPaymentId` for payment recording; `CouponRedemption.
  (couponId, paymentId)` for redemption recording; `LicenseActivation.
  (licenseId, machineFingerprint)` for activation recording.
- **State transitions only from provider events**, never from the API
  request that initiated them. The `PENDING` row is bookkeeping; only
  `checkout.session.completed` / `invoice.paid` move it to `ACTIVE`.
- **Fire-and-forget side-effects** (`emailService.dispatch`,
  `webhookService.emit`) NEVER block the user-facing response. A slow
  receiver is the receiver's problem; the user just signed up and
  shouldn't wait for SMTP.

---

## 11. Known follow-ups (not blocking, tracked for honest accounting)

- **In-process webhook retry worker** — `setTimeout` on the same Node
  process. Crash-survivable retries require a queue (BullMQ); the
  persistence layer (`WebhookDelivery.nextAttemptAt`) is already
  worker-friendly.
- ✅ ~~Per-email / per-account lockout~~ — shipped 2026-05-19 via
  `EndUser.{failedSignInAttempts, lockedUntil}` + 429 `TOO_MANY_FAILED_ATTEMPTS`
  with Retry-After. Global IP throttle remains for unknown emails.
- ✅ ~~HIBP-style breached-password check~~ — shipped 2026-05-19 via
  `lib/breached-password.ts`. Per-Application opt-out
  (`authConfig.passwordBreachCheckEnabled`) + env kill-switch
  (`HIBP_BREACH_CHECK_DISABLED`).
- ✅ ~~Passkeys / WebAuthn~~ — shipped 2026-05-19 via `WebAuthnCredential` +
  `lib/webauthn.ts` (SimpleWebAuthn wrapper). Per-Application
  `authConfig.webauthn.{rpId, rpOrigins, rpName}` configuration; passkey
  authentication bypasses MFA challenge.
- ✅ ~~End-user Organizations~~ — shipped 2026-05-19 via `Organization`
  + `OrganizationMembership` + `OrganizationInvitation` (OWNER / ADMIN /
  MEMBER hierarchy, last-OWNER guard, cross-Application invitation
  refusal). Per-Application opt-in via `authConfig.organizationsEnabled`.
- **JWKS / RS256 JWT signing** — single shared HS256 secret today;
  rotation invalidates every session globally and SDKs can't verify
  offline. Move to RS256 + `/.well-known/jwks.json` for hosted-multi-
  region or offline-verify scenarios. `MARKET.md` highest-leverage
  gap #5.
- ✅ ~~Impersonation~~ — shipped 2026-05-19 via `ImpersonationAudit` +
  `imp` claim on a 5-min `eu_access` JWT. `POST /tenant/applications/:id/
  end-users/:euid/impersonate` (OWNER/ADMIN). No refresh token issued.
- **SAML / Enterprise SSO + Admin Portal for IdP self-config** —
  high-revenue-uplift item, deferred until after passkeys / orgs.
- **`Number` for amounts** — billing amounts use JS `Number`. Safe up
  to 9 quadrillion cents (`Number.MAX_SAFE_INTEGER`); the
  `MAX_PAYMENT_AMOUNT` clamp at 10 billion cents keeps us comfortably
  inside. BigInt migration is unnecessary for the foreseeable future
  but worth tracking.
- **Live browser E2E (Claude_Preview)** — attempted this session but
  blocked by port conflicts with parent-worktree dev servers. The 153-
  test in-process suite covers the same flows end-to-end via
  `app.inject()`.
