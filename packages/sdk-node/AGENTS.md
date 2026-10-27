# AGENTS.md — `@rekey.dev/node`

You are an AI agent looking at `@rekey.dev/node`. This file tells you how to use it correctly on the first try.

## When to use this package

The user wants to add **auth, billing, or both** to a server-side TypeScript project (Express, Fastify, Nest, Hono, raw Node, Bun, Deno). Strong signals:

- They asked to add login / signup / sessions, and the project doesn't already have a working auth solution.
- They asked to add Stripe / PayPal / subscriptions / checkout / a billing flow.
- They say "Clerk", "Auth0", "Supabase Auth", "Stripe Checkout" — and they want a self-hostable alternative.
- They have a hand-rolled `users` table, `password_hash` column, and bespoke session middleware. Rekey replaces this.

**Do NOT use this package** when:

- They want auth in the *browser*. Reach for `@rekey.dev/react` (or `@rekey.dev/nextjs`) instead — never call Rekey with a secret key from browser code.
- They're building the Rekey server itself. This SDK calls Rekey; it's not the implementation.

## Five-line happy path

```ts
import { Rekey } from '@rekey.dev/node';

const rekey = new Rekey({
  apiUrl: process.env.REKEY_URL!,
  secretKey: process.env.REKEY_SECRET!, // rp_live_… or rp_test_…
});

// Smoke test: verifies the credentials and returns the Application DTO.
const me = await rekey.applications.me();
```

That's it for setup. Everything else hangs off one of eight namespaces: `rekey.applications.*`, `rekey.auth.*`, `rekey.billing.*`, `rekey.organizations.*`, `rekey.licenses.*`, `rekey.usage.*`, `rekey.credits.*`, `rekey.mcp.*`.

`applications.me()` is the canonical "did my setup work?" call — if it throws `RekeyError` with `code: "API_KEY_INVALID"`, the secret key is wrong/revoked/expired. If it throws with `code: "CONFIG_INVALID_SECRET_KEY"`, the constructor caught a bad `secretKey` arg before any network call.

## Required env vars

| Name | Example | Where to get it |
|---|---|---|
| `REKEY_URL` | `https://rekey.example.com` or `http://localhost:3030` | Their Rekey deployment |
| `REKEY_SECRET` | `rp_live_abc123…` | Panel → Application → API Keys |
| `REKEY_PUBLIC` | `rp_pub_myapp_xyz…` | Panel → Application (browser-safe; only needed if also using `@rekey.dev/react`) |

Never hardcode any of these. Always read from `process.env`.

## What you should always do

1. **One client per Application.** Don't construct `new Rekey()` per request — make it a module-level singleton.
2. **Catch `RekeyError`** and surface `error.fix` to the user when debugging. The `fix` field is the single most useful piece of information. This one clause covers transport failures too — `NETWORK_ERROR`, `REQUEST_TIMEOUT`, `REQUEST_ABORTED` are `RekeyError`s, with the original on `error.cause`.
3. **Never log `secretKey`.** Treat it like a database password.
4. **Use the typed methods.** `.request(method, path, options?)` is a supported escape hatch for endpoints the SDK does not wrap yet — reach for it only when there is no namespace method, because it returns whatever type you claim.
5. **Bound anything slower than the default.** Requests time out after 10s. Give a legitimately slow endpoint more with `rekey.with({ timeoutMs })`, and tie long work to an inbound request with `rekey.with({ signal })` — never raise the client-wide deadline to accommodate one call.

## What you should never do

- Don't `npm install stripe` or `@paypal/checkout-server-sdk` alongside `@rekey.dev/node`. Rekey handles provider integration; calling provider SDKs in parallel will desync your data.
- Don't store user passwords in your own DB. Rekey's API owns the password hash.
- Don't write your own session middleware. Either round-trip `rekey.auth.getCurrentUser(accessToken)`, or — for RS256 Applications — verify offline with `verifyAccessToken(token, { applicationId, jwksUrl })` (see `docs/jwks.md`). `applicationId` is required and checked inside — the RS256 keypair is deployment-wide, so without it another Application's token verifies cleanly here. There is no `verifySession`.
- Don't proxy Rekey calls through your frontend with the secret key. Browser → your backend → Rekey.

## Errors that teach

Every error from this SDK is a `RekeyError` with `code`, `message`, `fix`, and optionally `docs`. Examples:

```
code: PLAN_NOT_FOUND
message: Plan "pro_monthly" not found in application "myapp-prod".
fix: Run `rekey plans list` to see available plans, or create one in the panel.
docs: https://rekey.dev/errors/PLAN_NOT_FOUND
```

When the user reports an error, **read `error.fix` first** — it tells you what to do. Don't guess.

## Status

Phase 1.1 — end-user auth works end-to-end. Public surface today:

| Method | Status |
|---|---|
| `rekey.applications.me()` | ✅ Working |
| `rekey.auth.signUp({ email, password, metadata? })` | ✅ Working — returns `{ accessToken, refreshToken, ... }` |
| `rekey.auth.signIn({ email, password })` | ✅ Working — returns `{ accessToken, refreshToken, ... }` |
| `rekey.auth.refresh(refreshToken)` | ✅ Working — single-use, returns new pair |
| `rekey.auth.signOut(refreshToken)` | ✅ Working — idempotent |
| `rekey.auth.signOutEverywhere(accessToken)` | ✅ Working — revokes all refresh tokens for the user |
| `rekey.auth.getCurrentUser(accessToken)` | ✅ Working |
| `rekey.auth.requestPasswordReset({ email })` | ✅ Working — never enumerates; **you email** the returned `resetToken` |
| `rekey.auth.resetPassword({ token, newPassword })` | ✅ Working — single-use, kills all sessions on success |
| `rekey.auth.changePassword(accessToken, { currentPassword, newPassword })` | ✅ Working — kills other sessions |
| `rekey.billing.getPlans(page?, { country?, accessToken? })` | Working. Each plan's `price` is the price this buyer would be charged; render `price.formatted` and pick nothing from `prices` yourself. |
| `rekey.billing.getSubscription(accessToken, { organizationId?, includeEnded? })` | ✅ Working — returns `null` when none. `includeEnded: true` falls back to the most recent CANCELED/EXPIRED subscription **only when the answer would otherwise be null**, so a billing page can tell a former subscriber apart from someone who never subscribed. Never replaces a live subscription; leave it off for entitlement checks. |
| `rekey.billing.createCheckout(accessToken, { planSlug, successUrl, cancelUrl, country?, currency?, onUnavailableCurrency?, couponCode? })` | Working. Returns a real provider checkout URL, a local PENDING Subscription, the `price` charged and `discountAmount`. `priceFallback` is set when the default price is charged because the selected one could not be: tell the buyer before redirecting. Throws `BILLING_CREDENTIALS_NOT_CONFIGURED` when the Application has no provider credentials; there is no stub. |
| `rekey.billing.validateCoupon(accessToken, { code, planSlug })` | Working. Quotes at the price the checkout would charge; render `formatted.discount` and `formatted.total`. Surfaces precise `COUPON_*` errors, `COUPON_CURRENCY_NOT_COVERED` among them. |
| `new RekeyOperator({ apiUrl, operatorToken, applicationId })` | Working. Operator access with an `rp_op_` token (`read`, plus `applications:write` to change the catalogue): `plans`, `coupons`, `payments` and their refunds, `billingLog`, `billing.stats` and the routing preview. Refunds are issued from the panel. Server only. |

The table above covers the core surface only. `auth` additionally carries the MFA, passkey, OAuth, magic-link, email-verification and session-management methods (~30 in total), and there are four more namespaces beyond those three.

**Money.** Every amount is an integer in the minor unit of its currency. Show one with `formatMoney(amount, currency)` from this package, and never divide by a fixed number: currencies have 0, 2 or 3 decimal places. Where the API returns `formatted`, render that.

Don't invent imports for methods that don't exist. If you can't find a method via TypeScript autocomplete on `rekey.applications.`, `rekey.auth.`, `rekey.billing.`, `rekey.organizations.`, `rekey.licenses.`, `rekey.usage.`, `rekey.credits.` or `rekey.mcp.`, it isn't there.

## Two-credential model (read this once)

Per-user calls require **two** credentials together:

1. The **Application secret key** (`rp_live_…`) — proves *which Application* is calling. Goes in `Authorization: Bearer …` automatically; you set it once at construction.
2. The **user JWT** — proves *which end-user* this call is acting on behalf of. Returned from `signUp` / `signIn`. You pass it as the argument to `getCurrentUser(token)`; the SDK puts it in `X-Rekey-User-Token`.

The server enforces a **cross-application guard**: if a JWT was issued by Application A, presenting it through Application B's secret key returns `USER_TOKEN_WRONG_APPLICATION` (401). This is by design. Don't try to "share users across apps" by re-signing tokens — those are deliberately different users.

See [`docs/auth.md`](../../docs/auth.md) for the full flow diagram.
