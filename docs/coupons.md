# Coupons

Discount codes scoped to one Application. Two kinds:

- **PERCENT**: `basisPoints` is hundredths of a percent. `1500` = 15.00%, from 1 to 10000 (= 100%). It works on a price in any currency, unless `currencies` limits it.
- **AMOUNT**: `amounts` holds one amount per currency, each in that currency's smallest unit: `{ "currency": "USD", "amountOff": 500 }` = $5.00. It works only in the currencies it has an amount for.

An amount is never converted and never reused in another currency. Local prices are often purchasing-power prices, so $5 off a $19 plan and ₹400 off a ₹1,499 plan are two decisions, and you state both.

A coupon is never both kinds. If you want to model "10% off OR $5 off, whichever is greater", that's two coupons + your own server-side picker.

## Creating

Two equivalent routes, both live:

- `POST /api/v1/tenant/applications/:id/coupons` — **operator session** (or an operator PAT), subject to the caller's per-application grants. This is the one the panel uses and the one you want.
- `POST /api/v1/admin/applications/:id/coupons` — the super-admin twin, gated by `SUPER_ADMIN_KEY`, for bootstrap and scripting.

Body (identical for both):

```json
{
  "code": "LAUNCH50",
  "discountType": "PERCENT",
  "basisPoints": 5000,
  "currencies": ["USD", "EUR"],
  "planSlugs": ["pro_monthly"],
  "endsAt": "2026-12-31T23:59:59Z",
  "maxRedemptions": 1000,
  "maxRedemptionsPerUser": 1
}
```

```json
{
  "code": "FIVEOFF",
  "discountType": "AMOUNT",
  "amounts": [
    { "currency": "USD", "amountOff": 500 },
    { "currency": "INR", "amountOff": 40000 }
  ]
}
```

- Codes are stored **lowercase**. `LAUNCH50` and `launch50` are the same coupon.
- Per-`(applicationId, code)` uniqueness; multi-tenant by design.
- `planSlugs` is optional: empty or left out applies to any plan.
- `currencies` is optional and PERCENT only: empty or left out applies in any currency. Use it so a discount written for the USD price is not also taken off a purchasing-power price.
- Every currency must be one a price can be in, and every amount a chargeable one: above zero, and whole units for HUF, TWD and MGA (written in hundredths, so `50000` is Ft 500). A three-decimal currency such as KWD is refused.
- `amountOff` and `currency` at the top level were removed in 2.2.0-rc.7. A body that still sends either is refused with `BILLING_FIELD_REMOVED`.

The response, and every read, has the same shape for both kinds:

```json
{
  "id": "…", "applicationId": "…", "code": "fiveoff", "discountType": "AMOUNT",
  "basisPoints": null,
  "amounts": [{ "currency": "INR", "amountOff": 40000 }, { "currency": "USD", "amountOff": 500 }],
  "currencies": [],
  "coveredCurrencies": ["INR", "USD"],
  "planSlugs": [], "active": true, "startsAt": null, "endsAt": null,
  "maxRedemptions": null, "maxRedemptionsPerUser": null, "metadata": {},
  "createdAt": "…", "updatedAt": "…"
}
```

`coveredCurrencies` is every currency a checkout may use the coupon in, and `null` means any.

With `@rekey.dev/node` and an operator token (`billing:write`):

```ts
await operator.coupons.create({ code: 'LAUNCH50', discountType: 'PERCENT', basisPoints: 5000, currencies: ['USD', 'EUR'] });

const fiveOff = await operator.coupons.create(
  {
    code: 'FIVEOFF',
    discountType: 'AMOUNT',
    amounts: [
      { currency: 'USD', amountOff: 500 },
      { currency: 'INR', amountOff: 40000 },
    ],
  },
  { idempotencyKey: 'create-fiveoff' }, // makes a retry safe
);
console.log(fiveOff.coveredCurrencies); // ['INR', 'USD']
```

Creating and changing a coupon are written to the [billing log](billing-log.md)
as `coupon.created` and `coupon.changed`, with the terms before and after.

From a terminal, with `REKEY_OPERATOR_TOKEN`:

```bash
rekey coupons create --app <id> --code LAUNCH50 --percent 50 --currencies USD,EUR
rekey coupons create --app <id> --code FIVEOFF --amount USD=500 --amount INR=40000
rekey coupons update FIVEOFF --app <id> --amount USD=500 --amount EUR=450
rekey coupons update LAUNCH50 --app <id> --ends-at 2026-12-31 --max-redemptions 500 --max-redemptions-per-user none
rekey coupons list --app <id>
rekey coupons show FIVEOFF --app <id>
```

`--amount CUR=n` is an integer in the minor unit of that currency, one flag per
currency. On `update`, the `--amount` flags replace the whole set, and
`--ends-at`, `--max-redemptions` and `--max-redemptions-per-user` each take a
value or `none`, which removes the end date or the cap. On the
operator MCP server the tools are `list_coupons`, `create_coupon` and
`update_coupon`.

## Changing

`PATCH .../coupons/:code` on either route takes any of `active`, `basisPoints`, `amounts`, `currencies`, `planSlugs`, `endsAt`, `maxRedemptions` and `maxRedemptionsPerUser`. `amounts` replaces the whole set, so send every currency the coupon should keep. `discountType`, the code and `startsAt` cannot be changed. A checkout already open keeps the discount it was opened with.

`endsAt` takes an ISO 8601 date-time, or `null` to remove the end. `maxRedemptions` and `maxRedemptionsPerUser` each take a whole number of 1 or more, or `null` for no cap. A field left out is left as it is.

A cap cannot go below the redemptions the coupon already holds. They are counted the way a checkout counts them against the limit: settled redemptions plus checkouts still open that hold the coupon. `maxRedemptions` below that count, or `maxRedemptionsPerUser` below what any one buyer holds, is refused with `COUPON_LIMIT_BELOW_REDEEMED` (409) and nothing is changed. `details` carries `{ field, requested, redeemed, settled, reserved }`: `redeemed` is the lowest value the cap can take now. The count and the write happen under the lock every redemption takes, so a checkout cannot take a slot under a cap while it is being lowered.

Every change is written to the [billing log](billing-log.md) as `coupon.changed`, in the same transaction, with the coupon's terms before and after: `active`, the discount, `currencies`, `planSlugs`, `endsAt`, `maxRedemptions` and `maxRedemptionsPerUser`. An entry written before the last three were logged does not carry them.

`GET /api/v1/tenant/applications/:id/coupons/:code` reads one coupon. The list, `GET .../coupons`, adds `redemptionCount` and `discountIssuedByCurrency`: one `{ currency, amount, redemptions }` row per currency the coupon was redeemed in, the Application's reporting currency first. There is no total, because money in two currencies is never added together.

```ts
import { formatMoney } from '@rekey.dev/node';

// `amounts` replaces the whole set: send every currency the coupon should keep.
await operator.coupons.update('FIVEOFF', {
  amounts: [
    { currency: 'USD', amountOff: 500 },
    { currency: 'EUR', amountOff: 450 },
  ],
});
await operator.coupons.update('LAUNCH50', { active: false });
await operator.coupons.update('LAUNCH50', { endsAt: '2026-12-31T23:59:59.000Z', maxRedemptions: 500 });
await operator.coupons.update('LAUNCH50', { maxRedemptionsPerUser: null }); // no cap per buyer

const coupon = await operator.coupons.get('FIVEOFF');
const worksInRupees = coupon.coveredCurrencies === null || coupon.coveredCurrencies.includes('INR');

const { items } = await operator.coupons.list({ limit: 100 });
for (const each of items) {
  for (const row of each.discountIssuedByCurrency) {
    console.log(each.code, formatMoney(row.amount, row.currency), row.redemptions, worksInRupees);
  }
}
```

## Validating (without applying)

For a pricing page that needs to show the discounted price before submit:

```ts
import { RekeyError } from '@rekey.dev/node';

export async function previewCoupon(userAccessToken: string, code: string) {
  try {
    const quote = await rekey.billing.validateCoupon(userAccessToken, { code, planSlug: 'pro_monthly' });
    // Written by the API in the currency the checkout would charge.
    return `${quote.formatted.discount} off, you pay ${quote.formatted.total}`; // '$10.00 off, you pay $9.99'
  } catch (err) {
    // A RekeyError with one of the COUPON_* codes. Its message is written for the buyer.
    if (err instanceof RekeyError) return err.message;
    throw err;
  }
}
```

In a browser, `client.validateCoupon(accessToken, input)` from
`@rekey.dev/react` makes the same call, and `<CouponQuote quote={quote} />`
renders the result ([react-components.md](react-components.md#couponquote)).

`POST /api/v1/billing/coupons/validate` takes an Application key — **publishable or secret** — plus the user JWT (the JWT is what lets per-user limits be enforced). It accepts the publishable key for exactly the same reason `POST /billing/checkout` does: a pricing page applying a coupon runs in the browser.

The quote is made at the price the checkout would charge for this buyer, so send the same `country`, `currency`, `onUnavailableCurrency`, `provider` and `organizationId` the checkout will send. Left out, `onUnavailableCurrency` is the Application's default here as it is at checkout. The response is:

```json
{
  "coupon": { "code": "launch50", "discountType": "PERCENT", "basisPoints": 5000 },
  "plan": { "slug": "pro_monthly", "name": "Pro" },
  "price": { "id": "…", "currency": "USD", "amount": 1999, "formatted": "$19.99", "isDefault": true, "reason": "default" },
  "priceFallback": null,
  "currency": "USD",
  "amount": 1999,
  "discountAmount": 1000,
  "amountAfterDiscount": 999,
  "formatted": { "discount": "$10.00", "total": "$9.99" }
}
```

Render `formatted.discount` and `formatted.total`. `discountAmount` and `amountAfterDiscount` are the same figures as integers in the minor unit of `currency`. When `priceFallback` is set, the quote is for the plan's default price because the price selected for the buyer could not be charged: say so before they pay (see [billing.md](billing.md#when-a-currency-cannot-be-charged)).

It answers every refusal the checkout would give for the coupon, with the same code, including the ones that depend on the provider (`BILLING_DISCOUNT_UNSUPPORTED`, `COUPON_FULL_DISCOUNT_UNSUPPORTED`).

## A coupon that does not cover the currency charged

A coupon is judged in the currency of the price charged. When the price selected for the buyer cannot be charged and the checkout falls back to the default price, that is the default price's currency.

A fixed-amount coupon with no amount in that currency, or a percentage limited to other currencies, is refused with `COUPON_CURRENCY_NOT_COVERED`, both where the code is entered and at checkout:

```json
{
  "code": "COUPON_CURRENCY_NOT_COVERED",
  "message": "Coupon \"FIVEOFF\" does not work for prices in INR.",
  "fix": "Check out without `couponCode` to pay the full price in INR, …",
  "details": { "chargedCurrency": "INR", "requestedCurrency": null }
}
```

After a fallback the message names both currencies ("Prices in EUR cannot be charged yet, so this purchase is charged in USD, and coupon … does not work for prices in USD.") and `details.requestedCurrency` is the one that could not be charged. The currencies the coupon does cover are never named. The buyer chooses whether to continue at full price: a discount is never dropped silently and never converted.

`COUPON_CURRENCY_MISMATCH` and `COUPON_CURRENCY_REQUIRED` no longer exist. This one code replaces both.

To see which buyers a coupon will refuse before any of them meets it, pass `couponCode` to the [routing preview](billing.md#routing-preview).

## Applying at checkout

Pass `couponCode` to `createCheckout`:

```ts
export async function checkoutWithCoupon(userAccessToken: string) {
  const checkout = await rekey.billing.createCheckout(userAccessToken, {
    planSlug: 'pro_monthly',
    successUrl: 'https://app.example/ok',
    cancelUrl: 'https://app.example/cancel',
    couponCode: 'LAUNCH50', // optional
  });
  // checkout.discountAmount is in checkout.currency, the currency charged.
  return checkout.url;
}
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

Two more refusals exist so the provider is never handed an unchargeable amount: `COUPON_NO_DISCOUNT` (the coupon takes nothing off, which only a coupon from an earlier build with a percentage of 0 can do) and `COUPON_FULL_DISCOUNT_UNSUPPORTED` (the whole price off a one-time purchase: no provider checks out a zero-value order, and fulfilment hangs off a payment event that would never fire). The whole price off a *recurring* plan is fine on a provider that supports recurring discounts: a fixed amount larger than the price is capped at the price, and the first period is free.

## Redemption is recorded once per completed checkout

The `CouponRedemption` row is inserted when the provider tells us the purchase went through — not when the checkout is created. Until then the coupon just rides on `Subscription.metadata.couponBySession`.

It used to be recorded at apply-time on the theory that slight overcounting was harmless. It wasn't: abandoning checkouts in a loop burned through `maxRedemptions` / `maxRedemptionsPerUser` without anyone paying, which is a denial-of-discount against every other customer. A redemption should cost money.

**The unit is one checkout session**, enforced by a unique index on `(couponId, checkoutSessionId)`. That is what a coupon is actually sold at:

- A **one-time** purchase (Stripe `mode: 'payment'`, PayPal Orders v2) emits no invoice at all, so redemption is recorded where fulfilment happens — checkout completion / order approval. Recording only at payment-success meant a single-use coupon discounted an unlimited number of one-off checkouts.
- A **recurring** purchase gets a provider coupon with `duration: 'once'`, so only the first invoice is discounted. Renewals reuse the same session id and record nothing further. Redeeming per payment multiplied one discount by the number of periods the customer stayed.
- Redemption is **not** in the same transaction as the `Payment` row, and never throws at the webhook applier. An exhausted coupon is a bookkeeping fact; rolling a collected payment back over it is a lost charge.

A redemption records the currency charged, the amount taken off in it (`discountAmount`) and the price row (`planPriceId`). The operator's coupon totals are summed from those, per currency. Limits are counted across currencies: a single-use coupon is used up by one purchase in any of them.

## Validation rules — full table

| Check | Failure code (HTTP) |
|---|---|
| `active === true` | `COUPON_INACTIVE` (400) |
| `now >= startsAt` (if set) | `COUPON_NOT_YET_STARTED` (400) |
| `now <= endsAt` (if set) | `COUPON_EXPIRED` (400) |
| `planSlugs` contains target plan (if set) | `COUPON_NOT_APPLICABLE` (400) |
| The coupon covers the currency charged | `COUPON_CURRENCY_NOT_COVERED` (400) |
| The discount is above zero | `COUPON_NO_DISCOUNT` (400) |
| Total redemptions < `maxRedemptions` (if set) | `COUPON_REDEMPTION_LIMIT_REACHED` (400) |
| User redemptions < `maxRedemptionsPerUser` (if set) | `COUPON_USER_LIMIT_REACHED` (400) |

## Discount math

A fixed-amount coupon takes off its amount in the currency charged, capped at
the price. A percentage coupon takes off what `percentageDiscount` returns:

```ts
import { percentageDiscount } from '@rekey.dev/shared-types';

percentageDiscount('USD', 1999, 1500); // 300: 15% of $19.99 is 299.85, rounded up to $3.00
percentageDiscount('USD', 1000, 1500); // 150: exact, nothing to round
percentageDiscount('HUF', 499000, 1500); // 74900: 749 Ft, a whole forint
```

Always integers. Always clamped at the amount (a discount can never exceed the price). A percentage that does not land on a chargeable amount is rounded up, toward the buyer: 15% of 19.99 takes 3.00 and the buyer pays 16.99. In a currency charged in whole units only (HUF, TWD, MGA) the discount is rounded up to a whole unit.

The provider is always handed the computed amount, never the percentage, so the provider cannot round it differently from Rekey.

## What's deliberately not here yet

- **Multi-period discounts.** A coupon buys the first invoice, matching the one redemption it records. "20% off for six months" is not expressible.
- **PayPal / Razorpay recurring discounts.** Doing this honestly needs a discounted plan variant with an intro cycle, minted at plan-registration time — a different feature from applying a coupon at checkout. Until then those combinations are refused, not approximated.
- **Stacked coupons.** One per checkout. If a customer wants "pay-in-full discount + first-month-free", model as one coupon.
- **Promotion codes (Stripe-style code-vs-coupon).** We collapse them into one model. The provider abstraction can map at the seam later if needed.
