# Billing architecture and the decisions behind it

`billing.md` documents the surface: endpoints, the state machine, webhooks. This documents the shape underneath it — what Rekey owns, what a provider owns, why the boundary sits where it does, and how to extend it without discovering the boundary the hard way.

Read this before adding a plan kind, a provider, or anything that charges money.

## The boundary

> **Rekey owns what a subscriber is entitled to. A provider owns the movement of money.**

Every design decision below follows from that sentence, and the failures we have had came from blurring it.

A provider is asked to do two things: take a payment, and tell us truthfully whether it succeeded. It is never asked what a trial is, what a coupon means, or whether somebody may call an API. Those are product questions, and a provider that answered them would answer differently per vendor — which is how a feature matrix grows a column per integration.

The practical test: **if adding a fourth provider would require re-answering a product question, the question is on the wrong side of the boundary.**

## What exists today

### Plan kinds

A `Plan` has a `kind`, and the kind decides what a purchase provisions:

| Kind | Sold as | Provisions |
| --- | --- | --- |
| `SUBSCRIPTION` | Recurring charge | Feature flags and numeric limits, per period |
| `CREDIT` | One-off charge | A credit balance to spend down |
| `LICENSE` | One-off charge | A licence key — perpetual, timed, or seat-counted |
| `USAGE` | Recurring charge | An included quota against a meter — but only where explicit `PlanEntitlement` rows say so. A `USAGE` plan with none synthesizes an entitlement with a null quantity, which resolves to *no quota* and is therefore uncapped. |

`amount` is always an integer in the currency's smallest unit. `$9.99` is `999`. Never a float, never at rest, never in transit.

### Entitlements

An entitlement is a row saying "this subject may have this thing". Resolution unions every active subscription the subject holds, plus the subscriptions of organizations they belong to.

**Numeric `FEATURE` entitlements take the maximum across subscriptions — they are not summed.** This is deliberate and load-bearing: during an upgrade both subscriptions are briefly live, and summing would hand the buyer double what they paid for, then take it away when the old one lapses. The cost is that "ten seats" cannot be sold as ten one-seat subscriptions; sell a ten-seat plan.

**`USAGE` quotas and `CREDIT` grants do the opposite — they add up.** `includedQuotaFor` sums `quantity` across every entitling subscription, and a credit grant is provisioned once per subscription. So a subscriber holding two plans that each include 1,000 units gets 2,000, and the upgrade overlap the `FEATURE` rule guards against is real here. That inconsistency predates priced meters; pricing them turns it from a delayed `402` into foregone revenue, and it should be settled deliberately rather than inherited.

**Entitling status is `ACTIVE` *and* `PAST_DUE`.** A customer in dunning keeps what they bought while the provider retries — cutting access off at the first failed charge punishes the payment, not the customer. It also means a `PAST_DUE` subscriber keeps drawing down credits, which is intended: they are still entitled to spend what they pre-paid.

**Personal quota deliberately excludes organization-beneficiary subscriptions.** Usage metered under an org draws on the org pool; usage metered against a person draws on theirs. Recording team usage with `endUserId` instead of `organizationId` therefore bills the individual, which is a caller mistake worth catching in review.

### Two ways to meter spend

**Credits** are a pre-paid balance. `POST /credits/consume` is atomic, and idempotent **when the caller supplies a key** — without one, every call counts, which is the right default for a counter and the wrong one for a charge. A spend past zero returns `402` rather than going negative. This is the model for anything an agent burns unpredictably.

**Usage meters** count. Recording against a meter checks the subscriber's included quota for the UTC calendar month and refuses with `402 USAGE_QUOTA_EXCEEDED` past it. Until the change described below, a meter could only *cap*; it could not *cost*.

### Subscriptions with no provider behind them

`grantSubscription` creates an `ACTIVE` subscription with `provider` and `providerSubId` null, going through the same provisioning and the same outbox as a real activation. It exists because a deployment with no payment provider — or one selling by invoice, which is how Rekey Cloud sells — otherwise had no way to record a sale at all.

This is not a workaround. It is the boundary working: entitlement is ours, so we can grant it without asking anyone.

## Decisions, and what they cost

### Coupons apply once, and the model cannot express anything else

`Coupon` carries `discountType`, `amountOff`, validity window, and redemption limits. It has **no duration field**. Every coupon is implicitly first-period-only, and the provider call says so explicitly — a Stripe coupon is minted `duration: 'once'`.

The redemption grain follows from that: `@@unique([couponId, checkoutSessionId])`, one redemption per purchase, specifically so a renewal invoice cannot record a second redemption for the same discount.

**Cost:** "20% off forever" and "50% off for six months" are not expressible. See the extension section — the model change comes before any provider work.

### A provider that cannot do something says so, and we refuse

`capabilities.discounts` is optional and **absent means cannot**. A module that says nothing is never handed a discount it would silently drop:

> Fail-closed here costs a refused checkout; fail-open costs the buyer money.

That is the rule for every capability added since. A refusal is a support conversation; a wrong charge is a chargeback and a lost customer.

### PayPal refuses recurring discounts on purpose

PayPal's Subscriptions v1 has no per-subscription discount. The only price control is an inline plan override that restates a cycle the plan already declares — so "20% off the first month" becomes "20% off every month, forever" against a single recorded redemption. Refusing is the honest answer; charging a permanently wrong price is a different lie from charging full price.

### Expiry keys on `cancelAt`, not on `currentPeriodEnd`

A subscription stops entitling when `cancelAt` is set and past. `currentPeriodEnd` is display and anchoring; it does not end anything.

**Cost, and it is a real one:** `grantSubscription` accepts `currentPeriodEnd` and not `cancelAt`, so a granted subscription cannot be made to end by itself. Time-boxed grants — trials, comped months, limited-time plans — are not currently possible. This is the first thing to fix for trials.

### `cancelEffect` predicts; `isCancelScheduled` reports

Two questions that read alike and are not:

- `isCancelScheduled(sub)` — is this already ending? (`cancelAt !== null`)
- `cancelEffect(sub)` — if I cancel *now*, does the subscriber keep the period they paid for, or does access stop immediately?

The second returns `'period-end' | 'immediate'` rather than a boolean, because the previous name (`cancelsAtPeriodEnd`) was read as the first question by everyone who met it, including three of our own starter kits. A discriminant cannot be mistaken for a state.

## Prepaid usage billing

The change this document accompanies.

### The problem

Usage meters could count and cap, but not charge. `Plan.pricePerUnitCents` is **mandatory** on `USAGE` plan creation, **immutable** afterwards, shown in the panel and the CLI as though it were live — and read by nothing in the billing path. An operator is required to declare a currency price they cannot change and which charges nobody. Until that field is repurposed or removed, a priced meter means two prices on screen and only one of them real; say so in the panel rather than letting an operator find out. So "pay for what your agent spends" was metering with a wall at the end, not billing.

### Why prepaid, and not an invoice at month end

Post-paid billing needs to charge an amount nobody knew in advance, at a time the customer is not present. That requires a stored mandate and merchant-initiated transactions, which are gated in ways our users cannot control:

- **PayPal** requires account-level approval for reference transactions.
- **Razorpay** falls under RBI e-mandate rules: registration is capped at ₹15,000 without additional authentication, and a pre-debit notification is required 24 hours before each debit.
- Only Stripe is ungated.

Making postpaid the primary model would mean every Rekey user has to negotiate features with their payment provider before they can bill for usage. Prepaid needs none of that: a credit pack is a one-off charge, which every provider does today.

### The design

The price lives on the **plan entitlement that grants the quota**, expressed in
credits rather than currency:

```
PlanEntitlement.creditsPerUnit  Int?   -- USAGE only; null = the quota is a hard cap
UsageMeter.creditsPerUnit       Int?   -- fallback for a subject whose plan does not price it
```

On the entitlement, not the meter, for three reasons. Two plans may rate one
meter differently, which a meter-level price cannot express at all. A meter has
no edit surface and deleting one cascades its usage history, so re-pricing by
recreation would destroy the billing record. And every other price in the system
already lives on a plan.

Where two entitling plans price the same meter, **the lowest rate wins**. Quotas
are additive, so a subscriber holding two plans already gets the benefit of both;
charging the dearer rate while summing the allowances would be inconsistent. This
is written down because the code cannot decide it and two engineers would not
agree.

Each `UsageRecord` keeps `creditsCharged` and `creditsPerUnitApplied`, so a
dispute has an answer that does not depend on the plan still saying what it said.

Recording usage against a priced meter debits the subject's credit balance through the same atomic path `credits.consume` uses, **inside the transaction that writes the usage record**, so a unit recorded but not paid for cannot exist. Nothing new touches a provider. The credit pack that funds the balance is an ordinary `CREDIT` plan, bought with a one-off charge.

**Charging requires both a price and an explicitly configured entitlement.** `includedQuotaFor` returns null for "no `USAGE` entitlement with a positive quantity", which is indistinguishable from "no plan at all" and from a legacy `USAGE` plan. Reading that as a quota of zero would start billing all of them from the first unit the moment a meter was priced. An operator who wants to charge from unit one sets an explicit included quota of `0`; opting in is a sentence in the panel, and opting out after mis-billing is a refund run.

Why credits rather than currency on the meter: **`CreditBalance` has no currency**, and it does not need one. A subject may legitimately top up from a USD pack and an INR pack; a currency-denominated wallet would need a currency per balance, per-currency sub-balances and a conversion policy. Credits sidestep all of it, and they already carry the three properties money demands — atomic, idempotent, never negative.

Be clear about the limit of that, because it is not what it first looks like. **Credits are a terminal representation, not a general one.** Credit packs are ordinary plans, so an operator selling "1,000 for $9" and "5,000 for $40" has minted credits at two different implied rates into one balance, and no single credits-to-currency rate exists afterwards. Postpaid billing must be denominated in currency, so it will need its own accrual rather than reusing this one, and prepaid and postpaid revenue on the same meter will not be directly summable. If that matters, the cheap insurance is to declare a rate per Application **now**, while the ledger is empty, rather than trying to recover one later.

**The properties this must preserve**, all of which credits already have:

- A debit is atomic with the usage record. Either both happen or neither does; usage that was not paid for is not recorded.
- A debit is idempotent on the caller's key, so a retry does not double-charge.
- A spend past zero refuses with `402` rather than going negative. An agent cannot run up a debt.

### Interaction with included quota

A plan may include a quota *and* the meter may have a price. Order:

1. Included quota first — a subscriber consumes what they have paid for before spending credits.
2. Credits second — past the quota, each unit costs `creditsPerUnit`.
3. `402` when neither remains.

This makes "1,000 calls included, then 1 credit each" expressible, which is the shape most metered products want.

## Extending this

### Adding a plan kind

1. Add it to the `PlanKind` enum and the plan-create validation, naming the fields it requires.
2. Decide what it provisions in `entitlements.service`. If it provisions nothing, say so there — silence reads as an omission.
3. Decide what a purchase means: one-off or recurring. That decides which checkout path it takes.
4. Add the panel form fields, which adapt to kind.

Do not add a kind whose meaning depends on the provider. If it cannot be explained without naming Stripe, it belongs behind a capability flag instead.

### Adding a provider

Implement the module contract and declare capabilities honestly. Absent means cannot, and that is always safe. A provider that cannot do something makes checkouts refuse, which is visible; a provider that claims something it cannot do charges somebody the wrong amount, which is not.

### Postpaid usage billing, when we do it

This is the extension the current design deliberately leaves room for rather than building.

Postpaid requires charging an unknown amount later, so it requires a mandate. The seam is a third provider primitive alongside the existing two:

```ts
capabilities: {
  /** Can store a payment method and charge it later, merchant-initiated. */
  mandate?: {
    /** Take a mandate and return a token we can charge against. */
    supported: boolean;
    /** Cap the mandate must declare up front, in the smallest currency unit.
     *  RBI requires one on Razorpay e-mandates; Stripe has no equivalent. */
    requiresMaxAmount?: boolean;
  };
}
```

With that, a `METERED_POSTPAID` plan kind becomes: take a mandate at signup, meter the period, charge the total at period end through `charge(mandateToken, amount)`. The entitlement clock stays ours; only the charge is new.

**What must not change when it lands:** usage recording stays atomic and idempotent, and a failed end-of-period charge must move the subscription to `PAST_DUE` through the existing dunning path rather than inventing a second one. Postpaid adds a way to pay; it does not add a second lifecycle.

The reason it is not built now is not difficulty. It is that it would make every Rekey user's ability to bill for usage depend on approvals from their payment provider, and prepaid does the same job with primitives every provider already has.

### Discount durations, when we do them

The order is model, then provider — not the reverse.

1. `Coupon` gains a duration: `ONCE | FOREVER | REPEATING(n)`. Without this there is nothing to pass to anyone.
2. Decide the redemption grain for a repeating discount. One redemption applied `n` times, not `n` redemptions — the existing unique index assumes one discount per purchase and was written that way on purpose.
3. `FOREVER` is vendor-agnostic and needs no provider feature: subscribe at the discounted amount. We already mint plans and prices on all three.
4. `ONCE` is vendor-agnostic: charge the discounted first period as a one-off, start the recurring subscription one period later at full price.
5. `REPEATING(n)` is genuinely provider-dependent — Stripe natively, PayPal via an intro cycle on a minted plan variant, Razorpay not at all, because its subscription offers can only be created from the Dashboard. Capability flag, fail closed, and say so in the panel.

Do not reach for "subscribe discounted, then revise to full price at period n". PayPal's revise requires the subscriber to re-consent, and if they do not, the subscription keeps billing the old price indefinitely. A revenue leak that looks like success is worse than a refusal.

## What is still not here

- **Postpaid usage billing.** See above. Needs mandates.
- **Trials.** The clock is ours to build; the blocker is that grants cannot be time-boxed.
- **Discount durations.** Model change first.
- **Refunds, proration, mid-cycle changes.** Wrap provider behaviour; do not reinvent.
- **Tax.** Provider or external. Not our scope.
