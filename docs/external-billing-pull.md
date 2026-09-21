# External billing: the subscriptions pull

This is the contract for a billing system that wants Rekey to **read** what it
has already sold. It is the companion to [external-billing.md](external-billing.md),
which covers the other direction — your system posting events to Rekey as things
happen.

You need both, and they answer different questions:

| | What it covers |
|---|---|
| **Events** (you → Rekey) | Everything from the moment you connect. A sale, a renewal, a cancellation. |
| **Pull** (Rekey → you) | Everything you sold **before** you connected. On migration day, that is your whole book of business. |

The pull is one endpoint. You host it, Rekey reads it, paginated. Nothing else
is asked of you.

---

## 1. What you build

A single `GET` endpoint that lists your subscriptions.

```
GET {your endpoint}?limit=200&cursor={opaque}
```

Configure its URL and a bearer token in Rekey under **Application → Billing →
Providers → External**. Both are optional there: leave them blank and the import
is simply unavailable.

### Request

```http
GET /rekey/subscriptions?limit=200 HTTP/1.1
Host: billing.example.com
Authorization: Bearer <the pull token you configured>
X-Rekey-Signature: t=1757000000,v1=9f86d081884c7d65...
Accept: application/json
User-Agent: Rekey (+subscription-import)
```

- `limit` is between 1 and 200. Return at most that many.
- `cursor` is absent on the first request, and thereafter is whatever you
  returned as `nextCursor`. It is opaque to Rekey — an offset, a keyset, a
  page token, whatever paginates your store.

Rekey will stop after 500 pages or 10,000 rows, whichever comes first. Each
request times out after 10 seconds.

### Verifying the caller

`Authorization` proves the caller has your token. `X-Rekey-Signature` proves the
caller is Rekey, which matters because a leaked URL and token are otherwise
enough to read your customer list.

```
X-Rekey-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
```

The signed string is:

```
{t}.GET.{path}{query}
```

`path` and `query` are exactly as sent, including `?limit=` and `?cursor=`.

**The key is the `Signing secret` you already configured** under Billing →
Providers → External — the same secret your system uses to sign the events it
sends Rekey. There is not a second one for this direction. (The *string* being
signed is different; see the note below. Only the key is shared.)

So for the request above:

```js
const signed = `1757000000.GET./rekey/subscriptions?limit=200`;
const v1 = crypto.createHmac('sha256', SIGNING_SECRET).update(signed).digest('hex');
```

Reject the request if `v1` does not match, or if `t` is more than five minutes
from your clock. Compare in constant time.

> **If you have already implemented Rekey's webhook signature, this is not the
> same string.** Outbound webhooks sign `{t}.{body}`. A GET has no body, so
> reusing that helper here would sign `{t}.` on every request — identical for
> every URL within a given second, and therefore proof of nothing. The two
> schemes share a header shape and a tolerance window, and nothing else.

---

## 2. What you return

```json
{
  "items": [
    {
      "externalId": "sub_8f21",
      "status": "active",
      "planRef": "pro-monthly",
      "customer": {
        "email": "ada@example.com",
        "externalId": "cus_44a1",
        "name": "Ada Lovelace"
      },
      "startedAt": "2026-01-14T09:00:00Z",
      "currentPeriodEnd": "2026-10-01T00:00:00Z",
      "cancelAt": null,
      "quantity": 1,
      "metadata": {}
    }
  ],
  "nextCursor": "eyJvZmZzZXQiOjIwMH0"
}
```

| Field | Required | Notes |
|---|---|---|
| `externalId` | **yes** | Your stable id for the subscription. This is the idempotency key: re-importing the same id never creates a second subscription. **Never reuse one for a different subscription.** |
| `status` | **yes** | One of `active`, `trialing`, `past_due`, `canceled`, `expired`. Anything else is skipped as invalid rather than guessed at. |
| `planRef` | **yes** | Your plan identifier. Mapped to a Rekey plan — see §3. |
| `customer.email` | **yes** | The match key. A row without one cannot be imported. |
| `customer.name` | no | Recorded on the subscription's `metadata.import`. An import never renames an end-user who already has an account. |
| `startedAt` | no | ISO 8601. Recorded on the subscription's `metadata.import.providerStartedAt`. It does not move the local row's `createdAt`, which is when Rekey imported it. |
| `currentPeriodEnd` | no | ISO 8601. **Omit it and the subscription is open-ended** — nothing expires it locally, and cancelling it later takes effect immediately rather than at period end. A value in the past is treated as absent, because a subscription born already expired entitles nobody. |
| `cancelAt` | no | ISO 8601, or null. A future value is set on the local row; a past one is ignored. |
| `trialEndsAt` | no | ISO 8601. When the trial a `trialing` row is on ends. A future value is judged by Rekey's trial ledger under the Application's `trialPolicy`: honoured, the row is imported `TRIALING`; refused (the buyer has already had a trial here), it is imported `ACTIVE` without the trial and the run's summary names the row. Absent or past, a `trialing` row is imported `ACTIVE`. |
| `quantity` | no | Defaults to 1. Above 1 it is applied as a `LICENSE:` entitlement override, so it only does something where the plan actually carries a `LICENSE` entitlement. Where it does not, the subscription is still imported and the run reports which rows could not take a seat count — Rekey does not invent an entitlement the plan never sold. |
| `customer.externalId`, `metadata` | no | Opaque, stored under the subscription's `metadata.import`. Subject to Rekey's 16 KB metadata ceiling — a blob over it is dropped and noted there, rather than failing the row. |
| `nextCursor` | no | Absent or null ends the walk. |

Unknown top-level and per-item fields are ignored, so this contract can grow
without breaking you.

### What Rekey does not ask for

No card data, no payment instrument, no invoice history, no addresses. The
import reads **who is entitled to what, until when**. Payments stay in your
system; if you want payment rows in Rekey, use the event direction, which
already carries them.

---

## 3. Plan mapping

`planRef` is matched against, in order:

1. a Rekey plan whose **slug** is exactly `planRef`;
2. a Rekey plan whose metadata carries that value under `providerPlanId`,
   `providerPriceId` or `externalPlanRef`.

If your plan identifiers already match your Rekey plan slugs, the mapping works
with no configuration. Rows that map to nothing are reported as `skip_no_plan`
in the preview, with the unmapped `planRef` named, so the operator can fix the
mapping and run again. Nothing is guessed.

---

## 4. What Rekey does with a row

An import is two steps. The first writes nothing.

**Dry run.** Rekey reads every page and decides, per row:

| Outcome | Meaning |
|---|---|
| `match` | An existing Rekey end-user has that email. Will be imported. |
| `create` | No Rekey user has that email. Will be imported as a new **unlinked** user — only when the operator chose "create missing users". |
| `skip_no_plan` | `planRef` maps to no Rekey plan. |
| `skip_active` | That user already has a live subscription in Rekey. **An import never overwrites live entitlement.** |
| `skip_invalid` | No usable email, a status Rekey does not import, or an erased user. |

The operator reads that, then applies it — or does not.

**Apply.** Only `match` and `create` rows are acted on. Each goes through the
same path a hand-recorded sale takes: entitlements are materialised and
`subscription.activated` is announced to your webhook endpoints. The imported
subscription carries `provider: "external"` and your `externalId`, so the
cancellation you post later finds it.

A created user is **unlinked**: no password, email unverified, metadata naming
the import run. They get in through the normal recovery paths — magic link,
password reset, OAuth. Rekey's end-user page labels them so a support agent does
not mistake the account for a broken registration.

---

## 5. Requirements on you

- **Idempotent and side-effect free.** Rekey calls this repeatedly, including
  for dry runs that write nothing. Reading must not change anything.
- **Stable ordering within a walk.** An unstable sort silently drops rows
  between pages. Keyset pagination over an immutable column is the safe choice.
- **`externalId` is never reused** for a different subscription.
- **HTTPS, publicly reachable.** Rekey applies the same SSRF guard it applies to
  webhook targets; private and loopback addresses are refused unless the
  deployment sets `WEBHOOK_ALLOW_PRIVATE_TARGETS`, which is for local
  development only.

## 6. Errors Rekey will report

| Code | What happened |
|---|---|
| `EXTERNAL_PULL_NOT_CONFIGURED` | No subscriptions URL or token stored. |
| `SSRF_BLOCKED` / `EXTERNAL_PULL_URL_REFUSED` | The URL is not a permitted target (SSRF guard). |
| `EXTERNAL_PULL_UNREACHABLE` | No response within 10 seconds, or a connection failure. |
| `EXTERNAL_PULL_FAILED` | A non-2xx response. A 401 usually means the token or the signature check disagrees. |
| `EXTERNAL_PULL_MALFORMED` | The body was not a JSON object with an `items` array. |
