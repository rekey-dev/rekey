# End-User Auth

This is what your customer's *users* go through to sign up and sign in to the customer's app. It is distinct from:

- The Application secret key (`rp_live_*`) — the customer's *server* presents that to Rekey.
- The bootstrap admin key (`SUPER_ADMIN_KEY`) — operators present that to manage Tenants/Applications.

## Flow at a glance

```
Browser                  Customer's server                 Rekey
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
   │                            │  X-Rekey-User-Token: <jwt> │
   │                            │ ────────────────────────────>│
   │                            │ <──── 200 { id, email, ... } │
```

The **customer's server** is the trusted intermediary. It holds the Application secret key. It receives the user's password (over TLS) and forwards it to Rekey. It receives the JWT and decides how to ship it back to the browser (cookie, response body, whatever the customer wants).

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
- `X-Rekey-User-Token: <jwt>` — the user JWT obtained from sign-up/sign-in

Errors: `USER_TOKEN_MISSING` (401), `USER_TOKEN_INVALID` (401), `USER_TOKEN_WRONG_APPLICATION` (401).

### `PATCH /api/v1/users/me/`

Lets the signed-in EndUser edit **their own** record. Same two headers as the
GET; the JWT is the subject, so there is no user id anywhere in the request and
no way to aim this at another user.

Only `metadata` is writable. Email, role, password and erasure state are not
self-service and a body naming them is **refused** (`END_USER_UPDATE_INVALID`,
400) rather than silently ignored — the allowlist is closed so that a future
column is not writable by accident.

`metadata` is **shallow-merged at the top level**, not replaced:

| You send | Result |
|---|---|
| key omitted | left exactly as it was |
| `{"a": 1}` over `{"a": {"b": 2}, "c": 3}` | `{"a": 1, "c": 3}` — top-level key replaced wholesale, no deep merge |
| `{"c": null}` | `c` is deleted |
| `{"metadata": null}` | the whole object is cleared |
| `{}` | nothing changes |

Merged metadata is capped at 16KB serialized (`METADATA_TOO_LARGE`, 400); the
cap is checked after the merge, so a stream of small patches cannot grow past
it. **Every** writer applies the same cap — sign-up and the operator end-user
routes included — so an oversized blob cannot arrive by one door and then make
this route permanently un-writable.

One key inside `metadata` is reserved: **`oidc`**, refused here with
`METADATA_KEY_RESERVED` (400). It holds the identity claims the Application
asserts about the user to OpenID Connect relying parties (`name`,
`preferred_username`, `picture`, …), which are the fields an RP provisions
local accounts from — so they are the operator's to write, not the subject's.
Everything else in `metadata`, including top-level keys that happen to share a
claim's name, stays freely writable and is never emitted as a claim. See
[oidc-provider.md](oidc-provider.md#where-profile-claims-come-from).

SDK: `rekey.auth.updateCurrentUser(accessToken, { metadata })`.

## Tokens — access + refresh

Sign-up and sign-in return **two** tokens, used for different jobs:

| Token | Format | Lifetime | Where to send | What it's for |
|---|---|---|---|---|
| **Access** | JWT (HS256 default; RS256 opt-in) | 15 minutes | `X-Rekey-User-Token` header | Identifies the end-user on every per-user call (e.g. `GET /users/me`) |
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
- **Single-use, and a replay burns the family.** Replaying an already-used refresh returns `REFRESH_TOKEN_REUSED` (401) **and** revokes every refresh token the user holds (`revokeAllForEndUser`) before throwing. Treat the code as a strong signal of compromise — the original was likely leaked, and we can't tell the thief from the victim, so both are signed out rather than leaving the attacker's rotated token alive.
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
→ 200 { delivered: bool, emailSent: bool, resetToken: string | null }
```

- **Always returns 200** with the same shape, regardless of whether the email exists. The `delivered` flag tells the calling server which case it was. *Never* enumerate users via this endpoint.
- **Rekey sends the email when it can.** With an email transport configured (per-Application BYO Resend/SMTP, or a deployment-wide `RESEND_DEFAULT_API_KEY`), Rekey delivers it and `resetToken` is `null` — the raw token never leaves the server. With no transport, `emailSent: false` and a **secret-key** caller receives the raw token to ship via its own provider; that fallback is why the field exists at all, and it keeps self-hosters and customers who want their own from-address branding working. A publishable-key caller never receives a token, because that key ships in browser code.
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
Headers: Authorization: Bearer rp_live_…  +  X-Rekey-User-Token: <jwt>
→ 200 { ok: true }
```

- Verifies `currentPassword` first — wrong returns `INVALID_CREDENTIALS`.
- On success, every refresh token for the user is revoked. The caller's *current* access token stays valid until its 15-min expiry.

### What's still deliberately not here

- **Sliding access tokens via cookie middleware.** We expose the primitives; auto-refresh is the SDK's job (`@rekey.dev/nextjs` does it, `apps/panel` does it by hand).

Replay-chain revocation and sign-out-everywhere both shipped — see the refresh-token bullets above and `POST /auth/sign-out-everywhere`.

## Operator end-user management

Operators manage end-users from the panel (or the `/api/v1/tenant/applications/:id/end-users*` routes): seed users manually, edit role/metadata/verified flag, grant credits, impersonate (audited, 5-minute token), and delete.

### Data export (DSAR)

```
GET /api/v1/tenant/applications/:id/end-users/:euid/export
→ application/json attachment
```

Operator-initiated subject-access export for GDPR Art. 15 / CCPA requests. Returns one JSON document of everything Rekey stores about the end-user: profile, OAuth identities, session **metadata** (never token hashes), MFA enrollment metadata (never secrets), passkey metadata, organization memberships, subscriptions, payments, licenses (key prefix only), credit balance + ledger, usage records (capped at the most recent 10 000 rows — see `notes` in the document), security events, and impersonation audits. Credential material (password hashes, token/secret material, license key hashes) is never included. OWNER/ADMIN only; every export is recorded as an `end_user.data_exported` security event. In the panel: end-user detail page → "Export data (JSON)".

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
  sendVerificationEmailOnSignUp: boolean,  // default true
  requireEmailVerification: boolean,       // default false
}
```

The auth module enforces:
- **`methods`** — sign-up/sign-in refuse with `AUTH_METHOD_DISABLED` if `"password"` isn't enabled.
- **`passwordMinLength`** — sign-up enforces this, returning `PASSWORD_TOO_SHORT` otherwise.
- **`sendVerificationEmailOnSignUp`** (default **on**) — password sign-up mints a verification token and sends the `email_verification` mail alongside `welcome`. Both are fire-and-forget: a broken or absent transport is logged and dropped, never rolled back into the account creation. Magic-link sign-up and OAuth-first sign-up don't send it — the first creates the user with `emailVerified: true` (consuming the link is the proof), the second records the provider's own `email_verified` claim. **Ignored while `requireEmailVerification` is on**: the link is then the only way into a new account, so it goes out regardless.
- **`requireEmailVerification`** (default **off**) — a user whose `emailVerified` is false gets **no session at all**, refused with **403 `EMAIL_NOT_VERIFIED`** rather than `INVALID_CREDENTIALS`: the credential was right and the user needs to be told to check their inbox. Enforced at the single point every session is minted, so it covers sign-up (the account is created, but the response is the 403 — no access or refresh token), sign-in, MFA verification, organization switching, **and refresh**. Re-checking on refresh is what bounds the switch: flip it on and unconfirmed accounts that already hold a refresh token stop renewing within one access-token lifetime, rather than continuing for the 30-day chain. The check always runs after a credential verified, so it neither answers "does this address exist here" nor counts toward the brute-force lockout.

  Magic-link and OAuth sign-in **satisfy** the gate rather than skip it: each proves the address and records `emailVerified: true` (magic link does this for existing accounts too, not only at creation).

  It is also the prerequisite for the OpenID Connect `email` scope — see [oidc-provider.md](oidc-provider.md#why-email-needs-requireemailverification).

  Turning it on takes effect immediately for accounts that already exist, so send the verification email (above) before enforcing it. A blocked user can ask for a fresh link themselves with **`POST /api/v1/auth/resend-verification`** (`{ email }`, no session — that is the point, since this gate is what denies them one). It answers 200 with a constant body whatever happened, so it discloses nothing about which addresses have accounts, and it is rate-limited per (Application, address, IP) exactly like `/auth/forgot-password`. `POST /auth/send-verification` remains the authenticated version, for a user who *has* a session and is changing their address. Other routes back in: the original email, a magic link if that method is enabled, or an operator flipping the flag from Panel → Application → End-users.

  One prerequisite for both: a verification link has to be *buildable*. If the Application has no `appUrl`, no usable `redirectUrls` origin and the deployment has no `DEFAULT_APP_URL`, the automatic sign-up send and `resend-verification` are **skipped entirely** rather than mailing a confirmation with no button in it, and an `auth.email_delivery_failed` event is recorded naming the setting to fix. Set the Application URL (Panel → Application → Auth) before enabling the gate, or pass `verifyUrl` per call.

`google` / `github` (module `oauth`), `magic_link`, `passkey` and `organizationsEnabled` (module `organizations`) are all wired — enabling one in `authConfig.methods` is what opens the corresponding routes.

## SDK usage

```ts
// 1. user signs up via your form, server posts to Rekey
const { endUser, token } = await rekey.auth.signUp({
  email: req.body.email,
  password: req.body.password,
});
// store token however your stack stores sessions

// 2. on subsequent requests, look up the user
const user = await rekey.auth.getCurrentUser(req.cookies.session);
```

See [`packages/sdk-node/AGENTS.md`](../packages/sdk-node/AGENTS.md) for the full method surface.

## What's deliberately not here yet

Everything this section once listed has shipped: refresh tokens (documented above), OAuth providers (`modules/oauth`), magic link, TOTP MFA (`modules/mfa`), passkeys, orgs + invitations (`modules/organizations`), email verification, and per-account lockout. Kept as a pointer so the gap isn't re-filed as a roadmap item.

Genuinely open:

- **Lockout parameter tuning** — thresholds and windows are picked, not measured. Revisit with real sign-in telemetry.
- **SCIM / directory sync** and **SAML** — see [ENTERPRISE-ROADMAP.md](ENTERPRISE-ROADMAP.md).
