# Bring your own billing

Rekey ships with hosted checkout through Stripe, PayPal and Razorpay. Not
every product sells that way. Some already run their subscriptions in a
billing system of their own, some sell by invoice through an ERP, some are
mid-migration from a previous platform, and some sell through a marketplace
that owns the customer's card. In all of those, money changes hands somewhere
Rekey cannot see.

The **external billing provider** covers that case. It is a provider module
like the other three, configured on the Billing tab with one secret, and it
never sends anyone anywhere: your billing system tells Rekey what it sold by
posting signed events to a per-Application endpoint. Rekey then does what it
does after a Stripe webhook: creates or activates the subscription, provisions
the plan's entitlements, tracks renewals, past-due and cancellation, records
payments for the revenue views, and emits its own outbound webhooks so your
application code sees one stream of events whichever way a sale arrived.

Where Rekey has not met the buyer yet, it creates the end-user from the event.
A sale can therefore land before the person ever signs in, and their first
sign-in through an OIDC or OAuth provider that vouches for the same verified
address claims the account. That is the ordering most external systems
produce, and it is the one that used to be impossible.

## What it is not

It is not a checkout. A plan cannot be bought through it, the geo router never
picks it, and the public provider list omits it. If your Application also wants
self-serve checkout, connect a hosted provider alongside it; the two coexist,
and each subscription carries the provider that created it.

It is not two-way. Rekey never calls your billing system. A cancellation
requested through Rekey's portal for a subscription this provider created is
refused with `SUBSCRIPTION_MANAGED_EXTERNALLY`, because Rekey cannot stop the
money and cancelling only the entitlement would leave the buyer paying for
nothing. Cancel in your billing system and post `subscription.canceled`.

## Setup

1. Generate a signing secret of at least 32 characters, for example
   `openssl rand -hex 32`, and store it in your billing system.
2. In the panel, open the Application's Billing tab, find **External billing
   system**, click Configure, and paste the same secret. It is encrypted at
   rest and never returned by any API. Over the API this is
   `PUT /api/v1/tenant/applications/:id/billing-credentials/external` with
   `{ "data": { "webhookSecret": "..." } }`, and over MCP it is
   `configure_billing_provider` with `provider: "external"`.
3. Post events to `POST /api/v1/webhooks/billing/external/<app-slug>`. The
   panel shows the exact URL for your deployment.
4. Send a `ping` first. When it appears as **processed** in the inbound webhook
   log, the secret, the URL and your signature agree.

## Signing

Every request carries one header:

```http
X-Rekey-Signature: t=<unix seconds>,v1=<hex>
```

where `v1` is `HMAC-SHA256(secret, "<t>.<raw request body>")`, hex encoded.
Sign the exact bytes you send; a re-serialised object will not match. A
timestamp more than five minutes from Rekey's clock is refused as
`WEBHOOK_SIGNATURE_STALE`, so sign at send time and keep the sending host's
clock synchronised. This is the same scheme Rekey uses for the webhooks it
sends you, so one helper serves both directions.

In Node:

```ts
import { createHmac } from 'node:crypto';

function sign(body: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

const body = JSON.stringify(event);
await fetch(`${REKEY_URL}/api/v1/webhooks/billing/external/${APP_SLUG}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-rekey-signature': sign(body, SECRET) },
  body,
});
```

With curl and OpenSSL:

```bash
body='{"eventId":"evt_0001","type":"ping","occurredAt":"2026-01-01T00:00:00Z","data":{}}'
t=$(date +%s)
sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" | sed 's/^.* //')
curl -X POST "$REKEY_URL/api/v1/webhooks/billing/external/$APP_SLUG" \
  -H 'content-type: application/json' \
  -H "x-rekey-signature: t=$t,v1=$sig" \
  --data "$body"
```

## The envelope

```json
{
  "eventId": "evt_01J8…",
  "type": "subscription.activated",
  "occurredAt": "2026-09-03T10:15:00Z",
  "data": { "…": "…" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `eventId` | yes | Your unique id for this delivery. Rekey deduplicates on it per Application: a replay is acknowledged with `{"processed": false, "reason": "duplicate"}` and applies nothing. |
| `type` | yes | One of the event types below. Unknown types are acknowledged, logged and ignored, so you may post your whole catalogue. |
| `occurredAt` | no | ISO 8601. Used as the cancellation time when `subscription.canceled` carries no `effectiveAt`. |
| `data` | per type | See below. |

The Application is always the one the URL names. The slug selected the secret
that verified the body, and nothing in the body can redirect the event.

A body that fails validation is refused with `400 WEBHOOK_PAYLOAD_INVALID`,
naming the first failing field, and is stored nowhere. A body that verifies
and validates is stored as a receipt before it is applied; if applying it
fails, the receipt keeps the error, the response is `500`, and your retry of
the same `eventId` re-attempts it rather than being skipped as a duplicate.
Retry with backoff on any `5xx`; do not retry a `4xx` without changing
something.

## Events

### `subscription.activated`

The one event you need. Post it on every sale, renewal, plan change and
recovery; Rekey works out which it is.

```json
{
  "subscription": {
    "id": "sub_9f1c",
    "plan": "pro",
    "currentPeriodEnd": "2026-10-03T10:15:00Z",
    "trialEndsAt": null
  },
  "subscriber": {
    "email": "buyer@example.com",
    "emailVerified": true,
    "organizationId": null
  }
}
```

| Field | Notes |
|---|---|
| `subscription.id` | Your id for the subscription. Stored as `providerSubId` and used to find the row for every later event. |
| `subscription.plan` | A plan slug in this Application. An unknown slug fails the event and stays retryable. |
| `subscription.currentPeriodEnd` | When the paid period ends. Omit or `null` for an open-ended subscription. A later value than the one stored is a renewal; a value already in the past is stale news and the event is ignored. |
| `subscription.trialEndsAt` | When the trial your system is running ends. A future value is judged by Rekey's trial ledger under the Application's `trialPolicy`, the same one-per-buyer rule hosted checkout applies: honoured, the row is `TRIALING` until you post an activation with `trialEndsAt` null or past, which converts it to `ACTIVE`; refused, the subscription is still activated, `ACTIVE` and without the trial, and the refusal is kept under the row's `metadata.refusedTrials`. Re-delivering an event never spends a second slot. |
| `subscriber.email` or `subscriber.endUserId` | Exactly one. An email Rekey does not know creates the end-user (no password, the default role); an unknown `endUserId` fails the event. |
| `subscriber.emailVerified` | Default `true`. Send `false` if your system has not confirmed the address; an OIDC sign-in will then not auto-link to it. |
| `subscriber.organizationId` | The beneficiary organization, required for Applications that bill per organization. |

What happens:

- **No subscription, or one that has ended.** The row is created or reopened
  `ACTIVE`, bound to your `subscription.id`, the plan's entitlements are
  provisioned, and `subscription.activated` is emitted to your webhook
  endpoints. If the subscriber was created, `user.created` is emitted too,
  with `via: "billing:external"`, and a security event
  `end_user.created_by_billing_webhook` is recorded.
- **A live subscription and a later `currentPeriodEnd`.** A renewal: the
  period moves forward and entitlements are provisioned for the new period
  (credits refill once, a timed licence rolls once). Nothing is announced;
  `subscription.activated` is for transitions. A period end beyond a
  scheduled cancellation clears the schedule.
- **A `PAST_DUE` subscription.** Recovery: it returns to `ACTIVE`, the dunning
  case closes as recovered, and `subscription.activated` is emitted.
- **The same `subscription.id` with a different plan or subscriber.** A plan
  change, or a subscription that moved to another account. The old row is
  cancelled (`subscription.canceled` is emitted for it) and the new one
  activated.
- **Nothing new.** A replay; the binding is refreshed and nothing else happens.

### `subscription.canceled`

```json
{ "subscription": { "id": "sub_9f1c", "effectiveAt": "2026-10-03T10:15:00Z" } }
```

With `effectiveAt` in the future the subscription keeps its current status
(`ACTIVE` keeps entitling, `PAST_DUE` stays in dunning) with the date
scheduled, and is cancelled locally when the date arrives. Without it, or with
a past date, it is cancelled now and `subscription.canceled` is emitted. Once
a future date is scheduled, an immediate cancellation posted before that date
does not shorten it: the buyer was promised the rest of the period and keeps
it, exactly as with a hosted provider. A cancellation for an id Rekey does not
hold is logged and ignored.

### `subscription.past_due`

```json
{ "subscription": { "id": "sub_9f1c" } }
```

Marks the subscription `PAST_DUE`. It still entitles, as it does for a hosted
provider. If failed-payment recovery is enabled on the Application, Rekey
opens a dunning case and runs its reminder schedule; if your billing system
already chases the customer, leave that switch off. Post
`subscription.activated` when the payment clears.

### `payment.succeeded`, `payment.failed`, `payment.refunded`

```json
{
  "payment": {
    "id": "pay_7a2e",
    "subscriptionId": "sub_9f1c",
    "amount": 2900,
    "currency": "USD",
    "description": "Pro, September"
  }
}
```

Optional bookkeeping so the panel's payment list and revenue figures include
what you sold. `amount` is in the smallest currency unit. A succeeded payment
for a `subscriptionId` Rekey does not hold is still recorded, unlinked, and
appears in the operator's unapplied-payments queue so that money never goes
unseen; resolve it there once the matching `subscription.activated` has
landed. A failed payment for an unknown subscription is skipped.
`payment.succeeded` emits `payment.succeeded` outbound; `payment.refunded`
marks the payment refunded and does not revoke entitlements.

### `ping`

`data` is empty. Verified, recorded as processed, applies nothing.

## What your application sees

Nothing changes on the consuming side. Entitlements resolve through
`GET /api/v1/billing/entitlements` and the SDK as before, and your webhook
endpoints receive the same `subscription.activated`, `subscription.canceled`,
`subscription.past_due`, `payment.succeeded` and `user.created` events a
Stripe sale produces. Each subscription reports `provider: "external"`.

## Things worth knowing

- **Mode.** The credential's test/live mode is descriptive: it tells the
  revenue views whether the amounts are real money. Use a separate
  Application for a sandbox of your billing system if you want both.
- **Idempotency is yours to key.** `eventId` must be unique per delivery you
  intend to apply once. Posting the same activation with a new id is safe;
  posting two different events with one id loses the second.
- **Ordering.** Rekey applies events in the order they arrive. A stale
  activation cannot resurrect a cancelled subscription (a period end in the
  past is ignored, and a live row's scheduled cancellation is only cleared by a
  period end beyond it), but post events promptly rather than in batches.
- **Rate limits.** The endpoint shares the API's per-IP limit. A nightly
  reconcile that re-posts every active subscription is fine at a few requests
  per second; spread larger volumes.
- **A lapsed period does not end the subscription.** Rekey treats a
  subscription with a provider id as one whose provider will say when it ends,
  so `currentPeriodEnd` passing is not an expiry: entitlement continues until
  you post `subscription.canceled` (or a scheduled one comes due). Post the
  cancellation when the money stops.
- **A live hosted subscription is never rebound.** If the subscriber already
  holds a live subscription to the same plan created by Stripe, PayPal or
  Razorpay, your activation is recorded on that row (`metadata.refusedGrants`)
  and otherwise ignored, because taking the hosted id away would orphan that
  provider's events while it keeps charging. Cancel it there first.
- **One-time plans.** A credit pack or a perpetual licence has no period, so
  a second purchase of the same plan by the same subscriber looks like a
  replay unless something moved. Send `currentPeriodEnd` set to the time of
  each purchase (any value later than the previous one) and Rekey provisions
  the plan again for that anchor: the credits are granted once per purchase.
- **Only your rows.** Events from your system act only on subscriptions your
  system created. An id that happens to match a subscription Stripe, PayPal
  or Razorpay created is logged and ignored, on activation as well as on
  cancellation and payments.
- **Receipts are kept forever** unless `WEBHOOK_EVENT_RETENTION_DAYS` is set
  on the API. With a window configured (90 days covers every retry schedule
  and the inbound log), an `eventId` older than that is accepted as new.
- **Applier failures retry.** A body that fails validation is a `400` and is
  stored nowhere. An event that validates but cannot be applied (unknown plan
  slug, unknown `endUserId`, an erased subscriber, a missing organization) is
  stored with the error, answered `500`, and your retry re-attempts it; fix
  the cause and let the retry succeed, or stop retrying that event.
- **Erasure.** When an operator erases an end-user, Rekey does not call your
  system. Remove the customer there as well.
- **Quota.** Creating a subscriber counts against the workspace's end-user
  limit like a sign-up does. Over the limit, the event fails with the reason
  in the inbound log and your retry succeeds once there is room.

## See also

- [Billing](billing.md) for plans, entitlements and the subscription state machine.
- [Outbound webhooks](webhooks.md) for the events Rekey sends and how to verify them.
- [Adding a billing provider](billing-providers.md) for how this module fits the provider contract.
