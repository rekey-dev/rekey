# Quickstart

From a fresh clone to a working API + first Application + first key. Copy-pasteable for both humans and AI agents.

## 0 — Prerequisites

- Node 22+ LTS
- pnpm 9+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- Docker (for Postgres + Redis)

## 1 — Boot the stack

```bash
pnpm install

cp .env.example .env
# Fill in the required secrets:
#   JWT_SECRET=$(openssl rand -hex 32)
#   SUPER_ADMIN_KEY=$(openssl rand -hex 32)
# Optional for local dev (REQUIRED in production — the API refuses to boot without it):
#   ENCRYPTION_KEY=$(openssl rand -hex 32)

docker compose up -d postgres redis
pnpm db:migrate:deploy
pnpm dev
```

API at `http://localhost:3030`. Docs at `http://localhost:3030/docs`. OpenAPI JSON at `http://localhost:3030/docs/json`.

```bash
curl http://localhost:3030/health
# → {"status":"ok","service":"rekey-api"}
```

## 2 — Create your first Tenant

Steps 2–4 provision everything with raw `curl` + your `SUPER_ADMIN_KEY` — no UI
needed. Prefer clicking? The operator panel at `http://localhost:3031` does the
same thing: sign up there, create an Application, and copy its secret key from
the API keys page (this is the flow the SDK READMEs describe), then skip to
step 5.

```bash
ADMIN=$(grep ^SUPER_ADMIN_KEY .env | cut -d= -f2)

TENANT=$(curl -sX POST http://localhost:3030/api/v1/admin/tenants \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme Co", "ownerEmail": "ops@acme.example"}' \
  | jq -r .data.id)

echo "Tenant: $TENANT"
```

## 3 — Create an Application

```bash
APP=$(curl -sX POST http://localhost:3030/api/v1/admin/applications \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d "{\"tenantId\": \"$TENANT\", \"name\": \"Acme Prod\", \"slug\": \"acme-prod\"}" \
  | jq -r .data.id)

echo "Application: $APP"
```

The response includes a public key (`rp_pub_acme-prod_…`). That's safe to embed in client code.

## 4 — Mint an API key

```bash
curl -sX POST http://localhost:3030/api/v1/admin/applications/$APP/api-keys \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Production server"}' \
  | jq
```

Save the `rawKey` from the response. You will not see it again — only its hash is stored. If a key ever leaks (or just on schedule), follow [docs/api-key-rotation.md](api-key-rotation.md): revoke, mint a replacement, deploy, verify the old key is dead.

## 5 — Use it from your app

```ts
// my-app/server.ts
import { Rekey } from '@rekey.dev/node';

const rekey = new Rekey({
  apiUrl: 'http://localhost:3030',
  secretKey: process.env.REKEY_SECRET!, // the rawKey from step 4
});

// Smoke test — verifies your credentials and prints which Application you're connected to.
const me = await rekey.applications.me();
console.log(`Connected to "${me.name}" (${me.slug})`);
```

Or via curl:

```bash
curl http://localhost:3030/api/v1/me/ \
  -H "Authorization: Bearer $REKEY_SECRET"
# → {"success":true,"data":{"id":"...","slug":"acme-prod","publicKey":"rp_pub_...","authConfig":{...},"billingConfig":{...}}}
```

If this returns 200, your secret key is valid and you're pointed at the right deployment.

## 6 — Sign up your first end-user

```ts
const { endUser, accessToken, refreshToken } = await rekey.auth.signUp({
  email: 'alice@example.com',
  password: 'correct-horse-battery-staple',
});

// Subsequent per-user calls take the SHORT-LIVED access token.
const me = await rekey.auth.getCurrentUser(accessToken);
console.log(me.email); // → "alice@example.com"

// When the access expires (~15 min later), exchange the refresh for a new pair.
// The presented refresh is single-use — store the new one immediately.
const next = await rekey.auth.refresh(refreshToken);
```

Or via curl:

```bash
RESPONSE=$(curl -sX POST http://localhost:3030/api/v1/auth/sign-up \
  -H "Authorization: Bearer $REKEY_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"correct-horse-battery-staple"}')
ACCESS=$(echo "$RESPONSE" | jq -r .data.accessToken)

curl http://localhost:3030/api/v1/users/me/ \
  -H "Authorization: Bearer $REKEY_SECRET" \
  -H "X-Rekey-User-Token: $ACCESS"
```

See [docs/auth.md](auth.md) for the full auth model — access vs refresh tokens, the cross-application guard, replay protection, and how `Application.authConfig` shapes what is allowed. For billing see [docs/billing.md](billing.md) — `rekey.billing.getPlans()`, `createCheckout()`, `getSubscription()` and `getEntitlements()` are all live.

## 7 — Password reset & magic links: branch on `emailSent`

`auth.requestPasswordReset` and `auth.requestMagicLink` (and `auth.sendVerificationEmail`) return **different shapes depending on whether Rekey could send the email itself** (BYO Resend credentials on the Application, or `RESEND_DEFAULT_*` env). They never throw for an unknown email — enumeration-safe by design.

| Case | `delivered` | `emailSent` | token field (`resetToken` / `magicLinkToken`) | Your job |
|---|---|---|---|---|
| Email transport configured, user exists | `true` | `true` | `null` | Nothing — the user has the email. |
| No transport (or send failed), user exists | `true` | `false` | the raw token | **You** email the link via your own provider. |
| Unknown email | `false` | `false` | `null` | Nothing. Show the same "check your inbox" UI — never reveal. |

```ts
const result = await rekey.auth.requestPasswordReset({
  email,
  resetUrl: 'https://yourapp.com/reset?token={token}', // {token} is substituted
});

if (!result.emailSent && result.resetToken) {
  // No Rekey email transport — forward the token yourself.
  await sendgrid.send({
    to: email,
    subject: 'Reset your password',
    text: `https://yourapp.com/reset?token=${encodeURIComponent(result.resetToken)}`,
  });
}
// In ALL cases (including delivered: false) render the same neutral
// "If that address exists, we sent a link" message.
```

`requestMagicLink` follows the identical pattern with `signInUrl` and `magicLinkToken`.

## What's next

- [`docs/concepts.md`](concepts.md) — Tenant / Application / EndUser data model
- [`docs/api-keys.md`](api-keys.md) — the three credential types and how they differ
- [`docs/api-key-rotation.md`](api-key-rotation.md) — leaked-key drill + rotation cadence
- [`docs/errors.md`](errors.md) — error envelope + the complete code reference
- [`AGENTS.md`](../AGENTS.md) — agent-specific guidance for adding code or adding Rekey to other projects
