# Errors

Every error from a Rekey API or SDK has the same shape:

```json
{
  "success": false,
  "error": {
    "code": "TENANT_NOT_FOUND",
    "message": "Tenant \"ckxxx\" not found.",
    "fix": "List tenants with GET /api/v1/admin/tenants to see valid ids.",
    "requestId": "9f1c0a3e-8b47-4d21-9f0e-2c5a7b13d840"
  }
}
```

`code`, `message`, `fix` and `requestId` are always present. Two fields are optional and appear only where they apply:

- **`issues`** — on `VALIDATION_ERROR` (400): an array of `{ path, message }` naming each field that failed, capped at 10 entries. This is what tells you *which* key a `.strict()` endpoint refused.
- **`retryAfterSeconds`** — on the retryable codes listed below.

There is also a `docs` field in the envelope type, reserved for a per-code documentation URL. **No error the API emits sets it today**, so do not branch on its presence — this page is the reference it would point at.

**Read `error.fix` first.** It is the most actionable field. We treat the absence of a `fix` on any new error as a bug.

Every response also carries an `X-Request-Id` header (and, on errors, `error.requestId`) — grep the server logs for it to find the matching backtrace. It is a UUID, unique per request across restarts and replicas. If you send your own `X-Request-Id`, Rekey echoes it back so a trace spans your proxy and the API; the value is clamped to 64 characters of `[A-Za-z0-9._:@+=/-]` first, so anything longer or stranger comes back trimmed.

Retryable errors carry a `Retry-After` header **and** `error.retryAfterSeconds` (same value, in seconds): `RATE_LIMITED` (429), `TOO_MANY_FAILED_ATTEMPTS` / `MFA_TOO_MANY_ATTEMPTS` (429), `IDEMPOTENCY_KEY_IN_FLIGHT` (409), and `DEPENDENCY_UNAVAILABLE` (503). Honour it before retrying; nothing else in this document is worth retrying without a code change.

`error.code` is one of the codes listed below. Fastify's internal `FST_ERR_*` identifiers are normalised away before the response is written (`FST_ERR_VALIDATION` and `FST_ERR_CTP_INVALID_JSON_BODY` → `BAD_REQUEST`, `FST_ERR_CTP_INVALID_MEDIA_TYPE` → `UNSUPPORTED_MEDIA_TYPE`, and so on) — if you ever see one, that's a bug. Write your client so an unrecognised code degrades to "handle by status class" rather than throwing: a 4xx thrown by a plugin with a `code` of its own can still reach you verbatim, and this list grows.

## How errors propagate

- Service code throws `RekeyError({ statusCode, code, message, fix, docs? })`.
- Fastify's global error handler (`lib/error.ts`) turns it into the envelope above.
- `@rekey.dev/node` decodes the envelope into a typed `RekeyError` with `err.code`, `err.fix`, `err.docs`.

## Authoring guidelines

When you write a new error path:

1. **Code** — `SCREAMING_SNAKE_CASE`. Stable across versions; clients switch on it. Include the resource: `TENANT_NOT_FOUND`, `APPLICATION_SLUG_TAKEN`, `API_KEY_LIMIT_REACHED`.
2. **Message** — one sentence, includes the offending value when safe (`Slug "myapp" is not URL-safe.`).
3. **Fix** — concrete remediation. Imperative voice. If there's a CLI command or an API call that resolves it, name it. Avoid vague phrasing ("check your config").
4. **Status code** — match HTTP semantics. 401 for auth, 403 for authorized-but-not-allowed, 404 for missing, 409 for conflicts, 400 for validation, 402 for payment/quota, 429 for rate-limit, 5xx for server problems.

Bad error:

```ts
throw new Error('not found');
```

Good error:

```ts
throw new RekeyError({
  statusCode: 404,
  code: 'PLAN_NOT_FOUND',
  message: `Plan "${slug}" not found in application "${appId}".`,
  fix: 'Run `rekey plans list` to see available plans, or create one with POST /api/v1/admin/applications/:id/plans.',
});
```

## Code reference

The complete list of codes the API emits today, grouped by domain. This list is the spec for client compatibility — add new codes here when you introduce them.

### General / platform

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `INTERNAL_ERROR` | 500 | Unhandled server-side exception (message is opaque to clients in production). | Don't retry blindly. Grep the server logs for `requestId`. |
| `DEPENDENCY_UNAVAILABLE` | 503 | A backing service this deployment owns is unreachable — the `message` names which (PostgreSQL or Redis). Never carries a host, port, or connection string. | `GET /health/ready` reports `db` and `redis` separately; restore the failed one. Honour `Retry-After`. |
| `ROUTE_NOT_FOUND` | 404 | No route matches the method + path. | Check the path against `/docs` (OpenAPI). Usually a typo or a missing trailing segment. |
| `METHOD_NOT_ALLOWED` | 405 | The path exists but not for this verb (e.g. `GET` on an MCP JSON-RPC endpoint). | Read the `Allow` header. |
| `BAD_REQUEST` | 400 | The route's JSON-schema validation failed (the `message` names the field and the constraint, e.g. `body/amount must be <= 100000000000`), or the JSON body didn't parse. Also the catch-all for any Fastify-native 4xx without a code of its own. | Compare the request body/query against the route schema in `/docs`. Money fields cap at 10^11 minor units and counts at the `int4` range — a value past those is refused here rather than 500-ing at the database. |
| `VALIDATION_ERROR` | 400 | A handler's own schema parse failed — as opposed to the route-level one that raises `BAD_REQUEST`. Carries an **`issues`** array of `{ path, message }` (max 10). This is what the config `PATCH` endpoints answer for an **unrecognised key**: `auth-config`, `billing-config`, `portal`, `access`, `end-user-roles` and `usage-meters` all reject keys they don't know rather than accepting the request and ignoring them, so a typo like `mfaa` for `mfa` can no longer report success while changing nothing. | Read `issues` — it names the offending keys verbatim (`Unrecognized key(s) in object: 'mfaa'`). |
| `INVALID_BODY` | 400 | The JSON body contains a **NUL byte** (`\u0000`), anywhere — nested objects, array entries, or object *keys*. Postgres cannot store it, so it is refused at the edge instead of surfacing as a 500. The guard runs ahead of routing, so a NUL body on a path that doesn't exist answers 400 rather than 404; a clean body on an unknown path still 404s. | Strip `\u0000` from the value before sending. It is almost always a truncation bug or a probe, not data you meant to store. |
| `INVALID_QUERY` | 400 | Same, for a `%00` sequence in the URL's query string. | Remove the `%00` from the request URL. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The request body's `Content-Type` isn't JSON on an endpoint that only takes JSON. Form-encoded bodies are accepted **only** on the MCP OAuth endpoints, where RFC 6749/7662 require them. | Send `Content-Type: application/json`. A form-encoded body used to parse and then fail validation as a missing field — this is that mistake, reported honestly. |
| `PAYLOAD_TOO_LARGE` | 413 | The whole request body is over the 1 MiB limit, rejected by the HTTP layer before any handler runs. Not to be confused with `METADATA_TOO_LARGE` (400) — see the note under [Auth — end-user sessions & passwords](#auth--end-user-sessions--passwords). | Split the request. |
| `SSRF_BLOCKED` | 400 | A server-side fetch target (e.g. a webhook URL) resolved to a private/loopback address. | Use a publicly routable URL. |
| `RATE_LIMITED` | 429 | A **request-rate** limiter tripped — the deployment-wide limiter (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`, keyed per API key), the tighter per-identity cap on auth endpoints, or the per-Application ceiling across auth endpoints. | Back off for `Retry-After` seconds. `x-ratelimit-limit` / `-remaining` / `-reset` are on every response — pace ahead of the limit rather than discovering it. |
| `TOO_MANY_FAILED_ATTEMPTS` | 429 | **Credential lockout**, not request-rate: 10 failed password sign-ins for one (Application, email) inside 15 minutes locks that account for 15 minutes — end-user and operator sign-in both. Even the correct password is refused for the window. | Wait for `Retry-After` seconds, then retry. Don't loop. A successful sign-in clears the counter. |

The two 429s are different systems and you handle them differently. `RATE_LIMITED` means *you* are sending too fast — back off and continue. `TOO_MANY_FAILED_ATTEMPTS` means one **account** has too many failed passwords — retrying with the same credentials won't help until the window ends, and if it wasn't your user typing, someone is guessing at that account.

### Idempotency (generic `Idempotency-Key` header)

Selected mutating routes accept an `Idempotency-Key` header for safe blind retries — see ["Idempotent requests" in concepts.md](concepts.md#idempotent-requests) for the full semantics (scoping, replay, 24 h TTL).

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `IDEMPOTENCY_KEY_INVALID` | 400 | The header is empty, longer than 200 chars, or sent more than once. | Send one header with a stable unique string (a UUID works well). |
| `IDEMPOTENCY_KEY_REUSED` | 409 | The key was already used for a **different** request (method, path, or body hash doesn't match the original). | A key identifies one logical operation. Reuse it only for byte-identical retries; mint a fresh key for new operations. |
| `IDEMPOTENCY_KEY_IN_FLIGHT` | 409 | A request with this key is still executing (concurrent duplicate). | Honour `Retry-After` (1 s) and retry with the same key — you'll get the stored response once the original finishes. |

### Admin (bootstrap) & tenants

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `ADMIN_AUTH_MISSING` | 401 | `/api/v1/admin/*` called without `Authorization: Bearer <SUPER_ADMIN_KEY>`. | Send the deployment's `SUPER_ADMIN_KEY` as a bearer token. |
| `ADMIN_AUTH_INVALID` | 401 | The presented admin key doesn't match `SUPER_ADMIN_KEY`. | Check the env value on the deployment you're actually targeting. |
| `PANEL_URL_NOT_CONFIGURED` | 503 | Operator MCP consent needs `PANEL_URL`, which has no default — a default would send your operators to Rekey's panel. | Set `PANEL_URL` to your panel origin on the API and restart. |
| `ADMIN_IP_NOT_ALLOWED` | 403 | This deployment sets `ADMIN_IP_ALLOWLIST` and the request came from an address outside it. Raised *before* the key is examined, so it says nothing about whether the key was valid. | Call from an allowed address, or add yours to `ADMIN_IP_ALLOWLIST` and restart the API. Behind a proxy, check `TRUSTED_PROXIES` — otherwise every request appears to come from the proxy. |
| `TENANT_NOT_FOUND` | 404 | Tenant id doesn't exist (admin routes, workspace lookups). | List tenants with `GET /api/v1/admin/tenants`. |
| `TENANT_QUOTA_EXCEEDED` | 403 | Creating a **new** end-user would put the workspace over a limit set in `Tenant.limits` (see [concepts.md → Workspace limits](concepts.md#workspace-limits)). Existing end-users are unaffected — sign-in never returns this. | Raise the ceiling via `PUT /api/v1/admin/tenants/:id/limits` (super-admin only), or free capacity by deleting/erasing end-users. |
| `INVALID_TENANT_LIMITS` | 400 | The `PUT /api/v1/admin/tenants/:id/limits` body has an unknown key or an out-of-range value. Unknown keys are rejected rather than ignored, so a typo can't silently leave a workspace uncapped. | Send only documented limit keys; `{}` clears every limit. |

### API keys & request auth

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `API_KEY_MISSING` | 401 | Public-API call had no `Authorization: Bearer <secretKey>` header. | Send the Application secret key (`rp_live_…` / `rp_test_…`). |
| `API_KEY_INVALID` | 401 | Bearer credential is unknown / revoked / expired / wrong type (e.g. a public key or admin key sent to the public API). Single code on purpose — refusing to identify the kind of mistake stops credential-probing. | Mint a fresh secret key and check you're using the right credential type (see [api-keys.md](api-keys.md)). |
| `API_KEY_SCOPE_INSUFFICIENT` | 403 | The key's `scopes` don't cover this endpoint. | Mint a key with the needed scope (or `*`). |
| `IP_NOT_ALLOWED` | 403 | The key has an IP allowlist and your address isn't on it. | Update the key's allowlist in the panel, or call from an allowed address. |
| `PUBLISHABLE_KEY_INVALID` | 401 | The presented publishable key (`rp_pub_…`) is unknown or rotated out past its grace window. | Use the current publishable key from Panel → Application. If you just rotated, redeploy clients with the new key. |
| `ORIGIN_NOT_ALLOWED` | 403 | A publishable-key request came from a browser origin not on the Application's CORS allowlist (or with no `Origin`). | Call from an allowlisted origin, or add it in Panel → Application → Access. |
| `PUBLIC_KEY_ROTATION_IN_GRACE` | 409 | Rotate-public-key called while a previous key is still in its grace window (only one previous-key slot exists). | Wait for the window to end, or pass `force: true` to drop the previous key now (leaked-key path). |
| `API_KEY_LIMIT_REACHED` | 400 | Application already has 25 active keys. | Revoke unused keys before creating more. |
| `API_KEY_NOT_FOUND` | 404 | Key id doesn't exist or belongs to a different Application. | List the Application's keys to find the right id. |
| `API_KEY_EXPIRY_IN_PAST` | 400 | `expiresAt` on key creation is already in the past. | Pass a future timestamp or omit it. |
| `SIGNUP_REQUIRES_SECRET_KEY` | 403 | Sign-up was called with a publishable key on an Application whose signup posture is `secret_only`. | Call sign-up server-side with a secret key; keep the publishable key for browser sign-in. |

### Applications

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `APPLICATION_NOT_FOUND` | 404 | Application id or slug doesn't exist (or isn't in your workspace). | Verify the id/slug; list applications for your tenant. |
| `APPLICATION_SLUG_INVALID` | 400 | Slug fails the URL-safe regex. | Lowercase alphanumerics and hyphens. |
| `APPLICATION_SLUG_TAKEN` | 409 | Slug already exists. | Pick another slug. |
| `PORTAL_NOT_FOUND` | 404 | Hosted-portal config lookup for a slug/domain with no portal enabled. | Enable the portal in Panel → Application → Portal, or check the URL. |
| `PORTAL_DOMAIN_TAKEN` | 409 | The custom portal hostname is already claimed by another Application. | Pick a different hostname. |

### Auth — end-user sessions & passwords

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `AUTH_METHOD_DISABLED` | 400 | Sign-up/sign-in via a method (`password`, `magic_link`) not enabled in `Application.authConfig.methods`. | Enable the method in the panel, or use an enabled one. |
| `SIGNUP_DISABLED` | 403 | Public sign-up is off for this Application (invite-only posture). | Create users server-side, or enable sign-up. |
| `PASSWORD_TOO_SHORT` | 400 | Password below `authConfig.passwordMinLength`. | Surface the minimum to the user. |
| `PASSWORD_BREACHED` | 400 | Password appears in known breach corpora (k-anonymity check). | Ask the user for a different password. |
| `EMAIL_ALREADY_EXISTS` | 409 | Sign-up hit the `(applicationId, email)` unique constraint (also operator sign-up). | Route the user to sign-in / password reset instead. |
| `INVALID_CREDENTIALS` | 401 | Sign-in failed (wrong email *or* wrong password — never disclosed which), or wrong `currentPassword` on change. | Show a generic "email or password is incorrect". |
| `EMAIL_NOT_VERIFIED` | 403 | The Application sets `authConfig.requireEmailVerification` and this end-user's address is still unconfirmed. Raised wherever a session would be minted — **sign-up** (the account IS created, and the verification mail IS sent; only the session is refused), sign-in, MFA verification, org switching and **refresh**. Always after a credential verified, so it is neither an account-existence oracle nor a failed attempt against the lockout. | Tell the user to click the link in their verification email, and offer a "send it again" button wired to `POST /api/v1/auth/resend-verification` — that route takes `{ email }` and needs no session, because this refusal is what denies them one. (`POST /api/v1/auth/send-verification` is the authenticated sibling and is not reachable here.) Never show "wrong password". |
| `END_USER_ERASED` | 410 | The account was permanently erased on a GDPR data-subject request and can no longer authenticate. The per-Application OAuth/OIDC surface enforces the same rule in the OAuth dialect instead: `invalid_grant` at the token endpoint, `invalid_token` at `/userinfo` and the MCP endpoint. | Not recoverable — create a fresh account if the person returns. |
| `METADATA_KEY_RESERVED` | 400 | A metadata write named the reserved `oidc` key from an end-user session or a publishable key. That namespace holds the OIDC identity claims the Application asserts about the user, so only the operator may write it. | Store your own profile fields under any other key. To set claims, use a secret key or `PATCH /api/v1/tenant/applications/:id/end-users/:endUserId`. |
| `METADATA_TOO_LARGE` | 400 | `EndUser.metadata` would exceed 16KB serialized. Enforced on every writer — sign-up, the self-service PATCH (measured *after* the merge) and the operator end-user routes. | Keep large values (files, documents, long text) in your own storage and store a reference here. |
| `END_USER_UPDATE_INVALID` | 400 | The body of `PATCH /api/v1/users/me` named a field that is not self-service. The allowlist is closed and holds exactly one key, `metadata`; anything else — `email`, `role`, `password`, erasure state — is refused loudly rather than dropped silently, so an integrator finds out at once instead of shipping a call that appears to work. | Send `{ "metadata": { … } }` only. Email, role and password changes have their own routes. |
| `END_USER_NOT_FOUND` | 404 | EndUser id unknown, or belongs to a different Application than the calling secret key. | Verify the id and that you're using the right Application's key. |
| `USER_TOKEN_MISSING` | 401 | Per-user endpoint called without the `X-Rekey-User-Token` header. | Pass the user's access JWT as the per-user argument in the SDK. |
| `USER_TOKEN_INVALID` | 401 | User JWT malformed, expired, or signed with a different secret. | Refresh the session (`auth.refresh`) and retry once. |
| `USER_TOKEN_WRONG_APPLICATION` | 401 | JWT issued by a different Application than the calling secret key. **The cross-tenant guard.** | You're mixing credentials from two Applications — fix your config. |
| `IMPERSONATION_SESSION_ENDED` | 401 | The presented token is an operator impersonation token whose `impersonation_audits` row has been ended (`POST /api/v1/tenant/applications/:id/end-users/:euid/impersonate/end`), or that names no live row at all. Impersonation is revocable: ending the row invalidates the token immediately, ahead of its 5-minute expiry. | Mint a fresh token via the impersonate route if the session is still needed. |
| `IMPERSONATION_ACTION_FORBIDDEN` | 403 | An impersonating operator tried a credential-changing route — password change, MFA setup/disable, passkey enrolment or removal. Those changes outlive the 5-minute token permanently and the user cannot tell who made them, so they are refused for impersonated sessions regardless of who holds the token. Reads, billing, organizations and profile edits are unaffected. | Ask the user to perform the action themselves, or act through the operator panel. |
| `REFRESH_TOKEN_INVALID` | 401 | Refresh token unknown to the server (or not valid for session refresh). | Send the user through sign-in again. |
| `REFRESH_TOKEN_REUSED` | 401 | Refresh token already used. **Treat as a compromise signal** — all sessions for the user are revoked as a precaution. | Force re-authentication; investigate where the old token leaked. |
| `REFRESH_TOKEN_REVOKED` | 401 | The token was explicitly revoked — sign-out, sign-out-everywhere, an operator ending the session, or the family being burned by a `REFRESH_TOKEN_REUSED` elsewhere. Distinct from `_REUSED`: this token was never presented twice, it was invalidated by something else. | Send the user through sign-in again. Not on its own a compromise signal. |
| `REFRESH_TOKEN_EXPIRED` | 401 | Refresh token past its 30-day window. | Send the user through sign-in again. |
| `REFRESH_TOKEN_WRONG_APPLICATION` | 401 | Refresh token belongs to a different Application. | Fix the credential mix-up. |

**`METADATA_TOO_LARGE` (400) and `PAYLOAD_TOO_LARGE` (413) are different errors and want different handling.** The 413 is the HTTP layer refusing a >1 MiB *request*, before any handler runs, on every endpoint; the 400 is one handler refusing a `metadata` object that would push a single `EndUser` row past 16KB. A client switching on "too large" must switch on the code, not the phrase: the 413 says *split this request*, the 400 says *this field will never fit, move the value out of it*. The name is also the one code in this document that breaks the resource-prefix convention above (its peers are `END_USER_*`, `COUPON_*`) — it shipped that way in 2.0.0-rc.1, which is published, so it stays. Nothing about it is deprecated.

### Auth — email flows (reset, verification, magic link)

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `PASSWORD_RESET_TOKEN_INVALID` | 401 | Reset token unknown. | Ask the user to request a new reset. |
| `PASSWORD_RESET_TOKEN_USED` | 401 | Reset token already consumed. **Treat as a compromise signal.** | Issue a fresh reset; consider notifying the user. |
| `PASSWORD_RESET_TOKEN_EXPIRED` | 401 | Reset token past its 1-hour window. | Issue a fresh reset. |
| `PASSWORD_RESET_TOKEN_WRONG_APPLICATION` | 401 | Reset token from a different Application. | Fix the credential mix-up. |
| `EMAIL_ALREADY_VERIFIED` | 400 | `POST /auth/send-verification` (the authenticated route) for an already-verified address. Never raised by `POST /auth/resend-verification`, which answers 200 whatever the address's state — telling an anonymous caller "that one is already confirmed" is an account oracle. | Nothing to do — treat as success in UI. |
| `EMAIL_VERIFICATION_TOKEN_INVALID` / `EMAIL_VERIFICATION_TOKEN_USED` / `EMAIL_VERIFICATION_TOKEN_EXPIRED` / `EMAIL_VERIFICATION_TOKEN_WRONG_APPLICATION` | 401 | Verification token unknown / consumed / past 24 h / cross-Application. | Re-send the verification email. |
| `EMAIL_VERIFICATION_STALE` | 401 | Token was issued for a different email than is currently on the account. | Re-send verification for the current address. |
| `MAGIC_LINK_INVALID` / `MAGIC_LINK_USED` / `MAGIC_LINK_EXPIRED` / `MAGIC_LINK_WRONG_APPLICATION` | 401 | End-user magic-link token unknown / consumed / expired / cross-Application. | Request a new magic link. |
| `MAGIC_LINK_STALE` | 401 | Magic-link token issued for a different email than is currently on the account. | Request a new magic link. |
| `EMAIL_EVENT_UNKNOWN` | 404 | Tenant email-template route given an unknown event key. | Use one of the documented email event keys. |

### MFA (end-user and operator)

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `MFA_NOT_ENABLED` | 403 | MFA endpoints called but two-factor is not enabled for the Application. | Enable MFA in `authConfig` first. |
| `MFA_NOT_INITIATED` | 400 | `/mfa/setup-confirm` called before `/mfa/setup`. | Call setup first; confirm with the code from the authenticator. |
| `STEP_UP_REQUIRED` | 401 | A privileged self-service action was attempted without re-proving identity. End-user: enrolling a passkey (publishable callers only — secret-key callers are exempt). Operator: enrolling a passkey, and re-running `/tenant/auth/mfa/setup` or `/tenant/auth/mfa/disable` while MFA is enrolled. | Send `password` with the account password, or `code` with a current authenticator or unused backup code. **While an operator has MFA enrolled, the MFA routes accept only `code`** — the password is deliberately refused, since someone holding a stolen session and the password is who the second factor exists to stop. |
| `STEP_UP_UNAVAILABLE` | 400 | The account has neither a password nor enrolled MFA, so there is no second factor to confirm with. The access token is its only credential. | Have the user set a password or enroll MFA first, then retry. |
| `MFA_CODE_INVALID` | 401 (sign-in verify, or re-enrolling MFA from a browser) / 422 (setup-confirm) | TOTP or backup code didn't verify, or was not sent when re-running `/auth/mfa/setup` over a completed enrollment. | Prompt the user to retry; codes are time-based. |
| `MFA_CHALLENGE_INVALID` | 401 | MFA challenge token invalid or past its 5-minute lifetime. | Restart sign-in to get a new challenge. |
| `MFA_CHALLENGE_WRONG_APPLICATION` | 401 | Challenge token issued under a different Application. | Fix the credential mix-up. |
| `MFA_TOO_MANY_ATTEMPTS` | 429 | MFA verification throttled after repeated failures. | Wait for `Retry-After`, then retry. |

### Passkeys / WebAuthn

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `WEBAUTHN_NOT_CONFIGURED` | 400 | The Application (or the panel) has no WebAuthn RP config — ceremonies can't run. | Configure `authConfig.webauthn` (or `PANEL_WEBAUTHN_RP_ORIGINS` for operators). |
| `WEBAUTHN_CHALLENGE_INVALID` | 401 | Challenge unknown, expired, already used, or for a different ceremony. | Restart the ceremony from `start…`. |
| `WEBAUTHN_ALREADY_REGISTERED` | 409 | This passkey credential is already registered (end-user). | Treat as success or prompt for a different authenticator. |
| `WEBAUTHN_AUTH_INVALID` | 400/401 | Authentication response malformed (400) or didn't verify (401). | Restart authentication. |
| `WEBAUTHN_REGISTRATION_FAILED` | 401 | Registration response didn't verify. | Restart registration. |
| `PASSKEY_ALREADY_REGISTERED` | 409 | Operator-side duplicate authenticator. | Same as above, operator panel flows. |
| `PASSKEY_AUTHENTICATION_FAILED` | 401 | Operator passkey authentication didn't verify. | Restart the ceremony. |
| `PASSKEY_REGISTRATION_FAILED` | 400 | Operator passkey registration didn't verify. | Restart the ceremony. |
| `PASSKEY_RESPONSE_INVALID` | 400 | Operator passkey response missing a credential id. | Send the full WebAuthn response object. |
| `PASSKEY_UNKNOWN` | 401 | No operator account matches that passkey. | Sign in another way and (re-)register the passkey. |
| `PASSKEY_NOT_FOUND` | 404 | Passkey id isn't registered to this account (delete). | List passkeys to get a valid id. |

### OAuth (social sign-in) & MCP

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `OAUTH_PROVIDER_UNKNOWN` | 404 | Provider name isn't one Rekey knows. | Use a supported provider slug. |
| `OAUTH_PROVIDER_NOT_CONFIGURED` | 400 | Application (or operator panel) has no client id/secret for this provider. | Configure the provider's credentials first. |
| `OAUTH_NOT_CONFIGURED` | 503 | Operator OAuth redirect base not configured on the deployment. | Set the panel OAuth env config. |
| `OAUTH_NO_EMAIL` | 400 | Provider returned no email — can't create/sign in a user. | Ask the user to use a provider account with an email, or another method. |
| `OAUTH_EMAIL_NOT_VERIFIED` | 401 | Provider didn't verify the email — auto-linking to an existing account is refused. | User must verify the email at the provider, or sign in with the original method and link explicitly. |
| `OAUTH_IDENTITY_TAKEN` | 409 | This provider account is already linked to a different user. | Unlink it from the other account first. |
| `OAUTH_IDENTITY_WRONG_APPLICATION` | 401 | Provider account already linked under a different Application. | Fix the credential mix-up. |
| `OAUTH_UNLINK_WOULD_LOCK_OUT` | 409 | Unlinking would leave the account with no sign-in method. | Add a password or another provider before unlinking. |
| `INVALID_REDIRECT_URI` | 400 | MCP OAuth dynamic registration: `redirect_uris` empty, >20 entries, or a URI fails validation. | Register 1–20 valid redirect URIs. |
| `CLIENT_REGISTRATION_DISABLED` | 403 | `POST /oauth/register` on an Application with `authConfig.dynamicClientRegistration = false`, or on the **operator** MCP authorization server with `OPERATOR_MCP_DYNAMIC_REGISTRATION=disabled`. The endpoint exists and the deployment is real; the operator has closed registration, and `registration_endpoint` is absent from the discovery documents. | Ask the operator to register your redirect URIs and issue a `client_id`, or to re-open registration. |
| `MCP_NOT_FOUND` | 404 | No MCP server at this path — the Application is missing, or neither `mcpEnabled` nor (for the shared OAuth endpoints) `oidcEnabled` is set. | Check the Application slug in the MCP URL, and the toggle. |
| `OIDC_NOT_FOUND` | 404 | No OpenID Provider at this path (`/.well-known/openid-configuration`, `/oauth/userinfo`). The Application is missing or `oidcEnabled` is off. | Set `authConfig.oidcEnabled = true`, and check the slug. |
| `OPERATOR_MCP_UNAUTHORIZED` | 401 | Operator MCP called without a PAT (`rp_op_…`) or OAuth access token. | Pass a valid operator credential. |
| `MCP_GRANT_INVALID` | 400 | Operator-MCP consent POST (`/oauth/grant`) body didn't parse. | Send the OAuth params the authorize redirect carried, plus `tenant_id` and `approve`. |
| `MCP_GRANT_INVALID_CLIENT` | 400 | Consent named an unknown `client_id`, or a `redirect_uri` that client never registered. Deliberately not a redirect — we don't bounce to an unvalidated URI. | The client must complete RFC 7591 registration first. |
| `MCP_GRANT_PKCE_REQUIRED` | 400 | `code_challenge_method` wasn't `S256`. | Use PKCE with S256; `plain` is not accepted. |
| `TENANT_MEMBERSHIP_REQUIRED` | 403 | Operator-MCP consent chose a workspace the signed-in operator doesn't belong to. | Pick a workspace from your memberships. |

### Billing — checkout, providers, credentials

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `BILLING_DISABLED` | 403 | Billing endpoints called but billing isn't enabled for the Application. | Enable billing in the panel. |
| `BILLING_ORGANIZATION_REQUIRED` | 400 | The Application bills per organization (`billingSubject: 'org'`) but checkout had no `organizationId`. | Pass the active org's id to `createCheckout`; read `billingConfig.billingSubject` from `applications.me()`. |
| `PROVIDER_CANCEL_FAILED` | 502 | Deleting an end-user was refused because the payment provider would not cancel their still-active subscription. The user was NOT deleted. | Cancel it in the provider dashboard, or fix the stored credentials, then retry. To satisfy an erasure request without waiting on the provider, use the erase endpoint — it tombstones the user and does not block. |
| `BILLING_PROVIDER_SWITCH_BLOCKED` | 409 | Checkout named a `provider` other than the one this buyer's live subscription is bound to, anywhere in the Application. A subscription cannot move between processors, so this would create a second one and bill twice. One-off purchases (credit packs, perpetual licences) neither trigger this nor cause it. | Check out through the bound provider, which is `provider` on the active subscription, or cancel that subscription, let it terminate, and start a new one elsewhere. A checkout that names no `provider` is pinned to the bound one instead of refused. |
| `BILLING_SUBSCRIPTION_SUBJECT_CONFLICT` | 409 | The buyer already holds a live subscription to this plan billed to a different subject — their personal account when the checkout names an organization, or another organization. A subscription to one plan is stored once per buyer, so this checkout would MOVE the existing one rather than start a second: the current holder would lose the entitlement while the provider kept charging for it. | Cancel the existing subscription and let it terminate before starting one for a different billing subject, or bill the two subjects on separate plans. `GET /billing/subscription` (with `organizationId` for an org's) says which subject holds it. |
| `BILLING_BOUND_PROVIDER_UNAVAILABLE` | 409 | The buyer is bound to a provider that is no longer configured or enabled for the Application, so no checkout can be issued for them. Distinct from `BILLING_PROVIDER_NOT_AVAILABLE`, which is about a provider the CALLER named. | Re-enable that provider so existing subscribers can keep buying, or cancel their subscription there, let it terminate, and have them buy again through an enabled provider. |
| `BILLING_PROVIDER_NOT_AVAILABLE` | 400 | Checkout requested a provider that isn't enabled for this Application. | Omit `provider` (geo router picks) or use one from `billing.getProviders()`. |
| `BILLING_CREDENTIALS_MODE_CONTRADICTED` | 400 | The submitted `mode` disagrees with what the credential itself says (e.g. an `sk_live_…` key sent as `mode: test`). The key decides — the provider SDK authenticates with the key, not with our label. | Send the credentials for the mode you meant, or omit `mode` and let it be read from the key. |
| `BILLING_CREDENTIALS_NOT_CONFIGURED` | 400/404/503 | No credentials for the provider. **400** on checkout and on webhook auto-registration; **404** when an operator route addresses credentials that were never stored (e.g. setting the mode on them); **503** when a provider webhook arrives for an Application with no BYO credentials / webhook secret. There is no stub fallback in any environment. | Set the provider credentials + webhook secret in the panel. |
| `BILLING_CREDENTIALS_INVALID` | 400 | Submitted credentials fail shape validation (wrong fields for the provider). | Match the documented per-provider body shape. |
| `BILLING_CREDENTIALS_DECRYPT_FAILED` | 500 | Stored credentials can't be decrypted (e.g. `ENCRYPTION_KEY` changed). | Re-save the credentials; keep `ENCRYPTION_KEY` stable. |
| `BILLING_CREDENTIALS_PROVIDER_MISMATCH` / `BILLING_CREDENTIALS_SHAPE_INVALID` | 500 | Stored credentials are internally inconsistent. | Re-save the provider credentials. |
| `BILLING_WEBHOOK_AUTOCONFIG_UNSUPPORTED` | 400 | Automatic webhook registration isn't supported for this provider. | Create the webhook in the provider dashboard and paste the secret. |
| `BILLING_WEBHOOK_BASE_NOT_PUBLIC` | 400 | Webhook auto-config needs a public base URL but the deployment's base is private/localhost. | Use a public URL (or a tunnel in dev). |
| `BILLING_WEBHOOK_REGISTRATION_FAILED` | 502 | The provider's API rejected webhook registration. | Read the message; fix credentials/permissions at the provider, retry. |
| `BILLING_PROVIDER_ERROR` | 502 | A call to the payment provider's API failed — checkout, plan registration, or subscription cancellation. Most often the stored credentials are wrong or for the other mode (live keys with `mode=test`). **Branch on this** for "the provider, not the caller, is at fault": before 2.0.0-rc.3 these surfaced as `500 INTERNAL_ERROR` or as the provider's own `401` relabelled `BAD_REQUEST`, so there was no billing-specific code to switch on. | Operator responses carry the provider's own message; end-user responses deliberately do not (it can contain credential fragments) — those are in the server log against the `requestId`. Re-check the Application's billing credentials + mode, then retry. |
| `BILLING_PROVIDER_UNKNOWN` | 400 | A provider name that isn't in the module registry at all (distinct from `BILLING_PROVIDER_NOT_AVAILABLE`, which is a real provider this Application hasn't enabled). | Use a registered provider name. |
| `BILLING_DISCOUNT_UNSUPPORTED` | 400 | Checkout carried a `couponCode`, but the provider it routed to cannot apply a discount on that flow (PayPal and Razorpay: recurring subscriptions). Nothing is charged and nothing is redeemed. | Retry without the coupon, or pass an explicit `provider` that supports it — see `capabilities.discounts` in `GET /billing/providers`. |
| `SUBSCRIPTION_NOT_FOUND` | 404 | Subscription id unknown in this Application/workspace. | List subscriptions to get a valid id. |

### Billing — plans & entitlements

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `PLAN_NOT_FOUND` | 404 | Plan slug unknown for this Application. | `rekey plans list` or `GET /billing/plans`. |
| `PLAN_SLUG_INVALID` | 400 | Plan slug fails the regex (lowercase alphanumerics + `-` + `_`). | Fix the slug. |
| `PLAN_SLUG_TAKEN` | 409 | Plan slug already exists for this Application. | Pick another slug — or, if the existing plan failed provider registration, repair it in place (`PATCH .../plans/:slug`, then `POST .../plans/:slug/register`). The `fix` says which. |
| `PLAN_AMOUNT_INVALID` | 400 | Plan amount is negative. (Amount is the smallest currency unit — integers only.) | Pass an integer ≥ 0. |
| `PLAN_INACTIVE` | 400 | Checkout requested for a deactivated plan. | Reactivate the plan or point checkout at an active one. |
| `PLAN_NOT_REGISTERED_WITH_PROVIDER` | 409 | The plan has no price at the payment provider — its registration was refused, or it predates the registration column. Raised at checkout, and when an operator tries to activate such a plan. | Operator: fix the provider credentials if they were the cause, then `POST /api/v1/tenant/applications/:id/plans/:slug/register`. |
| `PLAN_PRICE_IMMUTABLE` | 409 | `PATCH` tried to change `amount`/`currency`/`interval` on a plan already registered with a provider. | A provider price object cannot be re-priced. Retire the plan (`{"active": false}`) and create a replacement. Price edits are accepted only while the plan is unregistered. |
| `PLAN_CREDITS_AMOUNT_REQUIRED` | 400 | CREDIT-kind plan missing a positive credit amount. | Set `creditsAmount`. |
| `PLAN_LICENSE_KIND_REQUIRED` / `PLAN_LICENSE_DURATION_REQUIRED` / `PLAN_LICENSE_SEATS_REQUIRED` | 400 | LICENSE-kind plan missing its kind / TIMED duration / SEATS count. | Fill the license config for the chosen kind. |
| `PLAN_USAGE_CONFIG_REQUIRED` / `PLAN_USAGE_METER_UNKNOWN` | 400 | USAGE-kind plan missing usage config, or referencing a meter that doesn't exist. | Create the meter first; reference its slug. |
| `PLAN_ENTITLEMENT_INVALID` | 400 | Entitlement row fails validation for its kind. | Match the entitlement schema for the kind. |
| `PLAN_ENTITLEMENT_NOT_FOUND` | 404 | Entitlement id not on this plan. | List the plan's entitlements. |
| `DEFAULT_PLAN_NOT_FOUND` | 400 | Setting an Application's free-tier `defaultPlanSlug` to a plan that doesn't exist or isn't active. | Pass an existing active plan slug, or `null` to clear it. |

### Coupons

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `COUPON_NOT_FOUND` | 404 | Code unknown for this Application (or no active auto-apply match). | Check the code; list coupons in the panel. |
| `COUPON_CODE_INVALID` | 400 | Create — code fails the regex (alphanumerics + `_-`, ≤ 40 chars). | Fix the code. |
| `COUPON_AMOUNT_INVALID` | 400 | Create — `amountOff` < 0, or PERCENT > 10000 (basis points). | Fix the amount. |
| `COUPON_CODE_TAKEN` | 409 | Create — `(applicationId, code)` collision. | Pick another code. |
| `COUPON_INACTIVE` | 400 | Validate — `active === false`. | Surface "coupon not valid" to the user. |
| `COUPON_NOT_YET_STARTED` / `COUPON_EXPIRED` | 400 | Validate — outside the `startsAt`/`endsAt` window. | Surface to the user. |
| `COUPON_NOT_APPLICABLE` | 400 | Validate — plan slug not in the coupon's `planSlugs`. | Surface to the user. |
| `COUPON_CURRENCY_MISMATCH` | 400 | Validate — AMOUNT coupon in a different currency than the plan. | Surface to the user. |
| `COUPON_REDEMPTION_LIMIT_REACHED` / `COUPON_USER_LIMIT_REACHED` | 400 | Validate — total / per-user redemption cap hit. `COUPON_REDEMPTION_LIMIT_REACHED` also fires at **checkout** when every remaining redemption is reserved by a checkout already in progress: the global limit counts recorded redemptions plus in-flight checkouts, so a one-use coupon cannot be discounted by five concurrent buyers. Reservations expire within 30 minutes, so an abandoned checkout frees its slot. | Surface to the user. If the coupon has redemptions left on paper, another buyer is mid-checkout — retrying shortly may succeed. |
| `COUPON_NO_DISCOUNT` | 400 | Checkout — the discount rounds down to zero at this price (a small PERCENT coupon on a cheap plan). | Use a coupon worth at least one unit of the plan currency. Nothing is redeemed. |
| `COUPON_FULL_DISCOUNT_UNSUPPORTED` | 400 | Checkout — the coupon covers 100% of a ONE-TIME purchase, and no provider will check out a zero-value order. | Use a smaller coupon, or grant the credits/licence directly. (A 100% coupon on a recurring plan is fine.) |
| `COUPON_CHECKOUT_ALREADY_OPEN` | 409 | Checkout — this end-user already has a live checkout holding this coupon's reserved slot. One buyer cannot hold two reservations against the same code; the discount already minted is still payable. | Finish or abandon the open checkout — the reservation frees itself within 24 hours. Do **not** advise a different coupon; the one they have still works. |
| `COUPON_DISCOUNT_EXCEEDS_PRICE` | 500 | Checkout — the discount came out larger than the plan. This is a Rekey bug; the coupon service is supposed to clamp it. | Report it with the coupon code and plan slug. |
| `COUPON_PROVIDER_REJECTED` | 502 | Checkout — the payment provider refused to create the ad-hoc discount object (currency or amount restrictions on the operator's account). Nothing is charged and nothing is redeemed. | Retry without the coupon, or check the provider account. Previously surfaced as an opaque 500. |

### Usage (metering)

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `USAGE_METER_NOT_FOUND` | 404 | Meter slug unknown for this Application. | Create the meter, or check the slug. |
| `USAGE_METER_INACTIVE` | 400 | Recording against a deactivated meter. | Reactivate or use another meter. |
| `USAGE_METER_SLUG_INVALID` | 400 | Meter slug fails the regex. | Fix the slug. |
| `USAGE_METER_SLUG_TAKEN` | 409 | Meter slug already exists. | Pick another slug. |
| `USAGE_QUOTA_EXCEEDED` | 402 | Record would exceed the subject's included quota (record-time hard cap). | Upsell: prompt an upgrade or credit purchase; don't retry the same record. |
| `USAGE_SUBJECT_AMBIGUOUS` | 400 | Both `endUserId` and `organizationId` passed. | Pass at most one. |

### Credits (prepaid)

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `CREDITS_SUBJECT_REQUIRED` | 400 | Neither `endUserId` nor `organizationId` given. | Pass exactly one subject. |
| `CREDITS_AMOUNT_INVALID` | 400 | Consume amount not a positive integer (or grant amount zero). | Whole credits only. |
| `CREDITS_INSUFFICIENT` | 402 | Balance below the requested drawdown (atomic guard — never overspends). | Prompt a credit-pack purchase; don't retry the same consume. |

### Licenses

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `LICENSE_NOT_FOUND` | 404 | License id unknown (operator routes). | List licenses for the Application. |
| `LICENSE_REVOKED` | 409 | Key rotation attempted on a revoked license. | Issue a new license instead. |
| `LICENSE_EXPIRES_AT_REQUIRED` | 400 | TIMED license created without `expiresAt`. | Set the expiry. |
| `LICENSE_SEATS_REQUIRED` | 400 | SEATS license created without a seat count. | Set the seats. |

Note: the public `licenses.verify` endpoint **never throws for an invalid key** — it returns 200 with `{ ok: false, reason: 'unknown' | 'wrong_application' | 'revoked' | 'expired' | 'seats_exhausted' }`. Branch on `result.ok`.

### Organizations (end-user teams)

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `ORGANIZATIONS_NOT_ENABLED` | 400 | Org endpoints called but orgs are off for the Application. | Enable organizations in the panel. |
| `ORGANIZATION_NOT_FOUND` | 404 | Org id unknown in this Application. | Check the id via `organizations.listMine`. |
| `ORGANIZATION_NOT_MEMBER` | 403 | Caller isn't a member of the org. | Only members can read/act; invite them first. |
| `ORGANIZATION_ROLE_INSUFFICIENT` | 403 | Caller's role can't perform this action. | Requires OWNER/ADMIN (per action). |
| `ORGANIZATION_ALREADY_MEMBER` | 409 | Inviting/adding someone already in the org. | Treat as success in UI. |
| `ORGANIZATION_MEMBER_NOT_FOUND` | 404 | Target user isn't a member. | Refresh the member list. |
| `ORGANIZATION_LAST_OWNER` | 409 | Demote/remove attempt against the only OWNER. | Promote another member to OWNER first. |
| `ORGANIZATION_OWNER_CANNOT_LEAVE` | 409 | An OWNER tried to leave (payment + benefits are tied to the owner). | Transfer ownership first. |
| `ORGANIZATION_SLUG_INVALID` / `ORGANIZATION_SLUG_TAKEN` | 400 / 409 | Slug fails the regex / collides. | Fix or change the slug. |
| `ORGANIZATION_INVITATION_NOT_FOUND` | 404 | Invitation token/id unknown. | Re-issue the invitation. |
| `ORGANIZATION_INVITATION_EXPIRED` / `ORGANIZATION_INVITATION_NOT_USABLE` | 400 | Invitation expired / revoked / already accepted. | Re-issue the invitation. |
| `ORGANIZATION_INVITATION_WRONG_APPLICATION` | 401 | Invitation belongs to a different Application. | Fix the credential mix-up. |
| `ORGANIZATION_INVITATION_EMAIL_MISMATCH` | 403 | The signed-in user's email is not the address the invitation names. Invite links travel by email or chat and can be forwarded, so acceptance is bound to the invited address. | Sign in as the invited address, or have an OWNER / ADMIN re-invite the address in hand. |

### End-user roles

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `END_USER_ROLE_NOT_FOUND` / `END_USER_ROLE_UNKNOWN` | 404 / 400 | Role id/name doesn't exist in this Application. | List roles first. |
| `END_USER_ROLE_NAME_INVALID` | 400 | Name fails the regex (lowercase, 2–40 chars, alphanumeric edges). | Fix the name. |
| `END_USER_ROLE_NAME_TAKEN` | 409 | Role name collision. | Pick another name. |
| `END_USER_ROLE_IN_USE` / `END_USER_ROLE_IS_DEFAULT` | 400 | Deleting a role users still hold / the default role. | Reassign users first; change the default first. |
| `END_USER_ROLE_REASSIGN_SELF` / `END_USER_ROLE_REASSIGN_TARGET_UNKNOWN` | 400 | Reassign target is the deleted role itself / unknown. | Pick a valid target role. |
| `NO_END_USER_ROLES` | 500 | Application has no roles defined at all (invariant breach). | Contact support — seed roles are created with the Application. |

### Webhooks

Two directions — see the "Webhooks — two directions" section of [billing.md](billing.md) for the distinction.

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `WEBHOOK_RAW_BODY_MISSING` | 400 | Internal — `fastify-raw-body` wasn't configured for the route. | Server bug; report it. |
| `WEBHOOK_SIGNATURE_MISSING` | 401 | Inbound provider webhook (Stripe) arrived with no `stripe-signature` header. | Point the provider at the correct Rekey endpoint; don't proxy through anything that strips headers. |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | Provider webhook signature didn't validate against the configured secret. | The webhook secret in the panel must match the provider dashboard's signing secret. |
| `WEBHOOK_VERIFICATION_UNAVAILABLE` | 503 | PayPal's signature-verification call did not answer in time, so Rekey **could not tell** whether the signature was good. Deliberately not `WEBHOOK_SIGNATURE_INVALID` — telling PayPal a signature was bad when the real fault is that we could not reach PayPal to ask is how an endpoint gets disabled for an outage. Still fail-closed: the event is not processed. | Transient; PayPal retries. If it persists, check PayPal's status and this deployment's egress to `api-m.paypal.com`. |
| `WEBHOOK_PAYLOAD_INVALID` | 400 | PayPal webhook body isn't a recognisable event. | Check the provider configuration. |
| `WEBHOOK_APPLICATION_MISMATCH` | 400 | An inbound provider event named a different Application than the credential that signed it. | Point the provider at the route for the Application whose webhook secret signs its events. |
| `WEBHOOK_ENDPOINT_NOT_FOUND` | 404 | Outbound-webhook endpoint id unknown in this Application. | List the Application's webhook endpoints. |
| `WEBHOOK_URL_UNSAFE` | 400 | Outbound webhook URL points at a private/loopback address (SSRF guard). | Use a publicly routable HTTPS URL. |
| `WEBHOOK_PROVIDER_UNKNOWN` | 404 | The `/webhooks/billing/<provider>` path segment isn't a registered provider. | Fix the webhook URL at the provider. |
| `WEBHOOK_APPLICATION_UNRESOLVED` | 401 | An inbound provider webhook arrived on a URL with no Application slug, so it can't be attributed. | Point the provider at the per-Application endpoint (`…/webhooks/billing/<provider>/<appSlug>`). |
| `WEBHOOK_DELIVERY_NOT_FOUND` | 404 | Manual retry targeted a delivery id that isn't on this endpoint (or already succeeded). | List deliveries and retry a PENDING/FAILED row. |

### Operator workspaces & sessions (panel)

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `TENANT_SESSION_MISSING` | 401 | Tenant route called without an `Authorization` bearer. | Sign in to the panel / send the operator access token. |
| `TENANT_SESSION_INVALID` | 401 | Operator JWT bad / expired / signed wrong, or the account no longer exists. | Refresh or sign in again. |
| `TENANT_MEMBERSHIP_REVOKED` | 403 | Operator was removed from the workspace after the JWT (or PAT) was issued. | Ask a workspace OWNER/ADMIN to re-invite. |
| `TENANT_ROLE_INSUFFICIENT` | 403 | Operator's role can't perform this action (e.g. MEMBER trying to invite). | Requires a higher workspace role. |
| `NO_TENANT_MEMBERSHIPS` | 403 | Operator account exists but isn't a member of any workspace. | Accept an invitation or create a workspace. |
| `NOT_A_MEMBER` | 403 | switch-workspace targeted a tenant the user doesn't belong to. | Pick a workspace from the memberships list. |
| `TENANT_USER_NOT_FOUND` | 404 | Operator account lookup miss. | Check the id. |
| `WORKSPACE_NAME_INVALID` | 400 | Workspace name not 2–80 characters. | Fix the name. |
| `WORKSPACE_CREATION_DISABLED` | 403 | This deployment sets `WORKSPACE_CREATION=disabled`, so a signed-in operator cannot create additional workspaces. Creation only — switching, listing and renaming are unaffected. | Ask the deployment administrator to create the workspace, or set `WORKSPACE_CREATION=open` (the default) and restart the API. |
| `INVITE_TARGET_ALREADY_MEMBER` | 409 | Inviting someone already in the workspace. | Treat as success in UI. |
| `INVITATION_NOT_FOUND` / `INVITATION_REVOKED` / `INVITATION_ALREADY_ACCEPTED` / `INVITATION_EXPIRED` / `INVITATION_NOT_USABLE` | 404 / 400 | Invitation lookup or consumption failures. | Re-issue the invitation. |
| `INVITATION_EMAIL_MISMATCH` | 403 | Invitation was issued to a different email than the accepting account. | Sign in with the invited address. |
| `MEMBERSHIP_NOT_FOUND` | 404 | Member-management target id is wrong. | Refresh the member list. |
| `CANNOT_REMOVE_LAST_OWNER` | 400 | Remove or demote attempt against the only OWNER of a workspace. | Promote someone else first. |
| `APP_ACCESS_DENIED` | 403 | A MEMBER's per-application grant (APP_VIEWER / APP_BILLING) doesn't allow this action on the granted Application. | Ask an OWNER/ADMIN to raise the grant (PUT /tenant/workspace/members/:id/grants). Note: an app the member holds NO grant for returns 404 `APPLICATION_NOT_FOUND`, not 403. |
| `APP_GRANT_MEMBER_ONLY` | 400 | Tried to set a per-application grant on an OWNER/ADMIN membership. | Grants only scope MEMBER roles — OWNER/ADMIN already have full access. Demote to MEMBER first if scoping is wanted. |
| `APP_GRANT_NOT_FOUND` | 404 | Deleting a grant that doesn't exist on that membership. | List grants via GET /tenant/workspace/members/:id/grants. |
| `MAGIC_LINK_TOKEN_INVALID` / `MAGIC_LINK_TOKEN_USED` / `MAGIC_LINK_TOKEN_EXPIRED` | 401 | Operator magic-link token failures (note: end-user codes drop the `_TOKEN`). | Request a new link. |

### Operator personal-access-tokens (PATs)

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `OPERATOR_TOKEN_INVALID` | 401 | PAT missing, invalid, revoked, or expired. | Mint a new PAT in the panel. |
| `OPERATOR_SCOPE_INSUFFICIENT` | 403 | PAT lacks the scope this action requires (e.g. `keys:mint`). | Mint a PAT with the right scope — default-deny by design. |
| `OPERATOR_SCOPE_UNKNOWN` | 400 | PAT creation with unrecognised scope names. | Use documented scope values. |
| `OPERATOR_TOKEN_EXPIRY_IN_PAST` | 400 | `expiresAt` already passed. | Pass a future timestamp or omit. |
| `OPERATOR_TOKEN_LIMIT_REACHED` | 400 | Operator already has the max active PATs. | Revoke unused tokens first. |
| `OPERATOR_TOKEN_NOT_FOUND` | 404 | PAT id unknown. | List your tokens. |

### Operator registration & invite keys

Gates who may create an operator account on this deployment — `OPERATOR_SIGNUP_MODE` is `open`, `invite`, or `closed`.

| Code | HTTP | When | How to handle |
|---|---|---|---|
| `OPERATOR_SIGNUP_CLOSED` | 403 | `OPERATOR_SIGNUP_MODE=closed` — no new operator accounts at all. | Sign in with an existing account, or ask the deployment administrator to open sign-up. |
| `OPERATOR_INVITE_REQUIRED` | 403 | `OPERATOR_SIGNUP_MODE=invite` and the sign-up carried no `inviteKey`. | Pass an invite key minted by the deployment administrator. |
| `OPERATOR_INVITE_INVALID` | 403 | The presented invite key is unknown or revoked. | Check the key, or ask for a fresh one. |
| `OPERATOR_INVITE_EXPIRED` | 403 | The invite key is past its `expiresAt`. | Ask for a fresh key. |
| `OPERATOR_INVITE_USED` | 409 | Each invite key creates exactly one operator; this one already did. | Ask for a fresh key. |
| `OPERATOR_INVITE_NOT_FOUND` | 404 | Admin invite management — no invite with that id. | Check the id against `GET /api/v1/admin/operator-invites`. |
| `OPERATOR_INVITE_ALREADY_USED` | 409 | Revoking an invite that has already created an operator. | Manage the resulting operator account instead. |
| `OPERATOR_INVITE_EXPIRY_IN_PAST` | 400 | Minting an invite with an `expiresAt` already in the past. | Pass a future timestamp, or omit it for a non-expiring key. |

### SDK client-side codes (`@rekey.dev/node`)

Raised locally by the SDK before any network call:

| Code | When | How to handle |
|---|---|---|
| `CONFIG_MISSING_API_URL` | Constructor — `apiUrl` was empty. | Set `REKEY_URL`. |
| `CONFIG_INVALID_SECRET_KEY` | Constructor — `secretKey` didn't start with `rp_`. | Use the Application secret key, not the admin key or public key. |

Add new codes here when you introduce them. The list is the spec for client compatibility.
