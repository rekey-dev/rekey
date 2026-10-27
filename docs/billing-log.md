# The billing log

Every Application has a billing log: one entry for each money change and each
pricing decision. It answers questions the money records cannot answer on
their own. Why was this buyer charged in dollars? Why was this payment not
applied? Who changed this price, and what was it before?

Payments, refunds, subscriptions and the credit ledger stay the record of what
happened. The log is an index of changes to them, and of decisions that leave
no record of their own: why a price was chosen, why a charge was not applied.

Related pages: [billing.md](billing.md), [currencies.md](currencies.md),
[coupons.md](coupons.md), [data-erasure.md](data-erasure.md).

## What is logged

Each entry has a `type`. The types, grouped:

| Group | Types | Written when |
|---|---|---|
| Checkout | `checkout.opened`, `checkout.price_fallback`, `checkout.refused`, `checkout.completed`, `checkout.expired` | A checkout is opened, charges the default price because the selected one could not be charged, is refused, is paid, or ends unpaid. |
| Payments | `payment.recorded`, `payment.failed`, `payment.not_applied`, `payment.not_recorded`, `payment.refunded`, `payment.unapplied`, `payment.unapplied_resolved` | A charge is recorded or fails, is recorded but not applied to a subscription, is reported by a provider and cannot be stored, is refunded, or an unapplied case is opened or resolved. |
| Subscriptions | `subscription.activated`, `subscription.priced`, `subscription.granted`, `subscription.imported`, `subscription.canceled` | A subscription starts, gets or changes its own price, is granted by an operator, is imported, or is canceled. |
| Coupons | `coupon.created`, `coupon.changed`, `coupon.redeemed`, `coupon.refused` | A coupon is created or edited, is used on a paid checkout, or is refused. A code that matches no coupon is not logged. |
| Credits | `credits.granted` | Credits are added by a purchase, a refill, a plan, an operator, or an Application secret key (`source: 'api_key'`). |
| Prices and settings | `plan.price_set`, `plan.price_archived`, `plan.local_prices_changed`, `provider.currencies_changed`, `settings.local_prices_changed`, `settings.reporting_currency_changed`, `settings.unavailable_currency_changed` | A price is added, changed or taken off sale, a provider's currency list changes, or a billing setting changes. Each carries the value before and after. |
| The log's own | `diagnostic.aggregated`, `reconciliation.finding` | Diagnostic entries were counted and not written one by one, or reconciliation found a disagreement. |

Operator actions that are not about money (who created a plan, who rotated a
provider key) stay in the audit log.

### What an entry looks like

```json
{
  "id": "evt_1",
  "seq": "48213",
  "applicationId": "app_123",
  "type": "checkout.price_fallback",
  "tier": "PERMANENT",
  "occurredAt": "2026-10-12T09:14:03.000Z",
  "recordedAt": "2026-10-12T09:14:03.120Z",
  "actor": { "type": "end_user", "id": "eu_456" },
  "endUserId": "eu_456",
  "subscriptionId": null,
  "checkoutSessionId": "cs_789",
  "paymentId": null,
  "refundId": null,
  "planId": "plan_pro",
  "planPriceId": "pp_usd",
  "couponId": null,
  "provider": "stripe",
  "providerEventId": null,
  "currency": "USD",
  "amount": 1900,
  "data": {
    "planSlug": "pro",
    "requested": { "planPriceId": "pp_inr", "currency": "INR", "amount": 149900 },
    "charged": { "planPriceId": "pp_usd", "currency": "USD", "amount": 1900 },
    "reason": "no_provider_for_currency",
    "buyerCountry": "IN",
    "buyerCountrySource": "vouched"
  }
}
```

- `seq` orders the log and is the paging cursor. It is a 64-bit integer sent
  as a string. A later entry has a larger value.
- `occurredAt` is when it happened (a provider's own time for a webhook).
  `recordedAt` is when Rekey wrote it.
- `actor.type` is `system`, `operator`, `end_user` or `provider`.
- `amount` is an integer in the minor unit of `currency`. Write it with
  `formatMoney`.
- `data` depends on `type`. In TypeScript, narrow on `type` and `data` has
  that type's fields and no others.

A webhook a provider delivers twice writes one entry: entries are deduplicated
on the provider's event id.

## Two tiers and how long each is kept

| Tier | Types | Kept |
|---|---|---|
| `PERMANENT` | Everything about money and configuration, including `checkout.price_fallback`. | For the life of the Application. |
| `DIAGNOSTIC` | `checkout.opened`, `checkout.refused`, `checkout.expired`, `coupon.refused`, `reconciliation.finding`, `diagnostic.aggregated`. | 90 days from when they were recorded, then deleted. |

Diagnostic entries can be caused by anyone who holds your publishable key: a
refused checkout needs nothing more. So they are bounded. Per Application and
per hour, the log takes:

- the first 20 entries of one type and reason, and
- at most 200 diagnostic entries in all.

The rest are counted, not written. Every five minutes a job writes one
`diagnostic.aggregated` entry per type, reason and hour, saying how many were
left out:

```json
{
  "type": "diagnostic.aggregated",
  "tier": "DIAGNOSTIC",
  "data": {
    "eventType": "checkout.refused",
    "reason": "BILLING_NO_PROVIDER_FOR_CURRENCY",
    "windowStart": "2026-10-12T09:00:00.000Z",
    "suppressed": 412
  }
}
```

The counters live in Redis. If Redis cannot be reached, a diagnostic entry is
not written at all, so the bound also holds during an outage. Permanent
entries are never bounded and never dropped for this reason.

## Privacy

- An entry names people by id only. There is no email address, IP address or
  user agent in any entry. The shape of each type is fixed and refuses a field
  it does not declare, and reasons are codes, not free text.
- The one thing an entry holds about a person beyond ids is where they were
  when they checked out: `data.buyerCountry` and `data.buyerCountrySource`.
- Erasing an end user, or deleting one, sets those two fields to null on every
  entry about them. The type, the time, the amounts, the currency and every id
  stay, the end user's own id included, so the accounting record survives the
  account.
- An end user's data export includes their entries as `billingEvents`, without
  the id of whoever acted.
- Only an operator with the `billing:read` scope can read the log. A
  publishable key cannot, and an end user never sees it directly.

## Append-only, and what that does and does not prove

The log is append-only. The database refuses to update or delete an entry,
except on the two paths above: erasure, which nulls the two country fields,
and the 90-day removal of diagnostic entries.

`seq` values only ever increase, and each entry keeps the value it was written
with. A consumer that keeps its own copy of the log can therefore see when an
entry it once read is no longer there. A gap between two `seq` values means
nothing by itself: a write that was rolled back also leaves one.

There is no hash chain. The log cannot prove by itself that nobody with direct
access to the database altered or removed an entry. Treat it as a reliable
operational trail, not as tamper-evident evidence. If you need that, copy the
log to storage you control as it grows (see
[Copying the log](#copying-the-log)).

## Reading the log

### In the panel

Open the Application, then Billing, then **Billing log**. It has three views:

- **Log**: every entry, newest first, with filters.
- **Default price used**: how often a buyer was charged the default price
  because their currency could not be charged.
- **Reconciliation**: where the log and the money records disagree.

The list of provider webhooks under Billing, Setup, **Provider webhooks** is a
different thing. That shows what providers sent. The billing log shows what
Rekey did about it, and why.

### With the API

All routes are under `/api/v1/tenant/applications/:id`, take an operator
session or an operator token with the `read` scope, and need the
`billing:read` scope on the caller's membership.

| Route | Returns |
|---|---|
| `GET /billing/events` | The whole log, newest first. |
| `GET /billing/subscriptions/:subscriptionId/events` | Every entry that names one subscription. |
| `GET /billing/payments/:paymentId/events` | Every entry that names one payment, its refunds included. |
| `GET /end-users/:endUserId/billing-events` | Every entry about one end user. |
| `GET /billing/price-fallbacks` | Counts of `checkout.price_fallback`, grouped. |
| `GET /billing/reconciliation` | The reconciliation report for a period. |

Query parameters of the four event routes:

| Parameter | Meaning |
|---|---|
| `cursor` | The `nextCursor` of the previous page. Entries older than it are returned. |
| `limit` | 1 to 200. Default 50. |
| `type` | One event type, or several separated by commas. |
| `tier` | `PERMANENT` or `DIAGNOSTIC`. |
| `currency` | ISO 4217, any case. |
| `from`, `to` | ISO 8601. Entries that happened at or after `from` and before `to`. |
| `endUserId`, `subscriptionId`, `paymentId` | On `/billing/events` only: narrow to one of them. |
| `include` | `actors`: also say who the people named on the page are. See [Who the ids are](#who-the-ids-are). |

The response is `{ "items": [...], "nextCursor": "48190", "actors": null }`.
`nextCursor` is null on the last page. The log is paged on a cursor and never on an offset, so
an entry written while you page does not repeat or displace another.

```bash
curl "$REKEY_URL/api/v1/tenant/applications/$APP_ID/billing/events?type=checkout.price_fallback,payment.not_applied&limit=20" \
  -H "Authorization: Bearer $REKEY_OPERATOR_TOKEN"
```

### Who the ids are

An entry names people by id. Add `?include=actors` to any of the four event
routes and the page also carries `actors`: who those ids are when the page is
read. Nothing of it is stored in the log.

```json
{
  "items": [],
  "nextCursor": null,
  "actors": {
    "endUsers": [
      { "id": "eu_1", "state": "known", "email": "buyer@example.com" },
      { "id": "eu_2", "state": "erased", "email": null },
      { "id": "eu_3", "state": "unknown", "email": null }
    ],
    "operators": [
      { "id": "op_1", "state": "known", "name": "Dana", "email": "dana@acme.example" }
    ]
  }
}
```

- `endUsers` lists every end user an entry of the page names, in `endUserId`
  or as its actor. An erased end user is `erased` with no email, never the
  address they had. An id with no end user behind it in the Application any
  more is `unknown`.
- `operators` lists every operator who is the actor of an entry. An operator
  who has left the workspace is still named while their account exists.
- End users are resolved only for a caller who holds the `end-users:read`
  scope. Without it `endUsers` is null and operators are still named.
- Without `include=actors`, `actors` is null and the read is ids only.

The lookup is one query for end users and one for operators per page,
whatever the page size. The panel's billing log asks for it and shows an email
or a name in the Customer and Actor columns, falling back to the id.
`rekey billing log --include actors`, the SDK's `include: ['actors']` and the
MCP tool `recent_billing_events` (`include: ["actors"]`) do the same.

### With the SDK

`RekeyOperator` from `@rekey.dev/node` reads the log with an operator token.
Create the token in the panel under Account, API tokens, with the
`billing:read` scope. Keep it on a server.

```ts
import { RekeyOperator, formatMoney } from '@rekey.dev/node';

const operator = new RekeyOperator({
  apiUrl: process.env.REKEY_URL!,
  operatorToken: process.env.REKEY_OPERATOR_TOKEN!,
  applicationId: process.env.REKEY_APPLICATION_ID!,
});

const page = await operator.billingLog.events.list({
  type: ['checkout.price_fallback', 'payment.not_applied'],
  from: new Date(Date.now() - 7 * 86_400_000),
});

for (const entry of page.items) {
  if (entry.type === 'checkout.price_fallback') {
    const { requested, charged } = entry.data;
    console.log(
      `${entry.occurredAt}: asked for ${formatMoney(requested.amount, requested.currency)},`,
      `charged ${formatMoney(charged.amount, charged.currency)}`,
    );
  }
  if (entry.type === 'payment.not_applied') {
    console.log(`${entry.occurredAt}: payment ${entry.paymentId} not applied, ${entry.data.reason}`);
  }
}
```

The trail of one record:

```ts
const subscription = await operator.billingLog.forSubscription('sub_123');
const payment = await operator.billingLog.forPayment('pay_123');
const endUser = await operator.billingLog.forEndUser('eu_123', { limit: 100 });

const refunds = payment.items.filter((entry) => entry.type === 'payment.refunded');
console.log(subscription.items.length, refunds.length, endUser.nextCursor);
```

### Copying the log

`events.pages()` fetches one page per request and `events.iterate()` yields
one entry at a time. Both go from newest to oldest and stop making requests
when you stop reading.

```ts
for await (const page of operator.billingLog.events.pages({ tier: 'PERMANENT', limit: 200 })) {
  await archive(page.items);
}

for await (const entry of operator.billingLog.events.iterate({ type: 'payment.refunded' })) {
  console.log(entry.seq, entry.occurredAt, entry.amount, entry.currency);
}
```

## "Default price used"

A plan can have a price in more than one currency. Checkout selects one for
each buyer (see [billing.md](billing.md#a-plan-in-more-than-one-currency)). When
no enabled provider can charge the selected price, checkout does not fail the
sale. It charges the plan's default price instead, tells the caller in
`priceFallback`, and writes a `checkout.price_fallback` entry. The panel calls
this "Default price used".

One fallback is a line in the log. Many of them in one country mean buyers
there are paying a price you did not set for them. To see how often it
happens:

```ts
const summary = await operator.billingLog.priceFallbacks();

console.log(`${summary.total} checkouts fell back between ${summary.from} and ${summary.to}`);
for (const group of summary.groups) {
  console.log(
    `${group.count} buyers in ${group.country ?? 'an unknown country'} on ${group.planSlug}`,
    `paid ${group.chargedCurrency} because ${group.requestedCurrency} could not be charged`,
  );
}
```

`GET /billing/price-fallbacks` returns the same. The period is the last 7 days
unless you pass `from` and `to`, and at most 31 days. Groups are by plan,
currency asked for, currency charged and country, most frequent first, at most
200 groups. `country` is null when it was not known and for an erased buyer.

To stop a group recurring, do one of two things:

1. **Add the currency to a provider that can charge it.** In the panel under
   Billing, Setup, Providers, tick `requestedCurrency` on a provider whose
   list includes it. [currencies.md](currencies.md#what-each-provider-can-charge)
   says which provider can charge what. If none of your providers can, connect
   one that can.
2. **Remove the price.** If you do not intend to charge that currency, take
   the price off the plan. Buyers there are then shown and charged the default
   price, and it is no longer a fallback.

The [routing preview](billing.md#routing-preview) shows what a buyer in a
country would get, before any buyer finds out.

## Reconciliation

Reconciliation compares the log with the payments, refunds and subscriptions
of one period and reports where they disagree. It reads only: it never changes
a payment, a refund or a subscription.

```ts
const report = await operator.billingLog.reconciliation({
  from: '2026-10-01T00:00:00Z',
  to: '2026-10-08T00:00:00Z',
});

const clean = Object.values(report.counts).every((count) => count === 0);
if (!clean) {
  for (const finding of report.findings) {
    console.log(finding.kind, finding.paymentId ?? finding.subscriptionId, finding.at);
  }
}
```

The period is the last 7 days unless you pass `from` and `to`. A period longer
than 31 days, or one that ends before it starts, is refused with
`BILLING_LOG_PERIOD_INVALID`. Cover a longer span one month at a time.

The same comparison runs every hour for each Application and writes each
finding once to the log, as a `reconciliation.finding` entry.

### What each finding means

| Kind | Meaning | What to do |
|---|---|---|
| `payment_without_event` | A payment exists and the log has no entry for it. | The payment itself is intact. Entries for some changes reach the log through a queue, so first check that the queue is not stuck: a super-admin reads it at `GET /api/v1/admin/metrics/billing-outbox`. If the finding is still there once nothing is pending, the entry is missing: keep the payment id and report it. |
| `event_without_payment` | A log entry names a payment that does not exist. `eventSeq` is the entry. | Read the entry (`GET /billing/events` with the `paymentId`) to see the amount, the currency and the provider's ids, then look for the charge in the provider's dashboard. |
| `refund_mismatch` | A payment's refunds add up differently in three places: `refundedOnPayment` (the payment's own total), `refundRowsTotal` (its refund records) and `refundEventsTotal` (the log). | List the payment's refunds (`GET /payments/:paymentId/refunds`) and compare them with the provider's dashboard, which says what the buyer was paid back. |
| `subscription_without_event` | A subscription has no activation, grant or import entry. | The subscription is intact. As with the first kind, check the queue, then report it with the subscription id. |

### What the report does and does not cover

- `checked` says how many payments, refunds, subscriptions and entries the
  period held. `counts` has one number per kind.
- `findings` lists at most 200 of each kind, oldest first. When a kind has
  more, `truncated` is true and that kind's count is a floor.
- **Records older than the log are not reported.** Nothing wrote log entries
  for payments made before the log existed. `paymentsLoggedSince` is when this
  Application's log first recorded a payment, and the payment check starts
  there. When it is null, the log holds no payment entry yet and the payment
  check did not run. `subscriptionsLoggedSince` is the same for subscriptions.
- **It does not compare with the provider's list of charges.** It compares
  Rekey's own records with each other. A charge a provider made that never
  reached Rekey at all is not found here. For that, compare the provider's
  dashboard or export with your payments list.

## With the CLI

`@rekey.dev/cli` reads the log with an operator token (`REKEY_OPERATOR_TOKEN`,
scope `billing:read`). Add `--json` for one JSON document on stdout.

```bash
# The log, newest first. --json prints { items, nextCursor }.
rekey billing log --app <id> --type checkout.price_fallback,payment.not_applied --from 2026-10-01

# One record's trail.
rekey billing log --app <id> --payment <paymentId>
rekey billing log --app <id> --subscription <subscriptionId>
rekey billing log --app <id> --end-user <endUserId>

# Follow nextCursor to the end, up to --max entries (default 1000).
rekey billing log --app <id> --tier permanent --all --max 5000 --json

# How often the default price was used, and where the log and the records disagree.
rekey billing price-fallbacks --app <id> [--from ISO] [--to ISO]
rekey billing reconciliation --app <id> [--from ISO] [--to ISO]
```

`rekey billing log` also takes `--currency`, `--to`, `--limit` and `--cursor`.
`--tier` is `permanent` or `diagnostic`. A bare date is midnight UTC.

`rekey doctor` runs the reconciliation of the last 7 days as its
`reconciliation` check for each Application the token can see, and fails when
the log and the records disagree. Its `price-providers` check reports a live
price no enabled provider can charge, which is the cause of a fallback.

## With MCP

On the operator MCP server ([mcp.md](mcp.md)), under `billing:read`:

| Tool | What it returns |
|---|---|
| `recent_billing_events` | One Application's log, newest first. Filter by `type`, `endUserId`, `subscriptionId`, `paymentId`, `currency`, `from` and `to`, and page with `cursor`. |
| `list_price_fallbacks` | The counts of `checkout.price_fallback`, grouped by plan, currency asked for, currency charged and country. |
| `get_billing_reconciliation` | The reconciliation report for a period of at most 31 days. |

`@rekey.dev/mcp`, the local server that uses the deployment's admin key, has
`get_billing_outbox_status`: what is waiting to reach the log, deployment-wide.
