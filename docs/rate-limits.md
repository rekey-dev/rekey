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
| Secret API key (`rp_live_…` / `rp_test_…`) | per key | 6000 | `RATE_LIMIT_API_KEY_MAX` |
| Operator (panel session, operator PAT, operator MCP token) | per operator | 600 | `RATE_LIMIT_AUTHENTICATED_MAX` |
| End user with a session (`x-rekey-user-token`) | per end user | 600 | `RATE_LIMIT_AUTHENTICATED_MAX` |
| Anyone else, including publishable-key calls before sign-in | per client IP | 100 | `RATE_LIMIT_MAX` |

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
| The same routes, all together | per Application, or per client IP where there is none (operator routes) | `RATE_LIMIT_MAX` |
| `POST /api/v1/tenant/auth/refresh` | per client IP | 60 (`RATE_LIMIT_REFRESH_MAX`) |
| `GET /api/v1/portal/config/:slug` | per (slug, client IP), plus a per-IP ceiling across all slugs | 30, ceiling `RATE_LIMIT_MAX` |
| `POST /api/v1/usage/record` | per API key | 6000 (`RATE_LIMIT_USAGE_MAX`, defaults to the per-key budget) |
| `POST /api/v1/licenses/verify`, `/deactivate` | (Application, client IP) | 60 per minute |

Account lockout after repeated wrong passwords (`TOO_MANY_FAILED_ATTEMPTS`) is
a separate system and is not affected by any of these settings. A wrong current
password on change-password counts toward the same lockout as a failed sign-in.

## Why these numbers

Sized for a deployment serving 5,000 to 10,000 daily active end users.

**Per secret API key: 6000 per minute (100 per second).** Assume a customer
backend makes 100 API calls per daily active user per day (sign-in, refresh,
entitlement and subscription checks, usage records; generous for most apps).
At 10,000 DAU that is 1,000,000 calls a day, an average of about 700 a minute.
Traffic is not flat: taking the busiest hour at 3x the daily average gives
about 2,100 a minute, and allowing 1.5x again for bursts inside that hour gives
about 3,100. 6000 leaves roughly 2x headroom over that burst. If your backend
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
everyone, so it is skipped and the per-Application ceiling applies; a route
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
