# Design: bundled-benefit billing model (Stripe-replica)

Status: design proposal. No code changed by this doc.
Scope: let one subscription grant a **bundle** of benefits — e.g. "Team = 5 seats + 500 credits/mo + API-call overage" — by replicating Stripe's Product/Price/Subscription-Item/Entitlement separation. Composes with the owner+beneficiary subject model in [ORG_BILLING.md](ORG_BILLING.md).

---

## 0. Scope decision (launch-fast, provider-agnostic)

**We already do entitlement accounting in-house.** Credits (`CreditBalance`/`CreditLedger`), usage (`UsageMeter`/`UsageRecord`), licenses + seats (`License`) are ReliPay's own tables; the provider (`BillingProvider` interface — `providers/types.ts`) only moves money: `createCheckoutSession` / `createOneTimeCheckout` / `cancelSubscription` (+ optional webhook register/capture). The provider interface deliberately holds only the **intersection** of Stripe/PayPal/Razorpay and pushes provider specifics into `metadata`.

**So the agnostic stance is: keep the source of truth in-house; the provider is a payment rail.** Do **not** adopt Stripe Entitlements / Meters / credit-grants — using them would couple us to Stripe and break the provider-agnostic goal. "Replicate Stripe" means copy its **object model** (Product/Price/Item/Feature separation), not call its entitlement APIs.

**Plugin:** the typed `BillingProvider` interface + the `getProviderForApplication` factory + `pickProvider` geo-router **are** the plugin system, and they already carry 3 providers. Adding a 4th = implement the interface + one `switch` case. Don't build a dynamic/registry plugin framework — that's over-engineering for a handful of processors.

**Launch cut (recommended):**
- **MVP (ship):** owner+beneficiary subject (ORG_BILLING) + `PlanEntitlement` bundle (many in-house benefits per plan) + a generalized **in-house provisioner** that replaces the ad-hoc grants in `stripe.handler.ts` — all on the **existing single-price checkout and the existing 3 providers**. Usage benefits ship with **included quota + hard cap** (block past quota) so no overage-billing is needed to launch.
- **Defer (only if demanded):** `PlanPrice` / `SubscriptionItem` / tiered pricing (multi-price), **overage *billing*** (compute is in-house; charging it back needs a provider invoice-item/usage push — a later interface method), and the entitlement-read webhook (query first).
- **Shipped beyond the MVP cut:** USAGE org pooling + included-quota hard cap (compute-on-read, §7); LICENSE org seats (one license pooled to the org beneficiary); the **`oid` active-org claim + `POST /users/me/organizations/:id/switch`** (persisted per-session on the RefreshToken, re-confirmed on refresh) so reads default to the active org without an explicit `organizationId`.

This ships the actual value (bundled in-house benefits + org billing) without the heaviest, most provider-entangled piece (a pricing/metering engine).

## 1. Problem

Today a `Plan` is **one** thing — `Plan.kind ∈ {SUBSCRIPTION, LICENSE, USAGE, CREDIT}` — and a subscription delivers exactly that one kind. Real plans bundle many benefits at once, in many combinations (N licenses **and** M credits **and** metered overage **and** feature flags). We need to model the bundle, provision it on payment, and revoke/adjust it on change — copying Stripe's **object model**, while keeping accounting in-house (§0).

## 2. How Stripe does it (researched)

| Object | Role |
|---|---|
| **Product** | the sellable thing ("Team plan"). |
| **Price** | a way to charge for a product: `recurring.interval`, `billing_scheme` (`flat`/`tiered`), `usage_type` (`licensed` = fixed qty/seats, `metered` = consumption), `tiers[]` (`up_to` + `unit_amount`). |
| **Subscription** | the contract for a customer. |
| **Subscription Item** | a `Price` × `quantity` on a subscription. **Many items per subscription** → bundle multiple pricing models, billed on one invoice. |
| **Feature** + `product_feature` | a capability (`lookup_key`) attached to a product. |
| **Active Entitlement** | when a customer has an active subscription to a product, Stripe auto-grants entitlements to that product's features; the app queries `active_entitlements` (or listens to `entitlements.active_entitlement_summary.updated`) and gates on `lookup_key`. |
| **Meter** + usage records | aggregate metered usage for `metered` prices. |
| **Credit grant / customer balance** | prepaid credits drawn down against invoices. |

Key separations to copy:
1. **What you sell (Product) ≠ how you charge (Price) ≠ what access it grants (Feature/Entitlement).**
2. **One subscription carries many items** (seats price + metered price + …).
3. **Included + overage = a tiered metered price** (first N units `up_to` at amount 0, remainder per-unit).
4. **Entitlements are derived + auto-synced** from subscription state, read by `lookup_key`, not hardcoded.

## 3. ReliPay mapping

| Stripe | ReliPay today | ReliPay proposed |
|---|---|---|
| Customer | `EndUser` (implicit) | provider customer per **owner** end-user (see ORG_BILLING) |
| Product | `Plan` | `Plan` keeps being the sellable; drop the single `kind` as the source of truth |
| Price | — (Plan has a single amount/interval) | **`PlanPrice`** (new): interval, amount, `scheme` flat/tiered, `usageType` licensed/metered, `tiers[]` |
| product_feature / Feature | — | **`PlanEntitlement`** (new): typed benefit grants attached to a Plan |
| Subscription | `Subscription` (`applicationId,endUserId,planId`) | `Subscription` (+ `beneficiaryOrgId?`, owner stays `endUserId`) |
| Subscription Item | — | **`SubscriptionItem`** (new): `PlanPrice` × qty on a subscription |
| Active Entitlement | — | **resolved at read time** + materialized rows (below) |
| Meter / usage | `UsageMeter` + `UsageRecord` | reuse; add included-quota + overage to the metered `PlanPrice` |
| Credit grant / balance | `CreditBalance` + `CreditLedger` | reuse; granted by a CREDIT `PlanEntitlement` per period |
| License | `License` (seats) | reuse; issued by a LICENSE `PlanEntitlement` |

### New: `PlanEntitlement` (the bundle)
A `Plan` has many `PlanEntitlement` rows — each a typed benefit the plan grants:

### Model options — pros / cons / configurability (researched: Stripe, Lago, Kill Bill)

| Option | Shape | Configurability | Pros | Cons |
|---|---|---|---|---|
| **1. Rigid typed enum** | `PlanEntitlement{type ∈ {FEATURE,LICENSE,CREDIT,USAGE}, quantity}` | low — fixed dimensions; new flag/limit needs schema/code | type-safe, dead-simple provisioner | every new limit/flag = a deploy; no arbitrary caps; no per-customer custom |
| **2. Pure Lago feature+privilege** | `Feature{code}` + `Privilege{type: bool/int/string/select}`; plan & sub set values; JSON read | very high — any flag/limit, no deploy; per-sub overrides | maximal flexibility, matches OSS-agnostic norm | generic values are stringly/JSON-typed; **stateful** subsystems (credit pool, license issue, usage allowance) don't fit a "privilege value" — they need real provisioning code |
| **3. Hybrid (chosen)** | explicit `kind` for the 3 **stateful** subsystems (CREDIT/LICENSE/USAGE) + a generic **FEATURE** kind carrying a Lago-style typed value; per-subscription overrides | high — unlimited flags/limits without deploy *and* the stateful grants map to real subsystems | simple provisioner (4 fixed cases), in-house subsystems reused, arbitrary feature flags/limits + enterprise overrides without code | one model spans two intents (state-grant vs read-flag) — mitigated by the `kind` discriminator |

**Decision: Option 3.** The 3 stateful kinds map 1:1 to ReliPay's existing in-house subsystems (you can't "configure a new stateful subsystem without code" anyway — the provisioner needs a case per subsystem). The `FEATURE` kind takes Lago's insight — a **typed value** (`BOOL | INT | STRING`) — so operators add any access flag or numeric limit (`advanced_reporting=true`, `max_projects=50`) with **no deploy**, read purely at request time. Plus **per-subscription overrides** (Lago's killer B2B feature) for negotiated/enterprise contracts without forking the plan.

```
PlanEntitlement
  planId
  kind:        FEATURE | CREDIT | LICENSE | USAGE
  key                 // FEATURE: flag/limit code ("advanced_reporting","max_projects"); USAGE: meter slug
  valueType?          // FEATURE only: BOOL | INT | STRING   (Lago privilege types)
  value?              // FEATURE: the flag/limit value, stringified per valueType
  quantity?           // CREDIT: amount granted/period; LICENSE: seats; USAGE: included units (hard cap, MVP)
  licenseKind?        // LICENSE: PERPETUAL | TIMED | SEATS
  rollover?           // CREDIT: carry unused balance to next period
  metadata
  @@unique([planId, kind, key])

Subscription.entitlementOverrides Json?   // sparse {"kind:key": value|quantity} merged over the plan's entitlements
```

"Subscription gives 5 licenses, 500 credits, API cap, + advanced reporting" = one Plan with four `PlanEntitlement`s: `{LICENSE, quantity:5, licenseKind:SEATS}`, `{CREDIT, quantity:500, rollover:false}`, `{USAGE, key:"api_calls", quantity:10000}`, `{FEATURE, key:"advanced_reporting", valueType:BOOL, value:"true"}`. An enterprise deal that needs 50 seats sets `Subscription.entitlementOverrides = {"LICENSE:": 50}` without touching the plan.

## 4. Entity graph

```
Plan (Product)
 ├─ PlanPrice[]         (how to charge: base recurring + any metered overage prices)
 └─ PlanEntitlement[]   (what it grants: features / licenses / credits / usage allowances)

Subscription (owner endUserId + optional beneficiaryOrgId)   ← the "billing id" / contract
 └─ SubscriptionItem[]  (PlanPrice × quantity; e.g. 5 × seat-price, 1 × metered-overage-price)

On ACTIVE / renewal a provisioner materializes PlanEntitlement → beneficiary:
   LICENSE  → License(beneficiary, seats)
   CREDIT   → CreditLedger grant → CreditBalance(beneficiary)
   USAGE    → UsageAllowance(beneficiary, meter, includedUnits, periodStart)   [new]
   FEATURE  → (no row; resolved by query)
 ↳ each materialization recorded in SubscriptionBenefit (grant ledger) for idempotency + revoke
```

The **beneficiary** = `beneficiaryOrgId ?? ownerEndUserId` (ORG_BILLING §3). Pooled rows (CreditBalance, UsageAllowance, seat pool) key to the beneficiary so a team shares them.

## 5. Worked example — "Team" plan

```
Plan "team"
  PlanPrice base      : $99/mo, flat, licensed
  PlanPrice seats     : $15/seat/mo, licensed            (optional add-on)
  PlanPrice api_over  : metered, tiered [up_to 10000 → $0, then $0.001/unit]
  PlanEntitlement     : FEATURE  advanced_reporting
  PlanEntitlement     : LICENSE  SEATS quantity=5
  PlanEntitlement     : CREDIT   quantity=500 rollover=false
  PlanEntitlement     : USAGE    key=api_calls includedUnits=10000 overagePriceId=api_over
```
Checkout creates a Subscription (owner Alice, beneficiary org Acme) with items `[base×1, seats×5]`. On ACTIVE: issue a 5-seat License to Acme, grant 500 credits to Acme's pool, open a 10k api_calls allowance for the period, mark `advanced_reporting` active for Acme. Acme's members consume seats/credits; api_calls past 10k bill via `api_over`.

## 6. Provisioning lifecycle (the hard part)

A single **`subscriptionProvisioner`** reacts to subscription state (driven by the existing per-app webhooks) and reconciles entitlements against the plan — idempotently:

- **activate / renew**: for each `PlanEntitlement`, ensure the materialized grant exists for the current period. Idempotency key = `(subscriptionId, planEntitlementId, periodStart)` so webhook replays + renewals grant exactly once. (Mirrors today's `maybeIssueLicenseFor` / `maybeGrantCreditsFor` idempotency in `stripe.handler.ts`, generalized.)
- **upgrade / downgrade (plan change)**: diff old vs new entitlements → add/remove licenses, adjust seat caps, change included quota; credits: grant the delta or nothing (policy).
- **cancel / lapse**: revoke licenses, stop future credit grants (existing balance policy: keep or zero — open question), close usage allowance (overage still billed for usage already incurred).
- **grant ledger** (`SubscriptionBenefit`): row per materialized grant linking `subscription → (entitlement, period, target row id)`; the audit trail + the thing revoke walks.

This generalizes what `stripe.handler.ts` already does ad-hoc (auto-issue license on LICENSE plan, grant credits on CREDIT plan) into one entitlement-driven engine.

## 7. Usage + overage

- Included quota lives on the `USAGE` `PlanEntitlement` (`quantity` = included units), attributed to the subject via `UsageRecord.endUserId`/`organizationId` (org pool = owner+beneficiary, ORG_BILLING §3) or neither (app-level).
- **Shipped (MVP): hard-cap, compute-on-read.** `usage.record` resolves the subject's included quota for the meter (`entitlementsService.includedQuotaFor` — sums USAGE entitlements over the subject's *own* ACTIVE subs: org-beneficiary subs for an org subject, personal `beneficiaryOrgId=null` subs for an end-user), sums the subject's existing usage in the current **calendar month (UTC)**, and rejects (`402 USAGE_QUOTA_EXCEEDED`) once `used + quantity > included`. No bundled quota (legacy metered plan / no plan) → uncapped. No subject (app-level) → never capped. **Deliberately no materialized `UsageAllowance` row** — the SUM-on-read over the indexed `UsageRecord` is enough for the cap and avoids a table + per-period provisioning/reset. Revisit a materialized allowance only when overage billing needs a running balance.
- Period = **calendar-month UTC**, not the subscription billing cycle — predictable for customers ("10k calls/month"), provider-agnostic, and needs no per-sub period bookkeeping. The record's `occurredAt` (default now) picks the month.
- **Later:** units past the included quota accrue **in-house** (we are the source of truth) and are charged via a provider invoice-item / usage push (a new interface method), not by handing metering to the provider.
- Tiered overage = `PlanPrice.scheme='tiered'`, `tiers=[{upTo:included, amount:0},{upTo:null, amount:perUnit}]` — exactly Stripe's pattern.

## 8. Credits

- `CREDIT` `PlanEntitlement` grants `quantity` to the beneficiary's `CreditBalance` each period via a `CreditLedger` entry (idempotent per period). `rollover` decides whether the prior balance carries over or resets. Reuses the existing atomic consume.

## 9. Entitlement resolution (read side)

- **Feature gate** ("can this user use advanced_reporting?"): true if the beneficiary (the user, or an org they're a member of) has an **active** subscription whose plan has a matching `FEATURE` PlanEntitlement. Mirror Stripe's `active_entitlements` query; optionally cache + emit a webhook like `entitlement.updated`.
- **Pooled draw** (credits/usage/seats): operate on the resolved beneficiary's row; no personal fallback in org context (ORG_BILLING §4.4).

## 10. Management + ownership (decided)

- **Only the owner** end-user manages the subscription (cancel / change plan / update payment). Org OWNER/ADMINs do **not** get management rights — they only receive the benefits. (Supersedes the earlier "org admin can co-manage" note.)
- **Transfer of ownership** is **not** a self-serve action: it's done **via the Panel by ReliPay support** (operator changes `Subscription.ownerEndUserId`). Keeps a single, auditable management identity and avoids an org-admin takeover vector.

## 11. Migration / phasing

Additive; `Plan.kind` stays as a back-compat shorthand (a single-kind plan = one `PlanEntitlement`), so existing plans/subscriptions keep working while the richer model rolls in.

1. **Phase A** — `PlanEntitlement` model + a provisioner that generalizes the current license/credit auto-grant (no pricing changes yet; bundles of LICENSE+CREDIT+FEATURE on the existing single base price).
2. **Phase B** — `PlanPrice` + `SubscriptionItem` (multiple prices/seat pricing) + tiered metered overage + `UsageAllowance`.
3. **Phase C** — entitlement-resolution read API + webhook + panel plan-builder UI (attach entitlements/prices to a plan).

(Interleaves with ORG_BILLING phasing — the owner+beneficiary subject lands first since the provisioner targets the beneficiary.)

## 12. Open questions
- On cancel: zero the credit balance, or let earned credits ride? (Stripe credits expire per grant; propose: grants stop, existing balance kept unless plan says expire.)
- Seat overage: block invites past the cap, or auto-add a seat item (post-pay)?
- Do we mirror Stripe objects 1:1 (Product/Price/Feature) or keep ReliPay's `Plan` as the umbrella with child `PlanPrice`/`PlanEntitlement`? **Decided: umbrella `Plan`** — fewer top-level concepts, same separation underneath.
- Build pricing/metering ourselves vs. lean on the provider? **Decided (§0): in-house source of truth** for provider-agnosticism — the provider only collects money. Overage *charging* is deferred; MVP hard-caps at the included quota.

## Free tier (default plan fallback)

Set `billingConfig.defaultPlanSlug` on an Application to a plan slug to make it the
free tier. End-users with **no active subscription** then resolve that plan's
**FEATURE** entitlements and its included **USAGE** quota at read time — no `$0`
checkout, no Subscription row. It applies to the individual end-user only (not the
org view).

Limitation: only FEATURE flags and USAGE caps fall back this way. **CREDIT** and
**LICENSE** grants are stateful (minted by the provisioner on activation) and still
require a real subscription, even at amount 0. Clear the free tier by setting
`defaultPlanSlug` to `null`.
