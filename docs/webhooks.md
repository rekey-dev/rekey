# Outbound webhooks

Rekey POSTs a signed JSON envelope to your endpoint when something happens to
one of your end-users, subscriptions or payments. This page covers the wire
format, how to verify a delivery, the event catalog, and what the retry
schedule actually is.

> **Direction matters.** This is Rekey → *your* app. The Stripe / PayPal /
> Razorpay webhooks go to *Rekey*, are verified there, and never reach you —
> see [billing.md](billing.md). `verifyWebhookSignature` in `@rekey.dev/node` is
> for this page's direction only.

## Register an endpoint

Panel → Application → Webhooks, or over HTTP with an operator session:

```http
POST /api/v1/tenant/applications/:applicationId/webhooks
{ "url": "https://yourapp.com/api/rekey/webhook", "events": ["user.created", "subscription.activated"] }
```

Pass `["*"]` to subscribe to everything, including events added in later
releases. The response carries the endpoint's signing **secret exactly once** —
store it like a password; only its stored copy exists afterwards, and the only
way to get a new one is `POST …/webhooks/:endpointId/rotate-secret`.

The URL must be public `http(s)`. Loopback, private, link-local and CGNAT
targets are refused at registration with `400 WEBHOOK_URL_UNSAFE`, and refused
again at delivery time after DNS resolution — a public hostname with a private
A record does not get through. Self-hosters who genuinely need to deliver to an
internal service set `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`; leave it `false` on
anything internet-facing, because the endpoint URL is attacker-influenceable
input and that flag is what stops it becoming an SSRF.

Endpoint management, all under `/api/v1/tenant/applications/:id/webhooks`:

| Route | What |
|---|---|
| `GET /` | List endpoints. |
| `POST /` | Create. Returns `secret` once. |
| `PATCH /:endpointId` | Change `url`, `events`, or `enabled`. |
| `DELETE /:endpointId` | **Hard** delete — takes the delivery history with it. To pause an endpoint and keep the log, `PATCH { "enabled": false }`. |
| `POST /:endpointId/rotate-secret` | New secret, returned once. In-flight deliveries are signed with the new value immediately. |
| `GET /:endpointId/deliveries` | Recent attempts: status, attempt count, response status, error, `nextAttemptAt`. |
| `POST /:endpointId/deliveries/:deliveryId/retry` | Force a re-attempt of a PENDING or FAILED delivery. |

## The wire format

```http
POST /api/rekey/webhook HTTP/1.1
Content-Type: application/json
User-Agent: rekey-webhooks/1.0
X-Rekey-Event-Id: qN1x8s0RbA6mQ1J7hR2v9w
X-Rekey-Event-Type: subscription.activated
X-Rekey-Signature: t=1751274862,v1=3f8a1c…(64 hex chars)
```

```json
{
  "eventId": "qN1x8s0RbA6mQ1J7hR2v9w",
  "occurredAt": "2026-07-30T11:02:41.882Z",
  "type": "subscription.activated",
  "applicationId": "cmd1x8s0r0001abcdefghij",
  "data": { "subscription": { "…": "…" } }
}
```

Every envelope has the same five fields. `data` is the only one that varies by
event type; the catalog below says what each carries.

## Idempotency

**The field is `eventId`. There is no `id`.**

Stated plainly because it has cost an integrator a production outage: a receiver
was written to reject any envelope without an `id` and returned 400, which meant
it rejected every delivery Rekey has ever sent, including the `user.erased`
events the check was built to protect.

`eventId` is present on every envelope, is a stable cuid, and is the
consumer-side idempotency key. A retry reuses it, whether the retry is ours or a
re-emit triggered by a provider retrying us: the envelope is frozen on the
delivery row at enqueue time and resent byte for byte, so deduping is one upsert.
Do that before you act on the payload, not after.

It also rides as the `X-Rekey-Event-Id` header, next to `X-Rekey-Event-Type`, if
you would rather dedupe before parsing a body.

It is inside the signed payload, not only in a header, so a replay cannot present
a fresh id without breaking `X-Rekey-Signature`.

## Verifying a delivery

`X-Rekey-Signature` is `t=<unix-seconds>,v1=<hex>`, where `v1` is
`HMAC-SHA256(secret, "<t>.<raw request body>")`. Sign over the **raw bytes**,
not a re-serialised object — `JSON.parse` followed by `JSON.stringify` will not
reproduce the same string, and the signature will not match.

With the SDK:

```ts
import { verifyWebhookSignature } from '@rekey.dev/node';

// Next.js App Router route handler.
export async function POST(req: Request): Promise<Response> {
  const raw = await req.text(); // raw body, before any parsing
  const ok = verifyWebhookSignature({
    header: req.headers.get('x-rekey-signature'),
    payload: raw,
    secret: process.env.REKEY_WEBHOOK_SECRET!,
  });
  if (!ok) return new Response('bad signature', { status: 401 });

  const event = JSON.parse(raw);
  if (await alreadyProcessed(event.eventId)) return new Response('ok');
  await handle(event);
  return new Response('ok');
}
```

`toleranceSeconds` defaults to 300: a delivery whose `t` is more than five
minutes from your clock fails verification even with a correct HMAC, which is
what stops a captured body being replayed later. If your receiver's clock is
not synchronised, fix the clock rather than widening the window.

Without the SDK, the whole check is a dozen lines — parse `t` and `v1`, reject
on clock skew, recompute the HMAC over `` `${t}.${raw}` ``, and compare with
`crypto.timingSafeEqual`. Use a constant-time comparison; `===` on a hex string
leaks the correct prefix a byte at a time.

## Delivery and retries

- Rekey fans out to every **enabled** endpoint whose `events` list matches the
  type or contains `"*"`, oldest endpoint first, capped at 100 endpoints per
  event.
- Delivery is fire-and-forget with respect to the API request that caused it. A
  slow receiver of yours never slows down the call your user is waiting on.
- The request times out after **10 seconds**. Return 2xx immediately and do the
  work asynchronously — a queue insert, then 200.
- Any 2xx is success. Everything else — 4xx, 5xx, timeout, connection error —
  is retried. Redirects are **not** followed; a 3xx is a failed attempt.
- **5 attempts total**, backing off 30s → 2m → 10m → 1h. That is roughly 72
  minutes of forgiveness from the first attempt, after which the delivery is
  marked `FAILED` and left for you to inspect and retry by hand from the panel
  or `POST …/deliveries/:deliveryId/retry`.
- Up to 4 KB of your response body is stored against the delivery row, so a
  descriptive error body from your handler shows up in the panel. That is a
  debugging aid, not a contract — don't put anything sensitive in it.

Deliveries are claimed atomically before each attempt, so a queue worker, the
recovery poller and a second API replica cannot double-send the same one.
Retries still happen, though, and a provider retrying Rekey after a 5xx on our
side can re-emit. Dedupe on `eventId`; treat "exactly once" as something you
implement, not something you receive.

## Event catalog

Seventeen events. The registry lives in
`apps/api/src/modules/webhooks/events.ts`, and `@rekey.dev/node` re-exports it
as `WEBHOOK_EVENTS` (`{ name, description }` pairs), `KNOWN_WEBHOOK_EVENTS`
(names only) and `isKnownWebhookEvent` — use those to build an event picker
rather than hardcoding this table.

### Users

| Event | When |
|---|---|
| `user.created` | An end-user account was created — password sign-up or first OAuth sign-in. |
| `user.updated` | An end-user's profile changed (email, role, metadata). |
| `user.deleted` | An end-user account was deleted. |
| `user.erased` | An end-user was erased for GDPR: PII and auth material hard-deleted, financial rows retained anonymized, and they can never authenticate again. **Propagate this to your own copies of their PII.** `data.user` carries `id` + `erasedAt`. See [data-erasure.md](data-erasure.md). |
| `session.revoked` | A refresh token was revoked — sign-out, per-session revoke, or kill-switch. |
| `mfa.enabled` | TOTP enrollment confirmed, or a passkey registered. |
| `mfa.disabled` | The end-user disabled MFA. |
| `password.changed` | Authenticated change or reset-token flow. All their other sessions are revoked. |
| `email.verified` | The end-user verified their email address. |

### Billing

Emitted from the provider inbound-webhook handlers, and only when **local state
actually transitions** — a provider event that changes nothing emits nothing.

| Event | When |
|---|---|
| `subscription.activated` | A Subscription became ACTIVE. `data.subscription` carries ids, plan slug/name/kind, amount/currency/interval, the resolved `entitlements` array, and the period end. |
| `subscription.canceled` | A Subscription became CANCELED (includes `canceledAt`). |
| `subscription.past_due` | A Subscription became PAST_DUE — payment failed, provider retrying. |
| `payment.succeeded` | A Payment was recorded SUCCEEDED. `data.payment` carries ids, plan slug when subscription-linked, amount/currency/status. |
| `payment.failed` | A Payment was recorded FAILED. |

Act on `data.subscription.entitlements`, not on the plan slug. Two subscribers
on the same plan can hold different quantities, and the slug cannot tell you
so.

### Dunning

A dunning *case* tracks one subscription's trip through PAST_DUE: reminders on
day 0/3/7, exhaustion at day 14. Off by default — the operator opts in per
Application via `billingConfig.dunningEnabled`. Payloads carry
`data.dunningCase` with ids, status, `failedAttempts` / `remindersSent` and the
open/close timestamps.

| Event | When |
|---|---|
| `dunning.case_opened` | A Subscription went PAST_DUE and a case opened. |
| `dunning.case_recovered` | A later successful payment or reactivation closed the case as RECOVERED. |
| `dunning.case_exhausted` | No recovery within 14 days — the case closed as EXHAUSTED and the subscription was canceled. A `subscription.canceled` accompanies this one. |

## Writing a receiver that holds up

- **Verify first, parse second.** Read the raw body, check the signature,
  and only then `JSON.parse`.
- **Dedupe on `eventId` before side effects.** Retries are normal operation.
- **Return 2xx fast.** Ten seconds is the budget; queue the work.
- **Don't infer order.** Two events emitted close together can arrive in
  either order, and a retried one arrives up to an hour late. Reconcile against
  the current state (`getSubscription`, `getEntitlements`) rather than assuming
  a sequence.
- **Rotate the secret like a credential.** `rotate-secret` returns the new
  value once and signs the very next delivery with it, so deploy the new secret
  to your receiver first, then rotate — or accept a short window of 401s.

## See also

- [billing.md](billing.md) — the other direction: provider → Rekey.
- [errors.md](errors.md) — `WEBHOOK_URL_UNSAFE`, `WEBHOOK_ENDPOINT_NOT_FOUND`,
  `WEBHOOK_DELIVERY_NOT_FOUND`.
- [data-erasure.md](data-erasure.md) — what `user.erased` obliges you to do.
