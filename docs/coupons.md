# Coupons

Discount codes scoped to one Application. Two kinds:

- **PERCENT** — `amountOff` is basis-points × 10. `1500` = 15.00%. Capped at 10000 (= 100%).
- **AMOUNT** — `amountOff` is the smallest currency unit. `500` = $5.00.

A coupon is never both. If you want to model "10% off OR $5 off, whichever is greater", that's two coupons + your own server-side picker.

## Creating

Admin-only — `POST /api/v1/admin/applications/:id/coupons`:

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
    await relipay.billing.validateCoupon(userAccessToken, {
      code: 'LAUNCH50',
      planSlug: 'pro_monthly',
    });
  // render: "$50 off → $4.99/mo"
} catch (err) {
  // RelipayError with one of COUPON_*. err.message + err.fix are user-readable.
}
```

`POST /api/v1/billing/coupons/validate` requires both an Application secret key and the user JWT (so per-user limits can be enforced).

## Applying at checkout

Pass `couponCode` to `createCheckout`:

```ts
const { url, discountAmount } = await relipay.billing.createCheckout(userAccessToken, {
  planSlug: 'pro_monthly',
  successUrl: 'https://app.example/ok',
  cancelUrl:  'https://app.example/cancel',
  couponCode: 'LAUNCH50',  // optional
});
```

A bad coupon **rejects the entire checkout** with the precise `COUPON_*` code — no partial state is created.

## Redemption is recorded at apply-time

When a coupon is applied at checkout we insert a `CouponRedemption` row immediately, even before the payment goes through. This means an abandoned checkout *does* count toward `maxRedemptions`. Cleanup of "applied but never paid" rows is a future concern — slight overcounting is acceptable today.

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

- **Coupon usage on the actual `Payment` row.** The redemption is linked to the Subscription at apply-time; linking to the eventual successful Payment via the webhook is a follow-up.
- **Stacked coupons.** One per checkout. If a customer wants "pay-in-full discount + first-month-free", model as one coupon.
- **Promotion codes (Stripe-style code-vs-coupon).** We collapse them into one model. The provider abstraction can map at the seam later if needed.
- **Cleanup of "applied but unpaid" redemptions.** Slight overcounting is acceptable today. Not worth fixing without a clear concurrent-checkout story.
