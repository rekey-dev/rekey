# Adding a billing provider

Rekey ships with Stripe, PayPal, and Razorpay, plus an inbound-only module
for a billing system of your own (see [Bring your own billing](external-billing.md)).
If your processor isn't one of those, you add it as a **provider module**: one directory in the API that
describes everything Rekey needs — how to create checkouts, how to verify the
processor's webhooks, and how its events map onto Rekey's subscription state
machine. The registry derives the rest: routes, validation, credential
handling, and the panel's configuration form.

> **Status**: fully landed — the module interface, shared webhook pipeline,
> generic credentials service, and discovery-driven panel/SDK labels are all
> merged. All three built-in providers (Stripe, PayPal, Razorpay) run through
> this system in production.

> **Before you ship one**: the ordinary test suite replaces every provider with
> a fake, so a module that passes it has only been checked against our own
> reading of the processor's semantics. Add a suite under
> `apps/api/test-providers/` that drives your processor's real sandbox, and see
> [Testing against a real payment provider](./provider-sandbox-testing.md).

## The shape of a module

A module lives at `apps/api/src/modules/billing/providers/modules/<name>/` and
default-exports a `ProviderModule`:

<!-- snippet: no-check `ProviderModule` is a type inside the API, not exported by a package -->
```ts
const mollie: ProviderModule = {
  name: 'mollie',
  display: {
    label: 'Mollie',
    docsUrl: 'https://docs.mollie.com/…',
    defaultCountries: ['NL', 'BE', 'DE'],   // feeds the geo router
    supportedCurrencies: ['EUR', 'GBP', 'USD'],  // every currency the processor can charge
    preselectedCurrencies: ['EUR'],              // what a new account starts with; never empty
    priority: 50,
  },
  capabilities: {
    checkout: true,            // buyers can be sent here to pay (false = inbound only)
    oneTime: true,             // supports one-time checkouts
    captureStep: false,        // no separate capture call needed
    autoWebhookRegister: true, // can create its own webhook endpoint via API
    periodRotationEvents: true,// emits a native "period renewed" event
    onlineVerify: false,       // signature check is offline (HMAC)
  },
  credentialSchema: [
    { key: 'apiKey', label: 'API key', secret: true,
      pattern: { prefix: 'live_', message: 'Live API keys start with live_' } },
    { key: 'webhookSecret', label: 'Webhook secret', secret: true,
      webhookRole: 'secret' },
  ],
  webhook: {
    resolveApplication,  // which Application does this event belong to?
    verify,              // is this really from the processor?
    extractEventId,      // idempotency key — replays are acked, not re-applied
    translate,           // processor event → normalized Rekey events
  },
};
```

Two halves:

**Outbound** is NOT part of the module. Providers are constructed by
`getProviderForApplication` in `providers/index.ts`, which returns the existing
`BillingProvider` interface — `ensurePlanRegistered`, `createCheckoutSession`,
`createOneTimeCheckout`, `cancelSubscription`, and friends. This interface
predates the module system and is unchanged; `docs/billing.md` covers its
rules (intersection of capabilities at the top level, provider-specific data
in `metadata`).

**Inbound** (`webhook`) is what the module system added. You never write a
route, an idempotency table, or a transaction: the shared pipeline calls your
four functions and applies the results atomically. Your `translate` returns
events from a fixed set —

```
checkout.completed          checkout.approved        payment.succeeded
payment.failed              payment.refunded         subscription.activated
subscription.canceled       subscription.past_due    subscription.period_advanced
subscription.granted
```

`subscription.granted` is the activate-or-create event for a sale Rekey did
not run the checkout for: it names the plan and the subscriber (by end-user id
or by email, which core creates when unknown) instead of a checkout session.
Emit it from a module whose processor sells without a Rekey checkout, and
declare `checkout: false` so the router never sends a buyer there.

`checkout.approved` is the buyer-approved-but-not-yet-captured case: emit it
instead of `checkout.completed` when your processor separates approval from
capture (PayPal Orders v2 does — that is what `capabilities.captureStep` above
declares). Core will not provision against it.

— and core takes it from there: payment rows, subscription status, dunning,
entitlements, outbound webhooks to the operator's own endpoints. If your
processor has no native "period renewed" event (PayPal doesn't), set
`periodRotationEvents: false` and emit `subscription.period_advanced` from
whatever signal it does have.

## Currencies and amounts

A module states which currencies its processor can charge, and converts
amounts at its own edge.

- `display.supportedCurrencies` is the list the processor publishes, or
  `'all-sellable'` for every currency a price may be in. An operator chooses
  an account's currencies from it, and saving a code outside it is refused
  with `BILLING_PROVIDER_CURRENCY_NOT_OFFERED`. Routing never sends a price to
  a provider that does not list its currency. Keep three-decimal currencies
  out: a price cannot be in one.
- `display.preselectedCurrencies` is what an account can usually charge
  without further setup. An account saved without a currency list starts with
  it, and the panel ticks it for a new account. It must not be empty: a test
  fails for a module that preselects nothing, because an account saved
  without a list would then be used for no checkout.
- An account's stored list being empty means none: the provider is not used
  for any checkout. Only an operator sending an empty list stores one.

Rekey stores every amount as an integer at the ISO 4217 exponent. Processors
do not all follow ISO, so each module owns its wire scale: one function that
turns a stored amount into what the processor's API takes, and one that turns
what the processor reports back into a stored amount. See `stripe-money.ts`,
`paypal-money.ts` and `razorpay-money.ts` beside the modules. Two rules hold
for all three, and yours should keep them:

- **Refuse, never round.** An amount the processor cannot take exactly throws
  `BILLING_AMOUNT_NOT_CHARGEABLE` (the `amountNotChargeable` helper) and
  nothing is sent.
- **A webhook amount never throws.** A figure read off a webhook that is not a
  whole number of stored units is handed on as not-a-number, which the
  applier does not apply. A throw there would answer 500 and the processor
  would redeliver the same body.

[currencies.md](currencies.md#how-an-amount-is-sent-to-each-provider) lists
what the three built-in modules do.

## What you don't write

- **Routes.** `POST /api/v1/webhooks/billing/<name>` exists the moment your
  module is registered.
- **Signature-skip logic for tests.** The pipeline decides that centrally.
  Your `verify` always verifies.
- **Credential storage or forms.** `credentialSchema` drives validation, the
  encrypted storage shape, and the panel's configuration form. `secret: true`
  fields render as password inputs and are never echoed back by the API.
- **Idempotency.** The pipeline records `(provider, eventId)` and acks
  replays with a 200 before your `translate` runs twice.

## Testing your module

Two kinds of tests, both run in CI:

1. **Translate fixtures** — recorded webhook payloads from your processor,
   asserted against the normalized events they should produce. Cheap, no
   database, catch most porting mistakes.
2. **Fixture replay** — the same payloads pushed through the full pipeline,
   asserted against resulting database rows and emitted events. This is the
   suite that guarantees the three built-in providers didn't change behavior
   during the migration; yours should join it.

There's also a registry-integrity test: module `name` must equal its directory
name, and `credentialSchema` must round-trip the credential JSON the service
stores.

## What about npm plugins?

Deliberately not yet. This code path moves money and holds decrypted
processor keys, so v1 keeps providers in-tree where they get review,
typechecking against the appliers, and the fixture suite. The interface is
designed to be published as a versioned contract later — the design doc's
"Why not npm plugins yet" section has the full reasoning. If you need a
provider we don't ship, a PR that adds a module is exactly what the system
was built for.
