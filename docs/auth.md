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
   │                            │ <──── 201 { endUser, accessToken, refreshToken }
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
    "accessToken": "<jwt>",
    "accessTokenExpiresAt": "...",
    "refreshToken": "<opaque>",
    "refreshTokenExpiresAt": "...",
    "mfaRequired": false,
    "isNewUser": true
  }
}
```

Errors: `EMAIL_ALREADY_EXISTS` (409), `PASSWORD_TOO_SHORT` (400), `AUTH_METHOD_DISABLED` (400), and the sign-up policy refusals `SIGNUP_DISABLED`, `SIGNUP_REQUIRES_SECRET_KEY` and `SIGNUP_EMAIL_DOMAIN_NOT_ALLOWED` (403, see [Sign-up email rules](#sign-up-email-rules)).

Email is normalised to lowercase before storage. Email is unique per Application — the same address can exist in multiple Applications as separate users.

### `POST /api/v1/auth/sign-in`

Authenticates an existing EndUser. Same response shape as sign-up, with `isNewUser: false`. Errors: `INVALID_CREDENTIALS` (401) for any auth failure (wrong email *or* wrong password *or* user signed up via OAuth). One code on purpose, so it never discloses which.

### Saying what the client is

Every route that starts a session (sign-up, sign-in, MFA verify, magic-link verify, passkey complete, OAuth callback) accepts an optional `client` object:

```json
{ "email": "…", "password": "…", "client": { "platform": "ios", "appVersion": "4.2.0" } }
```

`platform` is one of `web`, `ios`, `android`, `macos`, `windows`, `linux`, `server`, `mcp`, `other`; `appVersion` is up to 32 characters. Without it the platform comes from the User-Agent, which for a browser is enough and for a native app usually is not, so mobile and desktop apps should send it. A server that signs visitors in with a secret key should forward the visitor's User-Agent in `X-Rekey-Client-User-Agent` (the Next and Astro SDKs do); it is ignored from a publishable key. What is recorded, and where it shows, is in [analytics.md](analytics.md#where-they-sign-in-from).

### MFA: `POST /api/v1/auth/mfa-verify` and single-use codes

When the user has TOTP enrolled, sign-in answers `{ mfaRequired: true, mfaChallengeToken }` instead of a session. Exchange the token and a code at `POST /api/v1/auth/mfa-verify` `{ mfaChallengeToken, code }`. The operator panel has the same flow at `POST /api/v1/tenant/auth/mfa-verify`.

Every second-factor credential works once:

- **A challenge token completes one sign-in.** A second `mfa-verify` with the same token answers 401 `MFA_CHALLENGE_USED`, even with a different valid code. Start again from sign-in. A wrong code does not spend the token, so the user can retry within its 5-minute life, up to the usual MFA lockout. Neither does a refusal the session itself would get (`DEVICE_LIMIT_REACHED`, `DEVICE_BLOCKED`, `DEVICE_FINGERPRINT_REQUIRED`, `EMAIL_NOT_VERIFIED`, or `NO_TENANT_MEMBERSHIPS` for operators): those are decided after the code matches but before it is spent, so after releasing a device the user resubmits the same challenge and code. A wrong or reused code is answered as such and never reaches them, so the device list is only ever shown to someone who proved the second factor.
- **A TOTP code is accepted once** (RFC 6238 section 5.2). Once a code is accepted for a user, that code and any older one are refused, on every route that takes one: sign-in verify, step-up (`/auth/mfa/challenge`), `/auth/mfa/setup-confirm`, `/auth/mfa/disable`, and the operator equivalents. The code that confirmed enrolment cannot also complete the first sign-in, so the user waits for the next code (up to 30 seconds). Sign-in verify answers 401 `MFA_CODE_REUSED` and setup-confirm answers 422 `MFA_CODE_REUSED`. The step-up routes that answer with an error (browser re-enrol and disable, passkey enrolment, and the operator setup, disable and passkey enrolment) answer 401 `MFA_CODE_REUSED`, unless a valid password was sent where the route accepts one. `/auth/mfa/challenge` keeps its documented `{ ok: false }` for any code that does not verify, reused or not. A reused code does not count toward the lockout.
- **A backup code is consumed** on success, and concurrent requests carrying the same backup code cannot both succeed. Presenting a spent backup code again at sign-in verify answers 401 `MFA_BACKUP_CODE_USED` so the user knows to pick another one; it still counts toward the lockout. Re-enrolling issues new codes and forgets the spent ones. This is end-user sign-in only: operator sign-in still answers `MFA_CODE_INVALID` for a spent backup code.

The records behind this live in Redis (spent challenge tokens until they expire, the last accepted TOTP step for 120 seconds, which covers the 90-second window plus 30 seconds of clock skew between replicas). Like the lockout counters, they fail closed: if Redis is unreachable, MFA verification answers 503 `DEPENDENCY_UNAVAILABLE` rather than accepting a code it cannot record.

### `GET /api/v1/users/me/`

Returns the current EndUser. Requires **two** headers:

- `Authorization: Bearer rp_live_…`: the Application secret key (or the
  publishable key, from a browser)
- `X-Rekey-User-Token: <jwt>` — the user JWT obtained from sign-up/sign-in

Errors: `USER_TOKEN_MISSING` (401), `USER_TOKEN_INVALID` (401), `USER_TOKEN_WRONG_APPLICATION` (401).

The body is the EndUser plus the session's active organization:
`activeOrganizationId`, `activeOrganizationRole` (the caller's role name in
it) and `activeOrganizationBaseRole` (`OWNER`, `ADMIN` or `MEMBER`), each null
when the session acts for no organization or membership lapsed. `PATCH`
returns exactly the same shape (SDK type `CurrentUserDto`).

`GET /api/v1/auth/me` returns the same thing from the user JWT alone, with no
Application key. Both take `?include=`, described in
[Authorising requests in your own backend](#authorising-requests-in-your-own-backend).

### `PATCH /api/v1/users/me/`

Lets the signed-in EndUser edit **their own** record. Same two headers as the
GET; the JWT is the subject, so there is no user id anywhere in the request and
no way to aim this at another user. It returns the record after the update in
the GET's shape, active organization role fields included (before 2.2.0 it
left out `activeOrganizationRole` and `activeOrganizationBaseRole`).

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

## OAuth sign-in and the redirect URI

The redirect URI is the single most misconfigured value in Rekey, and it fails
in a way that explains nothing: the provider bounces the browser to a URL your
app does not serve, so you get a 404 with the provider's `code` sitting in the
query string and no error naming the cause.

**It is YOUR application's URL, never a Rekey one.** Rekey never receives the
provider's redirect. The flow is:

1. your app calls `POST /api/v1/auth/oauth/:provider/start` and gets an
   `authorizationUrl`;
2. it sends the browser there;
3. the provider redirects the browser back to **the redirect URI you
   registered**, which is a route on your own server;
4. your server takes the `code` from that request and calls
   `POST /api/v1/auth/oauth/:provider/callback`, which exchanges it and issues
   Rekey tokens.

Step 3 is the one that surprises people. Pointing the redirect URI at
`api.rekey.dev`, or at a Rekey-hosted page, breaks the flow, because Rekey is
not what the provider is redirecting to.

### Which buttons to show

`GET /api/v1/auth/oauth/providers` lists the providers an end-user can sign in
with right now, one entry per button:

```json
{ "success": true, "data": { "providers": [{ "id": "google", "name": "Google" }] } }
```

A provider is listed once it is configured on the Application with both a
client id and a client secret, which is exactly when `/:provider/start` stops
refusing it with `OAUTH_PROVIDER_NOT_CONFIGURED`. Configuring or removing one in
the panel is all it takes, with no second list to keep in your own app's
environment. `id` is the `:provider` path segment for `start`; `name` is a
display label (`oidc` reads `SSO`).

It returns names only. Client ids, redirect URIs, scopes and secrets are never
in the response, which is why it accepts the **publishable key**: a browser
sign-in page can call it directly. A secret key works too and needs `auth:read`.
The response carries `Cache-Control: private, max-age=60`, so a change in the
panel can take up to a minute to show.

```ts
// Server, @rekey.dev/node
const { providers } = await rekey.auth.listOAuthProviders();

// Browser, @rekey.dev/react
const { providers } = await new RekeyBrowserClient({ apiUrl, publishableKey }).listOAuthProviders();
```

`<SignIn>` and `<SignUp>` from `@rekey.dev/react` do this for you when given
`oauthStartAction` or `oauthStartUrl` instead of `oauthProviders`, see
[react-components.md](react-components.md#oauth-buttons-from-the-panel).

### The redirect URI has to appear in three places

It is compared byte for byte, so a trailing slash, a missing `www.`, or `http`
where you registered `https` is a hard failure:

1. the provider's console (Google Cloud, Discord Developer Portal, ...);
2. `redirectUri` on the provider's entry in the Application's OAuth config
   (Panel → Application → Authentication → Sign-in providers);
3. a route your app actually serves.

### The shape rekey.dev itself uses

There is no path Rekey requires; the route is yours to define, **on your own
server**. The pattern below is what rekey.dev implements for itself, and the
panel prefills it as a starting point. It is not a Rekey endpoint and there is
nothing to call: substitute your own host and build the route yourself.

```
https://yourapp.example/api/auth/oauth/google/callback
https://yourapp.example/api/auth/oauth/discord/callback
```

Note the provider name is IN the path, so each provider gets its own
registered URI. Nothing requires that shape, and a single route reading the
provider from a query parameter works too, but one URI per provider is what the
provider consoles expect you to register, and it keeps the three-way match above
a per-provider check rather than a shared one.

### Checking it

A correctly registered redirect URI returns a redirect (3xx) from your app, not
a 404. The fastest check is to open the registered URL directly: a 404 means
the string is registered against a route that does not exist, which is the
failure above.

For rekey.dev's own social sign-in, see
[rekey-cloud-social-sign-in.md](rekey-cloud-social-sign-in.md), which names the
exact values for that deployment.
## Roles: two axes, and which one you want

Rekey has **two independent role systems**. They are easy to confuse and the
consequences of confusing them are not subtle, so the distinction is worth
holding onto before you gate anything on a role.

| | Application role | Organization role |
|---|---|---|
| Field | `EndUser.role` | `OrganizationMembership.role` |
| Scoped to | (Application, end-user) | (organization, end-user) |
| A person in two organizations | holds **one** value | holds **two independent** values |
| Catalog | `/tenant/applications/:id/application-roles` | `/tenant/applications/:id/organization-roles` |
| Shape | free-form name | free-form name + a `baseRole` tier |
| Enforced by Rekey | **no**, it is data your app interprets | **yes**, the tier drives every org gate |
| Who assigns it | operator only | an org OWNER/ADMIN, with their own end-user token |

The application role answers *"is this person staff of my whole app?"*. It is
the same value in every organization they belong to, and Rekey never reads it.
No endpoint changes behaviour based on it. It exists so you can stamp a value on
a user and read it back.

The organization role answers *"what are they inside **this** agency?"*. This is
the one you want for team permissions. Rekey does enforce it.

> **The mistake to avoid.** `if (user.role === 'admin')` after an org switch
> reads the *application* role and will be identical in every organization the
> user belongs to. For the organization-scoped answer read
> `activeOrganizationBaseRole` from `GET /me`, or the `baseRole` on the
> membership.

### Organization role names and tiers

Organization roles are a per-Application catalog. Every Application is seeded
with three built-ins (`OWNER`, `ADMIN`, `MEMBER`), and an operator can define
more:

```json
{ "name": "content-manager", "baseRole": "MEMBER", "description": "Drafts and edits content" }
```

`baseRole` is the authority tier, one of OWNER / ADMIN / MEMBER. **Rekey gates on
the tier and never on the name.** A `content-manager` on tier MEMBER can do
exactly what MEMBER can. The `canManage` ladder, the last-OWNER guard and the
org-scoped billing writes all read the tier. The name is your vocabulary; what
`content-manager` means beyond MEMBER is for your app to decide.

The built-ins cannot be renamed, re-tiered or deleted. That is what keeps
memberships created before the catalog existed resolving to the authority they
always had.

### Who does what

Authoring the catalog and assigning from it are different acts with different
credentials:

- **Define** a role: operator, tenant JWT. Panel → Application → Organizations
  → Organization roles, `POST /tenant/applications/:id/organization-roles`, or
  the `create_organization_role` MCP tool. Requires
  `authConfig.organizationsEnabled`.
- **Assign** a role: an org OWNER/ADMIN, using **their own end-user access
  token**. `PATCH /users/me/organizations/:id/members/:euid` and
  `POST /users/me/organizations/:id/invitations`. No operator involved; the
  `canManage` ladder applies to the tiers, so an ADMIN-tier member can hand out
  ADMIN- and MEMBER-tier roles but not OWNER-tier ones.
- **Discover** the names: any signed-in end-user, so an org-admin UI can
  populate a role picker: `GET /api/v1/users/me/organizations/roles`.

End-users can read the catalog but never write it. There is no path for an
organization member to mint a role name that outranks their own.

### Revoking a role

`PATCH /tenant/applications/:id/organization-roles/:name` with
`{"disabled": true}` refuses every holder immediately and blocks new
assignment, while keeping the memberships so it can be undone. Prefer it to
re-tiering (which degrades holders silently) or deleting (which needs somewhere
to move everyone first). See
[organization-roles.md](organization-roles.md#revoking-a-role).

### Acting as an OpenID Connect provider for another app

When this Application is the identity provider, `GET /api/v1/mcp/:slug/oauth/authorize`
renders a built-in email + password page. That is right for a deployment with no
front end of its own, and **a dead end for an Application whose users sign in
with Google**: they have no password, so the only way through is a reset on an
account that has none.

Set `authConfig.hostedAuthorizeUrl` to your own login page and Rekey forwards
the authorization request there instead, parameters untouched. Your page signs
the user in however it likes, and skips the sign-in prompt if they already have
a session. It must not skip the consent step.

**Your page must ask before it mints a code.** Any client can register itself
(`POST /oauth/register`, open by default) with a redirect URI it controls, so a
page that mints a code as soon as a signed-in user arrives hands that user's
account to whoever wrote the link: the attacker registers a client, sends a
signed-in user a link to your page with their own PKCE challenge, and redeems
the code the page delivers. Do this instead:

1. On `GET`, call `POST /api/v1/mcp/:slug/oauth/authorize/preview` with the
   same credentials and body as the grant below. It runs every check the grant
   runs, mints nothing, and returns `client_name` (the name the client gave
   itself, unverified), the confirmed `redirect_uri`, the `scope` a grant would
   carry, and the signed-in `account.email`. Show all of it, with Allow and
   Deny. Name where the answer goes (the redirect URI's host), because the
   client name is whatever the registrant typed. Check `response_type` here
   too: the handoff endpoints never receive it, so a page reached directly is
   the only place it is checked. Anything but `code` redirects to the
   confirmed URI with `error=unsupported_response_type`.
2. Submit Allow and Deny as a `POST` from your own origin, with CSRF protection
   (a Next.js Server Action has an Origin check built in). Treat the posted
   fields as a fresh request: they are the client's own parameters handed back.
3. On Allow, call `POST /api/v1/mcp/:slug/oauth/authorize/grant` with your
   secret key (it needs the `auth:write` scope, which `*` includes) and the
   user's access token, then redirect to the `redirect_uri` in the response
   with the returned `code` and the original `state`.
4. On Deny, call `/preview` again and redirect to the `redirect_uri` it
   confirms with `error=access_denied` and the original `state`.
5. Refuse to be framed: send `X-Frame-Options: DENY` or
   `Content-Security-Policy: frame-ancestors 'none'` on the page, or the Allow
   button can be clicked through someone else's overlay.

The API keeps no record of past consent, so ask every time. Rekey Cloud's own
page (`apps/marketing/src/app/oauth/authorize`) is a working example.

Your page is a public URL, so anyone can reach it with a `redirect_uri` of their
choosing: it is not only reached through the forward. Redirect the browser only
to a URI the preview or grant response confirmed. A `200` carries it as `redirect_uri`. A
`400` whose `error.details` carries `oauth_error` and `redirect_uri` means the
client and URI were valid and the request was not, so redirect there with
`error` (plus `error_description` and `state`). Any other failure, including an
unknown `client_id`, an unregistered `redirect_uri` or the API being
unreachable, must be shown on your own page and not redirected (RFC 6749
§4.1.2.1). Redirecting on those makes your login page an open redirect.

The API forwards only the standard authorization parameters, which are already
public, and refuses to delegate to its own authorize path so a misconfiguration
cannot loop. Delegation happens after the client, `redirect_uri` and scope
checks, so a malformed request stays a protocol error rather than becoming your
login screen's problem.

### Reading the active organization's role

`GET /api/v1/users/me/` and `GET /api/v1/auth/me` both return:

```json
{
  "role": "user",
  "activeOrganizationId": "org_...",
  "activeOrganizationRole": "content-manager",
  "activeOrganizationBaseRole": "MEMBER"
}
```

`activeOrganizationRole` and `activeOrganizationBaseRole` are null when the
session has no active organization, or when membership lapsed since the token
was minted. A stale `oid` claim degrades to "no org", it never grants access.

## Authorising requests in your own backend

A backend that protects its own API with Rekey access tokens needs three
answers per request: who the caller is and whether the session is still valid,
what they are entitled to, and whether the device the session is bound to is
still allowed. One call answers all three:

```http
GET /api/v1/auth/me?include=entitlements,device
X-Rekey-User-Token: <access token>
```

```ts
const me = await rekey.auth.getCurrentUser(accessToken, { include: ['entitlements', 'device'] });
if (!me.entitlements.features.reports) return forbidden();
```

`include` is a comma-separated list, in any order, duplicates ignored. Each
value adds one top-level property of the same name:

| Value | Adds | Same answer as |
| --- | --- | --- |
| `entitlements` | `{ features, entitlements, creditBalance }`, every kind: FEATURE, CREDIT, USAGE, LICENSE | `GET /billing/entitlements/for-user` for the billing subject (below) |
| `subscription` | The current subscription, or `null` | `GET /billing/subscription` for the billing subject (below) |
| `device` | The device the token's `dev` claim names, or `null` when the session is not device-bound | `GET /users/me/devices`, that one row |
| `organization` | The active organization with the caller's `role` and `baseRole`, or `null` | `GET /users/me/organizations/:id` |
| `licenses` | `{ items, truncated }`: the caller's licences, newest first, first 100 (the active organization's too, in an org-billed Application); `truncated` is true when there are more | `GET /users/me/licenses` for the billing subject (below) |

What to rely on:

- **Without `include` nothing changes.** Same body, same queries.
- **The session checks run first and win.** An expired token, a session older
  than the user's last sign-out everywhere, an erased user, a frozen
  Application or an ended impersonation get the same error with or without
  `include`.
- **A 200 means the device is ACTIVE.** A session whose device was released or
  blocked is refused with `401 USER_TOKEN_INVALID` before anything is read, so
  a blocked laptop cannot keep working downstream while a cache says otherwise.
  `device` is there for the record itself (label, first and last seen).
- **The billing values follow what the Application bills.** In an org-billed
  Application (`billingSubject: "org"`), while the session acts for an
  organization the caller still belongs to, `entitlements` and `subscription`
  are that organization's (as `for-user?organizationId=` and
  `/billing/subscription?organizationId=` give them), and `licenses` adds the
  organization's pooled licences to the caller's own. In every other case,
  including the default user-billed Application with a session switched into
  a team, they are the end-user's own, so a paying user never reads as
  entitled to nothing because they changed team. `GET /billing/entitlements`,
  `GET /billing/entitlements/features/:key` and `GET /users/me/licenses`
  resolve the same subject when no `organizationId` is passed (since 2.2.0;
  `GET /billing/entitlements` used the active organization in both kinds of
  Application before). `GET /billing/subscription` does not: without
  `?organizationId=` it always answers for the end-user, so in an org-billed
  Application pass the organization's id to it to match
  `include=subscription`.
- **An unknown value is a 400** (`VALIDATION_ERROR`, naming the supported
  values), so a typo is never silently answered with less.
- **The billing values are gated like the billing routes.** `entitlements`,
  `subscription` and `licenses` on an Application with billing off answer
  `403 BILLING_DISABLED`. On `/users/me` a secret key needs the scope of the
  route that serves each value: `billing:read` for `entitlements`,
  `subscription` and `licenses`; `organization` needs only the route's own
  `auth:read`, as `GET /users/me/organizations/:id` does.
- **`include` can be repeated.** `include=device&include=organization`, which
  `URLSearchParams.append` builds, is the same as `include=device,organization`.
- **SDK types narrow on a literal list.** `getCurrentUser(token, { include:
  ['entitlements'] })` (or a list declared `as const`) promises `entitlements`.
  A list typed `MeInclude[]` could hold anything, so every field it might add
  is optional.

To gate on one feature without the rest, `GET /billing/entitlements/features/:key`
(SDK `billing.hasFeature(token, key)` / `getFeature`) answers
`{ key, granted, value }` for the same subject `include=entitlements` resolves;
see [billing](billing.md#checking-one-feature).

Cache the answer for a short time, a minute or two, keyed on the end-user id
plus the token's `dev` claim, so one browser session does not cost a Rekey call
per request, and so a second device never reads the first one's cached answer.
The access token itself lives 15 minutes by default, so a cache no longer than
that never outlives the session it describes by more than its own TTL.

**Rate limits.** `GET /auth/me` counts against the end-user it resolved (600 a
minute each by default, `RATE_LIMIT_AUTHENTICATED_MAX`), and all end-users seen from one client IP together are capped at
3000 a minute. A backend resolving many users from one address after a cold
start is better served by `GET /users/me` with its secret key: that counts
against the key (30000 a minute) and is exempt from the per-IP ceiling. See
[rate-limits.md](rate-limits.md).

## Devices

A native, desktop or CLI client can bind the session it mints to the machine
it runs on by sending `device: { fingerprint, label }` on any session-minting
endpoint. The session then carries a `dev` claim, the refresh chain is bound
to that device, and the number of active devices per end-user can be capped by
the `max_devices` entitlement on the plan. Browser SDKs never send it and see
no change. See [devices.md](devices.md).

## Tokens — access + refresh

Sign-up and sign-in return **two** tokens, used for different jobs:

| Token | Format | Lifetime | Where to send | What it's for |
|---|---|---|---|---|
| **Access** | JWT (HS256 default; RS256 opt-in) | 15 minutes by default (`END_USER_ACCESS_TOKEN_TTL_SECONDS`, up to 24 hours) | `X-Rekey-User-Token` header | Identifies the end-user on every per-user call (e.g. `GET /users/me`) |
| **Refresh** | Opaque base64url, 32 bytes random | 30 days by default (`END_USER_REFRESH_TOKEN_TTL_DAYS`, up to 365), sliding | `body.refreshToken` of `POST /auth/refresh` | Mints a fresh access + refresh pair when the access expires |

Both lifetimes are deployment settings, not per-Application ones. Sliding
means each refresh issues a fresh full window, so a client stays signed in as
long as it refreshes at least once per window; size the window to the longest
gap between uses (a desktop app opened monthly wants 60 or 90 days) and keep
the access token short, since a revoked session keeps acting until its next
refresh re-checks it. Every sign-in and refresh response carries
`accessTokenExpiresAt` and `refreshTokenExpiresAt`, so a client never has
to know the configured values.

A long access lifetime does not extend a session somebody ended, and ending
one session does not end the others. A password change or reset, sign-out
everywhere and refresh-token reuse detection end every session, so they stamp
the user: an access token minted before the stamp is refused on its next use.
Revoking a single session (the user's or an operator's) or releasing or
blocking a device ends only that session: its access token carries a `sid`
claim naming the session and a `dev` claim naming the device, and the API
refuses it once that session is revoked or that device is no longer ACTIVE,
while the user's other sessions keep working without a refresh. Both refusals
are `401 USER_TOKEN_INVALID` with a message naming the cause, the code SDKs
refresh on; the ended session's refresh then answers `REFRESH_TOKEN_REVOKED`.
Access tokens minted before the `sid` claim existed run to their expiry.

An offline verifier (`verifyAccessToken` in `@rekey.dev/node`, or your own
JWKS check) sees none of this: a locally verified token stays valid until it
expires. Call the API when immediate revocation matters.

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
- **Except a race, which costs nothing.** A token presented again within `REFRESH_TOKEN_REUSE_WINDOW_SECONDS` (15 by default, 0 turns it off) of its rotation, while its replacement is still unused, returns `REFRESH_TOKEN_RACED` (401) and revokes nothing: that is two tabs or two server instances refreshing at once, or a retry whose first response was lost. Nothing is issued to the replayer either, so a stolen token replayed inside the window buys an attacker nothing. The replay is still recorded (`user.refresh_token_raced`, with its IP and user agent). The allowance ends early once the replacement has itself been used or revoked, and it never covers a request carrying a device fingerprint the session is not bound to, or another Application's key: those are `REFRESH_TOKEN_REUSED`, as before. A client that gets `RACED` should pick up the replacement another request stored, or sign in again if it has none, and must not keep the spent token: presented after the window it revokes everything.
- **Cross-application guard.** The refresh row carries `applicationId`; presenting it through a different Application's secret key returns `REFRESH_TOKEN_WRONG_APPLICATION`.

### Sign-out

`POST /auth/sign-out` revokes the presented refresh token. Idempotent — unknown tokens return 200 (no enumeration). The access token paired with the refresh remains valid until its expiry (`accessTokenExpiresAt`; 15 minutes by default); clear it client-side for full logout.

### Sign-out everywhere

`POST /auth/sign-out-everywhere` (requires user JWT) revokes **every** refresh token for the calling user and stamps the user, so every access token they hold, the caller's included, is refused on its next use. That covers MCP and OIDC grants too: their refresh tokens are revoked with the rest, and an MCP access token issued before the stamp is refused by the MCP endpoint, `/oauth/userinfo`, and reported inactive by `/oauth/introspect`. A password change or reset and refresh-token reuse do the same. Revoking a single session does not touch MCP grants. Use cases: "log out all devices" button, suspected compromise, after a password change, etc.

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
- On success, every refresh token for the user is revoked. Access tokens minted before the call, the caller's own included, are refused on their next use.

### What's still deliberately not here

- **Sliding access tokens via cookie middleware.** We expose the primitives; auto-refresh is the SDK's job (`@rekey.dev/nextjs` does it, `apps/panel` does it by hand).

Replay-chain revocation and sign-out-everywhere both shipped — see the refresh-token bullets above and `POST /auth/sign-out-everywhere`.

## Server-side lookup with a secret key

Your own backend often holds a secret key but not the user's token — a
licence server, a support tool, a migration script. Two routes answer "who is
this" without a session, secret key only (the publishable key is refused, so a
browser can never enumerate accounts through them):

- `GET /api/v1/users?email=` — exact, case-insensitive match in the calling
  Application. SDK: `rekey.users.getByEmail(email)`.
- `GET /api/v1/users/:id` — by id, scoped to the Application. SDK:
  `rekey.users.get(id)`.

Both return the same shape as `GET /users/me`, including the sign-in counters
`lastSignedInAt`, `lastSignInVia` and `signInCount` (see
[analytics.md](analytics.md)). For what that user is entitled
to, `GET /api/v1/billing/entitlements/for-user?endUserId=` returns the same
union as `/billing/entitlements` (SDK: `rekey.billing.getEntitlementsFor(id)`).

## Migrating users from another auth system

`POST /api/v1/users/import` (secret key, `auth:write`; SDK
`rekey.users.import(users)`) takes up to 500 users per call: email, the
password hash your current system holds, whether the address was verified, a
role, metadata, and any OAuth identities already linked so a Google or
Discord user is not re-prompted.

Hashes are accepted as **argon2id** or **bcrypt** (`$2a$`, `$2b$`, `$2y$`)
and verified as-is at sign-in. Rekey never creates bcrypt hashes; an imported
one is upgraded to argon2id on the user's first successful sign-in, the one
moment the plaintext is in hand. Existing addresses are skipped, never
updated — an import is not a way to overwrite a live account's password — and
the whole batch is validated before any row is written.

## Operator end-user management

Operators manage end-users from the panel (or the `/api/v1/tenant/applications/:id/end-users*` routes): seed users manually, edit role/metadata/verified flag, grant credits, impersonate (audited, 5-minute token), and delete.

Impersonation is bounded twice over. It is **revocable**: `POST /api/v1/tenant/applications/:id/end-users/:euid/impersonate/end` stamps `endedAt` on every open audit row for that user and invalidates the tokens they issued on the spot (`IMPERSONATION_SESSION_ENDED`), for any operator, not just the one who started it. And it **cannot change credentials or mint a session**: password change, MFA setup/disable, passkey enrolment/removal, linking or unlinking an OAuth provider, the MCP session handoff, and the two routes that re-mint a token pair (`POST /users/me/organizations/:id/switch` and `POST /users/me/organizations/clear-active-organization`) answer 403 `IMPERSONATION_ACTION_FORBIDDEN` for an impersonated session. Each of those would outlive the five-minute token: a re-minted pair is an ordinary 30-day session with no `imp` claim, which would keep working after the impersonation ended. Everything else the user can do (reads, billing, organization membership, profile edits) is unchanged.

### Banning an end-user

```
POST /api/v1/tenant/applications/:id/end-users/:euid/ban     { reason }
POST /api/v1/tenant/applications/:id/end-users/:euid/unban
GET  /api/v1/tenant/applications/:id/end-users/:euid/ban     → { state, history }
```

A ban stops the person, where a device block stops one machine. It needs write access to the Application, and a reason of 1 to 500 characters that only operators ever see. In one transaction it records who banned and why, ends every session and OAuth/MCP grant, ends open impersonations, deletes outstanding password-reset links, and expires outstanding magic-link and verification links (kept, so a later erasure and the data export still find an address an email change was pending for). From then on:

- password, magic-link, OAuth, passkey and MFA sign-in and every live access token answer `403 END_USER_BANNED`, always after the credential has been checked, so the code tells nothing to someone without it;
- refresh with a token the ban revoked answers `401 REFRESH_TOKEN_REVOKED`, like any ended session; only a session minted by a sign-in that raced the ban answers `403 END_USER_BANNED` on refresh;
- magic-link and forgot-password requests send nothing and answer exactly as for an unknown address;
- licence keys the person holds verify as `{ ok: false, reason: "suspended" }` (organization-pooled licences are not affected);
- operator impersonation and support mail are refused until the ban is lifted.

Subscriptions keep billing. Cancel them separately if the person should stop paying. Banning a banned user returns the original ban with `alreadyBanned: true`; to change the reason, lift and ban again. Unbanning restores nothing: sessions the ban ended stay ended.

Two windows remain. An app that verifies RS256 access tokens offline with `verifyAccessToken` cannot see any revocation, so a banned user's access token keeps passing there until it expires (15 minutes by default). And erasing a banned user frees their email, so the same person can sign up again afterwards.

Every ban and lift is an `end_user.banned` / `end_user.unbanned` security event (with the reason and which operator credential acted) and a `user.banned` / `user.unbanned` webhook (without the reason). The person's data export carries `bannedAt` and the `end_user.banned` event, but never the reason. In the panel: end-user detail page → Access tab. The end-user list filters with `?banned=true`; an erased end-user counts as not banned there.

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

Operator-initiated erasure for GDPR Art. 17 / CCPA delete requests. Unlike a plain `DELETE` (which cascade-removes the user **and** their financial records), erasure **tombstones** the user — hard-deleting PII/auth material while **retaining anonymized financial records** for accounting / legal-retention obligations. A tombstoned user can never authenticate again (every auth path rejects with `END_USER_ERASED`, HTTP 410), and nothing can be granted to one. Workspace **OWNER only** — as is the plain `DELETE`, which is the more destructive of the two and was the weaker-gated one until 2.2. Recorded as an `end_user.erased` security event and emits a `user.erased` outbound webhook. In the panel: end-user detail page → Data &amp; privacy tab → "Erase (GDPR)" (type the email to confirm).

The full per-model cascade guarantee (delete / anonymize / retain) lives in **[docs/data-erasure.md](data-erasure.md)**.

## Honoring `Application.authConfig`

Each Application has an `authConfig`:

```ts
{
  // Open-ended strings, not a closed union — 'passkey' is valid too, and a
  // provider added later needs no schema change.
  methods: string[],                       // 'password' | 'google' | 'github' | 'magic_link' | 'passkey' | …
  passwordMinLength: number,               // default 8
  passwordBreachCheckEnabled: boolean,     // default true
  redirectUrls: string[],
  appUrl?: string,                         // base URL emails link back to
  signupMode?: 'public' | 'secret_only' | 'invite_only',
  signupRestrictions?: {                   // see "Sign-up email rules" below
    allowedDomains?: string[],
    blockedDomains?: string[],
    blockDisposable?: boolean,
  },
  organizationsEnabled: boolean,           // default false
  sendVerificationEmailOnSignUp: boolean,  // default true
  requireEmailVerification: boolean,       // default false
  welcomeEmail: 'on_signup' | 'on_verified' | 'off', // default 'on_signup'
  mfa: 'off' | 'optional' | 'required',    // default 'optional'
  tokenAlg: 'HS256' | 'RS256',             // default 'HS256' — see jwks.md
  oidcEnabled: boolean,                    // default false — see oidc-provider.md
  mcpEnabled: boolean,                     // default false — see mcp.md
  dynamicClientRegistration: boolean,      // default true — per-Application MCP/OIDC, see mcp.md
  webauthn?: { … },                        // passkey relying-party config
}
```

Abbreviated — `AuthConfigSchema` in `@rekey.dev/shared-types` is the authority,
and `GET /api/v1/me/` returns the live value for the calling Application.

The auth module enforces:
- **`methods`** — sign-up/sign-in refuse with `AUTH_METHOD_DISABLED` if `"password"` isn't enabled.
- **`passwordMinLength`** — sign-up enforces this, returning `PASSWORD_TOO_SHORT` otherwise.
- **`sendVerificationEmailOnSignUp`** (default **on**): password sign-up mints a verification token and sends the `email_verification` mail alongside `welcome`. Both are fire-and-forget: a broken or absent transport is logged and dropped, never rolled back into the account creation. Magic-link sign-up doesn't send it, because it creates the user with `emailVerified: true` (consuming the link is the proof). OAuth-first sign-up records the provider's own `email_verified` claim and sends it only when the provider did not vouch for the address. **Ignored while `requireEmailVerification` is on**: the link is then the only way into a new account, so it goes out regardless.
- **`requireEmailVerification`** (default **off**) — a user whose `emailVerified` is false gets **no session at all**, refused with **403 `EMAIL_NOT_VERIFIED`** rather than `INVALID_CREDENTIALS`: the credential was right and the user needs to be told to check their inbox. Enforced at the single point every session is minted, so it covers sign-up (the account is created, but the response is the 403 — no access or refresh token), sign-in, MFA verification, organization switching, **and refresh**. Re-checking on refresh is what bounds the switch: flip it on and unconfirmed accounts that already hold a refresh token stop renewing within one access-token lifetime, rather than continuing for the 30-day chain. The check always runs after a credential verified, so it neither answers "does this address exist here" nor counts toward the brute-force lockout.

  Magic-link and OAuth sign-in **satisfy** the gate rather than skip it: each proves the address and records `emailVerified: true` (magic link does this for existing accounts too, not only at creation).

  It is also the prerequisite for the OpenID Connect `email` scope — see [oidc-provider.md](oidc-provider.md#why-email-needs-requireemailverification).

  Turning it on takes effect immediately for accounts that already exist, so send the verification email (above) before enforcing it. A blocked user can ask for a fresh link themselves with **`POST /api/v1/auth/resend-verification`** (`{ email }`, no session — that is the point, since this gate is what denies them one). It answers 200 with a constant body whatever happened, so it discloses nothing about which addresses have accounts, and it is rate-limited per (Application, address, IP) exactly like `/auth/forgot-password`. `POST /auth/send-verification` remains the authenticated version, for a user who *has* a session and is changing their address. Other routes back in: the original email, a magic link if that method is enabled, or an operator flipping the flag from Panel → Application → End-users.

  One prerequisite for both: a verification link has to be *buildable*. If the Application has no `appUrl`, no usable `redirectUrls` origin and the deployment has no `DEFAULT_APP_URL`, the automatic sign-up send and `resend-verification` are **skipped entirely** rather than mailing a confirmation with no button in it, and an `auth.email_delivery_failed` event is recorded naming the setting to fix. Set the Application URL (Panel → Application → Auth) before enabling the gate, or pass `verifyUrl` per call.
- **`welcomeEmail`** (default **`on_signup`**) decides when the `welcome` mail goes out. It is sent once, fire-and-forget, to accounts created by password sign-up, magic-link sign-up or OAuth-first sign-up; operator-created and imported users never get one, an OAuth user who comes back or links a provider to an existing account does not get it again, and the per-event switch (Panel → Application → Email) still applies on top.

  | `welcomeEmail` | Address verified at creation (magic link, a vouching OAuth provider) | Unverified address, `requireEmailVerification` off | Unverified address, `requireEmailVerification` on |
  |---|---|---|---|
  | `on_signup` | at creation | at creation | on first verification |
  | `on_verified` | at creation | on first verification | on first verification |
  | `off` | never | never | never |

  "On first verification" means the first successful `POST /auth/verify-email`, or a magic link that proves the address, and the mail goes exactly once however many links are opened at the same time. `on_signup` waits while `requireEmailVerification` is on because that account is refused a session, and welcoming it would greet an address nobody has proven. A user welcomed before a switch is not welcomed again, and switching to `off` drops any welcome still waiting. Set it from Panel → Application → Auth, `PATCH /api/v1/tenant/applications/:id/auth-config`, or the operator MCP `update_auth_config` tool.
- **`signupMode`** (default `public`): `secret_only` lets only a secret key create accounts, and `invite_only` refuses every self-service creation (password, magic link, OAuth) with **403 `SIGNUP_DISABLED`**. Under `invite_only` the ways in are an operator creating the user (Panel → Application → End-users → "+ New end-user", or `POST /api/v1/tenant/applications/:id/end-users`) or a server-side `POST /api/v1/users/import` with a secret key. An organization invitation does not create an account: accepting one needs a signed-in end-user.

### Sign-up email rules

`signupRestrictions` decides which email addresses may **self sign-up**. It is checked after `signupMode`, in the same place, on every path that creates an end-user from a sign-up: password sign-up, consuming a magic link for a new address, and a first OAuth sign-in. Set it in Panel → Application → Auth → Sign-up email rules, with `PATCH /api/v1/tenant/applications/:id/auth-config`, or with the operator MCP tool `update_auth_config`.

```json
{ "signupRestrictions": { "allowedDomains": ["acme.com", "*.acme.com"], "blockedDomains": ["competitor.com", "*.competitor.com"], "blockDisposable": true } }
```

- **`allowedDomains`**: when non-empty, only these domains may sign up.
- **`blockedDomains`**: these domains may never sign up. A blocked domain wins over an allowed one. Blocking `competitor.com` alone still lets `mail.competitor.com` sign up; add `*.competitor.com` to cover its subdomains, as above. The panel flags an apex listed without its wildcard.
- **`blockDisposable`**: refuses throwaway-inbox domains and their subdomains (no `*.` entry needed, unlike the two lists), from a list vendored with the release ([disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains), CC0). Nothing is fetched at runtime. Maintainers refresh it with `pnpm --filter @rekey.dev/api disposable:refresh`, which rewrites `apps/api/src/lib/disposable-domains.data.ts` and records the source commit.

Matching: `acme.com` matches that domain only; `*.acme.com` matches any subdomain of it and **not** `acme.com` itself, so list both to admit both. No other wildcard is accepted. Entries are trimmed, lowercased and stored with internationalised names converted to punycode (`bücher.de` becomes `xn--bcher-kva.de`), duplicates are dropped, and each list holds at most 500 entries. The PATCH replaces the whole object; send `null` to remove the rules.

A refused sign-up answers **403 `SIGNUP_EMAIL_DOMAIN_NOT_ALLOWED`**. The message is safe to show the person signing up and never names the allowed domains. What the rules do **not** touch:

- **Existing users** keep signing in, whatever their domain.
- **Users an operator creates or imports** (`POST /api/v1/tenant/applications/:id/end-users`, `POST /api/v1/users/import`, and users a billing import creates) are never checked.
- **The magic-link request** for a refused new address answers exactly as a real send would (a publishable key gets the same constant body either way) and mints nothing, so the rules cannot be probed from a browser. The same check runs again when a link is consumed, so a link minted before a rule changed cannot create an account the rule now refuses.

`google` / `github` (module `oauth`), `magic_link`, `passkey` and `organizationsEnabled` (module `organizations`) are all wired — enabling one in `authConfig.methods` is what opens the corresponding routes.

## SDK usage

```ts
// 1. user signs up via your form, server posts to Rekey
const { endUser, accessToken, refreshToken } = await rekey.auth.signUp({
  email: req.body.email,
  password: req.body.password,
});
// store accessToken however your stack stores sessions; keep refreshToken to
// mint the next one when it expires

// 2. on subsequent requests, look up the user
const user = await rekey.auth.getCurrentUser(req.cookies.session);

// ...or everything needed to authorise the request, in the same call
const me = await rekey.auth.getCurrentUser(req.cookies.session, {
  include: ['entitlements', 'device', 'subscription', 'organization', 'licenses'],
});
```

See the type definitions in `@rekey.dev/node` for the full method surface.

### Routing new users to onboarding

Every session-issuing response carries `isNewUser`. It is true when that same
request created the account: password sign-up, a magic link that created the
user, or an OAuth callback that created the user. It is false for every other
sign-in (including an OAuth identity linked to an existing account), MFA
completion, refresh and organization switch.

```ts
// Node, any framework
const result = await rekey.auth.signIn({ email, password });
if (!result.mfaRequired) {
  res.redirect(result.isNewUser ? '/onboarding' : '/dashboard');
}

// OAuth and magic link return the same shape
const outcome = await rekey.auth.completeOAuth('google', code);
if (!outcome.mfaRequired && outcome.isNewUser) return redirect('/onboarding');
```

```ts
// Next.js server actions (@rekey.dev/nextjs/server)
const session = await signUp({ email, password });
redirect(session.isNewUser ? '/onboarding' : '/dashboard');

const outcome = await signIn({ email, password });
if (outcome.kind === 'session' && outcome.session.isNewUser) redirect('/onboarding');
```

`@rekey.dev/react`'s `RekeyBrowserClient` and `@rekey.dev/astro`'s `rekey()` return
the same `AuthResultDto`, so `result.isNewUser` is there too. A server that
wants the signal out of band can use the `session.created` webhook instead, whose
`firstSignIn` is also true for the first sign-in of an operator-created or
imported user (see [webhooks.md](webhooks.md#users)).

Rekey never holds a user in onboarding. Sign-in, refresh and every other route
behave the same whether onboarding is `pending`, `completed` or `skipped`.
Whether to send a returning user back to your form is your app's call: read
`onboardingStatus` on the user (`GET /users/me`, `GET /auth/me`) and decide.
If you offer a "skip" button, call `POST /api/v1/users/me/onboarding/skip` so
the choice is recorded. See [profile-fields.md](profile-fields.md#onboarding).

## What's deliberately not here yet

Everything this section once listed has shipped: refresh tokens (documented above), OAuth providers (`modules/oauth`), magic link, TOTP MFA (`modules/mfa`), passkeys, orgs + invitations (`modules/organizations`), email verification, and per-account lockout. Kept as a pointer so the gap isn't re-filed as a roadmap item.

Genuinely open:

- **Lockout parameter tuning** — thresholds and windows are picked, not measured. Revisit with real sign-in telemetry.
- **SCIM / directory sync** and **SAML** — not built.
