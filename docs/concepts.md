# Concepts

Rekey's data model is the smallest possible thing that supports auth + billing for many independent applications. There are five entities you have to know.

```
Tenant ─────► Application ─────► EndUser
                  │
                  ├──► ApiKey
                  │
                  └──► WebhookEvent  (and later: Plan, Subscription, Payment)
```

## Tenant

A **Tenant** is a Rekey customer — the company or developer who runs (or signs up to) Rekey. A Tenant typically owns one or more Applications.

- Created via `POST /api/v1/admin/tenants` (bootstrap admin only).
- Is **never** the thing an end-user authenticates against.
- Holds no domain data directly — Applications hold everything.
- May carry optional resource ceilings in `limits` — see [Workspace limits](#workspace-limits). Unset by default, which means unlimited.

When in doubt: a Tenant is the *operator*, not the *user*.

## Application

An **Application** is one project under a Tenant — `MyApp-prod`, `MyApp-staging`, `OtherSaas-eu`. This is the unit of multi-tenancy: every domain row in Rekey carries an `applicationId`.

- Has a unique URL-safe `slug` (immutable after create).
- Has an `environment` — `PRODUCTION`, `STAGING` or `DEVELOPMENT`, defaulting to `DEVELOPMENT`. It decides which prefix its API keys carry, and is the unit deployments are billed and quota'd by. It does **not** restrict which billing credentials the Application may hold — live provider keys on a `DEVELOPMENT` app are allowed. **Set at creation and immutable**: going live means creating a `PRODUCTION` Application, not converting this one. See [api-keys.md → Environments](api-keys.md#environments).
- Has a publishable key (`rp_pub_<slug>_<rand>`) — a real browser credential for the public-bootstrap routes (sign-in/up, magic-link, passkey, license verify, plans). Rotatable with a grace window. See [api-keys.md](api-keys.md#publishable-key).
- Has many ApiKeys (server-side secret keys).
- Owns its own end-user pool — users do not cross Applications.
- Owns its `authConfig` (which auth methods enabled, redirect URLs) and `billingConfig` (which provider, currency).

A handy frame: a single Rekey instance with three Tenants, each running two Applications, looks like six totally independent SaaS systems sharing one DB.

Because the Application is where isolation actually lives, "production vs staging" is two Applications, not one Application in two modes. Rekey tried the second shape (a per-key test/live `mode` stamped on rows) and removed it — it only ever covered three models, so the separation it promised was not real.

## EndUser

An **EndUser** is a signup inside one Application. Email is unique *per Application*, not globally — `alice@example.com` can exist in `MyApp-prod` and `OtherSaas-eu` as two distinct users.

- Has `passwordHash` (Argon2id) when password auth is enabled, `null` for OAuth-only users.
- Carries free-form `metadata: Json` per Application.
- Phase 1 adds Memberships / Invitations for org-team support inside an Application.

## ApiKey

The **secret key** a customer's server uses to call Rekey via `@rekey.dev/node`. Many per Application. Format: `rp_live_<rand>` or `rp_test_<rand>` — which one you get follows the Application's `environment` and is not chosen at mint time. Stored as SHA-256 hash; raw value shown to operator exactly once at creation.

Distinct from:
- **Publishable key** (`rp_pub_<slug>_<rand>`) — browser-safe credential for the public-bootstrap routes via `@rekey.dev/react`; no backend required. Identity, not authorization.
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

- **Scope** — the key belongs to the authenticated principal, **including the subject acting**: `app:<applicationId>:user:<endUserId>` when an end-user token is present (falling back to `app:<applicationId>`), and `tenant:<tenantId>:member:<membershipId>` when a membership is (falling back to `tenant:<tenantId>`). Different Applications, and different users within one Application, can use the same key string without collision. The actor is part of the scope on purpose: without it, one end-user replaying another's key on `POST /billing/subscription/cancel` — whose body is `{}` for everyone, so the fingerprint protects nothing — would receive that user's stored response.
- **First request executes**; its `{status, body}` is stored for **24 h** (2xx and 4xx only — a 5xx is never cached, so retrying after a server error re-executes).
- **Retry with the same key + identical request** (method, path, body) → the stored response is returned verbatim with an `Idempotency-Replayed: true` header. Nothing re-executes.
- **Same key, different request** → `409 IDEMPOTENCY_KEY_REUSED`. One key = one logical operation.
- **Concurrent duplicate while the first is still running** → `409 IDEMPOTENCY_KEY_IN_FLIGHT` with `Retry-After: 1`; retry with the same key to receive the stored response.
- After the 24 h TTL the key is forgotten and a reuse executes as a fresh request.

Routes with their own deduplication are deliberately **not** opted in: provider webhooks (`WebhookEvent` dedup above), `auth/sign-up` (duplicate emails 409 naturally). The credits routes additionally accept a body-level `idempotencyKey` that dedupes at the *ledger* level — that keeps working unchanged; the header is the generic transport-level mechanism on top.

## Workspace limits

One Rekey deployment often hosts several independent teams — a platform team running Rekey for the whole company, a lab running it for a handful of internal products. **Workspace limits** stop one workspace from consuming the deployment: a super-admin can put a ceiling on a Tenant, and Rekey enforces it.

Ceilings live in `Tenant.limits` (a jsonb column). Today there are two keys:

| Key | Meaning |
|---|---|
| `maxActiveEndUsers` | Maximum non-erased EndUsers across **all** Applications in the workspace. |
| `maxProductionApps` | Maximum Applications the workspace may **run** in production: `environment` is `PRODUCTION` **and** the Application is not disabled. STAGING and DEVELOPMENT Applications are never counted, so a workspace at its ceiling can still create as many non-production Applications as it likes. Nor are *disabled* production Applications — see [Application lifecycle](#application-lifecycle). |

A deployment can stamp defaults onto every workspace it creates with the
`DEFAULT_TENANT_LIMITS` env var (JSON matching the same shape). Unset — the
default — means new workspaces get `null` limits, i.e. unlimited.

Managed through two super-admin routes:

```bash
# Read the ceilings and what's currently counted against them
curl -H "Authorization: Bearer $SUPER_ADMIN_KEY" \
  https://your-rekey/api/v1/admin/tenants/$TENANT_ID/limits
# → { "limits": { "maxActiveEndUsers": 500, "maxProductionApps": 3 },
#     "usage":  { "activeEndUsers": 312, "productionApps": 2 } }

# Set them (PUT semantics — an omitted key becomes unlimited; `{}` clears all)
curl -X PUT -H "Authorization: Bearer $SUPER_ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"maxActiveEndUsers":500,"maxProductionApps":3}' \
  https://your-rekey/api/v1/admin/tenants/$TENANT_ID/limits
```

The rules that matter:

- **Unset means unlimited.** `limits` is null on every workspace until someone sets it, so a deployment that ignores this feature behaves exactly as it did before the column existed. An absent or `null` key inside the object means the same for that one limit.
- **Only a super-admin can set them.** The routes sit behind `SUPER_ADMIN_KEY`, not a workspace session — a quota an operator can raise themselves isn't a quota. There is no operator-facing write path.
- **Taking capacity is gated; authentication never is.** Hitting `maxActiveEndUsers` makes *new* end-users fail with `403 TENANT_QUOTA_EXCEEDED` — via SDK sign-up, magic-link first login, OAuth first login, and operator-driven manual create alike. `maxProductionApps` raises the same code from all three doors that take a production slot: **creating** a `PRODUCTION` Application, **promoting** one into production, and **re-enabling** a disabled one. End-users and Applications that already exist are untouched: end-users keep signing in, refreshing, and resetting passwords normally, and a running production Application is never taken offline by a quota. Lowering a limit below current usage is allowed and strands nobody.
- **Counting is workspace-wide.** Users are summed across every Application the Tenant owns, not counted per-Application. [Erased](data-erasure.md) (tombstoned) users don't count — the row survives for foreign-key integrity, but the person is gone.
- **Enforcement is check-then-act for end-users, and locked for production slots.** The end-user count is exact at the moment it's read, but nothing serialises concurrent sign-ups, so a burst racing at the boundary can overshoot by a few — deliberate, because a hard ceiling would mean locking one row per workspace on the hottest write path in the product. Production slots are different and take a per-workspace advisory lock: there is no way to demote or delete an Application, so an overshoot there would leave the workspace permanently over its ceiling. Promotion happens a handful of times per workspace ever, so the lock costs nothing. See `apps/api/src/lib/tenant-limits.ts`.

Rekey attaches no pricing meaning to these numbers — they're a resource-control mechanism, and the object shape (rather than a bare column) is so future limits can be added as new optional keys without a breaking change.

## Selling a deal the plan does not describe

A plan is a product; a subscription is one customer's copy of it. When one
customer needs different terms — more seats, a raised allowance, a feature the
tier does not include — the answer is **not** a private plan for one buyer.

`PATCH /api/v1/tenant/applications/:id/subscriptions/:subId/entitlement-overrides`
writes `Subscription.entitlementOverrides`, a sparse map of `KIND:key` to value
that is merged over the plan's entitlements on every resolve. What the customer is
*entitled to* changes immediately and everywhere entitlements are read: feature
gates, `GET /billing/entitlements`, usage allowances.

Already-materialised grants are a separate matter and are **not** retroactive.
CREDIT is granted once per period against an idempotency anchor, so raising a
credit allowance mid-period applies at the next renewal rather than topping up
immediately. A LICENSE that has already been issued keeps the `seatsAllowed` it
was issued with. FEATURE and USAGE are read live and do take effect at once.

```bash
curl -X PATCH -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"FEATURE:max_production_apps": 5, "FEATURE:beta_access": null}' \
  https://your-rekey/api/v1/tenant/applications/$APP/subscriptions/$SUB/entitlement-overrides
```

The rules worth knowing before you use it:

- **Sparse.** Keys you do not mention are untouched, so raising one allowance
  never means restating the rest of the deal.
- **`null` removes** an override and reverts that entitlement to the plan.
- **Only `FEATURE:` may introduce an entitlement the plan lacks.** A CREDIT,
  LICENSE or USAGE override replaces a *quantity* on a row that must already
  exist — add it to the plan first. The API refuses the alternative rather than
  storing something the resolver would ignore, which is the general rule here:
  anything that would be silently discarded at read time is rejected at write
  time instead.
- **It emits `subscription.entitlements_updated`** when the resolved
  entitlements actually change (a write restating the current deal announces
  nothing). Subscribe to that event if you project entitlements onto state of
  your own — a subscriber listening only for status transitions will never hear
  about a deal being adjusted, and will go on enforcing terms the customer no
  longer has.

## Application lifecycle

An Application has two lifecycle facts beyond its config: which environment it
is, and whether it is switched on.

**Promotion.** `environment` is `DEVELOPMENT` by default and can be raised to
`PRODUCTION` exactly once, via
`POST /api/v1/tenant/applications/:id/promote` (Panel → Application →
Lifecycle). **Workspace OWNER only** — an ADMIN cannot, and no application grant
unlocks it, because a production slot is a workspace-level commitment made
through a single application. It is one-way: there is no demote, and no other route writes the
field. Promotion asserts `maxProductionApps`, takes a slot, and leaves existing
API keys completely alone — keys minted before the promotion keep their
`rp_test_` prefix and keep working, because the prefix is a label for the human
pasting it and not a capability. Revoking them would break a customer's
integration at the exact moment they went live.

**Disabling.** Rekey has no Application delete. `POST .../:id/disable` is the
reversible substitute, and is **workspace OWNER only** for the same reason —
taking a live product offline is a workspace decision, and re-enabling a
production application re-takes a slot: a disabled Application refuses every end-user request
with `403 APPLICATION_DISABLED` on both the secret-key and publishable-key
surfaces, serves no hosted portal, and dispatches no outbound webhook,
transactional email or dunning escalation (its dunning clock pauses rather than
advancing). Nothing is deleted, and crucially **no session is revoked** — the
`tokenGeneration` kill-switch is untouched, so an end-user token issued before
the freeze is still valid after `DELETE .../:id/disable` lifts it. Every
operator surface stays fully readable throughout, or the freeze could not be
undone.

**The two interact through the quota**, and this is the part worth reading
twice:

| Action | Production slot |
|---|---|
| Create or promote to `PRODUCTION` | takes one, asserts the quota |
| Disable | **frees** one, never refused |
| Re-enable a `PRODUCTION` Application | takes one, **asserts the quota, can be refused** |
| Disable/enable a `DEVELOPMENT` or `STAGING` Application | no effect |

So the ceiling is on production Applications that are *running*, not on rows
whose `environment` is `PRODUCTION`. A workspace may legitimately own more
`PRODUCTION` Applications than its ceiling as long as all but
`maxProductionApps` of them are disabled — only one set can serve traffic at a
time, and swapping which one means a disable plus an enable, each re-checking
the ceiling. Anything counting production Applications for billing must use
`countProductionApps`, which owns the `disabledAt: null` predicate; filtering on
`environment` alone would bill for frozen Applications.

A workspace OWNER or ADMIN can *read* the position without super-admin access —
it is shown on Panel → Workspace settings:

```bash
curl -H "Authorization: Bearer $OPERATOR_TOKEN" \
  https://your-rekey/api/v1/tenant/workspace/limits
# → { "limits": { "maxProductionApps": 3 },
#     "usage":  { "productionApps": 2, "activeEndUsers": 312 } }
```

MEMBERs are excluded: both figures are workspace-wide, and the application list
is grant-scoped precisely so a MEMBER with three applications is not told the
workspace has forty. Nothing is lost by it — every action these ceilings gate
already requires OWNER or ADMIN.

That read is a UX hint so a client can grey out an action before it fails; it is
never the enforcement, which happens on the acting endpoint regardless.

## What Rekey deliberately doesn't model (in v1)

- **Cross-Application users.** Your end-user is in one Application. If your product family wants single-sign-on across Applications, that's a panel/account feature for Phase 2+, not a data-model feature.
- **Tax computation.** Defer to provider (Stripe Tax) or external (TaxJar).
- **PCI card vault.** Providers do this. We never see card numbers.
- **Fraud scoring.** Provider-handled in v1.
