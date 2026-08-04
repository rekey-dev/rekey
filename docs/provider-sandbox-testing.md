# Testing against a real payment provider

Rekey's ordinary test suite never touches a payment processor. `test/setup.ts`
replaces `getProviderForApplication` with fakes, on purpose: a unit suite that
needs Stripe to be up is a unit suite that is red for reasons nobody can fix.

The cost of that is precise, and it is what this harness exists to pay back.
**A fake agrees with whatever we believed when we wrote it.** Every checkout
parameter, every webhook payload field, every meaning of a boolean on the wire
is asserted against our own understanding — so a place where our understanding
and the provider's diverge produces a green test and a broken buyer.

`apps/api/test-providers/` is a **separate suite** that drives the real
provider in test/sandbox mode. It is not part of `pnpm test`, it needs
credentials you supply, and it skips loudly when you have not supplied them.

---

## Running it

```bash
# from the repo root
export STRIPE_TEST_SECRET_KEY=sk_test_...
pnpm --filter @rekey.dev/api run test:providers
```

With no credentials at all it runs, skips everything, and tells you why:

```
┌────────────────────────────────────────────────────┐
│ Rekey provider sandbox harness                     │
│ stripe     ABSENT  (STRIPE_TEST_SECRET_KEY)        │
│ …                                                  │
└────────────────────────────────────────────────────┘

 ↓ Stripe sandbox · checkout — SKIPPED: set STRIPE_TEST_SECRET_KEY to a
   Stripe TEST-mode secret key (sk_test_…) (5 tests)

┌──────────────────────────────────────────────────────────────────┐
│ 5 sandbox suite(s) DID NOT RUN — this run proves nothing about   │
│ them                                                             │
└──────────────────────────────────────────────────────────────────┘
```

### Database

The harness uses **its own** Postgres database and never `rekey_test` — both
suites truncate the same tables, and two vitest runs sharing a database eat
each other's fixtures.

```bash
psql postgresql://rekey:rekey@localhost:5432/postgres -c 'CREATE DATABASE rekey_sandbox;'
```

Override with `SANDBOX_DATABASE_URL` if your Postgres lives elsewhere.
`TEST_DATABASE_URL` is deliberately **not** consulted.

### Make a missing credential an error instead of a skip

Skipping is right for a contributor and wrong for a CI job that exists
*because* the secrets are configured — a rotated secret would turn that job
green while testing nothing.

```bash
REKEY_SANDBOX_REQUIRE=all pnpm --filter @rekey.dev/api run test:providers
# or name providers: REKEY_SANDBOX_REQUIRE=stripe,razorpay
```

---

## Getting the credentials

You need nothing but an email address for any of these, and no card. Every
provider below has a free sandbox that is completely separated from live money.

### Stripe — `STRIPE_TEST_SECRET_KEY` (start here)

Stripe covers the most ground and the other two are optional.

1. Sign up at <https://dashboard.stripe.com/register>. You do **not** need to
   activate the account or supply business details — test mode works
   immediately.
2. Make sure the dashboard's **Test mode** toggle is on (top right).
3. Go to **Developers → API keys**.
4. Copy the **Secret key**. It starts with `sk_test_`.

```bash
export STRIPE_TEST_SECRET_KEY=sk_test_51...
```

The harness **refuses to start** on an `sk_live_` key, and on a restricted key
(`rk_test_…`), which lacks the product/price/webhook permissions it needs.

Nothing else is required — the harness creates its own products, prices,
coupons, customers, webhook endpoints and test clocks, and removes them again.

> The suite that completes a hosted Checkout Session in a real browser is
> opt-in, because it needs a browser binary:
> ```bash
> pnpm exec playwright install chromium
> REKEY_SANDBOX_BROWSER=1 STRIPE_TEST_SECRET_KEY=sk_test_... \
>   pnpm --filter @rekey.dev/api run test:providers
> ```
> Stripe has no API that completes a Checkout Session in test mode. The
> documented route is a test card on the hosted page, so that is what this
> does. Everything the completion unlocks that can be reached another way is
> covered without the browser.

### PayPal — `PAYPAL_SANDBOX_CLIENT_ID`, `PAYPAL_SANDBOX_CLIENT_SECRET`

1. Sign in at <https://developer.paypal.com/dashboard/> with a PayPal account.
2. **Apps & Credentials → Sandbox** (the Sandbox/Live toggle matters).
3. **Create App**, type *Merchant*. A sandbox business account is created for
   you if you have none.
4. Copy the **Client ID** and **Secret key**.

```bash
export PAYPAL_SANDBOX_CLIENT_ID=A...
export PAYPAL_SANDBOX_CLIENT_SECRET=E...
```

**Optional but strongly recommended — `PAYPAL_SANDBOX_WEBHOOK_ID`.** PayPal
does not sign webhooks with an offline HMAC; verification is an *online* call
to PayPal, and the shared pipeline skips exactly that call under
`NODE_ENV=test`. That means `verifyPaypalWebhook` is executed by no other test
in this repository, and a verifier that failed open would pass all of them. The
harness calls it directly against the sandbox — but it needs a webhook id to do
so.

In the same app: **Webhooks → Add webhook**, any URL (it is never called; use
`https://rekey-harness.example.com/paypal`), subscribe to
*Billing subscription* events, save, copy the **Webhook ID**.

```bash
export PAYPAL_SANDBOX_WEBHOOK_ID=8SR...
```

### Razorpay — `RAZORPAY_TEST_KEY_ID`, `RAZORPAY_TEST_KEY_SECRET`

1. Sign up at <https://dashboard.razorpay.com/signup>. Test mode is available
   before KYC.
2. Switch the dashboard to **Test Mode**.
3. **Account & Settings → API Keys → Generate Test Key**.
4. Copy both halves. The secret is shown **once**.

```bash
export RAZORPAY_TEST_KEY_ID=rzp_test_...
export RAZORPAY_TEST_KEY_SECRET=...
```

---

## What it covers

| Area | File | What only the real provider can tell us |
| --- | --- | --- |
| Plan registration | `stripe-plan-registration.test.ts` | The Price Stripe minted is read back and compared with the Plan row — amount units, currency case, interval mapping, the metadata the webhook path routes on. |
| A refused credential | `stripe-plan-registration.test.ts` | A genuinely invalid `sk_test_` key. PR #325's whole feature was built against a mock refusal; this is Stripe's real one, including that the stored `registrationError` never contains the key. |
| Webhook auto-config | `stripe-plan-registration.test.ts` | `registerWebhook` creates a real endpoint, Stripe reveals a real `whsec_`, and re-registering does not leave two endpoints delivering everything twice. |
| Checkout | `stripe-checkout.test.ts` | The Session is retrieved from Stripe after creation: mode, price, quantity, buyer email, routing metadata, success/cancel URLs. |
| Coupons | `stripe-checkout.test.ts` | `total_details.amount_discount` and `amount_total` — whether the buyer was *actually* discounted, against a system that has already recorded that they were. Plus the ad-hoc Coupon's `duration`, `max_redemptions` and `redeem_by`. |
| Hosted completion | `stripe-checkout-browser.test.ts` | A real test-card payment, then the genuine `checkout.session.completed`. Opt-in. |
| Webhook → entitlement | `stripe-webhook-entitlement.test.ts` | Genuine `invoice.paid` events fetched from Stripe: the metadata inheritance the translator depends on, the event's API version, the amount recorded, the entitlements provisioned, replay and tamper behaviour. |
| Cancellation, both shapes | `stripe-cancellation.test.ts` | At period end: Stripe records the schedule, the buyer keeps the period, and — via a **test clock advanced past the period end** — Stripe genuinely emits the termination that a provider-backed row waits for. Immediately: cancelled on the spot. This is the half of PR #336 that had never been exercised. |
| PayPal | `paypal-sandbox.test.ts` | Plan + subscription created in the sandbox, a real approval URL, and the online signature verifier refusing a forged event. |
| Razorpay | `razorpay-sandbox.test.ts` | Plan + subscription created in test mode, and that "cancel at period end" leaves the subscription live — the argument that was inverted on the wire. |

### What is real, and what is not

Two shortcuts, both deliberate, both asserted around rather than hidden:

1. **Webhook transport.** Stripe delivers webhooks to a public URL, which a
   laptop does not have. The harness fetches the event from `stripe.events.list`
   — the exact object Stripe would have POSTed, every field as Stripe rendered
   it — and signs it locally with the Application's own stored secret. The
   *payload* is genuine; the signature is not. The HMAC construction itself is
   covered offline in `test/stripe-webhook.test.ts`, and the harness re-covers
   the negative case (a tampered body must 401).

2. **`providerSubId`.** In production that link is written by
   `checkout.session.completed`, which cannot be produced without completing a
   hosted page. The suites that do not use the browser write it directly
   (`linkProviderSubscription`). It is the only fabricated step; everything
   downstream — the events, their contents, their timing, what Stripe does when
   a period ends — is the provider's.

---

## Safety

- **Keys are never printed.** `support/redact.ts` wraps `process.stdout` and
  `process.stderr`, so a failing assertion's diff, a provider SDK's exception
  and a stray `console.log` are all scrubbed. Two layers: exact replacement of
  every registered credential, plus structural patterns (`sk_test_…`,
  `whsec_…`, `rzp_test_…`) that also catch a masked echo and a key the harness
  never saw.
- **Keys are encrypted at rest even in a throwaway database.** The global setup
  generates an ephemeral `ENCRYPTION_KEY`; without one `lib/secrets.ts` falls
  back to storing credentials as `plain.<hex>`.
- **Live keys are refused**, `sk_live_` and `rzp_live_` alike. This harness
  creates and deletes objects in whatever account it is pointed at.

## Cleanup

Everything is named `rekey-harness-…` and tagged `rekeyHarness: '1'` where the
provider allows metadata, and it is cleaned up twice: by the janitor at the end
of the run, and by a sweep at the *start* of the next one that collects
whatever a crashed or Ctrl-C'd run left behind. Repeated runs are idempotent.

What cannot be removed, and will accumulate slowly in a long-lived sandbox:

- **Stripe** — Prices cannot be deleted, only archived, and a Product with
  Prices cannot be deleted either. Both are archived (`active: false`).
  Customers, Coupons, Webhook Endpoints and Test Clocks *are* deleted; deleting
  a Test Clock takes its Customers and Subscriptions with it.
- **PayPal** — sandbox Plans and Products cannot be deleted through the REST
  API, only deactivated.
- **Razorpay** — Plans cannot be deleted. Subscriptions are cancelled.

Point the harness at a sandbox you are happy to accumulate archived objects in.

## CI

There is an opt-in job (`provider-sandbox` in `.github/workflows/ci.yml`) that
runs on `workflow_dispatch` only, reads the keys from repository secrets, and
sets `REKEY_SANDBOX_REQUIRE` so a missing secret fails rather than skips. It is
not part of the pull-request pipeline: it depends on a third party being up,
and a required check that can go red for reasons a contributor cannot fix is a
check people learn to ignore.
