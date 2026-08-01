# Rekey — Architecture

A self-hostable auth + billing backend for SaaS / B2C apps. One Rekey
deployment serves many **Tenants** (your customers), each owning many
**Applications** (their products), each owning many **EndUsers** (their
end-users) plus **Plans / Coupons / Licenses / UsageMeters / etc.**

There are two parallel auth pillars:

- **Operators** — humans who run a Tenant via the Rekey panel.
- **End-users** — people who sign into an Application through the SDKs.

This document describes how the system is put together so you can find your
way around the code and extend it.

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
│   Operator  │      │                       Rekey API                       │
│  (tenant    │      │                                                          │
│   admin)    │      │   ┌──────────────────────┐  ┌───────────────────────┐   │
│             │◀────▶│   │  Operator surface    │  │  End-user surface     │   │
│  Panel      │ 1.   │   │  /api/v1/tenant/*    │  │  /api/v1/auth/*       │   │
│  (Next.js)  │      │   │  /api/v1/admin/*     │  │  /api/v1/users/me/*   │   │
└─────────────┘      │   │                      │  │  /api/v1/billing/*    │   │
                     │   │  Auth: TenantUser    │  │  Auth: Application    │   │
                     │   │  JWT (typ=to_access) │  │  API key (rp_live_…)  │   │
                     │   │  with `tid` + `rol`  │  │  + end-user JWT       │   │
                     │   │                      │  │  (typ=eu_access)      │   │
                     │   └─────────┬────────────┘  └─────────┬─────────────┘   │
                     │             └──────────┬───────────────┘                 │
                     │                        │                                 │
                     │             ┌──────────▼───────────┐                     │
                     │             │ Postgres (Prisma)    │                     │
                     │             │ Tenants ─┬─ Apps     │                     │
                     │             │          ├─ EndUsers │                     │
                     │             │          ├─ Plans / Subscriptions / Payments │
                     │             │          ├─ Coupons + CouponRedemptions    │
                     │             │          ├─ Licenses + Activations         │
                     │             │          ├─ UsageMeters + UsageRecords     │
                     │             │          ├─ ApiKeys (hash-only)            │
                     │             │          ├─ RefreshTokens (hash-only)      │
                     │             │          ├─ OAuthIdentities                │
                     │             │          ├─ MfaCredentials (encrypted)     │
                     │             │          ├─ WebAuthnCredential (passkeys)  │
                     │             │          ├─ EmailTemplates                 │
                     │             │          ├─ WebhookEndpoints + Deliveries  │
                     │             │          └─ WebhookEvents (inbound idem.)  │
                     │             └──────────────────────┘                     │
                     │                                                          │
                     │   ┌──────────────────────────────────────────────────┐   │
                     │   │ Outbound side-effects (fire-and-forget)          │   │
                     │   │  emailService.dispatch ──▶ Resend (BYO / pool)   │──▶ 4a. transactional email
                     │   │  webhookService.emit  ──▶ HMAC-signed POST       │──▶ 4b. customer's webhook URL
                     │   └──────────────────────────────────────────────────┘   │
                     └──────────────────────────────────────────────────────────┘
                                                  ▲
                                                  │ 2. SDK call
                                                  │    (Application secret key +
                                                  │     optional X-Rekey-User-Token)
                                                  │
                          ┌───────────────────────┴───────────────────────┐
                  ┌───────▼───────┐                                ┌───────▼───────┐
                  │  Customer's   │  3b. fetch on browser →        │  Customer's   │
                  │   server      │      @rekey.dev/react sends      │   browser     │
                  │  (@rekey.dev/   │      X-Rekey-User-Token      │  (@rekey.dev/   │
                  │   node /      │      direct from JWT cookie    │   react)      │
                  │   nextjs)     │                                │               │
                  └───────────────┘                                └───────────────┘
```

**Numbered flows:**

1. **Operator panel** signs in via `/api/v1/tenant/auth/sign-in`, receives a
   `{tid, rol}` JWT + refresh token as cookies. MFA-enrolled operators pass
   through `/tenant/auth/mfa-verify` before getting tokens.

2. **End-user SDK calls** carry the Application secret key
   (`Authorization: Bearer rp_live_…`) and, for per-user endpoints, an
   end-user JWT (`X-Rekey-User-Token`). The middleware checks that (a) the
   secret key resolves to an Application, (b) the key's `scopes` permit the
   route, and (c) the user JWT's `applicationId` claim matches.

3a. **Inbound billing webhook** from a provider is signature-verified,
   recorded in `WebhookEvent` for idempotency, then dispatched to its handler.
   Subscription/payment state transitions happen here — never in the API
   request path.

3b. **Browser SDK** talks to the customer's own server (with cookies); that
   server forwards to Rekey via `@rekey.dev/node`. The browser never holds the
   secret key.

4a. **Outbound transactional email** via Resend — either a BYO key per
   Application or the Rekey-managed pool. When no transport is configured the
   API returns the raw token to the caller instead (self-host fallback).

4b. **Outbound webhooks** notify the customer's server of user-lifecycle events
   (`user.created`, `mfa.enabled`, `password.changed`, `session.revoked`,
   `email.verified`, …). HMAC-SHA256 signed as
   `X-Rekey-Signature: t=<unix>,v1=<hex>`, with up to 5 retry attempts on
   exponential backoff (30s / 2m / 10m / 1h / 4h).

---

## 2. Auth tiers (trust boundaries)

| Tier | Credential | Issued by | Used by | Scope |
|---|---|---|---|---|
| **Bootstrap admin** | `SUPER_ADMIN_KEY` env | the deployer | `rekey` CLI, first Tenant + Application bootstrap | global; `/api/v1/admin/*` only |
| **Operator session** | `to_access` JWT + 30-day refresh | `/api/v1/tenant/auth/sign-in` | the panel | one Tenant (`tid`) + role (`rol`) |
| **Application secret key** | `rp_live_*` / `rp_test_*` | operator via panel | customer's server (`@rekey.dev/node`) | one Application; `scopes` array gates routes |
| **Application public key** | `rp_pub_<slug>_*` | auto on Application create | customer's browser (`@rekey.dev/react`) | identifier only — never carries privilege |
| **End-user session** | `eu_access` JWT + 30-day refresh | `/api/v1/auth/sign-in` | customer's server forwards to Rekey | one EndUser within one Application |
| **MFA challenge token** | `eu_mfa_challenge` / `to_mfa_challenge` JWT (5 min) | sign-in when MFA enrolled | exchange at `/auth/mfa-verify` | not a session; bound to (user, application, time) |
| **Magic-link token** | 32-byte CSPRNG, SHA-256 in DB (15 min) | `/auth/magic-link/request` | exchange at `/auth/magic-link/verify` | single use; auto-creates user on consume when sign-up enabled |
| **Passkey credential** | WebAuthn credential id + COSE public key (`WebAuthnCredential`) | `/auth/passkey/register/*` | `/auth/passkey/authenticate/*` | Application `rpId` + `rpOrigins`; counter advances per assertion |
| **Impersonation token** | `eu_access` JWT with `imp` claim (5 min, no refresh) | `/tenant/applications/:id/end-users/:euid/impersonate` (OWNER/ADMIN) | end-user routes accept it like a real session | every mint writes an `ImpersonationAudit` row |
| **Password reset / email verify** | 32-byte CSPRNG, SHA-256 in DB | `/auth/forgot-password`, `/auth/send-verification` | single use; reset 1h, verify 24h | (user, application) |
| **Invitation token** | 32-byte CSPRNG, SHA-256 in DB | `/api/v1/tenant/invitations` | accept once | (Tenant, email, role) |
| **Webhook signing secret** | 32-byte hex, one per `WebhookEndpoint` | endpoint creation in panel | inbound HMAC verification by the customer | one endpoint; rotatable |

Every JWT carries a **`typ` claim** (`eu_access`, `eu_mfa_challenge`,
`to_access`, `to_mfa_challenge`) and verifiers refuse the wrong value.
End-user and operator tokens share the same `JWT_SECRET` but cannot
impersonate each other.

---

## 3. The two parallel auth stacks

End-user auth (`modules/auth`) and operator auth (`modules/tenant-auth`)
share primitives (argon2id, JWT, refresh tokens, password reset, MFA) but are
physically duplicated — each authenticates a different DB model
(`EndUser`, Application-scoped, vs `TenantUser`, global-but-multi-Tenant) with
a different JWT claim shape. Where to find each half:

| Concern | End-user | Operator |
|---|---|---|
| Service | `modules/auth/auth.service.ts` | `modules/tenant-auth/tenant-auth.service.ts` |
| Routes | `modules/auth/auth.routes.ts` | `modules/tenant-auth/tenant-auth.routes.ts` |
| Middleware | `middleware/user-session.ts` | `middleware/tenant-session.ts` |
| JWT lib | `lib/jwt.ts` | `lib/tenant-jwt.ts` |
| Refresh token | `lib/refresh-tokens.ts` | `lib/tenant-refresh-tokens.ts` |
| Password reset | `lib/password-reset.ts` | `lib/tenant-password-reset.ts` |
| MFA | `modules/mfa` | `modules/tenant-mfa` |
| Table prefix | `end_users` / `refresh_tokens` / … | `tenant_users` / `tenant_refresh_tokens` / … |

---

## 4. Billing lifecycle

A `Subscription` carries the purchase lifecycle. State transitions happen in
**webhook handlers only** — the API request that initiates checkout creates a
`PENDING` row but does not activate it.

```
   POST /billing/checkout ──▶ ┌─────────┐
                              │ PENDING │
                              └────┬────┘
                checkout.session.completed
                                   ▼
                              ┌─────────┐   invoice.paid
                              │ ACTIVE  │◀────────────┐ (from PAST_DUE)
                              └────┬────┘             │
                  invoice.payment_failed              │
                                   ▼                  │
                              ┌─────────┐             │
                              │ PAST_DUE│─────────────┘
                              └────┬────┘
                customer.subscription.deleted
                                   ▼
                              ┌─────────┐
                              │CANCELED │
                              └─────────┘
```

`EXPIRED` covers Stripe's `incomplete` / `incomplete_expired`. Status mapping
lives in `webhooks/stripe.handler.ts > mapStripeSubStatus`.

- **Coupon redemption** is recorded once at `invoice.paid`, never at checkout
  creation. `CouponRedemption` has a unique index on `(couponId, paymentId)`
  so webhook replays are idempotent.
- **License auto-issue** happens at `checkout.session.completed` for plans of
  `kind = LICENSE`, idempotent on `(applicationId, endUserId, planId)`.
- **Per-Application billing credentials** live in `BillingCredentials`, keyed
  by `(applicationId, provider)`. Each Application can configure any subset of
  `{stripe, paypal, razorpay}`; secrets are AES-256-GCM-encrypted at rest via
  `lib/secrets.ts`.

---

## 5. Outbound side-effects

Every auth flow that mutates user state fires two parallel, fire-and-forget
signals — neither blocks the user-facing response:

1. **Transactional email** via `emailService.dispatch(...)`. Each event has a
   per-Application `EmailTemplate` override or a built-in default. Transport
   resolution: BYO encrypted Resend key per Application → `RESEND_DEFAULT_*`
   env pool → return raw token to caller.
2. **Webhook** via `webhookService.emit(...)`. HMAC-SHA256 signed, up to 5
   attempts on exponential backoff, per-endpoint subscription list (`["*"]`
   for all events).

| Flow | Email event | Webhook event |
|---|---|---|
| Password sign-up | `welcome` | `user.created` |
| OAuth new user | `welcome` | `user.created` |
| Password reset (consume) | `password_changed` | `password.changed` |
| Authenticated change-password | `password_changed` | `password.changed` |
| MFA confirm | `mfa_enabled` | `mfa.enabled` |
| MFA disable | — | `mfa.disabled` |
| Email verify (consume) | — | `email.verified` |
| Forgot-password issue | `password_reset` | — |
| Send verification | `email_verification` | — |
| Workspace invitation | `workspace_invitation` | — |
| `DELETE /sessions/:id` | — | `session.revoked` |

---

## 6. Security model

The mechanics a contributor must preserve when touching auth or billing:

- **`typ` JWT claim is load-bearing.** End-user and operator JWTs share
  `JWT_SECRET`; the `typ` claim is what stops one from being accepted as the
  other. Always set and verify it.
- **Hash-only credentials at rest.** API keys, refresh tokens, password-reset
  / email-verification / invitation tokens, license keys and MFA backup codes
  are stored as SHA-256 hashes. Raw values are shown once at issue and are not
  queryable.
- **Encrypted secrets at rest.** Anything whose cleartext is needed later
  (provider API keys, OAuth client secrets, Resend keys, MFA TOTP secrets) is
  AES-256-GCM-encrypted via `lib/secrets.ts`. A `v1.…` prefix allows algorithm
  rotation.
- **Constant-time credential compare.** `timingSafeEqual` in `lib/keys.ts` and
  `middleware/admin-auth.ts`; SHA-256 lookups on indexed columns are
  constant-time at the DB layer.
- **Cross-tenant guard at every authenticated entry point.** The end-user JWT
  carries `applicationId`, the operator JWT carries `tid`; the resolving
  middleware refuses mismatched claims.
- **API key scope hierarchy** via `requireScope(scope)`: `*` ⊃ everything,
  `auth:write` ⊃ `auth:read`, `billing:write` ⊃ `billing:read`. Leaf scopes
  (e.g. `webhooks:read`) must be granted explicitly.
- **State transitions only from provider events.** The `PENDING` row is
  bookkeeping; only `checkout.session.completed` / `invoice.paid` move it to
  `ACTIVE`.
- **Idempotency via DB unique constraints**, not application-layer caches:
  `WebhookEvent.(provider, providerEventId)` (inbound), `Payment.
  providerPaymentId`, `CouponRedemption.(couponId, paymentId)`,
  `LicenseActivation.(licenseId, machineFingerprint)`.
- **Outbound webhook SSRF guard.** `isWebhookUrlSafe` rejects
  loopback/private/link-local/CGNAT IPs and non-HTTP schemes at endpoint
  creation. Opt out for intra-VPC self-hosting with
  `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`.
- **OAuth auto-link requires `emailVerified: true`** from the provider;
  unverified emails are refused (`OAUTH_EMAIL_NOT_VERIFIED`).
- **Per-route security posture:**

| Surface | Auth | Cross-tenant guard | Rate limit | CORS |
|---|---|---|---|---|
| `/api/v1/auth/*` | Application secret key (+ `eu_access` JWT when authenticated) | `applicationId` claim(s) must match | 100/min/IP | strict allowlist |
| `/api/v1/users/me/*` | Secret key + `eu_access` JWT | same | global | strict allowlist |
| `/api/v1/billing/*` | Secret key + (optional) `eu_access` JWT | same | global | strict allowlist |
| `/api/v1/billing/webhook/*` | Provider HMAC signature | `metadata.applicationId` on event | global | n/a (server-to-server) |
| `/api/v1/tenant/*` | `to_access` JWT | `tid` claim + membership re-check from DB | global | strict allowlist |
| `/api/v1/admin/*` | `SUPER_ADMIN_KEY` constant-time compare | n/a (bootstrap only) | global | strict allowlist |

---

## 7. Repository layout

```
apps/
  api/                       Fastify backend (the core)
    src/
      app.ts                 — Fastify build, plugin registration, CORS, raw-body
      config/env.ts          — env schema (single source of truth for config)
      lib/                   — primitives (no business logic)
        jwt.ts / tenant-jwt.ts            — typ-discriminated JWTs
        refresh-tokens.ts / tenant-refresh-tokens.ts
        password-reset.ts / tenant-password-reset.ts
        email-verification.ts
        passwords.ts         — argon2id hash + verify
        keys.ts              — API key generation + SHA-256
        license-keys.ts
        mfa.ts               — TOTP + backup codes
        webauthn.ts / tenant-webauthn.ts  — SimpleWebAuthn wrappers
        secrets.ts           — AES-256-GCM encrypt/decrypt
        email-transport.ts   — Resend BYO + default pool
        webhook-signing.ts   — HMAC sign / verify + SSRF URL safety
        prisma.ts            — Prisma client singleton
        error.ts             — RekeyError + Fastify error handler
      middleware/
        api-key-auth.ts      — Application secret key + requireScope
        user-session.ts      — eu_access JWT verification + applicationId guard
        tenant-session.ts    — to_access JWT verification + workspace re-check
        admin-auth.ts        — SUPER_ADMIN_KEY constant-time compare
      modules/
        auth/                — end-user auth (sign-up / in / refresh / reset / verify)
        tenant-auth/         — operator auth (parallel)
        oauth/               — OAuth providers + callback + link/unlink
          providers/         — google, github, microsoft, discord, gitlab, slack, oidc
        mfa/ tenant-mfa/     — TOTP enroll / confirm / challenge / disable
        passkeys/ tenant-passkeys/ — WebAuthn register / authenticate
        api-keys/            — API key CRUD + scopes
        end-user-roles/      — per-Application RBAC catalog
        organizations/       — end-user organizations + memberships + invitations
        tenants/ applications/ — bootstrap admin CRUD
        tenant-applications/ — tenant-scoped Application + plan + coupon + api-key CRUD
        tenant-workspaces/   — workspace members + invitations
        billing/             — plans + checkout + provider selection
          providers/         — stripe, paypal, razorpay
          webhooks/          — inbound provider webhook handlers
        plans/ coupons/ licenses/ usage/  — billing-tier surfaces
        email/               — template registry, render, transport, routes
        webhooks/            — outbound webhook endpoint CRUD + delivery + retry
      routes/                — top-level glue (health, me, users-me)
    test/                    — vitest suites
  panel/                     — Next.js operator panel (App Router, server actions, Tailwind)
  portal/                    — hosted multi-app customer billing portal
  admin/                     — super-admin dashboard
packages/
  shared-types/              — Zod schemas + types shared between API and SDKs
  sdk-node/                  — server SDK (Application secret key)
  sdk-react/                 — browser SDK (public key)
  sdk-nextjs/                — Next.js server-action + middleware helpers
  cli/                       — rekey CLI
  mcp/                       — Model Context Protocol surface
prisma/
  schema.prisma              — single Prisma schema for the whole monorepo
  migrations/                — SQL migrations
```

---

## 8. Configuration (env)

Required to boot: `DATABASE_URL`, `JWT_SECRET`, `SUPER_ADMIN_KEY`, and a
reachable Redis. Everything else is optional or has a default.

| Variable | Purpose | Required? |
|---|---|---|
| `DATABASE_URL` | Postgres connection | **required** |
| `JWT_SECRET` | signs end-user + operator + MFA-challenge JWTs (≥32 chars) | **required** |
| `SUPER_ADMIN_KEY` | bootstrap admin path (≥32 chars) | **required** |
| `REDIS_URL` | outbound-webhook delivery queue + rate-limit/lockout state | **required infra** — the API refuses to boot if Redis is unreachable; the URL itself defaults to `localhost` |
| `ENCRYPTION_KEY` | AES-256-GCM for secrets at rest (64 hex chars) | **required in production** (boot fails without it) |
| `CORS_ALLOWED_ORIGINS` | allowlist for browser callers | **required in production** (dev permits localhost) |
| `RESEND_DEFAULT_API_KEY` + `RESEND_DEFAULT_FROM` | shared Resend pool; without it the API returns raw tokens to the caller | optional |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS` | opt out of the outbound-webhook SSRF guard for intra-VPC URLs | optional (self-host) |

See [.env.example](.env.example) for the complete, commented list.

See [DEPLOY.md](DEPLOY.md) for a full self-host runbook and [docs/](docs/) for
per-feature guides (auth, billing, API keys, MCP, portal, …).
