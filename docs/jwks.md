# JWKS / RS256 — offline access-token verification

By default, end-user access tokens are **HS256**, signed with a per-Application key derived from the deployment's `JWT_SECRET`. That key is symmetric: anyone who can *verify* a token can also *mint* one, so it never leaves the API — your services confirm a session by round-tripping `relipay.auth.getCurrentUser(token)`.

Opting an Application into **RS256** removes that round-trip. Access tokens are then signed with the deployment's RSA private key and verified against its **public** half, published at:

```
GET /.well-known/jwks.json        ← no auth, Cache-Control: public, max-age=300
```

That enables zero-latency session checks anywhere that can hold a public key: API gateways, sidecars, edge middleware, your own services — without giving any of them the ability to mint tokens.

```json
{
  "keys": [
    { "kty": "RSA", "kid": "wJx8…", "alg": "RS256", "use": "sig", "n": "…", "e": "AQAB" }
  ]
}
```

Scope: **end-user access tokens only.** Refresh tokens (opaque, hash-at-rest), MFA-challenge tokens, MCP tokens, and operator-session tokens are unchanged and stay HS256/opaque regardless of this setting.

## Enabling RS256 per Application

`authConfig.tokenAlg` (`"HS256"` default, `"RS256"` opt-in):

```bash
curl -X PATCH "$RELIPAY_URL/api/v1/tenant/applications/$APP_ID/auth-config" \
  -H "Authorization: Bearer $OPERATOR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "tokenAlg": "RS256" }'
```

Switching is non-breaking in both directions: the API verifies **both** algorithms (dispatched on the token header, strict per-alg allowlist), so outstanding HS256 tokens keep working after you switch and outstanding RS256 tokens keep working if you switch back. Only *newly minted* tokens change. RS256 tokens carry the signing key's `kid` in the JWT header.

## Verifying tokens offline (`@relipay/node`)

```ts
import { verifyAccessToken } from '@relipay/node';

const claims = await verifyAccessToken(token, {
  jwksUrl: 'https://relipay.example.com/.well-known/jwks.json',
});
// claims: { typ: 'eu_access', sub, applicationId, oid?, iat, exp }
if (claims.applicationId !== MY_RELIPAY_APP_ID) throw new Error('wrong application');
```

- The JWKS is fetched lazily and cached **5 minutes**; an unknown `kid` triggers one immediate refetch (covers fresh rotations). Pass `jwks: {...}` instead of `jwksUrl` to skip the network entirely.
- It verifies what can be verified offline: RS256 signature against a published `kid` (strict allowlist — never the token's claimed algorithm), `exp`, and `typ === "eu_access"`. HS256 tokens are refused with `TOKEN_ALG_NOT_RS256`.
- **Always check `claims.applicationId` yourself** — the JWKS is deployment-wide, so a token from another Application on the same deployment carries a valid signature.
- Node-only (uses `node:crypto`). Any standard JWT library (jose, jwks-rsa, …) works too — the endpoint is plain RFC 7517.

## What offline verification cannot see

The API keeps two revocation levers that an offline verifier, by construction, cannot observe within a token's lifetime:

- **The per-app kill-switch.** Bumping `Application.tokenGeneration` ("log everyone out now") still revokes RS256 tokens *at the API* — they embed the generation as a `gen` claim and the API rejects mismatches. Offline verifiers don't know the current generation.
- **User deletion / session revocation.**

Access tokens live **15 minutes**, so that is the maximum staleness window. If a use case needs hard revocation guarantees, keep using `auth.getCurrentUser` for it.

## Key management & rotation

- **Default:** on first boot (or first use) the API generates a 2048-bit RSA keypair and persists it in the `signing_keys` table — private half AES-256-GCM encrypted with `ENCRYPTION_KEY`, public half served in the JWKS. `kid` is the RFC 7638 JWK thumbprint.
- **Bring your own key:** set `JWT_RS256_PRIVATE_KEY` (PEM; literal `\n` accepted). It becomes the active signer and nothing is persisted. Useful when the key must live in a secret manager rather than the DB.
- **Rotation story:** the table supports N keys with one active (newest row with `rotated_at IS NULL` signs; everything still in the table is published). To rotate: insert a new key row, stamp `rotated_at` on the old one. The old `kid` **stays in the JWKS** so tokens signed just before the rotation keep verifying through their 15-minute lifetime; delete the row once that window has safely passed. Verifiers polling on the 5-minute cache pick the new key up automatically. (A panel/CLI rotation surface is a follow-up; v1 rotation is an operator SQL/console action.)

## Threat model notes

- The verification path dispatches on the token header with a **strict per-algorithm allowlist**. An HS256 token "claiming" an RSA `kid` is verified only against the per-app derived secret (the kid is ignored — the classic public-key-as-HMAC-secret confusion is structurally impossible), and an RS256 token verifies only against a `kid` published in our key set.
- The JWKS endpoint serves public key material only; it is intentionally unauthenticated.
- HS256 stays the default. RS256 trades the per-app derived-key isolation for verifiability; cross-app isolation is preserved by the `applicationId` claim check (enforced by the API; **required** of offline verifiers — see above).
