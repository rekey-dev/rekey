# Coupons

Discount codes scoped to one Application. Two kinds:

- **PERCENT** — `amountOff` is basis points. `1500` = 15.00%. Capped at 10000 (= 100%).
- **AMOUNT** — `amountOff` is the smallest currency unit. `500` = $5.00.

A coupon is never both. If you want to model "10% off OR $5 off, whichever is greater", that's two coupons + your own server-side picker.

## Creating

Two equivalent routes, both live:

- `POST /api/v1/tenant/applications/:id/coupons` — **operator session** (or an operator PAT), subject to the caller's per-application grants. This is the one the panel uses and the one you want.
- `POST /api/v1/admin/applications/:id/coupons` — the super-admin twin, gated by `SUPER_ADMIN_KEY`, for bootstrap and scripting.

Body (identical for both):

```json
{
  "code": "LAUNCH50",
  "discountType": "PERCENT",
  "amountOff": 5000,
  "planSlugs": ["pro_monthly"],
  "endsAt": "2026-12-31T23:59:59Z",
  "maxRedemptions": 1000,
  "maxRedemptionsPerUser": 1
}
```

- Codes are stored **lowercase**. `LAUNCH50` and `launch50` are the same coupon.
- Per-`(applicationId, code)` uniqueness; multi-tenant by design.
- `planSlugs` is optional — empty array = applies to any plan.
- `currency` is optional — only meaningful for AMOUNT coupons that should reject mismatched currencies.

## Validating (without applying)

For a pricing page that needs to show the discounted price before submit:

```ts
// SDK
try {
  const { discountAmount, amountAfterDiscount } =
    await rekey.billing.validateCoupon(userAccessToken, {
      code: 'LAUNCH50',
      planSlug: 'pro_monthly',
    });
  // render: "$50 off → $4.99/mo"
} catch (err) {
  // RekeyError with one of COUPON_*. err.message + err.fix are user-readable.
}
```

`POST /api/v1/billing/coupons/validate` takes an Application key — **publishable or secret** — plus the user JWT (the JWT is what lets per-user limits be enforced). It accepts the publishable key for exactly the same reason `POST /billing/checkout` does: a pricing page applying a coupon runs in the browser.

## Applying at checkout

Pass `couponCode` to `createCheckout`:

```ts
const { url, discountAmount } = await rekey.billing.createCheckout(userAccessToken, {
  planSlug: 'pro_monthly',
  successUrl: 'https://app.example/ok',
  cancelUrl:  'https://app.example/cancel',
  couponCode: 'LAUNCH50',  // optional
});
```

A bad coupon **rejects the entire checkout** with the precise `COUPON_*` code — no partial state is created.

The discount is sent to the payment provider, so what the buyer is charged is the discounted amount. `discountAmount` in the response is that same number.

## Not every provider can take a discount

Providers differ on this and the difference is not cosmetic, so checkout **refuses** rather than charging full price against a discount we recorded:

| Provider | One-time purchase | Recurring subscription |
|---|---|---|
| Stripe | ✅ ad-hoc Coupon on the Checkout Session | ✅ same, `duration: once` — the first invoice only |
| PayPal | ✅ `amount.breakdown.discount` (Orders v2) | ❌ Subscriptions v1 has no per-subscription discount; the inline `plan` override would cut the price of *every* period |
| Razorpay | ✅ the payment link is created for the net amount | ❌ subscriptions bill from the plan; Offers are dashboard-created, not per-checkout |

A ❌ combination returns `BILLING_DISCOUNT_UNSUPPORTED` (400) and redeems nothing. Front-ends can read this ahead of time from `capabilities.discounts` on `GET /api/v1/billing/providers`.

Two more refusals exist so the provider is never handed an unchargeable amount: `COUPON_NO_DISCOUNT` (the discount floors to zero) and `COUPON_FULL_DISCOUNT_UNSUPPORTED` (100% off a one-time purchase — no provider checks out a zero-value order, and fulfilment hangs off a payment event that would never fire). 100% off a *recurring* plan is fine on a provider that supports recurring discounts.

## Redemption is recorded once per completed checkout

The `CouponRedemption` row is inserted when the provider tells us the purchase went through — not when the checkout is created. Until then the coupon just rides on `Subscription.metadata.couponBySession`.

It used to be recorded at apply-time on the theory that slight overcounting was harmless. It wasn't: abandoning checkouts in a loop burned through `maxRedemptions` / `maxRedemptionsPerUser` without anyone paying, which is a denial-of-discount against every other customer. A redemption should cost money.

**The unit is one checkout session**, enforced by a unique index on `(couponId, checkoutSessionId)`. That is what a coupon is actually sold at:

- A **one-time** purchase (Stripe `mode: 'payment'`, PayPal Orders v2) emits no invoice at all, so redemption is recorded where fulfilment happens — checkout completion / order approval. Recording only at payment-success meant a single-use coupon discounted an unlimited number of one-off checkouts.
- A **recurring** purchase gets a provider coupon with `duration: 'once'`, so only the first invoice is discounted. Renewals reuse the same session id and record nothing further. Redeeming per payment multiplied one discount by the number of periods the customer stayed.
- Redemption is **not** in the same transaction as the `Payment` row, and never throws at the webhook applier. An exhausted coupon is a bookkeeping fact; rolling a collected payment back over it is a lost charge.

`CouponRedemption.discountAmount` records what the discount was worth at redemption time, which is what the operator's coupon totals are summed from.

## Validation rules — full table

| Check | Failure code (HTTP) |
|---|---|
| `active === true` | `COUPON_INACTIVE` (400) |
| `now >= startsAt` (if set) | `COUPON_NOT_YET_STARTED` (400) |
| `now <= endsAt` (if set) | `COUPON_EXPIRED` (400) |
| `planSlugs` contains target plan (if set) | `COUPON_NOT_APPLICABLE` (400) |
| AMOUNT coupon currency matches plan currency (if `currency` set) | `COUPON_CURRENCY_MISMATCH` (400) |
| Total redemptions < `maxRedemptions` (if set) | `COUPON_REDEMPTION_LIMIT_REACHED` (400) |
| User redemptions < `maxRedemptionsPerUser` (if set) | `COUPON_USER_LIMIT_REACHED` (400) |

## Discount math

```ts
function discount(coupon, planAmount) {
  if (coupon.discountType === 'PERCENT') {
    return Math.min(Math.floor(planAmount * coupon.amountOff / 10000), planAmount);
  }
  return Math.min(coupon.amountOff, planAmount);
}
```

Always integers. Always clamped at `planAmount` (a discount can never exceed the price). Always floored — fractional cents are not representable in our schema.

## What's deliberately not here yet

- **Multi-period discounts.** A coupon buys the first invoice, matching the one redemption it records. "20% off for six months" is not expressible.
- **PayPal / Razorpay recurring discounts.** Doing this honestly needs a discounted plan variant with an intro cycle, minted at plan-registration time — a different feature from applying a coupon at checkout. Until then those combinations are refused, not approximated.
- **Stacked coupons.** One per checkout. If a customer wants "pay-in-full discount + first-month-free", model as one coupon.
- **Promotion codes (Stripe-style code-vs-coupon).** We collapse them into one model. The provider abstraction can map at the seam later if needed.
