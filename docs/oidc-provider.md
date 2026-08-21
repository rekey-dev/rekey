# OpenID Connect provider

An Application can act as an **OpenID Provider**: other software redirects users
to Rekey to sign in, and gets back an ID Token asserting who they are. This is
the mirror image of [OAuth sign-in](auth.md), where Rekey is the *client* of
Google/GitHub/an enterprise IdP.

It is off by default. Turn it on per Application in **Panel → Application →
Auth → Security policy**, with the *Act as an OpenID Connect provider* switch
(next to *Require a verified email*, which it wants — see below).

Or over the API:

```bash
curl -X PATCH "$REKEY_URL/api/v1/tenant/applications/$APP_ID/auth-config" \
  -H "Authorization: Bearer $OPERATOR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "oidcEnabled": true, "requireEmailVerification": true }'
```

`requireEmailVerification` is not decoration there. Without it the `email` scope
is not offered at all — see [Scopes](#scopes). Two other settings are worth a
decision before you point a relying party at this:

- **`dynamicClientRegistration`** (default `true`) — leave open while you
  onboard your relying parties, then close it. See
  [Client registration](#client-registration).
- **Who writes the profile claims** — they come from an operator-only namespace,
  not from anything the end-user can set. See
  [Where `profile` claims come from](#where-profile-claims-come-from).

## What it is built on

There is no separate OIDC server. The per-Application OAuth 2.1 authorization
server that already fronts the [hosted MCP server](mcp.md) — dynamic client
registration, authorization code, PKCE, refresh — *is* the OpenID Provider. OIDC
adds three things to it: a discovery document, an `id_token`, and `/userinfo`.

`oidcEnabled` and `mcpEnabled` are independent. Either one mounts the shared
grant endpoints; each resource then gates itself:

| Surface | Needs | Plus scope |
|---|---|---|
| `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/introspect` | `mcpEnabled` **or** `oidcEnabled` | — |
| `POST /api/v1/mcp/<slug>` (MCP JSON-RPC) | `mcpEnabled` | `mcp:account` |
| `/.well-known/openid-configuration`, `/oauth/userinfo` | `oidcEnabled` | `openid` |

An OIDC-only token cannot reach the MCP tools, and an MCP-only token cannot
reach `/userinfo`. "Let this site sign me in" is not "read my subscription".

## URLs

For an Application with slug `<slug>`, given `PUBLIC_WEBHOOK_BASE_URL=https://api.rekey.dev`:

| Concern | URL |
|---|---|
| Issuer (`iss`) | `https://api.rekey.dev/api/v1/mcp/<slug>` |
| Discovery (OIDC Discovery 1.0) | `…/api/v1/mcp/<slug>/.well-known/openid-configuration` |
| Discovery (RFC 8414 path-insertion) | `https://api.rekey.dev/.well-known/openid-configuration/api/v1/mcp/<slug>` |
| Authorization endpoint | `…/api/v1/mcp/<slug>/oauth/authorize` |
| Token endpoint | `…/api/v1/mcp/<slug>/oauth/token` |
| UserInfo endpoint | `…/api/v1/mcp/<slug>/oauth/userinfo` (GET + POST) |
| Dynamic client registration | `…/api/v1/mcp/<slug>/oauth/register` |
| JWKS | `https://api.rekey.dev/.well-known/jwks.json` (deployment-wide) |

The `/api/v1/mcp` segment in the issuer is historic — MCP shipped first on this
authorization server. It is load-bearing now: registered clients, the `aud` of
live access tokens, and discovery documents third parties have already fetched
all encode it. One authorization server, one issuer.

The JWKS is the **same** key set that signs RS256 end-user access tokens (see
[jwks.md](jwks.md)). There is no second signing key and no second JWKS.

## Scopes

| Scope | Grants | Needs |
|---|---|---|
| `openid` | An ID Token, and access to `/userinfo`. Required for both. | `oidcEnabled` |
| `profile` | `name`, `given_name`, `family_name`, `preferred_username`, `picture`, `updated_at` | `oidcEnabled` |
| `email` | `email`, `email_verified` | `oidcEnabled` **and** `requireEmailVerification` |
| `mcp:account` | The MCP account tools | `mcpEnabled` |

Requested scopes are intersected with what the Application actually supports;
anything else is dropped rather than granted (RFC 6749 §3.3). `profile` and
`email` survive only alongside `openid`. A **non-empty** request whose scopes are
*all* ungrantable is refused at the authorization endpoint with `invalid_scope` —
including `scope=openid` against an Application that never enabled OIDC. Only a
request that names **no scope at all** falls back to a default, and only to
`mcp:account`, and only when `mcpEnabled`: that is the pre-OIDC behaviour MCP
clients rely on, not a catch-all.

The granted scope is stored on the authorization code AND on the refresh-token
chain, so a refresh re-issues exactly the scope the end-user approved — it can
never widen.

### Why `email` needs `requireEmailVerification`

An `id_token` carrying `"email": "ceo@bigcorp.example"` is an assertion. Plenty
of relying parties key local accounts on that claim and ignore `email_verified`
entirely, so asserting an address nobody ever proved is an account-takeover
primitive at every one of them — and Rekey has no proof of an address until
somebody clicks the verification link.

Rather than emit a claim it cannot stand behind, an Application that does not
require verified addresses does not offer the scope:

- `scopes_supported` omits `email` in **both** discovery documents, and
  `claims_supported` omits `email` / `email_verified` with it.
- A client asking for `openid email` is granted `openid`, and gets no `email`
  claim in the ID Token or from `/userinfo`.
- When the scope IS granted, `email_verified` is therefore always `true`. A
  relying party that ignores it is now no worse off than one that reads it.

Switch `requireEmailVerification` on (Panel → Application → Auth → Security
policy) and the scope appears. Read that setting's note first: it applies to
accounts that already exist.

### Where `profile` claims come from

Rekey has no display-name column. `profile` claims live in a **reserved,
operator-only namespace** inside `EndUser.metadata` — the key `oidc` — read
through a strict allowlist of standard OIDC claim names:

```jsonc
// metadata on the EndUser
{
  "oidc": {
    "name": "Ada Lovelace",         // → the `name` claim
    "picture": "https://…/a.png",   // → the `picture` claim
    "shoe_size": 7                  // → never emitted (not on the allowlist)
  },
  "name": "whatever your app likes", // → never emitted; yours, not a claim
  "internal_risk_score": "high"      // → never emitted
}
```

Everything outside `metadata.oidc` stays private, including keys that happen to
share a claim's name. Values must be strings; `name`, `given_name`,
`family_name` and `preferred_username` are capped at 256 characters, `picture`
at 512 and must be an `https:` URL. Anything failing those is silently omitted
rather than emitted malformed.

**Who may write it.** `metadata.oidc` is refused — 400 `METADATA_KEY_RESERVED` —
on every path an end-user can reach: `PATCH /api/v1/users/me` and
`POST /api/v1/auth/sign-up` with a **publishable** key. It is writable with a
secret key or through
`PATCH /api/v1/tenant/applications/:id/end-users/:endUserId`.

That split is the whole point of the namespace. These claims are what a relying
party provisions and matches local accounts on — Grafana, Gitea, Argo CD, Vault,
Nextcloud and Keycloak brokering all key on `preferred_username` — so a user who
could set their own would be able to arrive at an RP as somebody else. The rest
of `metadata` stays freely end-user-writable, which is why the reservation is one
namespace rather than five claim names: `name` and `picture` are exactly the
fields the self-service profile route exists to edit.

## The ID Token

Returned alongside the access token by the `authorization_code` grant when
`openid` was granted. Signed **RS256** with the deployment's active JWKS key
regardless of `authConfig.tokenAlg` (that setting governs access tokens).

```jsonc
{
  "iss": "https://api.rekey.dev/api/v1/mcp/acme",
  "sub": "cm1x…",            // EndUser id — stable, and per-Application by construction
  "aud": "cm9k…",            // the OAuth client_id
  "exp": 1754050000,
  "iat": 1754049400,
  "auth_time": 1754049400,   // when the user actually authenticated
  "nonce": "n-0S6_WzA2Mj",   // present iff the client sent one
  "at_hash": "9NCiP…",       // binds this ID Token to the access token issued with it
  "email": "ada@example.com",// scope-gated, as above
  "email_verified": true     // always true when present — see the scope note
}
```

`sub` is the `EndUser` id. `EndUser` rows are per-Application, so the same human
signing into two Applications gets two unrelated subjects under two different
issuers — `subject_types_supported` is `["public"]` because pairwise would add
nothing.

Verify it the ordinary way: fetch `jwks_uri` from the discovery document, match
`kid`, check `iss`, `aud` (must equal your `client_id`), `exp`, and `nonce`.

## UserInfo

```
GET /api/v1/mcp/<slug>/oauth/userinfo
Authorization: Bearer <access_token>
```

`POST` works too (OIDC Core §5.3.1). The token is read **only** from the
`Authorization` header — the form-body and query-parameter forms RFC 6750 also
allows are not accepted, because a credential in a query string ends up in
access logs and `Referer`.

Returns `sub` plus whatever the granted scopes authorise, and nothing else:

| Situation | Response |
|---|---|
| Valid token, `openid` granted | `200` + claims |
| No / malformed / expired token | `401` `invalid_token` + `WWW-Authenticate` |
| Token from another Application | `401` `invalid_token` |
| ID Token used as a bearer token | `401` `invalid_token` |
| Valid token without `openid` | `403` `insufficient_scope` |
| End-user erased (GDPR) | `401` `invalid_token` |

An erased end-user is refused at **every** door on this surface, not just here:
redeeming an authorization code minted before the erasure returns
`invalid_grant`, so does `grant_type=refresh_token`, and the MCP endpoint
answers `401 invalid_token`. Erasure itself hard-deletes the user's refresh
tokens (session and OAuth alike) and any unredeemed authorization codes, so in
practice there is normally nothing left to refuse.

## Client registration

`POST …/oauth/register` is RFC 7591 open registration: unauthenticated,
rate-limited, public clients only (PKCE, no `client_secret`). It is governed by
`authConfig.dynamicClientRegistration`, **default `true`**.

```bash
curl -X PATCH "$REKEY_URL/api/v1/tenant/applications/$APP_ID/auth-config" \
  -H "Authorization: Bearer $OPERATOR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "dynamicClientRegistration": false }'
```

With it off, the endpoint answers `403 CLIENT_REGISTRATION_DISABLED` and both
discovery documents stop advertising `registration_endpoint` (RFC 8414 makes the
member optional so a client can tell "register here" from "do not try").
Already-registered clients are unaffected.

**Close it once your relying parties are registered.** Open registration is
normal for MCP, where clients self-register as their first act; on a public
OpenID Provider it means anyone can stand up a client with an attacker-chosen
`client_name` and a redirect URI they control, and get a password prompt
rendered on this deployment's own issuer origin. That is a phishing surface —
`client_name` is HTML-escaped, the consent screen lists the real scopes, and
PKCE plus redirect-URI binding stop a rogue client intercepting anyone else's
code — but it is one you do not need after onboarding.

It defaults on because there is no operator-side client-creation surface yet: a
default of `false` would break every deployment that already has MCP enabled and
would leave a freshly-enabled OpenID Provider with no way to onboard the first
relying party at all.

## Deviations and limits

Everything in the discovery document is implemented. What is *not* supported is
advertised as unsupported rather than omitted, and refused with the spec's own
error code at the authorization endpoint:

| Feature | Behaviour |
|---|---|
| `prompt=none` | `login_required`. There is no AS-side SSO session to reuse; every authorization re-authenticates. |
| `request`, `request_uri` | `request_not_supported` / `request_uri_not_supported` |
| `claims` request parameter | Not supported (`claims_parameter_supported: false`) |
| `response_type` other than `code` | `unsupported_response_type` — no implicit or hybrid flow |
| `code_challenge_method` other than `S256` | `invalid_request` — PKCE is mandatory |
| `max_age` | Always satisfied; `auth_time` is minted seconds before redemption |
| Signed/encrypted UserInfo responses | Not supported — plain JSON only |

Two deliberate departures from the letter of the spec:

- **Identity claims ride in the ID Token as well as `/userinfo`.** OIDC Core
  §5.4 says the `profile`/`email` claims "are returned from the UserInfo
  Endpoint" for flows that issue an access token. Including them in the token
  saves the round-trip nearly every relying party makes immediately, matches
  what mainstream providers do, and is gated by the identical scope check — it
  discloses nothing `/userinfo` would not.
- **No ID Token on the refresh grant.** OIDC Core §12.2 permits one. A refresh
  performs no authentication, so the only honest `auth_time` is the original
  sign-in, and re-asserting it hours later reads to a relying party as a fresh
  authentication that never happened. Clients needing a current assertion send
  the user back through `/oauth/authorize`.

Not built (deliberately, listed so nobody assumes otherwise):

- The operator MCP `update_auth_config` tool does **not** accept `oidcEnabled`:
  putting a public authentication surface on the internet is an
  operator-console decision, not an AI-tool one. Same for
  `dynamicClientRegistration`. (The console half of that argument was missing
  when this shipped — there was no panel toggle either, so the only way in was
  a hand-rolled `PATCH`. The `oidcEnabled` toggle is now on the Auth tab; see
  the top of this document.)

  This is now enforced rather than remembered. Both fields are listed in
  `NOT_IN_MCP` in `apps/api/test/auth-config-surface-parity.test.ts`, which fails if
  either appears on the tool. They were briefly added, on the reasoning that
  the panel exposes them so MCP should too, and reverted: the panel is a human
  holding the operator's session, and the argument above is about WHO decides,
  not about which surface happens to have a control.

  `hostedAuthorizeUrl` **is** settable through the tool. It is not a switch
  that exposes a new public surface; it redirects the sign-in half of a flow
  the operator has already turned on. It is still the most sensitive field the
  tool can write, since it names where a signing-in user's browser is sent, so
  its description carries an explicit security note and the parity test asserts
  that note stays there.
- No panel toggle for `dynamicClientRegistration` — `PATCH …/auth-config` is
  still the only surface for that one.
- No operator-side client registration. `POST /oauth/register` is the only way
  to create an OAuth client, which is why open registration is the default —
  see [Client registration](#client-registration).
- No RP-initiated logout, front/back-channel logout, or session management.
- No `client_secret` clients, no `private_key_jwt` — public clients + PKCE only.
- No consent persistence: the end-user re-authenticates on every authorization.

## Tests

`apps/api/test/oidc-provider.test.ts` covers discovery (both URL forms, gating,
`jwks_uri` really serving the signing key), ID Token claims and RS256
verification against the published JWKS, `sub` stability and per-Application
isolation, scope filtering, the unsupported-parameter error codes, refresh-scope
preservation, and the negative security cases: cross-Application tokens,
ID-Token-as-access-token substitution, `insufficient_scope` in both directions,
metadata keys that must never become claims, and the `tokenGeneration`
kill-switch.

`apps/api/test/auth-security-review.test.ts` covers the eight findings from the
adversarial review that blocked 2.0.0-rc.1, each asserting the exact reproduced
request is now refused: the sign-up verification bypass, the `email` scope
condition, end-user-controlled profile claims, the `invalid_scope` fallback, the
erased-user paths, the metadata ceiling and per-claim bounds, magic-link
verification, and the registration toggle. It also asserts that neither
`PROFILE_METADATA_CLAIMS` nor `issueIdToken`'s `claims` argument can ever carry
`typ` / `applicationId` / `gen` — the three checks that stop an ID Token being
replayed as an access token, which is the one thing standing between a widened
claim allowlist and cross-Application account takeover.
