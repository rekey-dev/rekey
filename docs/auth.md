# End-User Auth

This is what your customer's *users* go through to sign up and sign in to the customer's app. It is distinct from:

- The Application secret key (`rp_live_*`) — the customer's *server* presents that to ReliPay.
- The bootstrap admin key (`SUPER_ADMIN_KEY`) — operators present that to manage Tenants/Applications.

## Flow at a glance

```
Browser                  Customer's server                 ReliPay
   │                            │                              │
   │ ─── { email, password } ──>│                              │
   │                            │ POST /api/v1/auth/sign-up    │
   │                            │  Authorization: Bearer rp_live_xxx
   │                            │  body: { email, password }   │
   │                            │ ────────────────────────────>│
   │                            │                              │
   │                            │ <──── 201 { endUser, token, expiresAt }
   │                            │                              │
   │ <─── set cookie / token ───│                              │
   │                            │                              │
   │ ─── (later request) ──────>│                              │
   │                            │ GET /api/v1/users/me/        │
   │                            │  Authorization: Bearer rp_live_xxx
   │                            │  X-Relipay-User-Token: <jwt> │
   │                            │ ────────────────────────────>│
   │                            │ <──── 200 { id, email, ... } │
```

The **customer's server** is the trusted intermediary. It holds the Application secret key. It receives the user's password (over TLS) and forwards it to ReliPay. It receives the JWT and decides how to ship it back to the browser (cookie, response body, whatever the customer wants).

The browser **never** sees the Application secret key. The browser **may** see its own JWT (in a cookie or localStorage); that JWT is bound to one Application and one EndUser via the cross-app guard described below.

## Endpoints

### `POST /api/v1/auth/sign-up`

Creates a new EndUser in the calling Application.

```json
// request
{ "email": "alice@example.com", "password": "correct-horse-battery-staple", "metadata": { "name": "Alice" } }

// response (201)
{
  "success": true,
  "data": {
    "endUser": { "id": "...", "applicationId": "...", "email": "alice@example.com", "emailVerified": false, "metadata": { "name": "Alice" }, "createdAt": "..." },
    "token": "<jwt>",
    "expiresAt": "..."
  }
}
```

Errors: `EMAIL_ALREADY_EXISTS` (409), `PASSWORD_TOO_SHORT` (400), `AUTH_METHOD_DISABLED` (400).

Email is normalised to lowercase before storage. Email is unique per Application — the same address can exist in multiple Applications as separate users.

### `POST /api/v1/auth/sign-in`

Authenticates an existing EndUser. Same response shape as sign-up. Errors: `INVALID_CREDENTIALS` (401) for any auth failure (wrong email *or* wrong password *or* user signed up via OAuth) — single code on purpose, never disclose which.

### `GET /api/v1/users/me/`

Returns the current EndUser. Requires **two** headers:

- `Authorization: Bearer rp_live_…` — the Application secret key
- `X-Relipay-User-Token: <jwt>` — the user JWT obtained from sign-up/sign-in

Errors: `USER_TOKEN_MISSING` (401), `USER_TOKEN_INVALID` (401), `USER_TOKEN_WRONG_APPLICATION` (401).

## Tokens — access + refresh

Sign-up and sign-in return **two** tokens, used for different jobs:

| Token | Format | Lifetime | Where to send | What it's for |
|---|---|---|---|---|
| **Access** | JWT (HS256 default; RS256 opt-in) | 15 minutes | `X-Relipay-User-Token` header | Identifies the end-user on every per-user call (e.g. `GET /users/me`) |
| **Refresh** | Opaque base64url, 32 bytes random | 30 days, sliding | `body.refreshToken` of `POST /auth/refresh` | Mints a fresh access + refresh pair when the access expires |

### The access JWT

```
{ "sub": "<endUserId>", "applicationId": "<applicationId>", "iat": ..., "exp": ... }
```

- Algorithm: HS256 by default, signed with a per-Application key derived from `JWT_SECRET`. Applications can opt into **RS256** (`authConfig.tokenAlg: "RS256"`) — tokens are then signed with the deployment's RSA key and verifiable **offline** against `GET /.well-known/jwks.json` (the API accepts both algs, so switching never breaks outstanding tokens). See [jwks.md](jwks.md).
- **`applicationId` is load-bearing.** The user-session middleware refuses to act on a JWT whose `applicationId` doesn't match the Application that the calling secret key resolved to. This is the cross-tenant guard.

### The refresh token

- 32 bytes of CSPRNG entropy, base64url-encoded.
- Stored as SHA-256 hash in `refresh_tokens` (hash-only DB, same model as ApiKey). Raw value is shown to the caller exactly once when issued and is **unrecoverable** afterwards.
- **Rotated on use.** Calling `POST /auth/refresh` revokes the presented token (sets `revokedAt`) atomically with issuing the replacement. The chain is walkable via `replacedById`.
- **Single-use.** Replaying an already-used refresh returns `REFRESH_TOKEN_REUSED` (401). Treat this code as a strong signal of compromise — the original was likely leaked. (Future hardening: revoke the entire chain on detected replay; today we just refuse.)
- **Cross-application guard.** The refresh row carries `applicationId`; presenting it through a different Application's secret key returns `REFRESH_TOKEN_WRONG_APPLICATION`.

### Sign-out

`POST /auth/sign-out` revokes the presented refresh token. Idempotent — unknown tokens return 200 (no enumeration). The access token paired with the refresh remains valid until its 15-minute expiry; clear it client-side for full logout.

### Sign-out everywhere

`POST /auth/sign-out-everywhere` (requires user JWT) revokes **every** refresh token for the calling user. Use cases: "log out all devices" button, suspected compromise, after a password change, etc.

## Password management

Three endpoints — one unauthenticated reset flow + one authenticated change.

### Forgot password

```
POST /api/v1/auth/forgot-password   { email }
→ 200 { delivered: bool, resetToken: string | null }
```

- **Always returns 200** with the same shape, regardless of whether the email exists. The `delivered` flag tells the calling server which case it was. *Never* enumerate users via this endpoint.
- **ReliPay does not send email.** The customer's server receives the `resetToken` and ships it via its own provider (SendGrid, Resend, SES, etc.). This keeps us out of email-deliverability ops and lets each customer own their from-address branding.
- Token lifetime: 1 hour. Single-use. Stored as SHA-256 hash in `password_reset_tokens`.

### Reset password

```
POST /api/v1/auth/reset-password   { token, newPassword }
→ 200 { ok: true }
```

- Single-use token; consumed atomically (race-safe). Replays return `PASSWORD_RESET_TOKEN_USED`.
- On success, **every refresh token for the user is revoked** — anyone holding a session via the compromised credential is signed out.
- Cross-application guard: a token issued under app A is rejected if presented through app B's secret key (`PASSWORD_RESET_TOKEN_WRONG_APPLICATION`).
- Honours `passwordMinLength` from `Application.authConfig`.

### Change password (authenticated)

```
POST /api/v1/auth/change-password   { currentPassword, newPassword }
Headers: Authorization: Bearer rp_live_…  +  X-Relipay-User-Token: <jwt>
→ 200 { ok: true }
```

- Verifies `currentPassword` first — wrong returns `INVALID_CREDENTIALS`.
- On success, every refresh token for the user is revoked. The caller's *current* access token stays valid until its 15-min expiry.

### What's still deliberately not here

- **Sliding access tokens via cookie middleware.** We expose the primitives; auto-refresh is the SDK's job (Phase 1.4).
- **Replay-detection chain revocation.** When a `REFRESH_TOKEN_REUSED` fires, we currently only refuse the call. Future commit: revoke the entire `replacedById` chain so a leaked refresh can't keep the chain alive elsewhere.
- **Sign-out everywhere.** `revokeAllForEndUser` exists in `lib/refresh-tokens.ts` for password-change / compromise flows but no route surfaces it yet.

## Operator end-user management

Operators manage end-users from the panel (or the `/api/v1/tenant/applications/:id/end-users*` routes): seed users manually, edit role/metadata/verified flag, grant credits, impersonate (audited, 5-minute token), and delete.

### Data export (DSAR)

```
GET /api/v1/tenant/applications/:id/end-users/:euid/export
→ application/json attachment
```

Operator-initiated subject-access export for GDPR Art. 15 / CCPA requests. Returns one JSON document of everything ReliPay stores about the end-user: profile, OAuth identities, session **metadata** (never token hashes), MFA enrollment metadata (never secrets), passkey metadata, organization memberships, subscriptions, payments, licenses (key prefix only), credit balance + ledger, usage records (capped at the most recent 10 000 rows — see `notes` in the document), security events, and impersonation audits. Credential material (password hashes, token/secret material, license key hashes) is never included. OWNER/ADMIN only; every export is recorded as an `end_user.data_exported` security event. In the panel: end-user detail page → "Export data (JSON)".

### Data erasure (right to be forgotten)

```
DELETE /api/v1/tenant/applications/:id/end-users/:euid?erasure=true
→ { erased: true, erasedAt, alreadyErased }
```

Operator-initiated erasure for GDPR Art. 17 / CCPA delete requests. Unlike a plain `DELETE` (which cascade-removes the user **and** their financial records), erasure **tombstones** the user — hard-deleting PII/auth material while **retaining anonymized financial records** for accounting / legal-retention obligations. A tombstoned user can never authenticate again (every auth path rejects with `END_USER_ERASED`, HTTP 410). OWNER/ADMIN only; recorded as an `end_user.erased` security event and emits a `user.erased` outbound webhook. In the panel: end-user detail page → danger zone → "Erase (GDPR)" (type the email to confirm).

The full per-model cascade guarantee (delete / anonymize / retain) lives in **[docs/data-erasure.md](data-erasure.md)**.

## Honoring `Application.authConfig`

Each Application has an `authConfig`:

```ts
{
  methods: ('password' | 'google' | 'github' | 'magic_link')[],
  passwordMinLength: number,
  redirectUrls: string[],
  organizationsEnabled: boolean,
}
```

The auth module enforces:
- **`methods`** — sign-up/sign-in refuse with `AUTH_METHOD_DISABLED` if `"password"` isn't enabled.
- **`passwordMinLength`** — sign-up enforces this, returning `PASSWORD_TOO_SHORT` otherwise.

`google` / `github` / `magic_link` and `organizationsEnabled` are not yet wired — they land in subsequent slices.

## SDK usage

```ts
// 1. user signs up via your form, server posts to ReliPay
const { endUser, token } = await relipay.auth.signUp({
  email: req.body.email,
  password: req.body.password,
});
// store token however your stack stores sessions

// 2. on subsequent requests, look up the user
const user = await relipay.auth.getCurrentUser(req.cookies.session);
```

See [`packages/sdk-node/AGENTS.md`](../packages/sdk-node/AGENTS.md) for the full method surface.

## What's deliberately not here yet

- **Refresh tokens** — long-lived, hashed-in-DB, rotation on use. Lands in a follow-up.
- **OAuth providers** (Google, GitHub) — own modules, share `redact()` + `issueUserAccessToken()`.
- **Magic-link / passwordless** — own module.
- **MFA / TOTP** — separate concern, layered on top of base auth.
- **Org/team support** (Memberships, Invitations) — Phase 1.2+.
- **Account lockout / failed-attempt throttling** — relies on per-IP rate-limit today (global 100/min). Per-account lockout lands when we have observability to tune the parameters.
- **Email verification** flows — `emailVerified` exists on the schema, no flow yet.
