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
- The request times out after **10 seconds** by default. A self-hosted
  deployment can change that with `WEBHOOK_TIMEOUT_MS` (1000 to 30000
  milliseconds), so check with whoever runs yours. Either way, return 2xx
  immediately and do the work asynchronously: a queue insert, then 200.
- At most **4 deliveries to one endpoint**, and at most **8 across all of one
  Application's endpoints** (`WEBHOOK_APP_MAX_IN_FLIGHT` on a self-hosted
  deployment), are in flight at once. The rest wait their turn; waiting is not
  a failed attempt and does not use up a retry. A burst of events is therefore
  spread out over a few seconds rather than arriving all at once.
- An Application can have up to **100 webhook endpoints**. Creating one more is
  refused with `WEBHOOK_ENDPOINT_LIMIT_REACHED`.
- Any 2xx is success. Everything else — 4xx, 5xx, timeout, connection error —
  is retried. Redirects are **not** followed; a 3xx is a failed attempt.
- **5 attempts total**, backing off 30s → 2m → 10m → 1h. That is roughly 72
  minutes of forgiveness from the first attempt, after which the delivery is
  marked `FAILED` and left for you to inspect and retry by hand from the panel
  or `POST …/deliveries/:deliveryId/retry`.
- After **5 failed requests in a row** to an endpoint, Rekey stops sending to it
  for 60 seconds. An attempt that comes due in that window is recorded as failed
  without a request (its error starts `Not sent:`) and retried on the schedule
  above, so the 72 minutes still apply. The first successful delivery after the
  pause resumes normal sending.
- Up to 4 KB of your response body is stored against the delivery row, so a
  descriptive error body from your handler shows up in the panel. That is a
  debugging aid, not a contract — don't put anything sensitive in it.

Deliveries are claimed atomically before each attempt, so a queue worker, the
recovery poller and a second API replica cannot double-send the same one.
Retries still happen, though, and a provider retrying Rekey after a 5xx on our
side can re-emit. Dedupe on `eventId`; treat "exactly once" as something you
implement, not something you receive.

## Event catalog

Thirty-two events. The registry lives in
`apps/api/src/modules/webhooks/events.ts`, and `@rekey.dev/node` re-exports it
as `WEBHOOK_EVENTS` (`{ name, description }` pairs), `KNOWN_WEBHOOK_EVENTS`
(names only) and `isKnownWebhookEvent` — use those to build an event picker
rather than hardcoding this table.

### Users

| Event | When |
|---|---|
| `user.created` | An end-user account was created. `data.user` describes it and `data.via` says how (see below). |
| `user.updated` | An end-user's role, metadata, verified flag or profile answers changed. `data.changed` lists the field names that changed, never their values, and `data.user` is the record after the change. See below. |
| `user.onboarding_completed` | Onboarding was marked complete, once per user. `data.userId`, `data.completedAt` and `data.via` (`self`, `server` or `operator`). See [profile-fields.md](profile-fields.md). |
| `user.onboarding_skipped` | The user skipped onboarding, once per user and never after completion. `data.userId`, `data.skippedAt` and `data.via` (`self`, `server` or `operator`). Rekey records the skip and blocks nothing. See [profile-fields.md](profile-fields.md#onboarding). |
| `user.deleted` | An end-user account was deleted. |
| `user.banned` | An operator banned an end-user: every session, OAuth/MCP grant and sign-in link was ended, and every sign-in is refused until the ban is lifted. Subscriptions are not touched. `data.user` carries `id` + `bannedAt`; `data.sessionsRevoked` counts the sessions ended. Never carries the operator's reason. A sign-in racing the ban can deliver `session.created` after this event, so order by the event timestamp. |
| `user.unbanned` | An operator lifted a ban. The person can sign in again; sessions the ban ended stay ended. `data.user` carries `id` + `bannedAt: null`. |
| `user.erased` | An end-user was erased for GDPR: PII and auth material hard-deleted, financial rows retained anonymized, and they can never authenticate again. **Propagate this to your own copies of their PII.** `data.user` carries `id` + `erasedAt`. See [data-erasure.md](data-erasure.md). |
| `session.created` | An end-user signed in and a session was minted. See below. |
| `session.revoked` | A refresh token was revoked — sign-out, per-session revoke, or kill-switch. |
| `mfa.enabled` | TOTP enrollment confirmed, or a passkey registered. |
| `mfa.disabled` | The end-user disabled MFA. |
| `password.changed` | Authenticated change or reset-token flow. All their other sessions are revoked. |
| `email.verified` | The end-user verified their email address. |

`user.created` carries `data.via`:

| `via` | Created by |
|---|---|
| `password` | Password sign-up. |
| `magic_link` | The first magic-link sign-in for a new address. |
| `oauth` | The first OAuth sign-in for a new address. `data.provider` names the provider. |
| `operator` | An operator, from the panel's End-users page or `POST /api/v1/tenant/applications/:id/end-users`. |
| `import` | `POST /api/v1/users/import`. This payload carries only `data.user.id` and `data.user.email`. |
| `import:<provider>` | A subscription import from a billing provider. |
| `billing:<provider>` | A billing provider reporting a sale for an address Rekey had not met. |

`user.updated` carries `data.changed` and `data.via`:

| `via` | Change | Fields |
|---|---|---|
| `self` | The end-user's own `PATCH /api/v1/users/me`, or `PATCH /api/v1/users/me/profile`. | `metadata`, or `profile.<key>` per answer |
| `server` | A secret key's `PATCH /api/v1/users/:id/profile`. | `profile.<key>` per answer |
| `operator` | An operator's `PATCH /api/v1/tenant/applications/:id/end-users/:euid`, or `.../end-users/:euid/profile`. | any of `role`, `emailVerified`, `metadata`, or `profile.<key>` |
| `email_verification` | The first successful `POST /api/v1/auth/verify-email`. | `emailVerified` |
| `magic_link` | A magic-link sign-in that proved an unverified address. | `emailVerified` |

It is written in the same transaction as the change, and only when a value
actually changed: a PATCH that stores what was already there, or a second
verification of a verified address, emits nothing. A password change is
`password.changed`, and session churn is `session.revoked`; neither emits
`user.updated`.

`session.created` fires once per real sign-in, in the transaction that writes
the session, so a sign-in whose event cannot be recorded gets no session:

```json
{
  "userId": "eu_...",
  "sessionId": "clx...",
  "deviceId": null,
  "via": "password",
  "firstSignIn": true,
  "platform": "web",
  "country": "DE"
}
```

`via` is `password` (sign-in and sign-up), `magic_link`, `oauth`, `passkey`, or
`mfa` when the session was minted by completing a second factor (the password
step before it mints nothing, so it emits nothing). A refresh, or switching the
active organization, re-mints a session and never emits it. `sessionId` is the
id `session.revoked` carries when that session ends. The same sign-ins, and
only those, move the user's `signInCount` and `lastSignedInAt` (see
[analytics.md](analytics.md)). `platform` is where the session came from
(`web`, `ios`, `android`, `macos`, `windows`, `linux`, `server`, `mcp`, `other`)
and `country` the visitor's country when the deployment trusts Cloudflare's
(`TRUST_CF_IPCOUNTRY`, see [analytics.md](analytics.md#country)), else null. Erasure nulls `country` in stored deliveries.

`firstSignIn` is true for the first session the user ever gets, exactly once
even when several first sign-ins race. That is the sign-up session for a
self-service sign-up, and the first sign-in for an operator-created or imported
user. Accounts that existed before this event shipped count as already signed
in. For "this request created the account", read `isNewUser` on the auth result
instead (see [auth.md](auth.md#routing-new-users-to-onboarding)).

### Organizations

End-user organizations (`authConfig.organizationsEnabled`). Both events are
written in the transaction that creates or accepts the invitation, and neither
carries the invitation token.

| Event | When |
|---|---|
| `organization.invitation.created` | An invitation was created. `data.invitation`: id, organizationId, email, role, invitedById, expiresAt, createdAt. |
| `organization.invitation.accepted` | An invitation was accepted, once per invitation however many accepts race. `data.invitation` (id, organizationId, email, role, acceptedAt) and `data.membership` (id, organizationId, endUserId, role). |

### Lists

People joining and leaving a list, and what they typed (see
[lists.md](lists.md)). Each is written in the transaction that changed the
membership or stored the submission, and a call that changes nothing emits
nothing. Erasing a contact scrubs its stored deliveries (see
[data-erasure.md](data-erasure.md)).

| Event | When |
|---|---|
| `contact.subscribed` | Someone joined a list: a first subscribe, or a secret-key subscribe with `consent` that added back a person who had left. `data.contact` (id, email, name), `data.list` (id, key), `data.member` (status, source, consentVersion, consentAt). |
| `contact.unsubscribed` | Someone left a list: your server called `DELETE /api/v1/lists/:key/members/:email`, or an operator took them off in the panel. Sent once per change. `data.contact` (id, email, name), `data.list` (id, key), `data.member` (status, unsubscribedAt). |
| `contact.submission.created` | A subscribe carried `fields` and they were stored, for example a contact form message. `data.contact` (id, email), `data.list` (id, key), `data.submission` (id, fields, createdAt). |

### Devices

The machines an end-user signs in from — see [devices.md](devices.md). Every
payload carries `data.device` (id, endUserId, fingerprint, label, status,
timestamps) except `device.limit_reached`, which has no row to describe.

| Event | When |
|---|---|
| `device.registered` | A new fingerprint was registered for an end-user, or a released device came back (`data.reactivated`). A sign-in from an already-active device emits nothing. |
| `device.released` | The end-user or an operator gave the slot back; every session minted on the device was revoked (`data.sessionsRevoked`, `data.releasedBy`). |
| `device.blocked` | An operator blocked the device. Sign-in from that fingerprint is refused until it is unblocked; its sessions were revoked. |
| `device.unblocked` | An operator lifted the block. The device is RELEASED and takes a slot again on its next sign-in, subject to the limit. |
| `device.limit_reached` | A new device was refused because the end-user is at `max_devices`. `data.devices` lists the active devices filling the cap, so you can prompt the user to release one. |
| `license.deactivated` | A machine gave back its license seat — the customer's software called `POST /licenses/deactivate`, or an operator released the activation (`data.releasedBy`). `data.license` carries id, endUserId and kind; `data.machineFingerprint` names the machine. |

### Billing

Emitted from the provider inbound-webhook handlers, and only when **local state
actually transitions** — a provider event that changes nothing emits nothing.

| Event | When |
|---|---|
| `subscription.activated` | A Subscription became ACTIVE. `data.subscription` carries ids, plan slug/name/kind, amount/currency/interval, the resolved `entitlements` array, the period end, and `trialEndsAt`. |
| `subscription.canceled` | A Subscription became CANCELED (includes `canceledAt`). |
| `subscription.past_due` | A Subscription became PAST_DUE — payment failed, provider retrying. |
| `subscription.trial_started` | A Subscription entered TRIALING: a checkout that completed on a trial, a billing system reporting a trial, or a provider moving the subscription onto one. Sent alongside `subscription.activated` when the trial is also the activation. `data.subscription.trialEndsAt` is the trial end. A re-dated trial is not a new start. |
| `subscription.trial_will_end` | A TRIALING Subscription's trial ends within 3 days. A sweep checks every 10 minutes, and sends it once per subscription and trial end date; a trial re-dated after it was sent is announced again for the new date. Not sent for a trial that already converted or ended. |
| `payment.succeeded` | A Payment was recorded SUCCEEDED. `data.payment` carries ids, plan slug when subscription-linked, amount/currency/status. |
| `payment.failed` | A Payment was recorded FAILED. |

Act on `data.subscription.entitlements`, not on the plan slug. Two subscribers
on the same plan can hold different quantities, and the slug cannot tell you
so.

The field is **absent** when Rekey could not resolve it while recording the
event. Absent means unknown, not "grants nothing": leave what you provisioned
alone and read the current grant from `GET /api/v1/billing/entitlements/for-user` (secret key with `billing:read`) instead. An empty array
does mean the subscription grants nothing.

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

### Credits

One event per credit ledger entry, so a copy of balances on your side can
follow along instead of polling `GET /credits/balance`. Each is enqueued in the
same database transaction that writes the ledger entry: the event exists if and
only if the entry does. A refused consume (402) and an idempotent replay write
no entry and emit nothing.

| Event | When |
|---|---|
| `credit.granted` | Credits were added: an operator or Application-key grant, a refund, a credit-pack purchase, or plan provisioning. |
| `credit.consumed` | Credits were drawn down: `POST /credits/consume`, or usage recorded past an included quota on a meter priced in credits. |
| `credit.adjusted` | An operator corrected a balance, with reason ADJUST in either direction, or any other operator entry that removes credits. Kept apart from `credit.consumed` so a correction is never read as usage. |

Every credit event carries the same `data.credit` (`CreditWebhookData` in
`@rekey.dev/node`):

```json
{
  "credit": {
    "entryId": "clx...",
    "endUserId": "eu_...",
    "organizationId": null,
    "delta": -4,
    "amount": 4,
    "reason": "CONSUME",
    "balance": 96,
    "idempotencyKey": "lead-123",
    "description": null,
    "createdAt": "2026-09-22T10:00:00.000Z"
  }
}
```

Exactly one of `endUserId` / `organizationId` is set. `delta` is signed and
`balance` is the subject's balance right after this entry, so one handler can
apply all three events the same way. Deliveries can arrive out of order, so
keep the entry with the latest `createdAt` per subject rather than summing
deltas, and dedupe on `eventId` (or `entryId`). `metadata` is not included; read
the entry with `GET /credits/ledger` if you need it.

`credit.consumed` fires for every drawdown, including one per `POST
/usage/record` that is charged in credits. On a busy priced meter that is a lot
of deliveries; subscribe to it only if you want each one. An endpoint subscribed
to `*` receives it too, so a wildcard endpoint on an Application with a busy
priced meter gets one delivery per charged record: list the events by name if
you do not want them.

A grant made with `POST /credits/grant` carries the `idempotencyKey` it was
sent with as `api-grant:<key>`, the form the ledger stores it in.

## Writing a receiver that holds up

- **Verify first, parse second.** Read the raw body, check the signature,
  and only then `JSON.parse`.
- **Dedupe on `eventId` before side effects.** Retries are normal operation.
- **Return 2xx fast.** Five seconds is the budget; queue the work.
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
