# Quickstart

From a fresh clone to a working API + first Application + first key. Copy-pasteable for both humans and AI agents.

## 0 — Prerequisites

- Node 22+ LTS
- pnpm 9+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- Docker (for Postgres + Redis). Already have your own? Point `DATABASE_URL` / `REDIS_URL` at them and skip the compose step.

Redis is not optional. The API refuses to boot without it — outbound webhook
delivery runs on a Redis-backed queue and there is no in-process fallback.

## 1 — Configure

```bash
pnpm install
cp .env.example .env
```

Now edit `.env`. Five values have to be filled in before anything boots, and
two of them appear twice:

```bash
# Datastore passwords — docker-compose.yml requires both, with no default.
openssl rand -hex 24   # → POSTGRES_PASSWORD
openssl rand -hex 24   # → REDIS_PASSWORD

# API secrets.
openssl rand -hex 32   # → JWT_SECRET
openssl rand -hex 32   # → SUPER_ADMIN_KEY
openssl rand -hex 32   # → ENCRYPTION_KEY
```

Then replace the two `CHANGE_ME` placeholders in the connection strings with
the passwords you just generated — compose does **not** substitute them for
you, and the API reads these strings directly:

```ini
DATABASE_URL=postgresql://rekey:<POSTGRES_PASSWORD>@localhost:5432/rekey?schema=public
REDIS_URL=redis://:<REDIS_PASSWORD>@localhost:6379
```

(The leading colon in `REDIS_URL` is not a typo — Redis `AUTH` with
`requirepass` has no username.)

`ENCRYPTION_KEY` is optional in development and **required in production**: the
API refuses to boot without it, and also refuses to boot on the value
`docker-compose.yml` shipped as a default before 2.0.0-rc.1. Generate your own.

## 2 — Boot

```bash
docker compose up -d postgres redis
pnpm db:migrate:deploy
pnpm dev
```

All three commands read the `.env` you just wrote — `db:migrate:deploy` runs
Prisma from the repo root so it picks the file up, and `pnpm dev` loads it
before handing off to turbo. `pnpm dev` also generates the Prisma client and
builds the workspace packages the apps import from `dist/`, so there is no
separate build step on a fresh clone.

API at `http://localhost:3030`. Interactive docs at `http://localhost:3030/docs`.
OpenAPI JSON at `http://localhost:3030/docs/json`. Operator panel at
`http://localhost:3031`.

```bash
curl http://localhost:3030/health
# → {"status":"ok","service":"rekey-api","db":"ok","redis":"ok"}
```

`/health` checks its dependencies, so a 503 here names the one that is
unreachable. `/health/live` never touches a dependency — that is the one to
point a container liveness probe at.

## 3 — Bootstrap: one command

`rekey init` creates the Tenant, the Application, and the Application's first
API key in a single call. That is the whole bootstrap.

```bash
export REKEY_URL=http://localhost:3030
export SUPER_ADMIN_KEY=$(grep ^SUPER_ADMIN_KEY .env | cut -d= -f2)

npx @rekey.dev/cli init \
  --tenant-name "Acme Co" \
  --owner-email ops@acme.example \
  --app-name    "Acme Prod" \
  --app-slug    acme-prod
```

```
✓ Tenant      cmsa9dd8p0003v5ssca5nrw4k  Acme Co
✓ Application cmsa9dd900005v5sss645n3og  acme-prod
✓ Public key  rp_pub_acme-prod_781Wp_9DdfjOCbEt
✓ API key     rp_test_BOXc…

SECRET KEY (shown once — save it now):
  rp_test_BOXc99-YIx-TLKird419Xk3NkMCjx5Uo
```

Save the secret key now. Only its hash is stored, so it cannot be recovered —
mint a replacement instead. When one leaks, follow
[docs/api-key-rotation.md](api-key-rotation.md): revoke, mint, deploy, verify
the old key is dead.

Add `--json` to any command for a single JSON document on stdout — every
command in this CLI runs non-interactively when given enough flags, which is
what makes it safe for an agent to drive. `rekey doctor` checks your
`REKEY_URL` / `SUPER_ADMIN_KEY` and the API's reachability before you start.

**Two things to know about what you just created.** The key prefix is
`rp_test_` because `init` creates a `DEVELOPMENT` Application, and environment
is fixed at creation with no promotion path — a `PRODUCTION` Application is
created from the panel or `POST /api/v1/tenant/applications`. And **billing is
off**: `billingConfig.enabled` defaults to `false` on a new Application, so
every billing endpoint answers `403 BILLING_DISABLED` until you turn it on in
**Panel → Application → Billing**.

### Prefer clicking?

The operator panel at `http://localhost:3031` does the same thing: sign up,
create an Application, copy its secret key from the API keys page. Then skip to
step 4.

### Prefer raw HTTP?

<details>
<summary>The three <code>curl</code> calls <code>rekey init</code> makes</summary>

```bash
ADMIN=$(grep ^SUPER_ADMIN_KEY .env | cut -d= -f2)

TENANT=$(curl -sX POST http://localhost:3030/api/v1/admin/tenants \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme Co", "ownerEmail": "ops@acme.example"}' \
  | jq -r .data.id)

APP=$(curl -sX POST http://localhost:3030/api/v1/admin/applications \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d "{\"tenantId\": \"$TENANT\", \"name\": \"Acme Prod\", \"slug\": \"acme-prod\"}" \
  | jq -r .data.id)

curl -sX POST http://localhost:3030/api/v1/admin/applications/$APP/api-keys \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Production server"}' \
  | jq
```

The Application response also carries a public key (`rp_pub_acme-prod_…`).
That one is safe to embed in client code — see
[docs/api-keys.md](api-keys.md).

</details>

## 4 — Use it from your app

```ts
// my-app/server.ts
import { Rekey } from '@rekey.dev/node';

const rekey = new Rekey({
  apiUrl: 'http://localhost:3030',
  secretKey: process.env.REKEY_SECRET!, // the secret key from step 3
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

If this returns 200, your secret key is valid and you're pointed at the right
deployment.

## 5 — Sign up your first end-user

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

See [docs/auth.md](auth.md) for the full auth model — access vs refresh tokens,
the cross-application guard, replay protection, and how `Application.authConfig`
shapes what is allowed. Building the UI? [docs/react-components.md](react-components.md)
covers the drop-in `<SignIn />` / `<SignUp />` / `<UserButton />` family.

## 6 — Password reset & magic links: branch on `emailSent`

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

## 7 — Turn on billing (when you need it)

Billing is off on a new Application, so this is a deliberate step rather than
something you inherit. Enable it in **Panel → Application → Billing**, store the
provider credentials for that Application (there is no deployment-wide Stripe
key — see [docs/api-keys.md](api-keys.md)), then create plans:

```bash
npx @rekey.dev/cli plans create --app <applicationId> \
  --slug pro_monthly --name Pro --amount 999   # amount is an INTEGER in minor units
```

After that `rekey.billing.getPlans()`, `createCheckout()`, `getSubscription()`
and `getEntitlements()` all work. Read [docs/billing.md](billing.md) first —
checkout is asynchronous (the subscription flips to ACTIVE on the provider's
webhook, not on the redirect), and that shapes how you write the success page.

## What's next

- [`docs/concepts.md`](concepts.md) — Tenant / Application / EndUser data model
- [`docs/api-keys.md`](api-keys.md) — the three credential types and how they differ
- [`docs/api-key-rotation.md`](api-key-rotation.md) — leaked-key drill + rotation cadence
- [`docs/react-components.md`](react-components.md) — the drop-in React component library
- [`docs/webhooks.md`](webhooks.md) — outbound events, signatures, retries
- [`docs/errors.md`](errors.md) — error envelope + the complete code reference
- [`AGENTS.md`](../AGENTS.md) — agent-specific guidance for adding code or adding Rekey to other projects

## If something didn't work

| Symptom | Cause |
|---|---|
| `Error: Environment variable not found: DATABASE_URL` | `.env` is missing, or you ran the Prisma command from `apps/api` instead of the repo root. `pnpm db:migrate:deploy` from the root reads the root `.env`. |
| `❌ Invalid environment variables: DATABASE_URL / JWT_SECRET / SUPER_ADMIN_KEY` | Same file, not filled in. Nothing else in the stack supplies defaults for these three. |
| `ERR_MODULE_NOT_FOUND: @rekey.dev/shared-types/dist/index.js` | A workspace package hasn't been built. `pnpm dev` and `pnpm build` build dependencies first; running an app's own `dev` script directly does not. |
| `Module '"@prisma/client"' has no exported member 'Prisma'` | The Prisma client hasn't been generated. `pnpm db:generate` (the root `build` / `dev` / `typecheck` / `test` scripts run it for you). |
| `403 BILLING_DISABLED` | Expected on a new Application — see step 7. |
| API starts, then exits naming Redis | Redis is genuinely required. Start it, or point `REDIS_URL` somewhere real. |
