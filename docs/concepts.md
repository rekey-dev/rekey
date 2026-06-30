# Concepts

ReliPay's data model is the smallest possible thing that supports auth + billing for many independent applications. There are five entities you have to know.

```
Tenant ─────► Application ─────► EndUser
                  │
                  ├──► ApiKey
                  │
                  └──► WebhookEvent  (and later: Plan, Subscription, Payment)
```

## Tenant

A **Tenant** is a ReliPay customer — the company or developer who runs (or signs up to) ReliPay. A Tenant typically owns one or more Applications.

- Created via `POST /api/v1/admin/tenants` (bootstrap admin only).
- Is **never** the thing an end-user authenticates against.
- Holds no domain data directly — Applications hold everything.

When in doubt: a Tenant is the *operator*, not the *user*.

## Application

An **Application** is one project under a Tenant — `MyApp-prod`, `MyApp-staging`, `OtherSaas-eu`. This is the unit of multi-tenancy: every domain row in ReliPay carries an `applicationId`.

- Has a unique URL-safe `slug` (immutable after create).
- Has a publishable key (`rp_pub_<slug>_<rand>`) — a real browser credential for the public-bootstrap routes (sign-in/up, magic-link, passkey, license verify, plans). Rotatable with a grace window. See [api-keys.md](api-keys.md#publishable-key).
- Has many ApiKeys (server-side secret keys).
- Owns its own end-user pool — users do not cross Applications.
- Owns its `authConfig` (which auth methods enabled, redirect URLs) and `billingConfig` (which provider, currency).

A handy frame: a single ReliPay instance with three Tenants, each running two Applications, looks like six totally independent SaaS systems sharing one DB.

## EndUser

An **EndUser** is a signup inside one Application. Email is unique *per Application*, not globally — `alice@example.com` can exist in `MyApp-prod` and `OtherSaas-eu` as two distinct users.

- Has `passwordHash` (Argon2id) when password auth is enabled, `null` for OAuth-only users.
- Carries free-form `metadata: Json` per Application.
- Phase 1 adds Memberships / Invitations for org-team support inside an Application.

## ApiKey

The **secret key** a customer's server uses to call ReliPay via `@relipay/node`. Many per Application. Format: `rp_live_<rand>` or `rp_test_<rand>`. Stored as SHA-256 hash; raw value shown to operator exactly once at creation.

Distinct from:
- **Publishable key** (`rp_pub_<slug>_<rand>`) — browser-safe credential for the public-bootstrap routes via `@relipay/react`; no backend required. Identity, not authorization.
- **`SUPER_ADMIN_KEY`** — bootstrap credential, not Application-scoped.

See [api-keys.md](api-keys.md) for the full key model.

## WebhookEvent

Durable record of every inbound provider webhook (Stripe, PayPal, …). The unique constraint on `(provider, providerEventId)` is the source of truth for idempotency — Redis is only a fast-path cache. Operators replay failed events from the panel via the persisted `processing_error`.

This pattern is non-optional. Redis-only dedup loses events on flush; we learned that lesson the hard way in our companion project.

## Idempotent requests

Selected high-value mutating routes accept an **`Idempotency-Key` header** (any stable unique string, max 200 chars — a UUID works well) so timeouts and network errors can be retried blindly without double effects:

- Public API (secret-key auth): `POST /api/v1/billing/checkout`, `POST /api/v1/billing/subscription/cancel`, `POST /api/v1/credits/consume`.
- Operator API (panel session): create end-user / plan / coupon, mint API key, issue license, grant credits (under `/api/v1/tenant/applications/:id/…`).

Semantics:

- **Scope** — the key belongs to the authenticated principal: the Application for secret-key calls, the workspace (tenant) for operator calls. Different Applications can use the same key string without collision.
- **First request executes**; its `{status, body}` is stored for **24 h** (2xx and 4xx only — a 5xx is never cached, so retrying after a server error re-executes).
- **Retry with the same key + identical request** (method, path, body) → the stored response is returned verbatim with an `Idempotency-Replayed: true` header. Nothing re-executes.
- **Same key, different request** → `409 IDEMPOTENCY_KEY_REUSED`. One key = one logical operation.
- **Concurrent duplicate while the first is still running** → `409 IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After: 1`; retry with the same key to receive the stored response.
- After the 24 h TTL the key is forgotten and a reuse executes as a fresh request.

Routes with their own deduplication are deliberately **not** opted in: provider webhooks (`WebhookEvent` dedup above), `auth/sign-up` (duplicate emails 409 naturally). The credits routes additionally accept a body-level `idempotencyKey` that dedupes at the *ledger* level — that keeps working unchanged; the header is the generic transport-level mechanism on top.

## What ReliPay deliberately doesn't model (in v1)

- **Cross-Application users.** Your end-user is in one Application. If your product family wants single-sign-on across Applications, that's a panel/account feature for Phase 2+, not a data-model feature.
- **Tax computation.** Defer to provider (Stripe Tax) or external (TaxJar).
- **PCI card vault.** Providers do this. We never see card numbers.
- **Fraud scoring.** Provider-handled in v1.
