# Upgrading from 2.3 to 2.4

This page takes a deployment and its integrations from **2.3.x** to
**2.4.0**. Follow it from the top and you end on a working 2.4.0. "Before" is
2.3.1 and "after" is 2.4.0.

2.4 has one database migration and one behaviour change that needs a
decision: an Application with `mfa: 'required'` now refuses every session
whose user has not set up an authenticator. The rest is configuration and a
few API responses that changed shape. Your customers also see new pages in
the hosted portal, which follow settings you may want to check first.

The examples use `api.acme.example`, `panel.acme.example` and
`portal.acme.example` for the three services, and `acme` as the
Application's slug. Put your own in their place.

## Who needs to do what

| If you | Read |
|---|---|
| Self-host with Docker Compose (`docker-compose.prod.yml`) | [Before you start](#before-you-start), [Environment](#environment), [Database](#database), [Deploy and verify](#deploy-and-verify) |
| Self-host from a source checkout | The same four sections. The commands for a source checkout are given beside the Compose ones |
| Use the hosted service and only the SDKs | [Upgrade the SDKs](#6-upgrade-the-sdks) and [API and SDK changes](#api-and-sdk-changes-that-need-code-changes). The server side is upgraded for you |
| Have `mfa: 'required'` on any Application | [Required two-factor is enforced on the session](#required-two-factor-is-enforced-on-the-session), before you deploy |
| Have `deviceBinding: 'required'` on any Application | [`INTERNAL_CALLER_SECRET`](#internal_caller_secret) and [Device-bound applications](#device-bound-applications) |
| Use the hosted portal | [Hosted portal changes](#hosted-portal-changes), and [Custom domains](#custom-domains) if you want one |
| Use an Application as an OpenID Connect provider or a hosted MCP server | [OIDC provider and MCP server applications](#oidc-provider-and-mcp-server-applications) |
| Mail your own organization invitations | [Organization invitations are emailed](#organization-invitations-are-emailed) |
| Read `GET /billing/plans`, or call `getPlans` in an SDK | [The plan list](#the-plan-list) |
| Let users delete their own account | [Deleting an account with no password](#deleting-an-account-with-no-password) |
| Verify access tokens offline (JWKS) | [Offline token verification](#offline-token-verification) |

## Before you start

**1. Back up the database.** With the bundled Postgres in
`docker-compose.prod.yml`:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U rekey -d rekey -Fc > rekey-$(date +%F).dump
```

Keep the `-T`: without it Compose allocates a terminal and the dump is
corrupted. On a managed database, take a snapshot the way your provider does
it. [Rolling back](#rolling-back) says when you would need it.

**2. Note the version you are on.** `/health/live` reports it:

```bash
curl -fsS https://api.acme.example/health/live
# {"status":"ok","service":"rekey-api","version":"2.3.1","commit":"..."}
```

**3. Plan the order.**

1. The migration. It runs by itself when the 2.4.0 `api` container starts
   (`prisma migrate deploy` is part of the image's start command). From a
   source checkout you run it yourself, see [Database](#database).
2. The API, the panel and the portal, together.
3. The `@rekey.dev/*` packages in your own apps.

The API and the portal must go together because the portal reads a part of
the portal config response that 2.3 does not send.
`GET /api/v1/portal/config/:slug` gained a required `auth` object with seven
fields: `password`, `magicLink`, `signup`, `emailVerificationRequired`,
`mfaRequired`, `devices` and `organizations`. The 2.4.0 portal decides every
sign-in page from it, so in front of a 2.3 API it fails on every page. The
2.4.0 panel reads only the API of its own release, so deploy it in the same
step. A 2.3 package against a 2.4 API keeps working apart from the changes in
[API and SDK changes](#api-and-sdk-changes-that-need-code-changes).

**4. If any Application has `mfa: 'required'`, decide what happens to its
users first.** See [Required two-factor is enforced on the
session](#required-two-factor-is-enforced-on-the-session). It is the one
change your users notice the moment the API restarts.

## Environment

No variable is new in 2.4.0. Several that existed now decide whether a
feature works, so check each one. The [check below](#check-your-setup) prints
what each service sees without printing a secret.

| Variable | Set on | Needed when | Already in place with `docker-compose.prod.yml`? |
|---|---|---|---|
| `INTERNAL_CALLER_SECRET` | API, portal, panel (one value) | Always on a Compose stack; on any deployment with a device-bound Application whose customers use the portal | Required on the `api` and `portal` services since 2.2: Compose refuses to start without it. Optional on `panel`, which reads the same `.env` key |
| `PUBLIC_PORTAL_URL` | API | The portal is used | Defaults to `https://${PORTAL_HOST}` |
| `PORTAL_BASE_URL` | Portal | The portal is used | Defaults to `https://${PORTAL_HOST}` |
| `PORTAL_PROXY_SECRET` | Portal | A reverse proxy sits in front of the portal | Required since 2.2; Traefik sends it |
| `PORTAL_TRUSTED_PROXY_HOPS` | Portal | A reverse proxy sits in front of the portal | Defaults to `1` |
| `PORTAL_EXTRA_HOST_RULES` | Compose only (a Traefik label) | You serve a portal on a custom domain | Unset, routes nothing extra |
| `JWT_SECRET` | API | Always | Required |

### `INTERNAL_CALLER_SECRET`

A shared secret the panel and the portal send to the API as
`X-Rekey-Caller-Secret`. It proves a request came from your own panel or
portal server, so the API believes the visitor's address, browser and country
those servers forward.

In 2.4.0 it also lets the portal sign in a customer of a device-bound
Application (`deviceBinding: 'required'`). With it, the API gives the portal
a session that holds no device. Without it, every portal sign-in for that
Application is refused with `DEVICE_FINGERPRINT_REQUIRED`, and the portal
tells the customer that the account signs in through the app installed on
their computer. Customers of other Applications are not affected.

Set one value on the API and the portal. The panel sends it too when it is
set, so give the panel the same value. The variable has existed since 2.2.
Generate it with `openssl rand -hex 32`; the API refuses a value shorter than
16 characters. `docker-compose.prod.yml` already requires it on `api` and
`portal`. `docker-compose.yml`, the local stack, passes it to `api`, `panel`
and `portal` when `.env` sets it, and leaves it unset otherwise.

### `PUBLIC_PORTAL_URL` and `PORTAL_BASE_URL`

`PUBLIC_PORTAL_URL` is the API's copy of the portal's public address.
`PORTAL_BASE_URL` is the portal's own. They must name the same origin, such as
`https://portal.acme.example`.

When they differ, the portal sends a link or an `Origin` the API does not
treat as the portal:

- Password reset, sign-in link, confirmation and invitation emails requested
  from the portal are refused with `400 AUTH_URL_NOT_ALLOWED`.
- Social sign-in from the portal is refused with
  `400 OAUTH_REDIRECT_URI_NOT_ALLOWED`.
- On an Application with an origin allowlist (Panel, Application, Access),
  every portal call is refused with `403 ORIGIN_NOT_ALLOWED`.

With `PUBLIC_PORTAL_URL` unset, the API treats the deployment as running no
portal: the panel shows no portal address and portal password resets are
refused.

Both variables existed before 2.4. In `docker-compose.prod.yml` both default
to `https://${PORTAL_HOST}`, so they agree unless you override one of them.

### `PORTAL_PROXY_SECRET` and `PORTAL_TRUSTED_PROXY_HOPS`

When a reverse proxy sits in front of the portal, it adds
`X-Rekey-Proxy-Secret` with the value of `PORTAL_PROXY_SECRET` to every
request, and overwrites any copy a client sent. The portal believes a request's
forwarded headers only when that header matches.

- `PORTAL_TRUSTED_PROXY_HOPS` is how many proxies append to
  `X-Forwarded-For` in front of the portal (Traefik alone is `1`). With the
  secret, the portal forwards the visitor's address to the API, so per-IP
  limits count visitors instead of the portal.
- On a custom domain, the portal also reads `X-Forwarded-Host` to know which
  Application a request is for. It believes that header only with the proxy
  secret, whatever the hop count. Without the secret it uses `Host`, so a
  proxy that rewrites `Host` breaks custom domains.

Both are set on the portal and both existed before 2.4. Generate the secret
with `openssl rand -hex 32` and have your proxy send it. With
`docker-compose.prod.yml` this is done: it requires `PORTAL_PROXY_SECRET`,
defaults the hop count to `1`, and Traefik sends the header.

### `PORTAL_EXTRA_HOST_RULES`

Only for `docker-compose.prod.yml`, and only if you serve a portal on a custom
domain. It is Traefik rule text appended after the portal's own `Host()`
rule, so it starts with `||`:

```bash
# .env
PORTAL_EXTRA_HOST_RULES= || Host(`billing.acme.example`) || Host(`account.other.example`)
```

Traefik then routes those hosts to the portal and asks for a certificate for
each. Restart the stack after changing it (`docker compose -f
docker-compose.prod.yml up -d portal`). Behind your own proxy, route the
hosts there instead. See [Custom domains](#custom-domains).

### `JWT_SECRET`

Not new and not changed by the upgrade. The TXT record that proves a custom
portal domain is derived from `JWT_SECRET`, the Application id and the
hostname. Rotating `JWT_SECRET` changes every record's value, so every
verified custom domain lapses until its owner publishes the new record and
verifies again. If you rotate it, tell those operators first.

### Check your setup

These print each value that is safe to show, and a short SHA-256 prefix of
each secret. The secret prefixes must be the same on every line, and the two
URLs must have the same origin.

With Docker Compose, while the stack runs:

```bash
show() {
  docker compose -f docker-compose.prod.yml exec -T "$1" node -e '
    const { createHash } = require("node:crypto");
    for (const name of process.argv.slice(1)) {
      const v = process.env[name];
      const plain = /_URL$|_HOPS$/.test(name);
      const shown = !v ? "UNSET" : plain ? v : "sha256 " + createHash("sha256").update(v).digest("hex").slice(0, 12);
      console.log(name.padEnd(26) + shown);
    }' "${@:2}"
}
show api    INTERNAL_CALLER_SECRET PUBLIC_PORTAL_URL
show panel  INTERNAL_CALLER_SECRET
show portal INTERNAL_CALLER_SECRET PORTAL_BASE_URL PORTAL_PROXY_SECRET PORTAL_TRUSTED_PROXY_HOPS
docker compose -f docker-compose.prod.yml config | grep 'routers.rekey-portal.rule'
```

From a source checkout, where the API reads the root `.env` and the panel and
portal read their own `.env.local`:

```bash
fp() { if [ -n "$1" ]; then printf %s "$1" | openssl dgst -sha256 | awk '{print substr($NF,1,12)}'; else echo UNSET; fi; }
get() { grep -E "^$1=" "$2" 2>/dev/null | tail -n 1 | cut -d= -f2-; }
echo "api    INTERNAL_CALLER_SECRET  $(fp "$(get INTERNAL_CALLER_SECRET .env)")"
echo "panel  INTERNAL_CALLER_SECRET  $(fp "$(get INTERNAL_CALLER_SECRET apps/panel/.env.local)")"
echo "portal INTERNAL_CALLER_SECRET  $(fp "$(get INTERNAL_CALLER_SECRET apps/portal/.env.local)")"
echo "portal PORTAL_PROXY_SECRET     $(fp "$(get PORTAL_PROXY_SECRET apps/portal/.env.local)")"
echo "api    PUBLIC_PORTAL_URL       $(get PUBLIC_PORTAL_URL .env)"
echo "portal PORTAL_BASE_URL         $(get PORTAL_BASE_URL apps/portal/.env.local)"
```

A value written in quotes in a file is hashed with its quotes, so quote it the
same way in every file or not at all. If a process manager sets the variables
instead of these files, run the Compose version's `node -e` line in that
environment.

## Database

2.4.0 has one migration, `20261110132835_portal_domain_verification`. It
changes only the `applications` table:

- It drops the unique index `applications_portal_domain_key`. Before, only one
  Application could name a hostname at all, so a hostname someone else had
  typed in blocked the real owner.
- It adds a partial unique index, `portal_domain_verified_key`, on
  `portal_domain` where `portal_domain_verified_at` is set. Any number of
  Applications may claim a hostname; one may hold it verified.
- It adds three columns for the periodic re-check of verified domains:
  `portal_domain_checked_at`, `portal_domain_check_failures` (an integer,
  default 0) and `portal_domain_lapsed_at`.

**It is safe on a live database.** The migration runs as one transaction that
takes an exclusive lock on `applications` from its first statement until it
commits. Most API requests read an Application, so they wait while it holds
the lock. Adding a column with a constant default
does not rewrite the table, and building the new index reads a table that
has one row per Application, so the lock is held for milliseconds. The new
index cannot fail on existing data: the dropped index already allowed at most
one row per hostname.

The one thing that can stretch it is a long transaction already open on
`applications`, because the migration waits behind it and everything else
waits behind the migration. Check before you deploy:

```sql
SELECT pid, now() - xact_start AS open_for, state, left(query, 60) AS query
FROM pg_stat_activity
WHERE xact_start < now() - interval '1 minute'
ORDER BY xact_start;
```

**Run it.** With Docker Compose it runs when the 2.4.0 `api` container starts.
From a source checkout, with `DATABASE_URL` in the root `.env`:

```bash
pnpm db:migrate:deploy
```

**Confirm it applied:**

```bash
docker compose -f docker-compose.prod.yml exec -T postgres psql -U rekey -d rekey -c \
  "SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = '20261110132835_portal_domain_verification';"
docker compose -f docker-compose.prod.yml exec -T postgres psql -U rekey -d rekey -c '\d applications' | grep portal_domain
```

The first prints one row with a `finished_at` time. The second lists the three
new columns and the index `portal_domain_verified_key` with
`WHERE portal_domain_verified_at IS NOT NULL`. From a source checkout, run the
same two queries with `psql "$DATABASE_URL"`.

## Deploy and verify

### 1. Deploy the API, the panel and the portal

With Docker Compose, after pulling the 2.4.0 source:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The `api` container runs the migration, then starts. From a source checkout,
run the migration, then build and restart all three apps together.

### 2. Check the API

```bash
curl -fsS https://api.acme.example/health
# {"status":"ok","service":"rekey-api","db":"ok","redis":"ok"}
curl -fsS https://api.acme.example/health/live
# {"status":"ok","service":"rekey-api","version":"2.4.0","commit":"..."}
```

A `503` from `/health` names the dependency it cannot reach. If the container
does not start, read its log: a migration that failed says so there.

### 3. Check the portal config

For an Application with the portal on:

```bash
curl -fsS https://api.acme.example/api/v1/portal/config/acme
```

```json
{
  "success": true,
  "data": {
    "slug": "acme",
    "name": "Acme",
    "publishableKey": "rp_pub_acme_...",
    "billingEnabled": true,
    "billingSubject": "user",
    "branding": {},
    "auth": {
      "password": true,
      "magicLink": false,
      "signup": true,
      "emailVerificationRequired": false,
      "mfaRequired": false,
      "devices": false,
      "organizations": false
    }
  }
}
```

No `auth` object means the request reached a 2.3 API. A `404 PORTAL_NOT_FOUND`
means the portal is off for that Application.

### 4. Sign in through the portal

Open `https://portal.acme.example/acme/login` and sign in as a test user. The
page offers the methods in `auth`: a password form, an emailed link, or both.
You should land on the overview.

### 5. Check the origin allowlist

2.3 portals sent no `Origin`, so every Application with an origin allowlist
answered `403 ORIGIN_NOT_ALLOWED` to portal sign-in. To check the API now
accepts the portal's origin for such an Application, try a sign-in for an
address that has no account:

```bash
curl -sS https://api.acme.example/api/v1/auth/sign-in \
  -H 'Authorization: Bearer rp_pub_acme_...' \
  -H 'Origin: https://portal.acme.example' \
  -H 'Content-Type: application/json' \
  -d '{"email":"nobody@acme.example","password":"not-a-real-password"}'
```

The answer should be `401 INVALID_CREDENTIALS`. A `403 ORIGIN_NOT_ALLOWED`
means `PUBLIC_PORTAL_URL` does not match the origin you sent, or the portal
is off for that Application.

### 6. Upgrade the SDKs

Upgrade every `@rekey.dev/*` package in your apps to 2.4.0 together, make the
changes in [API and SDK changes](#api-and-sdk-changes-that-need-code-changes),
and run your type-check.

## Required two-factor is enforced on the session

Until 2.3, `mfa: 'required'` was checked at sign-in: a user with no
authenticator got a session, with `mfaEnrollmentRequired: true` on the
sign-in result, and your app was trusted to send them to setup. In 2.4.0 the
API enforces it on every request.

**What changes.** A session whose user has no confirmed authenticator gets
`403 MFA_ENROLLMENT_REQUIRED` from every user-session route except these:

- `GET /api/v1/auth/mfa/status`
- `POST /api/v1/auth/mfa/setup`
- `POST /api/v1/auth/mfa/setup-confirm`
- `POST /api/v1/auth/send-verification`, because setup needs a confirmed
  address
- `POST /api/v1/auth/sign-out-everywhere`
- `GET /api/v1/auth/me` and `GET /api/v1/users/me`, without `include`

`POST /api/v1/auth/refresh` and `POST /api/v1/auth/sign-out` take the refresh
token and keep working.

- A passkey does not count. A user who signs in only with a passkey has no
  authenticator and is refused like anyone else.
- Existing sessions are affected. The check runs on each request, so a
  user who signed in before the upgrade is refused from the first request
  after it.
- Impersonation sessions are not. An operator acting as the user cannot enrol for
  them, so an impersonation session is never held back.

**Before you upgrade, count who it affects.** This lists each Application with
the policy and how many of its users have no confirmed authenticator. It only
reads.

```sql
SELECT a.slug, a.name,
       count(u.id) FILTER (WHERE m.enrolled_at IS NULL) AS users_without_authenticator,
       count(u.id) AS users
FROM applications a
LEFT JOIN end_users u ON u.application_id = a.id AND u.erased_at IS NULL AND u.banned_at IS NULL
LEFT JOIN mfa_credentials m ON m.end_user_id = u.id
WHERE a.auth_config ->> 'mfa' = 'required'
GROUP BY a.id, a.slug, a.name
ORDER BY users_without_authenticator DESC;
```

With Compose, pipe it in with
`docker compose -f docker-compose.prod.yml exec -T postgres psql -U rekey -d rekey`.

**Then choose, per Application:**

- **Let the portal take them through setup.** If your users manage their
  account in the hosted portal, it already sends them to its setup page (a QR
  code, the setup key, and backup codes) before anything else.
- **Handle the code in your own app.** Send the user to your setup screen when
  sign-in says `mfaEnrollmentRequired`, and when any call answers
  `MFA_ENROLLMENT_REQUIRED`. Your setup screen calls `POST /auth/mfa/setup`
  and `POST /auth/mfa/setup-confirm` (`rekey.auth.mfaSetup` and
  `rekey.auth.confirmMfaSetup` in `@rekey.dev/node`). If setup answers
  `EMAIL_NOT_VERIFIED`, ask the user to confirm their address first.
- **Relax the policy first.** Set `mfa` to `optional` in Panel, Application,
  Authentication, upgrade, let users enrol, then set it back to `required`.

With the browser client from `@rekey.dev/react`:

```ts
import { RekeyError } from '@rekey.dev/react';

export async function signInAndRoute(email: string, password: string) {
  const outcome = await client.signIn({ email, password });
  if (outcome.mfaRequired) return redirectTo('/sign-in/code');
  if (outcome.mfaEnrollmentRequired) return redirectTo('/settings/two-factor');
  return redirectTo('/');
}

export async function readEntitlements(accessToken: string) {
  try {
    return await client.getEntitlements(accessToken);
  } catch (err) {
    if (err instanceof RekeyError && err.code === 'MFA_ENROLLMENT_REQUIRED') {
      redirectTo('/settings/two-factor');
    }
    throw err;
  }
}
```

### Offline token verification

An access token does not say whether its user has enrolled. If your server
verifies tokens offline against the JWKS and never calls the API, it still
admits an unenrolled user's token. Enforce the policy on your side, for
example by sending a user to setup when sign-in reports
`mfaEnrollmentRequired`, or check with `GET /api/v1/auth/mfa/status`.

Portal sessions on device-bound Applications are always HS256, so no offline
verifier accepts them.

## Hosted portal changes

The portal was mostly a billing page. In 2.4.0 it is the customer's account
page. Everything below follows the Application's own settings, so check them
before your customers see the new pages.

**What your customers now see:**

- **Sign-in follows the Application's methods:** a password form, an emailed
  sign-in link, both, or a note that sign-in happens in your app.
- **Create an account,** while `signupMode` is `public`. `public` is the
  default for an Application that never set it. While sign-up is open, an
  emailed sign-in link for a new address creates the account, and the page
  says so.
- **Email confirmation,** when `requireEmailVerification` is on, with a
  resend control.
- **A step for required profile fields,** when your profile schema has
  required fields the user may answer.
- **Two-factor setup** before the dashboard, when `mfa` is `required`.
- Security, profile, licences, organization and devices pages. See
  [portal.md](portal.md#what-end-users-can-do) for each.

**What to check before you upgrade:**

- **Sign-up.** If customers should not create accounts in the portal, set
  `signupMode` to `invite_only` (nobody signs up) or `secret_only` (only your
  server creates users) in Panel, Application, Authentication.
- **Social sign-in.** The portal offers no provider until you turn it on for
  that provider. Register `https://portal.acme.example/acme/oauth/callback`
  (your `PUBLIC_PORTAL_URL`, the slug, then `/oauth/callback`) as a redirect
  URI in the provider's console, then tick **Offer in the hosted portal** on
  the provider in Panel, Application, Authentication, Sign-in providers, or
  send `hostedPortal: true` to
  `PUT /api/v1/tenant/applications/:id/oauth-config/:provider`. A GitHub
  OAuth App takes one callback URL, so an app that already calls back to your
  own site cannot also serve the portal.
- **Reset emails the portal sent before the upgrade** point at the old reset
  page, which now asks for a new link. Customers request another.
- **Brand colours must be 3 or 6 digit hex,** such as `#0a7` or `#00aa77`.
  `rgb()`, `hsl()`, named colours, 8-digit hex and `transparent` fall back to
  the default, as does a colour that would leave the text unreadable.
- **Emailed links now default to the portal.** With the portal on and no App
  URL to link to (no `appUrl`, no redirect URL, and no `DEFAULT_APP_URL`),
  verification, reset, sign-in, email change and invitation emails link to
  the portal. Before, they had no link. If your app has its own pages for
  these, set `appUrl`.

## Device-bound applications

An Application with `deviceBinding: 'required'` signs users in per machine,
and its customers could not sign in to the portal at all. In 2.4.0 the
portal signs them in with a **portal session**:

- It holds no device and no `max_devices` slot.
- The API honours it only on requests that carry `INTERNAL_CALLER_SECRET`, so
  it works only inside the portal. Without the secret, portal sign-in is
  refused as before. See [`INTERNAL_CALLER_SECRET`](#internal_caller_secret).
- It cannot approve another app. See
  [OIDC provider and MCP server applications](#oidc-provider-and-mcp-server-applications).

The portal's devices page, `https://portal.acme.example/acme/devices`, lists
the customer's devices and lets them remove one, which signs it out and frees
its slot. A desktop app that hits the device limit can open that address. A
signed-out visit goes to sign-in and comes back to the page. When the
Application sets `deviceRelease: 'server_only'`, removal is refused, so do not
send customers there.

```ts
import { RekeyError } from '@rekey.dev/react';

declare function openInBrowser(url: string): void;

const DEVICES_PAGE = 'https://portal.acme.example/acme/devices';

export async function signInOnThisMachine(email: string, password: string, fingerprint: string) {
  try {
    return await client.signIn({ email, password, device: { fingerprint, label: 'Work laptop' } });
  } catch (err) {
    if (err instanceof RekeyError && err.code === 'DEVICE_LIMIT_REACHED' && err.details?.['selfRelease'] !== false) {
      openInBrowser(DEVICES_PAGE);
    }
    throw err;
  }
}
```

## OIDC provider and MCP server applications

An Application with `oidcEnabled` or `mcpEnabled` that has the portal on and
no `hostedAuthorizeUrl` now sends the browser to the portal for
authorization, at `https://portal.acme.example/acme/authorize?request=<id>`,
instead of the API's built-in password page.

The end user signs in with whatever the portal offers (password,
emailed link, social sign-in, the two-factor step, required setup, email
confirmation), then sees a consent page with your Application's name, the
client's name, where the answer will be sent and what each scope allows.
Consent is asked every time. A desktop or command-line client gets a page that
says they can return to the app.

To keep your own page, set `authConfig.hostedAuthorizeUrl` to it. That
setting takes precedence over the portal.

A publishable key on
`POST /api/v1/mcp/:slug/oauth/authorize/preview` or `/grant` now answers
`403 SESSION_HANDOFF_FORBIDDEN` instead of a 401. Only the portal's server,
which also sends the caller secret, may use a publishable key there. Call
these from your server with the secret key.

A device-bound Application cannot approve from the portal. The portal
session holds no device, so preview and grant answer
`403 AUTHORIZATION_NEEDS_DEVICE_SESSION`, and the portal tells the user to
sign in from the app itself. If a device-bound Application acts as a provider,
keep `hostedAuthorizeUrl` set to a page your server backs.

## API and SDK changes that need code changes

### Organization invitations are emailed

`POST /api/v1/users/me/organizations/:id/invitations` and the new resend route
now email the invited address a link in your Application's branding. The
response gains `emailSent`. If your app mailed the link itself, the invitee
now gets two emails. Either stop mailing it, or keep your own email and switch
off the **Organization invitation** email on the Application's Email page in
the panel.

The link goes to `inviteUrl` when you send one (with `{token}` where the token
goes, on an origin the Application registered), else your App URL's
`/accept-invitation` page, else the portal. `emailSent` is false when there is
no page to link to, the email is switched off, or the address has reached its
email cap. Share the link yourself in that case.

```ts
export async function inviteTeammate(accessToken: string, organizationId: string, email: string) {
  // 2.3: create the invitation, then mail `token` yourself.
  const { emailSent, token } = await rekey.organizations.invite(accessToken, organizationId, {
    email,
    inviteUrl: 'https://app.acme.example/join?token={token}',
  });
  if (!emailSent) show(`Send this link yourself: https://app.acme.example/join?token=${token}`);
}
```

### The plan list

`GET /api/v1/billing/plans` gains `defaultPlanSlug`: the free plan
`POST /billing/subscribe` activates, or `null` when there is none.
`billing.getPlans` in `@rekey.dev/node` and `getPlans` in `@rekey.dev/react`
now return `PublicPlanPage` (`Paged<PublicPlanDto>` plus `defaultPlanSlug`).
Code that reads the result keeps compiling. A fake or wrapper that returns the
old type does not.

```ts
import type { PublicPlanPage } from '@rekey.dev/node';

// 2.3: const fake: Paged<PublicPlanDto> = { items: [], page };
export const emptyPlans: PublicPlanPage = {
  items: [],
  page: { total: 0, limit: 50, offset: 0, hasMore: false },
  defaultPlanSlug: null,
};

export async function freePlanSlug(): Promise<string | null> {
  const { defaultPlanSlug } = await rekey.billing.getPlans();
  return defaultPlanSlug;
}
```

### Deleting an account with no password

From a browser, `DELETE /api/v1/users/me` on an account with no password and
no two-factor used to answer `400 STEP_UP_UNAVAILABLE`, with no way through.
It now answers `401 EMAIL_CODE_REQUIRED`. Request a code with
`POST /api/v1/auth/email-code` and `{ "purpose": "delete_account" }`, then
send it as `emailCode`. A wrong, used or expired code answers
`401 EMAIL_CODE_INVALID`. A secret-key call needs no proof, as before.

```ts
import { RekeyError } from '@rekey.dev/react';

export async function deleteMyAccount(accessToken: string, proof: { password?: string; emailCode?: string }) {
  try {
    return await client.deleteAccount(accessToken, proof);
  } catch (err) {
    // 2.3 answered STEP_UP_UNAVAILABLE here and the user was stuck.
    if (err instanceof RekeyError && err.code === 'EMAIL_CODE_REQUIRED') {
      await client.requestEmailCode(accessToken, { purpose: 'delete_account' });
      show('We emailed you a code. Enter it to delete your account.');
      return null;
    }
    throw err;
  }
}
```

### Smaller changes

| What | Before (2.3.1) | After (2.4.0) | What to do |
|---|---|---|---|
| `DELETE /api/v1/users/me/licenses/:licenseId/activations/:activationId` | Not present | Frees a licence seat. A secret key needs `billing:write`; reads under `/users/me/licenses` still need `billing:read` | Give the key `billing:write` if your server calls it. |
| `license.deactivated` webhook | `data.releasedBy` was `client` or `operator` | Also `end_user`, when the holder removed a machine | Handle the new value. |
| `GET /api/v1/auth/me`, `GET /api/v1/users/me` | No `hasPassword` | `hasPassword: boolean` on `CurrentUserDto` | Offer "change password" or "create a password" from it. A fixture typed `CurrentUserDto` needs it. |
| `GET /api/v1/auth/sessions` | No way to tell the caller's own session | `current: true` on it | Label it "This session". |
| `POST /api/v1/auth/sign-up` | No `verifyUrl` | Takes `verifyUrl` for the confirmation link | Optional. |

Every new endpoint, SDK method and error code is listed in the `## 2.4.0`
entry of [CHANGELOG.md](../CHANGELOG.md), and the codes in
[errors.md](errors.md).

## Custom domains

Optional. An Application can serve its portal on its own hostname, such as
`billing.acme.example`. Do the steps in this order, because verifying moves
every emailed link, the authorization page and checkout returns to the domain
at once.

1. **Save the hostname** in Panel, Application, Billing, Portal, Custom
   domain. It must be a bare hostname with no scheme, path or port.
2. **Point it at the portal** with a CNAME to the host of `PUBLIC_PORTAL_URL`.
3. **Route it and get a certificate.** With `docker-compose.prod.yml`, add it
   to `PORTAL_EXTRA_HOST_RULES` and restart the portal. Behind your own proxy,
   route the host to the portal, terminate TLS, and pass the host on as `Host`,
   or as `X-Forwarded-Host` with the proxy secret. Opening
   `https://billing.acme.example/` should now give an empty 404 over a valid
   certificate: the portal answers 404 until the domain is verified.
4. **Publish the TXT record** the panel shows, named
   `_rekey-portal.billing.acme.example`, with a value that starts
   `rekey-portal-verification=`.
5. **Verify** in the panel, or with
   `POST /api/v1/tenant/applications/:id/portal/domain/verify`. If the record
   has not propagated yet you get `422 PORTAL_DOMAIN_NOT_VERIFIED`; wait and
   try again.

**Lapse.** The API looks the record up again about every six hours. After
three lookups in a row find no matching record, the domain stops being
honoured, the panel shows "Verification lapsed", and an
`app.portal_domain_lapsed` security event is recorded. A lookup DNS did not
answer does not count. Publish the record again and verify to restore it.

**Removing one.** Clear the hostname in the panel. Links switch back to the
shared address at once. Then remove the host from `PORTAL_EXTRA_HOST_RULES`
and the DNS records. Clear the hostname before you give a domain up: the
record's value never changes, so whoever controls its DNS later could keep it
verified.

## Rolling back

**What is reversible.** The 2.3.1 API runs against the migrated database:

- 2.3.1's `prisma migrate deploy` accepts it. A 2.3.1 schema run against a
  database migrated to 2.4.0 reports nothing pending and the schema up to
  date. This was checked by running both against one database.
- 2.3.1 names the columns it reads, so the three new columns are ignored.
- The dropped unique index only means 2.3.1 lets two Applications save the
  same hostname, where it used to refuse the second. Nothing in 2.3.1
  verifies a hostname, so this has no effect.

The 2.3.1 API itself has not been run end to end against the migrated
schema; the points above come from reading its code. If anything looks wrong after a rollback,
restore the backup.

**What is not.**

- **Roll back the portal and the panel with the API.** The 2.4.0 portal fails
  on every page in front of a 2.3.1 API.
- **Clear custom domains first.** A domain verified under 2.4.0 stays
  verified, and 2.3.1 accepts it as one of the portal's origins, but the
  2.3.1 portal does not serve custom domains. Clear each hostname in the panel
  before you roll back.
- **Portal sessions end.** Portal sessions issued by 2.4.0 on device-bound
  Applications are a token type 2.3.1 does not know: its API refuses them and
  its refresh refuses their refresh tokens. Those customers sign in again.
- **Emailed links from 2.4.0** (sign-in, confirmation, reset, invitation)
  point at portal pages the 2.3.1 portal does not have, such as
  `/<slug>/sign-in-link` and `/<slug>/reset-password-link`. Customers request
  a new one.
- Ordinary sessions, accounts, passwords set with an emailed code and
  confirmed email changes stay valid.

To roll back with Compose, check out 2.3.1 and run
`docker compose -f docker-compose.prod.yml up -d --build`. The 2.3.1 `api`
container's migration step finds nothing to do.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Portal sign-in says the account signs in through the app installed on the computer | The Application has `deviceBinding: 'required'`, and the API refused the portal's sign-in with `DEVICE_FINGERPRINT_REQUIRED` because the request had no valid caller secret | Set the same `INTERNAL_CALLER_SECRET` on the API and the portal, restart both, and [check your setup](#check-your-setup). |
| `ORIGIN_NOT_ALLOWED` from the portal | A 2.3 portal (it sent no `Origin`), or `PORTAL_BASE_URL` and `PUBLIC_PORTAL_URL` name different origins | Deploy the 2.4.0 portal and make the two variables name the same origin. |
| `AUTH_URL_NOT_ALLOWED` on a reset or sign-in link from the portal | `PORTAL_BASE_URL` and `PUBLIC_PORTAL_URL` name different origins, or `PUBLIC_PORTAL_URL` is unset | Set both to the portal's public origin. |
| Users suddenly get `MFA_ENROLLMENT_REQUIRED` | The Application has `mfa: 'required'` and they have no authenticator; 2.4.0 enforces it on every session | Send them to setup, or relax the policy. See [Required two-factor](#required-two-factor-is-enforced-on-the-session). |
| A social sign-in button is missing in the portal | Every provider starts off in the portal | Register the portal's callback URL with the provider and tick **Offer in the hosted portal**. See [Hosted portal changes](#hosted-portal-changes). |
| `OAUTH_PROVIDER_NOT_IN_PORTAL` | The portal started a social sign-in for a provider not offered in the portal | Turn on `hostedPortal` for that provider, or ignore it if you did not mean to offer it. |
| A custom domain answers 404 | The domain is not verified, has lapsed, or the portal sees another host (a proxy rewrote `Host` and sent no proxy secret with `X-Forwarded-Host`) | Verify it in the panel. Check the proxy passes the host on. The portal caches its answer for a minute. |
| A custom domain is verified but its links are dead | Verifying moved the links before the host was routed or had a certificate | Route the host to the portal (`PORTAL_EXTRA_HOST_RULES` with Compose) and get its certificate, or clear the hostname until you have. |
| `AUTHORIZATION_NEEDS_DEVICE_SESSION` | A device-bound Application sends authorization to the portal, whose session cannot approve another app | Set `hostedAuthorizeUrl` to a page your server backs. |
| An invitee received two emails | Your app mails the invitation and 2.4.0 mails it too | Stop mailing it, or switch off the Organization invitation email. |
| Portal forms answered 500 before 2.4 | A form posted before the page had loaded its scripts | Fixed in 2.4.0. Nothing to do. |
