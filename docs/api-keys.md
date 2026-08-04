# API Keys

Rekey has **three** distinct credentials. Confusing them is the #1 cause of integration bugs. Pick by **where the code runs** and **what it needs to do**.

| Credential | Format | Lives in | Authorizes | Can it move money / touch other users? |
|---|---|---|---|---|
| **Publishable key** | `rp_pub_<slug>_<random>` | Browser, mobile, desktop — safe in client code | Public **bootstrap** only: sign-in/up, magic-link, passkey, license verify, plan listing | **No.** Identity, not authorization — grants nothing on its own |
| **Secret key** | `rp_live_<rand>` / `rp_test_<rand>` | Your server only — never the browser | Everything for the whole Application | **Yes** — full app access. Treat like a DB password |
| **`SUPER_ADMIN_KEY`** | 32+ hex chars (env var) | The Rekey deployment itself | `/api/v1/admin/*` bootstrap (create tenants/apps) | Deployment-wide. Not Application-scoped |

**How to choose:**

- **Browser / mobile / desktop, signed-out user logging in or registering?** → publishable key (`@rekey.dev/react`, or `@rekey.dev/nextjs/client`). No backend required.
- **Your server doing anything trusted** — billing checkout, usage, credits, reading a specific user's data, account management? → secret key (`@rekey.dev/node`). Pass the end-user's JWT for per-user reads.
- **Provisioning tenants/apps at deploy time?** → `SUPER_ADMIN_KEY`.

**Rule of thumb**: if it starts with `rp_pub_`, it's safe in HTML. If it starts with `rp_live_` or `rp_test_`, it must never reach a browser.

> The publishable and secret keys are **not interchangeable**. A publishable key sent to a secret-only route is rejected (`401 API_KEY_INVALID`); a secret key in the browser is a credential leak. The split is the security model, not a limitation — see the [can/cannot table](#what-the-publishable-key-can-and-cannot-do) below.

## Publishable key

The publishable key is a **real browser credential** for the public-bootstrap routes — the things a signed-out user does before any token exists. It lets a frontend-only app (SPA, mobile, desktop, or AI-generated) sign users in and verify licenses **with no backend**.

It is **identity, not authorization**. It names the Application and asserts "legit public client"; it grants nothing on its own. Sign-in still requires the user's password / passkey / emailed token; license verify still requires the license key. That is why it is safe to ship in client code — exactly like Stripe's `pk_`, Supabase's anon key, or a Clerk publishable key.

Pass it to `@rekey.dev/react`:

```tsx
<RekeyProvider apiUrl="https://api.rekey.example.com" publishableKey="rp_pub_myapp-prod_…">
  <App />
</RekeyProvider>
```

```ts
// Browser, no backend:
const out = await client.signIn({ email, password });   // → SignInOutcome
const { items: plans } = await client.getPlans();         // public catalogue ({items, page})
const lic = await client.verifyLicense({ key, machineFingerprint });
```

### What the publishable key can and cannot do

| Allowed | Rejected (secret key only) |
|---|---|
| `auth`: sign-up, sign-in, mfa-verify, refresh, sign-out, forgot/reset/verify-email, magic-link, passkey authenticate | `GET /me` (credential self-inspection) |
| `oauth`: provider start + callback | `usage/record` + `usage/aggregate` |
| `licenses/verify` | `credits/*` (balance, consume, ledger) |
| `billing/plans` + `billing/providers` (catalogue) | |
| † account management: change-password, list/revoke passkeys + sessions, sign-out-everywhere | |
| † self-service billing: entitlements, payments, checkout, `billing/coupons/validate`, subscription cancel | |
| † org management (`users/me/organizations/*`) | |
| ‡ passkey **enrollment** (`passkey/register/*`) | |

† These additionally require the end-user's own JWT (`requireUserSession`), and that JWT — not the key — is the authorizer: every one of them acts solely on `request.endUser`. That is what lets a browser-only portal manage a team and take a payment with no secret key at all (Portal V2).

‡ Publishable callers must additionally **step up** — send `password`, or a current TOTP / unused backup `code` — at `passkey/register/start`. A passkey bypasses the MFA challenge at sign-in, and neither a password change nor sign-out-everywhere removes one, so a stolen access token alone must not be able to enroll it. `/complete` needs no second proof: the single-use challenge binds it to the `/start` that already stepped up. Secret-key callers skip step-up, because the customer's backend is the gate.

The gate is **route membership, not scope**. A publishable key is accepted only on routes that opted into `requirePublishableOrSecretKey`; `requireScope` returns early for a publishable caller rather than consulting scopes. Presenting one on a `requireApiKey` route returns **401 `API_KEY_INVALID`**. So widening the publishable set is a deliberate per-route decision — and a breaking one for tenants relying on `ipAllowlist`, which only constrains the secret-key path.

### Origin allowlist

A publishable key is public, so restrict **where** it works. Set the Application's CORS origins (Panel → Application → Access). When non-empty, a publishable request must carry a matching `Origin` header or it gets **403 `ORIGIN_NOT_ALLOWED`**. Empty = open (still rate-limited). Always set origins for production.

### Rotation

The publishable key rotates with a **grace window** — see [api-key-rotation.md](api-key-rotation.md#publishable-key-rotation).

## Creating a secret key

```bash
curl -X POST https://rekey.example.com/api/v1/admin/applications/$APP_ID/api-keys \
  -H "Authorization: Bearer $SUPER_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Production server"}'
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

There is no `mode` in the request body. The `rp_live_` / `rp_test_` prefix follows the **Application's environment** — see [Environments](#environments) — so the example above returns `rp_live_…` only if `$APP_ID` is a `PRODUCTION` application.

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

When `@rekey.dev/node` (or `curl`) sends `Authorization: Bearer rp_live_…`, Rekey's middleware ([`apps/api/src/middleware/api-key-auth.ts`](../apps/api/src/middleware/api-key-auth.ts)) does:

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

## Environments

An Application carries an `environment`: `PRODUCTION`, `STAGING`, or `DEVELOPMENT`. New applications are `DEVELOPMENT` unless you say otherwise, because going live should be a deliberate act rather than a default.

**The Application is the isolation boundary.** Every row in Rekey — end-users, subscriptions, payments, licences, credits, usage, organizations, webhook endpoints — carries an `applicationId`. So "keep my rehearsals away from my customers" is *use a second Application*, not *flip a mode on the same one*.

Rekey used to have a per-key `test`/`live` data mode instead. It was removed on 2026-07-30: it stamped only three models, so a "test" end-user still held real licences, burned real credits, wrote real usage rows and fired real webhooks. The isolation it advertised did not exist. Environments replace it with a boundary that was already real.

### What the environment actually controls

- **Billing credentials.** An Application's environment does not restrict which provider credentials it may hold — store live keys against a `DEVELOPMENT` Application if that is deliberately what you want to test against. What Rekey does guarantee is that the stored `mode` is not a lie: where the key states its own mode (Stripe `sk_live_`/`sk_test_`, Razorpay `rzp_live_`/`rzp_test_`) that is what gets recorded, and a contradicting `mode` in the request is refused with **400 `BILLING_CREDENTIALS_MODE_CONTRADICTED`**. PayPal credentials cannot be told apart, so there the declared mode is taken as given.
- **Key prefixes.** A `PRODUCTION` app mints `rp_live_…`; `STAGING` and `DEVELOPMENT` mint `rp_test_…`. You do not choose this at mint time. The prefix is a label for humans — so a key pasted into a chat window is identifiable at a glance — and nothing in the API branches on it beyond "is this shaped like a secret key".

That is the whole list. The environment is not a filter: it does not hide rows, scope queries, or change what any endpoint returns.

### Going live

You don't. The Application does not move — you make a new one.

`environment` is fixed when the Application is created and there is no endpoint that changes it afterwards. Going to production means creating a second Application with `environment: "PRODUCTION"`, storing your live provider credentials on it, and pointing your production deployment at its keys. The development Application keeps working, unchanged, for the next round of work.

```bash
curl -X POST https://rekey.example.com/api/v1/tenant/applications \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Northwind (production)", "slug": "northwind-prod", "environment": "PRODUCTION"}'
```

This is more work than flipping a field, and that is the trade. A mutable environment means every already-stored credential can be invalidated later by the Application changing underneath it — so every transition needs its own guard, and the one nobody writes is the one that ships a PRODUCTION app still holding sandbox keys: live-looking in every UI, charging nothing, discovered at reconciliation. Immutability removes the category.

What it costs you honestly: the new Application starts empty. Plans, coupons, meters, webhook endpoints and end-users do not come with it, and there is **no copy/clone flow yet** — you re-create the catalogue against the production Application. If that becomes the painful part, say so; a guided clone is deliberately not built until someone needs it.

### You still need a provider sandbox account

An environment is a Rekey-side property. It does not simulate a payment provider. To run an end-to-end checkout against a `DEVELOPMENT` or `STAGING` Application you need real sandbox credentials from the provider (Stripe `sk_test_…`, a PayPal sandbox app, Razorpay test keys) stored as that app's billing credentials.

There is no fallback if you skip that. Checkout without configured credentials fails with **400 `BILLING_CREDENTIALS_NOT_CONFIGURED`** in every environment, development included. Rekey used to substitute a stub provider that returned a plausible-looking checkout URL, which meant an integration could look finished while no money could ever move; that stub was deleted along with the data modes.
