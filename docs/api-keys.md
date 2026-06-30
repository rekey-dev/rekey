# API Keys

ReliPay has **three** distinct credentials. Confusing them is the #1 cause of integration bugs. Pick by **where the code runs** and **what it needs to do**.

| Credential | Format | Lives in | Authorizes | Can it move money / touch other users? |
|---|---|---|---|---|
| **Publishable key** | `rp_pub_<slug>_<random>` | Browser, mobile, desktop — safe in client code | Public **bootstrap** only: sign-in/up, magic-link, passkey, license verify, plan listing | **No.** Identity, not authorization — grants nothing on its own |
| **Secret key** | `rp_live_<rand>` / `rp_test_<rand>` | Your server only — never the browser | Everything for the whole Application | **Yes** — full app access. Treat like a DB password |
| **`SUPER_ADMIN_KEY`** | 32+ hex chars (env var) | The ReliPay deployment itself | `/api/v1/admin/*` bootstrap (create tenants/apps) | Deployment-wide. Not Application-scoped |

**How to choose:**

- **Browser / mobile / desktop, signed-out user logging in or registering?** → publishable key (`@relipay/react`, or `@relipay/nextjs/client`). No backend required.
- **Your server doing anything trusted** — billing checkout, usage, credits, reading a specific user's data, account management? → secret key (`@relipay/node`). Pass the end-user's JWT for per-user reads.
- **Provisioning tenants/apps at deploy time?** → `SUPER_ADMIN_KEY`.

**Rule of thumb**: if it starts with `rp_pub_`, it's safe in HTML. If it starts with `rp_live_` or `rp_test_`, it must never reach a browser.

> The publishable and secret keys are **not interchangeable**. A publishable key sent to a secret-only route is rejected (`401 API_KEY_INVALID`); a secret key in the browser is a credential leak. The split is the security model, not a limitation — see the [can/cannot table](#what-the-publishable-key-can-and-cannot-do) below.

## Publishable key

The publishable key is a **real browser credential** for the public-bootstrap routes — the things a signed-out user does before any token exists. It lets a frontend-only app (SPA, mobile, desktop, or AI-generated) sign users in and verify licenses **with no backend**.

It is **identity, not authorization**. It names the Application and asserts "legit public client"; it grants nothing on its own. Sign-in still requires the user's password / passkey / emailed token; license verify still requires the license key. That is why it is safe to ship in client code — exactly like Stripe's `pk_`, Supabase's anon key, or a Clerk publishable key.

Pass it to `@relipay/react`:

```tsx
<RelipayProvider apiUrl="https://api.relipay.example.com" publishableKey="rp_pub_myapp-prod_…">
  <App />
</RelipayProvider>
```

```ts
// Browser, no backend:
const out = await client.signIn({ email, password });   // → SignInOutcome
const plans = await client.getPlans();                   // public catalogue
const lic = await client.verifyLicense({ key, machineFingerprint });
```

### What the publishable key can and cannot do

| Allowed (public-bootstrap) | Rejected (secret key only) |
|---|---|
| `auth`: sign-up, sign-in, mfa-verify, refresh, sign-out, forgot/reset/verify-email, magic-link, passkey authenticate | billing checkout, subscription cancel, usage record, credits consume |
| `oauth`: provider start + callback | license **issuance**, org management |
| `licenses/verify` | account management (change-password, list/revoke passkeys + sessions) |
| `billing/plans` (catalogue) | `GET /me`, `billing/providers` |

Reaching a secret-only route with a publishable key returns **401 `API_KEY_INVALID`** — those routes use `requireApiKey`, which rejects `rp_pub_*` outright. A publishable request can never structurally reach them.

### Origin allowlist

A publishable key is public, so restrict **where** it works. Set the Application's CORS origins (Panel → Application → Access). When non-empty, a publishable request must carry a matching `Origin` header or it gets **403 `ORIGIN_NOT_ALLOWED`**. Empty = open (still rate-limited). Always set origins for production.

### Rotation

The publishable key rotates with a **grace window** — see [api-key-rotation.md](api-key-rotation.md#publishable-key-rotation).

## Creating a secret key

```bash
curl -X POST https://relipay.example.com/api/v1/admin/applications/$APP_ID/api-keys \
  -H "Authorization: Bearer $SUPER_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Production server", "mode": "live"}'
```

Response:

```json
{
  "success": true,
  "data": {
    "apiKey": {
      "id": "ckxxx...",
      "applicationId": "ckyyy...",
      "name": "Production server",
      "keyPrefix": "rp_live_aBcD",
      "scopes": ["*"],
      "createdAt": "2026-05-05T..."
    },
    "rawKey": "rp_live_aBcD-EFGH...32-byte-token...",
    "warning": "Store this rawKey now — it is shown exactly once and cannot be recovered."
  }
}
```

**Save `rawKey` immediately.** It is not in the database — only the SHA-256 hash is. There is no recovery path other than minting a new key.

## Storage model

- `key_hash` — SHA-256(rawKey), unique-indexed. The lookup column.
- `key_prefix` — first 12 chars of the raw key for UI display ("which key is this?"). **Not** a credential.
- `scopes` — `string[]`. Defaults to `["*"]` (full access). Recognised values:
  - `auth:read`, `auth:write`
  - `billing:read`, `billing:write`
  - `webhooks:read`
  - `*` — all of the above
- `expires_at` — optional. Verification rejects expired keys.
- `revoked_at` — soft-delete. Revoked keys are kept for audit.

### Why SHA-256, not Argon2?

API keys are 24 bytes of CSPRNG entropy — uncrackable by online brute force. Argon2 is for *user-chosen passwords*, where slowdown buys protection against weak inputs. For random tokens, fast verification is correct.

## Limits

- 25 active keys per Application. Revoke before creating more.
- Keys never auto-rotate. Operators rotate explicitly: create new → swap in deploy → revoke old.

## Verifying a key in your code

When `@relipay/node` (or `curl`) sends `Authorization: Bearer rp_live_…`, ReliPay's middleware ([`apps/api/src/middleware/api-key-auth.ts`](../apps/api/src/middleware/api-key-auth.ts)) does:

1. Pre-filter on prefix (`rp_live_` / `rp_test_`). A `rp_pub_*` or anything else returns **401 `API_KEY_INVALID`** with a `fix` message pointing the caller at the right credential type.
2. SHA-256 hash the raw value.
3. `prisma.apiKey.findUnique({ where: { key_hash } })`.
4. Reject if `revoked_at !== null` or `expires_at < now`.
5. Resolve `apiKey.applicationId` → `Application` row. Attach both to `request.application` and `request.apiKey` for the rest of the handler chain.
6. Fire-and-forget update on `last_used_at`.

This is the only chokepoint. Don't add bespoke verification elsewhere.

The first endpoint to use this middleware is **`GET /api/v1/me`** — used by SDKs as a credentials smoke test. Returns the `Application` DTO (no secrets).

## What never to do

- Never log raw keys. They appear in `body.rawKey` (creation response) and `headers.authorization` (every request) — both are in the logger redact list. Don't add log statements that bypass redaction.
- Never return a raw key on a list/get endpoint. Hash-only DB by design.
- Never compare keys with `===`. Use the indexed-lookup path or `timingSafeEqualHex` from `lib/keys.ts`.
- Never put a secret key in client-side code. Browser code uses the **public key** only.

## Test mode

A secret key's `mode` (`live` / `test`) is more than a prefix: test and live data are **parallel universes** (roadmap §7 v1). Every `EndUser`, `Subscription`, and `Payment` row carries a `mode` column (`TEST` / `LIVE`), stamped at creation from the calling key, and the public API scopes by it.

### What test mode isolates

- **Sign-ups**: a user created through an `rp_test_` key is stamped `TEST` (password, magic-link, and OAuth sign-up paths alike). `rp_live_` keys (and rows that predate the feature) are `LIVE`.
- **Auth**: a live key cannot sign in, refresh, or read a test user, and vice versa. Wrong-mode sign-ins get the same **401 `INVALID_CREDENTIALS`** as a nonexistent email (no enumeration); presenting a valid user JWT through a wrong-mode key gets **403 `DATA_MODE_MISMATCH`**.
- **Subjects**: credits balance/consume/ledger and usage record/aggregate refuse end-user subjects of the other mode (`END_USER_NOT_FOUND`).
- **Checkout**: a test-key checkout only selects billing credentials stored with `mode: test` (a sandbox provider account) and stamps the Subscription/Payments `TEST`. If only live credentials are configured, checkout fails with **400 `BILLING_MODE_MISMATCH`**. `billing.getProviders()` through a test key lists only test-mode providers.
- **Revenue stats**: the operator Billing Overview / revenue dashboard counts **live data only** — test subscriptions and payments never inflate MRR or payment volume.
- **Dunning**: cases inherit the subscription's mode. TEST cases run the same day-0/3/7/14 state machine but log reminders (`metadata.reminders[].outcome = "skipped_test_mode"`) instead of emailing the end-user.
- **Operator surfaces**: the panel and tenant API see **both** modes; list payloads carry `mode`, rows show a `TEST` badge, and lists accept a `?mode=TEST|LIVE` filter.
- **Outbound webhooks**: `user.*`, `subscription.*`, `payment.*`, and `dunning.*` payloads include the object's `mode` so consumers can branch.

One caveat: email is unique per `(application, email)` **across** modes — the same address cannot exist as both a test and a live user.

### What still needs a provider sandbox account

ReliPay's test mode isolates *ReliPay's* data; it does not simulate a payment provider. To run a real end-to-end test checkout you still need sandbox credentials at the provider (Stripe `sk_test_…`, a PayPal sandbox app, Razorpay test keys) stored as billing credentials with `mode: test`. Without them, test-mode checkouts fail with `BILLING_MODE_MISMATCH` (or, when no credentials are configured at all, fall through to the dev stub provider). Provider webhooks from a sandbox account flow through the same per-app webhook endpoint and inherit the subscription's `TEST` mode.
