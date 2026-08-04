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

- **Plan** — pricing entry. `{ slug, name, amount, currency, interval, active }`. `amount` is the **smallest currency unit** (cents/paise/sen) — never a float.
- **Subscription** — links an `EndUser` to a `Plan` with a status: `PENDING → ACTIVE → (PAST_DUE | CANCELED | EXPIRED)`. `currentPeriodEnd`, `cancelAt`, `canceledAt` track the lifecycle.
- **Payment** — every charge attempt. Status: `PENDING → SUCCEEDED | FAILED | REFUNDED`.

## Money rule

Always integers. `$9.99` is `999`. `₹499` is `49900`. `¥100` is `100`. **Never floats.** Format on display, not in storage.

## The provider abstraction

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
POST   /api/v1/admin/applications/:id/plans
PATCH  /api/v1/admin/applications/:id/plans/:slug         { active?, name?, amount?, currency?, interval?, metadata? }
POST   /api/v1/admin/applications/:id/plans/:slug/register
```

Creating a plan calls `ensurePlanRegistered()` **only when the Application already has Stripe credentials stored**; the returned price id is persisted into `Plan.metadata.stripe`. PayPal and Razorpay register the plan lazily at first checkout. Making the call unconditional used to be fine when a stub always answered — once the stubs were deleted it meant a PayPal-only or Razorpay-only operator could not create a plan at all, and the error named Stripe, a provider they had never configured.

### A plan is never on sale before the provider can charge for it

`Plan.registrationStatus` is written **before** the provider round-trip and settled after it:

| Status | Meaning | On the public catalogue? |
|---|---|---|
| `NOT_REQUIRED` | No eager registration owed — PayPal/Razorpay-only apps, or no billing configured. Registers lazily at first checkout. | yes |
| `PENDING` | Inserted, provider call in flight (or the process died during it). | no |
| `REGISTERED` | Provider acknowledged it; `metadata.<provider>` holds the price id. | yes |
| `FAILED` | Provider refused. Forced `active: false`, with the refusal in `registrationError`. | no |

A plan awaiting registration is inserted `active: false` and only promoted once the provider answers. The provider call is a network call, so it cannot sit inside a database transaction — the ordering is what makes it safe, not a transaction. Before this, a refused registration left the plan committed **and active**: it stayed on the pricing page, indistinguishable from a working plan, and every buyer who clicked it got a 500 out of checkout.

Repairing one does not need a new slug. `PATCH` accepts `name`/`metadata` always, and `amount`/`currency`/`interval` while the plan is unregistered (there is no immutable provider price to contradict yet — a registered plan answers `PLAN_PRICE_IMMUTABLE`). `POST .../plans/:slug/register` then retries registration and puts the plan back on sale. Activating a plan with no provider price is refused outright with `PLAN_NOT_REGISTERED_WITH_PROVIDER`.

Coupons have no equivalent hazard: nothing is registered with a provider at coupon-create time. The provider-side discount is minted per checkout and discarded if the session fails (`stripe-real.ts` `createDiscount`/`discardDiscount`).

There is **no delete endpoint by design**. Plans referenced by historical Subscriptions need to live forever for accounting. Use `setActive(false)` to retire — that's the only way out.

## Public endpoints

Publishable **or** secret key (`Authorization: Bearer rp_pub_…` / `rp_live_…`). The user-scoped ones additionally require the end-user JWT in `X-Rekey-User-Token`, and that token — not the key — is what authorizes them; see [api-keys.md](api-keys.md).

```
GET   /api/v1/billing/plans                                  — Application key only (pricing pages)
GET   /api/v1/billing/subscription                           — Application key + user JWT
POST  /api/v1/billing/checkout    { planSlug, successUrl, cancelUrl }
```

`POST /checkout` asks the **provider first**: it creates the hosted-checkout session, and only once the provider has answered does it upsert the local `PENDING` Subscription (so the row can correlate the eventual webhook). Nothing local is written for a checkout the provider refused. Returns the URL to redirect to and the local Subscription row. **Subscription activation happens via the provider's webhook — not synchronously here.**

A provider refusal answers **`502 BILLING_PROVIDER_ERROR`**. This is the public surface, so the caller is the operator's *customer*: the message says only that the provider refused and who to contact, never the provider's own text or any fragment of the operator's credential. The provider's message goes to the server log against the response's `requestId`. See [errors.md](errors.md).

If the user already started checkout for the same plan and bailed, repeated calls **reuse the existing PENDING row** rather than creating parallel ones. The unique constraint is `(applicationId, endUserId, planId)`. An already-entitled row (`ACTIVE`/`PAST_DUE`) is **not** reset to `PENDING` — opening a checkout is not an event that removes entitlement.

## SDK usage

```ts
// Pricing page (server-side render)
const { items: plans, page } = await rekey.billing.getPlans();
// → {
//     items: [{ slug: "pro_monthly", amount: 999, currency: "USD", interval: "MONTH", ... }],
//     page:  { total: 4, limit: 50, offset: 0, hasMore: false }
//   }
// Every list endpoint returns this envelope. `page.hasMore` is how you learn
// the response was a window rather than the whole catalogue — pass
// `{ offset: page.offset + page.limit }` for the next one.

// User clicks "Subscribe"
const { url } = await rekey.billing.createCheckout(userAccessToken, {
  planSlug: 'pro_monthly',
  successUrl: 'https://yourapp.com/billing?status=ok',
  cancelUrl:  'https://yourapp.com/billing?status=cancel',
});
res.redirect(url);

// Account page.
//
// `includeEnded` because a billing page has to answer "what happened to my
// subscription", not only "am I entitled". Without it this returns null the
// moment a subscription reaches CANCELED, and a customer who cancelled last
// month sees the same page as one who never subscribed. The flag can only turn
// a null into a row — a live subscription is still the one returned — so it is
// safe to add to a call you already make. Leave it OFF where you are deciding
// access.
const sub = await rekey.billing.getSubscription(userAccessToken, { includeEnded: true });
if (sub === null) {
  // user hasn't subscribed — show upsell
} else if (sub.status === 'ACTIVE') {
  // gate features on sub.planId (cancelAt set = cancelling, still entitled)
} else {
  // CANCELED / EXPIRED — say what they were on and when it ended, and offer
  // a way back. Do NOT treat this as entitled.
}
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

## Webhooks — two directions, don't conflate them

Rekey is in the middle of **two separate webhook flows**, and they have nothing in common beyond the word "webhook":

| | Sender → Receiver | Who verifies the signature | Who configures it | Events |
|---|---|---|---|---|
| **(a) Outbound** | Rekey → **your app** | **You**, with `verifyWebhookSignature` from `@rekey.dev/node` | You: Panel → Application → Webhooks (or `POST /api/v1/tenant/applications/:id/webhooks`) | `user.created`, `user.updated`, `user.deleted`, `session.revoked`, `mfa.enabled`, `mfa.disabled`, `password.changed`, `email.verified`, `subscription.activated`, `subscription.canceled`, `subscription.past_due`, `payment.succeeded`, `payment.failed`, `dunning.case_opened`, `dunning.case_recovered`, `dunning.case_exhausted` |
| **(b) Provider** | Stripe/PayPal → **Rekey** | **Rekey**, against the per-Application provider webhook secret | Operator: provider dashboard endpoint + secret pasted into Panel → Application → Billing | Provider events (`checkout.session.completed`, `invoice.paid`, …) that drive the subscription state machine |

`verifyWebhookSignature` is **only** for direction (a). Your application code never receives or verifies a Stripe/PayPal webhook — that traffic terminates at Rekey.

### (a) Webhooks Rekey sends to YOUR app

Register an endpoint (URL + event list, `"*"` for all) in the panel or via `POST /api/v1/tenant/applications/:id/webhooks`. The response includes the endpoint's signing `secret` exactly once — store it (e.g. as `REKEY_WEBHOOK_SECRET`).

Every delivery is a JSON envelope `{ eventId, occurredAt, type, applicationId, data }`, signed with a `t=<unix-ts>,v1=<hmac-sha256-hex>` header named `X-Rekey-Signature`. Verify it against the **raw body bytes** before trusting anything:

```ts
import { verifyWebhookSignature } from '@rekey.dev/node';

// Fastify shown; any framework works as long as you keep the RAW body.
app.post('/webhooks/rekey', { config: { rawBody: true } }, async (req, reply) => {
  const ok = verifyWebhookSignature({
    header: req.headers['x-rekey-signature'] as string,
    payload: req.rawBody!,            // raw bytes — reserialized JSON breaks the HMAC
    secret: process.env.REKEY_WEBHOOK_SECRET!,
  });
  if (!ok) return reply.status(401).send();

  const event = req.body as { eventId: string; type: string; data: Record<string, unknown> };
  // Failed deliveries are retried with backoff and REUSE the same eventId —
  // dedupe on it (one cheap upsert) before acting.
  await handleOnce(event.eventId, () => applyEvent(event));
  return reply.status(200).send();
});
```

Failed deliveries retry with exponential backoff (30s → 2m → 10m → 1h → 4h, ~5h total); the panel shows delivery history per endpoint, and you can force a retry from there (or via `POST /api/v1/tenant/applications/:id/webhooks/:endpointId/deliveries/:deliveryId/retry`).

The canonical event list ships in code as `WEBHOOK_EVENTS` (an array of `{ name, description }`) and `KNOWN_WEBHOOK_EVENTS` (just the names) from `@rekey.dev/node` / `@rekey.dev/shared-types`, with the `WebhookEventType` union and `WebhookEventEnvelope<TData>` envelope type — use them to autocomplete an endpoint's `events` array or render an event picker.

> The outbound registry covers the auth/user lifecycle **and** the billing lifecycle: `subscription.activated` / `subscription.canceled` / `subscription.past_due` fire when a provider webhook actually transitions the local Subscription's status, and `payment.succeeded` / `payment.failed` fire when a Payment row is recorded. Payloads carry the ids, plan slug, and amount/currency/status under `data.subscription` / `data.payment`. Events are emitted only on a real state change — a replayed provider event that changes nothing emits nothing — but a provider retry after a 5xx on Rekey's side may re-emit, so **dedupe on the envelope's `eventId`** (which retried deliveries reuse) before acting.
>
> `data.subscription.entitlements` carries what that subscription grants — the same array shape `GET /api/v1/billing/entitlements` returns, with the subscription's `entitlementOverrides` already applied. Provision against it rather than against `planSlug`: an override is how a bespoke quantity is sold without minting a private plan, so two subscribers on the same plan can be entitled to different amounts and the slug cannot tell you which.
>
> ```ts
> // "How many widgets did this customer buy?" — plan default, or their override.
> const seats = event.data.subscription.entitlements
>   .find((e) => e.kind === 'FEATURE' && e.key === 'max_widgets');
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

**Application identification.** The app is identified by the URL slug, and the slug is trusted because the signing secret that validated the request is that app's own — a Stripe account can't sign payloads for another app's endpoint. (The dispatch handler still reads `metadata.applicationId` to scope its DB writes; Rekey-created checkout sessions embed it and subscription/invoice events inherit it.)

**Today's coverage:**

| Event | Effect |
|---|---|
| `checkout.session.completed` | Local PENDING Subscription matched on `metadata.checkoutSessionId` → ACTIVE; persists `providerSubId` |
| `customer.subscription.updated` | Mirrors status, currentPeriodEnd, cancelAt, canceledAt |
| `customer.subscription.deleted` | → CANCELED |
| `invoice.paid` / `invoice.payment_succeeded` | Inserts SUCCEEDED Payment + ensures Subscription ACTIVE |
| `invoice.payment_failed` | Inserts FAILED Payment + sets Subscription PAST_DUE |
| anything else | Logged + recorded as processed (no-op) |

See [`apps/api/src/modules/billing/webhooks/AGENTS.md`](../apps/api/src/modules/billing/webhooks/AGENTS.md) for the full module rules.

## Caching entitlements

`billing.getEntitlements(accessToken)` resolves feature flags + limits + the live credit balance from active subscriptions. Hitting it on every request adds a network round-trip to every page load, but caching it forever serves stale plans after an upgrade. The recommended middle:

- **Cache per subject with a ~5-minute TTL** — key on `(endUserId)` or `(endUserId, organizationId)` when the user has an active org. Five minutes bounds how long a plan change can be invisible while absorbing nearly all of the read traffic.
- **Serve stale-while-revalidate** — answer from cache immediately and refresh in the background when the entry is past TTL. Entitlement checks are on the hot path; a synchronous re-fetch on expiry shows up as p99 latency.
- **Bust the cache on checkout success** — when the user lands on your `successUrl`, drop the cache entry and re-fetch so the just-purchased plan is visible on the very next render. (Activation arrives via the provider webhook a moment after redirect, so if the first re-fetch still shows the old plan, retry for a few seconds.) For a push-based invalidation, subscribe to the outbound `subscription.activated` / `subscription.canceled` / `subscription.past_due` events and drop the entry when one arrives.
- **Don't cache `creditBalance` for spend decisions** — the credits API is its own atomic guard (`CREDITS_INSUFFICIENT` on overdraw); use the cached balance for display only.

```ts
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: EntitlementsDto; fetchedAt: number }>();

async function entitlementsFor(userId: string, accessToken: string, orgId?: string) {
  const key = orgId ? `${userId}:${orgId}` : userId;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.value;

  const fresh = rekey.billing
    .getEntitlements(accessToken, orgId ? { organizationId: orgId } : undefined)
    .then((value) => (cache.set(key, { value, fetchedAt: Date.now() }), value));

  // SWR: serve the stale value if we have one; otherwise wait.
  return hit ? (void fresh, hit.value) : fresh;
}

// On the checkout success route:
cache.delete(cacheKeyFor(userId, orgId)); // then re-fetch / retry until the new plan shows
```

(Use your shared cache — Redis with `EX 300` — instead of an in-process `Map` when you run multiple replicas.)

## What's deliberately not here yet

- **Provider-side overage billing.** Usage is metered + hard-capped in-house (record-time enforcement; 402 `USAGE_QUOTA_EXCEEDED` past the included quota), but charging consumption *past* the quota back through a provider invoice-item / usage push is a later `BillingProvider` method.
- **`PlanPrice` / tiered pricing.** Multiple prices per plan + tiered metered overage — see `BILLING_MODEL.md`.
- **Refunds, proration, mid-cycle plan changes.** Wrap provider behavior; don't reinvent.
- **Tax computation.** Provider-handled (Stripe Tax) or external (TaxJar). Not our scope.
- **PCI card vault.** Provider-handled. Rekey never sees card numbers.
