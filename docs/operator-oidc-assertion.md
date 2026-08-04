# Operator sign-in by OIDC ID Token assertion

`POST /api/v1/tenant/auth/oidc/assert`

Establishes an **operator** session (the panel identity) from an OpenID Connect
ID Token that **this deployment itself issued** for one of its own
Applications acting as an OpenID Provider.

It exists so that a deployment which already authenticates people through a
Rekey Application can let those same people into the operator panel without a
second account, a second password, or a token pasted between two websites.
Rekey Cloud is the first user of it: rekey.dev signs a buyer in against its own
`account` Application, and the panel accepts the resulting ID Token.

Off by default. A deployment that sets neither environment variable has no
assertion surface at all — the endpoint answers `404`.

## Configuration

```bash
# The OIDC issuer whose ID Tokens are believed. This is the per-Application
# authorization-server URL — the `issuer` value from
# GET /api/v1/mcp/<slug>/.well-known/openid-configuration
OPERATOR_OIDC_ISSUER=https://api.example.com/api/v1/mcp/account

# The client_id those tokens must carry as their audience. Register it with
# POST /api/v1/mcp/<slug>/oauth/register and pin the value here.
OPERATOR_OIDC_CLIENT_ID=<client_id>
```

Both must be set. The pair **is** the trust statement:

- `OPERATOR_OIDC_ISSUER` names the Application whose end-users may become
  operators. Its `email` claim becomes an operator identity.
- `OPERATOR_OIDC_CLIENT_ID` is the audience they must carry, so a token minted
  for a *different* client of the *same* Application is refused rather than
  replayed into an operator login.

## What it accepts

An ID Token is accepted only when all of the following hold. Every failure
returns the same `401 OIDC_ASSERTION_INVALID` — which one applied is not
something an unauthenticated caller should be able to probe for.

| Check | Why |
| --- | --- |
| RS256, `kid` resolvable in the local JWKS | Only tokens this deployment signed. No remote key fetch, so there is no discovery document to poison. |
| `iss` equals `OPERATOR_OIDC_ISSUER` | Another Application's users are not operators here. |
| `aud` equals `OPERATOR_OIDC_CLIENT_ID` | A token minted for another client of the same Application is not a panel credential. |
| unexpired | ID Tokens live ten minutes. |
| no `typ` claim | Refuses an end-user **access** token substituted for an ID Token — both are RS256 under the same key. |
| `email_verified` is literally `true` | The whole federation rests on the email; see below. |
| not previously redeemed | Assertions are single-use. |

### Verified email is load-bearing

An operator is matched to an existing account **by email**. If an unverified
address were accepted, anyone who could register that address on the upstream
Application would take over the matching operator account. So the claim must be
`true`, not merely present.

### Single use

An ID Token carries no `jti`, and this one travels through a browser to get
from the site that obtained it to the panel that redeems it. Without a replay
guard, a token captured in transit — browser history, a shared machine, an
over-broad `Referer` — could be redeemed repeatedly for the rest of its ten
minute life.

The endpoint therefore claims each token by hash before resolving the operator.
The store **fails closed**: if it is unreachable the sign-in is refused with
`503` rather than silently degrading a single-use credential into a replayable
one. This mirrors the posture of the brute-force counters.

## The identity model: federation, not merger

The upstream end-user is **authoritative**. The operator is a **projection** of
it, linked by verified email.

The endpoint lands on the same `findOrCreateOAuthOperator` that the Google and
GitHub operator login buttons use. Two consequences follow, and both are
deliberate:

1. **An operator who already exists keeps everything.** Their workspaces, MFA
   enrolment and passkeys are untouched — the assertion signs them in, it does
   not create a parallel account. This is the migration path for anyone who
   already has two separate accounts.
2. **A first-time assertion is a new-operator creation** and is gated by
   `OPERATOR_SIGNUP_MODE` exactly like any other. Federation is **not** a way
   around invite-only.

That second point matters on a deployment running `OPERATOR_SIGNUP_MODE=invite`
(which is what Rekey Cloud runs). There, an assertion can only ever *sign in* an
operator that already exists — something else must have provisioned it. On Rekey
Cloud that something is the private billing service, at payment time. Provision
first, then assert.

## Scope and limits

- **Only issuers this deployment hosts.** The token is verified against the
  local JWKS. Pointing `OPERATOR_OIDC_ISSUER` at a third-party IdP (Okta, Entra,
  Keycloak) will not work — that is a different feature with a different threat
  model, requiring remote JWKS fetching and discovery caching, and it is not
  built.
- **No `state`/`nonce` binding is enforced here.** The relying party that
  obtained the token is responsible for its own CSRF; this endpoint's defence is
  audience binding plus single use.

## Related

- `POST /api/v1/mcp/:slug/oauth/authorize/grant` — how a first-party server
  obtains an ID Token for a user it has already authenticated, without sending
  them through a second password prompt. See `docs/oidc-provider.md`.
- `docs/tenant-auth.md` — operator sessions, MFA, and `OPERATOR_SIGNUP_MODE`.
