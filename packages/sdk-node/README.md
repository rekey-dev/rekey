# `@rekey.dev/node`

The server SDK for [Rekey](https://rekey.dev) — auth, billing, usage, credits, licenses, and teams for your application, from any server-side TypeScript runtime (Node, Bun, Deno, Express, Fastify, Nest, Hono).

> **For AI coding agents:** start at [AGENTS.md](../../AGENTS.md) — it has the do-this-first rules.

```bash
npm i @rekey.dev/node
# or: pnpm add @rekey.dev/node / yarn add @rekey.dev/node
```

## Setup

One client instance per Application, constructed with that Application's **secret key**:

| Key | Format | Where to get it |
| --- | --- | --- |
| Secret key | `rp_live_…` (production) or `rp_test_…` (sandbox) | Panel → Application → API Keys |
| API URL | see below | Rekey Cloud, or your own deployment |

**`REKEY_URL` is `https://api.rekey.dev` on Rekey Cloud**, and your own
deployment's public origin when self-hosting (`http://localhost:3030` locally).
There is no default: a default would have to be the Cloud host, and a
self-hosted deployment that forgot the variable would then send its secret key
to a host its operator never chose. Full explanation, including how to verify
the origin before wiring any keys, in [docs/api-url.md](../../docs/api-url.md).

Convention: read both from the environment — never hardcode.

```bash
REKEY_URL=https://api.rekey.dev   # Rekey Cloud; self-hosted, use your own origin
REKEY_SECRET=rp_live_…            # the Application secret key
```

> **Never ship the secret key to the browser.** It authenticates as the whole
> Application — anyone holding it can act on every end-user. Browser code must
> use the Application's **public** key (`rp_pub_…`) via [`@rekey.dev/react`](https://www.npmjs.com/package/@rekey.dev/react)
> or [`@rekey.dev/nextjs`](https://www.npmjs.com/package/@rekey.dev/nextjs) instead. The flow is always:
> browser → your backend → Rekey.

## Quickstart

```ts
import { Rekey } from '@rekey.dev/node';

// Module-level singleton — don't construct one per request.
const rekey = new Rekey({
  apiUrl: process.env.REKEY_URL!,
  secretKey: process.env.REKEY_SECRET!,
});

// 1. Smoke test: verifies your credentials and returns the Application.
const me = await rekey.applications.me();
console.log(`Connected to "${me.name}" (${me.slug})`);

// 2. Create an end-user. Returns the user + a session token pair.
const { endUser, accessToken } = await rekey.auth.signUp({
  email: 'alice@example.com',
  password: 'correct-horse-battery-staple',
});
```

Steps 1 and 2 work on a brand-new Application. Step 3 needs one thing first:

```ts
// 3. Gate features on the user's resolved entitlements (server-side).
//
// REQUIRES billing to be enabled on the Application. `billingConfig.enabled`
// is false on a new one, and every billing call — this included — answers
// 403 BILLING_DISABLED until an operator turns it on in
// Panel → Application → Billing. Read the live value from
// `rekey.applications.me()` if you need to branch on it.
const { features, creditBalance } = await rekey.billing.getEntitlements(accessToken);
if (features.advanced_reporting) console.log('Show the reporting tab', creditBalance);
```

### The two-credential model

Per-user calls require **two** credentials together:

1. The **Application secret key** — proves *which Application*. Set once at construction; sent as `Authorization: Bearer …` automatically.
2. The **user JWT** (returned by `signUp` / `signIn`) — proves *which end-user*. You pass it as the first argument to per-user methods; the SDK puts it in `X-Rekey-User-Token`.

A JWT issued by Application A presented through Application B's secret key is refused with `USER_TOKEN_WRONG_APPLICATION` (401), by design.

## Core API

Everything hangs off namespaces on the client. Every amount is an integer in the minor unit of its currency, never a float. Show one with `formatMoney(amount, currency)` (see [Money helpers](#money-helpers)).

### `rekey.applications`
| Method | Description |
| --- | --- |
| `me()` | Verify credentials + fetch the calling Application (your smoke test). |

### `rekey.auth`
| Method | Description |
| --- | --- |
| `signUp({ email, password, metadata?, emailVerified? })` | Create an end-user; returns user + token pair. Pass `emailVerified: true` only when your server has already confirmed the address. An account left unverified cannot register a passkey, enrol MFA or link a provider, and loses this password the first time someone proves the mailbox by magic link, social sign-in or reset. See [docs/auth.md](https://github.com/rekey-dev/rekey/blob/main/docs/auth.md#an-unverified-account-belongs-to-whoever-proves-the-mailbox). |
| `signIn({ email, password })` | Authenticate. Returns a `SignInOutcome` — **branch on `mfaRequired`** before reading `accessToken`. |
| `mfaVerify({ mfaChallengeToken, code })` | Exchange an MFA challenge for a real session. |
| `getCurrentUser(accessToken, { include? })` | Resolve the end-user behind a token (+ `activeOrganizationId`, `activeOrganizationRole`, `activeOrganizationBaseRole`). `include: ['entitlements', 'device', 'subscription', 'organization', 'licenses']` adds any of those in the same call, typed to what you asked for. |
| `updateCurrentUser(accessToken, { metadata })` | Let a signed-in user edit their own `metadata`. Returns the same shape as `getCurrentUser`. **Shallow-merged**, not replaced: omitted keys survive, a sent key replaces that top-level key wholesale, a key sent as `null` is deleted, and `metadata: null` clears it. Only `metadata` is writable; email, role and password are refused. |
| `refresh(refreshToken)` | Rotate the token pair. Single-use — store the new refresh immediately. |
| `signOut(refreshToken)` / `signOutEverywhere(accessToken)` | Revoke one / all refresh tokens. |
| `requestPasswordReset({ email, resetUrl? })` / `resetPassword({ token, newPassword })` | Reset flow. **Branch on `emailSent`** — see [Email-sending methods](#email-sending-methods-branch-on-emailsent). |
| `changePassword(accessToken, { currentPassword, newPassword })` | Authenticated change; kills other sessions. |
| `requestMagicLink({ email, signInUrl? })` / `verifyMagicLink(...)` | Passwordless sign-in. Same `emailSent` contract as password reset. |
| `sendVerificationEmail(...)` / `verifyEmail(...)` | Email verification. Same `emailSent` contract (no `delivered` field — the caller is already authenticated). |
| `resendVerificationEmail({ email, verifyUrl? })` | Re-send a verification link with **no session** — the route for a user locked out by `requireEmailVerification`, which refuses the session `sendVerificationEmail` requires. Enumeration-safe; **branch on `emailSent`**. |
| `listSessions(accessToken)` / `revokeSession(...)` | Active-session management. |
| `mfaStatus` / `mfaSetup` / `confirmMfaSetup` / `mfaChallenge` / `disableMfa` | TOTP enrollment + step-up. |
| `startPasskeyAuthentication` / `verifyPasskeyAuthentication` / `startPasskeyRegistration` / `verifyPasskeyRegistration` / `listPasskeys` / `deletePasskey` | WebAuthn / passkeys. |
| `listOAuthProviders` | The OAuth providers a sign-in page should offer, `{ providers: [{ id, name }] }`. Names only, never client ids or secrets. |
| `startOAuth` / `completeOAuth` / `listOAuthIdentities` / `startOAuthLink` / `completeOAuthLink` / `unlinkOAuth` | Social sign-in + account linking. |

#### Email-sending methods: branch on `emailSent`

`requestPasswordReset` and `requestMagicLink` return a different shape depending on whether the Application has an email transport configured (BYO Resend creds, or `RESEND_DEFAULT_*` on the deployment). They never throw for an unknown email. A secret-key caller (your server) is told, with `delivered: false` on password reset; a publishable-key browser caller always gets the same body. Keep that difference out of what you render.

| Case | `delivered` | `emailSent` | token (`resetToken` / `magicLinkToken`) | Your job |
| --- | --- | --- | --- | --- |
| Transport configured, user exists | `true` | `true` | `null` | Nothing — Rekey sent the email. |
| No transport (or send failed), user exists | `true` | `false` | the raw token | **You** email the link via your own provider. |
| Unknown email | `false` | `false` | `null` | Nothing. Render the same neutral UI — never reveal. |

<!-- snippet: no-check a fragment: no imports, and values from the surrounding code -->
```ts
const r = await rekey.auth.requestPasswordReset({
  email,
  resetUrl: 'https://yourapp.com/reset?token={token}', // {token} substituted into the email
});
if (!r.emailSent && r.resetToken) {
  await mailer.send({ to: email, text: `Reset: https://yourapp.com/reset?token=${encodeURIComponent(r.resetToken)}` });
}
// Always show "if that address exists, we sent a link" — even when delivered === false.
```

`sendVerificationEmail` follows the same contract with `{ emailSent, verificationToken }` (no `delivered` — the caller is already authenticated, so there's nothing to hide).

`resendVerificationEmail` is the unauthenticated one, and so is enumeration-safe like the two above: it returns `{ emailSent, verificationToken }` and never reveals whether the address exists or was already verified. One difference from `sendVerificationEmail` — it refuses to send when no link can be built (no `verifyUrl`, and no Application URL configured), returning `{ emailSent: false, verificationToken: null }` rather than mailing a verification message with no button in it. Pass `verifyUrl`, or set the Application URL in **Panel → Application → Auth**.

### `rekey.billing`
| Method | Description |
| --- | --- |
| `getPlans(page?, { country?, accessToken? })` | List the Application's active plans (public, for rendering pricing pages). Returns `{items, page}`. Each plan carries `price`: the price this buyer would be charged, resolved by the function checkout uses. Render `price.formatted` and pick nothing yourself. `price` is null for a plan with no flat price (`isFree` says whether it is free). `prices` lists every price the plan sells at. Pass `country` (ISO 3166-1 alpha-2) for a buyer there, and `accessToken` for a signed-in buyer, who is shown the currency they already pay in. `price.reason` is `bound`, `country`, `default`, or `fallback` when the price selected for the buyer cannot be charged and the default one is shown. Each plan's `checkout.ready` is false when checkout for it would be refused: `items.filter((p) => p.slug === freeSlug \|\| p.checkout.ready)`. Keep the free tier in. The free tier is the plan named by `billingConfig.defaultPlanSlug`: it applies to every signed-in user without checkout, and `billing.subscribe` activates it with no provider. It must be an active plan that is free (`isFree`). Set it with `PATCH /api/v1/tenant/applications/:id/billing-config` (the panel has no control for it yet). |
| `getSubscription(accessToken, { organizationId?, includeEnded? })` | The user's active subscription, or `null`. Its `price` (`{ id, currency, amount, formatted }`) is what this subscriber pays each period, which can differ from the plan's default price; null for a plan with no flat price and for an unpaid checkout. `includeEnded: true` falls back to their most recent CANCELED/EXPIRED subscription **only when the answer would otherwise be null**, so a billing page can say what a former subscriber was on and when it ended. It never replaces a live subscription; leave it off for entitlement checks. |
| `createCheckout(accessToken, { planSlug, successUrl, cancelUrl, country?, currency?, onUnavailableCurrency?, provider?, couponCode?, organizationId? })` | Start hosted checkout; returns the redirect URL + a PENDING subscription. Activation happens via the provider webhook. The result's `price` is always the price charged, with `currency` and `unitAmount`. `priceFallback` is set when the price selected for the buyer could not be charged and the plan's default price is charged instead: tell the buyer before you redirect them (`priceFallbackMessage` writes the sentence). `currency` names the price from your server; with `onUnavailableCurrency: 'refuse'` a currency no provider can charge throws `BILLING_NO_PROVIDER_FOR_CURRENCY` in place of falling back. A buyer who already pays in another currency is refused with `BILLING_CURRENCY_CONFLICT`. |
| `cancelSubscription(accessToken, { atPeriodEnd?, organizationId? })` | Cancel the user's subscription. Defaults to **at period end** — the row stays ACTIVE with `cancelAt` set until the day arrives, so read `cancelAt`, not `status`. Pass `atPeriodEnd: false` to end it immediately. The default is a *request*: a PAST_DUE subscription, a PENDING checkout, or an ACTIVE row with no known period end is canceled on the spot regardless. Ask `cancelsAtPeriodEnd(sub)` (exported from this package) before showing a confirmation, so you promise the outcome the caller will actually get. |
| `validateCoupon(accessToken, { code, planSlug, country?, currency?, onUnavailableCurrency?, provider?, organizationId? })` | Price-check a coupon without applying it, at the price the checkout would charge. Render `formatted.discount` and `formatted.total`. A coupon that does not work in the currency charged throws `COUPON_CURRENCY_NOT_COVERED`, here and at checkout. |
| `getProviders(country?, { planSlug }?)` | The geo-routed list of enabled billing providers, with `routedProvider` and `countrySource`. Each provider's `currencies` is what that account charges; an empty list means none. With `planSlug`, only those that can charge that plan. |
| `getEntitlements(accessToken, { organizationId? })` | Resolve feature flags + limits + live credit balance. **Gate your app on this.** Cache it with a ~5-min TTL / stale-while-revalidate and bust on checkout success — see ["Caching entitlements" in docs/billing.md](https://github.com/rekey-dev/rekey/blob/main/docs/billing.md#caching-entitlements). |
| `hasFeature(accessToken, key, { organizationId? })` / `getFeature(...)` | One feature: `hasFeature` is `Boolean(value)`, `getFeature` returns `{ key, granted, value }`. Same subject as `include: ['entitlements']`; skips the credit balance read. |
| `hasFeatureFor(endUserId, key)` / `getFeatureFor(...)` | The same for an end-user you name. Secret key only. |

### Money helpers

```ts
import { formatMoney, minorUnitExponent, validatePriceAmount, sellableCurrencies, isSellableCurrency } from '@rekey.dev/node';

formatMoney(149900, 'INR'); // '₹1,499.00'
formatMoney(5000, 'JPY'); // '¥5,000'
minorUnitExponent('JPY'); // 0
validatePriceAmount('HUF', 500050).ok; // false: HUF is sold in whole units
isSellableCurrency('KWD'); // false: three decimal places
sellableCurrencies().length; // every currency a price may be in
```

| Export | Description |
| --- | --- |
| `formatMoney(amount, currency, locale?)` | Writes an integer amount in minor units for a person. Use it wherever you show an amount, so nothing in your code keeps its own divisor. |
| `minorUnitExponent(currency)` | How many decimal places the currency has, or `null` for an unknown code. |
| `validatePriceAmount(currency, amount)` | Whether a price may be stored, and the rule it breaks when not. |
| `sellableCurrencies()` / `isSellableCurrency(code)` | The currencies a price may be in. |
| `priceFallbackMessage(fallback)` | The sentence to show a buyer whose checkout charges the default price. |
| `BILLING_MONEY_ERROR_CODES` / `isBillingMoneyError(err)` | The closed list of money error codes, and a guard for a caught error. |

See [docs/currencies.md](https://github.com/rekey-dev/rekey/blob/main/docs/currencies.md).

### `RekeyOperator` (operator token)

`Rekey` acts as your Application towards its end users, with a secret key.
`RekeyOperator` acts as a member of the workspace that owns the Application,
with an operator token, and calls the routes the panel calls. Use it for
back-office tools, scripts and reports, never on a path a visitor can reach.

```ts
import { RekeyOperator, formatMoney } from '@rekey.dev/node';

const operator = new RekeyOperator({
  apiUrl: process.env.REKEY_URL!,
  operatorToken: process.env.REKEY_OPERATOR_TOKEN!, // rp_op_..., from Panel → Account → API tokens
  applicationId: process.env.REKEY_APPLICATION_ID!,
});

const stats = await operator.billing.stats();
for (const row of stats.mrr) console.log(row.currency, formatMoney(row.mrrCents, row.currency));

const payment = await operator.payments.get('pay_123');
console.log(payment.status, formatMoney(payment.refundedAmount, payment.currency));
```

Reads need the `read` scope on the token. Changing a plan, a price, a coupon
or the reporting currency needs `applications:write`. Issuing a refund,
changing provider credentials and changing the billing settings need an
operator session, so they are in the panel and not on this client.

| Method | Description |
| --- | --- |
| `plans.list(page?)` | Every plan, active or not, with `prices` (where each stands at the provider, whether its amount can still change, and how many live subscriptions and open checkouts are on it), `price` and `checkout` readiness with its blockers. |
| `plans.create(input)` / `plans.update(slug, input)` | Create a plan, or change one. The default price is `price: { currency, amount }`, with `amount` in minor units; leave it out for a free plan, and send `price: null` on an update to make a plan free. `price` and `interval` change only until a provider has registered the plan. `localPrices` (`INHERIT`, `TRUSTED`, `OFF`) says whether a buyer's country may select one of the plan's other prices, and can change at any time. |
| `plans.prices.list(plan)` / `set(plan, currency, { amount?, countries? })` / `archive(plan, currency)` | A plan's prices, one per currency. `amount` is required to add a price and can change only until a provider has registered it. |
| `coupons.list(page?)` / `get(code)` / `create(input, { idempotencyKey? }?)` / `update(code, input)` | Coupons: a percentage in `basisPoints`, or `amounts` with one amount per currency. `coveredCurrencies` is where a coupon works, `null` for any. `update` also changes `endsAt`, `maxRedemptions` and `maxRedemptionsPerUser`, each a value or `null` to remove it; a cap below what is already redeemed is refused with `COUPON_LIMIT_BELOW_REDEEMED`. |
| `payments.list({ status?, from?, to?, sort?, order?, limit?, offset? })` / `payments.get(paymentId)` | Payments, each with `refundedAmount`, the `provider` that took it, and whether it is `refundable` through Rekey with the `refundBlockedReason` when it is not. `refundBlockedMessage(reason)` is the sentence for a person. |
| `payments.refunds.list(paymentId, page?)` | The refunds recorded against one payment, oldest first. |
| `billingLog.events.list(options?)` / `pages(options?)` / `iterate(options?)` | The billing log: one page, every page, or every entry, newest first, paged on a cursor. |
| `billingLog.forSubscription(id)` / `forPayment(id)` / `forEndUser(id)` | The trail of one record. |
| `billingLog.priceFallbacks(period?)` | How often a buyer was charged the default price because their currency could not be charged. |
| `billingLog.reconciliation(period?)` | Where the log and the payments, refunds and subscriptions disagree. |
| `billing.getReportingCurrency()` / `setReportingCurrency(code)` | The currency the stats lead with. Nothing is converted into it. |
| `billing.getConfig()` | The Application's billing settings: `onUnavailableCurrency` is the default for a checkout that names a currency no provider can charge, `'fallback'` charges the default price and `'refuse'` answers `BILLING_NO_PROVIDER_FOR_CURRENCY`. A request's own `onUnavailableCurrency` wins. |
| `billing.stats()` | Subscription counts, and MRR and revenue per currency. No total across currencies. `unverified` is money recorded and not applied. |
| `billing.previewRouting({ country, plan?, couponCode?, ... })` | Which price and provider a buyer in a country would get, and why, without opening a checkout. |
| `billing.providers()` / `providerCurrencies()` | What each provider can charge, and what each configured account charges. |
| `forApplication(applicationId)` | The same client for another Application of the workspace. |

See [docs/billing-log.md](https://github.com/rekey-dev/rekey/blob/main/docs/billing-log.md) and [docs/billing.md](https://github.com/rekey-dev/rekey/blob/main/docs/billing.md).

### `rekey.organizations` (teams)
| Method | Description |
| --- | --- |
| `create(accessToken, { name, slug })` | Create an org; caller becomes OWNER. |
| `listMine(accessToken, page?)` | Orgs the user belongs to (paginated — see Gotchas). |
| `get` / `update` / `listMembers(…, page?)` | Read / update org + list members (paginated). |
| `invite` / `revokeInvitation` / `acceptInvitation` | Invitation flow (raw token surfaced once). |
| `setMemberRole` / `removeMember` / `leave` | Membership management (last-OWNER guarded). |
| `switch(accessToken, orgId)` / `clearActive(accessToken)` | Set / clear the session's active org. **Returns a fresh token pair — store both.** |

### `rekey.usage`
| Method | Description |
| --- | --- |
| `record({ meterSlug, quantity, endUserId? \| organizationId? })` | Record a metering event (quantity may be negative). |
| `aggregate({ meterSlug, from?, to?, endUserId?, organizationId? })` | Sum a meter over a window / subject. |
| `getRemaining(accessToken, { meter?, organizationId? })` | The signed-in user's included quota, `used` and `remaining` this period, per meter. Same numbers `record` enforces with. |
| `getRemainingFor({ endUserId? , organizationId? }, { meter? })` | The same for a subject you name (secret key). |
| `listMeters({ limit?, offset? })` | The meter catalogue: slugs, units, active flag, fallback credit price. |

### `rekey.credits` (prepaid / pay-as-you-go)
| Method | Description |
| --- | --- |
| `getBalance(subject)` | Spendable balance for `{ endUserId }` or `{ organizationId }`. |
| `consume(subject & { amount, idempotencyKey? })` | Idempotent drawdown. Throws `CREDITS_INSUFFICIENT` (402) when too low. |
| `listLedger(subject, limit?, offset?)` | Ledger entries, newest first (default 50, max 200). Returns `{items, page}`. |
| `grant({ endUserId? \| organizationId?, amount, idempotencyKey, reason?, description? })` | Add credits. Needs a key minted with the **elevated** `credits:grant` scope, which `*` does not include. 1 to 1,000,000 per call. |
| `listMyLedger(accessToken, { organizationId?, limit?, offset? })` | The signed-in user's own ledger, without `metadata`. |

Credit changes are also sent as `credit.granted`, `credit.consumed` and `credit.adjusted` webhooks; the payload type is `CreditWebhookData`.

#### `idempotencyKey` scoping & retry semantics

The key is unique per **subject** within the Application: `(applicationId, subject, idempotencyKey)` on the append-only ledger. The same key used for two different end-users is two separate operations, which is right when the key names what is being paid for (a lead id) and two buyers pay for it. Within one subject, embed the operation in the key:

```ts
// Recommended format: `${subjectId}:${operationId}` — stable per logical operation.
export async function chargeForLead(user: { id: string }, leadId: string) {
  const result = await rekey.credits.consume({
    endUserId: user.id,
    amount: 1,
    idempotencyKey: `${user.id}:enrich-lead:${leadId}`, // ≤ 200 chars
  });
  if (!result.applied) {
    // Replay: this exact operation was already charged. `result.balance` and
    // `result.entryId` are from the ORIGINAL entry, so it is safe to treat as success.
  }
  return result.balance;
}
```

Retry semantics: a repeat with the same key (timeout retry, queue redelivery, double-click) is a no-op that returns the original result with `applied: false` — never a double charge and never an error. Keys never expire (the ledger is append-only for the life of the subject), so derive them from the operation, not from a timestamp or a random UUID minted per attempt — a fresh UUID per retry defeats the whole mechanism.

### `rekey.lists` (waitlists, newsletters, contact forms)
| Method | Description |
| --- | --- |
| `list()` | Every list with member counts. `contacts:write` (in `*`). |
| `get(key)` | The list's form: `fieldSchema`, and the consent text and version to show. |
| `subscribe(key, { email, name?, fields?, consent?, sourceUrl?, hp? })` | Add someone. For your own purposes it resolves `{ status, contactId }`, status `subscribed \| already_subscribed \| previously_unsubscribed \| suppressed \| ignored`. Relaying a visitor's form, call it through `rekey.with({ clientIp })` and pass `{ relay: 'browser' }` as the third argument: it then follows the browser rules and always resolves `{ status: 'received' }`. `contacts:write`. |
| `members(key, { status?, updatedSince?, cursor?, limit? })` | One page, oldest change first. Needs a key minted with the **elevated** `contacts:read`. |
| `iterateMembers(key, options?)` | Every member, following cursors. |
| `unsubscribe(key, email)` | Take someone off a list. Idempotent. `contacts:write`. |

Rekey sends no email to a list. See [docs/lists.md](https://github.com/rekey-dev/rekey/blob/main/docs/lists.md).

### `rekey.email` (custom templates)
| Method | Description |
| --- | --- |
| `send({ template, to, variables?, version?, idempotencyKey? })` | Send a custom template registered and published in the panel (Application → Email → Custom templates). Needs a key minted with the **elevated** `email:send` scope, which `*` does not include. Returns `{ id, status: 'sent' \| 'suppressed', template, version, messageId? }`. |

<!-- snippet: no-check a fragment: no imports, and values from the surrounding code -->
```ts
import { emailVariableIssues, isEmailSendError } from '@rekey.dev/node';

try {
  const { status } = await rekey.email.send({
    template: 'order_shipped',
    to: order.email,
    variables: { orderNumber: order.number, trackingUrl: order.trackingUrl },
    idempotencyKey: `order-shipped:${order.id}`,
  });
  // status 'suppressed': nothing was sent. The address is on the suppression list, or it
  // unsubscribed from notification mail (critical templates and account emails still arrive).
} catch (err) {
  if (isEmailSendError(err) && err.code === 'EMAIL_VARIABLES_INVALID') {
    console.warn(emailVariableIssues(err)); // [{ path: 'variables.trackingUrl', message: 'must use https.' }]
  }
  throw err;
}
```

- The call carries no subject, HTML or From address. Those come from the published version, and a body with any of them is refused.
- Mail only goes out through the Application's own Resend or SMTP provider. On the shared pool the call throws `EMAIL_TRANSPORT_NOT_CUSTOM`.
- Variables are checked against the template: undeclared names are refused, `url` values must be https on the template's link domains.
- An `idempotencyKey` names one attempt. A repeat returns the first result and sends nothing, including a repeat of a failed send (`EMAIL_DELIVERY_FAILED`); retry a failure with a new key. If the first attempt never recorded an outcome, a repeat after five minutes throws `EMAIL_SEND_OUTCOME_UNKNOWN`: check whether it arrived before sending with a new key.
- Sends are capped per workspace per day and per recipient per hour (`EMAIL_RATE_LIMITED`, with `retryAfterSeconds`); the workspace limits can set other numbers.
- `EMAIL_SEND_ERROR_CODES` lists every code this call can add to the generic ones.

### `rekey.licenses`
| Method | Description |
| --- | --- |
| `verify({ key, machineFingerprint, label? })` | Verify a license key + record an activation. Always 200 — branch on `result.ok`. |
| `deactivate({ key, machineFingerprint })` | Give a machine's seat back. Same deterministic body as `verify`; idempotent. |
| `listMine(accessToken, page?, { organizationId? })` | The signed-in user's own licences (and the active organization's, in an org-billed Application). Pass `organizationId` to include that organization's pool instead; member-only, else 403 `ORGANIZATION_NOT_MEMBER`. No raw keys, just `keyPrefix`. Needs `billing:read`. |

### `rekey.devices` (secret key)
| Method | Description |
| --- | --- |
| `list(endUserId, { status? })` | The machines an end-user has signed in from. |
| `release(deviceId, endUserId)` | Give the slot back and revoke that device's sessions. |

### `rekey.users` (secret key)
| Method | Description |
| --- | --- |
| `getByEmail(email)` / `get(id)` | Exact-match lookup, scoped to the Application. |
| `import({ users })` | Bring users over from another auth system with their argon2id or bcrypt hashes and OAuth identities. Reports `created`, `skipped` and `unlinked`. |

`rekey.billing.getEntitlementsFor(endUserId)` answers "what may this user use" for a backend holding no user token. See `docs/devices.md`.

### `rekey.mcp` (bring-your-own MCP server)
| Method | Description |
| --- | --- |
| `introspect(token)` | Validate an inbound Rekey-issued MCP access token (RFC 7662). |
| `metadata()` | Fetch this Application's OAuth authorization-server metadata (RFC 8414). |

### Top-level exports
| Export | Description |
| --- | --- |
| `verifyWebhookSignature({ header, payload, secret, toleranceSeconds? })` | Verify the HMAC on a webhook **Rekey sends to your app** (user-lifecycle + billing events) against the **raw body bytes** + the `X-Rekey-Signature` header. Not for Stripe/PayPal webhooks — those go to Rekey, never to you (see [docs/billing.md](https://github.com/rekey-dev/rekey/blob/main/docs/billing.md)). |
| `verifyAccessToken(token, { applicationId, jwksUrl \| jwks })` | Verify an end-user access token **offline** (no API round-trip) against your deployment's `GET /.well-known/jwks.json`. RS256 only — the Application must opt in via `authConfig.tokenAlg: "RS256"`; default HS256 tokens still need `auth.getCurrentUser`. Fetches + caches the JWKS for 5 minutes, checks `kid`/signature/`exp`/`typ`, and returns the claims (`sub`, `applicationId`, `oid?`, …). **`applicationId` is required** — the RS256 keypair is deployment-wide, so without it a token minted for any other Application on the same deployment would verify here. (The HS256 default is unaffected: its key is derived per Application.) It cannot see a server-side revocation: a locally verified token stays valid until it expires, even after sign-out everywhere, a session revoke or a device release, so call the API when immediate revocation matters. See [docs/jwks.md](https://github.com/rekey-dev/rekey/blob/main/docs/jwks.md). |
| `WEBHOOK_EVENTS` / `KNOWN_WEBHOOK_EVENTS` / `isKnownWebhookEvent` | The full outbound-event registry: `{ name, description }` pairs (and just the names) for every event Rekey can send, among them `payment.succeeded`, `payment.failed` and `payment.refunded`. Mirrors the API exactly; use it for event pickers and for autocompleting an endpoint's `events` array, and do not hardcode a list. See [docs/webhooks.md](https://github.com/rekey-dev/rekey/blob/main/docs/webhooks.md). |
| `WebhookEventType` / `WebhookEventEnvelope<TData>` | Types for the event-name union and the delivery envelope (`{ eventId, occurredAt, type, applicationId, data }`). Dedupe on `eventId` — retries reuse it. |
| `PaymentWebhookData` / `SubscriptionWebhookData` | Types for `data` of the `payment.*` and `subscription.*` events. A payment carries `refundedAmount` and `verification`; a subscription's `amount` and `currency` are its own price, with `currency: null` when it has none. |
| `RekeyError` | The canonical error class — `instanceof`-consistent across SDK packages. |

### Pagination

Every list method resolves to the same envelope:

```ts
const { items, page } = await rekey.billing.getPlans();
// page → { total: 80, limit: 50, offset: 0, hasMore: true }
```

`page.total` is the count of matching rows ignoring `limit`/`offset`, so you can
tell a complete list from a window without over-fetching. **This is a breaking
change in 2.0.0-rc.3** — these methods used to resolve to a bare array, which
could not report that it had been truncated.

Request pagination is `{ limit, offset }` everywhere. Per-endpoint windows
(server-enforced — a larger `limit` is clamped or rejected):

| Method | Default `limit` | Max `limit` |
| --- | --- | --- |
| `organizations.listMine(accessToken, page?)` | 50 | 100 |
| `organizations.listMembers(accessToken, orgId, page?)` | 50 | 100 |
| `credits.listLedger(subject, limit?, offset?)` | 50 | 200 |
| `auth.listSessions(accessToken, page?)` | 50 | 100 |
| `auth.listPasskeys(accessToken, page?)` | 50 | 100 |
| `billing.getPlans(page?, opts?)` | 50 | 100 |
| `auth.listOAuthIdentities` | — (bare array; one row per provider the user linked, bounded by the Application's provider list) | — |

## Errors

Every failure is a `RekeyError` with `code`, `message`, and usually a concrete `fix` (plus optional `docs`, `statusCode`, `requestId`, `retryAfterSeconds`). **Read `error.fix` first.**

That includes failures where no server answered. A refused connection, a DNS failure or an expired deadline is a `RekeyError` too — one `catch` covers everything:

```ts
import { RekeyError } from '@rekey.dev/node';

try {
  await rekey.billing.createCheckout(accessToken, { planSlug: 'pro', successUrl, cancelUrl });
} catch (err) {
  if (err instanceof RekeyError) console.error(err.code, err.fix);
  throw err;
}
```

Transport codes, and what each one asks you to do:

| `code` | Meaning | What to do |
| --- | --- | --- |
| `REQUEST_TIMEOUT` | The deadline expired before a response. | Retry, or raise `timeoutMs`. |
| `NETWORK_ERROR` | The request never reached a server (refused, DNS, TLS). | Check `apiUrl` and reachability. `error.cause` has the original. |
| `REQUEST_ABORTED` | An `AbortSignal` you passed fired. | Your own cancellation — usually swallow it. |
| `RATE_LIMITED` | Too many requests. | Wait `error.retryAfterSeconds`, then retry. |

## Timeouts and cancellation

Every request carries a **10-second deadline** by default — the same one the Rekey API uses for its own outbound webhooks. Without it the effective timeout is undici's `headersTimeout`, five minutes, which is long enough for one unreachable deployment to pin a request handler.

<!-- snippet: no-check a fragment: no imports, and values from the surrounding code -->
```ts
// Client-wide.
const rekey = new Rekey({ apiUrl, secretKey, timeoutMs: 5_000 });

// One call. `with()` returns a cheap scoped clone; it works on every method.
const plans = await rekey.with({ timeoutMs: 2_000 }).billing.getPlans();

// Tie Rekey calls to an inbound request's lifetime.
app.get('/me', async (req, res) => {
  const scoped = rekey.with({ signal: AbortSignal.any([req.signal]) });
  res.json(await scoped.auth.getCurrentUser(token));
});
```

Pass `timeoutMs: 0` to opt out. `verifyAccessToken` takes its own `timeoutMs` / `signal` for the JWKS fetch.

## Calling an endpoint the SDK does not wrap

`rekey.request()` is a supported escape hatch — you keep the auth header, the `{ success, data }` unwrapping, the `RekeyError` mapping and the deadline:

```ts
const seats = await rekey.request<{ used: number }>('GET', '/api/v1/seats');
await rekey.request('POST', '/api/v1/seats', { body: { count: 5 }, timeoutMs: 30_000 });
```

Prefer a namespace method wherever one exists — those carry the endpoint's real types.

## Gotchas

- **Entitlements are resolved server-side.** Never gate features from client state — always read `rekey.billing.getEntitlements(...)` on the server.
- **`billingSubject: 'org'` needs an `organizationId`.** When the Application bills per-team (Panel → Application → Billing → Setup → Defaults), an individual can't hold a subscription — pass `organizationId` (a team the user owns/admins) to `createCheckout`. Omitting it throws `BILLING_ORGANIZATION_REQUIRED`. Read the live config via `rekey.applications.me()` (`billingConfig.billingSubject`) and drive your UI from it.
- **Checkout is async.** `createCheckout` returns a *PENDING* subscription + a redirect URL; the subscription flips to ACTIVE only when the **provider's webhook to Rekey** lands (Stripe/PayPal → Rekey — configured by the operator in the panel; your code never receives or verifies it). To react to activation, re-fetch `getSubscription` / `getEntitlements` when the user returns to your `successUrl`. `verifyWebhookSignature` is for the *other* direction — webhooks Rekey sends to your app (user-lifecycle events); see [docs/billing.md](https://github.com/rekey-dev/rekey/blob/main/docs/billing.md).
- **A checkout can charge the default price.** When no provider can charge the price selected for the buyer, `createCheckout` charges the plan's default price and sets `priceFallback`. Tell the buyer before you redirect them. Read `price` for what is charged.
- **Switching active org returns new tokens.** `organizations.switch` / `clearActive` return a fresh `{ accessToken, refreshToken }` pair — persist both, or later reads use the stale org view.
- **Pagination is `{ limit, offset }`.** Defaults to 50 everywhere; max is 100 for org lists and 200 for the credit ledger — see the [Pagination](#pagination) table.
- **Retrying a timed-out mutation? Send an `Idempotency-Key` header.** High-value mutating routes (checkout, subscription cancel, credits consume, and the operator create/mint/issue/grant endpoints) accept the header (max 200 chars, scoped to your Application): a retry with the same key replays the first response (`Idempotency-Replayed: true`) instead of executing twice; the same key with a *different* body is a `409 IDEMPOTENCY_KEY_REUSED`. Keys live 24 h; 5xx responses are never cached, so retries after server errors really re-execute. The body-level `idempotencyKey` on `credits.consume` still works — it dedupes the ledger entry itself. See [docs/concepts.md → Idempotent requests](https://github.com/rekey-dev/rekey/blob/main/docs/concepts.md#idempotent-requests).
- **One client per Application.** Construct a module-level singleton; don't `new Rekey()` per request. Never log the secret key.

## Links

- Docs: [/docs](https://rekey.dev/docs) · [SDK guide](https://rekey.dev/docs/sdk) · [API reference](https://rekey.dev/docs/api) · [agent prompt](https://rekey.dev/docs/prompt)
- Worked walkthroughs: [quickstart](https://github.com/rekey-dev/rekey/blob/main/docs/quickstart.md) · [webhooks](https://github.com/rekey-dev/rekey/blob/main/docs/webhooks.md) · [billing](https://github.com/rekey-dev/rekey/blob/main/docs/billing.md). The `examples/` apps were removed pending a rebuilt set.

## License

MIT
