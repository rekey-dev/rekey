# Changelog

Notable changes to ReliPay, covering the self-hosted stack as well as the
`@relipay/*` SDK packages. The packages share one version and release together
with the API, panel and portal.

## 1.1.0

This release is mostly the result of turning the tooling on ourselves. We ran
adversarial reviews against a running instance instead of only reading the code,
and that found things a code review had missed twice, including a shipped
account takeover. Everything below is fixed and verified.

If you self-host, read the breaking changes first. Two of them need action
before you upgrade.

### Breaking changes

**Postgres and Redis passwords are now required.** `docker-compose.yml` used to
default Postgres to the password `relipay` and publish both datastores on
`0.0.0.0`. That put a database with a known credential on the public internet
for anyone running on a VPS without a host firewall. Both now bind to
`127.0.0.1`, and `POSTGRES_PASSWORD` and `REDIS_PASSWORD` are required with no
fallback. Compose refuses to start rather than quietly using a shared password.

Upgrading an existing deployment takes one extra step, because the Postgres
image only applies `POSTGRES_PASSWORD` when it initialises an empty data
directory. Your existing volume keeps the old password, so compose will start
while the API fails to authenticate. Rotate it in place instead:

```bash
NEW_PW=$(openssl rand -hex 24)
docker compose exec postgres \
  psql -U relipay -d relipay -c "ALTER USER relipay WITH PASSWORD '$NEW_PW';"
# then put $NEW_PW in POSTGRES_PASSWORD and DATABASE_URL in .env
```

Full instructions are in DEPLOY.md.

**`X-Forwarded-For` is no longer trusted by default.** It used to be trusted
whenever `NODE_ENV=production`, from any peer, which meant a client could rotate
that header to get an unlimited number of rate limit buckets. We measured 60 out
of 60 requests bypassing the limiter that way. If you run behind a reverse
proxy, set `TRUSTED_PROXIES` to a hop count or an IP and CIDR list. If you do
not set it, `request.ip` is the real socket peer, which is what you want.

**`/health` now reports the truth.** It used to return `200 OK` while the
database was down, which is exactly wrong for the endpoint people wire into a
load balancer. Health is now split three ways. `/health/live` never touches a
dependency and is what a container healthcheck should use, because restarting
the API cannot fix a database outage. `/health/ready` checks Postgres and Redis.
`/health` is dependency aware and returns 503 naming whichever dependency is
unreachable. The healthy response still says `status: "ok"`, so existing
monitors that match on that keep working.

**Self-service auth flows now accept the publishable key.** Accepting an
invitation, enrolling MFA, linking an OAuth provider, changing a password and
validating a coupon used to require a secret key, even though every one of them
already required an end user session. That made them unreachable from a browser,
so a portal could create an invitation but never accept one, and an app could
challenge a user for MFA they had no way to enroll.

The part that needs your attention: secret keys are restricted by IP allowlist,
publishable keys by origin allowlist, and these are not equivalent controls.
`Origin` is a request header that any non browser client sets freely, while an
IP allowlist constrains a network position. Both treat an empty list as open. So
if you were relying on `ipAllowlist` to fence these flows to your own backend,
they are now reachable from anywhere with a leaked end user token. Passkey
enrollment deliberately stayed on secret keys only, because a passkey bypasses
the MFA challenge and enrolling one is a persistent takeover.

**Disabling MFA from a browser now requires a current code.** The endpoint used
to require nothing beyond a session. Server side callers using a secret key keep
the old behaviour, so `disableMfa(accessToken)` in `@relipay/node` is unchanged.

**Rate limit responses changed shape.** A 429 used to carry
`code: "BAD_REQUEST"` with a message telling you to check your request body,
which no client could act on. It now carries `code: "RATE_LIMITED"` and a
`retryAfterSeconds` field that agrees with the `Retry-After` header.

**Requests with the wrong content type now return 415.** Sending a form encoded
body used to produce a 400 complaining that a field was missing when you had in
fact sent it. The MCP OAuth endpoints that legitimately accept form bodies are
unaffected.

### Security fixes

**A publishable key could take over any end user account.** This is the one that
matters. The publishable key is designed to ship in browser bundles, and our own
docs said it grants nothing on its own. But when no email transport was
configured, which is the default, `forgot-password` returned the raw reset token
in the response body to any caller. Three requests took over an account: get the
token, reset the password, sign in. The same leak existed on
`magic-link/request`, where it is worse, because a magic link token is a session
and needs no password change at all.

The operator surface had the same bug with no credential required whatsoever.
`/tenant/auth/forgot-password` and `/tenant/auth/magic-link/request` are
unauthenticated by necessity, and they returned raw operator tokens, so knowing
an operator's email address was enough to take over their entire workspace.

**A failed email send handed back the token too.** A send failure was treated
identically to having no transport configured. So the moment a Resend key
expired or hit quota, every reset and magic link request started returning a
live credential into your request logs while still answering 200. Send failures
now withhold the token and record a security event you can see in the panel.

**The operator MCP introspection endpoint was unauthenticated.** It answered
token validity questions for anyone who asked, returning the operator id,
workspace id and scopes for any live token, with no rate limit. Its per
application equivalent had always required a secret key. It now requires an
operator token, is rate limited, and only answers about tokens in the caller's
own workspace.

**Pooled license keys were revealed through the URL.** The operator panel put
the raw key in a query string, which means browser history, referrer headers and
access logs. It now uses a short lived httpOnly cookie, matching how the
licenses page already worked.

**One attacker could lock out every user of an application.** Sign in rate
limiting was keyed on the API key alone, so all end users of an app shared a
single budget of ten attempts per minute. Ten failed logins a minute is ordinary
traffic for a modest user base, and an attacker who triggered them locked
everyone out for the window. Limits are now per identity, with a separate per
application ceiling so one app still cannot exhaust global capacity.

**A Redis outage took down every route.** Including `/health` and reads that
only touch Postgres. The rate limiter failed closed on a store error, which
meant a routine Redis restart was a full outage. It now fails open, and health
endpoints are exempt entirely.

**Smaller ones.** Operator branding could set a `javascript:` logo URL that
rendered in customers' browsers. Internal hostnames could leak into client HTML
through an environment variable fallback. The post login `next` parameter is now
validated as a local path across every sign in method, including passkeys,
OAuth and the MFA step, so it cannot be used as an open redirect. Token expiry
checks were inconsistent about the boundary instant and are now uniform.

### One issue we are naming rather than hiding

`POST /auth/forgot-password` does not fully hide whether an email address has an
account. The status code and response shape are constant and the timing is
padded, but the `delivered` field is `false` for an unknown address and `true`
for a known one. This endpoint accepts the publishable key, so anyone who reads
your JS bundle can use it to test whether a given address is registered.

This is long standing behaviour that the response contract exposes, and the
docblock claiming otherwise has been corrected. We did not quietly change the
field, because clients read it. `magic-link/request` has the same property, but
only under `invite_only` or `secret_only` signup: under the default `public`
mode an unknown address is auto created, so the two cases are genuinely
identical. If you need enumeration resistance today, put these endpoints behind
your own backend with a secret key and return a constant response.

### Added

**Adding a payment provider is now one directory.** It used to take changes in
roughly sixteen places across the API, shared types, the panel, the portal and
both SDKs. A provider is now a single self describing module: it declares its
credentials, how to verify its webhooks and how to translate its events, and the
registry derives the routes, validation, credential forms and SDK labels from
that. Stripe, PayPal and Razorpay all run through it, and every bespoke webhook
handler is gone. There is a guide at docs/billing-providers.md.

We deliberately did not add npm plugin loading. This code path moves money and
holds decrypted processor keys, so providers stay in tree where they get review
and test coverage. The reasoning is written up in the design doc.

**Provider discovery endpoints.** `GET /billing/providers` now includes each
provider's label, docs URL and capabilities, and there is a tenant scoped
version that returns the credential fields a provider needs so the panel can
build its own form. Credential values are never returned.

**The customer portal stopped dead ending.** It had no password recovery, no
path for accounts with two factor auth enabled, no billing history and an error
message that told people to contact support without giving them any way to do
so. All four are now handled. Operators can set a support email or URL in
branding and it appears in the portal.

**Better failure diagnostics.** Connection failures to Postgres or Redis now
return a 503 that names the subsystem instead of a generic 500 that told you to
contact support, which is unhelpful when you are the one running it. Request ids
are now UUIDs and appear on every response, so quoting one actually identifies a
request. They used to be small sequential counters that restarted from one on
every boot.

### Fixed

**`disableMfa()` would have broken on upgrade.** Adding the step up code to
`POST /auth/mfa/disable` introduced a body schema, and Fastify validates a
missing body against it, so a request with no body at all got
`400 body must be object`. That is exactly what `disableMfa(accessToken)` in
`@relipay/node` 1.0.0 sends, since it passes no body and therefore no
`Content-Type`. Every published SDK caller would have broken on upgrade. The
route now accepts the bodyless shape. We checked the other seven SDK call sites
that send no body and none of them were affected.

The operator panel and customer portal got a pass for the states people actually
hit. The portal used to show a raw framework 404 page to paying customers
whenever an app's portal was switched off, discarding the perfectly good
explanation the API was already returning. The panel sign in page told every
operator that data may be reset without notice and pointed them at Discord to
request production access, on every deployment, including production ones. That
notice is now opt in for demo instances only.

Beyond that: the password reset form had a single password field, so one typo
locked you out of the account you were recovering, and now has a confirmation
field. Pages with a missing or invalid token used to show a terse sentence
written for developers with no way forward. Around fifty hand rolled alert boxes
were replaced with one component so error and success messages are announced
correctly to screen readers. A large number of focus rings were invisible
because of a Tailwind quirk where an opacity modifier on a CSS variable silently
compiles to nothing, so keyboard users had no focus indicator at all.

Also fixed: the billing section of the navigation disappeared once billing was
disabled, which hid the switch to turn it back on. Plan prices are entered in
cents and now show a running dollar preview, because it was easy to type 50 and
create a fifty cent plan. Activity logs paginate. Container logs rotate, which
matters because a webhook worker retry loop during a Redis outage could write
enough to fill a small disk and take Postgres with it.

### Docs

The OpenAPI document at `/docs` used to declare only two credentials, a super
admin key and an application secret key, while the API actually accepts eight.
That meant the machine readable schema was wrong for most authenticated routes,
telling integrators to use a secret key where a publishable key was expected.
All 267 routes are now annotated with what they really accept, and routes that
are genuinely public say so explicitly rather than leaving it to be inferred.

`docs/auth.md` was a release behind and documented a `token` field that does not
exist, called several shipped features unbuilt, and stated that ReliPay does not
send email, which it does. The error catalogue now lists every code the API can
emit, and every code it lists is one the API actually emits.

The quickstart's headline command did not work. `docker compose up` only started
the datastores, because the API, panel and portal sit behind a compose profile.
It now says `docker compose --profile full up`.

### Internal

The test suite was throttling itself. The global rate limiter never got the test
mode escape hatch the per route limiters already had, and because every injected
request reports the same IP, one bucket counted an entire test file. Any file
over a hundred requests started failing partway through with 429s inside its
fixtures, surfacing as an unrelated assertion failure further down. Redis state
now gets cleared between tests alongside the Postgres truncate, which also
removes a source of cross file flakiness that had been blamed on transient
infrastructure.

Install:

```bash
npm install @relipay/node
```

## 1.0.0

First stable release. All `@relipay/*` packages publish under the `latest`
dist-tag. `npm install @relipay/node` (no tag) now resolves.

Since `1.0.0-rc.1`: operator MCP write/operate tools (plan entitlements,
member management, credentials, end-user + mode controls, scoped + audited),
new ReliPay brand/logo across the apps, panel MCP-consent and passkey
sign-in fixes, and marketing self-host guide + SEO updates.

Install:

```bash
npm install @relipay/node
```

## 1.0.0-rc.1

First release candidate for the 1.0 line. Published under the `beta` npm
dist-tag (pre-release) so it can be smoke-tested end-to-end before `1.0.0`
stable promotes to `latest`.

- Cut the first public release from the new OSS home, `relipay-dev/relipay`.
- No API changes versus `0.1.0-beta.4`; this is a version-line bump to exercise
  the public release pipeline (clean mirror → GitHub Release → npm publish).

Install:

```bash
npm install @relipay/node@beta
```
