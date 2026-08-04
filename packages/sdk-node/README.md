# `@rekey.dev/node`

> **ReliPay is now Rekey.** This package was previously published as the equivalent `@relipay/*` package, which is deprecated. Env vars renamed `RELIPAY_*` → `REKEY_*` (as of 2.0.0 the old names are no longer read — set `REKEY_*`). relipay.dev (the old domain) will redirect to rekey.dev after the domain migration.

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
| API URL | `https://api.rekey.dev` or `http://localhost:3030` | Your Rekey deployment |

Convention: read both from the environment — never hardcode.

```bash
REKEY_URL=https://api.rekey.dev
REKEY_SECRET=rp_live_…   # the Application secret key
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
if (features.advanced_reporting) renderReportingTab();
```

### The two-credential model

Per-user calls require **two** credentials together:

1. The **Application secret key** — proves *which Application*. Set once at construction; sent as `Authorization: Bearer …` automatically.
2. The **user JWT** (returned by `signUp` / `signIn`) — proves *which end-user*. You pass it as the first argument to per-user methods; the SDK puts it in `X-Rekey-User-Token`.

A JWT issued by Application A presented through Application B's secret key is refused with `USER_TOKEN_WRONG_APPLICATION` (401), by design.

## Core API

Everything hangs off namespaces on the client. `amount` fields are always integers in the smallest currency unit (cents/paise/sen) — never floats.

### `rekey.applications`
| Method | Description |
| --- | --- |
| `me()` | Verify credentials + fetch the calling Application (your smoke test). |

### `rekey.auth`
| Method | Description |
| --- | --- |
| `signUp({ email, password, metadata? })` | Create an end-user; returns user + token pair. |
| `signIn({ email, password })` | Authenticate. Returns a `SignInOutcome` — **branch on `mfaRequired`** before reading `accessToken`. |
| `mfaVerify({ mfaChallengeToken, code })` | Exchange an MFA challenge for a real session. |
| `getCurrentUser(accessToken)` | Resolve the end-user behind a token (+ `activeOrganizationId`). |
| `updateCurrentUser(accessToken, { metadata })` | Let a signed-in user edit their own `metadata`. **Shallow-merged**, not replaced: omitted keys survive, a sent key replaces that top-level key wholesale, a key sent as `null` is deleted, and `metadata: null` clears it. Only `metadata` is writable — email/role/password are refused. |
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
| `startOAuth` / `completeOAuth` / `listOAuthIdentities` / `startOAuthLink` / `completeOAuthLink` / `unlinkOAuth` | Social sign-in + account linking. |

#### Email-sending methods: branch on `emailSent`

`requestPasswordReset` and `requestMagicLink` return a different shape depending on whether the Application has an email transport configured (BYO Resend creds, or `RESEND_DEFAULT_*` on the deployment). They never throw for an unknown email — enumeration-safe by design.

| Case | `delivered` | `emailSent` | token (`resetToken` / `magicLinkToken`) | Your job |
| --- | --- | --- | --- | --- |
| Transport configured, user exists | `true` | `true` | `null` | Nothing — Rekey sent the email. |
| No transport (or send failed), user exists | `true` | `false` | the raw token | **You** email the link via your own provider. |
| Unknown email | `false` | `false` | `null` | Nothing. Render the same neutral UI — never reveal. |

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
| `getPlans(page?)` | List the Application's active plans (public — render pricing pages). Returns `{items, page}`. |
| `getSubscription(accessToken, { organizationId?, includeEnded? })` | The user's active subscription, or `null`. `includeEnded: true` falls back to their most recent CANCELED/EXPIRED subscription **only when the answer would otherwise be null** — so a billing page can say what a former subscriber was on and when it ended, instead of showing them the same blank state as somebody who never subscribed. It never replaces a live subscription; leave it off for entitlement checks. |
| `createCheckout(accessToken, { planSlug, successUrl, cancelUrl, couponCode?, organizationId? })` | Start hosted checkout; returns the redirect URL + a PENDING subscription. Activation happens via the provider webhook. |
| `cancelSubscription(accessToken, { atPeriodEnd?, organizationId? })` | Cancel the user's subscription. Defaults to **at period end** — the row stays ACTIVE with `cancelAt` set until the day arrives, so read `cancelAt`, not `status`. Pass `atPeriodEnd: false` to end it immediately. The default is a *request*: a PAST_DUE subscription, a PENDING checkout, or an ACTIVE row with no known period end is canceled on the spot regardless. Ask `cancelsAtPeriodEnd(sub)` (exported from this package) before showing a confirmation, so you promise the outcome the caller will actually get. |
| `validateCoupon(accessToken, { code, planSlug })` | Price-check a coupon without applying it. |
| `getProviders(country?)` | The geo-routed list of enabled billing providers. |
| `getEntitlements(accessToken, { organizationId? })` | Resolve feature flags + limits + live credit balance. **Gate your app on this.** Cache it with a ~5-min TTL / stale-while-revalidate and bust on checkout success — see ["Caching entitlements" in docs/billing.md](https://github.com/rekey-dev/rekey/blob/main/docs/billing.md#caching-entitlements). |

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

### `rekey.credits` (prepaid / pay-as-you-go)
| Method | Description |
| --- | --- |
| `getBalance(subject)` | Spendable balance for `{ endUserId }` or `{ organizationId }`. |
| `consume(subject & { amount, idempotencyKey? })` | Idempotent drawdown. Throws `CREDITS_INSUFFICIENT` (402) when too low. |
| `listLedger(subject, limit?, offset?)` | Ledger entries, newest first (default 50, max 200). Returns `{items, page}`. |

#### `idempotencyKey` scoping & retry semantics

The key is unique per **Application** — `(applicationId, idempotencyKey)` on the append-only ledger — **not** per subject. Two consumes with the same key but different `endUserId`s collide: the second silently replays the first entry and **does not charge the second user**. So always embed the subject and the operation in the key:

```ts
// Recommended format: `${subjectId}:${operationId}` — stable per logical operation.
const result = await rekey.credits.consume({
  endUserId: user.id,
  amount: 1,
  idempotencyKey: `${user.id}:enrich-lead:${leadId}`, // ≤ 200 chars
});
if (!result.applied) {
  // Replay: this exact operation was already charged. `result.balance` and
  // `result.entryId` are from the ORIGINAL entry — safe to treat as success.
}
```

Retry semantics: a repeat with the same key (timeout retry, queue redelivery, double-click) is a no-op that returns the original result with `applied: false` — never a double charge and never an error. Keys never expire (the ledger is append-only for the life of the subject), so derive them from the operation, not from a timestamp or a random UUID minted per attempt — a fresh UUID per retry defeats the whole mechanism.

### `rekey.licenses`
| Method | Description |
| --- | --- |
| `verify({ key, machineFingerprint, label? })` | Verify a license key + record an activation. Always 200 — branch on `result.ok`. |

### `rekey.mcp` (bring-your-own MCP server)
| Method | Description |
| --- | --- |
| `introspect(token)` | Validate an inbound Rekey-issued MCP access token (RFC 7662). |
| `metadata()` | Fetch this Application's OAuth authorization-server metadata (RFC 8414). |

### Top-level exports
| Export | Description |
| --- | --- |
| `verifyWebhookSignature({ header, payload, secret, toleranceSeconds? })` | Verify the HMAC on a webhook **Rekey sends to your app** (user-lifecycle + billing events) against the **raw body bytes** + the `X-Rekey-Signature` header. Not for Stripe/PayPal webhooks — those go to Rekey, never to you (see [docs/billing.md](https://github.com/rekey-dev/rekey/blob/main/docs/billing.md)). |
| `verifyAccessToken(token, { applicationId, jwksUrl \| jwks })` | Verify an end-user access token **offline** (no API round-trip) against your deployment's `GET /.well-known/jwks.json`. RS256 only — the Application must opt in via `authConfig.tokenAlg: "RS256"`; default HS256 tokens still need `auth.getCurrentUser`. Fetches + caches the JWKS for 5 minutes, checks `kid`/signature/`exp`/`typ`, and returns the claims (`sub`, `applicationId`, `oid?`, …). **`applicationId` is required** — the RS256 keypair is deployment-wide, so without it a token minted for any other Application on the same deployment would verify here. (The HS256 default is unaffected: its key is derived per Application.) See [docs/jwks.md](https://github.com/rekey-dev/rekey/blob/main/docs/jwks.md). |
| `WEBHOOK_EVENTS` / `KNOWN_WEBHOOK_EVENTS` / `isKnownWebhookEvent` | The full outbound-event registry — `{ name, description }` pairs (and just the names) for the 17 events Rekey can send: `user.created/updated/deleted/erased`, `session.revoked`, `mfa.enabled/disabled`, `password.changed`, `email.verified`, `subscription.activated/canceled/past_due`, `payment.succeeded/failed`, `dunning.case_opened/case_recovered/case_exhausted`. Mirrors the API exactly; use it for event pickers / autocompleting an endpoint's `events` array rather than hardcoding this list. See [docs/webhooks.md](https://github.com/rekey-dev/rekey/blob/main/docs/webhooks.md). |
| `WebhookEventType` / `WebhookEventEnvelope<TData>` | Types for the event-name union and the delivery envelope (`{ eventId, occurredAt, type, applicationId, data }`). Dedupe on `eventId` — retries reuse it. |
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
| `billing.getPlans(page?)` | 50 | 100 |
| `auth.listOAuthIdentities` | — (bare array; one row per provider the user linked, bounded by the Application's provider list) | — |

## Errors

Every failure is a `RekeyError` with `code`, `message`, and usually a concrete `fix` (plus optional `docs`, `statusCode`, `requestId`, `retryAfterSeconds`). **Read `error.fix` first.**

That includes failures where no server answered. A refused connection, a DNS failure or an expired deadline is a `RekeyError` too — one `catch` covers everything:

```ts
import { RekeyError } from '@rekey.dev/node';

try {
  await rekey.billing.createCheckout(accessToken, { /* … */ });
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
- **`billingSubject: 'org'` needs an `organizationId`.** When the Application bills per-team (Panel → Application → Billing → Subject), an individual can't hold a subscription — pass `organizationId` (a team the user owns/admins) to `createCheckout`. Omitting it throws `BILLING_ORGANIZATION_REQUIRED`. Read the live config via `rekey.applications.me()` (`billingConfig.billingSubject`) and drive your UI from it.
- **Checkout is async.** `createCheckout` returns a *PENDING* subscription + a redirect URL; the subscription flips to ACTIVE only when the **provider's webhook to Rekey** lands (Stripe/PayPal → Rekey — configured by the operator in the panel; your code never receives or verifies it). To react to activation, re-fetch `getSubscription` / `getEntitlements` when the user returns to your `successUrl`. `verifyWebhookSignature` is for the *other* direction — webhooks Rekey sends to your app (user-lifecycle events); see [docs/billing.md](https://github.com/rekey-dev/rekey/blob/main/docs/billing.md).
- **Switching active org returns new tokens.** `organizations.switch` / `clearActive` return a fresh `{ accessToken, refreshToken }` pair — persist both, or later reads use the stale org view.
- **Pagination is `{ limit, offset }`.** Defaults to 50 everywhere; max is 100 for org lists and 200 for the credit ledger — see the [Pagination](#pagination) table.
- **Retrying a timed-out mutation? Send an `Idempotency-Key` header.** High-value mutating routes (checkout, subscription cancel, credits consume, and the operator create/mint/issue/grant endpoints) accept the header (max 200 chars, scoped to your Application): a retry with the same key replays the first response (`Idempotency-Replayed: true`) instead of executing twice; the same key with a *different* body is a `409 IDEMPOTENCY_KEY_REUSED`. Keys live 24 h; 5xx responses are never cached, so retries after server errors really re-execute. The body-level `idempotencyKey` on `credits.consume` still works — it dedupes the ledger entry itself. See [docs/concepts.md → Idempotent requests](https://github.com/rekey-dev/rekey/blob/main/docs/concepts.md#idempotent-requests).
- **One client per Application.** Construct a module-level singleton; don't `new Rekey()` per request. Never log the secret key.

## Links

- Docs: [/docs](https://rekey.dev/docs) · [SDK guide](https://rekey.dev/docs/sdk) · [API reference](https://rekey.dev/docs/api) · [agent prompt](https://rekey.dev/docs/prompt)
- Worked walkthroughs: [quickstart](https://github.com/rekey-dev/rekey/blob/main/docs/quickstart.md) · [webhooks](https://github.com/rekey-dev/rekey/blob/main/docs/webhooks.md) · [billing](https://github.com/rekey-dev/rekey/blob/main/docs/billing.md). The `examples/` apps were removed pending a rebuilt set.

## License

MIT
