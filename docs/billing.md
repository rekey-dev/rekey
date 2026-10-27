# Billing

The billing surface in Rekey is intentionally provider-agnostic. Stripe, PayPal, and Razorpay all sit behind one `BillingProvider` interface; an Application picks one in its `billingConfig.provider`.

> **Status (today)**: all three providers are real — `RealStripeProvider` (stripe SDK), `RealPaypalProvider` (REST), `RealRazorpayProvider` (razorpay SDK). Inbound webhook ingestion is live for all three (signature-verified, with a durable `WebhookEvent` idempotency table) and drives the subscription state machine end-to-end. There are no stub providers: every provider talks to the real processor, and an Application with no credentials configured gets `BILLING_CREDENTIALS_NOT_CONFIGURED` in every environment, dev included. An Application's `environment` does not restrict which credentials it may hold; the recorded `mode` is read from the key where the provider's key format states it. See [api-keys.md → Environments](api-keys.md#environments).

> **How strong that constraint is, honestly.** The stored `mode` is read from the key material wherever the key states it: Stripe (`sk_live_` / `sk_test_`) and Razorpay (`rzp_live_` / `rzp_test_`). For those two, mislabelling is refused (`BILLING_CREDENTIALS_MODE_CONTRADICTED`), so the recorded mode is never a lie about what the key will actually do. Note this is a truthfulness guarantee, not a restriction: a live Stripe key may be stored against a development Application — it will simply be recorded, correctly, as `live`.
>
> **PayPal warning.** A PayPal sandbox client id is byte-indistinguishable from a live one, so Rekey cannot verify the `mode` you declare for PayPal credentials — it is recorded exactly as given, and nothing downstream will catch a mistake. Pasting **live** PayPal credentials into an Application you think of as a sandbox means that Application takes real money. For Stripe and Razorpay the mode is read from the key itself and a contradicting declaration is refused, so this is the one provider where the label is taken on trust. Treat PayPal credentials with the care nothing here can give you.

## Concepts

```
Application
  ├── many Plan          ("pro_monthly", "team_annual"; admin-managed)
  └── many Subscription  (one active per (Application, EndUser, Plan))
           └── many Payment
```

- **Plan**: what you sell. It has a `slug`, a `name`, an `interval` and its prices: one default price, and optionally one more price for each other currency. `interval` is `"MONTH"` (the default) or `"YEAR"`, uppercase exactly; `"month"` or `"monthly"` is refused. A plan with no price at all is free (`isFree: true`).
- **Subscription**: links an `EndUser` to a `Plan` with a status: `PENDING → ACTIVE → (PAST_DUE | CANCELED | EXPIRED)`. `currentPeriodEnd`, `cancelAt`, `canceledAt` track the lifecycle. A subscription keeps its own price: the currency and amount this subscriber pays each period, fixed when they subscribed.
- **Payment**: every charge attempt. Status: `PENDING → SUCCEEDED | FAILED`, then `PARTIALLY_REFUNDED | REFUNDED` as refunds arrive. `refundedAmount` is the sum of the payment's refunds that have not failed. `verification` is `verified` for a charge Rekey applied and `unverified` for one it recorded and did not apply.
- **Refund**: one refund of a payment, in the payment's currency. A payment can have several.

## Money rule

Every amount is an integer in the minor unit of its currency: `$9.99` is `999`, `₹499.00` is `49900`, `¥100` is `100`. Never a float. Show an amount with `formatMoney(amount, currency)`, which knows how many decimal places each currency has. Where the API has resolved a price for a buyer it also returns the text, as `formatted`. See [currencies.md](currencies.md).

## The provider abstraction

<!-- snippet: no-check an excerpt of an internal interface, not a program -->
```ts
// apps/api/src/modules/billing/providers/types.ts
interface BillingProvider {
  readonly name: string;                                                 // "stripe" | "paypal" | "razorpay"
  ensurePlanRegistered(plan: Plan): Promise<{ providerPlanId: string }>;  // Stripe Product+Price, PayPal Plan, …
  createCheckoutSession(input: CheckoutSessionInput): Promise<{ url: string; sessionId: string }>;
  createOneTimeCheckout(input: OneTimeCheckoutInput): Promise<{ url: string; sessionId: string }>;
  cancelSubscription(input: CancelSubscriptionInput): Promise<void>;
  captureOneTime?(input: CaptureOneTimeInput): Promise<...>;   // PayPal Orders v2 only
  registerWebhook?(input: RegisterWebhookInput): Promise<...>; // Razorpay has no create-webhook API
}
```

The interface expresses the **intersection** of capabilities. Provider-specific data (Stripe `tax_behavior`, PayPal `setup_fee`, …) lives in `metadata: Json` on `Plan` / `Subscription` / `Payment`. **Resist surfacing provider-only concepts at the top level.** That's the seam.

`getProviderForApplication(application, providerName)` is the only call site that picks a provider. Don't construct a provider class anywhere else — go through the registry in `modules/billing/providers/index.ts`.

## Admin endpoints

All gated by `SUPER_ADMIN_KEY`. Owned by the `plans` module.

```
GET    /api/v1/admin/applications/:id/plans?includeInactive=true
POST   /api/v1/admin/applications/:id/plans               { slug, name, price?: { currency, amount }, interval?, metadata? }
PATCH  /api/v1/admin/applications/:id/plans/:slug         { active?, name?, price?: { currency, amount } | null, interval?, metadata? }
POST   /api/v1/admin/applications/:id/plans/:slug/register
GET    /api/v1/admin/applications/:id/plans/:slug/entitlements
```

The entitlements read returns the plan's rows (`kind`, `key`, `valueType`, `value`) with no subscription override applied. Edit them on the tenant route of the same path.

The create body is **strict**: it builds SUBSCRIPTION plans, and an unknown key (`kind`, `licenseKind`, `creditsAmount`, or a typo) is a 400 `VALIDATION_ERROR` naming the field. It used to drop them and answer 201, so a caller asking for a LICENSE or CREDIT plan got a subscription and a success message. Per-kind plans and `trialDays` live on the tenant route, `POST /api/v1/tenant/applications/:id/plans`.

Creating a plan calls `ensurePlanRegistered()` **only when the Application already has Stripe credentials stored**; the returned price id is persisted into `Plan.metadata.stripe`. PayPal and Razorpay register the plan lazily at first checkout. Making the call unconditional used to be fine when a stub always answered — once the stubs were deleted it meant a PayPal-only or Razorpay-only operator could not create a plan at all, and the error named Stripe, a provider they had never configured.

### A plan is never on sale before the provider can charge for it

`Plan.registrationStatus` is written **before** the provider round-trip and settled after it:

| Status | Meaning | On the public catalogue? |
|---|---|---|
| `NOT_REQUIRED` | No eager registration owed — PayPal/Razorpay-only apps, or no billing configured. Registers lazily at first checkout. | yes |
| `PENDING` | Inserted, provider call in flight (or the process died during it). | no |
| `REGISTERED` | Provider acknowledged it; `metadata.<provider>` holds the price id. | yes |
| `FAILED` | Provider refused. Forced `active: false`, with the refusal in `registrationError`. | no |

Readiness blockers a plan can report alongside these: `PLAN_NOT_REGISTERED`
and `PLAN_REGISTRATION_FAILED` (Stripe), `PLAN_TRIAL_UNSUPPORTED` (a trial on
a provider that cannot run one), `NO_BILLING_PROVIDER`, and
`PROVIDER_INBOUND_ONLY` (the only enabled provider is the external billing
system, which hosts no checkout — see [external-billing.md](external-billing.md)).

A plan awaiting registration is inserted `active: false` and only promoted once the provider answers. The provider call is a network call, so it cannot sit inside a database transaction — the ordering is what makes it safe, not a transaction. Before this, a refused registration left the plan committed **and active**: it stayed on the pricing page, indistinguishable from a working plan, and every buyer who clicked it got a 500 out of checkout.

Repairing one does not need a new slug. `PATCH` accepts `name`/`metadata` always, and `amount`/`currency`/`interval` while the plan is unregistered (there is no immutable provider price to contradict yet — a registered plan answers `PLAN_PRICE_IMMUTABLE`). `POST .../plans/:slug/register` then retries registration and puts the plan back on sale. Activating a plan with no provider price is refused outright with `PLAN_NOT_REGISTERED_WITH_PROVIDER`.

Coupons have no equivalent hazard: nothing is registered with a provider at coupon-create time. The provider-side discount is minted per checkout and discarded if the session fails (`stripe-real.ts` `createDiscount`/`discardDiscount`).

There is **no delete endpoint by design**. Plans referenced by historical Subscriptions need to live forever for accounting. Use `setActive(false)` to retire — that's the only way out.

## Public endpoints

Publishable **or** secret key (`Authorization: Bearer rp_pub_…` / `rp_live_…`). The user-scoped ones additionally require the end-user JWT in `X-Rekey-User-Token`, and that token — not the key — is what authorizes them; see [api-keys.md](api-keys.md).

```
GET   /api/v1/billing/plans?country=                         (Application key; add the user JWT for a signed-in buyer)
GET   /api/v1/billing/subscription                           — Application key + user JWT
GET   /api/v1/billing/subscriptions                          (Application key + user JWT)
POST  /api/v1/billing/subscription/cancel { atPeriodEnd?, organizationId?, subscriptionId?, reason?, feedback? }
GET   /api/v1/billing/entitlements/features/:key             (Application key + user JWT)
GET   /api/v1/users/me/licenses                              (Application key + user JWT)
POST  /api/v1/billing/checkout    { planSlug, successUrl, cancelUrl, country?, currency?, onUnavailableCurrency?, provider?, couponCode? }
POST  /api/v1/billing/coupons/validate { code, planSlug, country?, currency?, onUnavailableCurrency?, provider? }
GET   /api/v1/billing/providers?country=&planSlug=           (Application key)
POST  /api/v1/billing/subscribe   { organizationId? }            — Application key + user JWT
```

### What a buyer sees of their subscriptions

Every end-user subscription response (the two reads above, cancel, subscribe,
checkout's `subscription`, and `include=subscription`) is an explicit allowlist of
fields. `metadata` carries only `checkoutSessionId` and `oneTime`; the rest of it is
what the operator and the providers wrote for themselves (a grant's note, retired
checkout sessions, the provider a row moved from) and stays on the secret-key
operator routes. `entitlementOverrides` is not on this surface either; the effect of
an override shows in `GET /billing/entitlements`.

A buyer can hold several live subscriptions, for instance two plans bought
separately. `GET /billing/subscription` returns one: a recurring paid plan first, then a
one-time purchase (a credit pack or a perpetual licence), then a plan that costs nothing,
the most recently created within each, ties broken by id. `GET /billing/subscriptions`
returns all live ones in that order (at most 100, the newest), so `items[0]` is the same row. Read the list
before offering a checkout, so nobody is offered a plan they already pay for, and
pass `subscriptionId` to cancel to end one of several. A `subscriptionId` naming an unfinished checkout answers `409 SUBSCRIPTION_CHECKOUT_UNFINISHED`, and cancelling a one-time purchase answers `409 SUBSCRIPTION_NOT_CANCELABLE`, since it never renews.

### Cancellation reasons

`POST /billing/subscription/cancel` takes two optional fields from your cancel survey:

| Field | Value |
|---|---|
| `reason` | One of `too_expensive`, `missing_features`, `switched_service`, `unused`, `too_complex`, `low_quality`, `customer_service`, `other` (`CANCEL_REASONS` in `@rekey.dev/shared-types`). Any other value answers `400`. |
| `feedback` | The subscriber's own words, 1 to 1000 characters after trimming. Only accepted with a `reason`; send `other` when none fits. |

<!-- snippet: no-check a fragment: no imports, and values from the surrounding code -->
```ts
await rekey.billing.cancelSubscription(userAccessToken, {
  reason: 'missing_features',
  feedback: 'No CSV export yet',
});
```

Both are stored on the subscription. A cancel at period end keeps them on the row, so the `subscription.canceled` that ends it later carries them too. Once a reason is stored, every subscription webhook carries `data.subscription.cancellation`: `{ reason, feedback }`, with `feedback` null when none was given. The operator billing view (`GET /tenant/applications/:id/end-users/:euid/billing`) returns `cancelReason` and `cancelFeedback`, and the panel shows them on the end user's Subscriptions tab. The hosted portal's cancel dialog asks "Why are you cancelling?" with the same reasons, optional.

When a subscription comes back from a scheduled cancel (the provider resumes it, or a renewal is paid after the cancel), the reason and feedback are cleared with `cancelAt`, so nothing keeps reporting a cancellation that did not happen.

Erasing the end user nulls `cancelFeedback` on the row and `feedback` in stored webhook deliveries. The `reason` is kept: it is one of eight fixed values and says nothing about the person. See [data-erasure.md](data-erasure.md).

### Where checkout sends the buyer afterwards

`successUrl` and `cancelUrl` are where the processor sends the buyer once they
have paid or given up. They should be on an origin the Application has
registered: its **Application URL** or one of its **redirect URLs** (Panel →
Application → Auth), compared by origin, so any path on a registered origin
passes. The hosted portal's own origin is allowed without registration for an
Application that uses it, because Rekey chose it rather than the caller.

| Return URL | Today | Next minor release |
|---|---|---|
| `javascript:`, `data:`, or any other non-http(s) scheme | **400** `CHECKOUT_RETURN_URL_INVALID` | same |
| http(s) on a registered origin (or the hosted portal) | allowed | allowed |
| http(s) on an unregistered origin | allowed, with a warning | **400** `CHECKOUT_RETURN_URL_NOT_ALLOWED` |

A warning rides on the checkout response and does not stop it:

```json
{ "url": "https://checkout.stripe.com/…", "subscription": { … }, "provider": "stripe",
  "currency": "USD", "unitAmount": 1900, "discountAmount": 0,
  "price": { "id": "…", "currency": "USD", "amount": 1900, "formatted": "$19.00", "isDefault": true, "reason": "default" },
  "priceFallback": null, "mode": "redirect", "checkoutSessionId": "…",
  "warnings": [{ "code": "CHECKOUT_RETURN_URL_UNREGISTERED", "field": "successUrl",
                 "origin": "https://shop.example", "message": "…", "fix": "…" }] }
```

`warnings` is always present on this API and empty when there is nothing to
report. Each unregistered checkout is also logged and recorded as the
security event `app.checkout_return_url_unregistered`, and the Application's
Billing page in the panel shows a notice with the origins and a count for the
last 7 days. An Application that has registered **no** origin at all gets the
warning on every checkout, and its message says so: set the Application URL
before upgrading. `http://localhost` is judged like any other origin, so add
your dev origin to the redirect URLs too.

**Razorpay subscriptions do not return the buyer.** Razorpay's subscription
checkout takes no return or cancel URL, so a buyer who pays for a recurring
Razorpay plan finishes on Razorpay's page and is not sent back to your app;
`successUrl` and `cancelUrl` are unused for them. Show the buyer how to get
back (the activation still arrives by webhook). One-time Razorpay purchases do
return to `successUrl`. The Rekey checkout page (below) fixes this: Razorpay's
modal opens on that page, and the page sends the buyer to `successUrl`.

**Stripe payment methods.** Stripe Checkout offers whatever payment methods the
operator's Stripe account has enabled (cards, Link, Apple Pay and Google Pay,
and local methods), not cards only. A delayed method such as a bank debit
completes the session before the money arrives; Rekey activates such a
checkout on `checkout.session.async_payment_succeeded`, not on
`checkout.session.completed`. To offer cards only, turn the other methods off
in the Stripe Dashboard (Settings → Payment methods).

### Which provider a buyer gets

A checkout that names a `provider` uses it. Otherwise Rekey routes, in this
order, among the providers that are enabled:

1. providers whose **Preferred in countries** list contains the buyer's country;
2. providers with an empty list, which are offered everywhere;
3. any other enabled provider, so a buyer always reaches one.

Within each step the lowest **Priority** wins. A tie goes to the provider's
built-in order (Stripe and Razorpay before PayPal), then its name.
Both fields are in Panel → Application → Billing → Setup → Providers → Edit. A
buyer with a live subscription, or an unfinished checkout, stays on that
provider.

To send buyers in India to Razorpay and everyone else to PayPal: set Razorpay's
countries to `IN` (the dialog pre-fills it) and leave PayPal's empty.

Routing needs the buyer's country, and where it comes from depends on who calls:

| Caller | Country used |
|---|---|
| Your server, with the secret key | The `country` you pass. Failing that, the country hint on your `@rekey.dev/node` client (below): you set it yourself, except in Astro, where `visitorClient(context)` sets it. The connection is your server's, so nothing else about it is read. |
| The hosted portal | The visitor's country, when `TRUST_CF_IPCOUNTRY=true` (see [analytics.md](analytics.md#country)). Without that setting, none: the portal's own connection is never read. |
| A browser with the publishable key | The country a trusted proxy vouched for, under the same setting. Failing that, a CDN country header on the request, then the `country` the caller passes, as a hint. |

So a backend has to say where the buyer is. There are two ways, and they are
not worth the same.

**A country hint.** Your hosting platform puts the visitor's country on every
request: `cf-ipcountry` behind Cloudflare, `x-vercel-ip-country` on Vercel.
Hand it to the SDK as a hint and the buyer is routed to the provider you prefer
in that country:

```ts
// Any server: read your platform's header and scope your client with it.
import { Rekey } from '@rekey.dev/node';

const rekey = new Rekey({ apiUrl: process.env.REKEY_URL!, secretKey: process.env.REKEY_SECRET! });

export async function startCheckout(request: Request, userAccessToken: string) {
  const scoped = rekey.with({ visitorCountryHint: request.headers.get('cf-ipcountry') ?? undefined });
  return scoped.billing.createCheckout(userAccessToken, { planSlug: 'pro', successUrl, cancelUrl });
}
```

```ts
// Next.js: read the header with the helper, then scope your client the same way.
import { visitorCountryHint } from '@rekey.dev/nextjs/server';

export async function startCheckout(userAccessToken: string) {
  const scoped = rekey.with({ visitorCountryHint: await visitorCountryHint() });
  return scoped.billing.createCheckout(userAccessToken, { planSlug: 'pro', successUrl, cancelUrl });
}
```

```ts
// Astro: visitorClient(context) builds the client and sets the hint for you.
import { visitorClient } from '@rekey.dev/astro';

export async function startCheckout(context: { request: Request }, userAccessToken: string) {
  return visitorClient(context).billing.createCheckout(userAccessToken, { planSlug: 'pro', successUrl, cancelUrl });
}
```

Nothing forwards the hint for a Next.js checkout on its own. `@rekey.dev/nextjs`
sets it only on the calls it makes itself (sign-in, sign-up, MFA, lists), and
those never price anything. A checkout goes through your own client, so it
carries the hint only when you scope that client as above.

The SDK sends it as the `x-rekey-visitor-country-hint` header, and only when
the platform header is a real country (Cloudflare's `XX` and `T1` are not). It
is a hint, with source `hint`: it chooses the provider. Under the default
**Local prices** setting it does not select a plan's local price, and the buyer
is charged the default price. Under **Any country** it selects the local price
too (see [Which country counts](#a-plan-in-more-than-one-currency)). A buyer
who reaches your origin without going through the CDN can write that header
themselves, so Rekey does not treat it as proof.

**A declared country.** `country` on the call is your server's own statement,
with source `declared`. It routes the provider and it selects a local price
under either setting, and it wins over a hint:

```ts
export async function startCheckout(userAccessToken: string, billingCountry: string) {
  return rekey.billing.createCheckout(userAccessToken, {
    planSlug: 'pro',
    successUrl,
    cancelUrl,
    country: billingCountry, // from the buyer's billing address: something they cannot rewrite
  });
}
```

Pass a geo header as `country` only if nothing but your CDN can reach your
origin. Otherwise use the hint for routing and a declared country, or
`currency`, for price.

`GET /billing/providers?country=IN` returns the same order, and `routedProvider`,
the provider a checkout would get for a buyer not already bound to one. A
country value that is not a country (Cloudflare's `T1` and `XX`) is ignored.
Each checkout session records the country it was routed with and its source
(`declared`, `vouched` or `hint`).

Currency comes before all of that, and it is the one hard rule. Each provider
account has a list of **currencies it charges**, in the same dialog. You choose
them from the list the provider publishes, and an empty list means none (see
[currencies.md](currencies.md#what-each-provider-can-charge)). A price is never
routed to a provider that does not list its currency, whatever the buyer's
country. Naming such a provider from your server is refused with
`BILLING_PROVIDER_CURRENCY_UNSUPPORTED`. A provider named from a browser cannot
decide which price is selected: when it cannot charge the selected price, the
checkout is routed as if none were named. A new provider starts with what its
accounts usually charge, in the dialog and when it is saved through the API
without a list: every currency Stripe lists for Stripe, PayPal's cross-border
currencies for PayPal (which do not include INR), and INR for Razorpay. Add
more to Razorpay once international payments are activated on the account. A
provider with nothing ticked is not used for any checkout. What happens when no enabled provider lists the currency is
under [When a currency cannot be charged](#when-a-currency-cannot-be-charged).

`GET /billing/providers?planSlug=pro` lists only the providers a checkout of
that plan accepts for this buyer, each judged at the price that checkout would
charge (the local price where the buyer's country selects one), and its
`routedProvider` is the provider a checkout of the plan that names none is sent
to. Both SDKs take it: `rekey.billing.getProviders(country, { planSlug })` on
your server and `listBillingProviders({ planSlug })` in the browser. Ask that
way when a picker is for one plan. A list fetched for a whole pricing page
carries each provider's `currencies`, and `<PricingTable>` and the hosted
portal use them: a provider is offered for a plan when it can charge any of the
plan's prices, a provider the picker merely preselected is not posted with a
plan that has more than one price, and a plan the pick cannot charge posts
none, so Rekey routes it.

A plan can carry a price in more than one currency, and the rule applies to the
price a checkout is charged at, not to the plan. So you do not need a separate
plan to sell in India: give the plan an INR price and, with the lists above,
that price goes to Razorpay and the USD price to PayPal or Stripe without any
country setting. The next section covers it.

### A plan in more than one currency

A plan has one default price. It can also carry one more price for each other
currency you sell in. Everything else about the
plan is shared: the slug, the interval and the entitlements. Your integration
still checks out `pro` and still reads `pro` off the subscription, whatever
currency the buyer paid in.

An additional price has three parts:

| Field | Meaning |
|---|---|
| `currency` | ISO 4217, from the [sellable set](currencies.md#which-currencies-a-price-may-be-in), and not the currency of the default price. One price per currency. |
| `amount` | An integer in the minor unit of that currency, like every amount here. ₹1,499.00 is `149900`. HUF, TWD and MGA amounts must end in `00`. |
| `countries` | Optional. ISO 3166-1 alpha-2 codes where the price applies. |

With no `countries`, the price applies wherever its currency is the local one:
INR in India, EUR in Germany. That comes from a fixed table, so there is no
mapping for you to maintain. List countries when the table is wrong for you,
for example a EUR price you do not want offered in every euro country, or a USD
price for buyers in a country whose own currency you do not sell in.

**How a price is chosen.** At checkout Rekey takes the first of these that
applies:

1. The currency the buyer already pays in, if they have a live subscription.
2. The `currency` your server passes to checkout with the secret key.
3. The price that applies in the buyer's country, when that country can be
   trusted (see below) and the plan allows local prices.
4. The plan's default price.

The plan list answers the same question before the buyer clicks. Each plan on
`GET /billing/plans` carries `price`: the price this buyer would be charged,
resolved by the function checkout uses. A pricing page renders
`plan.price.formatted` and picks nothing itself.

```ts
export async function pricingRows(country: string, accessToken?: string) {
  const { items } = await rekey.billing.getPlans(undefined, {
    country, // where the buyer is, from your server
    ...(accessToken !== undefined && { accessToken }), // a signed-in buyer keeps the currency they pay in
  });
  return items.map((plan) => ({
    name: plan.name,
    price: plan.price ? plan.price.formatted : plan.isFree ? 'Free' : 'Usage based',
    why: plan.price?.reason, // 'bound' | 'requested' | 'country' | 'default' | 'fallback'
  }));
}
```

`price` is null for a plan with no flat price: a free plan, or a usage plan
with no base fee. `prices` lists every price the plan sells at, the default
first. It is there to show what exists. Do not pick from it yourself: a price
you pick is not the price checkout charges.

### When a currency cannot be charged

The selected price is used only if an enabled provider lists its currency.
When none does, what happens depends on why the price was selected:

| Selected because | Outcome when no usable provider can charge it |
|---|---|
| The buyer's country | The checkout charges the default price and says so in `priceFallback`. |
| Your server named `currency` | Decided by `onUnavailableCurrency`: `fallback` charges the default price and says so in `priceFallback`, `refuse` refuses the checkout with `BILLING_NO_PROVIDER_FOR_CURRENCY`. The request's own value wins. Without one, the Application's default applies. |
| The buyer already pays in it | Refused with `BILLING_CURRENCY_CONFLICT`. A subscriber is never moved to another currency. |
| It is the default price | Refused with `BILLING_NO_PROVIDER_FOR_CURRENCY`, or `BILLING_PROVIDER_CURRENCY_UNSUPPORTED` when your server named a provider, or `BILLING_BOUND_PROVIDER_CURRENCY_UNSUPPORTED` when the buyer is tied to one. There is nothing to fall back to. |

A checkout that names a `currency` the buyer does not already pay in, while
they have a live subscription in another, is also refused with
`BILLING_CURRENCY_CONFLICT`.

**The Application default.** `billingConfig.onUnavailableCurrency` is
`fallback` or `refuse`, and `fallback` until you change it. Set it in the
panel under Billing, Setup, Defaults, "When a currency cannot be charged", or with:

```http
PATCH /api/v1/tenant/applications/:id/billing-config
{ "onUnavailableCurrency": "refuse" }
```

Changing it needs an operator session, so an operator token cannot. Read it
from a terminal with `rekey billing unavailable-currency get --app <id>`, or
from the SDK with `operator.billing.getConfig()`.

It is used by every request that names a `currency` and sends no
`onUnavailableCurrency` of its own: checkout, the coupon quote and the routing
preview. A request that sends its own value always wins. It decides the second
row of the table and nothing else: a price selected by the buyer's country
still falls back, a subscriber is never moved off their currency, and a
default price nobody can charge is refused either way. A change is written to
the [billing log](billing-log.md) as `settings.unavailable_currency_changed`,
with the value before and after.

The checkout result's `price` is always the price charged. `priceFallback` is
set when it differs from the price selected, with both sides, and is null
otherwise. **Tell the buyer before they pay.** `priceFallbackMessage` writes
the sentence:

```ts
import { priceFallbackMessage } from '@rekey.dev/node';

export async function startCheckout(userAccessToken: string, country: string) {
  const checkout = await rekey.billing.createCheckout(userAccessToken, {
    planSlug: 'pro',
    country,
    successUrl,
    cancelUrl,
  });

  if (checkout.priceFallback) {
    // 'Prices in INR are not available yet. You will pay $19.00.'
    await confirmWithBuyer(priceFallbackMessage(checkout.priceFallback));
  }
  console.log(checkout.price?.formatted, checkout.price?.reason); // '$19.00' 'fallback'
  return checkout.url;
}
```

The hosted portal tells the buyer the same thing on its review step, before
they continue to payment. The Rekey checkout page always shows the amount and
currency the buyer is actually charged. In React,
`<PriceFallbackNotice fallback={checkout.priceFallback} />` renders the
sentence ([react-components.md](react-components.md#pricefallbacknotice)).

Every fallback is written to the [billing log](billing-log.md) as
`checkout.price_fallback`, and
[billing-log.md](billing-log.md#default-price-used) shows how to count them and
how to stop them. A fallback is a sale at a price you did not set for that
buyer, so it is worth watching.

To be refused instead of falling back, whatever the Application's default is:

```ts
import { isBillingMoneyError } from '@rekey.dev/node';

export async function startRupeeCheckout(userAccessToken: string) {
  try {
    return await rekey.billing.createCheckout(userAccessToken, {
      planSlug: 'pro',
      currency: 'INR',
      onUnavailableCurrency: 'refuse',
      successUrl,
      cancelUrl,
    });
  } catch (err) {
    if (isBillingMoneyError(err) && err.code === 'BILLING_NO_PROVIDER_FOR_CURRENCY') {
      show('Prices in INR are not available yet.');
      return null;
    }
    throw err;
  }
}
```

**Which country counts.** A lower local price is worth lying about your country
for, so by default only a country Rekey has reason to believe selects one. In
the terms of the table above:

| Country source | Selects a local price by default |
|---|---|
| `declared`: your server passed `country` with the secret key | Yes |
| `vouched`: a trusted proxy set it (`TRUST_CF_IPCOUNTRY=true`) | Yes |
| `hint`: a header or a `country` that arrived from a browser, or the country hint your server's client forwarded from your platform's geo header | No. The buyer is charged the default price. |

The country is the `country` body field, or `?country=` on a GET. The
`x-country` header is removed: a request that sends it is refused with
`BILLING_FIELD_REMOVED` (400), on every billing route that reads a country. Declare a country only from a source the
buyer cannot write, such as a billing address, never a value the browser
posted. The country hint (`visitorCountryHint` on your client) stays a hint
even though it travels with your secret key, for the reason given under [Which
provider a buyer gets](#which-provider-a-buyer-gets): by default it routes, and
it does not price.

A plan can be narrower than the Application. The operator plan list returns
each plan's `localPrices`: `INHERIT` (follow the Application's setting),
`TRUSTED` (a declared or vouched country only) or `OFF` (the buyer's country
never selects one of this plan's other prices). A CREDIT plan is created
`TRUSTED`, because every price of a credit pack grants the same credits. Every
other plan is created `INHERIT`.

Change it with `PATCH /api/v1/tenant/applications/:id/plans/:slug` and
`{ "localPrices": "OFF" }` (Panel → Application → Plans → Edit → **Local prices
on this plan**, `operator.plans.update('pro', { localPrices: 'OFF' })` in
`@rekey.dev/node`, `rekey plans local-prices pro off --app <id>`, or the
operator MCP tool `update_plan`). It can change whether or not a provider has
registered the plan. With `OFF`, every new buyer is charged the default price
unless your server names a `currency` at checkout; a subscriber already paying
in another currency keeps it. A change is written to the
[billing log](billing-log.md) as `plan.local_prices_changed`, with the value
before and after; sending the value the plan already has writes nothing.

The Application's setting is Panel → Application → Billing → Setup → Defaults → **Local
prices** (`billingConfig.localPrices`). **Verified country only** (`trusted`)
is the default and behaves as above. **Any country** (`any`) lets a hint select
a local price too, which means a buyer can choose their price by changing their
country. Use it when your local prices are a convenience and not a discount.

Under the default, an app that creates checkouts from the browser with the
publishable key and has no trusted proxy charges every buyer the default price.
To charge local prices there, create the checkout from your server and pass
`country`, or put the app behind a proxy Rekey trusts.

Your server can also skip the country and name the price:

```ts
export async function startCheckout(userAccessToken: string) {
  return rekey.billing.createCheckout(userAccessToken, {
    planSlug: 'pro',
    currency: 'INR', // decided on your server
    successUrl,
    cancelUrl,
  });
}
```

`currency` is accepted from the secret key only. The same field sent with a
publishable key is refused with `BILLING_CURRENCY_NOT_ALLOWED`, so never
forward a currency that a browser posted.

**A subscriber keeps their currency.** The price is fixed when the buyer
subscribes, and every renewal is charged in that currency for the life of the
subscription. Adding, changing or removing a price later moves nobody who is
already subscribed. `GET /billing/subscription` returns it as `price`
(`{ id, currency, amount, formatted }`): what this subscriber pays each period,
which can differ from the plan's default price. It is null for a subscription
to a plan with no flat price, and for a checkout that has not been paid yet.

```ts
export async function currentPriceLabel(userAccessToken: string) {
  const subscription = await rekey.billing.getSubscription(userAccessToken);
  return subscription?.price?.formatted ?? null; // '₹1,499.00'
}
```

**A registered price cannot change.** Once a payment provider has registered a
price, its amount is fixed, the same way the plan's own price is. Changing it
is refused with `PLAN_PRICE_IMMUTABLE`. Its `countries` can change at any time,
and you can add a new currency to a plan at any time, registered or not.

**Nor can a price a record names.** A price keeps its amount while a live
subscription or an open checkout is on it, and after an ended subscription, a
payment or a credit grant was recorded at it, so those records go on saying
what was charged. Changing its amount is refused with `PLAN_PRICE_REFERENCED`.
To charge a different amount, `DELETE` the price once nobody is on it (it is
kept, archived) and `PUT` the new amount, which is the plan's price in that
currency from then on. Changing a plan's default price with `PATCH` does the
same by itself: a default price a record names is archived at its amount and
the new amount is added as a new price.

**Setting prices.** With an operator token:

```
PUT    /api/v1/tenant/applications/:id/plans/:planId/prices/:currency   { amount, countries? }
DELETE /api/v1/tenant/applications/:id/plans/:planId/prices/:currency
```

`PUT` creates the price or updates it. `amount` is required to create a price;
to change only `countries`, leave it out. It answers the price:
`{ id, currency, amount, countries, isDefault, archived, registration: { status, error }, amountEditable, liveSubscriptions, openCheckouts }`.
The operator plan list carries the same three facts on every price:
`amountEditable` is false once a provider holds the price or is registering it
(a `PUT` that changes its amount then answers `PLAN_PRICE_IMMUTABLE`) or a
record names it (`PLAN_PRICE_REFERENCED`), and
`liveSubscriptions` and `openCheckouts` count who is on it (with either above
0, `DELETE` answers `PLAN_PRICE_IN_USE`). The public catalogue carries none of
them.
`DELETE` takes the price off sale and answers `{ deleted }`. A price that an
ended subscription or a payment still names is kept, archived, and no longer
sold. Both changes are written to the [billing log](billing-log.md) as
`plan.price_set` and `plan.price_archived`.

With `@rekey.dev/node` and an operator token:

```ts
import { formatMoney } from '@rekey.dev/node';

const price = await operator.plans.prices.set('pro', 'INR', { amount: 149900, countries: ['IN'] });
console.log(price.registration.status); // 'PENDING' until its first recurring checkout

for (const each of await operator.plans.prices.list('pro')) {
  console.log(each.currency, formatMoney(each.amount, each.currency), each.isDefault);
}

await operator.plans.prices.archive('pro', 'INR');
```

| Code | When |
|---|---|
| `PLAN_PRICE_IS_DEFAULT` | `:currency` is the plan's own currency. Change the plan's price instead. |
| `PLAN_PRICE_IMMUTABLE` | The amount of a price a provider has already registered would change. |
| `PLAN_PRICE_REFERENCED` | The amount of a price a subscription, an open checkout, a payment or a credit grant names would change. |
| `PLAN_PRICE_CURRENCY_UNSUPPORTED` | A currency outside the sellable set: a three-decimal one (BHD, IQD, JOD, KWD, LYD, OMR, TND), a withdrawn code, or a code that is not money. |
| `PLAN_PRICE_NOT_APPLICABLE` | The plan is free or billed on usage, so it has no price to add another currency to. |
| `PLAN_PRICE_CURRENCY_INVALID`, `PLAN_PRICE_AMOUNT_INVALID`, `PLAN_PRICE_COUNTRY_INVALID` | The code is not ISO 4217; the amount is not a positive integer, is above 2,147,483,647, or does not end in `00` in a whole-unit currency; or a country is not ISO 3166-1 alpha-2. |
| `PLAN_PRICE_NOT_FOUND` | Removing a price the plan does not have. |
| `PLAN_PRICE_IN_USE` (409) | `DELETE` on a price that is still in use. |

The same two operations are available elsewhere:

- **Panel**: Application → Plans → **Edit** on the plan → **Prices in other
  currencies**. Amounts are entered in the smallest unit, like the plan's own
  price, and the form shows what the number comes to as you type.
- **CLI**: `rekey plans prices list <plan> --app <id>`, `rekey plans prices add
  <plan> <currency> <amount> --app <id> [--countries IN,NP]`, `rekey plans
  prices update <plan> <currency> --app <id> [--amount <n>] [--countries
  IN,NP]` and `rekey plans prices archive <plan> <currency> --app <id>`.
  `<plan>` is the plan's id or slug. All use `REKEY_OPERATOR_TOKEN`.
- **MCP**: `set_plan_price` and `remove_plan_price` on the operator server.

**Reading prices.** `GET /api/v1/billing/plans` and the operator plan list
return each plan with:

- `price`: the price resolved for the buyer you asked about, with `formatted`
  and `reason`, or null for a plan with no flat price. On the operator list it
  is the default price.
- `prices`: every price the plan sells at, the default one first, then the
  others by currency. Each has `id`, `currency`, `amount`, `countries` and
  `isDefault`. Empty for a plan with no flat price. The operator list adds
  `registration` to each.
- `isFree`: whether the plan charges nothing at all.

The public plan carries no `amount` and no `currency` of its own: `price` is
the price. When `price.reason` is `fallback`, `price.requestedCurrency` names
the currency that was selected for the buyer and cannot be charged; it is
`null` for every other reason. The operator plan list still repeats the
default price as `amount` and `currency`; read `price` and `prices` there too.

The public plan is a fixed list of fields. It carries no `metadata`, no
`applicationId`, no provider ids and no registration state: those are on the
operator plan list only.

`<PricingTable>` renders `price.formatted` as it is
([react-components.md](react-components.md#pricingtable)).

**Worked example: selling to India.** You have one plan, `pro`, whose default
price is USD 19 a month (`1900`), and two providers: Razorpay, whose
currencies are `INR`, and PayPal, with PayPal's own list, which has no INR.
Add the INR price:

```bash
rekey plans prices add pro INR 149900 --app <appId>
```

No countries are given, so the price applies where INR is the local currency,
which is India. Then:

| Buyer | Price | Provider |
|---|---|---|
| In India, and your server passes `country: 'IN'` | INR 1,499 | Razorpay, the only one that can charge INR |
| In the United States | USD 19 | PayPal, because Razorpay cannot charge USD |
| In India, checking out from the browser with no trusted proxy | USD 19, because the country is only a hint | PayPal |
| Anywhere, and your server passes `currency: 'INR'` | INR 1,499 | Razorpay |

Neither provider needs a country list for this. The currency each account can
charge does the routing. The third row is the one to check before you launch:
if your Indian buyers should pay in INR, make sure their country reaches Rekey
from your server or from a trusted proxy.

### The Rekey checkout page (beta)

Instead of sending the buyer to the processor's own page, a checkout can land
on a Rekey-hosted page at `<portal>/<slug>/checkout/chk_…` that carries your
name, logo and colours, the order summary and the renewal terms, with the
processor's own payment buttons in it. Today that is **PayPal**,
**Razorpay** and **Stripe**, for subscriptions and one-time purchases.

Nothing changes in your code. `POST /billing/checkout` still answers with a
`url` to redirect to; when the page is on, `url` is the Rekey page and the
response says `"mode": "embedded"`. Pass `"mode": "redirect"` on a checkout to
force the processor's page for that one checkout.

**Switching it on.** Panel → Application → Billing → Setup → **Checkout page**. It is
set separately for **Test** and **Live**: a checkout uses the setting for the
mode of the credentials its provider runs on, so you can run the Rekey page on
sandbox credentials while live checkouts stay on PayPal's page. Switching a
mode to "Rekey page" runs that mode's readiness checks first and is refused on
any FAIL; switching back is never refused. The same settings are on the API:
`GET` / `PATCH /api/v1/tenant/applications/:id/checkout`,
`GET …/checkout/readiness` and `GET …/checkout/status`.

**Readiness checks**, shown as a Test and a Live column:

| Check | FAIL when | WARN when |
|---|---|---|
| Portal reachable | no hosted portal on this deployment (`PUBLIC_PORTAL_URL` unset), or the portal did not answer a round-trip probe | the probe took over 2 s |
| Provider supports the page | the provider cannot take a flow this Application sells on the page | sandbox credentials on a PRODUCTION Application, or live ones on a DEVELOPMENT/STAGING one; or nothing has shown the credentials work yet. Any one of these counts: a plan registered with the provider in this mode (Stripe), or, since the secret or its mode last changed, a checkout session opened in this mode, a subscription or payment through the provider, or a verified webhook. Editing only enablement or routing does not restart that window |
| Webhook registered | no webhook registered; for Stripe and PayPal, the provider itself says the saved webhook is not on this account (another account, or the other mode), delivers to another URL, is switched off, or lacks an event the checkout needs. Press **Reconfigure** on the provider's row to register it again | the provider could not be asked; for Razorpay, which has no API to read a webhook, no verified event in the last 30 days or since its secret was last saved, the last one is over 7 days old, or with one-time plans no `order.paid` delivered yet |
| Plans ready in this mode | a live paid plan cannot be bought through the provider, or was registered in the other mode | there are no active paid plans to sell; or a registration predates mode recording |
| Return URL origin registered | the Application has no Application URL and no redirect URLs | |
| Browser credential | PayPal has no Client ID; Razorpay has no Key ID; Stripe has no publishable key, or its mode differs from the secret key's | |
| Branding | | no display name or no logo (Panel → Application → Billing → Portal → Branding) |
| CSP reports | | the portal does not receive the page's CSP reports |

A PayPal account that has never sent a verified live webhook fails the live
webhook check, so take the first live payment on PayPal's page (the default),
then switch.

**If a check fails at checkout time.** Every checkout re-runs the critical
checks. "Fall back to the provider's page" (the default) serves that checkout
on PayPal's page and adds a `CHECKOUT_EMBEDDED_FELL_BACK` warning naming the
check; "Refuse the checkout" answers `409 CHECKOUT_EMBEDDED_NOT_READY` and
creates nothing. Neither tells the buyer why beyond the check's name: the
detail is on the Checkout page tab and the security log. On the Rekey page an unregistered `successUrl` or `cancelUrl`
is always a failed check, never a warning. `CHECKOUT_EMBEDDED_ENABLED=false`
on the API switches the page off for the whole deployment under the same rules.

**What the buyer sees.** The page shows the email the checkout was created
for while it can still be paid, and never after it is paid or expired. In test
mode a banner says "Test mode: no real money moves." It is never shown in live
mode. The buyer approves in PayPal's own window (the PayPal wallet, or "Debit
or Credit Card"), and the page waits for PayPal's webhook, then sends the buyer
to `successUrl`. The browser's word activates nothing: a subscription
activates only from PayPal's verified `BILLING.SUBSCRIPTION.ACTIVATED` webhook,
and a one-time order is captured and fulfilled only from its verified
`CHECKOUT.ORDER.APPROVED` webhook, as on PayPal's page. If
PayPal's script does not load, the page offers "Continue on PayPal", the same
PayPal page as before. One-time purchases need `CHECKOUT.ORDER.APPROVED` and
`PAYMENT.CAPTURE.COMPLETED` on the PayPal webhook. Auto-configure in Billing →
Setup → Providers → PayPal registers both, and when a webhook already exists at
Rekey's URL it replaces that webhook's event list with the full set, so run it
once on an Application set up before one-time checkout. A webhook you pasted by
id and never auto-configured keeps whatever events you gave it at PayPal.
A webhook belongs to the account that created it, so when you save new keys or
switch the mode, Rekey registers it again with the new credentials. **Reconfigure**
on the provider's row does the same on demand, for Stripe and PayPal.
Before capturing, Rekey reads the order back from PayPal and captures only an
order for the buyer, amount and currency the checkout created; anything else is
left uncaptured and logged as `app.checkout_capture_refused`.

**Razorpay on the page.** The page shows its own "Pay" button in your accent
colour; it opens Razorpay's Standard Checkout modal (cards, UPI, netbanking,
wallets) with your display name, logo and colour, UPI first for an INR
one-time purchase (Razorpay does not reorder methods for a subscription). Card and
UPI details are entered only in Razorpay's modal. A subscription is the same
Razorpay subscription as on Razorpay's page; a one-time purchase is a Razorpay
Order rather than a Payment Link, because the modal cannot open a link. When
Razorpay says paid, Rekey checks Razorpay's signature on it (and, for an order,
reads the payment back from Razorpay and captures it if your account is set to
manual capture), then waits for the webhook: `subscription.activated` /
`subscription.authenticated` for a subscription, `order.paid` for a one-time
order. **Add `order.paid` to your Razorpay webhook** (Razorpay Dashboard →
Settings → Webhooks) before selling one-time plans on the page; without it the
buyer pays and the order is never fulfilled. The readiness check warns until
one has arrived. Keep automatic capture on (Razorpay Dashboard → Account &
Settings → Capture settings, the default): with manual capture, a payment whose
page closed before reporting back is never captured, and Razorpay refunds it.
If Razorpay's script does not load, "Continue on Razorpay"
opens the subscription's Razorpay page, or posts the same order to Razorpay
Hosted Checkout, which returns the buyer to the page: waiting for the webhook
after a payment, or saying nothing was charged after a failed one. While a
buyer's earlier Razorpay subscription for the same plan is authorised and
waiting for its webhook, a new checkout for it answers
`409 CHECKOUT_PAYMENT_IN_PROGRESS`, as for PayPal.

**Stripe on the page.** The page shows Stripe's Payment Element (cards, Link,
Apple Pay, Google Pay and the other methods your Stripe account enables) under
the order summary, themed with your accent and surface colours, with a Pay
button that names the amount. It is the same Checkout Session the redirect
flow creates, in `ui_mode: 'elements'`, so trials, coupons and payment methods
behave exactly as on Stripe's page, and the purchase still completes only from
the verified `checkout.session.completed` (or
`checkout.session.async_payment_succeeded`) webhook. Card details stay inside
Stripe's frames. Setup:

- Add the **publishable key** in Panel → Application → Billing → Setup →
  Providers → Stripe → Edit (`pk_test_…` with a `sk_test_…` secret key,
  `pk_live_…` with `sk_live_…`; a key in the other mode is refused). It is a
  public value, sent only to the checkout page. The redirect flow does not
  need it.
- **Wallets need the page's domain registered** on your Stripe account:
  Stripe Dashboard → Settings → Payment method domains, add the portal's host
  (`portal.rekey.dev` on Rekey Cloud, or your own portal host). Until then
  Apple Pay and Google Pay do not appear; cards and Link still do.
- A card that asks for 3-D Secure may send the buyer to their bank and back to
  the page, which checks the payment with Stripe and carries on waiting for
  the webhook.
- A bank debit (SEPA, ACH, Bacs) finishes on the page as "confirming": the
  money arrives days later and the purchase completes on
  `checkout.session.async_payment_succeeded`. Until then a new checkout for
  the same plan answers `409 CHECKOUT_PAYMENT_IN_PROGRESS`, so the buyer
  cannot pay twice. If the debit fails, `checkout.session.async_payment_failed`
  closes the checkout and the buyer can start another. Stripe leaves a
  subscription whose first debit failed `active` with its invoice voided, so
  Rekey also cancels that Stripe subscription; otherwise it would bill the
  next period for a checkout that never activated. Auto-configure
  subscribes both events; add them to a webhook you registered by hand.

"Continue on Stripe" (shown if Stripe.js does not load or the payment fails)
closes the session on the page and opens Stripe's own checkout page for the
same order, at the same price, with the same coupon and trial, so the buyer
can never pay twice. Stripe's page expires with the Rekey checkout. In the
checkout's last half hour the link is still shown but answers
`409 CHECKOUT_FALLBACK_UNAVAILABLE` and returns the buyer to the page, whose
form keeps working. A Checkout custom domain works: each click asks Stripe for
the page's address.

**Links on the page.** Set Terms, Privacy and Refund policy URLs in Panel →
Application → Billing → Portal → Branding to show them in the page's footer. The hosted
customer portal itself does not need to be switched on for the checkout page
to work.

**Limits.** On either page and for every provider: one end-user may start
10 checkouts an hour and 30 a day, one client address
`CHECKOUT_LIMIT_PER_IP_HOUR` (default 20) an hour, and one Application
`CHECKOUT_LIMIT_PER_APP_HOUR` (default 1000) an hour. The next answers
`429 CHECKOUT_RATE_LIMITED` with the time to retry. While a buyer's earlier
subscription checkout for the same plan is approved and waiting for its webhook, a
new one answers `409 CHECKOUT_PAYMENT_IN_PROGRESS` instead of starting a
second subscription. A checkout page link expires with its checkout, after 24 hours.

### Hiding a plan that would fail at checkout

Every plan on `GET /billing/plans` carries `checkout: { ready }`. It is `false`
when a buyer sent to checkout for that plan would be refused by a provider they
could be routed to: no provider is connected, the plan was created before the
provider and never registered, or it offers a trial a provider cannot run. A
pricing page can hide such a plan instead of letting a buyer find out at the
Buy button.

It is the same readiness the operator plan list reports, computed in the same
pass, but only the boolean. The operator list's `checkout.blockers` names the
provider, the error code and the repair; that is configuration a publishable
key must not read, and a buyer has nothing to repair. Only providers a buyer
can be routed to count: an inbound-only external billing system enabled beside
Stripe does not make every plan read `false`, though it is the reason when it
is the only provider. The readiness costs one extra query per page, whatever
the number of plans on it.

`ready` describes checkout only. A free default plan (`billingConfig.defaultPlanSlug`) reads `ready: false` when no provider is connected, because nothing can check out on it, yet it still applies to every signed-in user. Do not filter your free tier out on `ready`; filter paid plans only.

```ts
const { items } = await rekey.billing.getPlans();
const freeSlug = 'free'; // your billingConfig.defaultPlanSlug
const shown = items.filter((p) => p.slug === freeSlug || p.checkout.ready);
```

### Checking one feature

`GET /billing/entitlements/features/:key` answers one feature for the signed-in
user:

```json
{ "key": "projects", "granted": true, "value": 5 }
```

`value` is what `features[key]` holds in the full `GET /billing/entitlements`
answer, or `null` when nothing grants the key (an unknown key is not an error).
`granted` is `Boolean(value)`, the test `if (features[key])` makes, so a
`false` flag, a `0` limit and an absent key are all not granted; compare
`value` yourself for a numeric limit. The subject is the one
`GET /auth/me?include=entitlements` and `GET /billing/entitlements` resolve: the active organization in an
org-billed Application while the caller still belongs to it, otherwise the
end-user. Pass `?organizationId=` (member-only) for that organization's view.
It skips the credit balance read the full call makes.

The secret-key counterpart for a user you name is
`GET /billing/entitlements/for-user/features/:key?endUserId=` (with optional
`organizationId`), next to `/entitlements/for-user`. Both need `billing:read`
on a secret key.

### The signed-in user's licences

`GET /users/me/licenses` lists every licence issued to the caller, newest
first, paginated. In an org-billed Application whose session acts for an
organization the caller still belongs to, the licences pooled to that
organization are included, whoever bought them. Each row carries `keyPrefix`
but never the key: only its hash is stored, and the raw key is shown once, at
issue. The operator's licence `metadata` is not on this surface. It needs
`billing:read` on a secret key and answers `403 BILLING_DISABLED` when billing
is off. The same list is `include=licenses` on `/auth/me` and `/users/me`, as
`{ items, truncated }`: the first 100 rows, with `truncated: true` when there
are more to page through here.

`POST /subscribe` puts the caller on the Application's nominated free plan (`billingConfig.defaultPlanSlug`) with no provider involved. When that plan grants CREDIT or LICENSE entitlements, the claim is **once per end-user**, across their personal account and every organization they own or administer, and it survives cancellation: activating it for a second beneficiary answers `409 BILLING_FREE_TIER_ALREADY_CLAIMED`. Cancelling and reactivating for the same beneficiary is allowed and issues nothing new. Credits already issued stay with their beneficiary after a cancel. A free plan carrying only FEATURE or USAGE entitlements has no such limit, because nothing is handed over that outlives the subscription. A person gets its features and included usage at read time without calling anything. An organization gets them only on an Application that bills per organization, and only once an OWNER or ADMIN has called `POST /subscribe` for it: each such call records the organization's claim (idempotent, one per organization and plan). The claim is read against the current `defaultPlanSlug`, so renominating the free plan carries claimed organizations with it and clearing it removes the fallback. An organization takes the free plan's FEATURE flags and included USAGE quantity, never its per-unit USAGE price, because an organization's credit pool is usually empty. A priced free-plan USAGE row still caps the organization at its included quantity (zero when it includes none) rather than leaving it unmetered. Past that allowance, `POST /usage/record` charges the meter's own `creditsPerUnit` when the meter has one, from the organization's credit pool; with an empty pool that refuses the record, so it acts as a hard cap. A claim survives the deletion of the plan it was made on. A subscription is stored once per end-user and plan, so the first beneficiary gets a subscription row and activating it for another answers `200` with `data: null` (nothing is stored beyond the claim). The response never carries another beneficiary's subscription. Organizations that never claimed, and every organization on an Application that bills per user, get no free-tier fallback. The one organization that holds the free plan's own subscription row is metered by that subscription like any subscriber, its USAGE price included. The body of a `200` or `201` carries `activated`, true when this call activated the plan.

`POST /checkout` asks the **provider first**: it creates the hosted-checkout session, and only once the provider has answered does it upsert the local `PENDING` Subscription (so the row can correlate the eventual webhook). Nothing local is written for a checkout the provider refused. Returns the URL to redirect to and the local Subscription row. **Subscription activation happens via the provider's webhook — not synchronously here.**

A provider refusal answers **`502 BILLING_PROVIDER_ERROR`**. This is the public surface, so the caller is the operator's *customer*: the message says only that the provider refused and who to contact, never the provider's own text or any fragment of the operator's credential. The provider's message goes to the server log against the response's `requestId`. See [errors.md](errors.md).

If the user already started checkout for the same plan and bailed, repeated calls **reuse the existing PENDING row** rather than creating parallel ones. The unique constraint is `(applicationId, endUserId, planId)`. An already-entitled row (`ACTIVE`/`PAST_DUE`) is **not** reset to `PENDING` — opening a checkout is not an event that removes entitlement.

## SDK usage

```ts
// Pricing page (server-side render)
const FREE_PLAN_SLUG = 'free'; // your billingConfig.defaultPlanSlug

export async function pricingPage(country: string) {
  const { items: plans, page } = await rekey.billing.getPlans(undefined, { country });
  // → {
  //     items: [{ slug: 'pro_monthly', interval: 'MONTH', isFree: false,
  //               price: { currency: 'USD', amount: 999, formatted: '$9.99', reason: 'default', ... }, ... }],
  //     page:  { total: 4, limit: 50, offset: 0, hasMore: false }
  //   }
  // Every list endpoint returns this envelope. `page.hasMore` is how you learn
  // the response was a window and not the whole catalogue: pass
  // `{ offset: page.offset + page.limit }` for the next one.
  // Hide plans checkout would refuse, but never the free tier: with no provider
  // connected it reads ready: false and still applies to every signed-in user.
  const shown = plans.filter((p) => p.slug === FREE_PLAN_SLUG || p.checkout.ready);
  return { shown, hasMore: page.hasMore };
}
```

```ts
// Gate one feature without fetching the rest
export async function projectLimit(userAccessToken: string) {
  if (!(await rekey.billing.hasFeature(userAccessToken, 'reports'))) throw new Error('Forbidden');
  const { value } = await rekey.billing.getFeature(userAccessToken, 'projects');
  return value;
}

// The signed-in user's licences (no raw keys, just keyPrefix)
export async function licences(userAccessToken: string, organizationId: string) {
  const { items: mine } = await rekey.licenses.listMine(userAccessToken);
  // ...plus one organization's pooled licences (member-only, else 403 ORGANIZATION_NOT_MEMBER)
  const { items: team } = await rekey.licenses.listMine(userAccessToken, undefined, { organizationId });
  return { mine, team };
}
```

```ts
// User clicks "Subscribe"
export async function subscribe(userAccessToken: string) {
  const checkout = await rekey.billing.createCheckout(userAccessToken, {
    planSlug: 'pro_monthly',
    successUrl: 'https://yourapp.com/billing?status=ok',
    cancelUrl: 'https://yourapp.com/billing?status=cancel',
  });
  // checkout.price is the price charged. checkout.priceFallback is set when it
  // is the default price because the selected one could not be charged.
  return redirectTo(checkout.url);
}
```

```ts
// Account page.
//
// `includeEnded` because a billing page has to answer "what happened to my
// subscription", not only "am I entitled". Without it this returns null the
// moment a subscription reaches CANCELED, and a customer who cancelled last
// month sees the same page as one who never subscribed. The flag can only turn
// a null into a row (a live subscription is still the one returned), so it is
// safe to add to a call you already make. Leave it OFF where you are deciding
// access.
export async function accountPage(userAccessToken: string) {
  const sub = await rekey.billing.getSubscription(userAccessToken, { includeEnded: true });
  if (sub === null) {
    return 'upsell'; // the user has not subscribed
  }
  if (sub.status === 'ACTIVE') {
    // gate features on sub.planId (cancelAt set = cancelling, still entitled).
    // sub.price?.formatted is what they pay each period.
    return 'active';
  }
  // CANCELED / EXPIRED: say what they were on and when it ended, and offer a
  // way back. Do NOT treat this as entitled.
  return 'ended';
}
```

## Refunds

An operator refunds any recorded payment, in full or in part, through Rekey.
Rekey asks the provider that took the payment to pay the money back, then
records the refund.

```
GET   /api/v1/tenant/applications/:id/payments                       billing:read
GET   /api/v1/tenant/applications/:id/payments/:paymentId            billing:read
GET   /api/v1/tenant/applications/:id/payments/:paymentId/refunds    billing:read
POST  /api/v1/tenant/applications/:id/payments/:paymentId/refunds    billing:write   { amount?, reason?, idempotencyKey? }
```

The reads take an operator session or an operator token with the `read`
scope. Issuing a refund takes an operator session only: a token is refused
with `OPERATOR_TOKEN_NOT_ACCEPTED`, so a refund is issued from the panel or
by a caller signed in as an operator.

```ts
import { formatMoney } from '@rekey.dev/node';

// Whether Rekey can refund it, known before anything is asked of a provider.
const before = await operator.payments.get('pay_123');
if (!before.refundable) throw new Error(`Not refundable: ${before.refundBlockedReason}`);

console.log(formatMoney(before.refundedAmount, before.currency), before.status); // '$5.00' 'PARTIALLY_REFUNDED'

// Every refund of a payment, oldest first.
const { items } = await operator.payments.refunds.list('pay_123');
for (const each of items) console.log(each.id, each.initiatedBy, formatMoney(each.amount, each.currency));
```

- **Whether it can be refunded.** A payment, read on its own or in the list,
  carries `provider` (who took it), `refundable` and `refundBlockedReason`.
  `refundable` is the judgement the refund route makes before it asks a
  provider, so a control can be disabled up front with the reason on it. The
  provider can still refuse a refund that Rekey would send. The reasons:

  | `refundBlockedReason` | Meaning | What the refund route answers |
  |---|---|---|
  | `payment_not_succeeded` | The payment is pending or failed: nothing was collected. | `BILLING_PAYMENT_NOT_REFUNDABLE` (409) |
  | `no_provider_charge_id` | No provider charge id was recorded for it. | `BILLING_PAYMENT_NOT_REFUNDABLE` (409) |
  | `already_refunded` | All of it has been refunded. | `BILLING_PAYMENT_ALREADY_REFUNDED` (409) |
  | `provider_unknown` | Rekey has no record of which provider took it. | `BILLING_PAYMENT_NOT_REFUNDABLE` (409) |
  | `provider_cannot_refund` | Rekey cannot issue refunds through that provider (the external provider). | `BILLING_REFUND_UNSUPPORTED` (409) |
  | `provider_not_configured` | That provider has no credentials on the Application now. | `BILLING_CREDENTIALS_NOT_CONFIGURED` (400) |

  `refundBlockedReason` is null exactly when `refundable` is true.
  `refundBlockedMessage(reason)` from `@rekey.dev/node` is the sentence for a
  person.
- **Amount.** An integer in the minor unit of the payment's currency. A refund
  is always in the payment's currency. A payment can be refunded more than
  once, up to its amount. More than what remains is refused with
  `BILLING_REFUND_AMOUNT_EXCEEDED`, and a payment already refunded in full
  with `BILLING_PAYMENT_ALREADY_REFUNDED`.
- **Repeating a request is safe.** Without `idempotencyKey`, the key sent to
  the provider is derived from the payment, the total already refunded and the
  amount. The same call made twice is one refund. A second partial refund of
  the same amount, made after the first is recorded, is another.
- **`refundedAmount`.** Every payment carries it: the sum of its refunds that
  have not failed, `0` when nothing was refunded. A failed refund counts for
  nothing. The payment's `status` becomes `PARTIALLY_REFUNDED` or `REFUNDED`.
- **Who started it.** `initiatedBy` is `operator` for a refund issued through
  Rekey, `provider` for one made in the provider's dashboard and reported by
  webhook, and `system` for one Rekey issued itself. A refund Rekey issued and
  then hears about from the provider is recorded once.
- **What it does not do.** Refunding does not cancel a subscription and does
  not take back credits or licences.
- **Where it is announced.** Each refund sends the outbound webhook
  `payment.refunded` ([webhooks.md](webhooks.md#payments)) and is written to
  the [billing log](billing-log.md) as `payment.refunded`.

The refund codes (`BILLING_PAYMENT_NOT_REFUNDABLE`, `BILLING_REFUND_UNSUPPORTED`,
`BILLING_REFUND_REJECTED`, `BILLING_REFUND_EXCEEDS_PAYMENT`, `PAYMENT_NOT_FOUND`)
are in [errors.md](errors.md#billing-money-model). From a terminal:
`rekey payments show <paymentId> --app <id>` and `rekey refunds list
<paymentId> --app <id>`. On the operator MCP server: `get_payment`,
`list_payment_refunds` and `create_refund`. The provider facts under
[Things that will surprise you](#things-that-will-surprise-you) apply to every
refund: fees are not returned, the first answer is not the outcome, and refund
windows close.

## Stats per currency

`GET /api/v1/tenant/applications/:id/billing/stats` reports money per currency
and never adds two currencies together. There is no converted total and no
single headline number.

```ts
import { formatMoney } from '@rekey.dev/node';

const stats = await operator.billing.stats();

console.log(stats.reportingCurrency); // the first entry of every list below
for (const row of stats.mrr) {
  console.log(row.currency, formatMoney(row.mrrCents, row.currency), row.activeSubscriptions);
}
for (const row of stats.revenueLast30d) {
  console.log(row.currency, formatMoney(row.grossCents, row.currency), formatMoney(row.refundedCents, row.currency), formatMoney(row.netCents, row.currency));
}
for (const series of stats.monthlyRevenue) {
  console.log(series.currency, series.months.length); // 12 UTC calendar months, oldest first
}
for (const row of stats.unverified) {
  console.log('Waiting to be resolved:', formatMoney(row.amountCents, row.currency), row.payments);
}
```

- Every list has one entry per currency. The Application's
  [reporting currency](currencies.md#the-reporting-currency) comes first and is
  present even at zero. The others follow by code.
- `unpricedLiveSubscriptions` counts the ACTIVE, TRIALING and PAST_DUE
  subscriptions that record no price of their own although their plan has a
  flat price. Each reads `price: null` in
  `GET /api/v1/tenant/applications/:id/end-users/:euid/billing` and is not
  counted in `mrr`. It should be zero: only a subscription to a plan with no
  flat price (a free plan, a usage plan with no base fee) goes without one.
  Granting the plan again to such a subscriber gives the subscription the
  price granted and changes nothing else. `rekey doctor` reports the count as
  `unpriced-subscriptions`.
- `mrr` counts ACTIVE subscriptions on recurring SUBSCRIPTION plans, each at
  its own price, and leaves out one with no price of its own. A yearly price counts as a twelfth, rounded down per
  subscription.
- `revenueLast30d` and `monthlyRevenue` count **verified** payments only, net
  of refunds. A refund counts against the day of the payment it refunds.
- `unverified` is money a provider charged that Rekey recorded and did not
  apply: the charge matched no subscription, or not the price it was for. It
  is never in revenue or MRR. It is not limited to 30 days, because an
  unresolved charge does not stop mattering when it ages. Extending a
  subscription from an [unapplied case](#unapplied-payments--money-we-could-not-apply)
  marks its payment verified, after which it counts as revenue.
- The field names end in `Cents` for every currency. They are minor units:
  pass them to `formatMoney` with the row's `currency`.

## Routing preview

The routing preview answers "which price and provider would a buyer in this
country get, and why" without opening a checkout. It runs the functions
checkout runs, writes nothing and calls no provider.

```
POST /api/v1/tenant/applications/:id/billing/checkout/preview    billing:read
     { country, plan?, countrySource?, endUserId?, currency?, onUnavailableCurrency?, provider?, couponCode? }
```

```ts
const preview = await operator.billing.previewRouting({ country: 'IN', plan: 'pro', couponCode: 'LAUNCH' });

for (const item of preview.items) {
  console.log(item.summary); // one sentence: who pays what, through whom, and why
  console.log(item.price?.formatted, item.provider, item.providerReason);
  if (item.priceFallback) console.log('Default price charged, not', item.priceFallback.requested.currency);
  if (item.refusal) console.log('Checkout would refuse:', item.refusal.code);
  if (item.coupon?.discount) console.log('Coupon takes off', item.coupon.discount.formatted.discount);
  if (item.coupon?.refusal) console.log('Coupon refused:', item.coupon.refusal.code);
}
```

- `plan` is a plan's id or slug. Left out, every active plan is previewed (at
  most 100).
- `countrySource` says how the checkout would learn the country: `vouched`
  (the default, a browser placed by a trusted proxy), `hint` (a browser
  stating its own country) or `declared` (your server with the secret key).
  Only a `declared` preview may name a `currency`, as at checkout.
- `providerReason` is `bound`, `named`, `country`, `only_capable` or
  `priority`.
- With `couponCode`, each item says what the coupon takes off, or the refusal
  a checkout carrying it would get, such as `COUPON_CURRENCY_NOT_COVERED`.

In the panel it is under Billing, Setup, **Routing preview**. From a terminal:
`rekey billing preview --app <id> --country IN [--plan pro] [--coupon LAUNCH]`.
On the operator MCP server it is the tool `preview_checkout_routing`.

## Usage and credits

Metered usage and prepaid credits have their own routes under `/api/v1/usage` and `/api/v1/credits`. What each credential can reach:

```
POST  /api/v1/usage/record                 secret key, billing:write
GET   /api/v1/usage/aggregate              secret key, billing:read
GET   /api/v1/usage/meters                 secret key, billing:read       meter catalogue
GET   /api/v1/usage/remaining              Application key + user JWT      the caller's quota
GET   /api/v1/usage/remaining/for-user     secret key, billing:read       a named subject's quota

GET   /api/v1/credits/balance              secret key, billing:read
GET   /api/v1/credits/ledger               secret key, billing:read
POST  /api/v1/credits/consume              secret key, billing:write
POST  /api/v1/credits/grant                secret key, credits:grant       elevated, see api-keys.md
GET   /api/v1/credits/me/ledger            Application key + user JWT      the caller's own ledger
```

### How much is left

`GET /usage/remaining` answers "how many of my included units are left this period" for the signed-in user, per meter or for one with `?meter=`:

```json
{
  "endUserId": "eu_...", "organizationId": null,
  "periodStart": "2026-09-01T00:00:00.000Z", "periodEnd": "2026-10-01T00:00:00.000Z",
  "meters": [{
    "meterSlug": "api_calls", "name": "API calls", "unit": "calls", "active": true,
    "included": 1000, "used": 940, "remaining": 60, "creditsPerUnit": null,
    "periodStart": "2026-09-01T00:00:00.000Z", "periodEnd": "2026-10-01T00:00:00.000Z"
  }]
}
```

It is computed by the same code `POST /usage/record` enforces with: the calendar month in UTC, the plan quota from the subject's live subscriptions (plus the free-tier default plan for a personal subject), and the same sum over recorded units. So a record dated now of more than `remaining` units is exactly the one that comes back `402 USAGE_QUOTA_EXCEEDED`, or, when `creditsPerUnit` is set, the one whose excess is charged in credits. `included: null` means the subject has no quota for the meter, and records are neither capped nor charged. `occurredAt` may only fall within the current UTC calendar month, up to one minute ahead of the server clock: an earlier month is refused with `400 USAGE_OCCURRED_AT_TOO_OLD` and a later time with `400 USAGE_OCCURRED_AT_IN_FUTURE`, so a record always lands in the period `remaining` describes. A record on an inactive meter is refused with `USAGE_METER_INACTIVE` whatever `remaining` says; an unknown `?meter=` is `404 USAGE_METER_NOT_FOUND`. The read takes no lock, so under concurrent records it is a snapshot. Without `?meter=` it reports up to 200 meters, oldest first; `totalMeters` and `truncated: true` say when the catalogue is larger, and the rest are read one at a time.

Whose quota: the personal one; in an Application that bills organizations (`billingSubject: "org"`), the session's active organization while the caller is still a member; or `?organizationId=` (member-only). A backend with no user token uses `/remaining/for-user?endUserId=` (or `organizationId=`, or both to read the organization as that member).

### Granting credits from your server

`POST /credits/grant` adds credits to an end-user or an organization pool, through the same ledger write as an operator grant from the panel. It needs a key minted with the elevated `credits:grant` scope; a default `*` key is refused. One call grants 1 to 1,000,000 credits, `idempotencyKey` is required (reusing one with a different amount or reason is `409 CREDITS_IDEMPOTENCY_KEY_REUSED`), and every grant is recorded in the security log against the key, in the same transaction. See [api-keys.md](api-keys.md#elevated-scopes-and-why--does-not-include-them).

```ts
import { Rekey } from '@rekey.dev/node';

const granter = new Rekey({ apiUrl: process.env.REKEY_URL!, secretKey: process.env.REKEY_GRANT_KEY! }); // minted with credits:grant

export async function rewardReferral(endUserId: string, referralId: string) {
  await granter.credits.grant({ endUserId, amount: 500, idempotencyKey: `referral:${referralId}` });
}
```

### The caller's own ledger

`GET /credits/me/ledger` pages through the signed-in user's own ledger, newest first, with the same subject rules as `/usage/remaining`. Entries omit `metadata`, which the operator and your backend write for their own use; the secret-key `GET /credits/ledger` still returns it. Credit changes are also announced as `credit.granted`, `credit.consumed` and `credit.adjusted` webhooks, see [webhooks.md](webhooks.md#credits).

```ts
// Browser, with the publishable key
const { meters } = await client.getUsageRemaining(accessToken, { meter: 'api_calls' });
const { items } = await client.listMyCreditLedger(accessToken, { limit: 20 });
```

## Subscription state machine

```
              checkout            provider webhook            provider event
PENDING ─────────────────────────> ACTIVE ──cancel──> CANCELED
                                     │
                                     ├──payment-fail──> PAST_DUE ──retry-ok──> ACTIVE
                                     │                       │
                                     │                       └──end-of-period──> EXPIRED
                                     │
                                     └──end-of-period──> EXPIRED
```

All of these transitions are live. Checkout creates the `PENDING` row; the signed provider webhook path (see below) is what flips it to `ACTIVE` and drives every later transition (`PAST_DUE`, `CANCELED`, `EXPIRED`).

## Dunning — failed-payment recovery

When a subscription transitions to `PAST_DUE`, Rekey opens a **dunning case** (`DunningCase` row) that tracks the recovery and notifies the end-user. One case per PAST_DUE trip; at most one OPEN case per subscription.

**What's provider-driven vs what Rekey automates — read this first:**

- **The provider owns the actual card retries.** Stripe Smart Retries re-attempts the charge on Stripe's own schedule (each attempt arrives at Rekey as another `invoice.payment_failed` or, on success, `invoice.paid`); PayPal retries a `SUSPENDED` subscription similarly. Rekey **never re-charges a payment method itself** — there is no retry policy to configure here.
- **Rekey owns the state machine, the reminder emails, and the events.** The case is the operator's single source of truth for "who is in recovery, since when, how many failures, what happens next."

**Schedule** (all offsets relative to the case's `openedAt`):

| When | Action |
|---|---|
| Day 0 (case opens) | Reminder email #1 to the end-user + `dunning.case_opened` outbound event |
| Day 3 | Reminder email #2 |
| Day 7 | Reminder email #3 |
| Day 14, no recovery | Case → `EXHAUSTED`; subscription is set `CANCELED` locally, a provider-side cancel is attempted where a provider subscription exists, and `subscription.canceled` + `dunning.case_exhausted` are emitted |

Reminder emails go through the **per-Application email system** (event key `billing_payment_failed_reminder` — customizable in Panel → Application → Email like any other transactional template). No transport configured → the send is logged as `no_transport` and the schedule still advances; the case, not the inbox, is the source of truth.

**Recovery & closure:** a later successful payment (`invoice.paid` / `PAYMENT.SALE.COMPLETED`) or a provider reactivation closes the case as `RECOVERED` and emits `dunning.case_recovered`. If the subscription is canceled while in dunning (end-user portal cancel, provider cancel), the case closes as `CANCELED` silently — the accompanying `subscription.canceled` event already announced it.

**EXHAUSTED behavior:** exhaustion is terminal. The subscription is canceled both locally and (best-effort) provider-side via the same `BillingProvider.cancelSubscription` path the portal uses; a provider API error does not block the local cancel — the provider has already failed to collect for 14 days. Re-subscribing means a fresh checkout.

**Scheduling/ops:** a 10-minute in-process poller (`processDueDunningCases`, registered in `app.ts` like the webhook retry poller) advances OPEN cases whose `nextActionAt` has passed. Each case is claimed with an atomic guarded update, so running multiple API replicas never double-sends a reminder or double-exhausts.

**Operator visibility:** `GET /api/v1/tenant/applications/:id/dunning` (filter `?status=`, paginated/sortable like `/payments`), plus the Billing → Dunning tab and the "Dunning" tile on the revenue overview in the panel.

## Unapplied payments — money we could not apply

Sometimes a provider captures money for something Rekey never applied. The
buyer's checkout completed at the provider **after** Rekey had stopped waiting
for it, or two checkouts raced and only one won. The money is real, the
customer is real, and nothing was provisioned.

Rekey records these as an **unapplied payment** (`UnappliedPayment` row). The
definition is exact:

> a `Payment` with `status = SUCCEEDED` and `subscriptionId IS NULL`

A charge that reaches a subscription but does not match it is treated the same
way. A renewal is applied only when it is in the currency of the price the
subscription is on, below 100 times that price, and for a provider price that
belongs to the same plan; a one-time purchase only at exactly the amount its
checkout was opened at. Anything else is recorded as a payment with
`verification: "unverified"`, linked to no subscription (the end user is kept),
and opens an unapplied case. Nothing is granted for it, and it is in no revenue
figure. The [billing log](billing-log.md) has the reason, as
`payment.not_applied`. No verified charge is ever dropped.

"Unapplied" is the term the wider billing and accounting world uses for
received money that cannot be matched to what it was meant to pay for (Zuora,
Maxio, Oracle, QuickBooks). If you have a finance person, they already know it.

### Rekey never refunds one automatically

This is the central design decision and it is deliberate. Auto-refunding
anything unmatched would be wrong in the common case: most of these buyers
**received the service they paid for** through a path we lost track of, and
silently reversing the charge takes away something they are actively using. The
operator knows things Rekey does not.

Leaving the money unflagged would be worse than either, though — an unresolved
case does not stay neutral. Both scenarios that produce one map to named
card-network reason codes with roughly 120-day issuer filing windows (Visa
12.6.1 "Duplicate Processing", Visa 12.6.2 "Paid by Other Means", Mastercard
4834), and refund windows close on their own schedule. So the queue is
**ordered oldest first**, which is the opposite of every other list in the
panel, and the age column turns red past 90 days.

### The three dispositions

Panel → Application → **Unapplied**. Each open case offers exactly three
outcomes, and a case can be resolved only once — the second attempt answers
`409 UNAPPLIED_PAYMENT_ALREADY_RESOLVED`, which is what stops a double-click
paying a buyer back twice.

| Action | What happens | API |
|---|---|---|
| **Refund** | A real refund at the provider, then the case closes. Partial amounts supported; blank means everything not already refunded. | `POST /api/v1/tenant/applications/:id/unapplied-payments/:caseId/refund` |
| **Extend** | Keep the money, add days to the customer's current subscription period, re-provision entitlements. | `…/:caseId/extend` |
| **Close** | Move nothing. For cases settled somewhere Rekey cannot see. **Note required.** | `…/:caseId/dismiss` |

The refund is issued **before** the case is marked resolved, and only marked
resolved if the provider accepted it. The other order produces the worst state
this feature can reach: a case claiming the buyer was refunded when they were
not, which nothing will ever revisit because it has left the queue.

**Extend has no precedent among billing vendors** — Stripe, Chargebee, Recurly
and Zuora all credit *money*. Crediting service is also the cleaner outcome in
the books: you deliver what was paid for, so revenue recognises normally
instead of parking a liability. It needs Rekey to know who paid; an
unattributable payment answers `409 UNAPPLIED_PAYMENT_UNATTRIBUTED`.

### Things that will surprise you

- **Provider fees are not returned on a refund.** None of the three reverse
  them — PayPal since October 2019, and Razorpay keeps MDR plus 18% GST. A
  refund costs you the original processing fee. This is a real input to
  refund-versus-extend.
- **The refund response is not the outcome.** Razorpay creates every refund
  `pending` and reports the result later on `refund.processed`; PayPal returns
  PENDING for eCheck-funded refunds. Rekey records what the provider said at
  create time and waits for the webhook.
- **Refund windows close.** PayPal refuses past **180 days**
  (`REFUND_NOT_ALLOWED_AFTER_180_DAYS`); Razorpay past **six months**. Stripe
  documents no limit. Past the window the money cannot be moved back at all and
  extending is the only lever left.
- **Refunding never cancels the subscription.** Separate call at all three
  providers.
- **Attribution is best-effort.** When a charge matches no subscription, Rekey
  looks for the checkout breadcrumb (`unappliedCompletions`) to work out who
  paid. It reports `unknown` rather than guessing — attributing a stranger's
  money to the wrong customer is worse than admitting we do not know.

### Notification

Opening a case emails the workspace **owners** (admins if there is no owner),
using event key `billing_unapplied_payment` — customisable in Panel →
Application → Email like any other template. It is the only operator-addressed
template in that list. If no transport is configured the send is logged and the
case still stands; the queue, not the inbox, is the source of truth.

### A note on Razorpay

Before this existed, an unmatched Razorpay payment was **dropped entirely** —
no `Payment` row, no log, nothing. Every provider now records a succeeded
charge whether or not it matched, which is what Stripe and PayPal already did.
If you run Razorpay and have been live for a while, expect the first sync of
this queue to surface historical money you could not previously see.

## Webhooks — two directions, don't conflate them

Rekey is in the middle of **two separate webhook flows**, and they have nothing in common beyond the word "webhook":

| | Sender → Receiver | Who verifies the signature | Who configures it | Events |
|---|---|---|---|---|
| **(a) Outbound** | Rekey → **your app** | **You**, with `verifyWebhookSignature` from `@rekey.dev/node` | You: Panel → Application → Webhooks (or `POST /api/v1/tenant/applications/:id/webhooks`) | `user.created`, `user.updated`, `user.deleted`, `session.revoked`, `mfa.enabled`, `mfa.disabled`, `password.changed`, `email.verified`, `subscription.activated`, `subscription.canceled`, `subscription.past_due`, `payment.succeeded`, `payment.failed`, `payment.refunded`, `dunning.case_opened`, `dunning.case_recovered`, `dunning.case_exhausted` |
| **(b) Provider** | Stripe/PayPal → **Rekey** | **Rekey**, against the per-Application provider webhook secret | Operator: provider dashboard endpoint + secret pasted into Panel → Application → Billing | Provider events (`checkout.session.completed`, `invoice.paid`, …) that drive the subscription state machine |

`verifyWebhookSignature` is **only** for direction (a). Your application code never receives or verifies a Stripe/PayPal webhook — that traffic terminates at Rekey.

### (a) Webhooks Rekey sends to YOUR app

Register an endpoint (URL + event list, `"*"` for all) in the panel or via `POST /api/v1/tenant/applications/:id/webhooks`. The response includes the endpoint's signing `secret` exactly once — store it (e.g. as `REKEY_WEBHOOK_SECRET`).

Every delivery is a JSON envelope `{ eventId, occurredAt, type, applicationId, data }`, signed with a `t=<unix-ts>,v1=<hmac-sha256-hex>` header named `X-Rekey-Signature`. Verify it against the **raw body bytes** before trusting anything:

```ts
import { verifyWebhookSignature } from '@rekey.dev/node';
import type { PaymentWebhookData, WebhookEventEnvelope } from '@rekey.dev/node';

// Any framework works as long as you keep the RAW body.
export async function handleRekeyWebhook(rawBody: string, signatureHeader: string | null): Promise<number> {
  const ok = verifyWebhookSignature({
    header: signatureHeader, // the X-Rekey-Signature header
    payload: rawBody, // raw bytes: reserialized JSON breaks the HMAC
    secret: process.env.REKEY_WEBHOOK_SECRET!,
  });
  if (!ok) return 401;

  const event = JSON.parse(rawBody) as WebhookEventEnvelope<unknown>;
  // Failed deliveries are retried with backoff and REUSE the same eventId.
  // Dedupe on it (one cheap upsert) before acting.
  if (event.type === 'payment.refunded') {
    const { payment, refund } = event.data as PaymentWebhookData;
    console.log(event.eventId, payment.id, payment.refundedAmount, refund?.amount);
  }
  return 200;
}
```

Failed deliveries retry with exponential backoff (30s → 2m → 10m → 1h → 4h, ~5h total); the panel shows delivery history per endpoint, and you can force a retry from there (or via `POST /api/v1/tenant/applications/:id/webhooks/:endpointId/deliveries/:deliveryId/retry`).

The canonical event list ships in code as `WEBHOOK_EVENTS` (an array of `{ name, description }`) and `KNOWN_WEBHOOK_EVENTS` (just the names) from `@rekey.dev/node` / `@rekey.dev/shared-types`, with the `WebhookEventType` union and `WebhookEventEnvelope<TData>` envelope type — use them to autocomplete an endpoint's `events` array or render an event picker.

> The outbound registry covers the auth/user lifecycle **and** the billing lifecycle: `subscription.activated` / `subscription.canceled` / `subscription.past_due` fire when a provider webhook actually transitions the local Subscription's status, and `payment.succeeded` / `payment.failed` fire when a Payment row is recorded. Payloads carry the ids, plan slug, and amount/currency/status under `data.subscription` / `data.payment`. Events are emitted only on a real state change — a replayed provider event that changes nothing emits nothing — but a provider retry after a 5xx on Rekey's side may re-emit, so **dedupe on the envelope's `eventId`** (which retried deliveries reuse) before acting.
>
> `data.subscription.entitlements` carries what that subscription grants — the same array shape `GET /api/v1/billing/entitlements` returns, with the subscription's `entitlementOverrides` already applied. Provision against it rather than against `planSlug`: an override is how a bespoke quantity is sold without minting a private plan, so two subscribers on the same plan can be entitled to different amounts and the slug cannot tell you which.
>
> `data.subscription.amount` and `currency` are the subscription's own price: what this subscriber pays, which can differ from the plan's default price. A subscription with no price of its own carries `amount: 0` and `currency: null`. `data.payment` carries `refundedAmount` and `verification`, and `payment.refunded` adds `data.refund`. The full shapes are in [webhooks.md](webhooks.md#payments).
>
> The field `entitlements` is **absent** when Rekey could not resolve it while recording the event. Absent is not empty: do not provision `0` from it, keep what the customer has and read the current grant instead. An empty array does mean the subscription grants nothing.
>
> ```ts
> // "How many widgets did this customer buy?" — plan default, or their override.
> const { entitlements } = event.data.subscription;
> if (entitlements === undefined) return; // unknown, not zero: leave provisioning as it is
> const seats = entitlements.find((e) => e.kind === 'FEATURE' && e.key === 'max_widgets');
> const allowance = seats?.valueType === 'INT' ? Number(seats.value) : 0;
> ```

### (b) Provider webhooks (Stripe/PayPal) that REKEY receives

This is the flow that activates subscriptions. **Your application code plays no part in it** — you never write a handler for these and never see the payloads. As an operator you configure it once per Application: register the endpoint URL in the provider's dashboard and paste the signing secret into the panel (or let Rekey auto-register it where supported); Rekey does all verification and processing.

`POST /api/v1/billing/webhook/stripe/<app-slug>` is live. It is **per-Application only** — there is no deployment-wide endpoint or shared `STRIPE_WEBHOOK_SECRET` (a shared signing secret would be a cross-tenant trust boundary; see decisions.md 2026-05-27). PayPal works the same way (`/webhook/paypal/<app-slug>`).

```
Stripe ──signed event──> Rekey  (POST /webhook/stripe/<app-slug>)
                            │
                            ├─ resolve Application by slug; load its BYO webhook secret (none → 503)
                            ├─ verify HMAC against THAT app's webhook secret (bad → 401)
                            ├─ insert WebhookEvent row (P2002 = dup, skip)
                            ├─ translate via providers/modules/stripe/index.ts
                            └─ persist processed_at OR processing_error
                            ▼
                       always returns 200 (after sig check)
```

The signature is the auth — no `Authorization` header on this route. The raw body is preserved by `fastify-raw-body` (HMAC verification breaks if you reserialize the JSON).

**Application identification.** The app is identified by the URL slug, and the slug is trusted because the signing secret that validated the request is that app's own — a Stripe account can't sign payloads for another app's endpoint. (The dispatch handler still reads `metadata.applicationId` to scope its DB writes; Rekey-created checkout sessions and subscriptions embed it, and an invoice is routed by the subscription metadata Stripe snapshots onto it.)

**Today's coverage:**

| Event | Effect |
|---|---|
| `checkout.session.completed` | Local PENDING Subscription matched on `metadata.checkoutSessionId` → ACTIVE; persists `providerSubId`. Skipped when `payment_status` is `unpaid` (a delayed payment method) |
| `checkout.session.async_payment_succeeded` | The same activation, for a delayed payment method once its money arrives |
| `checkout.session.async_payment_failed` | A delayed payment method's money did not arrive: the checkout is closed and its coupon and trial reservations are released, so the buyer can start another. Nothing was activated |
| `customer.subscription.updated` | Mirrors status, currentPeriodEnd, cancelAt, canceledAt |
| `customer.subscription.deleted` | → CANCELED |
| `invoice.paid` / `invoice.payment_succeeded` | Inserts SUCCEEDED Payment + ensures Subscription ACTIVE |
| `invoice.payment_failed` | Inserts FAILED Payment + sets Subscription PAST_DUE |
| `charge.refunded` | Records each refund against the matching Payment as a refund record, sets the Payment's `refundedAmount` to the sum of its refunds that have not failed and its status to PARTIALLY_REFUNDED or REFUNDED, and sends `payment.refunded`. Matched by the charge's invoice (a subscription charge) or payment intent (a one-time checkout); in the basil-or-later shape a charge with no Rekey metadata has its invoice looked up through Stripe's Invoice Payments API. Entitlements are not revoked. Disputes are not consumed |
| anything else | Logged + recorded as processed (no-op) |

**Invoice routing.** A subscription invoice does not carry Rekey's
`applicationId` on its own `metadata`; Stripe snapshots the subscription's
metadata onto it (`parent.subscription_details.metadata`, or
`subscription_details.metadata` on acacia endpoints), and Rekey routes
`invoice.paid` and `invoice.payment_failed` by that snapshot when the invoice
has none of its own. That is what records renewal payments and opens dunning
for Stripe subscriptions.

- Renewals from before this release are not backfilled: Stripe already
  delivered those events and Rekey acknowledged them, so they stay unrecorded.
  Resending one from the Stripe dashboard does not help either, because the
  resend carries the same event id and Rekey skips it as a duplicate.
- Stripe retries a failed renewal on the same invoice. Each failed attempt
  counts on the open dunning case, and when a retry succeeds the invoice's
  FAILED payment becomes SUCCEEDED, the subscription returns to ACTIVE and
  the case closes as recovered.
- A subscription's first invoice can arrive before `checkout.session.completed`
  (or, for a delayed payment method, before
  `checkout.session.async_payment_succeeded`). Until the checkout links the
  subscription, that invoice answers 500 and Stripe redelivers it. After 24
  hours (by the event's `created` time) it stops waiting and is filed as an
  unapplied payment, so a checkout that never reached Rekey still reaches the
  operator.
- A first invoice that charged nothing (a trial's) records no payment. A $0
  renewal (covered by a customer balance or a 100%-off coupon) records a $0
  SUCCEEDED payment and sends `payment.succeeded` with amount 0, because that
  is what refills credits and extends a TIMED licence for the new period. A
  payment never ends a trial; the status mirror does.
- A failed payment for a canceled or expired subscription is recorded, but it
  does not move the subscription to PAST_DUE or open dunning.

**Applications sharing one Stripe account.** A Stripe webhook endpoint
receives every event in its account. When two Applications use the same
Stripe account, each one's endpoint also receives the other's checkout,
subscription and (now) invoice events, signed with its own secret but naming
the other Application. Rekey answers those `400 WEBHOOK_APPLICATION_MISMATCH`,
applies nothing, and records why on the receipt; the other Application's own
endpoint receives the same event and applies it. Stripe retries the refused
deliveries and shows them as failures on the endpoint. To avoid the noise,
give each Application its own Stripe account (or sandbox), which also keeps
their payouts and disputes apart.

**Mode.** A Stripe event carries `livemode`. One that contradicts the mode of
the credential that verified it (a live event under test keys, or the reverse)
is recorded on its receipt, answered `409 WEBHOOK_MODE_MISMATCH`, and not
applied. It means the saved signing secret belongs to the other mode's
endpoint. The receipt stays unprocessed, so once the credential is corrected,
Stripe's next retry of the event applies it.

**Stripe API version.** Rekey's Stripe client speaks `2026-09-30.endive`
(`STRIPE_API_VERSION` in `providers/stripe-api-version.ts`, on `stripe@^23`),
and the endpoint it registers is pinned to the same version, so events arrive
in the shape Rekey reads. An endpoint registered by an earlier Rekey is pinned
to `2024-11-20.acacia`, and one created by hand without choosing a version
delivers in the Stripe account's default. Rekey reads both the acacia shape
and the basil-or-later one (`2025-03-31.basil` moved the subscription's
`current_period_end` onto its items, an invoice's subscription and its
metadata onto `parent.subscription_details`, and removed the invoice from a
charge), so those endpoints keep working. For a refunded charge in the newer
shape, Rekey asks Stripe's Invoice Payments API, with the Application's own
key, which invoice the charge paid; if Stripe cannot be reached the event
answers 500 and Stripe retries it.

Re-register anyway (Panel → Application → Billing → Setup → Providers,
**Auto-configure** on the Stripe row) to pin the version and to subscribe
`checkout.session.async_payment_succeeded`, without which a buyer who pays by
a delayed method is never activated, and `charge.refunded`, without which a
refund made in the Stripe dashboard never reaches Rekey's books. A hand-made
endpoint should pick `2026-09-30.endive` and subscribe the events in the table
above.

See `apps/api/src/modules/billing/webhooks/` for the full module rules.

### (c) Your own billing system posting to Rekey

When the sale happens in a system Rekey never called (your own billing stack,
an invoicing tool, a marketplace), that system posts signed events to
`POST /api/v1/webhooks/billing/external/<app-slug>` and Rekey activates,
renews and cancels the subscription from them, creating the end-user when it
has not seen them yet. Same pipeline, same appliers, same outbound events as
(b). See [Bring your own billing](external-billing.md).

## Caching entitlements

`billing.getEntitlements(accessToken)` resolves feature flags + limits + the live credit balance from active subscriptions. Hitting it on every request adds a network round-trip to every page load, but caching it forever serves stale plans after an upgrade. The recommended middle:

- **Cache per subject with a ~5-minute TTL** — key on `(endUserId)` or `(endUserId, organizationId)` when the user has an active org. Five minutes bounds how long a plan change can be invisible while absorbing nearly all of the read traffic.
- **Serve stale-while-revalidate** — answer from cache immediately and refresh in the background when the entry is past TTL. Entitlement checks are on the hot path; a synchronous re-fetch on expiry shows up as p99 latency.
- **Bust the cache on checkout success** — when the user lands on your `successUrl`, drop the cache entry and re-fetch so the just-purchased plan is visible on the very next render. (Activation arrives via the provider webhook a moment after redirect, so if the first re-fetch still shows the old plan, retry for a few seconds.) For a push-based invalidation, subscribe to the outbound `subscription.activated` / `subscription.canceled` / `subscription.past_due` events and drop the entry when one arrives.
- **Don't cache `creditBalance` for spend decisions** — the credits API is its own atomic guard (`CREDITS_INSUFFICIENT` on overdraw); use the cached balance for display only.

```ts
import type { EntitlementsDto } from '@rekey.dev/node';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: EntitlementsDto; fetchedAt: number }>();
const cacheKeyFor = (userId: string, orgId?: string) => (orgId ? `${userId}:${orgId}` : userId);

async function entitlementsFor(userId: string, accessToken: string, orgId?: string) {
  const key = cacheKeyFor(userId, orgId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.value;

  const fresh = rekey.billing
    .getEntitlements(accessToken, orgId ? { organizationId: orgId } : undefined)
    .then((value) => (cache.set(key, { value, fetchedAt: Date.now() }), value));

  // SWR: serve the stale value if we have one; otherwise wait.
  return hit ? (void fresh, hit.value) : fresh;
}

// On the checkout success route: drop the entry, then re-fetch and retry until the new plan shows.
export function onCheckoutSuccess(userId: string, orgId?: string) {
  cache.delete(cacheKeyFor(userId, orgId));
}
```

(Use your shared cache — Redis with `EX 300` — instead of an in-process `Map` when you run multiple replicas.)

## What's deliberately not here yet

- **Provider-side overage billing.** Usage is metered + hard-capped in-house (record-time enforcement; 402 `USAGE_QUOTA_EXCEEDED` past the included quota), but charging consumption *past* the quota back through a provider invoice-item / usage push is a later `BillingProvider` method.
- **Tiered pricing.** A plan has one price per currency. Tiered prices and tiered metered overage are not built.
- **Currency conversion.** Nothing is converted. Totals are reported per currency (see [currencies.md](currencies.md#the-reporting-currency)).
- **Per-seat pricing.** A licence checkout has quantity 1 at every provider.
- **Proration and mid-cycle plan changes.** Refunds are built (see [Refunds](#refunds)); these are not.
- **Disputes.** A dispute at a provider is not recorded as its own record.
- **Taking entitlements back on refund.** A refund does not revoke credits or licences.
- **Tax computation.** Provider-handled (Stripe Tax) or external (TaxJar). Not our scope.
- **PCI card vault.** Provider-handled. Rekey never sees card numbers.
