# Rate limits

Every Rekey API response carries `x-ratelimit-limit`, `x-ratelimit-remaining`
and `x-ratelimit-reset`. A throttled request gets `429 RATE_LIMITED` with a
`Retry-After` header and `error.retryAfterSeconds` ([errors.md](errors.md)).
Counters live in Redis, so the limits hold across API replicas.

## Who a request counts against

The deployment-wide limiter keeps one bucket per caller, picking the most
specific identity the request has proved:

| Caller | Bucket | Budget per window | Env |
| --- | --- | --- | --- |
| Secret API key (`rp_live_…` / `rp_test_…`) | per key | 30000 | `RATE_LIMIT_API_KEY_MAX` |
| Operator (panel session, operator PAT, operator MCP token) | per operator | 600 | `RATE_LIMIT_AUTHENTICATED_MAX` |
| End user with a session (`x-rekey-user-token`) | per end user | 600 | `RATE_LIMIT_AUTHENTICATED_MAX` |
| Anyone else, including publishable-key calls before sign-in | per client IP | 100 | `RATE_LIMIT_MAX` |

`GET /api/v1/auth/me` takes the user token alone and counts against that end
user, like any other session call. A backend that resolves many users' tokens
from one address shares the per-IP ceiling below between all of them; one that
calls `GET /api/v1/users/me` with its secret key instead counts against the key
and is exempt from that ceiling.

MCP token introspection (`POST /api/v1/mcp/<slug>/oauth/introspect`, what
`rekey.mcp.introspect()` calls) is an ordinary secret-key call: it counts
against the key at 30000 a minute, not against a sign-in limit, so an MCP
server that introspects on every tool call from one address is not throttled.
Without a valid secret key it counts against the caller's address at 100 a
minute. The operator twin (`POST /api/v1/tenant/mcp/oauth/introspect`) counts
against the PAT's operator at 600. Both used to share the sign-in tier's 30 a
minute per address. See [mcp.md](mcp.md#introspection-from-your-own-mcp-server)
for caching the answer.

The window is `RATE_LIMIT_WINDOW_MS` (60 seconds). The two authenticated
budgets default to the larger of their own default and `RATE_LIMIT_MAX`, so a
deployment that had raised `RATE_LIMIT_MAX` does not lose headroom on upgrade.

Two ceilings sit on top of those buckets:

| Ceiling | Budget per window | Env |
| --- | --- | --- |
| All operators and end users seen from one client IP, together (API-key traffic exempt) | 3000 | `RATE_LIMIT_AUTHENTICATED_IP_MAX` |
| Rejected credentials (any 401) from one client IP; over it, the address is refused before any credential is checked | 100 | `RATE_LIMIT_AUTH_FAILURE_MAX` (defaults to `RATE_LIMIT_MAX`) |

The first stops one address multiplying its budget by holding many accounts
(end users can sign up). The second exists because a rejected credential never
reaches the per-caller limiter at all: the auth check answers 401 first, so
garbage bearers and forged tokens were otherwise unmetered lookups. Both key on
the TRUSTED client IP (see below), so traffic that arrives through the panel or
portal counts per visitor, not per panel.

Some routes replace the global limiter with their own bucket:

| Route | Bucket | Budget |
| --- | --- | --- |
| Sign-in, operator sign-up, MFA, magic link, password reset, email verification (end user and operator) | (Application or none, email, client IP) | 10 per minute (some OAuth and MCP endpoints use 20 or 30) |
| Change password, passkey enrolment step-up (end user and operator) | (Application or none, account, client IP) | 10 per minute |
| End-user sign-up | (Application, client IP) | 10 per minute |
| The same routes, all together | per Application | 3000 (`RATE_LIMIT_AUTH_CEILING_MAX`) |
| The same routes, all together, from one client IP | per (Application, client IP) for publishable-key traffic and for secret-key traffic that sends `X-Rekey-Client-Ip`; per client IP for operator routes, which have no Application | 100 (`RATE_LIMIT_MAX`) |
| Failed end-user sign-ins and MFA codes with no client address (secret key without `X-Rekey-Client-Ip`, or an unidentified proxy); past it, only accounts that already failed this window are refused | per Application | 300 (`RATE_LIMIT_AUTH_UNATTRIBUTED_FAILURE_MAX`) |
| `POST /api/v1/tenant/auth/refresh` | per client IP | 60 (`RATE_LIMIT_REFRESH_MAX`) |
| `GET /api/v1/portal/config/:slug` | per (slug, client IP), plus a per-IP ceiling across all slugs | 30, ceiling `RATE_LIMIT_MAX` |
| `POST /api/v1/usage/record` | per API key | 30000 (`RATE_LIMIT_USAGE_MAX`, defaults to the per-key budget) |
| `POST /api/v1/licenses/verify`, `/deactivate` | (Application, client IP) | 60 per minute |

Account lockout after repeated wrong passwords (`TOO_MANY_FAILED_ATTEMPTS`) is
a separate system and is not affected by any of these settings. A wrong current
password on change-password counts toward the same lockout as a failed sign-in.

## Why these numbers

Sized so that one Application serving 50,000 daily active end users fits
inside every default without tuning. They used to be sized for 5,000 to
10,000 DAU per deployment; a load test against those saw exactly 5,999
successful requests on one key and then 429s.

**Per secret API key: 30000 per minute (500 per second).** Assume a customer
backend makes 100 API calls per daily active user per day (sign-in, refresh,
entitlement and subscription checks, usage records; generous for most apps).
At 50,000 DAU that is 5,000,000 calls a day, an average of about 3,500 a
minute. Traffic is not flat: taking the busiest hour at 3x the daily average
gives about 10,400 a minute, and allowing 1.5x again for bursts inside that
hour gives about 15,600 (260 a second). 30000 leaves roughly 2x headroom over
that burst. If your backend
calls Rekey on every page view, redo the arithmetic as DAU x page views x calls
per view, then raise `RATE_LIMIT_API_KEY_MAX` or give each service its own key
(every key has its own bucket).

**Per operator: 600 per minute.** One panel page view costs about 12 API
calls, plus up to about 22 route prefetches in a production build, so roughly
34. 600 covers about 17 page views a minute, one every 3.5 seconds for a full
minute, from a single operator. Each operator has their own bucket, so a team
does not share it.

**Per signed-in end user: 600 per minute.** A person using an app cannot come
near it; it exists to stop one runaway client loop from spending capacity that
belongs to everyone else.

**All identities from one IP: 3000 per minute.** Five full operator or end-user
budgets. An office behind one NAT address with a dozen people using the panel
or an app stays well under it; one address holding a hundred freshly signed-up
accounts does not.

**Rejected credentials, per IP: 100 per minute.** A rejected credential is
anonymous traffic, so it gets the anonymous budget. A real client produces a
handful of 401s at most (an expired token, then a refresh).

**Unauthenticated, per IP: 100 per minute.** Unchanged. These routes have no
identity to key on, so the address is all there is.

**All auth routes of one Application: 3000 per minute.** Sign-in, sign-up,
MFA, magic link, password reset and email verification together; refresh is
not one of them. Assume each daily active user makes two of these requests a
day (most days a sign-in, some days a verification, an MFA step or a reset).
At 50,000 DAU that is 100,000 a day, about 70 a minute on average, about 210
in the busiest hour and about 310 in a burst inside it. The ceiling sits about
10x above that on purpose, for the day every user signs in at once: a forced
sign-out of all sessions, with half of 50,000 users coming back inside 15
minutes, is about 1,700 a minute. This ceiling used to be `RATE_LIMIT_MAX`,
100 a minute for the whole Application, which a 50,000-DAU Application
outgrows at an ordinary peak.

**One client IP across one Application's auth routes: 100 per minute.**
Exactly what one address could do before this ceiling was split out, so
raising the Application's budget did not loosen anything for a single source.
The per-identity cap (10 per email per IP) and the account lockout are
unchanged too. Those stop a guesser working on one account; a spray of one
password across many accounts is held by this per-IP share, which is why a
backend that signs users in with a secret key should forward the visitor
address (below).

**Unattributed failed attempts, per Application: 300 per minute.** Only wrong
passwords and wrong MFA codes count, from traffic with no visitor address. A
real Application sees a few percent of its sign-ins fail; at the 310-a-minute
burst above that is about ten, so 300 is not reached by ordinary typos. Past
it, the cap refuses only repeat failures for the same account, so a spray gets
one guess per account per window while every other user signs in normally.
Refusing all unattributed sign-ins instead would let an attacker who can reach
the backend's form shut the Application's sign-in for 300 bad passwords a
minute.

### Why a public key cannot shut an Application's sign-in

The publishable key ships in browser code, so anyone can call the auth routes
as the Application. While the per-Application ceiling was 100 a minute, one
address spending 100 requests a minute on `forgot-password` with made-up
emails refused every real sign-in to that Application for the rest of the
window. The ceiling is now 3000 and one address may spend only 100 of it, so
exhausting it takes about 30 addresses the API can vouch for, sustained for
the whole window, and every one of them is also subject to the per-identity
cap, the rejected-credential block and the account lockout. The ceiling is an
aggregate guard against a distributed flood, not the brute-force defence.

### Sign-in through your backend: forward the visitor address

The per-IP share needs a visitor address, and two kinds of traffic arrive
without one: calls made with a **secret key** (they come from your backend,
one address for all of its users) and publishable-key calls through a proxy
the API cannot identify (see below). A password spray sent through your
backend's sign-in form used to be bounded only by the 3000-a-minute
Application ceiling, because the per-email cap and the account lockout do not
slow one password tried against many accounts.

- **Send the visitor address.** A secret-key call may carry the visitor's
  address in `X-Rekey-Client-Ip` (one IPv4 or IPv6 address; anything else is
  ignored). The auth routes then hold that visitor to 100 a minute
  (`RATE_LIMIT_MAX`) across the Application, exactly like browser traffic.
  The header is read only on a secret-key call, and only for this limit:
  whoever holds the secret key already speaks for the Application, so naming
  a visitor gives it nothing new. It must be the address your backend itself
  saw, or read from a proxy you run, never a value copied from a
  client-supplied `X-Forwarded-For`, or the attacker picks their own bucket.
- **Without it,** failed sign-ins and MFA codes (`INVALID_CREDENTIALS`,
  `MFA_CODE_INVALID`) from that unattributed traffic are counted per
  Application. After 300 in a window (`RATE_LIMIT_AUTH_UNATTRIBUTED_FAILURE_MAX`),
  and until the window ends, an unattributed sign-in or MFA attempt is refused
  with `RATE_LIMITED` **only for an account that has already failed one this
  window** (the email for sign-in, the pending user for MFA). Every other
  account still signs in, and sign-up, password reset, magic link,
  verification and passkey routes are never refused by this cap. A spray
  therefore gets at most one guess per account per window once the cap is
  reached, and cannot shut real users out. Successful sign-ins never count,
  the per-(Application, email) account lockout is unchanged, and traffic that
  carries a visitor address is not affected.
- **You will see it.** The first time in a window that an Application's
  unattributed failures reach the cap, the API writes one
  `auth.unattributed_failure_cap_reached` security event (in the Application's
  workspace log) and one warning log line. If you see it, your backend is not
  forwarding `X-Rekey-Client-Ip`.

Publishable-key traffic through an unidentified proxy gets the same
unattributed cap, which is one more reason `API_PROXY_SECRET` is required by
both production compose files.

### Small self-hosted boxes

The defaults are budgets per caller, not a promise of capacity, and they are
safe on a small box for three reasons. What one source may do is unchanged:
100 a minute per client IP on the auth tier and for anonymous traffic.
The per-key budget only matters to a caller holding a secret key, which the
operator issued; a box that cannot serve 500 requests a second saturates
before one key reaches it, and the budget exists to keep one key from
starving the others, not to protect the host. And password hashing, the
expensive part of the auth tier, is bounded where the cost is: at most four
argon2 hashes run at once per API process (`apps/api/src/lib/passwords.ts`)
and imported bcrypt hashes go through a two-worker pool that refuses with 503
when its queue is full. A flood from many addresses therefore slows sign-in
on a small box rather than exhausting its memory. To refuse instead, set
`RATE_LIMIT_AUTH_CEILING_MAX` to what the box can hash in a minute (for
example 600).

The API image sets `UV_THREADPOOL_SIZE=16`. libuv's threadpool runs argon2 and
also the DNS lookups for outbound webhooks, the breached-password check and
email; at the default of 4, a burst of sign-ins held every thread and outbound
calls waited behind it. Hashing keeps 4 of the 16, so its throughput and
worst-case memory (4 x 64 MiB) are what they were.

**Operator refresh, per IP: 60 per minute.** An operator access token lives 15
minutes by default, so a panel tab refreshes about four times an hour. 60 a
minute covers a whole office behind one NAT address with many tabs open, and
the route keeps its own bucket so ordinary browsing never exhausts it.

## Client IP behind a proxy

Per-IP limits are only per-client when `request.ip` is the client. The API
believes `X-Forwarded-For` in exactly two cases, and reads it from the right,
so an entry a client prepends itself is never used:

1. **From our internal callers, by address.** `TRUSTED_PROXIES` names the
   panel and portal containers, which sit at fixed addresses on a private
   `rekey-edge` network that nothing else joins (defaults `10.203.53.10` and
   `10.203.53.11` in `10.203.53.0/28`; set `REKEY_EDGE_SUBNET`,
   `REKEY_PANEL_EDGE_IP` and `REKEY_PORTAL_EDGE_IP` if that collides with a
   network on your host). They forward one visitor address that they have
   validated themselves.
2. **From our proxy, proven by a shared secret.** Traefik sends
   `API_PROXY_SECRET` as the `X-Rekey-Proxy-Secret` request header on every
   request (a header middleware on the API router in the compose files), which
   also overwrites any copy a client sent. Then the client is the
   `API_PROXY_HOPS`-th entry from the right: `1` for Traefik alone, `2` with a
   CDN such as Cloudflare in front, which is only right if Traefik is
   configured to trust the CDN's ranges
   (`entryPoints.websecure.forwardedHeaders.trustedIPs`). A chain shorter than
   that is not believed.

3. **From our panel or portal, proven by `INTERNAL_CALLER_SECRET`,** whatever
   network path the call took. They send it as `X-Rekey-Caller-Secret`
   together with `X-Rekey-Client-Ip`, the one visitor address they validated,
   and on this path the API reads ONLY that header. `X-Forwarded-For` is not
   used here: the CDN and Traefik append to it even when the caller sent
   nothing, so its entries would be the caller's own egress or the edge,
   shared by every visitor. A missing or malformed `X-Rekey-Client-Ip` means
   the caller had no visitor address, and the request is treated as shared
   (never blocked by IP). Without a valid caller secret, `X-Rekey-Client-Ip`
   is ignored and removed. This is what the split Dokploy units need: the
   hosted panel and portal call the API's public origin, so without it every
   operator and portal visitor would count as the host's outgoing address.
   Both headers are removed before anything logs or handles the request.

Everything else has its `X-Forwarded-For` discarded, and `request.ip` is the
connection's own address. That address is used to block only when it is the
client's: a direct connection with no forwarding header, or a public address
that sent a forwarding header itself. A forwarding header from a private,
loopback or link-local address without the proxy secret means a proxy the API
cannot identify, whose address everyone behind it shares, and **no per-IP limit
applies to it**, whether or not `API_PROXY_SECRET` is configured. That covers
a Traefik router that lost the secret middleware (an API domain re-added in
Dokploy's UI creates one): the slip turns per-IP blocking off instead of
refusing every request through Traefik, and the API logs a warning (at most
every ten minutes) naming the peer. The
anonymous budget, the rejected-credential block, the per-IP ceiling across
identities and the sign-up, refresh, licence and portal IP buckets are all
skipped. That traffic falls back to per-key, per-account and per-Application
limits (a publishable-key call gets a per-Application bucket at the per-key
budget), and the API logs once at boot that per-IP protection is off until
`API_PROXY_SECRET` is set. Blocking the shared address instead would let 100
garbage requests a minute from anyone refuse every end user, backend and
webhook behind the proxy.

A secret key that has verified is never refused by the rejected-credential
block: the API remembers a digest of keys that verified recently (24 hours)
and lets them past a blocked address without a lookup. Anything else from a
blocked address, a forged or never-seen key included, is refused before any
lookup; a new key first used from a blocked address waits out the window.

On routes with no email or session to key on (magic-link and reset
verification, MFA verification, OAuth token and registration) the tight auth
bucket is per (Application, client IP) for an address that is the client's.
Behind a proxy we cannot identify, that bucket would be one bucket for
everyone, so it is skipped and the per-Application ceiling applies (its
per-client-IP share is skipped for the same reason); a route
that names an email keeps a per-(Application, email) bucket without the IP.

Forwarded host and scheme headers are discarded unless our proxy sent them,
and all of this happens before Fastify writes its first log line, so logs,
audit events and the request log all see the decided address.

`ADMIN_IP_ALLOWLIST` checks the same decided address, so it needs one that is
the caller's own. Behind a proxy the API cannot identify there is none: the
address it sees is the proxy's, shared by everyone behind it. A configured
allowlist therefore refuses that traffic outright, with
`403 ADMIN_IP_UNVERIFIABLE`, rather than matching the proxy and admitting
everyone behind it. Running an allowlist behind a proxy means setting
`API_PROXY_SECRET` (or clearing the allowlist); the API warns once at boot when
it is set and the secret is not.

Never a hop count in `TRUSTED_PROXIES` on a network other containers share.
The API sits on `dokploy-network`, which other Dokploy apps join; a hop count
believes the header from any of them, so a sibling container could reset its
own limits, write any address into audit logs, or claim an address on
`ADMIN_IP_ALLOWLIST`. A CIDR is avoided too: traffic through a published port
can arrive from a network's gateway address, which a CIDR includes. A hop
count is still accepted for a deployment where nothing else can reach the API.

What each compose file sets:

- **`docker-compose.prod.yml`** (self-host behind Traefik): the panel and
  portal by address; `API_PROXY_SECRET` required, the stack refuses to start
  without it, because public traffic through Traefik would otherwise get no
  per-IP limits; `API_PROXY_HOPS=1`.
- **`docker-compose.yml`** (local stack): the panel and portal by address; no
  proxy in front of the API, so no secret.

The portal forwards a visitor address only when a request carries
`PORTAL_PROXY_SECRET` as `X-Rekey-Proxy-Secret` (Traefik adds it on the portal
router) and `PORTAL_TRUSTED_PROXY_HOPS` says how many proxies sit in front, so
a container that reaches the portal around Traefik cannot choose the address.
It forwards exactly one address. The panel follows the same rule with
`PANEL_PROXY_SECRET`.

If you expose the panel with no proxy in front of it (for example
`BIND_ADDRESS=0.0.0.0` on `docker-compose.yml`), it forwards the address it
sees, and nothing a browser writes.
