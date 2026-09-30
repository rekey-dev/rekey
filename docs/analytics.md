# End-user activity

What Rekey counts about your end users, when it counts it, and what the
numbers do and do not mean.

Rekey writes activity only at a sign-in, and at most once a day on a session
refresh. It never writes on an ordinary authenticated request, so a busy app
does not turn into a write per request.

## Sign-in counters

Every end user carries three fields:

| Field | Meaning |
|---|---|
| `lastSignedInAt` | When the user last signed in with a credential. `null` if never. |
| `lastSignInVia` | How: `password`, `magic_link`, `oauth`, `passkey` or `mfa`. |
| `signInCount` | Credential sign-ins since the Application's `activityTrackedSince`. |

**What counts as a sign-in.** Anything that verifies a credential and mints a
new session: sign-up with a password, password sign-in, a magic link, OAuth, a
passkey. The same moment fires `session.created` (see [webhooks](webhooks.md)).
When the user has MFA, the password step alone does not count; the sign-in
counts once, as `mfa`, when the second factor completes.

**What does not count.** Refreshing a session, switching the active
organization, and an operator creating or importing the user. A sign-in that
fails, or whose transaction rolls back, counts nothing.

**Where to read them.**

- `GET /api/v1/users/:id` and `GET /api/v1/users?email=` (secret key), and
  `GET /api/v1/users/me` for the signed-in user.
- The operator end-user list, `GET /api/v1/tenant/applications/:id/end-users`,
  returns `lastSignedInAt` on every row and sorts by it with
  `?sort=lastSignedInAt&order=desc|asc`. Users who never signed in come last in
  both directions.
- The panel's end-user list has a **Last sign-in** column.

A sign-in does not change the user's `updatedAt`. That field is the OIDC
`updated_at` claim, which means the profile changed.

## How the account was created

Every end user created from 2.2 on carries `createdVia`:

| Value | Created by |
|---|---|
| `password` | Sign-up with a password. |
| `magic_link` | A magic link for an address with no account yet. |
| `oauth:<provider>` | The first OAuth sign-in, for example `oauth:google`. |
| `passkey` | Reserved: no route creates an account from a passkey today. |
| `operator` | An operator, from the panel or `POST /api/v1/tenant/applications/:id/end-users`. |
| `import` | `POST /api/v1/users/import`, or a billing subscription import that creates the buyer. |
| `billing` | A billing webhook for a buyer with no account. |
| `unknown` | Accounts created before the column existed. Nothing backfills it. |

It is set in the same transaction as the row, never changes afterwards, and is
not personal data, so erasure leaves it. The end-user DTO (`GET /api/v1/users/:id`),
the operator end-user list and detail, the insights endpoint and the DSAR export
return it.

## Active days

A user is **active** on a UTC day when they sign in, refresh a session, or
get or refresh a token at the Application's MCP endpoint that day. Ordinary
authenticated requests do not count: an access token lives 15 minutes, so
anyone using the app refreshes at least that often, and counting refreshes
costs one conditional write per user per day instead of one per request.

Each end user carries `lastActiveOn` (the last active UTC day, returned on
`/users/me` and `/users/:id`) and a 63-day window of active days stored beside
it. The first refresh of a day records it; every later one that day matches no
row and writes nothing.

`GET /api/v1/tenant/applications/:id/stats` derives from that window:

| Field | Meaning |
|---|---|
| `activeUsers.d1` | Users active today (UTC). |
| `activeUsers.d7` | Users active on any of the last 7 days, today included. |
| `activeUsers.d30` | Users active on any of the last 30 days, today included. |
| `activitySeries` | Active users per day for the last 30 days, oldest first. |

The numbers are cached for 60 seconds. The panel shows them on the
Application Overview as **Active users (30d)**.

The window holds 63 days, so history further back is not kept yet.

## Where they sign in from

Each session records, once, when it starts:

| Field (on the session) | Source |
|---|---|
| `clientPlatform` | The sign-in body's `client.platform` when sent, else read from the User-Agent: `web` for any browser, `ios`, `android`, `macos`, `windows` or `linux` for a native client that says so, `server` for a backend runtime, `mcp` for the MCP endpoint, else `other`. |
| `clientOs`, `clientBrowser` | Read from the User-Agent: `Windows`, `iOS`, `Android`, `macOS` or `Linux`, and `Edge`, `Opera`, `Firefox`, `Chrome` or `Safari`. Anything else is null. |
| `clientAppVersion` | The body's `client.appVersion`: 1-32 letters, digits and `_ . + -`, else 400. |
| `country` | Two letters, only when `TRUST_CF_IPCOUNTRY=true` (see below). Otherwise, and on every secret-key call (the connection is your server's), null. Never guessed. |

The User-Agent is the request's own, except when a caller that speaks for the
visitor sends `X-Rekey-Client-User-Agent`: a secret-key call (your server,
the same trust `X-Rekey-Client-Ip` gets, see [rate-limits.md](rate-limits.md)),
or the hosted portal proven by `INTERNAL_CALLER_SECRET`. From anyone else the
header is ignored. A refresh keeps the session's values.

### Country

`CF-IPCountry` is a header anyone can send, so the API records a country only
when the deployment says it can be believed:

- `TRUST_CF_IPCOUNTRY=true` on the API (default off), which asserts that the
  proxy sending `API_PROXY_SECRET` receives nothing but Cloudflare traffic:
  its origin is locked to Cloudflare's address ranges or to authenticated
  origin pulls. If anything else can reach that proxy, leave it off.
- and the request came through that proxy (`X-Rekey-Proxy-Secret`), so a hit
  on the API's origin that skips it is ignored;
- or it came from the hosted portal, proven by `INTERNAL_CALLER_SECRET`, which
  forwards its visitor's country as `X-Rekey-Client-Country` (the portal's own
  `CF-IPCountry` is its host's country, never used).

Self-hosted deployments without Cloudflare leave it off and record no
country.

The end user carries the roll-up: `lastPlatform` and `lastCountry` from the
latest sign-in (a sign-in with no country keeps the last known one), and
`platformsSeen`, every platform the user signed in from or was active on, in
the order first seen. `session.created` carries `platform` and `country`.
Erasure clears all three fields and deletes the sessions.

## Filtering the end-user list

`GET /api/v1/tenant/applications/:id/end-users` takes the same audience the
Users overview counts, so every table there has a "View all" that opens the
same people:

| Parameter | Meaning |
|---|---|
| `activeFrom`, `activeTo` | `lastActiveOn` within these UTC days. |
| `inactiveForDays=N` | Not active in the last N UTC days, today included (never-active users match). |
| `minSignIns` | `signInCount` at least this. |
| `createdFrom`, `createdTo`, `createdVia` | When and how the account was created. |
| `platform`, `country`, `lastSignInVia` | Latest values, comma lists. |
| `onboarding`, `mfa` | `pending`/`completed`/`skipped`; `true`/`false`. |
| `plan`, `org` | Need `billing:read` / `organizations:read`; an id from another Application is a 404. |

`sort=lastActiveOn` lists never-active users last in either order, and each row
now carries `lastActiveOn` (a UTC day) and `lastCountry`. The "at risk" table is
`activeFrom=<today-60>&inactiveForDays=14&minSignIns=2&sort=lastActiveOn`.

## Reporting timezone

Each Application has a `reportingTimezone`, an IANA zone name, `UTC` unless
you change it:

```bash
curl -X PATCH "$REKEY_URL/api/v1/tenant/applications/$APP_ID/settings" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  -d '{"reportingTimezone":"Asia/Kolkata"}'
```

It needs write access to the Application and the `overview:write` scope, and
the change is recorded as `app.settings_updated`.

What it changes: the days of the daily analytics rollup and the "today" the
Users overview resolves its date range against. What it does not change: the
activity bits above, which are UTC days, and so every number the live path
computes from them. Every series in the Users overview names its timezone.

A change applies to days computed after it. Days already rolled up keep the
zone they were computed in, and the Users overview never joins days from two
zones into one series: it returns them as separate segments and says where
the zone changed.

A change also rolls the Application up at once, so today in the new zone has
a value before the next hourly run. Rapid changes coalesce: per Application
at most one such run is in progress and one more waits, and the waiting one
reads whatever zone is current when it starts.

## Users overview (`GET /api/v1/tenant/applications/:id/analytics/users`)

Aggregates for the panel's Users → Overview tab, also usable from a PAT. It
returns counts, rates and dates only, never a person. It needs `overview:read`;
the plan and paying filters also need `billing:read`, the organization filter
`organizations:read`, and `profileField` `end-users:read`.

**Sections.** `sections=kpis,activity,...` picks which to compute (default:
all). Each comes back in its own envelope and succeeds or fails alone:

| `status` | Meaning |
|---|---|
| `ok` | `data`, plus `source` (`live` or `rollup`), `timezone`, `computedAt`, `cache {hit, ageSeconds, stale}`, `ignoredFilters` and `gaps`. `gaps` lists `{reason, metrics, days, fix}` for every metric the rollup returns as `null` on a day it holds: `filter_not_in_rollup` (a backfilled day keeps no per-filter activity) or `not_in_rollup`. |
| `error` | `error {code, message, fix}`, for example `ANALYTICS_TIMEOUT`. |
| `forbidden` | The caller lacks `scope` for this section. Naming the section in `sections=` turns this into a 403 instead. |
| `pending` | Another request is computing it; retry after `retryAfterSeconds`. |
| `unavailable` | `reason` and `fix`, for data Rekey does not have. |

**Range.** `range=7d|30d|90d|12m|custom` (with `from` and `to`),
`compare=prev|none`. Every number carries `{ value, previous, delta }`, where
`delta` is `value - previous` in the metric's own unit.

**Filters.** `platform`, `country`, `via` and `createdVia` (comma lists),
`onboarding`, `verified`, `mfa`, `plan`, `paying`, `org`. Platform, country
and via are the user's latest values, not each event's. An unknown parameter
is a 400, never ignored.

**Which path.** A request is answered from the daily rollup when the rollup
holds at least one day for the Application and the filters are ones it keeps:
nothing but at most one of `platform`, `country` and `via` (several values
of that one are fine). `createdVia` is answered live: the rollup keeps
sign-ups per source, not activity. Then the range resolves against today
in the Application's reporting timezone, ranges up to 366 days work, `kpis`,
`activity` and `usage` report `source: "rollup"`, and days without a row are
`null` (or, in UTC, filled from the live bits; `coverage.rollupMissingDays`
lists them). Every other request uses the
live path below and is capped at 63 days. Days counted in different zones come
back as separate `activity.data.segments`, each naming its zone, and
`coverage.timezoneNote` says where the zone changed. With a dimension filter, the rollup's own per-dimension DAU, WAU and MAU answer
the day in any zone. UTC days inside the bits' window take them from the live
bits instead; older backfilled days hold none, so those metrics are `null` and
the section's `gaps` says so. A range too long for the live path gets a 400
whose `fix` names exactly the filters to drop. `mix.liveSessions.ignoredFilters`
and `security.trendIgnoredFilters` name the filters the unfiltered snapshots
ignore. `mix.liveSessions` (sessions by platform, OS,
browser, app version) and `security.trend` (adoption per day) come from the
daily snapshots. The Overview's `/stats` sums usage from the rollup once it
holds all of the last 30 days.

**Live path.** Activity comes from the bits above, so it counts UTC days and
answers the last 63 of them: DAU exactly for 63 days, WAU for 57 and MAU for
34. Older days are `null`, never estimated, and `coverage` says where each one
starts. Sign-ins by method come from the event log for the last 7 days of the
range (`partial: true` when the range is longer).

**What each section counts.**

| Section | Population | Notes |
|---|---|---|
| `kpis` | All users (erased included) | DAU/WAU/MAU at the last day of the range, average DAU, stickiness, paying users. |
| `activity` | Users per day | DAU/WAU/MAU series, accounts created, sign-ins by method. |
| `mix` | Platform and country: users active since the range start. Latest sign-in method: users who signed in during the range. Sign-up source (`createdVia`): users created in the range. OAuth providers: linked identities now. | A breakdown is never filtered on its own dimension. Top 8 plus `other` and `unknown`. |
| `onboarding` | The cohort created in the range; `counts` covers every user now (`completed`, `skipped`, `pending`). | Funnel: created, verified, first sign-in, completed, active in the last 7 days, with skipped beside it; median seconds to complete. `profileField` (needs `end-users:read`) charts a select or boolean field's answers. |
| `retention` | Weekly cohorts of the last 8 weeks | Exact from the bits; the range does not apply. |
| `security` | All users now | Verified, MFA, passkeys, devices. Failed sign-ins and lockouts are `unavailable`: only the rate limiter holds them. |
| `billing` | Live subscriptions now; trials that ended in the range | Needs `billing:read`; `unavailable` while billing is off. Never an amount. |
| `usage` | Units per meter, last 7 days of the range | Needs `billing:read`; only `org` applies. |

**Counting.** Totals include erased users; `totalUsers.erased` says how many.
Paying users own an `ACTIVE`, `TRIALING` or `PAST_DUE` subscription.

**Cost.** Each section is cached for 60 seconds and then served stale for up
to 15 minutes while one request refreshes it; a section runs read-only with a
4 second statement budget, and at most two sections compute at once per API
process (503 `ANALYTICS_BUSY` with `Retry-After` when every section had to
wait). The route allows 120 requests a minute per operator per Application,
of which at most 30 may compute an uncached section; a cached section does not
count, so reloading the page does not use up the allowance (429 `RATE_LIMITED`
with `Retry-After` past either limit). Changing the reporting timezone computes
the new zone's today at once instead of at the next hourly run.

## Daily rollup

The activity bits forget a day after 63 days. The rollup keeps it: once an
hour, one API replica (a Redis lease plus an hour marker) recomputes
yesterday and today for every Application with users, in the Application's
reporting timezone, into two tables:

- `application_activity_days`: one row per Application per day with DAU, WAU,
  MAU, accounts created (and how many are verified), sign-ins, onboarding
  completions and skips, per-platform, per-country, per-method and per-source
  breakdowns, and units per usage meter. `timezone` says which zone the day
  was counted in; `final` is set once the day has been over for 15 minutes,
  and a final day is never rewritten.
- `application_population_snapshots`: one row per Application per day with the
  population as it stood (totals, erased, verified, MFA, passkeys, paying,
  organizations, devices, onboarding status, live sessions by platform, OS,
  browser and app version, plan distribution, and a
  platform x onboarding x verified x MFA x paying cube).

In UTC the day's DAU, WAU and MAU come from the activity bits, so a rolled-up
day equals the live one. In any other zone the bits cannot be re-cut into
local days, so a day counts the users with a session issued or refreshed
inside its local window. MCP activity has no session row and is not counted
there.

Nothing is written on the sign-in or refresh path: every figure is derived
from rows already stored. Each Application's reads run read-only with a 30
second statement budget, two Applications at a time; one failing is logged
(`analytics rollup failed for one application`) and the rest still run. Set
`ANALYTICS_ROLLUP_ENABLED=false` to turn the job off.

The job reads through two indexes on `refresh_tokens`, each created by a
migration of its own with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, so sign-ins
and refreshes keep writing while they build: `refresh_tokens_app_live_head_idx`
(live sessions by client attribute) and
`refresh_tokens_application_id_created_at_idx` (sessions per local day). A
concurrent build that is interrupted leaves an INVALID index that
`IF NOT EXISTS` would then skip. Check with
`SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT indisvalid;`,
and recover with `DROP INDEX CONCURRENTLY IF EXISTS "<name>";` followed by
`prisma migrate resolve --rolled-back <migration>` and another
`prisma migrate deploy`.

Usage is the one figure a final day may still change: meters can report
`occurredAt` in the past, so every run re-sums units per meter for the rolled-up
days of the last 45 days and rewrites the days whose totals moved.

### Backfilling the rollup

The rollup starts on the day you deploy it. Fill the days before once:

```bash
# the published image
docker compose exec api node apps/api/dist/scripts/backfill-analytics-rollup.js
# a checkout
pnpm --filter @rekey.dev/api backfill:analytics-rollup
```

Every backfilled day is a UTC day (`timezone: 'UTC'`, `source: 'backfill'`),
whatever the Application's reporting timezone, because the activity bits are
UTC. What it can fill: DAU for the last 63 days, WAU for 57 and MAU for 34
(older days keep them null); accounts created with their platform, country
and sign-up source for 366 days; sign-ins by method for as far back as
`security_events` still holds (`LOG_RETENTION_DAYS`); onboarding completions
and skips; usage per meter. Population snapshots cannot be rebuilt for past
days. It never writes yesterday or today (the job owns them) and never
touches a day that already has a row, so a re-run does nothing. Each
Application runs read-only with a 120 second statement budget; one that fails is
logged (`<id>: failed, skipped (...)`), the rest still run, and the script exits
non-zero so a re-run picks it up.

## End-user IP addresses

Sessions and devices carry the address an end user's request came from, and
impersonation audits the address the impersonating operator came from. OWNER
and ADMIN operators whose credential holds `activity:read` see them in full,
as the workspace security log already requires. Everyone else gets the
network only: IPv4 masked to `/24` (`203.0.113.0/24`), IPv6 to `/48` in
canonical form (`2001:db8:1234::/48`, `::/48`). That covers grant holders,
restricted members, and an OWNER or ADMIN using a PAT or MCP token that does
not carry `activity:read` (a `keys:mint`-only PAT, for example). The operator
MCP device tools follow the same rule.

A secret key reads what whoever minted it could read at mint time: a key
minted by an OWNER or ADMIN holding `activity:read` (or with the super-admin
key) gets addresses in full on `GET /api/v1/devices` and `POST
/api/v1/devices/:id/release`; a key minted by anyone else gets them masked. The
choice is stored on the key (`revealsEndUserIps`), so later role changes do
not alter an existing key. Keys minted before 2.2 have no record and keep
reading addresses in full; to mask them, mint a replacement as a member and
revoke the old key.

The DSAR export and the request log are already limited to OWNER and ADMIN
and return addresses in full.

## In the panel

An end user's **Overview** shows it all in one place: last and first sign-in
(with the method, browser and country), onboarding progress, a row of
engagement tiles (sign-ins since tracking began, active days with a nine-week
grid of the whole 63-day window, from `activity.last63`, platforms, security
factors), their onboarding answers, and the five
newest places they sign in from. The data comes from
`GET /api/v1/tenant/applications/:id/end-users/:euid/insights` (`end-users:read`),
which returns the same numbers for your own tooling. The end-user list shows
**Last sign-in** and **Platform** columns, plus any profile field marked
`showInList`.

**Users > Overview** (`/applications/:id/users`, needs `overview:read`) is the
aggregate view: total, new, daily, weekly and monthly active and paying users
with a change against the previous period, active users over time, sign-ins by
method and accounts created. Its filters live in the URL (`range`, `compare`,
`platform`, `country`, `via`, `createdVia`, `onboarding`, `verified`, `mfa`, and `plan`,
`paying` and `org` for callers with billing or organizations read access), so
a view can be bookmarked or shared; an unknown parameter is dropped with a
note. Onboarding, verified, MFA, plan, paying and organization filters, or two
of platform, country, method and sign-up source together, read live data and
so cover at most 63 days; a longer range shows the API's refusal with a link to
the last 30 days under the same filters. Every axis names the
timezone its days were counted in. The reporting timezone is set on the
Settings tab (`PATCH /api/v1/tenant/applications/:id/settings`, write access
with `overview:write`). The page reads
`GET /api/v1/tenant/applications/:id/analytics/users` twice, the top of the
page first, and hides the tab against an API that does not serve it yet.

## Since when

`signInCount` and the active-day window are not lifetime numbers for users who
existed before they shipped. Each Application records `activityTrackedSince`: the deploy that added
the counters for older Applications, and creation time for new ones. Read
`signInCount` as "sign-ins since that date".

### Backfilling the last sign-in after upgrading

The upgrade does not fill `lastSignedInAt` for existing users; a script does,
from the newest `user.signed_in` security event still stored. Run it once after
the deploy:

```bash
# the published image
docker compose exec api node apps/api/dist/scripts/backfill-last-sign-in.js
# a checkout
pnpm --filter @rekey.dev/api backfill:last-sign-in
```

It walks users 5,000 at a time, one short statement per batch, and only
touches users who have no `lastSignedInAt`, so it never overwrites a sign-in
recorded since the deploy, can be stopped and re-run, and a second run changes
nothing. Until it runs, older users show "Never" in the Last sign-in column.
When `LOG_RETENTION_DAYS` has pruned a user's events, their `lastSignedInAt`
stays `null` and fills in on their next sign-in.
