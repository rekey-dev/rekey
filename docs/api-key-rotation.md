# API key rotation

Secret keys (`rp_live_…` / `rp_test_…`) authenticate as the **whole Application**. Anyone holding one can read and act on every end-user. This page covers the leaked-key emergency drill, the proactive rotation cadence, and how the adjacent secrets (webhook signing secrets, provider credentials) rotate.

Background on the credential model: [api-keys.md](api-keys.md). Two properties matter for rotation:

- The raw key is shown **exactly once** at mint time; only its SHA-256 hash is stored. There is no "view key again" — replacing a key always means minting a new one.
- An Application can hold up to **25 active keys at once**, so a new key and the old key can overlap during a deploy. Rotation never requires downtime.

## Emergency: a secret key leaked

A key pasted into a public repo, a log aggregator, a screenshot, an AI chat — treat them all the same. Work the steps in this order; minutes matter for step 1.

### 1. Revoke the leaked key immediately

Revocation is instant and permanent (`revoked_at` soft-delete; the row is kept for audit). Every request using that key fails with `API_KEY_INVALID` (401) from the next request on.

Via the panel: **Application → API Keys → Revoke** (requires workspace OWNER or ADMIN).

Via the API:

```bash
# Operator session (panel credentials):
curl -X DELETE "$RELIPAY_URL/api/v1/tenant/applications/$APP_ID/api-keys/$KEY_ID" \
  -H "Authorization: Bearer $OPERATOR_ACCESS_TOKEN"

# Or with the bootstrap admin key:
curl -X DELETE "$RELIPAY_URL/api/v1/admin/applications/$APP_ID/api-keys/$KEY_ID" \
  -H "Authorization: Bearer $SUPER_ADMIN_KEY"
```

Don't know which key id leaked? List them and match on `keyPrefix` (the first characters of the raw key, e.g. `rp_live_aBcD`):

```bash
curl "$RELIPAY_URL/api/v1/tenant/applications/$APP_ID/api-keys" \
  -H "Authorization: Bearer $OPERATOR_ACCESS_TOKEN"
```

Yes — this takes your integration down until step 3. That is the correct trade against an attacker holding Application-wide access. If you can mint the replacement within a minute or two, you can do steps 2–3 first and revoke immediately after; never let the window stretch.

### 2. Mint the replacement

```bash
curl -X POST "$RELIPAY_URL/api/v1/tenant/applications/$APP_ID/api-keys" \
  -H "Authorization: Bearer $OPERATOR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Production server (rotated 2026-06-10)", "mode": "live"}'
```

Copy `data.rawKey` from the response **now** — it is shown exactly once. Put a date in the `name` so the key list tells you when each credential was last rotated.

If your agent tooling mints keys, the [MCP server](mcp.md)'s `mint_api_key` tool does the same thing via a scoped operator PAT (`keys:mint`).

### 3. Deploy the new key

Update `RELIPAY_SECRET` in your secret store / deployment env and roll your servers. Because old and new keys can be active simultaneously, the zero-downtime order is: mint new → deploy → revoke old. In a confirmed-leak emergency, prefer revoke-first (step 1) and eat the brief outage.

### 4. Verify the old key is dead and the new key works

```bash
# New key — expect 200 with your Application's slug:
curl "$RELIPAY_URL/api/v1/me/" -H "Authorization: Bearer $NEW_KEY"

# Old key — expect 401 API_KEY_INVALID:
curl "$RELIPAY_URL/api/v1/me/" -H "Authorization: Bearer $OLD_KEY"
```

Also check `lastUsedAt` on the revoked key in the panel over the next hours — continued attempts after revocation tell you someone was actively using it.

### 5. Assess what the key touched

Key mints and revocations are recorded as security events (`app.api_key.created` / `app.api_key.revoked` — panel → Security events, or `GET /api/v1/tenant/security-events`). Review whatever window the key was exposed for: unexpected end-user creation, checkout sessions, credit grants. If you suspect end-user data was read, follow your incident-response policy.

## Proactive rotation cadence

You don't have to wait for a leak:

- **Rotate live keys on a schedule** — quarterly is a sane default; align with your other secret rotations. The mint-deploy-revoke sequence above is zero-downtime.
- **Rotate on personnel change** — anyone who could read production env vars and leaves the team.
- **Set `expiresAt` on keys minted for short-lived purposes** (load tests, migrations, contractors). Expired keys fail closed with `API_KEY_INVALID`; nothing to remember to clean up.
- **One key per consumer** — give each service/environment its own named key so a leak is revocable without redeploying everything else, and `lastUsedAt` stays meaningful.
- **Scope down where possible** — keys take a `scopes` array (`auth:read`, `auth:write`, `billing:read`, `billing:write`, `webhooks:read`); a leaked scoped key buys an attacker less than `*`.

Keys never auto-rotate. Rotation is always an explicit operator action.

## Rotating adjacent secrets

### Outbound webhook signing secrets

Each webhook endpoint you register (the ones ReliPay signs and sends to **your** app — see [billing.md](billing.md)) has its own signing secret, also shown once at creation. To rotate:

```bash
curl -X POST "$RELIPAY_URL/api/v1/tenant/applications/$APP_ID/webhooks/$ENDPOINT_ID/rotate-secret" \
  -H "Authorization: Bearer $OPERATOR_ACCESS_TOKEN"
```

The new raw secret is returned once. Note this is a **hard cutover** — deliveries are signed with the new secret immediately, so update `RELIPAY_WEBHOOK_SECRET` on your receiver right away; deliveries verified against the old secret in between will fail your `verifyWebhookSignature` check and be retried by ReliPay's delivery worker.

### Provider credentials (Stripe / PayPal / Razorpay)

BYO provider credentials and the provider webhook secret are write-only (AES-256-GCM encrypted at rest; no GET returns plaintext). Rotating them is a re-`PUT`:

```bash
curl -X PUT "$RELIPAY_URL/api/v1/tenant/applications/$APP_ID/billing-credentials/stripe" \
  -H "Authorization: Bearer $OPERATOR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"data": {"apiKey": "sk_live_NEW…", "webhookSecret": "whsec_NEW…"}}'
```

Rotate at the provider first (Stripe dashboard → roll key / roll webhook signing secret), then `PUT` the new values here. Until the `PUT` lands, inbound provider webhooks signed with the new provider secret are rejected with `WEBHOOK_SIGNATURE_INVALID` (401) — the providers retry, so a short gap self-heals, but keep it short.

### `SUPER_ADMIN_KEY`

The bootstrap admin key is a deployment env var, not a database row. Rotate it like any other infrastructure secret: change the env value and restart the API. Old value stops working immediately.

## Publishable-key rotation

The publishable key (`rp_pub_…`) rotates differently from a secret key, because of **where it lives**. A secret key sits on your server — rotate it and redeploy, done in minutes. A publishable key is baked into **shipped client bundles you cannot force-update**: old mobile-app versions in the wild, cached SPAs, desktop installs. A hard cutover would break every client still running the old key.

So publishable-key rotation is **dual-key with a grace window**:

1. Rotating mints a fresh key and moves the current one to `previous_public_key` with a deadline (`previous_public_key_valid_until`).
2. **Both** keys verify until the deadline passes (see `requirePublishableOrSecretKey`).
3. You roll the new key out to all clients during the window.
4. After the deadline the old key stops verifying.

The slug is preserved (`rp_pub_<slug>_<random>`) — only the random tail changes, so the key stays identifiable.

### Rotate via the panel

**Application → API Keys → Publishable key → Rotate** (workspace OWNER/ADMIN, type the slug to confirm). The card then shows the grace-window deadline.

### Rotate via the API

```bash
curl -X POST "$RELIPAY_URL/api/v1/tenant/applications/$APP_ID/rotate-public-key" \
  -H "Authorization: Bearer $OPERATOR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"graceDays": 30}'   # 1–90, default 30
```

Response carries `publicKey` (new), `previousPublicKey` (old, still valid), and `previousPublicKeyValidUntil`. A `app.public_key.rotated` security event is recorded.

There is **one** previous-key slot. Rotating again while a previous key is still in its grace window is rejected with **409 `PUBLIC_KEY_ROTATION_IN_GRACE`** — otherwise the in-flight previous key would be silently dropped, locking out clients still on it. Wait for the window to end, or pass `"force": true` to drop the previous key now (the leaked-key path, where you *want* the older key dead immediately). The panel surfaces this: when a rotation is already in progress, the Rotate button warns that the previous key will be dropped before it proceeds.

### If a publishable key is abused

A publishable key grants nothing on its own, so a leak is far lower-severity than a secret-key leak — the worst case is someone else's site driving sign-in/license-verify attempts against your app. Mitigate with the **origin allowlist** (Panel → Application → Access) first; rotate the key if you also want to invalidate the leaked value. Set a **short `graceDays`** if you control all clients (e.g. a single SPA you can redeploy immediately); keep it longer when native installs are in the field.
