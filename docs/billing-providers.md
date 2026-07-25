# Adding a billing provider

ReliPay ships with Stripe, PayPal, and Razorpay. If your processor isn't one of
those, you add it as a **provider module**: one directory in the API that
describes everything ReliPay needs — how to create checkouts, how to verify the
processor's webhooks, and how its events map onto ReliPay's subscription state
machine. The registry derives the rest: routes, validation, credential
handling, and the panel's configuration form.

> **Status**: fully landed — the module interface, shared webhook pipeline,
> generic credentials service, and discovery-driven panel/SDK labels are all
> merged. All three built-in providers (Stripe, PayPal, Razorpay) run through
> this system in production.

## The shape of a module

A module lives at `apps/api/src/modules/billing/providers/modules/<name>/` and
default-exports a `ProviderModule`:

```ts
const mollie: ProviderModule = {
  name: 'mollie',
  display: {
    label: 'Mollie',
    docsUrl: 'https://docs.mollie.com/…',
    defaultCountries: ['NL', 'BE', 'DE'],   // feeds the geo router
    priority: 50,
  },
  capabilities: {
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
  createProvider,   // the outbound side: checkout, cancel, plan registration
  webhook: {
    resolveApplication,  // which Application does this event belong to?
    verify,              // is this really from the processor?
    extractEventId,      // idempotency key — replays are acked, not re-applied
    translate,           // processor event → normalized ReliPay events
  },
};
```

Two halves:

**Outbound** (`createProvider`) returns the existing `BillingProvider`
interface — `ensurePlanRegistered`, `createCheckoutSession`,
`createOneTimeCheckout`, `cancelSubscription`, and friends. This interface
predates the module system and is unchanged; `docs/billing.md` covers its
rules (intersection of capabilities at the top level, provider-specific data
in `metadata`).

**Inbound** (`webhook`) is what the module system added. You never write a
route, an idempotency table, or a transaction: the shared pipeline calls your
four functions and applies the results atomically. Your `translate` returns
events from a fixed set —

```
checkout.completed          payment.succeeded        payment.failed
payment.refunded            subscription.activated   subscription.canceled
subscription.past_due       subscription.period_advanced
```

— and core takes it from there: payment rows, subscription status, dunning,
entitlements, outbound webhooks to the operator's own endpoints. If your
processor has no native "period renewed" event (PayPal doesn't), set
`periodRotationEvents: false` and emit `subscription.period_advanced` from
whatever signal it does have.

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
