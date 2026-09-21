# `@rekey.dev/panel`

Next.js 15 admin panel for Rekey deployments.

> **For AI agents**: see [AGENTS.md](../../AGENTS.md).

## Run

```bash
REKEY_URL=http://localhost:3030 pnpm --filter @rekey.dev/panel dev
# → http://localhost:3031
```

Sign in with the deployment's `SUPER_ADMIN_KEY` (httpOnly cookie, never exposed to client JS).

## Build

```bash
pnpm --filter @rekey.dev/panel build
pnpm --filter @rekey.dev/panel start
```

## Required env

- `REKEY_URL` — base URL of the Rekey API

## Proxy env

- `PANEL_TRUSTED_PROXIES`: how many reverse proxies stand in front of the panel
  (default `0`). The panel forwards exactly one client IP to the API, which
  rate-limits operator sign-in and token refresh on it. At `0` a client-sent
  `X-Forwarded-For` is discarded and the socket address is used; set `1` behind
  one Traefik, `2` for Cloudflare in front of Traefik. Never higher than the
  real count. See `src/lib/client-ip.ts`.
- `PANEL_PROXY_SECRET`: required with `PANEL_TRUSTED_PROXIES` of 1 or more. The
  proxy sends it as `X-Rekey-Proxy-Secret` (a Traefik
  `headers.customRequestHeaders` middleware; the compose files wire it), and
  `X-Forwarded-For` is believed only on requests that carry it. Without it,
  anything reaching the panel around the proxy could pick the forwarded IP.
- `INTERNAL_CALLER_SECRET` (optional): sent on every server-side API call as
  `X-Rekey-Caller-Secret`, with the visitor's address in `X-Rekey-Client-Ip`
  when the panel validated one (omitted otherwise), so the API can believe it
  even when the call goes through its public origin. Must match the API's
  value. Server-only, never logged.

## Routes

- `/login` — paste admin key
- `/applications` — list (default landing)
- `/applications/[id]/{plans,coupons,api-keys}` — per-app inspection
- `/tenants` — tenant list

Mutations are intentionally not in v1 — operators create resources via `rekey <command>` (the CLI) or the admin API directly.

## Navigation performance

Every panel page is a dynamic server render, and most renders call the API
several times. The API rate-limits every operator on one shared budget
(`RATE_LIMIT_MAX`, see below), so on this console request volume is not a
performance nicety: too much of it is what makes a page fail.

Measured on a production build (`next build`, standalone server) against a
counting mock of the API, before and after the September 2026 change:

| | before | after |
|---|---|---|
| prefetch requests, first load of an end-user page | 21 | 0 |
| API calls, first load of `/applications` (3 apps) | 13 | 7 |
| API calls, hard load of an end-user overview | 10 | 9 (`creation-mode` cached for 5 min) |
| API calls, one save (write + landing render + post-save refresh) | 13 | 11 |
| post-save refreshes per save | 0 or 1 | exactly 1 |
| tab clicks that never committed (27 before, 36 after, headless) | 5 | 0 |

### Links do not prefetch

`src/components/Link.tsx` is the panel's only `<Link>`, and it defaults
`prefetch` to `false`. `test/request-volume.test.ts` fails if anything imports
`next/link` directly.

Next's default prefetches every link in the viewport, again on hover, and again
whenever the cache entry is older than `staleTimes.dynamic` or a refresh emptied
it. A prefetch whose target has a `loading.tsx` renders every layout between the
divergence point and that boundary, API calls included, which is why each
application card on `/applications` cost a `GET /applications/:id` before
anyone clicked it.

Instead a click fetches exactly one render, and feedback comes from two places:
the `loading.tsx` under each tab strip (end-user tabs, email sub-tabs,
`account/*`, and the application tabs), and `<LinkPending>` inside the nav
components, which dims the clicked label from the moment of the click until the
page arrives.

### `experimental.staleTimes`

```js
staleTimes: { dynamic: 30, static: 180 }
```

With prefetching off, `dynamic` now governs one thing: **a page you visited in
the last 30 seconds is reused** from the router cache, so flicking back to a tab
costs no request. That window is for changes somebody *else* made; your own
writes are covered below. Dropping it to 0 would remove the stale window (and
the need for the post-save refresh) but make every tab revisit a full render,
and revisits far outnumber saves.

`static` only applies to prefetched loading boundaries, which the panel no
longer requests. It is left at 180 so that a caller who opts one link back into
prefetching gets the old behaviour.

### Fresh after a save, without a blank page

Every panel server action ends in `redirect()`. Two things are true of that in
Next 15.5, and they pull in opposite directions:

- **Do not call `revalidatePath` or `revalidateTag` in an action that
  redirects.** It turns off the prefetch seed the redirect relies on, and the
  page renders blank for a full round-trip (vercel/next.js#73317).
- **Without it, the page you land on is fresh, but other pages may not be.**
  Next keeps the router cache from before the write, so a tab you opened in the
  last `dynamic` seconds shows its old render.

The panel closes the second gap on the client. When a render is the destination
of an action redirect (Next marks it with `x-action-redirect`), the authed
layout mounts `<RefreshAfterAction>` with a fresh id, which calls
`router.refresh()`. The rules are in `lib/refresh-once.ts`: one refresh per
action, fired even if the operator has already moved to another tab (that tab
may be a cached pre-write render), held until nothing on the page is still
loading or submitting, and retried, at most three times in all, only when Next
discarded it (a navigation or `SavedBanner`'s `replaceState` arriving first; a
refresh that commits unmounts the component). The runtime details are at the top of
`(authed)/layout.tsx`, and `test/action-landing.test.ts` fails if a Next upgrade
changes any of them.

### When the API is busy

A 429 (rate limited) or 503 (a dependency is down) is "retry shortly", and the
panel treats it that way:

- A 429 on the token refresh is **not** a sign-out. The limiter answers before
  the refresh handler runs, so the token is unspent and the session is intact.
  A 503 or any other failure on the refresh still signs out: the API commits
  the rotation before reading the user and memberships, so a 503 from those
  reads arrives with the token already spent, and replaying it would trip reuse
  detection and revoke every session the operator has. A timeout signs out for
  the same reason.
- In a render, `api()` throws a `PanelApiError` whose `digest` carries the status
  and Retry-After (`lib/api-busy.ts`). The error boundaries show "The Rekey API
  is busy, retrying in Ns" and retry on their own, never sooner than
  Retry-After, three times, then leave a button.
- Reads that fall back to an empty list on failure use `unlessBusy`, so a 429
  reaches that notice instead of rendering "no API keys" or "no plans".

### Rate limiting

These settings decide how many API calls a browsing session makes, and the API
throttles on `RATE_LIMIT_MAX` (default 100 per 60s, keyed by API key or, for
panel traffic, by the operator's IP). A panel session presents a session token
rather than an API key, so it lands in the IP bucket and one operator can spend
the whole window alone. If you make navigation chattier, check that limit moves
with it.
