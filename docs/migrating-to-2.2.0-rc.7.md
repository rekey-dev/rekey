# Migrating to 2.2.0-rc.7

2.2.0-rc.7 changes how Rekey holds money. A plan can have a price in more than
one currency, the API resolves which price a buyer is charged, coupons carry an
amount per currency, refunds are records, and every pricing decision is
written to a billing log. Several fields, one header and two error codes are
removed. Nothing is kept only for compatibility, so read this page before you
upgrade.

"Before" below is 2.2.0-rc.6, the previous release.

Guides for the new shapes: [billing.md](billing.md),
[currencies.md](currencies.md), [coupons.md](coupons.md),
[billing-log.md](billing-log.md), [webhooks.md](webhooks.md),
[errors.md](errors.md#billing-money-model).

## Upgrade the API and the SDKs together

- A **2.2.0-rc.6 SDK against a 2.2.0-rc.7 API** is refused wherever it sends a
  country: those SDKs send the `x-country` header, which the API now answers
  with `BILLING_FIELD_REMOVED` (400). That affects `billing.getProviders(country)`,
  `billing.createCheckout({ country })` and `listBillingProviders({ country })`.
- A **2.2.0-rc.7 SDK against a 2.2.0-rc.6 API** reads fields that are not
  there, such as `plan.price`.

So deploy the API first, then ship your apps on the new SDKs. The order is
under [Deploying](#deploying).

## The one rule that changes most code

An amount is an integer in the minor unit of its currency, as before. What
changes is how you show it and which one you show:

- Show an amount with `formatMoney(amount, currency)`. Remove every fixed
  divisor and every hand-kept list of zero-decimal currencies.
- Where the API resolved a price for a buyer, render the `formatted` text it
  returns: a plan's `price.formatted`, a checkout's `price.formatted`, a coupon
  quote's `formatted.discount` and `formatted.total`.
- Do not pick a price out of `plan.prices` yourself. The price you pick is not
  the price checkout charges.

## `@rekey.dev/node`

| What | Before | Now | What to change |
|---|---|---|---|
| `billing.getPlans` | `getPlans(page?)` | `getPlans(page?, { country?, accessToken? })` | Pass the buyer's `country`, and their access token when signed in, so each plan's `price` is the one they would be charged. Existing calls still compile. |
| `RekeyOperator.plans.create`, `.update` | Not present | Create a plan and change one, with `price: { currency, amount }` | New. |
| A plan from `getPlans` (`PublicPlanDto`) | The operator's plan plus `checkout.ready`: it carried `applicationId`, `active`, `metadata`, `pricePerUnitCents`, `createdAt`, `updatedAt` | A fixed list: `id`, `slug`, `name`, `kind`, `interval`, `isFree`, `trialDays`, the licence fields, `meterSlug`, `creditsAmount`, `price`, `prices`, `checkout` | Stop reading the removed fields from the public plan. `pricePerUnitCents` is gone everywhere; read the others from the operator plan list if you need them. |
| The price to show | `plan.amount` and `plan.currency`, formatted by you | `plan.price` (`{ id, currency, amount, formatted, isDefault, reason, requestedCurrency }`), or `null` for a plan with no flat price | Render `plan.price.formatted`. For `null`, show "Free" when `plan.isFree` and your usage wording otherwise. |
| `plan.amount`, `plan.currency` on a plan | The plan's one price | Gone from the public plan and from the operator's plan | Read `price` and `prices`. |
| `price.requestedCurrency` | Not present | With `reason: 'fallback'`, the currency selected for the buyer that no provider can charge. `null` for every other reason | Use it to tell the buyer which currency is not available, before checkout. |
| A free plan | `plan.amount === 0` | `plan.isFree` | Replace the comparison. A usage plan with no base fee has no price and is not free. |
| `plan.prices` | Not present | Every price the plan sells at, the default first: `{ id, currency, amount, countries, isDefault, archived }` | Use it to show what exists, never to choose. |
| `billing.createCheckout` input | No `currency`, no `onUnavailableCurrency` | Adds `currency` and `onUnavailableCurrency` | Optional. Pass `currency` from your server to name the price. |
| `CheckoutResultDto.price`, `priceFallback` | Not present | Always present. `price` is the price charged (null for a plan with no flat price). `priceFallback` is null, or says the default price is charged because the selected one could not be | When `priceFallback` is set, tell the buyer before you redirect them. `priceFallbackMessage(checkout.priceFallback)` writes the sentence. |
| `CheckoutResultDto.currency`, `unitAmount` | Not present | Always present | Nothing to change. Read them without a fallback. |
| `CheckoutResultDto.warnings`, `mode`, `checkoutSessionId` | Optional | Always present | Remove the `?? []` and `?.` you wrote for the optional form. |
| `billing.validateCoupon` input | `{ code, planSlug }` | Adds `country`, `currency`, `onUnavailableCurrency`, `provider`, `organizationId` | Send the same values the checkout will send, so the quote is at the price charged. |
| `ValidateCouponResultDto.plan` | `{ slug, name, amount, currency }` | `{ slug, name }` | Read the price from `price`, `currency` and `amount` on the result. |
| `ValidateCouponResultDto.coupon` | `{ code, discountType, amountOff, currency }` | `{ code, discountType, basisPoints }` | A percentage is `basisPoints`. A fixed amount is the result's `discountAmount`. |
| `ValidateCouponResultDto` | `discountAmount`, `amountAfterDiscount` | Adds `price`, `priceFallback`, `currency`, `amount`, `formatted: { discount, total }` | Render `formatted.discount` and `formatted.total`. |
| `billing.getProviders` | `getProviders(country?)` | `getProviders(country?, { planSlug? })` | Optional. Pass `planSlug` when the picker is for one plan. |
| `ProvidersListDto.countrySource`, `routedProvider` | Not present | Always present, each nullable | Preselect `routedProvider` in a picker. |
| `BillingProviderInfoDto.currencies` | Not present | Always present. The currencies the account charges. **Empty means none** | If you read an empty or missing list as "any", change it: empty is none. |
| `BillingProviderCapabilities.checkout` | Optional, absent meant it can | Required boolean | Remove the default you applied when it was absent. |
| A subscription from `getSubscription` | No price | `price: { id, currency, amount, formatted } \| null`, what this subscriber pays | Show `subscription.price.formatted` in place of the plan's price. |
| `TenantPaymentDto.refundedAmount` | Not present | Always present, `0` when nothing was refunded | Net paid is `amount - refundedAmount`. |
| `TenantPaymentDto.verification` | Not present | `verified` or `unverified`, on the operator payment list and on the super-admin payment list (which also gains `refundedAmount` and the `PARTIALLY_REFUNDED` status filter) | Do not count an `unverified` payment as revenue. |
| `TenantPaymentDto.provider`, `refundable`, `refundBlockedReason` | Not present | Always present, on a payment list row and on `payments.get`. `provider` is nullable; `refundBlockedReason` is null exactly when `refundable` is true | A fixture or mock of `TenantPaymentDto` needs the three fields. Disable a refund control when `refundable` is false. |
| `operator.payments.get(paymentId)` | Not present | One payment by id | New. Read it before a refund to learn whether one is possible. |
| `GET /api/v1/checkout-sessions/:token` `order.priceFallback` | Not present | The price fallback recorded when the checkout was opened, or `null` | A checkout page shows it before the buyer pays. |
| `credits.granted` billing event `data.source` | `purchase`, `refill`, `operator`, `plan` | Adds `api_key`, for a grant made with an Application secret key | Handle the new value where you switch on `source`. |
| Operator access | None in this package | `RekeyOperator` with an `rp_op_` token: `plans.prices`, `coupons`, `payments.refunds`, `billingLog`, `billing` | New. Use it in place of hand-written calls to `/api/v1/tenant/...` billing routes. |
| Money helpers | None | `formatMoney`, `minorUnitExponent`, `validatePriceAmount`, `sellableCurrencies`, `isSellableCurrency`, `priceFallbackMessage`, `refundBlockedMessage`, `REFUND_BLOCKED_REASONS`, `BILLING_MONEY_ERROR_CODES`, `isBillingMoneyError` | New. Replace your own formatting with `formatMoney`. |
| The `x-country` header | Sent by `createCheckout` and `getProviders` | Never sent. The country travels in `country` or in the client's `visitorCountryHint` | Nothing, once you are on this version. Remove the header from any request you build by hand. |

```ts
import { formatMoney, priceFallbackMessage } from '@rekey.dev/node';

export async function pricingAndCheckout(userAccessToken: string, country: string) {
  // Before: `${plan.amount / 100} ${plan.currency}` for every plan.
  const { items } = await rekey.billing.getPlans(undefined, { country, accessToken: userAccessToken });
  const labels = items.map((plan) => plan.price?.formatted ?? (plan.isFree ? 'Free' : 'Usage based'));

  // Before: `const { url } = await createCheckout(...)`, then redirect.
  const checkout = await rekey.billing.createCheckout(userAccessToken, { planSlug: 'pro', country, successUrl, cancelUrl });
  const notice = checkout.priceFallback ? priceFallbackMessage(checkout.priceFallback) : null;

  // An amount you hold yourself, such as a payment row.
  const example = formatMoney(149900, 'INR'); // '₹1,499.00'
  return { labels, url: checkout.url, notice, example };
}
```

## `@rekey.dev/react`

| What | Before | Now | What to change |
|---|---|---|---|
| `PricingPlan` | `id`, `slug`, `name`, `amount`, `currency`, and optional fields | `id`, `slug`, `name`, `price`, `prices`, `isFree`, `checkout`, and the same optional fields. No `amount`, no `currency` | Pass the `items` of `getPlans()` as they are. A plan built by hand supplies `price: { currency, amount, formatted }`, `prices: [{ currency, amount }]`, `isFree` and `checkout: { ready: true }`. |
| `<PricingTable currency>` | Not in 2.2.0-rc.6. Present on builds between the two releases | Removed | Fetch the plans for the buyer (`country`, access token) and the table shows that price. |
| `<PricingTable priceFallbackNote>` | Not present | What a card says when its `price.reason` is `fallback` | Optional. The default names the price. |
| `<PricingTable unavailableLabel>` | Not present | What a paid plan shows in place of its button when `checkout.ready` is false. Default "Not available right now" | Optional. |
| How the table writes a price | Divided `amount` by 100 and prefixed a symbol | Renders `price.formatted` | Nothing, once `plans` carries `price`. |
| `<PriceFallbackNotice>`, `<CouponQuote>` | Not present | New components | Show the first before a checkout that fell back, and the second for a coupon quote. |
| `ProviderOption.currencies` | Not present | The account's currencies. **Empty means none.** Left out means not judged, and the provider is treated as able to charge | Pass providers as `getProviders()` returned them. Do not pass `[]` to mean "any". |
| `client.getPlans` | `getPlans(page?)` | `getPlans(page?, { accessToken? })` | Pass the token for a signed-in buyer. |
| `client.validateCoupon` | Not present | `validateCoupon(accessToken, input)` | New. |
| `client.listBillingProviders` | `{ country? }`, sent as the `x-country` header | `{ country?, planSlug? }`, sent as `?country=` | Nothing in your code. |
| `PortalPaymentDto.refundedAmount` | Optional | Always present, `0` when nothing was refunded | Remove the `?? 0`. |
| Money helpers | None | `formatMoney`, `minorUnitExponent`, `validatePriceAmount`, `sellableCurrencies`, `priceFallbackMessage` | New. |

## `@rekey.dev/nextjs` and `@rekey.dev/astro`

| What | Before | Now | What to change |
|---|---|---|---|
| A pricing page | Called `rekey.billing.getPlans()` | Call it through the client scoped with the visitor's country hint, with the session's access token | Next.js: `rekey.with({ visitorCountryHint: await visitorCountryHint() })`. Astro: `visitorClient(context)`. Both are in the package READMEs. |
| A checkout action | Redirected to `url` | Check `priceFallback` first | Show the notice, then redirect. |
| `visitorCountryHint()` (Next.js) | Not present | The visitor's country from your platform's geo header, as a hint | Scope your client with it for plans, providers, coupon quotes and checkout alike, so all four are priced the same way. |
| `visitorClient(context)` (Astro) | Carried the visitor's address and User-Agent | Also carries the country hint | Make billing calls through it. |

## `@rekey.dev/shared-types`

| What | Before | Now | What to change |
|---|---|---|---|
| `PlanDtoSchema` | One schema for both readers | `PlanDtoSchema` (operator) and a strict `PublicPlanDtoSchema` (pricing page) | Parse a `GET /billing/plans` row with `PublicPlanDtoSchema`. It refuses a field it does not list. |
| `PlanDto` | `amount`, `currency`, `pricePerUnitCents`, `metadata` | `amount`, `currency` and `pricePerUnitCents` are removed. Adds `price`, `prices` (with `registration`), `defaultPriceId`, `isFree`, `localPrices`, `registrationStatus`, `registrationError`, `trialDays` | Read the default price from `price`, or through `defaultPriceId` and `prices`. |
| `PlanPriceDto` (an entry of an operator plan's `prices`) | Not present | `id`, `currency`, `amount`, `countries`, `isDefault`, `archived`, `registration`, and `amountEditable`, `liveSubscriptions`, `openCheckouts`. The public price (`PublicPlanPriceDto`) has none of the last four | Disable an amount edit when `amountEditable` is false, and a removal when either count is above 0. |
| `CreatePlanRequestSchema`, `UpdatePlanRequestSchema`, `PlanPriceInputSchema` | Not present | The bodies of the operator plan routes, with `price: { currency, amount }` | Use them to type a plan you create or change. |
| `EndUserExportSubscription.plan` | `slug`, `name`, `kind`, `amount`, `currency`, `interval` | `slug`, `name`, `kind`, `interval`. The export's `exportVersion` is 2 | Read what the subscriber pays from the subscription's own `price`. |
| `CouponDto` | `amountOff`, `currency` | `basisPoints`, `amounts[]`, `currencies[]`, `coveredCurrencies` | See [Coupons](#coupons). |
| `CouponWithStatsDto` | `redemptionCount`, `totalDiscountIssued` | `redemptionCount`, `discountIssuedByCurrency: { currency, amount, redemptions }[]`. No total | Sum nothing across currencies. Show one row per currency. |
| `BillingStatsDto` | Scalars, see [Stats](#stats-and-the-reporting-currency) | One entry per currency | See below. |
| `BillingConfig.currency` | The Application's default currency | `BillingConfig.reportingCurrency` | Rename the field where you read it. |
| `BillingConfig.onUnavailableCurrency` | Not present | `'fallback'` or `'refuse'`, always present: the Application's default for a checkout that names a `currency` nobody can charge | A fixture or mock of `BillingConfig` needs the field. |
| `RoutingPreviewDto.onUnavailableCurrency` | Not present | `'fallback'` or `'refuse'`, always present: the rule the preview applied | A fixture or mock of `RoutingPreviewDto` needs the field. |
| `BILLING_EVENT_TYPES`, `BillingLogEntry` | The event types of builds between the two releases | Adds `settings.unavailable_currency_changed`, with `data: { before, after }` | A `switch` over every event type needs the new case. |
| `BillingLogPage.actors` | Not present | Always present: null, or with `include=actors` the end users and operators the page's entries name (`BillingLogActors`) | A fixture or mock of `BillingLogPage` needs `actors: null`. |
| New exports | | The currency registry, `BILLING_MONEY_ERROR_CODES`, the refund, billing log, reporting and routing preview schemas, `PaymentWebhookData`, `SubscriptionWebhookData` | Listed in the package README. |

## Endpoints

| Route | Before | Now | What to change |
|---|---|---|---|
| `GET /api/v1/billing/plans` | No query beyond paging | `?country=` from a server caller. The user JWT is read when present | Optional. |
| `POST /api/v1/billing/checkout` | See the SDK table | `currency` and `onUnavailableCurrency` in the body. `price` and `priceFallback` in the response | As the SDK table says. |
| `POST /api/v1/billing/coupons/validate` | `{ code, planSlug }` | Also `country`, `currency`, `onUnavailableCurrency`, `provider`, `organizationId` | As the SDK table says. |
| `GET /api/v1/billing/providers` | Country in `x-country` | `?country=` and `?planSlug=` | Send the country as a query parameter. |
| `POST /api/v1/tenant/applications/:id/plans`, `POST /api/v1/admin/applications/:id/plans` | `{ slug, name, amount, currency?, ... }`, and `pricePerUnitCents` required for a USAGE plan | `{ slug, name, price?: { currency, amount }, ... }`. `price` left out is a plan with no flat price. A USAGE plan needs `meterSlug` only. `amount`, `currency` or `pricePerUnitCents` at the top level is refused with `BILLING_FIELD_REMOVED` (400) | Move the pair into `price`, name the currency (there is no USD default), drop `amount: 0` for a free plan, and remove `pricePerUnitCents`. |
| `PATCH /api/v1/tenant/applications/:id/plans/:slug`, `PATCH /api/v1/admin/applications/:id/plans/:slug` | `amount?`, `currency?`, each on its own | `price?: { currency, amount } \| null`, both fields together. `null` makes the plan free. The old fields are refused with `BILLING_FIELD_REMOVED` (400) | Send the whole price. `amount: 0` becomes `price: null`. |
| The same two `PATCH` routes | No way to change a plan's `localPrices` | `localPrices: 'INHERIT' \| 'TRUSTED' \| 'OFF'`, at any time. A change is logged as `plan.local_prices_changed` | New. |
| A plan in an operator response (`GET`, `POST`, `PATCH .../plans`, the operator MCP plan tools) | Carried `amount`, `currency`, `pricePerUnitCents` | Carries none of them. `price`, `prices[]`, `defaultPriceId` and `isFree` say what it costs | Read `price` (null for a plan with no flat price). |
| `GET /api/v1/tenant/applications/:id/end-users/:euid/billing`, `GET .../end-users/:euid/export` | `subscriptions[].plan` carried `amount` and `currency`, the plan's default price | `subscriptions[].plan` is `{ slug, name, kind, interval }` | Read what the subscriber pays from `subscriptions[].price`, null for a subscription with no price of its own. |
| `PUT`, `DELETE /api/v1/tenant/applications/:id/plans/:planId/prices/:currency` | Not present | Set a price in a currency, or take it off sale | New. |
| `GET`, `PATCH /api/v1/tenant/applications/:id/coupons/:code` | `PATCH` changed `active` | `GET` reads one coupon. `PATCH` changes `active`, `basisPoints`, `amounts`, `currencies`, `planSlugs`, `endsAt`, `maxRedemptions`, `maxRedemptionsPerUser` | New fields. See [Coupons](#coupons) for the caps. |
| `GET`, `POST /api/v1/tenant/applications/:id/payments/:paymentId/refunds` | Not present. A refund was possible only from an unapplied case | List a payment's refunds, and refund any recorded payment in full or in part | New. |
| `GET /api/v1/tenant/applications/:id/payments/:paymentId` | Not present | One payment, with `provider`, `refundable` and `refundBlockedReason`. `GET .../payments` rows carry the same three fields | New. A strict parser of a payment row needs the three fields. |
| `POST /api/v1/tenant/applications/:id/payments/:paymentId/refunds` refusals | Checked in this order: status, charge id, nothing left, `amount` above what is left, provider unknown, provider credentials, provider cannot refund. A provider name Rekey has no module for answered 500 | The payment is judged first (status, charge id, nothing left, provider unknown, provider cannot refund, provider not configured), then `amount`. A provider with no module answers `BILLING_REFUND_UNSUPPORTED` (409). The codes are unchanged | Nothing, unless you depend on which of two refusals a request gets. |
| `GET /api/v1/tenant/applications/:id/billing/events`, `.../billing/subscriptions/:id/events`, `.../billing/payments/:id/events`, `.../end-users/:id/billing-events` | Not present | The billing log and its three trails | New. |
| `GET .../billing/price-fallbacks`, `GET .../billing/reconciliation` | Not present | Fallback counts and the reconciliation report | New. |
| `GET`, `PUT .../billing/reporting-currency` | Not present | Read and set the reporting currency | New. |
| `POST .../billing/checkout/preview` | Not present | The routing preview. Its response carries `onUnavailableCurrency`, the rule it applied | New. |
| `PATCH .../billing-config` | `enabled`, `dunningEnabled`, `billingSubject`, `trialPolicy`, `localPrices`, `defaultPlanSlug` | Also takes `onUnavailableCurrency: 'fallback' \| 'refuse'`. A change to it or to `localPrices` is written to the billing log (`settings.unavailable_currency_changed`, `settings.local_prices_changed`) | Set it if you want a named currency nobody can charge refused by default. |
| `GET /api/v1/tenant/applications`, `GET .../applications/:id` | `billingConfig` as stored: a setting never saved was missing | `billingConfig` complete: every setting present, at its default when never saved | Stop guarding `localPrices`, `reportingCurrency` and `onUnavailableCurrency` against `undefined`. |
| `POST /api/v1/billing/checkout`, `POST /api/v1/billing/coupons/validate` | A named `currency` nobody can charge fell back unless the request passed `onUnavailableCurrency: 'refuse'` | Without `onUnavailableCurrency` on the request, the Application's `billingConfig.onUnavailableCurrency` decides. It is `fallback` until an operator changes it, so nothing changes until then | Pass `onUnavailableCurrency` on the request when your code depends on one outcome. |
| `GET .../billing/stats` | Scalars | Per currency, and `unpricedLiveSubscriptions`: the live subscriptions on a plan with a flat price that record no price of their own | See [Stats](#stats-and-the-reporting-currency). A fixture or mock of `BillingStatsDto` needs the new field. |
| `GET .../billing/providers`, `PUT`/`PATCH .../billing-credentials/:provider` | `currencies` not present | Each provider lists `supportedCurrencies` and `preselectedCurrencies`. An account's `currencies` must come from that list, and empty means none | Choose each account's currencies. See [Provider currencies](#provider-currencies). |
| `GET /api/v1/admin/metrics/...` | Scalars, `sort=mrrCents` | Per currency, `sort=mrr` | See [Stats](#stats-and-the-reporting-currency). |
| `GET /api/v1/admin/metrics/billing-outbox` | Not present | What is waiting to reach the billing log | New. |

## Headers

| Header | Before | Now | What to change |
|---|---|---|---|
| `x-country` | Read as the buyer's country | Refused with `BILLING_FIELD_REMOVED` (400) on plans, providers, checkout, coupon validate and trial eligibility | Send `country` in the body of a POST, or `?country=` on a GET. |
| `x-rekey-visitor-country-hint` | Not present | Set by the SDK from the client's `visitorCountryHint`. Read from a secret-key caller only, as a hint | Set `visitorCountryHint` on your client. Do not write the header yourself. |

## Coupons

| What | Before | Now | What to change |
|---|---|---|---|
| A percentage coupon | `discountType: "PERCENT"`, `amountOff: 1500` (basis points) | `discountType: "PERCENT"`, `basisPoints: 1500`, optionally `currencies: ["USD"]` | Rename `amountOff` to `basisPoints`. |
| A fixed-amount coupon | `discountType: "AMOUNT"`, `amountOff: 500`, `currency: "USD"` | `discountType: "AMOUNT"`, `amounts: [{ "currency": "USD", "amountOff": 500 }]` | Move the pair into `amounts`, and add one entry for each other currency the coupon should work in. |
| `amountOff` or `currency` at the top level of a create or update body | Accepted | Refused with `BILLING_FIELD_REMOVED` (400) | Send the new shape. |
| Where a coupon works | Any plan in its currency | `coveredCurrencies`: a list, or `null` for any | A fixed-amount coupon works only in the currencies it has an amount for. Existing coupons were given one amount, in their old currency. |
| A coupon in the wrong currency | `COUPON_CURRENCY_MISMATCH` at checkout | `COUPON_CURRENCY_NOT_COVERED` at the quote and at checkout | Handle the new code. Show its `message` and let the buyer continue without the code. |
| Percentage rounding | Rounded down | Rounded up to the next chargeable step, toward the buyer, in every currency | 15% of $19.99 now takes $3.00, not $2.99. Update any figure you compute yourself, or read the quote. |
| Coupon stats | `totalDiscountIssued` | `discountIssuedByCurrency` | One row per currency. |
| A coupon's end date and caps | Fixed once the coupon was created | `PATCH .../coupons/:code` takes `endsAt`, `maxRedemptions` and `maxRedemptionsPerUser`, each a value or `null` to remove it. A cap below the redemptions already held is refused with `COUPON_LIMIT_BELOW_REDEEMED` (409) | New. Handle the refusal: `details.redeemed` is the lowest cap accepted. |
| `coupon.changed` and `coupon.created` billing events | Terms were `active`, `basisPoints`, `amounts`, `currencies`, `planSlugs` | New entries also carry `endsAt`, `maxRedemptions` and `maxRedemptionsPerUser` in each set of terms. Entries already written do not | Read the three as optional. A strict parser of a stored event needs the new keys allowed. |

## Error codes

| Code | Before | Now | What to change |
|---|---|---|---|
| `COUPON_CURRENCY_MISMATCH` | Checkout with a fixed coupon in another currency | Gone | Handle `COUPON_CURRENCY_NOT_COVERED`. |
| `COUPON_CURRENCY_REQUIRED` | A fixed coupon created with no currency | Gone | Handle `COUPON_AMOUNTS_REQUIRED`. |
| `COUPON_CURRENCY_NOT_COVERED`, `COUPON_AMOUNTS_REQUIRED`, `COUPON_CURRENCY_INVALID`, `COUPON_DISCOUNT_SHAPE_INVALID`, `COUPON_LIMIT_BELOW_REDEEMED` | Not present | New | See [errors.md](errors.md#coupons). |
| `BILLING_DISCOUNT_UNSUPPORTED` | `message` named the payment provider | `message` is written for a buyer and names no provider ("A coupon code cannot be used on a recurring subscription here."). The provider and the flow are in `details: { provider, flow }` | Show `message` to a buyer as it is. Read the provider from `details.provider`, not from the message. |
| `BILLING_FIELD_REMOVED` | Not present | A removed plan field (`amount`, `currency`, `pricePerUnitCents`), a removed coupon field, or the `x-country` header | Fix the request as its `fix` says. |
| `BILLING_NO_PROVIDER_FOR_CURRENCY` | Not in 2.2.0-rc.6. On builds between the two releases, raised whenever no provider could charge the plan's currency | Raised only when there is nothing to fall back to, or when the rule for a `currency` you named is `refuse`: you passed `onUnavailableCurrency: 'refuse'`, or passed nothing and the Application's default is `refuse` | Where no provider can charge the selected price, expect a `priceFallback` on the result, not this error. If an operator may set the Application default to `refuse`, handle this error on every checkout that names a `currency`, or pass `onUnavailableCurrency: 'fallback'` to keep the fallback. |
| `BILLING_CURRENCY_CONFLICT`, `BILLING_CURRENCY_NOT_ALLOWED`, `BILLING_PLAN_CURRENCY_UNAVAILABLE`, the `PLAN_PRICE_*` codes, the refund codes, `BILLING_REPORTING_CURRENCY_INVALID`, `BILLING_PROVIDER_CURRENCY_NOT_OFFERED`, `BILLING_LOG_PERIOD_INVALID` | Not present | New | The full list is `BILLING_MONEY_ERROR_CODES`. Each has an entry in [errors.md](errors.md#billing-money-model). |

## Webhook payloads

| Event | Before | Now | What to change |
|---|---|---|---|
| `payment.refunded` | Not sent | Sent once for each refund recorded, with `data.payment` and `data.refund` | Subscribe to it if you act on refunds. An endpoint subscribed to `*` receives it without a change. |
| `payment.succeeded`, `payment.failed` | `data.payment` with ids, plan slug, amount, currency, status | Adds `refundedAmount` and `verification` | **Do not provision on a `payment.succeeded` whose `verification` is `unverified`.** That is a charge Rekey recorded and did not apply. |
| `subscription.*` `amount`, `currency` | The plan's price | The subscription's own price: what this subscriber pays | If you compared them with the plan's price, stop. A subscriber on a local price reports that price. |
| `subscription.*` `currency` | Always a string | `null`, with `amount: 0`, for a subscription with no price of its own | Handle `null`. Do not substitute a default currency. |

The full shapes are in [webhooks.md](webhooks.md#billing).

## Stats and the reporting currency

Money is reported per currency and never added across currencies. Every scalar
that held "the" figure is removed.

| What | Before | Now | What to change |
|---|---|---|---|
| `BillingStats.mrrCents`, `mrrCurrency`, `mixedCurrencies` | One figure in the dominant currency, and a flag | `mrr: { currency, mrrCents, activeSubscriptions }[]` | Render one row per currency. |
| `BillingStats.revenueLast30dCents` | One figure | `revenueLast30d: { currency, grossCents, refundedCents, netCents, payments }[]` | The same. Revenue counts verified payments only. |
| `BillingStats.revenueCurrency`, `revenueCurrencies`, `revenueLast30dByCurrency` | Not in 2.2.0-rc.6. Present on builds between the two releases | Removed | Read `revenueLast30d`. |
| `BillingStats.monthlyRevenue` | One series | One series per currency: `{ currency, months }[]` | Chart one line per currency. |
| `BillingStats.reportingCurrency`, `unverified` | Not present | The Application's reporting currency, and money recorded but not applied | New. `unverified` is in no revenue figure. |
| `billingConfig.currency` | The Application's default currency | `billingConfig.reportingCurrency`, set with `PUT .../billing/reporting-currency` | Rename. Stored values were carried over. |
| Super-admin overview and tenant rows | `mrrCents`, `mrrCurrency`, `mixedCurrencies`, `mrrCapped` | One entry per currency | Read the per-currency list. |
| Super-admin overview payment volumes | Scalar volumes | In `byCurrency` only, with `unverified` beside it | Read `byCurrency`. |
| Super-admin payments by Application | `volumeCents`, `volumeCurrency`, `mixedCurrencies` | Per currency | Read the per-currency list. |
| Super-admin tenant list sort | `sort=mrrCents` | `sort=mrr`, in one named currency | Change the query value. |

Nothing is converted. A local price may be a purchasing-power price, so a rate
would present a guess as a figure. See
[currencies.md](currencies.md#the-reporting-currency).

## Provider currencies

Each provider account now has a list of the currencies it charges, chosen from
the list the provider publishes. **An empty list means none.**

- The API reads an empty list as none from this release: routing, the plan
  catalogue, the routing preview, checkout readiness and `rekey doctor` all
  agree. An enabled provider with an empty list is sent no checkout.
- The migration leaves no existing account empty, so no provider that takes
  payments today stops taking them. A Stripe account gets every currency
  Stripe lists. A PayPal account gets PayPal's cross-border currencies and a
  Razorpay account gets INR, each plus every currency that Application has
  already sold in on that provider. The external provider, and any provider
  module of your own, gets every currency a price may be in: what its empty
  list meant before. Check each list after you deploy: Panel → Application →
  Billing → Setup → Providers.
- A provider saved for the first time without `currencies` (REST `PUT
  .../billing-credentials/:provider`, the MCP `configure_billing_provider`
  tool) is stored with the provider's `preselectedCurrencies`, not an empty
  list. A later save without `currencies` keeps the stored list. `currencies:
  []` is stored as sent and means none.
- `preselectedCurrencies` is never empty. Stripe and the external provider
  returned `[]` on builds between the two releases; they now return their
  whole supported list. A provider module of your own must preselect at least
  one currency.
- While this release rolls out, an API instance still on the previous build
  can save a provider with an empty list. The new API sends it no checkout.
  Checkout readiness and `rekey doctor` name any enabled provider with no
  currency: run `rekey doctor` once the rollout is done.
- A code outside the provider's list is refused on save with
  `BILLING_PROVIDER_CURRENCY_NOT_OFFERED`.
- A price whose currency no enabled provider lists is not sold at: the buyer
  is charged the default price and the fallback is logged. `rekey doctor`
  reports such a price.

## CLI

All of these are new in `@rekey.dev/cli` 2.2.0-rc.7 and take an operator token
(`REKEY_OPERATOR_TOKEN`).

| Command | What it does |
|---|---|
| `rekey plans prices list <plan> --app <id>` | Every price of a plan. |
| `rekey plans prices add <plan> <currency> <amount> --app <id> [--countries IN,NP]` | Add a price. |
| `rekey plans prices update <plan> <currency> --app <id> [--amount <n>] [--countries IN,NP]` | Change one. |
| `rekey plans prices archive <plan> <currency> --app <id>` | Take one off sale. |
| `rekey coupons list\|show\|create\|update` | Coupons, with `--percent`, `--basis-points` or one `--amount CUR=n` per currency. `update` also takes `--ends-at`, `--max-redemptions` and `--max-redemptions-per-user`, each a value or `none` to remove it. |
| `rekey billing log --app <id>` | The billing log, with filters and `--all`. `--include actors` adds who the end users and operators named are; `--json` then prints `{ items, nextCursor, actors }`, and `actors` is null without it. |
| `rekey billing preview --app <id> --country IN` | The routing preview. With `--currency`, its first line says which rule a currency nobody can charge got, and whether it came from `--on-unavailable-currency` or the Application default. |
| `rekey billing reporting-currency get\|set` | The reporting currency. |
| `rekey billing reconciliation`, `rekey billing price-fallbacks` | The two reports over the log. |
| `rekey payments show <paymentId> --app <id>` | One payment, and whether it can be refunded through Rekey, with the reason when it cannot. |
| `rekey refunds list\|create <paymentId> --app <id>` | A payment's refunds. |
| `rekey doctor [--app <id>]` | Now also checks each Application's money setup. A `skipped` check did not run. `unpriced-subscriptions` is one check per Application, read from the billing stats: `ok` at zero, `warn` with the count otherwise. `provider-currencies` also warns for an enabled provider with no currency. |

| What | Before | Now | What to change |
|---|---|---|---|
| `rekey plans prices set`, `rekey plans prices remove` | Not in 2.2.0-rc.6. Present on builds between the two releases | `add` and `update`, and `archive` | Rename in any script written against those builds. |
| `rekey plans list` output | Printed the integer amount and the currency code | Prints money for a person through `formatMoney`, such as `$19.00`. `--json` carries the integer and the currency code | Parse `--json`, not the text. |
| `rekey plans create` | Sent `amount` and `currency` | Sends `price: { currency, amount }`, and no price for `--amount 0`. The flags are unchanged | Nothing, but it needs an API on 2.2.0-rc.7: an older API refuses the body. |
| `rekey plans local-prices <slug> <inherit\|trusted\|off> --app <id>` | Not present | Sets a plan's local prices rule, with an operator token | New. |

## MCP

Operator MCP server (`/api/v1/tenant/mcp`):

| Tool | Before | Now |
|---|---|---|
| `get_billing_stats`, `get_reporting_currency`, `preview_checkout_routing`, `list_price_fallbacks`, `get_billing_reconciliation`, `get_payment`, `list_payment_refunds`, `list_coupons`, `recent_billing_events` | Not present | New read tools, under `billing:read` |
| `set_plan_price`, `remove_plan_price`, `create_coupon`, `update_coupon`, `set_reporting_currency` | Not present | New write tools |
| `create_refund` | Refunds were not exposed | New admin tool. It pays money out and cannot be undone |
| `update_plan` | Name, licence seats and duration, credit amount | Also `localPrices` (`INHERIT`, `TRUSTED`, `OFF`) |
| `get_workspace_overview` | `mrrMinor` at the top level, a sum, beside `currencies` | `currencies` only, one entry per currency. No single total |
| Rows of `recent_subscriptions` and `get_end_user` | A currency for every subscription | A null currency for a subscription with no price of its own |

`@rekey.dev/mcp`, the local admin server, gains `get_billing_outbox_status` and, with an operator token, `get_payment`.

## What the database still holds

The database columns behind the removed plan fields (`amount`, `currency`,
`price_per_unit_cents`) are still written, because the units of a deployment
are upgraded one after another and the previous build must keep working beside
the new one. No route reads or returns them, and they are dropped in the next
release.

## Deploying

Rekey is several units deployed separately, and the API runs its migrations
when it starts. Deploy in this order:

1. **Run the preflight** against production (next section) and resolve what it
   reports.
2. **Take a database snapshot.**
3. **Deploy the API.** Its migrations add the new columns and tables and copy
   existing data into them. They drop nothing.
4. **Deploy the panel, then the portal, the admin dashboard and the marketing
   site.**
5. **Ship your own apps on the 2.2.0-rc.7 SDKs.**

**Rolling back.** Until the next release, the old columns still exist and are
still written, so rolling back is redeploying the previous images. The next
release drops those columns. After that, rolling back means restoring the
snapshot.

The constraints that hold the new shape in place (a subscription's price being
all set or all null, a subscription's price belonging to its own plan) do not
run on this deploy. They ship as a later migration, once every unit runs the
new code, because a write from a unit still on the previous build would
otherwise make that migration fail and stop the API from starting.

## Production preflight

`docs/specs/billing-money-model.preflight.sql` is a set of read-only queries.
Run it against production with a read-only role before you deploy the API. It
writes nothing.

```bash
psql "$READ_ONLY_DATABASE_URL" -f docs/specs/billing-money-model.preflight.sql
```

What each query means, and what a non-empty result requires:

| Query | What it lists | If it returns rows |
|---|---|---|
| 1 | Provider-billed subscriptions with no price of their own | Expected: none. Each row is a subscriber whose renewals are checked against the plan's price. Price them before the fallback to the plan's price is removed. |
| 2 | Every other unpriced subscription on a plan that costs money: granted, hand-provisioned, imported | Nothing to do. They take the plan's default price. Read the counts so the result does not surprise you. |
| 3 | Every row holding money in HUF, TWD, ISK, UGX or MGA | **The first migration refuses to run.** See [the next section](#when-you-hold-money-in-huf-twd-isk-ugx-or-mga). |
| 3b | Plans priced in a three-decimal currency (BHD, IQD, JOD, KWD, LYD, OMR, TND) | This release does not sell in those. Re-price or retire each plan. |
| 4 | Usage plans at amount 0 | Nothing to do. Their per-unit figure was the only thing that made them "not free". They are marked not free explicitly. Check the list is what you expect. |
| 5 | A count of payments with no subscription, and of payments whose currency differs from their subscription's plan | The first stay unlinked. The second cannot be attached to a price automatically. Review them. |
| 6 | Every stored provider registration, per plan and price | **Save this output.** Registrations move from the plan to its default price. Compare the registrations after the deploy with what you saved: the provider ids must be the same. |
| 7 | Fixed-amount coupons and the plans they are scoped to | A coupon whose plans are sold in a currency it has no amount in will refuse buyers on that price. After the deploy, add an amount for each such currency. |
| 8 | Provider accounts with an empty currency list, which used to mean "any" | They are given a list by the migration. Check each afterwards. |
| 9 | Provider events of the last 90 days that named no currency, by provider | Tells you how often a charge that names no currency arrives. Such a charge takes the subscription's currency. |
| 10 | Currencies that are not three letters, on any money row | The migrations copy none of them: such a plan gets no default price, such a coupon no amount, such a subscription no price link. Correct each by hand. The constraints of the later step cannot be added until this query returns nothing. |
| 11 | Price rows the default-price migration will change: stored in another letter case, in the plan's own currency at another amount, or filed under another Application | Read them so you know what changes. A row in another case is upper-cased. One in the plan's own currency at another amount is archived, and the plan's amount becomes the default. One under another Application is moved to its plan's. |
| 12 | Subscriptions whose price belongs to another plan | Expected: none. Correct any row before the later step that ties a subscription's price to its plan. |

### When you hold money in HUF, TWD, ISK, UGX or MGA

If query 3 returns any row, the first migration (`money_v2_01`) stops before it
changes anything, and the API does not start. Its message names the tables and
how many rows each holds.

**Why.** This release changes how a stored amount in these five currencies is
sent to a provider:

| Currency | Provider | A stored amount was sent as | It is now sent as |
|---|---|---|---|
| HUF, TWD | PayPal | The stored number: `5000` went out as "5000" | Whole units: `5000` goes out as "50" |
| ISK, UGX | Stripe | The stored number | The stored number multiplied by 100 |
| MGA | Stripe | The stored number | The stored number divided by 100 |

So the same stored number would mean a different amount of money at the
provider after the upgrade. A price of 5,000 Ft stored as `5000` and sold
through PayPal would be charged as 50 Ft. Nothing can rescale these rows
automatically, because what a stored number meant depends on which provider it
was written for, and that is not recorded on every row.

**What to do.** The preflight file and the migration give two choices for each
row that query 3 lists:

1. **Rescale it by hand**, against the provider that query names in its
   `provider` column, so that the stored number means the same amount of money
   under the new rule.
2. **Remove it**, if it is not real money: a test plan, or a price nobody
   bought.

Query 3 lists rows from `plans`, `plan_prices`, `subscriptions`, `payments`,
`checkout_sessions` and `coupons`. Every one has to be rescaled or removed
before the migration will run.

Then tell Prisma the stopped migration did not apply, and deploy again:

```bash
pnpm exec prisma migrate resolve --rolled-back 20261011100001_money_v2_01_plan_default_price
```

The files describe no procedure beyond this, and this page does not add one.
What the right new number is for a row depends on the provider and on what the
buyer was really charged, so check each against the provider's own record of
the price or the charge before you change it. If you have many such rows, or
live subscribers among them, stop and plan the change before you deploy.
