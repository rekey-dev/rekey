# Design: organization-level billing

Status: design proposal. No code changed by this doc.
Scope: let billing (subscriptions, payments, credits, licenses, usage) benefit an **Organization** — not only an individual EndUser — for applications that opt in.

> **Revision 2** — adopts the "owner + beneficiary" model (a subscription keeps a
> stable owner end-user for payment/management and *optionally* names a
> beneficiary org). This supersedes Revision 1's "polymorphic XOR subject"
> sketch: keeping the owner non-null makes the migration trivial and makes
> "orgs disabled ⇒ owner has full access" the default with no special-casing.

---

## 1. Recommendation (TL;DR)

1. **Do it** — org/seat/workspace billing is the standard B2B model (Clerk, WorkOS, Stripe-for-SaaS bill the org). Per-user-only is a real gap once orgs are used for paid teams.
2. **Owner + beneficiary, not XOR.** A `Subscription` always has an **owner** end-user (the payer + manager) and *optionally* a **beneficiary org**. When no org is named, the owner is the sole beneficiary — exactly today's behavior. This is the model the question proposed and it's the right one.
3. **Don't auto-couple to `organizationsEnabled`.** Billing-subject and collaboration are orthogonal (an app may want teams yet still bill individuals). Gate org-billing behind an explicit per-app `billingConfig.billingSubject: 'user' | 'org'` (default `'user'`).
4. **Phase it** (§9): feature-access subscriptions first (cheapest — no new balance tables), then pooled credits/usage/seats.

---

## 2. Current state (what's built today)

Billing is **100% per individual EndUser** and entirely org-unaware.

- **Plans** — `Plan(applicationId, slug, kind)`; kinds `SUBSCRIPTION | LICENSE | USAGE | CREDIT`. Per-app.
- **Checkout** — `POST /api/v1/billing/checkout` ([billing.routes.ts](apps/api/src/modules/billing/billing.routes.ts)) runs `[requireApiKey, requireBillingEnabled, requireScope('billing:write'), requireUserSession]`; subject = `req.endUser`. `billing.service.createCheckoutSession` upserts a PENDING `Subscription(applicationId, endUserId, planId)` (`@@unique`).
- **Subscription management** — `getCurrentSubscription(endUser)` + cancel/upsert all key on `endUserId`.
- **Webhook** — per-app `…/billing/webhook/<provider>/<slug>` → ACTIVE; writes `Payment`, auto-issues `License(applicationId, endUserId, planId)`, grants `CreditBalance`/`CreditLedger(applicationId, endUserId)`.
- **Entitlement reads** — `credits.consume` decrements `CreditBalance(applicationId, endUserId)` atomically; `licenses.verify` records activations against `seatsAllowed` (machine fingerprints, **not** members); usage aggregates per `endUserId`.
- **Org-unaware** — `Organization`/memberships reference nothing in billing. `organizationsEnabled` has zero billing effect. The `oid` active-org claim + `/me/organizations/:id/switch` described in [organizations.service.ts](apps/api/src/modules/organizations/organizations.service.ts) comments are **not implemented** (no `oid` mint, no switch route). Nothing on a request says "act as org X."

---

## 3. The model: owner + beneficiary

```
Subscription
  ├─ ownerEndUserId          (always set) — pays, manages (cancel/update/change plan)
  └─ beneficiaryOrgId?       (optional)   — who gets the benefit
```

- **Owner** = the end-user who bought it. Always present → stable handle for payment + management, identical to today's `endUserId`.
- **Beneficiary** = `beneficiaryOrgId ?? ownerEndUserId`. The party that *holds the entitlement*:
  - no org named → beneficiary = owner (today's behavior, free).
  - org named → beneficiary = the org; every member benefits.

**Who can manage:** the **owner** end-user **only** (cancel / update / change-plan / payment). Org OWNER/ADMINs do **not** get management rights — they only receive the benefits. **Ownership transfer is not self-serve**: it's done via the **Panel by ReliPay support** (an operator re-points `ownerEndUserId`). This keeps a single, auditable management identity and removes an org-admin takeover vector.

This keeps "link to both org and owner" exactly as asked: one subscription, owner manages, org enjoys the benefit; and with orgs disabled the owner is the beneficiary by default.

> **Benefit bundling** — how one subscription grants *many* entitlements (N licenses + M credits + metered overage + feature flags), replicating Stripe's Product/Price/Item/Entitlement separation, is designed in [BILLING_MODEL.md](BILLING_MODEL.md). This doc covers *who the subject is*; that one covers *what a subscription grants*.

### Two layers behave differently

| Plan kind | benefit = | data |
|---|---|---|
| `SUBSCRIPTION` (feature/access gate) | **boolean access** shared to the beneficiary | no balance — resolved by query |
| `LICENSE` | a license held by the beneficiary; `SEATS` cap counts **members** when org-linked | `License.beneficiaryOrgId?` |
| `CREDIT` | a **pooled** balance the beneficiary draws down | `CreditBalance` keyed to the beneficiary |
| `USAGE` | metered events aggregated for the beneficiary | `UsageRecord.beneficiaryOrgId?` |

Feature-access subscriptions (the common case) need **no new balance tables** — just a resolution query. Pooled resources (credits/usage/seats) must key their *state row* to the beneficiary subject (org when linked, else owner) so the pool is shared, not duplicated per owner.

---

## 4. Design

### 4.1 Per-app switch
`BillingConfigSchema` (shared-types): `billingSubject: z.enum(['user','org']).default('user')`. `'org'` requires `organizationsEnabled = true` (validate on save). Panel: a radio on the Billing tab, shown when orgs are enabled. `'user'` = today, unchanged.

### 4.2 Active-org / beneficiary signal
- **Phase 1 (explicit):** `POST /billing/checkout` accepts optional `organizationId`; the API asserts the caller is **OWNER/ADMIN** of that org in this app, and records it as the beneficiary. No JWT change.
- **Phase 3 (ergonomic):** implement the documented `oid` claim + `POST /api/v1/users/me/organizations/:id/switch`; the SDK sets an active org once and pooled consume/verify calls infer the beneficiary. Middleware re-confirms membership per request.

### 4.3 Schema (additive — no XOR, no nullable owner)
- `Subscription`: add `beneficiaryOrgId String?` (FK → organizations, `onDelete: SetNull` or a guarded cascade — see §5). `endUserId` stays **required** (the owner). Drop the assumption that `(applicationId, endUserId, planId)` is the only key if an owner can hold both a personal and an org sub of the same plan — relax to include beneficiary in the uniqueness, or move org subs to their own uniqueness.
- `License`, `UsageRecord`: add `beneficiaryOrgId String?` (owner `endUserId` stays).
- `CreditBalance`/`CreditLedger`: the **pool** must belong to the beneficiary. Add `organizationId String?`; replace the `(applicationId, endUserId)` unique with the beneficiary key — simplest is two partial unique indexes (`… WHERE organization_id IS NULL` keyed on end_user_id; `… WHERE organization_id IS NOT NULL` keyed on organization_id), or a `subject_key` generated column.
- No backfill: existing rows have `beneficiaryOrgId / organizationId = NULL` → owner-scoped, unchanged.

### 4.4 Entitlement resolution
Helper `resolveBeneficiary(req)` → `{ kind:'org', orgId } | { kind:'user', endUserId }` from the explicit `organizationId` (phase 1) or the `oid` claim (phase 3), after membership check.

- **Has active subscription?** → `true` if the user **owns** an active sub for the plan **OR** is a member of an org that is the **beneficiary** of an active sub. (boolean OR — double coverage is harmless.)
- **Credits / usage (pooled):** operate on the **resolved beneficiary's** row. **No personal fallback** in org context by default — a user's personal credits must not silently cover org usage. (Opt-in `allowPersonalFallback` later if asked.)
- **`billingSubject = 'user'`** → resolution ignores orgs entirely; identical to today.

### 4.5 Seats
- `SUBSCRIPTION` org plan → seat count = `OrganizationMembership` count (optionally capped via plan metadata; block invites past the cap, or post-pay overage — open question §10).
- `LICENSE` `SEATS` org-linked → members consume seats instead of machine fingerprints; needs a seat-assignment table or derive from membership.

### 4.6 RBAC
**Checkout** for an org beneficiary requires the caller be **OWNER/ADMIN of that org** (you must be allowed to spend on the team you're buying for). Once created, **subscription management is the owner end-user only** — not delegated to org admins. Ownership transfer is a Panel/support action (re-points `ownerEndUserId`).

### 4.7 Provider / webhooks
- Checkout `metadata` carries `ownerEndUserId` + `beneficiaryOrgId`. Webhook routes the resulting entitlement to the beneficiary.
- **Provider customer**: created against the **owner** (their payment method pays), which matches "owner manages + pays." Optionally store the org as the customer's company/metadata for invoicing. (Alternative — customer-per-org — is heavier; owner-as-payer is the simpler default and fits the model.)

---

## 5. Edge cases / decisions to nail down

- **Owner leaves the beneficiary org** → the sub keeps benefiting the org; **management stays with the owner** (they can manage even from outside the org). Moving it requires support to re-point `ownerEndUserId` via the Panel — no automatic org-admin takeover.
- **Org deleted** with a live subscription → `onDelete: SetNull` would orphan the sub (beneficiary gone, owner still set → silently reverts to owner-only benefit). Prefer **blocking org delete while a live org sub exists**, or auto-cancel at the provider first.
- **User in multiple orgs** → the explicit `organizationId` / active-org disambiguates; without it for a pooled op, reject with a clear error rather than guess.
- **Switching `billingSubject` on a live app** → existing owner-scoped rows keep resolving; decide if new purchases are org-only or both during transition.
- **Owner holds personal *and* org sub for the same plan** → uniqueness must allow it (include beneficiary in the key); access is OR, pooled consume routes by active context.

---

## 6. Panel
- Billing tab: `billingSubject` radio (shown when orgs enabled; blocks `org` when disabled).
- Org detail page: a "Billing" section — active subscription + owner, seats used/allowed, pooled credit balance, licenses — when the app bills orgs.

## 7. SDK
- `relipay.billing.checkout({ planSlug, organizationId? })`; pooled `credits.consume` / `usage.record` / `licenses.verify` gain optional `organizationId`.
- Phase 3: `relipay.organizations.switch(id)` sets the active org so the param can be omitted.

## 8. Migration / back-compat
- Additive nullable `beneficiaryOrgId` / `organizationId` columns + adjusted CreditBalance uniqueness. `endUserId` stays required everywhere. Existing rows → NULL beneficiary → owner-scoped, unchanged. No backfill.
- `billingSubject` defaults `'user'` → no app changes behavior until flipped.

## 9. Phasing
1. **Phase 1** (~2–3d): `billingConfig.billingSubject` + panel radio; `organizationId` on `/billing/checkout` (OWNER/ADMIN assert); `Subscription.beneficiaryOrgId`; **feature-access resolution** ("owns sub OR member of beneficiary org"); provider customer = owner; webhook routing. No pooled credits/licenses/usage yet.
2. **Phase 2** (~3–4d): beneficiary on `License`/`CreditBalance`/`CreditLedger`/`UsageRecord`; pooled resolution + the no-personal-fallback rule; seat model; org-billing panel section.
3. **Phase 3** (~2d): `oid` claim + `/me/organizations/:id/switch`; SDK active-org.

## 10. Open questions for product
- Default fallback: should personal entitlements ever cover org usage? (Proposed: no.)
- Seats: hard cap at purchase, or post-pay overage?
- Provider customer: per-owner (proposed) vs per-org.
- Org-delete with a live subscription: block, or auto-cancel at provider?
- Allow an owner to hold both a personal and an org subscription of the same plan? (Proposed: yes; uniqueness includes beneficiary.)
