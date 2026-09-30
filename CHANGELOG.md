# Changelog

Notable changes to Rekey, covering the self-hosted stack as well as the
`@rekey.dev/*` SDK packages. The packages share one version and release together
with the API, panel and portal.

## 2.2.0-rc.5

A release candidate on the 2.2.0 line. It adds contact lists (waitlists,
newsletters and contact forms, with consent proof, erasure and an export for
your email tool), end-user profile questions with onboarding completion and
skip, sign-in and activity tracking per end user, a Users overview with
analytics kept in a daily rollup, and a ban that shuts one person out of an
Application. End-user IP addresses are masked for callers below OWNER and
ADMIN. It fixes billing regressions found in
pre-release testing, makes portal password resets work, and keeps MFA
challenge tokens out of URLs in the panel and the portal.

**Upgrading an existing deployment:** twenty-one migrations run on boot, all
additive for existing data; two of them build indexes on `refresh_tokens`
concurrently. `docker-compose.prod.yml` now refuses to start without
`INTERNAL_CALLER_SECRET` in `.env`. After the API is live, run the
analytics rollup backfill soon and the last-sign-in backfill once. See **Upgrade notes** at the end of this section.

### Changed

Every item here changes a behaviour an existing 2.2.0-rc.4 deployment or
integration can see. Read this list before you upgrade.

- **Breaking for self-hosters on `docker-compose.prod.yml`: it requires
  `INTERNAL_CALLER_SECRET`.** The compose passes it to the `api` and `portal`
  services and fails to render without it, with a message naming the key.
  The panel already read the same `.env` key. The secret is what lets the API
  believe the visitor's browser and country that the portal forwards on a
  sign-in; without it every portal sign-in was recorded as `node`. Generate
  one with `openssl rand -hex 32`. The split Dokploy compose files already
  required it.

The next seven items are the billing fixes that were written up as the 2.2.0
release notes. They fix regressions found in pre-release testing: external
renewals on org-billed Applications, the organization free tier, usage
idempotency keys, checkout readiness evidence and refund amounts in the
portal.

- **`billing.subscribe()` can return `subscription: null`** (`@rekey.dev/node`
  and `@rekey.dev/react`; the SDK types are now `SelfSubscriptionDto | null`).
  `POST /billing/subscribe` answers `200` with `data: null` when a FEATURE or
  USAGE-only free plan is asked for an organization while the caller's one
  subscription to it is billed to another beneficiary. It used to answer with
  that other beneficiary's subscription. Row answers now carry `activated`.
- **Organizations get the free tier only when claimed.** On an Application
  that bills per organization, `POST /billing/subscribe` naming an
  organization records its claim, and the org view of entitlements then
  applies the free plan's FEATURE flags and included USAGE quantity to it (not
  its per-unit USAGE price; a priced row caps at its included quantity).
  Admins claiming one organization at once are serialised, so it gets one
  subscription row. Claims survive deletion of the claimed plan. Unclaimed
  organizations, and organizations on a per-user Application, are unchanged.
  The credit and licence variant still answers `409
  BILLING_FREE_TIER_ALREADY_CLAIMED`.
- **External billing renewals keep their organization.** A same-id
  `subscription.activated` that omits `subscriber.organizationId` on an
  org-billed Application applies to the existing subscription instead of
  failing on every retry. An event naming an unknown organization or end user
  answers `404`, an erased end user `410`, instead of `500`; a new
  subscription with no organization still answers a retryable `500`.
- **A sender `occurredAt` more than 5 minutes ahead** is ignored for dating a
  cancellation or ordering an activation, and noted on the receipt. A delayed
  older cancellation can still end a newer renewal, so send `occurredAt` on
  every event.
- **`POST /usage/record` refuses a reused `idempotencyKey`** with a different
  quantity or in another UTC month (`409 IDEMPOTENCY_KEY_REUSED`). A retry in
  the same month with a regenerated `occurredAt` still replays.
  `rekey.usage.record()` in `@rekey.dev/node` now accepts `idempotencyKey`.
- **Checkout readiness** warns when there are no paid plans to sell and when
  nothing has shown the provider credentials work (a registered plan, a
  checkout, subscription or payment through the provider, or a verified
  webhook since its secret or mode last changed). Routing and enablement edits
  no longer restart the webhook evidence window; a mode change does. Fresh
  credentials show a provider WARN until one of those happens.
- **`GET /billing/payments` items carry `refundedAmount`**, and the portal
  shows how much of a partially refunded payment came back.

Other changes:

- **Unknown API key scopes are refused.** Minting a key with a scope outside
  the known list answers `400 API_KEY_SCOPE_UNKNOWN`, with the valid scopes in
  `fix` and the rejected ones in `details.unknown`. It used to return 201 with
  a scope that matched nothing. This covers the super-admin, tenant, operator
  token and operator MCP mint paths. Stored keys are untouched.
- **Operator token mints with an unknown scope** answer
  `OPERATOR_SCOPE_UNKNOWN` with `details.unknown` and `details.valid`, instead
  of `BAD_REQUEST`.
- **Every `*` key gains `contacts:write`,** the new standard scope for list
  subscribes. It reaches only lists, and no list exists until an operator
  creates one. `contacts:read` is elevated, so no existing key gains it.
- **Token-link checks run before the account lookup** on password reset,
  magic link and verification re-send. A caller that sends a disallowed
  `resetUrl`, `signInUrl` or `verifyUrl` for an unknown address now gets `400
  AUTH_URL_NOT_ALLOWED` too, where it used to get the constant 200. A token
  URL with a username or password in it
  (`https://attacker.example@app.example.com`) is refused even when its origin
  is registered.
- **A spent backup code at end-user MFA sign-in** answers
  `MFA_BACKUP_CODE_USED`, so the user is told the code was already used. It
  still counts toward the MFA lockout. Step-up, disable and operator sign-in
  keep their existing answers.
- **Custom template previews validate `variables`.** A preview override with
  a bad value, such as a `javascript:` URL, answers `400
  EMAIL_VARIABLES_INVALID`, using the send rules minus `required`.
- **Operator sign-up without a workspace name** answers
  `WORKSPACE_NAME_REQUIRED` instead of `BAD_REQUEST`. The name is optional
  when signing up with a workspace-bound invite key.
- **Portal MFA moves to a cookie.** The code step is `?step=mfa` and reads
  the challenge from the httpOnly `rekey_portal_mfa` cookie. Old
  `/<slug>/login?mfa=...` links no longer open the code step, so a user who is
  on that step during the deploy signs in again.
- **Panel MFA moves to a cookie.** `/mfa-verify` reads the challenge from
  `rk_mfa_challenge`; an old bookmarked `?challenge=` URL is ignored. A
  missing or expired challenge shows "Sign in again" instead of redirecting
  to `/login`.
- **The portal's `PORTAL_BASE_URL` and the API's `PUBLIC_PORTAL_URL` must
  name the same origin.** Portal password resets are refused with
  `AUTH_URL_NOT_ALLOWED` when they differ, and when the API has no
  `PUBLIC_PORTAL_URL`.
- **The API's hosted authorize page** (served when an Application has no
  `hostedAuthorizeUrl`) uses plainer scope wording, shows the host both
  buttons send you to, and says what Deny does. An unnamed client is called
  "An app" instead of "An application".
- **Session rows record the visitor, not your server.** When a secret-key
  caller sends `X-Rekey-Client-User-Agent`, that value becomes the session's
  `userAgent`, so server-side sign-ins stop showing `node` once you upgrade
  `@rekey.dev/nextjs` or use `visitorClient` in `@rekey.dev/astro`.
- **`session.created` carries `platform` and `country`,** and `user.updated`
  has a new `via` value, `server`, for secret-key profile writes.
- **`@rekey.dev/nextjs`, `@rekey.dev/astro` and `@rekey.dev/react` treat
  `END_USER_BANNED` and `END_USER_ERASED` as signed out** and clear the
  session cookies, instead of throwing on every page until the token expires.
- **Billing `fix` strings name the new panel paths.** They point at Billing,
  Setup, Providers (`/applications/:id/billing/providers`), Setup, Status and
  Setup, Settings instead of the old single Billing page. If you match on
  `fix` text, update it; match on `code` instead.
- **`PLAN_SLUG_TAKEN` and `PLAN_INACTIVE`** name a failed or unfinished
  registration correctly. An unregistered plan's `PLAN_INACTIVE` fix names
  `POST .../register`.
- **Profile schema writes are versioned.** `GET
  /tenant/applications/:id/profile-schema` returns `version`; a PUT that sends
  a stale `version` answers `409 PROFILE_SCHEMA_CHANGED`. Removing a select
  option that users picked answers `409 PROFILE_OPTION_IN_USE`.
- **`PUT /admin/tenants/:id/limits`** now records a
  `workspace.limits_set_by_admin` security event with the previous and new
  limits.
- **End-user IP addresses are masked below OWNER and ADMIN.** Only OWNER
  and ADMIN operators whose credential holds `activity:read` see them in
  full. Everyone else (grant holders, restricted members, and an OWNER or
  ADMIN using a PAT or MCP token without `activity:read`) gets the network:
  IPv4 as `/24`, IPv6 as `/48` in canonical CIDR form. This covers session
  lists, impersonation audits, the device list and its block, unblock and
  release responses, and the operator MCP device tools. Secret keys record
  `revealsEndUserIps` at mint: a key minted by an OWNER or ADMIN holding
  `activity:read` (or with the super-admin key) reads full addresses on `GET
  /api/v1/devices` and `POST /api/v1/devices/:id/release`, and a key minted by
  anyone else reads them masked. Keys minted before this release have no
  record and keep reading full addresses; to mask one, mint a replacement as
  a member and revoke the old key.
- **Overview and Billing Overview numbers are cached.** `GET
  /tenant/applications/:id/stats` and `.../billing/stats` are served from a
  stale-while-revalidate cache: fresh for 60 seconds, then served stale for
  up to 15 minutes while one request refreshes them. Each computation runs
  read-only under a 4 second statement budget, and at most two dashboard
  computations run at once per API process. Under a cold burst a request can
  get `503 ANALYTICS_BUSY` with `Retry-After`, or `503 ANALYTICS_TIMEOUT`,
  instead of queueing on the database pool.
- **`get_workspace_overview` MRR is computed in SQL.** It used to load at
  most 10,000 subscriptions and counted non-recurring plans, so it could
  disagree with Billing Overview. It now counts only `SUBSCRIPTION` plans,
  yearly plans as `floor(amount / 12)`, per currency, with no cap, and matches
  Billing Overview. `activeSubscriptions` is an uncapped count.
  `list_applications` reads end-user counts and DAU and MAU from the rollup
  when it has them (`endUserCountAsOf`, `activityDay`, `activityTimezone`).
- **Panel:** Billing is split into routed Setup tabs (Status, Providers,
  Checkout page, Events, Settings); old `/billing?edit=` and `?webhook=` links
  redirect. Team has Members, Application access and Invitations tabs. Lists
  sit under a new Audience group. Users has an Onboarding tab that replaces
  Profile fields (`/profile-fields` redirects). "Usage" is labelled Meters,
  and "Force-logout all end-users" is now Sign out all end-users. Email is its
  own nav group, and a new Settings tab holds Promote, Sign out all end-users
  and Disable (`/lifecycle` redirects there). The OpenID Connect provider
  switch and "Your own sign-in page" moved to OAuth clients; Developer, Access
  is now "Allowed origins & IPs". The Applications list hides disabled
  applications until you turn on "Show disabled". Destructive actions share
  one outlined red button, settings forms save through one sticky bar, and
  wide tables scroll inside their card on a phone. The sidebar shows the
  running Rekey version.

### Added

- **Contact lists.** Collect waitlist, newsletter and contact-form sign-ups
  into lists that belong to an Application, with versioned consent text and
  consent proof (version, time, network prefix, source page).
  - Operator routes under `/api/v1/tenant/applications/:id/lists` to create,
    edit, archive and restore lists, read members and submissions,
    unsubscribe a member, and export CSV (`export.csv`, workspace OWNER or
    ADMIN only, audited). A new `audience` operator scope guards them;
    viewer and billing grants never reach contacts.
  - `GET /api/v1/lists/:key` returns a list's form, and `POST
    /api/v1/lists/:key/subscribe` takes sign-ups. A publishable key (only on
    a list with Public capture on, and only for an Application with allowed
    origins) always gets `202 { status: "received" }`. A secret key with
    `contacts:write` gets the real outcome. A browser can never re-subscribe
    someone who left, and a secret key that names a visitor
    (`X-Rekey-Client-Ip` or `X-Rekey-Relay: browser`) is treated as the
    browser it relays. Browser traffic is rate limited per visitor, per list
    and per workspace day, and fails closed.
  - `GET /api/v1/lists/:key/members` with the elevated `contacts:read`
    scope, keyset-paged with `updatedSince` for incremental sync, for your
    email tool. `GET /api/v1/lists` returns lists with counts.
    `DELETE /api/v1/lists/:key/members/:email` unsubscribes.
  - Webhooks `contact.subscribed`, `contact.submission.created` and
    `contact.unsubscribed`. Rekey sends no email from a list.
  - Erasure: erasing an end user also erases their contact in that
    Application, `DELETE /tenant/applications/:id/contacts/:contactId`
    (workspace OWNER only) erases a contact who never signed up, and an
    erased address cannot be re-captured from a browser for 30 days. DSAR
    exports gain `contacts`. Submissions older than a list's
    `submissionRetentionDays` are pruned.
  - Workspace limits `maxContacts`, `maxContactLists` and
    `contactCaptureDailyCap`, reported in both limits views.
  - SDKs and tools: `rekey.lists` in `@rekey.dev/node` (`list`, `get`,
    `subscribe`, `members`, `iterateMembers`, `unsubscribe`);
    `subscribeToList` in `@rekey.dev/nextjs/server`; `<NewsletterForm>`,
    `<ContactForm>` and `useListSubscribe` in `@rekey.dev/react`, which work
    through a Server Action with no provider; `rekey lists ls` and `rekey
    lists export --format csv|jsonl` in `@rekey.dev/cli`; operator MCP read
    tools `list_contact_lists` and `get_contact_list_stats` (counts only).
  - Panel: Audience, Lists with Members, Submissions, Settings and Embed
    tabs. See docs/lists.md.
- **Profile questions and onboarding.** Define up to 50 profile fields per
  Application (`text`, `select`, `number`, `boolean`, `url`, `date`), each
  writable by the user or only by your server.
  - `GET|PUT /tenant/applications/:id/profile-schema`, `GET
    /api/v1/profile-schema`, `PATCH /api/v1/users/me/profile`, `PATCH
    /api/v1/users/:id/profile` and the operator equivalent.
  - `POST .../onboarding/complete` (refuses with `PROFILE_INCOMPLETE` until
    every required field is answered) and `POST .../onboarding/skip`, for the
    user, your server and the operator. Rekey records what happened and never
    blocks a user; `onboardingStatus` is `pending`, `completed` or
    `skipped`.
  - Webhooks `user.onboarding_completed` and `user.onboarding_skipped`.
  - `rekey.users.updateProfile`, `completeOnboarding` and `skipOnboarding` in
    `@rekey.dev/node`; `skipOnboarding` and `completeOnboarding` on
    `RekeyBrowserClient` in `@rekey.dev/react`; `onboardingStatus()` and the
    profile types in `@rekey.dev/shared-types`. See docs/profile-fields.md.
- **Sign-in and activity per end user.** `lastSignedInAt`, `lastSignInVia`,
  `signInCount` (counted from this deploy), `lastActiveOn`, `lastPlatform`,
  `platformsSeen` and `lastCountry` on the end-user record, plus each
  session's platform, OS, browser, app version and country. Clients can say
  what they are with an optional `client: { platform, appVersion }` on
  sign-up, sign-in, MFA verify, magic-link verify, passkey complete and the
  OAuth callback. `GET /tenant/applications/:id/stats` gains `activeUsers`
  (`d1`, `d7`, `d30`) and a 30-day `activitySeries`. `GET
  .../end-users/:euid/insights` returns one user's sign-ins, active days,
  platforms, places and profile answers. The operator end-user list sorts by
  `lastSignedInAt`. `@rekey.dev/node` gains `clientUserAgent`, and
  `@rekey.dev/astro` gains `visitorClient(Astro)`. See docs/analytics.md.
- **Ban an end user.** `GET|POST
  /api/v1/tenant/applications/:id/end-users/:euid/ban` and `POST .../unban`,
  with a required reason. A ban ends every session and MCP grant, deletes
  outstanding links and codes, and answers `403 END_USER_BANNED` on every
  sign-in path, refresh and live access token, after the credential
  verifies. Licence verify answers `reason: "suspended"`. Webhooks
  `user.banned` and `user.unbanned`, a `banned` filter on the end-user list,
  and an Access tab in the panel. Subscriptions keep billing, and apps
  verifying RS256 tokens offline see the ban only when the access token
  expires. See docs/auth.md.
- **`rekey init --owner-email` hands over the workspace.** `POST
  /api/v1/admin/operator-invites` accepts `tenantId`, `email` and `role`, and
  returns `inviteUrl`. A bound invite joins its redeemer to that workspace at
  sign-up (password or OAuth) or through the panel's accept-invite page, and
  only for the bound email. `rekey init` prints the link and, under
  `--json`, `ownerInvite`. Against an older API it revokes the unbound key
  and stops with `CLI_INVITE_UNBOUND`.
- **`GET /tenant/applications/:id` returns `portalBaseUrl`,** and the panel
  Portal page warns when the API has no portal base instead of showing a
  placeholder URL as live.
- **`GET /api/v1/admin/applications/:id/plans/:slug/entitlements`,** a
  super-admin read of a plan's rows.
- **Users overview.** `GET /api/v1/tenant/applications/:id/analytics/users`
  (`overview:read`) returns counts, rates and dates, never a person, in
  sections that succeed or fail on their own: `kpis`, `activity`, `mix`,
  `onboarding`, `retention`, `security`, `billing` and `usage` (the last two
  need `billing:read`). It takes `range` (7d, 30d, 90d, 12m or custom),
  `compare` and filters for platform, country, sign-in method, sign-up source,
  onboarding, verified, MFA, plan, paying, organization and one profile
  question. Each section is cached like `/stats`. The route allows 120
  requests a minute per operator per Application, of which at most 30 may
  compute an uncached section; cache hits do not count, and the operator MCP
  tool draws on the same allowance (`429 RATE_LIMITED` with `Retry-After`
  past either). The panel's new Users, Overview tab shows it, with the
  filters in the URL, and Users, Onboarding shows completed, skipped and
  pending counts. See docs/analytics.md.
- **Daily analytics rollup.** Once an hour one API replica rolls each
  Application's yesterday and today into `application_activity_days` and a
  daily population snapshot, in the Application's reporting timezone. Once
  the rollup holds days, the Users overview answers ranges up to 366 days
  from it (unfiltered, or filtered on one of platform, country or sign-in
  method); other requests use live data and are capped at 63 days. Set
  `ANALYTICS_ROLLUP_ENABLED=false` to turn the job off.
- **Reporting timezone per Application.** `PATCH
  /api/v1/tenant/applications/:id/settings` with `{ "reportingTimezone":
  "Asia/Kolkata" }` (write access and `overview:write`) sets the zone the
  rollup counts days in; the default is `UTC`. A zone the database does not
  know, such as a legacy alias like `Asia/Calcutta`, answers `400
  REPORTING_TIMEZONE_UNSUPPORTED`; send the current name. Days already rolled
  up keep their zone, and a change rolls the Application up at once. `GET
  /tenant/applications/:id` returns `reportingTimezone`.
- **How each account was created.** End users carry `createdVia`:
  `password`, `magic_link`, `oauth:<provider>`, `operator`, `import` or
  `billing`. Accounts created before this release read `unknown`. It is on
  the end-user object, the operator list and detail, the insights endpoint
  and the DSAR export.
- **End-user list filters.** `GET /tenant/applications/:id/end-users` takes
  `activeFrom`, `activeTo`, `inactiveForDays`, `minSignIns`, `createdFrom`,
  `createdTo`, `createdVia`, `platform`, `country`, `lastSignInVia`,
  `onboarding`, `mfa`, `plan` and `org`, sorts by `lastActiveOn`, and returns
  `lastActiveOn` and `lastCountry` on each row. `plan` needs `billing:read`
  and `org` needs `organizations:read` (403 otherwise, never ignored).
- **Users analytics for agents and scripts.** Operator MCP tool
  `get_user_analytics` (`overview:read`) and `rekey analytics users --app
  <id>` in `@rekey.dev/cli`, which takes an operator token through
  `--operator-token` or `REKEY_OPERATOR_TOKEN`.
- **Applications list filters.** `GET /api/v1/tenant/applications` takes
  `status`, `environment`, `q`, `sort` (`created`, `name`, `activity`) and
  `include=summary` (active API keys and last active day, each left out when
  the caller cannot read it). With no parameters it behaves as before.

### Fixed

- **Portal password reset works.** The portal's reset link was refused on
  every portal app because the portal origin was never an allowed token-link
  destination, and the link carried no `{token}`. The app's own portal pages
  are now allowed while the portal is on (scoped to the app's slug on a
  shared host, or a verified custom domain). Nothing is written into
  `redirectUrls`. An email transport is still needed.
- **A new `pnpm dev` stack gets a working portal password reset:** the root
  `.env.example` sets `PUBLIC_PORTAL_URL`.
- **`rekey init --owner-email` left the new workspace unreachable.** The
  named owner got a second, empty workspace. See **Added**.
- **Panel selects show the saved value after a save,** and a second save no
  longer reverts an earlier select change (auth methods, team roles and
  scopes, end-user role, organization role, billing provider mode, template
  category, plan interval, audit log filter).
- **Panel:** "MFA enabled" and "MFA disabled" banners now appear; the
  member role select has an accessible name; the Account security summary
  says when the passkey read failed; the Operator MCP page takes its address
  from the API instead of showing `<set NEXT_PUBLIC_API_URL>`; the "Mint your
  first API key" step ticks when any of the three newest applications has a
  key; a damaged profile answers form reports "Nothing was saved" instead of
  a false success; list and onboarding snippets are valid, copy-paste ready
  code; copy that said failed sign-ins are not recorded, and several stale
  cross-links, are corrected. Success banners no longer vanish a moment
  after an action, and the Overview pages say "not visible to your role" or
  "could not be read" instead of showing zeros.
- **Trial eligibility on an external-only Application** no longer says the
  provider "cannot host a checkout".
- **Sign-up email rules explain apex versus subdomain.** `example.com`
  matches only that domain and `*.example.com` its subdomains; the panel
  notes an apex listed without its wildcard. Matching is unchanged.

### Security

- **End-user IP addresses are no longer readable in full by every member.**
  A member with a viewer, billing or admin grant read raw addresses from
  sessions, devices and the MCP device tools, an APP_ADMIN could mint a
  secret key to read them, and an OWNER token narrowed below `activity:read`
  still got them. All three now get the masked network (see **Changed**).
- **Dashboard reads cannot exhaust the database pool.** Analytics and
  Overview computations run read-only, under a statement budget, through a
  small per-process slot pool, and uncached computations are rate limited
  per operator.
- **An account-existence oracle on token links is closed.** A publishable
  key sending a disallowed reset, magic-link or verification URL got 400 for
  a known address and 200 for an unknown one. Both now get the same refusal.
- **Portal reset links are scoped to the app's own pages.** Every app shares
  the portal host, so the allowance is the app's `/<slug>/` path only, with
  dot segments, encoded separators, backslashes and empty segments refused
  both raw and parsed.
- **MFA challenge tokens no longer travel in URLs** in the panel (after
  password, magic link, OAuth and the Cloud handoff) or the portal. They were
  visible in access logs and browser history.
- **Token URLs with userinfo are refused,** so
  `https://attacker.example@app.example.com` cannot pass as a registered
  origin.
- **`X-Rekey-Client-User-Agent` is believed only from a secret key** or a
  proven internal caller, and a session's country only when
  `TRUST_CF_IPCOUNTRY` is on and the request came through the proven proxy or
  the portal (see **Upgrade notes**).
- **A bound operator invite is single-use, hashed and expiring,** and needs
  the bound email at sign-up and at accept.
- **Erasure** now also clears the new fields: profile answers, onboarding
  skip time, platform and country roll-ups, ban reasons, and `country` in
  stored `session.created` deliveries.

### Upgrade notes

Migrations, applied on boot or with `pnpm db:migrate:deploy`. All are
additive for existing data:

- `20260928095906_operator_invite_workspace_binding`: three nullable columns,
  a foreign key and an index on `operator_invites`.
- `20260928100124_mfa_used_backup_code_hashes`: a defaulted column on the MFA
  credential.
- `20260928102404_org_free_tier_claims` and
  `20260928114500_org_free_tier_claim_survives_plan_delete`: the
  `organization_free_tier_claims` table, its `plan_id` nullable with `ON
  DELETE SET NULL`.
- `20260928102922_billing_credentials_secrets_updated_at`: a defaulted
  `billing_credentials.secrets_updated_at`, backfilled from `updated_at`.
- `20260929022614_end_user_sign_in_counters`: sign-in columns on
  `end_users`, an index, and `applications.activity_tracked_since`, which is
  the deploy time for existing Applications.
- `20260929022615_end_user_last_sign_in_desc_index`: an index on `end_users`
  for the last-sign-in sort. It is a plain `CREATE INDEX`, so writes to
  `end_users` wait while it builds; on a very large table, plan for that.
- `20260929022650_end_user_ban`: three nullable ban columns.
- `20260929024139_end_user_daily_activity`: `last_active_on`,
  `activity_bits` and an index.
- `20260929025448_session_client_platform`: client columns on
  `refresh_tokens` and roll-up columns on `end_users`.
- `20260929030658_end_user_profile_fields` and
  `20260929030659_profile_schema_version`: `applications.profile_schema`
  (default `[]`), its version, `end_users.profile` (default `{}`) and
  `onboarding_completed_at`.
- `20260929041500_contact_lists`: five new tables for lists, consent
  versions, contacts, members and submissions.
- `20260929050545_contact_erasure_tombstones`: a new table of hashed,
  30-day erasure markers.
- `20260929211359_onboarding_skipped_at`: one nullable column.
- `20260929222101_end_user_created_via`: one nullable column, no backfill.
- `20260929223019_application_reporting_timezone`: `reporting_timezone`,
  default `UTC`.
- `20260929230642_analytics_rollups`: the `application_activity_days` and
  `application_population_snapshots` tables.
- `20260929230643_refresh_tokens_app_live_head_idx` and
  `20260929234841_refresh_tokens_app_created_at_idx`: two indexes on
  `refresh_tokens`, each in a migration of its own and built with `CREATE
  INDEX CONCURRENTLY IF NOT EXISTS`, so sign-ins and refreshes keep writing
  while they build. An interrupted build leaves an INVALID index that `IF NOT
  EXISTS` then skips. Check with `SELECT indexrelid::regclass, indisvalid
  FROM pg_index WHERE NOT indisvalid;`, and recover with `DROP INDEX
  CONCURRENTLY IF EXISTS "<name>";`, then `prisma migrate resolve
  --rolled-back <migration>` and another `prisma migrate deploy`. See
  docs/analytics.md, "Daily rollup".
- `20260930043535_api_key_reveals_end_user_ips`: one nullable column on
  `api_keys`; existing keys stay null and keep reading full addresses.

**Breaking, `docker-compose.prod.yml`:** set `INTERNAL_CALLER_SECRET` in
`.env` before you pull this release (`openssl rand -hex 32`). The same value
is used by the API, panel and portal. Without it `docker compose up` fails
on `services.api.environment.INTERNAL_CALLER_SECRET`.

**Soon after the API is live, backfill the analytics rollup:**

```bash
docker compose exec api node apps/api/dist/scripts/backfill-analytics-rollup.js
```

Do not put this off. The activity bits it reads hold 63 days, so each day
you wait loses one more day of per-day history. It writes UTC days only,
never yesterday or today, and never a day that already has a row, so a
re-run does nothing. An Application that fails is logged and skipped, and
the script exits non-zero so a re-run picks it up.

**Known limits of the Users overview.** Requests the rollup cannot answer
(filters such as verified or onboarding, or several dimensions at once) are
computed live over the whole population. With about 20 operators forcing
such computations at once on a large Application, they can take 9 to 12
seconds, or answer `503 ANALYTICS_BUSY` or a `pending` section. Repeat views
are served from the cache.

**After the API is live, backfill the last sign-in** once, on each API:

```bash
docker compose exec api node apps/api/dist/scripts/backfill-last-sign-in.js
```

It fills `lastSignedInAt` and `lastSignInVia` from each user's newest stored
`user.signed_in` event, in batches, only where they are empty. It is safe to
re-run and to stop half way. `signInCount` is not backfilled and counts from
the deploy.

**`TRUST_CF_IPCOUNTRY` is opt-in and off by default.** With it off, no
country is ever recorded. Turn it on only when the API sits behind a proxy
that sends `API_PROXY_SECRET` and that proxy receives nothing but Cloudflare
traffic (its origin locked to Cloudflare's address ranges, or authenticated
origin pulls). Anyone who can reach that proxy another way can write
`CF-IPCountry` themselves. Requests that skip the proxy are ignored either
way. The hosted portal forwards its visitor's country only when it is proven
by `INTERNAL_CALLER_SECRET`. See docs/analytics.md.

**Contact-list limits.** Workspaces have three new limit keys in
`Tenant.limits`: `maxContacts`, `maxContactLists` and
`contactCaptureDailyCap`. Absent or `null` means unlimited, so nothing
changes until you set them, with `PUT /api/v1/admin/tenants/:id/limits` or
`DEFAULT_TENANT_LIMITS` for new workspaces. On Rekey Cloud they come from the
plan entitlements `max_contacts`, `max_contact_lists` and
`contact_capture_daily_cap` (FEATURE, INT). Without rows, Free falls back to
500 contacts and 1 list and Standard to 25,000 contacts with unlimited
lists. Existing workspaces keep their limits until their next billing
webhook or `/plan-change`.

New environment variables:

- `TRUST_CF_IPCOUNTRY` (API), default off. See above.
- `ANALYTICS_ROLLUP_ENABLED` (API), default on. `false` turns the hourly
  rollup off.
- `PUBLIC_PORTAL_URL` is not new, but must now be the same origin as the
  portal's `PORTAL_BASE_URL` for portal password resets to work.
- `INTERNAL_CALLER_SECRET` is required by `docker-compose.prod.yml`.

New webhook events: `user.banned`, `user.unbanned`,
`user.onboarding_completed`, `user.onboarding_skipped`,
`contact.subscribed`, `contact.submission.created` and
`contact.unsubscribed`. New scopes: `contacts:write` (standard, in `*`),
`contacts:read` (elevated; minting it needs `audience:read` on the
Application) and the operator scope `audience`.

New error codes. The API codes are listed in docs/errors.md:

- Lists: `LIST_NOT_FOUND`, `LIST_KEY_TAKEN`, `LIST_CAPTURE_UNPROTECTED`,
  `LIST_MEMBER_NOT_FOUND`, `CONTACT_LIST_QUOTA_EXCEEDED`,
  `CONTACT_QUOTA_EXCEEDED`, `CONTACT_NOT_FOUND`, `CONTACT_CURSOR_INVALID`,
  `CONTACT_CONSENT_REQUIRED`, `CONTACT_CONSENT_STALE`,
  `CONTACT_FIELDS_INVALID`, `CONTACT_EMAIL_DOMAIN_NOT_ALLOWED`,
  `CONTACTS_RATE_LIMITED`.
- Profile: `PROFILE_SCHEMA_INVALID`, `PROFILE_SCHEMA_CHANGED`,
  `PROFILE_FIELD_KEY_IMMUTABLE`, `PROFILE_OPTION_IN_USE`,
  `PROFILE_FIELD_UNKNOWN`, `PROFILE_FIELD_READ_ONLY`,
  `PROFILE_FIELD_INVALID`, `PROFILE_TOO_LARGE`, `PROFILE_INCOMPLETE`.
- Auth and keys: `END_USER_BANNED`, `BAN_REASON_INVALID`,
  `MFA_BACKUP_CODE_USED`, `API_KEY_SCOPE_UNKNOWN`,
  `OPERATOR_INVITE_EMAIL_MISMATCH`, `OPERATOR_INVITE_TENANT_REQUIRED`,
  `OPERATOR_INVITE_EMAIL_REQUIRED`, `WORKSPACE_NAME_REQUIRED`.
- Analytics: `ANALYTICS_BUSY`, `ANALYTICS_TIMEOUT`,
  `ANALYTICS_RANGE_INVALID`, `ANALYTICS_RANGE_TOO_LONG`,
  `ANALYTICS_FILTER_UNSUPPORTED`, `REPORTING_TIMEZONE_UNSUPPORTED`.
- Thrown by the SDK and CLI themselves: `CLIENT_IP_MISSING`
  (`subscribeToList` without a visitor address), `CLI_INVITE_UNBOUND`,
  `CLI_SECRET_KEY_MISSING`, `CLI_LISTS_FORMAT_INVALID`,
  `CLI_LISTS_STATUS_INVALID`, `CLI_OPERATOR_TOKEN_MISSING`.

## 2.2.0-rc.4

A release candidate on the 2.2.0 line. It adds a Rekey-hosted checkout page
(beta, PayPal subscriptions first), custom transactional email templates sent
by key, lifecycle webhooks for sign-in, invitations and trials, and sign-up
email domain rules. The default transactional emails are redesigned and carry
the sending Application's brand. It also makes MFA codes and sign-in challenge
tokens single-use, tightens how billing webhooks apply to subscriptions and
payments, and stops `rekey --help` printing the super-admin key.

**Upgrading an existing deployment:** six migrations run on boot, all additive
(new tables, nullable or defaulted columns, one index, one backfill). Before
deploying, check your Stripe credential rows for a key whose mode contradicts
the stored mode, or every Stripe event on that Application answers 409. See
**Upgrade notes** at the end of this section.

### Changed

Every item here changes a behaviour an existing 2.2.0-rc.3 deployment or
integration can see. Read this list before you upgrade.

- **MFA codes and sign-in challenge tokens are single-use** (end-user and
  operator). A TOTP code is accepted once per factor; a code at or below the
  last accepted time step answers `MFA_CODE_REUSED` (401 at sign-in verify and
  on step-up, 422 at setup-confirm). A `mfaChallengeToken` that already
  completed a sign-in answers `401 MFA_CHALLENGE_USED`, so an integration that
  retries `mfa-verify` after a success must sign in again. Consequences a user
  will notice: the code that confirms enrolment cannot also complete the
  first sign-in, and a code used for step-up cannot be used again for another
  action in the same window. A reused code does not count toward the MFA
  lockout. Step-up routes that answered `STEP_UP_REQUIRED` or
  `MFA_CODE_INVALID` for a spent but correct code now answer
  `MFA_CODE_REUSED`; `/auth/mfa/challenge` keeps its `200 { ok: false }`.
  Replay state lives in Redis and fails closed with `503
  DEPENDENCY_UNAVAILABLE`. Challenge tokens issued before the deploy stay
  valid until they expire (5 minutes at most).

- **Checkout creation is limited for every checkout**, on the provider's page
  as well as the new Rekey page, for every provider: 10 an hour and 30 a day
  per end-user, 20 an hour per client IP (`CHECKOUT_LIMIT_PER_IP_HOUR`) and
  1000 an hour per Application (`CHECKOUT_LIMIT_PER_APP_HOUR`). Over a limit
  answers `429 CHECKOUT_RATE_LIMITED`. An unvouched client address skips the
  IP ceiling, so a backend starting checkouts for many buyers from one server
  IP is held only by the per-end-user and per-Application limits.

- **Checkout return URLs are checked.** A `successUrl` or `cancelUrl` that is
  not http(s) (`javascript:`, `data:`, `ftp:`) is refused with `400
  CHECKOUT_RETURN_URL_INVALID` before anything is created. An http(s) URL
  whose origin is not the Application's App URL, one of its redirect URLs, or
  (when enabled) its hosted portal still succeeds, and the response carries
  `warnings: [{ code: "CHECKOUT_RETURN_URL_UNREGISTERED", ... }]` plus an
  `app.checkout_return_url_unregistered` security event. A later minor release
  refuses these; register your origins now.

- **A second checkout while the first is being paid is refused.** `POST
  /billing/checkout` answers `409 CHECKOUT_PAYMENT_IN_PROGRESS` when a session
  for the same end-user and plan is confirming, or PayPal reports its
  subscription approved. A failed PayPal read answers `503
  CHECKOUT_PAYMENT_STATUS_UNAVAILABLE`.

- **Stripe Checkout no longer forces card-only.** Stripe shows Link, wallets
  and whatever the account enables. A `checkout.session.completed` with
  `payment_status: "unpaid"` activates nothing, and
  `checkout.session.async_payment_succeeded` completes it. Endpoints
  registered before this release do not receive that event, so a buyer paying
  by a delayed method stays PENDING until the endpoint is re-registered
  (Auto-configure). Newly registered Stripe endpoints are pinned to the API
  version the client uses (`2024-11-20.acacia`), and the translator reads the
  `2025-03-31.basil` shapes for period end and invoice subscription too.

- **Stripe events whose `livemode` contradicts the verifying credential's
  mode are answered `409 WEBHOOK_MODE_MISMATCH`** and not applied. They stay
  unprocessed, so Stripe retries, and a retry after the credential is fixed
  applies. A cross-Application Stripe event now answers the documented `400
  WEBHOOK_APPLICATION_MISMATCH`, not 500.

- **Billing webhooks and grants refuse a second subject on the same plan.**
  An operator or super-admin grant for a different organization (or the
  personal account) on a plan the end-user already holds answers `409
  BILLING_SUBSCRIPTION_SUBJECT_CONFLICT`, where it answered `200
  {"activated":false}`. Subscription imports report it as a per-row error. An
  external `subscription.activated` for a different subscription id and
  another subject is acknowledged with 200 but not applied, and the reason is
  on the webhook event receipt. External activations dated (`occurredAt`) at
  or before a sender-dated cancellation of the same subscription are ignored,
  and a live row's period moves only when the new `currentPeriodEnd` is at
  least 24 hours later. Senders should include `occurredAt`.

- **Refunds are accumulated.** `payment.refunded` adds to `refundedAmount` and
  sets `PARTIALLY_REFUNDED` or `REFUNDED` from the total. A refund past the
  payment (`BILLING_REFUND_EXCEEDS_PAYMENT`), in another currency, or for an
  unrecorded payment is refused and noted on the receipt. Stripe
  `charge.refunded` is now translated and subscribed on newly registered
  endpoints. Tenant billing stats and super-admin payment volume count
  `amount - refundedAmount`. The operator payments list gains
  `refundedAmount`, and its status filters (and the operator MCP
  `recent_payments`) accept `PARTIALLY_REFUNDED`.

- **The free-tier default plan must cost nothing.** Setting
  `billingConfig.defaultPlanSlug` to a plan with a nonzero `amount` or any
  `pricePerUnitCents` answers `409 BILLING_FREE_PLAN_NOT_FREE`, the code
  `POST /billing/subscribe` already used. An Application
  that already has a priced default stops granting its entitlements to
  non-subscribers and records an `app.default_plan_ignored` security event.

- **End-user subscription responses are an allowlist.** `GET
  /billing/subscription`, cancel, subscribe, checkout's `subscription` and
  `include=subscription` now return `SelfSubscriptionDto`. `metadata` keeps
  only `checkoutSessionId` and `oneTime`, and `entitlementOverrides` is
  dropped. Code that read operator notes or provenance keys through a
  publishable key or user token must move to the secret-key operator routes.
  `@rekey.dev/node` and `@rekey.dev/react` return the new type.

- **Coupons.** Creating an `AMOUNT` coupon without `currency` answers `400
  COUPON_CURRENCY_REQUIRED`, and a currency outside ISO 4217 answers `400
  COUPON_CURRENCY_INVALID`. An existing `AMOUNT` coupon with no currency is
  refused at validate and checkout with `COUPON_CURRENCY_REQUIRED`; the panel
  flags it. A checkout already open with one still records its redemption
  when paid.

- **Subscription webhooks omit `entitlements` when the grant cannot be
  resolved**, where they sent `[]`. Absent means unknown, not zero; do not
  downgrade on it. `subscription.entitlements_updated` is not sent in that
  case. Every subscription event payload now carries `trialEndsAt`.

- **Billing refusals name the right provider.** On an Application whose only
  enabled provider is inbound-only (`external`), checkout and
  `GET /billing/trial-eligibility` answer `BILLING_PROVIDER_INBOUND_ONLY`
  instead of `BILLING_CREDENTIALS_NOT_CONFIGURED`. A plan create whose
  provider registration fails now says the plan exists and names the
  `/register` route, with `details.planId`, `planSlug` and
  `registrationStatus: "FAILED"`.

- **Cancelling a checkout that was never completed by `subscriptionId`
  answers `409 SUBSCRIPTION_CHECKOUT_UNFINISHED`.**

- **`user.updated` is emitted**, and operator-created end-users emit
  `user.created`. `user.updated` fires on the self and operator end-user
  PATCH, the first email verification and a magic link that proves an
  unverified address, only when a value changed, with `data.changed` (field
  names) and `data.via`. Operator-created users emit `user.created` with
  `via: "operator"`, and password sign-up's `user.created` now carries
  `via: "password"`. Subscribers to `*` receive both.

- **Welcome email timing.** OAuth-first sign-up now sends the welcome email
  once. With `requireEmailVerification` on, an unverified sign-up gets the
  welcome after its first verification instead of at sign-up.

- **Default transactional emails are redesigned and branded.** The nine
  built-in emails use the Application's portal branding (`displayName`,
  `logoUrl`, `primaryColor`, support contact) with the Application name as the
  fallback, get a hand-built plain-text part and dark-mode styles, and
  subjects name the app ("Reset your Acme password"). The "Sent via Rekey"
  line is gone. Timestamps gain readable UTC variables (`expiresAt`,
  `changedAt`, `enabledAt`, `graceEndsAt`, `receivedAt`) beside the existing
  `*Iso` ones, and the payment-failed reminder gains `portalUrl` and an
  "Update payment method" button when the hosted portal is on. Customised
  templates are unchanged.

- **Email sender identity is separate from credentials.** Saving email
  credentials without `fromName` or `replyTo` now keeps the stored values
  instead of clearing them. On the shared pool a stored `fromName` shows as
  `<name> (via <deployment>)` and Reply-To is now sent. A `fromName` with a
  control character answers `400 EMAIL_FROM_NAME_INVALID` at write time. From
  display names are quoted per RFC 5322 on every send.

- **`requireEmailVerification` cannot be switched on without a verification
  URL.** The auth-config PATCH (and the operator MCP `update_auth_config`)
  answers `409 EMAIL_VERIFICATION_URL_REQUIRED` when the Application has no
  `appUrl`, no http(s) redirect URL and no `DEFAULT_APP_URL`.

- **`API_KEY_INVALID` and `PUBLISHABLE_KEY_INVALID` name the public API
  origin**, not an in-cluster host, and the OpenAPI `servers` entry uses it.

- **`@rekey.dev/cli`: usage errors under `--json` are JSON.** Unknown options
  and commands, and missing arguments, go to stderr as `CLI_USAGE_ERROR`, exit
  1. `--limit` (1 to 100) and `--offset` (0 or more) are checked before any
  request (`CLI_LIST_LIMIT_INVALID`, `CLI_LIST_OFFSET_INVALID`).

- **Rekey Cloud Standard includes three production applications per
  workspace;** Free keeps one.

### Added

- **Rekey checkout page (beta, PayPal subscriptions).** `POST
  /billing/checkout` can return a Rekey-hosted page on the portal
  (`/<slug>/checkout/chk_live_...`) with the Application's branding, the order
  summary, an auto-renewal disclosure and PayPal's own buttons. It is switched
  on per Application and per payment mode in Panel, Billing, Checkout page,
  with a failure behaviour of falling back to the provider's page (default)
  or refusing. The body accepts `mode: "redirect" | "embedded"`, and the
  response gains `mode` and `checkoutSessionId`. Card data stays in PayPal's
  windows, and activation stays webhook-only: a PayPal approval only moves the
  session to confirming after Rekey checks the subscription with PayPal.
  - Public routes under `/api/v1/checkout-sessions/:token` (view, status,
    fallback, `paypal/approved`) and `GET /api/v1/checkout/probe/:nonce`.
  - Tenant routes `GET`/`PATCH /tenant/applications/:id/checkout`,
    `GET .../checkout/readiness` (eight checks per mode, Test and Live) and
    `GET .../checkout/status`.
  - Kill switch `CHECKOUT_EMBEDDED_ENABLED=false` on the API.
  - Portal branding gains Terms, Privacy and Refund policy URLs, shown in the
    checkout page footer.
  - Webhook events record the mode of the credential that verified them
    (`WebhookEvent.mode`); readiness counts only live events received since
    the credentials were last saved.
  - New security events `app.checkout_embedded_fallback`,
    `app.checkout_embedded_refused`, `app.checkout_mode_mismatch`,
    `app.checkout_confirmation_refused` and `app.checkout_settings_updated`.
- **Custom transactional email templates.** Register a template in Panel,
  Email, Custom templates (draft, preview, test send to yourself, publish as
  an immutable version), then send it by key with `POST /api/v1/email/send`
  and a secret key holding the new elevated scope `email:send`. The call
  carries only `template`, `to`, `variables`, `version` and `idempotencyKey`,
  never a subject or HTML. Custom templates send only through the
  Application's own Resend or SMTP, never the shared pool. Variables are typed
  and validated, an idempotency key names one attempt, and sends are capped
  per workspace (`EMAIL_SEND_DAILY_CAP`, `EMAIL_SEND_RECIPIENT_HOURLY_CAP`,
  overridable in `Tenant.limits`). `notification` templates carry RFC 8058
  one-click unsubscribe, which stops notification mail only; password resets,
  sign-in links and `critical` templates keep arriving. The suppressions list
  shows what each entry stops. The preview returns and highlights undeclared
  variables. See docs/email-templates.md.
- **`@rekey.dev/node`: `rekey.email.send()`**, with `isEmailSendError()`,
  `emailVariableIssues()` and `EMAIL_SEND_ERROR_CODES`.
- **Email sender identity.** `PATCH
  /api/v1/tenant/applications/:id/email-sender` sets `fromName`, `replyTo` and
  `supportEmail`, and the panel's Email settings gain a Sender section.
  `supportEmail` feeds the "Need help?" footer of the default emails and is
  returned as `ApplicationDto.supportEmail`.
- **Lifecycle webhooks:** `session.created` (once per real sign-in, with
  `via` and `firstSignIn`, never on refresh or organization switch),
  `organization.invitation.created`, `organization.invitation.accepted`,
  `subscription.trial_started` and `subscription.trial_will_end` (3 days
  before `trialEndsAt`, once per trial end). Subscribers to `*` receive them.
- **`isNewUser` on the auth result**, true when the sign-in created the user
  (password sign-up, magic link, OAuth), and `SignedInSession` from
  `@rekey.dev/nextjs`'s `signIn`, `signUp` and `mfaVerify`.
- **`authConfig.welcomeEmail`**: `on_signup` (default, unchanged timing),
  `on_verified` or `off`, on the panel Auth page, the auth-config PATCH and
  the operator MCP.
- **Sign-up email domain rules**, `authConfig.signupRestrictions`:
  `allowedDomains`, `blockedDomains` (exact or `*.` subdomains) and
  `blockDisposable` (a vendored list). Self sign-up from a refused domain
  answers `403 SIGNUP_EMAIL_DOMAIN_NOT_ALLOWED`; operator create and import
  skip the rules, and existing users keep signing in. Panel: Auth, Sign-up
  email rules.
- **`GET /api/v1/auth/oauth/providers`** lists an Application's usable OAuth
  providers (id and name only) for the publishable key.
  `rekey.auth.listOAuthProviders()` in `@rekey.dev/node`; in
  `@rekey.dev/react`, `useOAuthProviders()` and `<SignIn>` / `<SignUp>` fetch
  them when given `oauthStartUrl` or `oauthStartAction`.
- **`GET /api/v1/billing/subscriptions`** returns every live subscription of
  the user or organization, and cancel accepts `subscriptionId`.
  `listSubscriptions` and the `subscriptionId` option in `@rekey.dev/node` and
  `@rekey.dev/react`. The portal lists each live subscription with its own
  Cancel button and never offers a plan the buyer already holds.
- **Operator MCP:** `list_organizations`, `add_organization_member` and
  `set_organization_member_role`, with MCP annotations on tools and the
  `fix` of every `RekeyError` returned. Member adds and role changes from the
  panel and MCP record `app.organization_member_added` and
  `app.organization_member_role_changed`.
- **`licenses.listMine` (`@rekey.dev/node`) and `listMyLicenses`
  (`@rekey.dev/react`) take `{ organizationId }`.**
- **"Secured by Rekey" attribution** for workspaces whose `Tenant.limits`
  sets `emailAttribution: true` (Rekey Cloud Free). Off everywhere else,
  including every self-hosted install.
- **Panel:** the email template editor opens uncustomised templates with the
  default loaded as editable blocks, and the API returns the default's
  `designJson`.

### Fixed

- **`npx @rekey.dev/cli` and `npx @rekey.dev/mcp` did nothing.** The entry
  check compared a symlinked bin path with the real file, so both exited 0
  without running. They now run under npx and `node_modules/.bin`.
- **Portal sign-in errors say what happened.** A locked-out or throttled
  customer is told to wait (with the minutes when known), service failures
  say the account is fine, and forgot-password no longer claims a link is on
  its way after a failed request. Error pages outside the billing dashboard
  no longer say nothing was charged.
- **A fresh clone reaches its API.** The root `.env.example` sets `REKEY_URL`
  and `PORTAL_BASE_URL`, and the panel says so when `REKEY_URL` is missing.
- **The panel login shows a message for every error code**, including
  `DEPENDENCY_UNAVAILABLE`.
- **The `SIGNUP_DISABLED` fix** names ways in that exist.
- **A pending checkout's binding window** is measured from when its session
  was opened, not from the row's last write.
- **Panel:** form rows stay aligned when a field shows a hint or an error, and
  the plan Amount hint no longer shows two amounts.
- **Documentation:** docs/portal.md describes what the portal serves, the
  forgot-password route states when a secret-key caller learns an address is
  unknown, and docs/billing.md, the SDK READMEs and CONTRIBUTING.md are
  corrected against the code.

### Security

- **`rekey --help` printed the super-admin key.** The CLI's global options
  took `SUPER_ADMIN_KEY` and `REKEY_URL` as commander defaults, which help
  prints. Anyone with the key exported who ran `--help` put it on screen and in
  any captured log. Help now reads `(env: SUPER_ADMIN_KEY)`; the values are
  read from the environment only when the flag is absent. Rotate
  `SUPER_ADMIN_KEY` if help output may have been captured.
- **MFA replay.** One TOTP code verified several times, one challenge token
  plus one code minted two sessions, and 8 concurrent requests could all spend
  one backup code. All three are closed; see **Changed**.
- **Passkey sign-in starts are rate limited** to 10 a minute per Application
  and visitor address, on the end-user and operator routes.
- **Tokens in query strings stay out of the API's logs.** Values of `code`,
  `key`, `invite` and names ending in `token`, `secret`, `password`,
  `signature`, `ticket` or `challenge` are redacted, as are checkout tokens in
  paths.
- **PayPal webhook verification uses the raw body**, not a re-serialised one.
- **SMTP connects to the address it checked**, closing a DNS rebinding gap,
  with SNI and certificate checks still on the hostname.
- **`.gitignore` covers every `.env.*`** except the examples.

### Upgrade notes

Migrations, applied on boot or with `pnpm db:migrate:deploy`:

- `20260926120000_custom_email_templates` and
  `20260926180000_email_unsubscribe_category`: new template tables, new
  `EmailLog` columns and status `pending`, `EmailSuppression.category`.
- `20260927000510_hosted_checkout_sessions`: `checkout_sessions` table and
  checkout columns on `applications` (default: provider's page).
- `20260927013324_webhook_event_mode`: nullable `webhook_events.mode`.
- `20260927135137_end_user_welcome_email_pending`: a defaulted boolean.
- `20260927141304_lifecycle_first_sign_in_and_trial_will_end`: two nullable
  columns, an index on `subscriptions (status, trial_ends_at)`, and a backfill
  that marks every existing end-user as already signed in, so none reads as a
  first sign-in.

New environment variables for the API, all optional:

- `CHECKOUT_EMBEDDED_ENABLED`, unset means on.
- `CHECKOUT_LIMIT_PER_IP_HOUR`, default `20`, and
  `CHECKOUT_LIMIT_PER_APP_HOUR`, default `1000`.
- `EMAIL_SEND_DAILY_CAP`, default `1000`, and
  `EMAIL_SEND_RECIPIENT_HOURLY_CAP`, default `10`.
- `EMAIL_UNSUBSCRIBE_SECRET` (32+ characters), `EMAIL_UNSUBSCRIBE_SECRET_ID`
  (default `k1`) and `EMAIL_UNSUBSCRIBE_PREVIOUS_SECRETS`. Unset, unsubscribe
  links are signed with a key derived from `JWT_SECRET` and stop working if it
  changes.

New error codes (each is listed in docs/errors.md):

- Checkout: `CHECKOUT_RATE_LIMITED`, `CHECKOUT_RETURN_URL_INVALID`,
  `CHECKOUT_PAYMENT_IN_PROGRESS`, `CHECKOUT_PAYMENT_STATUS_UNAVAILABLE`,
  `CHECKOUT_EMBEDDED_NOT_READY`, `CHECKOUT_READINESS_FAILED`,
  `CHECKOUT_MODE_MISMATCH`, `CHECKOUT_SESSION_NOT_FOUND`,
  `CHECKOUT_SESSION_EXPIRED`, `CHECKOUT_SESSION_COMPLETE`,
  `CHECKOUT_CONFIRMATION_REFUSED`, `CHECKOUT_CONFIRMATION_LIMIT`,
  `CHECKOUT_FALLBACK_UNAVAILABLE`, `CHECKOUT_EMBEDDED_UNSUPPORTED`; warnings
  `CHECKOUT_RETURN_URL_UNREGISTERED` and `CHECKOUT_EMBEDDED_FELL_BACK`.
- Billing: `BILLING_SUBSCRIPTION_SUBJECT_CONFLICT` (409),
  `BILLING_REFUND_EXCEEDS_PAYMENT`, `SUBSCRIPTION_CHECKOUT_UNFINISHED`,
  `COUPON_CURRENCY_REQUIRED`, `COUPON_CURRENCY_INVALID`,
  `WEBHOOK_MODE_MISMATCH`.
- Auth: `MFA_CODE_REUSED`, `MFA_CHALLENGE_USED`,
  `SIGNUP_EMAIL_DOMAIN_NOT_ALLOWED`, `EMAIL_VERIFICATION_URL_REQUIRED`.
- Email: `EMAIL_TEMPLATE_NOT_FOUND`, `EMAIL_TEMPLATE_NOT_PUBLISHED`,
  `EMAIL_TEMPLATE_INVALID`, `EMAIL_TEMPLATE_KEY_TAKEN`,
  `EMAIL_TEMPLATE_LIMIT_REACHED`, `EMAIL_VARIABLES_INVALID`,
  `EMAIL_TRANSPORT_NOT_CUSTOM`, `EMAIL_SENDER_DOMAIN_MISMATCH`,
  `EMAIL_RECIPIENT_NOT_END_USER`, `EMAIL_IDEMPOTENCY_KEY_REUSED`,
  `EMAIL_SEND_IN_FLIGHT`, `EMAIL_SEND_OUTCOME_UNKNOWN`, `EMAIL_RATE_LIMITED`,
  `EMAIL_DELIVERY_FAILED`, `EMAIL_FROM_NAME_INVALID`,
  `EMAIL_REPLY_TO_INVALID`, `EMAIL_SUPPORT_EMAIL_INVALID`.
- CLI: `CLI_USAGE_ERROR`, `CLI_LIST_LIMIT_INVALID`, `CLI_LIST_OFFSET_INVALID`.

Also:

- Before deploying, find Stripe credential rows whose key contradicts the
  stored mode (an `sk_live_` key on a `test` row, or the reverse). Older rows
  defaulted to `test`. Keys are encrypted, so compare them through
  `billingCredentialsService.loadDecryptedWithMode`, not SQL.
- Re-register Stripe webhook endpoints (Auto-configure) to receive
  `checkout.session.async_payment_succeeded` and `charge.refunded` and to pin
  the API version.
- Register every origin your checkout `successUrl` and `cancelUrl` use as the
  App URL or a redirect URL.
- A root `.env` for local development needs `REKEY_URL` and
  `PORTAL_BASE_URL`; copy them from `.env.example`.

## 2.2.0-rc.3

A release candidate on the 2.2.0 line. Most of it is about sessions: the
operator panel, the hosted portal, rekey.dev, `@rekey.dev/nextjs` and
`@rekey.dev/astro` could spend a refresh token without storing its
replacement, and the next request then replayed the spent token, which made
the API revoke every session the user had on every device. Refresh now happens
where the new cookies can be stored, the API forgives a replay that is only a
race, and a refresh that may have spent the token signs the browser out
instead of replaying it. It also isolates tenants from each other's slow
webhook receivers, resizes the rate limits for a busy Application, and closes
several open redirects.

**Upgrading an existing deployment:** one migration adds a nullable column,
`docker-compose.yml` now requires `JWT_SECRET` and `SUPER_ADMIN_KEY`, and the
default per-key rate limit goes from 6000 to 30000 a minute. See **Upgrade
notes** at the end of this section for every new environment variable and its
default.

### Breaking changes

Every item here changes a behaviour or a configuration that an existing
2.2.0-rc.2 deployment or integration can see. Read this list before you
upgrade.

- **Outbound webhook delivery is capped per endpoint and per Application.** At
  most 4 sends to one endpoint and 8 sends for one Application
  (`WEBHOOK_APP_MAX_IN_FLIGHT`) are in flight at once, across every replica.
  A send over a cap waits its turn and does not use up a retry. After 5 failed
  sends in a row an endpoint's circuit breaker opens for 60 seconds: attempts
  that come due meanwhile are recorded as failed without a request (the error
  starts `Not sent:`) and stay on the normal retry schedule. One success closes
  it. The request timeout is still 10 seconds and is now configurable with
  `WEBHOOK_TIMEOUT_MS` (1000 to 30000). Each replica runs up to 50 sends at
  once, where it ran 10. Deliveries to one endpoint can arrive slightly more
  out of order than before; order was never guaranteed.

- **An Application can register at most 100 webhook endpoints.** Creating
  another answers `400 WEBHOOK_ENDPOINT_LIMIT_REACHED`.

- **`@rekey.dev/astro`: `getSession` no longer refreshes outside
  `rekeyMiddleware`** unless you pass `{ refresh: true }`. Called from a
  component after the response had started, it rotated the token and lost the
  new cookies. With `rekeyMiddleware` installed nothing changes. Without it,
  add the middleware, or pass `{ refresh: true }` from an API endpoint or
  top-level page frontmatter; otherwise a visitor whose access token has
  expired reads as signed out.

- **`@rekey.dev/nextjs` and `@rekey.dev/astro` sign the browser out when a
  refresh may have spent the token.** The API rotates the token before the
  work that can fail, so a 5xx from the API itself (one that carries a Rekey
  error envelope), a timeout, or a connection dropped mid-request can come
  after the rotation. Both SDKs now clear the session cookies then;
  `rekeyRefreshHandler` redirects to `signInUrl?next=…&reason=session_interrupted`,
  and the Astro middleware continues signed out. The session is kept on a 429
  or any other 4xx that is not a `REFRESH_TOKEN_*` verdict, on a connection
  that was never made (DNS failure, connection refused), and on a 502, 503 or
  504 with no Rekey envelope, which is a proxy answering while the API
  restarts. The refresh route answers those with `503` and `Retry-After`.

- **A refresh token replayed moments after its rotation answers `401
  REFRESH_TOKEN_RACED` and revokes nothing.** That is two tabs or two server
  instances refreshing at once, or a retry after a lost response. It applies
  within `REFRESH_TOKEN_REUSE_WINDOW_SECONDS` (default 15, 0 turns it off)
  while the replacement is unused, to end-user and operator sessions. Nothing
  is issued to the replayer, and the replay is recorded as
  `user.refresh_token_raced` or `operator.refresh_token_raced`. A later
  replay, or one after the replacement was used, still answers
  `REFRESH_TOKEN_REUSED` and revokes every session. A client that gets
  `RACED` should use the replacement another request stored, or sign in again
  if it has none, and must never present the spent token again. Both SDKs do
  this: `rekeyRefreshHandler` redirects back to `next` with the session
  cookies untouched, and the Astro middleware sends a GET or HEAD back to its
  own URL. The same token racing a second time is treated as finished.

- **`@rekey.dev/nextjs`: `rekeyMiddleware` changes three answers.** A Server
  Action whose `Origin` is `null` or otherwise not a URL gets a `403` (Next 15
  crashed on it with a 500). Only GET and HEAD are redirected to the refresh
  route; a Server Action or other non-GET with a stale session reaches your
  code and refreshes in place through `auth()`, where it used to fail with a
  405. Its redirects carry `Cache-Control: no-store`, and the sign-in bounce
  keeps the page's query in `next`.

- **Refresh routes answer a cross-site navigation with an interstitial page
  instead of rotating.** `rekeyRefreshHandler`, the Astro middleware and the
  panel, portal and rekey.dev refresh routes rotate only when
  `Sec-Fetch-Site` is `same-origin` or `none`, or absent. Any other request,
  `same-site` included, gets a small `no-store` page that asks for the same
  URL again from this origin, with no script, no cookie and no API call.

- **`@rekey.dev/nextjs`: the access cookie's `maxAge` follows the access
  token's own lifetime**, read from its `exp` and `iat`, instead of a fixed
  default.

- **Auth and lifecycle webhooks are written in the transaction of the change
  they announce.** `user.created`, `password.changed`, `email.verified`,
  `session.revoked`, `mfa.enabled`, `mfa.disabled`, `user.deleted`,
  `user.erased`, the `device.*` events and `license.deactivated` can no longer
  be lost to a crash after the change committed. Payloads are unchanged. The
  trade: if the event cannot be written, the request now fails and the change
  does not commit, where it used to succeed and log the lost event.

- **A busy connection pool answers `503 DEPENDENCY_UNAVAILABLE`, not 500.**
  Prisma `P2024` (no pool connection in time) and `P2028` (a transaction that
  could not start or ran past its timeout) now map to 503 with `Retry-After`,
  and `details.reason` says `pool_busy` or `transaction_timeout` rather than
  claiming the database is unreachable.

- **New `503 USAGE_RECORD_BUSY` on `POST /api/v1/usage/record`.** Capped
  records now queue only behind records for the same end-user or
  organization, not every subject of the meter, and a record that waits more
  than 2 seconds for that lock is refused with this code. Nothing was
  recorded or charged, so retrying after `Retry-After` is safe.

- **Rate limits are resized for one Application at 50,000 DAU.**
  - The per-secret-key budget (`RATE_LIMIT_API_KEY_MAX`) defaults to 30000 a
    minute, was 6000. `RATE_LIMIT_USAGE_MAX` follows it.
  - The per-Application ceiling across sign-in, sign-up, MFA, magic link,
    reset and verify has its own setting, `RATE_LIMIT_AUTH_CEILING_MAX`
    (default 3000). It used `RATE_LIMIT_MAX` (100), which let one address
    using the public publishable key block an Application's sign-in.
  - One client address is still held to `RATE_LIMIT_MAX` (100 a minute) across
    an Application's auth routes, now as a per-(Application, client IP)
    bucket.
  - A secret-key caller can name the visitor in `X-Rekey-Client-Ip`, and its
    auth requests are then counted per visitor, like browser traffic. The API
    believes the header from a secret key only, and only for these limits.
  - Auth traffic with no visitor address (a secret key that does not send the
    header, or a publishable key behind a proxy the API cannot identify) gets
    a new cap, `RATE_LIMIT_AUTH_UNATTRIBUTED_FAILURE_MAX` (default 300 failed
    sign-in or MFA attempts per Application a minute). Past it, only accounts
    that already failed in the window are refused; every other account still
    signs in, and sign-up, reset, magic link, verification and passkeys are
    never refused by it. The first time an Application reaches it in a
    window, the API writes an `auth.unattributed_failure_cap_reached`
    security event.

- **MCP token introspection counts against the secret key's budget.**
  `POST /api/v1/mcp/:slug/oauth/introspect` (`rekey.mcp.introspect()`) was
  held to a 30-a-minute sign-in limit per address; it now uses the key's own
  budget (30000 a minute by default). The operator
  `POST /api/v1/tenant/mcp/oauth/introspect` counts against the token's
  operator at the authenticated limit.

- **Hosted authorize pages must ask for consent.** The rekey.dev hosted
  authorize page now shows Allow and Deny before any authorization code is
  minted. New `POST /api/v1/mcp/:slug/oauth/authorize/preview` describes an
  authorization request (client name, confirmed `redirect_uri`, scope and the
  account's email) without minting a code, for a hosted page to build its
  consent screen from. `POST /api/v1/mcp/:slug/oauth/authorize/grant` now
  returns the confirmed `redirect_uri`, and includes it in `details` on
  refusals made after it was confirmed. See docs/auth.md.

- **`GET /health/live` and `GET /health/ready` report `version` and
  `commit`.** `version` is the running release; `commit` is the
  `REKEY_COMMIT` build argument, or `unknown`.
  `scripts/check-deployed-version.sh` compares it with npm.

- **`docker-compose.yml` refuses to start without `JWT_SECRET` and
  `SUPER_ADMIN_KEY`**, and names the missing one. Their old
  `change-me-in-prod` default was too short for the API, so it only ever
  produced a crash-looping container.

- **An operator's refresh keeps the workspace they switched to** (or joined
  through an invitation), instead of moving them back to their oldest
  workspace every time the access token expired. Migration
  `20260923120000_operator_refresh_active_tenant` adds a nullable column to
  `tenant_refresh_tokens`.

- **The API image sets `UV_THREADPOOL_SIZE=16` and runs at most 4 argon2
  hashes at once.** Hashing throughput and memory are unchanged, and outbound
  DNS lookups (webhooks, breached-password checks, email) no longer queue
  behind a burst of sign-ins. A deployment that runs the API outside this
  image should set the variable itself.

### Added

- **`@rekey.dev/nextjs`: `rekeyRefreshHandler()`** on `/server`, the refresh
  route `rekeyMiddleware` redirects to. `export const GET =
  rekeyRefreshHandler();` in `app/api/rekey/refresh/route.ts` is the whole
  route. It follows `next` only to a same-origin path, and requests presenting
  the same token at the same moment share one exchange with the API.
- **`@rekey.dev/nextjs`: `rejectMalformedActionOrigin(req)`** on
  `/middleware`, for hand-written middleware that wants the same 403.
- **`@rekey.dev/nextjs`: `DEFAULT_REFRESH_PATH`** (`/api/rekey/refresh`) and
  **`DEFAULT_SIGN_IN_PATH`** (`/sign-in`).
- **`@rekey.dev/nextjs`: `signIn`, `signUp` and `mfaVerify` forward the
  visitor's address** as `X-Rekey-Client-Ip`: the
  `REKEY_TRUSTED_PROXY_HOPS`-th entry from the right of `X-Forwarded-For`
  (default 1), or `X-Real-IP`. An optional `{ clientIp }` argument overrides
  it, and `null` sends none. With nothing in front of the app, set
  `REKEY_TRUSTED_PROXY_HOPS=0`, or a visitor could pick a fresh rate-limit
  bucket per request.
- **`@rekey.dev/node`: `clientIp`**, client-wide or per call with
  `rekey.with({ clientIp })`, sent as `X-Rekey-Client-Ip` only when it is
  exactly one IPv4 or IPv6 address. `normalizeClientIp` and `CLIENT_IP_HEADER`
  are exported.
- **`@rekey.dev/shared-types/transport`**: `neverConnected` and
  `NEVER_CONNECTED_CODES`, the one list the refresh clients use to tell a
  connection that was never made from one that failed mid-request.
- **Sign-in pages explain an interrupted session.** The panel, portal and
  rekey.dev sign-in pages show one line for `reason=session_interrupted`.
- **New security events:** `user.refresh_token_raced`,
  `user.refresh_token_reused`, `operator.refresh_token_raced`,
  `operator.refresh_token_reused` and `auth.unattributed_failure_cap_reached`.

### Fixed

- **Opening two magic links for a new address at once, or double-clicking
  Accept on a workspace or organization invitation, no longer answers 500 to
  the slower request.** It signs in or joins like the first one, and a new
  user gets one welcome email.
- **A user created through an OAuth provider is written together with its
  identity**, so a failed identity insert no longer leaves a user with no way
  to sign in.
- **One slow or unresponsive webhook receiver no longer delays other
  tenants' deliveries.** A receiver that never answered held every delivery
  slot on a replica for the full timeout. See **Breaking changes** for the
  caps and the breaker that replace this.
- **An MCP server that introspects on every tool call is no longer
  throttled** after 30 calls a minute.

### Security

- **Open redirects in `next` and redirect handling.** A validator that checks
  its input and then returns the path rebuilt by the URL parser is not enough:
  the parser collapses dot segments, so `/..//evil.com` and
  `/%2e%2e//evil.com` come back as `//evil.com`, a URL on another host. Every
  validator below now refuses control characters, backslashes and encoded
  separators, and checks the path it returns as well as the one it was given.
  - `@rekey.dev/astro`'s `safePath` returned those protocol-relative URLs in
    every published version since 2.0.0-rc.7. The hash of a legitimate path is
    now kept alongside the query.
  - The panel's `next` on sign-in, sign-up, MFA, OAuth and passkey sign-in
    had the same dot-segment flaw.
  - rekey.dev's sign-in `next` let `/%09/evil.com` through, which a browser
    follows to another host once it strips the tab.
  - The refresh route the `@rekey.dev/nextjs` README and the rekey.dev
    quickstart showed for apps to copy followed `next` off-site. It is
    replaced by `rekeyRefreshHandler`, which applies the checks above.
  - The portal refuses a slug that is not one plain path segment, so an
    encoded slash (`/%2Fevil.com/...`), which Next decodes, can never become a
    protocol-relative `Location`.
  - The rekey.dev hosted OAuth authorize page could redirect to a
    `redirect_uri` the API had not confirmed. It now shows an error on
    rekey.dev instead, asks for consent before minting a code, and refuses to
    be framed.
- **A refresh token spent during a Server Component render revoked every
  session.** The panel, the portal and rekey.dev refreshed a stale session
  while a page rendered, where Next cannot write cookies, so the replacement
  was lost and the next request replayed the spent token. They now refresh in
  a route handler (`/session/refresh` on the panel and rekey.dev,
  `/<slug>/session/refresh` on the portal) and return to the page.
  `@rekey.dev/astro`'s `getSession` had the same failure; see **Breaking
  changes**.
- **A malformed `Origin` on a Server Action is refused, not stripped.** The
  panel, portal, admin and rekey.dev apps removed an `Origin: null` header to
  stop Next 15 crashing, which made Next skip its CSRF origin check for that
  action. They now answer 403, as `rekeyMiddleware` does.
- **Refresh clients never re-issue tokens from a local cache.** The panel,
  portal, rekey.dev and `@rekey.dev/nextjs` share only an exchange that is
  still in flight, keyed by a hash of the token (and of the device in the
  SDK). A request that arrives with a spent refresh cookie after the exchange
  finished goes to the API, which answers `REFRESH_TOKEN_RACED`, so nobody
  holding a copy of a spent cookie is handed its successor.
- **rekey.dev no longer sends URL query strings to Google Analytics**, where
  email verification and password reset links carried their tokens.
- **Operator refresh-replay security events are filed under the session's
  workspace**, not the operator's oldest one, so another workspace's owner no
  longer sees them.

### Upgrade notes

New environment variables for the API, all optional:

- `REFRESH_TOKEN_REUSE_WINDOW_SECONDS`, default `15` (0 to 60, 0 turns the
  reuse window off).
- `RATE_LIMIT_AUTH_CEILING_MAX`, default `3000`, never below
  `RATE_LIMIT_MAX`.
- `RATE_LIMIT_AUTH_UNATTRIBUTED_FAILURE_MAX`, default `300`.
- `WEBHOOK_TIMEOUT_MS`, default `10000` (1000 to 30000).
- `WEBHOOK_APP_MAX_IN_FLIGHT`, default `8` (1 to 200).
- `REKEY_COMMIT`, a build argument and environment variable for the API and
  billing images, reported by the health probes. Unset reads as `unknown`.
- `UV_THREADPOOL_SIZE`, set to `16` by the API image.

Changed defaults: `RATE_LIMIT_API_KEY_MAX` is `30000` (was `6000`), and
`RATE_LIMIT_USAGE_MAX` follows it. A deployment that set either explicitly to
the old `6000` keeps 6000; remove the setting to get the new default.

For `@rekey.dev/nextjs` apps: `REKEY_TRUSTED_PROXY_HOPS`, default `1`, the
number of proxies in front of the app that append to `X-Forwarded-For`. Set
`0` when nothing sits in front.

Also:

- `docker-compose.yml` needs `JWT_SECRET` and `SUPER_ADMIN_KEY` in `.env`
  (`openssl rand -hex 32` each).
- Run `pnpm db:migrate:deploy` for
  `20260923120000_operator_refresh_active_tenant`. It adds a nullable column,
  so rolling back the code does not need a SQL step.
- A Next.js app using `rekeyMiddleware` needs the refresh route:
  `export const GET = rekeyRefreshHandler();` in
  `app/api/rekey/refresh/route.ts`. Replace a hand-written one; the copies the
  README and quickstart used to show were open redirects.
- An Astro site calling `getSession` without `rekeyMiddleware` needs the
  middleware or `{ refresh: true }`.
- A backend that signs users in with a secret key should send the visitor's
  address (`clientIp` in `@rekey.dev/node`), or its failed sign-ins count
  toward the unattributed cap.

## 2.2.0-rc.2

A minor release, and NOT a patch. It changes what an existing subscriber
resolves at read time and closes an input the API used to accept, so a patch
number would tell integrators "nothing here needs your attention" when something
does. Same reasoning that moved this release line from 2.0.1 to 2.1.0.

**Upgrading an existing deployment:** several migrations in this release
rewrite rows on tables that sign-in depends on, one builds five indexes that
block writes to each table while the index builds, and rolling back needs one
SQL step first. Read
[Upgrading: 2.2.0 migrations and rollback](DEPLOY.md#upgrading-220-migrations-and-rollback)
before you deploy. `docker-compose.prod.yml` also requires three proxy secrets
it did not require in 2.1.x; see **Breaking changes** below.

### Breaking changes

Every item here is a behaviour or a configuration an existing 2.1.x deployment
depends on today. Read this list before you upgrade. The API behaviour an
integrator's code sees comes first, then deployment configuration, then the
operator panel and CLI.

- **`GET /api/v1/billing/subscription` returns a live subscription before an
  unfinished checkout.** A buyer already on a plan (a free tier, say) who opens
  a checkout now reads as that plan, not PENDING, while the checkout settles,
  and a paid plan outranks a free one. A UI that shows "confirming your
  payment" by reading PENDING here has to key that state off its own return
  flag instead. The entry under **Changed** has the full rule.

- **`GET /api/v1/billing/entitlements` without `?organizationId=` answers for
  the end-user in a user-billed Application**, even when the session is
  switched into a team. It used the active organization in every Application.
  Only an Application with `billingSubject: "org"` still resolves the
  organization by default. If a user-billed Application grants credits to an
  organization's pool and reads them from a switched session, pass
  `?organizationId=` now: the default `creditBalance` is the member's personal
  pool. See **Fixed**.

- **Entitlement resolution changes what three existing populations resolve.**
  The Application's free tier is a base layer now rather than another voter in
  the merge: a subject with an override naming a key the free tier also defines
  gets the override's value where they got the larger of the two; a STRING
  feature the free tier also defines no longer overwrites a paying plan's
  value; and two subscriptions defining the same STRING feature are ordered by
  `createdAt` rather than by Postgres row order. An override of `0` on a meter
  now resolves to zero included units. The "A per-subscription entitlement
  override now beats the Application's free tier" entry under **Changed** has
  the full account, including which subjects to check before upgrading.

- **Free-tier rows now sort FIRST in the `entitlements[]` array** returned by
  `GET /billing/entitlements`. A consumer that locates a value with `.find()`
  by key rather than reading `features` will now find the free tier's row where
  it used to find a subscription's. Read `features` instead.

- **A repeat free trial is refused with `BILLING_TRIAL_ALREADY_USED` (409).**
  A buyer gets one trial per Application (`billingConfig.trialPolicy`,
  `once_per_application` by default). Checkout used to grant one every time.
  Retry with `allowWithoutTrial: true` and a NEW `Idempotency-Key` to sell at
  full price, or set `trialPolicy: 'unlimited'` to keep the old behaviour.

- **A plan carrying a CREDIT or LICENSE entitlement cannot carry `trialDays`.**
  Creating a plan, patching one, adding an entitlement to one and the legacy
  `creditsAmount` column all refuse the combination with
  `PLAN_TRIAL_MATERIALISES_ENTITLEMENTS`, because such a trial hands over
  credits or a licence key on day 0 with no inverse.

- **A free plan that materialises CREDIT or LICENSE is claimable once per
  end-user per Application.** Another beneficiary gets
  `409 BILLING_FREE_TIER_ALREADY_CLAIMED`. Reactivating for the same
  beneficiary still works. Existing self-serve activations are backfilled as
  claims, and credits already issued are not clawed back.

- **Buying the same one-off plan twice now delivers twice.** It charged twice
  and delivered once before. If you sell credit packs, buyers who repurchased
  were charged and not credited; the **Fixed** entry says how to find them.

- **`*` on an API key means every standard scope, not every scope.** The new
  `credits:grant` scope (for `POST /api/v1/credits/grant`) is elevated: no key
  that exists today holds it, `*` keys included, and a key gets it only when an
  operator names it at mint. Code that treated `*` as "can call anything" is
  refused on that route with `403 API_KEY_SCOPE_INSUFFICIENT`. See
  [docs/api-keys.md](docs/api-keys.md#elevated-scopes-and-why--does-not-include-them).

- **Webhook endpoints subscribed to `*` start receiving three new events**,
  `credit.granted`, `credit.consumed` and `credit.adjusted`, one per credit
  ledger entry. `credit.consumed` fires once per `POST /usage/record` that is
  charged in credits, so a busy priced meter means one delivery per record. If
  that is more than an endpoint should take, list its events by name. Code with
  an exhaustive `switch` over `KnownWebhookEventType` needs branches for the
  new names (and for the six device and licence events below).

- **Credential routes cap their request body, and answer `413
  PAYLOAD_TOO_LARGE`.** Sign-in, sign-up, magic links, password reset, MFA,
  passkeys and the OAuth token endpoints refuse an oversized body before it is
  read, rather than parsing up to the global 1 MiB. A sign-up whose `metadata`
  is over the cap now gets 413 where it used to get `400 METADATA_TOO_LARGE`.

- **An impersonation token can no longer mint a real session.** Switching or
  clearing the active organization, and linking or unlinking an OAuth provider,
  answer 403 `IMPERSONATION_ACTION_FORBIDDEN` from an impersonated session.
  An ended impersonation's token is also refused on `GET /auth/me` with
  `401 IMPERSONATION_SESSION_ENDED`, as every key-guarded route already did.

- **A FEATURE override of `""`, and a quantity on a licence with no seats, are
  refused** with `ENTITLEMENT_OVERRIDE_INVALID`. Both were previously accepted
  and neither reached anything that read it. See **Removed**.

- **`POST /api/v1/admin/applications/:id/plans` refuses fields it used to drop
  silently.** An unrecognised key, or a typo like `intervall`, answers
  `400 VALIDATION_ERROR` naming the field, where it previously answered 201 and
  built a SUBSCRIPTION plan. Per-kind plans and `trialDays` are created on
  `POST /api/v1/tenant/applications/:id/plans`.

- **`docker-compose.prod.yml` refuses to start without `PANEL_PROXY_SECRET`,
  `API_PROXY_SECRET` and `PORTAL_PROXY_SECRET`.** All three are `:?` in that
  file now. Without them the panel would forward a browser-chosen
  `X-Forwarded-For` and the API would not recognise its own proxy, so every
  per-IP limit protecting sign-in would be off after one warning line at boot.
  Generate each with `openssl rand -hex 32` and put them in `.env` before you
  redeploy. `docker-compose.yml`, the development stack, requires none of the
  three; it still requires `POSTGRES_PASSWORD`, `REDIS_PASSWORD` and
  `ENCRYPTION_KEY`, as it did before.

- **The split-unit compose files require their secrets too.**
  `docker-compose.api.yml` requires `API_PROXY_SECRET` and
  `INTERNAL_CALLER_SECRET` and no longer trusts a bare hop count;
  `docker-compose.panel.yml` requires `INTERNAL_CALLER_SECRET` and
  `PANEL_PROXY_SECRET`; `docker-compose.portal.yml` requires
  `INTERNAL_CALLER_SECRET` and `PORTAL_PROXY_SECRET`. The API, panel and portal
  units must share one `INTERNAL_CALLER_SECRET`.

- **Admin endpoints refuse an address the API cannot verify.** With
  `ADMIN_IP_ALLOWLIST` set, a request that arrives through a proxy the API
  cannot identify is answered `403 ADMIN_IP_UNVERIFIABLE` before the key is
  read. That address belongs to the proxy and is shared by everyone behind it,
  so matching the allowlist against it admitted them all. Set
  `API_PROXY_SECRET` and have the proxy send it as `X-Rekey-Proxy-Secret`, or
  clear the allowlist. The API logs this once at boot.

- **Redis is replaced by Valkey, on a NEW volume, so the store starts empty.**
  See the entry under **Changed** for what that resets and how to remove the
  old volume.

- **Revocation can lag briefly across API replicas.** Operator auth is cached
  per API process and invalidated over Redis. If Redis loses that message, the
  other replicas can keep admitting a revoked session for at most
  `OPERATOR_AUTH_CACHE_TTL_MS` (new, default 5000). Set it to 0 to turn the
  cache off and restore the previous read-every-request behaviour.

- **Erasing or cascade-deleting an end-user is workspace-OWNER only.** Both
  were open to workspace ADMINs, and the cascade delete was gated on `write`
  alone, so a member holding an application grant could delete a person the
  erase form refused them. An ADMIN who handles erasure requests today gets a
  403 naming the OWNER; the data export still works for them.

- **Panel forms need JavaScript to submit.** The 75 forms built on
  `ActionForm` do nothing in a browser with scripts off. See **Changed**.

- **`rekey plans create` no longer accepts `--kind`, `--license-kind`,
  `--license-duration-days`, `--license-seats-allowed`, `--meter-slug`,
  `--price-per-unit-cents` or `--credits-amount`.** They are refused with
  `CLI_PLANS_KIND_UNSUPPORTED`, which names the panel and the tenant route,
  because the admin route behind them never implemented any of it.
- **The session handoff needs a key with `auth:write`.**
  `POST /api/v1/mcp/:slug/oauth/authorize/grant` checked for a secret key but
  not its scopes, so a key minted with only `credits:grant` could mint an
  authorization code that becomes a session and an MCP grant for the user. A
  key without `auth:write` now gets `403 API_KEY_SCOPE_INSUFFICIENT`. Keys
  with `*` are unaffected, and a key that signs users in already holds
  `auth:write`. If your hosted login page calls this with a narrowed key, add
  `auth:write` to it.

### Changed

- **`GET /api/v1/billing/subscription` prefers a live subscription over an
  unfinished checkout.** It used to return the newest row that was ACTIVE,
  TRIALING, PAST_DUE or PENDING, so a free-tier subscriber who opened a paid
  checkout and closed the tab read as PENDING from then on. Every entitlement
  gate built on that answer refused them, and `POST /billing/subscription/cancel`
  cancelled the abandoned checkout instead of their plan. It now returns a
  live (ACTIVE, TRIALING or PAST_DUE) row whenever there is one, newest first,
  with free rows ranked last: a row whose plan costs nothing (no amount and no
  per-unit price) or is the Application's `billingConfig.defaultPlanSlug`. So a
  paid plan wins even when its row is older. A live row that lapses on the read
  no longer hides another live one. PENDING is returned only when nothing is
  live. The end-user MCP `get_subscription` tool picks its row through the same
  service, so a pending checkout, or a paid plan held next to a free one, reads
  the same on both, including for connections made before this release.

  **Check before upgrading** if your UI shows a "confirming your payment" state
  by reading PENDING from this endpoint: a buyer who is already on another plan
  (a free tier, say) now reads as that plan while the new checkout settles. Key
  that state off your own return flag from the provider redirect instead.

  Without `?organizationId=` this route still answers for the end-user
  personally, in every Application. `GET /auth/me?include=subscription` and the
  MCP tool follow the billing subject instead (the active or bound organization
  in an org-billed Application), so pass the organization's id here to compare
  the two.

- **Behaviour change: an `auth:read` secret key can now read the signed-in
  user's own organizations, sessions, passkeys, MFA status and linked OAuth
  identities.** These GET routes used to require `auth:write`, because their
  plugins applied it to every route, reads included, which pushed backends
  that only read to hold a key that can also write. They now require
  `auth:read`, like `GET /users/me` and `GET /users/me/devices` already did.
  Every other method on those routes still requires `auth:write`, and a key
  with `auth:write` (or `*`) can do everything it could before. This is more
  permissive, not less: nothing that worked stops working, but an `auth:read`
  key that was refused with `403 API_KEY_SCOPE_INSUFFICIENT` on
  `GET /users/me/organizations`, `/users/me/organizations/roles`,
  `/users/me/organizations/:id`, `/users/me/organizations/:id/members`,
  `GET /auth/sessions`, `GET /auth/passkeys`, `GET /auth/mfa/status` or
  `GET /auth/oauth/identities` is now answered. Review which services hold an
  `auth:read` key if that matters to you. `include=organization` on
  `GET /users/me` follows its route and needs only `auth:read` too.

- **Behaviour change: `GET /api/v1/auth/me` is rate limited per end-user.**
  It is now keyed on the end-user it resolved (600 a minute by default,
  `RATE_LIMIT_AUTHENTICATED_MAX`) under the 3000-a-minute ceiling for every
  end-user seen from one client IP, instead of per client IP at 100 a minute
  shared by every user a backend resolved from one address, because the token
  is verified before the limiter runs rather than inside the handler. Its
  refusals other than 401 (a frozen Application's 403, an unknown or erased
  user's 404 and 410) count toward the per-IP rejected-credential limit, like
  a 401. A backend resolving many users from one address is better served by
  `GET /users/me` with its secret key, which counts against the key. See
  [docs/rate-limits.md](docs/rate-limits.md).

- **A per-subscription entitlement override now beats the Application's free
  tier.** Resolution merges across sources: booleans OR-true, numbers take the
  max, included usage is summed. The free tier
  (`billingConfig.defaultPlanSlug`) was merged in as one more source, so a
  default the subject had not bought could only ever raise the answer. An
  operator restricting one customer got a 200, a `changed: true` and a
  `subscription.entitlements_updated` webhook carrying the lower value, while
  `GET /billing/entitlements` kept serving the higher one. Lowering a metered
  allowance from 1000 to 50 resolved to **1050**.

  The free tier is now a base layer: it fills in where nothing else answered, and
  it is withheld for a key or meter a per-subscription override names. A plan row
  does **not** withhold it: buying a credit pack that happens to mention a key is
  a top-up, not being on a plan, and does not take a free tier away.

  **Three populations resolve differently after this. Check before upgrading.**

  1. **A subject with an override** naming the same FEATURE key or meter as the
     Application's default plan, who holds no SUBSCRIPTION or USAGE plan (those
     already suppressed the free tier entirely). They now get the override's
     value where they got the larger of the two.
  2. **A subject with a STRING feature the free tier also defines**, with *no
     override involved*. STRING merges last-wins and the free tier used to be
     applied last, so a default of `support_tier: "community"` overwrote a paying
     plan's `"priority"`. The default is now applied first, so it can raise a
     number or turn a boolean true but never replace a value. If you relied on a
     default plan overriding subscriptions for STRING features, it no longer does.
  3. **A subject with two or more subscriptions** that define the same STRING
     feature. Which one wins was Postgres row order and could change after an
     unrelated write; it is now ordered by `createdAt`, so the later subscription
     wins, deterministically.

  An override of `0` on a meter now resolves to **zero included units**. It
  previously had the default plan's allowance added to it. If a later plan edit
  clears the price out from under such an override, the zero still stands rather
  than falling back, because the alternative answers "unmetered" for a subject
  the operator explicitly restricted.

  The free tier's per-unit price still floors the rate charged wherever the free
  tier applies at all, even when its quantity is withheld. A SUBSCRIPTION or
  USAGE plan suppresses the free tier entirely, price included; that is
  unchanged. Free-tier rows also sort first in `entitlements[]` now (see
  **Breaking changes**).

- **`PATCH /api/v1/users/me` returns what `GET` returns.** It returned
  `activeOrganizationId` but not `activeOrganizationRole` and
  `activeOrganizationBaseRole`, which its own published schema marks required,
  so a typed client read `undefined`. Both now come from one builder, and
  `@rekey.dev/node` types both `getCurrentUser` and `updateCurrentUser` as
  `CurrentUserDto`.

- **Security events name their actor: `actorEmail` on every event.**
  `GET /api/v1/tenant/security-events` (JSON, and CSV, where it is a new last
  column) and the operator MCP `recent_security_events` tool now return the
  actor's email, looked up when the log is read: the operator account for
  `operator`, including one who has since left the workspace, the end-user for
  `end_user` (only within the event's Application), and `null` for `system` or
  an actor that no longer exists. The end-user detail's `recentImpersonations`
  gains `operatorEmail` the same way. Nothing is stored twice; `actorId` is
  unchanged.

- **The `APP_BILLING` grant role can now manage provider credentials and issue
  refunds.** Both were plain `write` before, so the billing role could do
  neither. This widens what an existing `APP_BILLING` holder can do; review who
  holds it if that matters to you.

- **Panel forms need JavaScript to submit.** `ActionForm` now lets React
  dispatch the submit, so the navigation a save's `redirect()` triggers is
  committed instead of dropped (#569: on the Auth methods page, 0 of 14 saves
  showed the saved state before, 9 of 10 after). The trade is that React no
  longer emits the fields a no-JavaScript post needs, so the 75 forms that use
  `ActionForm` do nothing without scripts. That path was already partial:
  confirmation buttons, slug checks and the unsaved-changes guard all needed
  scripts. The remaining tenth of #569 was the same lost render that left
  minted secrets unshown, and is fixed with it (see **Fixed**).

- **The end-user page is split into tabs** (overview, subscriptions, devices,
  credits, security, data) with a breadcrumb, and the email page into settings,
  templates, delivery and suppressions. Links to the old single page still land
  on the overview.

- **The panel costs far fewer database queries.** A signed-in operator request
  used to read the operator, the session and the membership (and, on an
  application route, the application; for a MEMBER, the grants) before doing
  anything. Those reads are now cached in each API process and a warm request
  makes none. Measured with the same data: the application overview page went
  from 48 statements to 9, one operator request from 3 to 0.
- **Revocation is still immediate within a replica.** Sign-out, sign out
  everywhere, a revoked session, a password change or reset, and any role,
  scope, grant or membership change drop the cached entry at once in the
  process that made the change and, over Redis, in every other API replica.
  The bound on a lost invalidation is under **Breaking changes**.
- **Per-application stats are one query, cached for 60s in Redis**
  (`rk:stats:app:<id>`). The overview tile's counts may lag by up to a minute;
  turning billing on or off shows at once.
- **Super-admin lists no longer query per row.** The application list made 3
  queries per listed application and the tenant list 5 per tenant, up to 1,500
  at once on a computed sort. Each is now a fixed handful whatever the page
  size. The super-admin overview is one statement for its counts and is cached
  for 60s (`rk:admin:overview`).
- **Tenant MRR on the super-admin tenant list is exact.** It is summed in SQL
  over every active subscription rather than the first 10,000, so `mrrCapped`
  on that list is always `false`.

- The `redis` service in every compose file (`docker-compose.yml`,
  `docker-compose.api.yml`, `docker-compose.prod.yml`) and in CI now runs
  `valkey/valkey:8.1-alpine` instead of `redis:7-alpine`. The floating
  `redis:7-alpine` tag now resolves to Redis 7.4, which is licensed under
  RSALv2/SSPLv1 (source-available, not open source); Valkey is the Linux
  Foundation's BSD-3-Clause fork and is protocol-compatible with this
  codebase's ioredis/BullMQ usage, so no application code changed. The
  service name and `REDIS_URL` / `REDIS_PASSWORD` env vars are unchanged, but
  the volume is a NEW one (`rekey_valkey` / `valkey-data`, replacing
  `rekey_redis` / `redis-data`): Valkey refuses to start on a Redis
  7.4-format AOF/RDB file, which most existing self-hosted volumes already
  are, so an in-place volume swap would have been a boot-time outage on
  upgrade. The store starts empty instead. See "Why Valkey, not Redis" in
  DEPLOY.md for exactly what that resets (queued webhook retries, lockouts,
  rate-limit windows, in-flight PKCE state: all recoverable or
  reconstructible, nothing in Postgres) and how to remove the old volume once
  you've confirmed the deploy is healthy.

### Added

- **`GET /api/v1/auth/me` and `GET /api/v1/users/me` answer who, what and
  which device in one call** (rekey#41). A new `?include=` takes any of
  `entitlements`, `device`, `subscription`, `organization` and `licenses`,
  comma-separated or repeated (`include=a&include=b`), and adds each as a
  top-level property of the same name. `entitlements` and `subscription` are
  what `GET /billing/entitlements/for-user` and `GET /billing/subscription`
  return for the Application's billing subject, from the same service code: in
  an org-billed Application the active organization while the caller is still a
  member of it, otherwise the end-user, including a user-billed session
  switched into a team. `licenses` is what `GET /users/me/licenses` returns for
  that subject, as `{ items, truncated }`: the first 100 rows, `truncated: true`
  when there are more. `device` is the device the token's `dev` claim names, or
  null for a session that is not device-bound. `organization` is the active
  organization with the caller's role and base role. Without `include` the
  response and the queries it runs are unchanged. An unknown value is a
  `400 VALIDATION_ERROR` naming the supported ones. Every session check still
  runs first. With a secret key on `/users/me`, each value needs the scope of
  the route that serves it (`billing:read` for the three billing values,
  `auth:read` for `organization`), and on an Application with billing off the
  billing values answer `403 BILLING_DISABLED` on both routes.
  `@rekey.dev/node` takes it as `auth.getCurrentUser(token, { include })`
  (which calls `/users/me`) and the React browser client as
  `getMe(token, { include })` (which calls `/auth/me`), both typed so a literal
  list gives exactly the properties asked for; a list typed `MeInclude[]` makes
  them optional. `/auth/me` changes how it is rate limited; see **Changed**. See
  [Authorising requests in your own backend](docs/auth.md#authorising-requests-in-your-own-backend).

- **A signed-in user can list their own licences.** `GET /api/v1/users/me/licenses`
  (publishable or secret key plus the user token, `billing:read` on a secret
  key, billing enabled) returns every licence issued to the caller, newest
  first and paginated (`limit`, `offset`), and in an org-billed Application
  whose session acts for an organization the caller belongs to, that
  organization's pooled licences as well. Rows carry `keyPrefix`, never the key
  (only its hash is stored), and not the operator's licence `metadata`. SDK:
  `rekey.licenses.listMine(token)` in `@rekey.dev/node`, `listMyLicenses(token)`
  in the React browser client.

- **A single-feature check.** `GET /api/v1/billing/entitlements/features/:key`
  answers `{ key, granted, value }` for the signed-in user, for the same subject
  `include=entitlements` resolves, without the credit balance read; `granted`
  is `Boolean(value)`, and an unknown key is a 200 with `granted: false`.
  `GET /billing/entitlements/for-user/features/:key?endUserId=` is the
  secret-key variant (`billing:read`). SDK: `billing.hasFeature` /
  `getFeature` in both SDKs, and `hasFeatureFor` / `getFeatureFor` in
  `@rekey.dev/node`.

- **Usage remaining is readable by the user it belongs to** (rekey#473).
  `GET /api/v1/usage/remaining` takes an end-user token with the publishable
  or secret key (`billing:read` on a secret key) and answers, per meter (or one
  with `?meter=`), the `included` quota, the units `used` this period, what is
  `remaining`, the `creditsPerUnit` charged past the quota, and the period
  window. `GET /api/v1/usage/remaining/for-user` answers the same for a named
  end-user or organization with a secret key (`billing:read`). Both are
  computed by the code `POST /usage/record` enforces with, so a record dated
  now of more than `remaining` units is exactly the one refused with
  `402 USAGE_QUOTA_EXCEEDED` (or charged, on a priced meter). Without
  `?meter=` it reports up to 200 meters and says so with `totalMeters` and
  `truncated`. `@rekey.dev/node`: `usage.getRemaining(token)`,
  `usage.getRemainingFor()`; React browser client: `getUsageRemaining(token)`.

- **`GET /api/v1/credits/me/ledger` pages through the signed-in user's own
  credit ledger** (or their active organization's, in an org-billed
  Application), newest first, without `metadata` or the idempotency key.
  Entries written in the same instant now page in a fixed order here and on
  `GET /credits/ledger`. `@rekey.dev/node`: `credits.listMyLedger(token)`;
  React browser client: `listMyCreditLedger(token)`.

- **`POST /api/v1/credits/grant` grants credits with the Application key**
  (rekey#473), to an end-user or an organization pool, through the same ledger
  write as a panel grant. It needs the new **elevated** `credits:grant` scope,
  which `*` does not include (see **Breaking changes**). Minting a key with it
  needs the authority of a panel credit grant, billing-write access and the
  `billing:write` operator scope, on the panel, the operator PAT route and the
  MCP `mint_api_key` tool; otherwise `403 SCOPE_INSUFFICIENT`. The panel's API
  key form has an "Elevated scopes" group, can mint a key holding only that
  scope, and the key list flags elevated scopes. One call grants 1 to
  1,000,000 credits, as `GRANT` (the default) or `REFUND`. `idempotencyKey` is
  required and belongs to this route (stored as `api-grant:<key>`): an exact
  retry grants nothing and returns the original entry, and reusing the key
  with a different amount or reason is `409 CREDITS_IDEMPOTENCY_KEY_REUSED`.
  Each grant is written to the security log as
  `app.credits_granted_by_api_key` naming the key, in the grant's own
  transaction. `@rekey.dev/node`: `credits.grant()`. `@rekey.dev/shared-types`
  exports `STANDARD_API_KEY_SCOPES`, `ELEVATED_API_KEY_SCOPES` and
  `isElevatedApiKeyScope`.

- **Credit webhooks: `credit.granted`, `credit.consumed`, `credit.adjusted`**
  (rekey#473). One per credit ledger entry, enqueued in the transaction that
  writes the entry, so a mirror of balances no longer has to poll. A consume is
  `credit.consumed`, an operator ADJUST of either sign (or any other entry that
  removes credits) is `credit.adjusted`, and every other entry (a grant, a
  refund, a purchase) is `credit.granted`. The payload is `data.credit` with the
  entry id, the subject, the signed `delta`, `amount`, `reason`, the `balance`
  after the entry, the idempotency key, description and time
  (`CreditWebhookData`). A refused consume or an idempotent replay emits
  nothing. `credit.consumed` also fires for usage charged in credits, once per
  charged record; see **Breaking changes** for what that means for `*`
  endpoints. Erasing an end-user scrubs their `credit.*` delivery payloads like
  every other event's. See [docs/webhooks.md](docs/webhooks.md#credits).

- **`GET /api/v1/users/me/licenses` accepts `?organizationId=`**, as every
  other self read does. The caller's own licences are listed with that
  organization's pooled ones; it is member-only
  (`403 ORGANIZATION_NOT_MEMBER` otherwise).
- **An end-user MCP connection can act for one of the user's organizations**
  (EtherLabZ/Rekey#473 item 3, #587). When the Application has
  organizations on and the user can act for at least one, the MCP consent page
  asks, after sign-in, whether the connection acts for them personally
  (preselected) or for one of those organizations. The choice is stored on the
  grant, carried in the access token as `oid` and through every refresh, and
  reported by token introspection. `get_profile` now returns the bound
  `organization` with the user's role in it. `get_subscription` and
  `get_credits` answer for the organization when the Application bills
  organizations (`billingSubject: "org"`) and for the user otherwise, by the
  subject rule `include=` uses, and say which in a new `organizationId` field.
  `list_licenses` returns the rows `GET /users/me/licenses` does for the same
  subject: the user's own licences plus, in that case, the organization's
  pool, the newest 100 with `truncated` when there are more.
  `list_my_devices` stays personal.
  The session handoff (`POST /oauth/authorize/grant`) takes `organization_id`;
  omitted is personal, as before, even when the session has an active
  organization. A binding fails closed:
  once the user leaves the organization, is removed, has the role disabled or
  the organization is deleted, the access token is refused and the refresh
  answers `invalid_grant` rather than quietly switching to the personal
  account. Grants made before this change carry no binding and keep acting
  for the user personally. Migration `20260922120000_mcp_grant_organization`
  adds two nullable columns and rewrites no rows. See
  [docs/mcp.md](docs/mcp.md#organization-binding).

- **`GET /api/v1/usage/meters` lists the meter catalogue** with a secret key
  (`billing:read`): slug, name, unit, active flag and fallback credit price
  (`creditsPerUnit`), so a backend learns meter slugs instead of hard-coding
  them. `@rekey.dev/node`: `usage.listMeters()`.

- **Checkout readiness on the public plan list.** Each plan on
  `GET /api/v1/billing/plans` carries `checkout: { ready: boolean }`, false
  when a buyer sent to checkout for it would be refused (no provider
  connected, a plan never registered with Stripe, a trial a provider cannot
  run), so a pricing page can hide it. Only the boolean: which provider refuses
  and how to repair it stay on the operator list, and the two lists serialise
  through one function so they cannot disagree about whether a plan is
  buyable. One extra query per page, however many plans are on it. A free
  default plan reads `ready: false` with no provider connected yet still
  applies, so do not filter the free tier out. SDK type `PublicPlanDto`;
  `PlanDto.checkout.blockers` is now optional in the TypeScript type so a
  public row still assigns to `PlanDto` (the operator routes always send it).

- **The published spec documents `creditsPerUnit`** on the entitlement rows of
  `GET /billing/entitlements` and `GET /billing/entitlements/for-user`. Both
  routes already returned it (USAGE only: credits charged per unit past the
  included quantity, null for a hard cap); only the OpenAPI document and the
  `ResolvedEntitlementDto` type were missing it.

- **`PATCH /api/v1/admin/applications/:id/default-plan`** sets or clears an
  Application's free-tier plan (`billingConfig.defaultPlanSlug`) with the
  super-admin key. It is the only billing setting with no panel control, and
  without it `POST /api/v1/billing/subscribe` answers `BILLING_NO_FREE_PLAN`.
  Same validation as the operator route: the slug must name an active plan.
  It touches nothing else in the billing config, and an unknown body key is a
  400, not silently dropped.

- **The SDKs can reach the billing and device features the API already had.**
  `@rekey.dev/node` and the browser client in `@rekey.dev/react` gain
  `subscribe()` for a free plan a buyer claims themselves, `getTrialEligibility()`
  behind `GET /billing/trial-eligibility`, and `listMyDevices()` /
  `releaseMyDevice()` for the end-user device list. Until now each of these
  endpoints existed with no way to call it from an SDK, so an integrator wrote
  the `fetch` by hand. `<PricingTable>` takes an optional `trialEligibility`
  list and offers a trial only to a buyer the API says may have one, never
  because a plan carries trial days. `allowWithoutTrial` is now part of the
  checkout request type, so the documented way out of
  `BILLING_TRIAL_ALREADY_USED` no longer needs a cast. `DEVICE_LIMIT_REACHED`
  has a type for its `details`, so the "release a device" path it asks for can
  be built. `VerifiedAccessTokenClaims` carries `sid` and `dev`, so an offline
  verifier can read session and device binding. `POST /auth/sign-in` declares
  its 503 in the published spec.

- **Free trials are available again, and `GET /api/v1/billing/trial-eligibility`
  says who may have one.** The 2.1.0 hold (`PLAN_TRIAL_UNAVAILABLE`) is lifted.

  It named two ways a trial lost money. One is fixed: nothing recorded that a
  buyer had already trialled, which `TrialRedemption` and `trialPolicy` now do.
  The other is closed by construction rather than accepted: `provision` has no
  trial gate, so a plan carrying a CREDIT or LICENSE entitlement hands over
  credits or a licence key on day 0, before any money moves, with no inverse.
  A trial is therefore refused on such a plan with
  `PLAN_TRIAL_MATERIALISES_ENTITLEMENTS`, on every write path that could
  introduce the combination (creating a plan, patching one, adding an
  entitlement to one, and the legacy `creditsAmount` column). FEATURE and USAGE
  entitlements resolve at read time and lapse with the subscription, which is
  the ordinary feature-gated SaaS trial `trialDays` exists for.

  The new endpoint answers, per plan, whether **this** buyer may start a trial,
  so a pricing page renders "Start 14 days free" or "Subscribe" from the answer
  rather than from the plan alone. `reason` is evaluated in a fixed order:
  `PLAN_HAS_NO_TRIAL`, `PLAN_TRIAL_MISCONFIGURED` (the plan is currently
  unbuyable and checkout would answer 400), `TRIAL_IN_PROGRESS` (scoped to that
  plan, with `endsAt`), then `ALREADY_REDEEMED`. A buyer's own live reservation
  reads **eligible**, because reporting it as a refusal would make an SDK send
  `allowWithoutTrial` and charge them today for the trial checkout was about to
  grant.

  Advisory, like `coupons/validate`: the authoritative decision is taken under a
  lock at checkout, and the response echoes the resolved `provider` because a
  plan can be unbuyable on one processor and fine on another.

  **A buyer gets one free trial per Application, not one per checkout.**
  `resolveCheckoutTrial` was a pure function of the plan and nothing anywhere
  asked whether the buyer had trialled before, so a buyer could trial, cancel on
  the last day and trial again without limit. On a plan carrying CREDIT or
  LICENSE entitlements each loop handed out a full period of them.

  Checkout now takes a `TrialRedemption` slot before the provider call, the same
  way a coupon reservation works, and refuses a repeat trialist with
  `BILLING_TRIAL_ALREADY_USED` (409). The refusal names the plan already
  trialled and the price that would be charged instead. To sell to that buyer at
  full price, retry with `allowWithoutTrial: true` **and a new Idempotency-Key**:
  checkout stores 4xx responses, so reusing the key answers
  `IDEMPOTENCY_KEY_REUSED`.

  `billingConfig.trialPolicy` chooses the rule: `once_per_application` (the
  default, since trialling two plans is two free months of the product),
  `once_per_plan`, or `unlimited`, which never refuses. The subject is whatever
  the Application bills, so an org-billed Application counts the trial against
  the organization rather than handing a five-person team five trials.

  **Who is affected on upgrade.** Only an Application whose plans already carry
  `trialDays`: writing one first became possible in 2.1.0 and was refused for
  the rest of 2.1.x (`PLAN_TRIAL_UNAVAILABLE`), so the exposed population is
  plans written in that window. They keep working; a repeat buyer now sees a
  409 where they previously got a second free trial. Set
  `trialPolicy: 'unlimited'` to restore the old behaviour.

The entries below came from one contribution by @libworky
(rekey-dev/rekey#39), written while running Rekey as the licensing layer for a
desktop product. Thank you.

- **Devices.** Every session-minting endpoint accepts an optional
  `device: { fingerprint, label }`. The device is registered before any token
  is issued, the access token carries a `dev` claim, and refresh keeps the chain
  bound to that machine. A `max_devices` FEATURE entitlement caps a person's
  active devices, and also caps live activations on PERPETUAL and TIMED
  licences. `authConfig.deviceBinding` (`optional` or `required`) decides
  whether sign-in must name a device. Over the cap, sign-in answers
  `DEVICE_LIMIT_REACHED` with the active devices in `details`, so a client can
  offer to release one. End-users, secret-key backends and operators can list
  and release devices; operators can also block and unblock them. Licence seats
  can be given back with `POST /api/v1/licenses/deactivate`. Nothing changes for
  a client that sends no device or an Application without the entitlement. See
  `docs/devices.md`.

  On refresh, a device refused after the refresh token was already spent answers
  `REFRESH_TOKEN_REVOKED`, with the device code in `details.reason`, so a client
  signs in again instead of retrying a token that no longer works.

- **Import users with the password hashes you already have.**
  `POST /api/v1/users/import` (secret key) takes up to 500 users per call with
  an argon2id or bcrypt hash, so moving a user base onto Rekey no longer means a
  forced reset. A bcrypt hash is re-hashed to argon2id on the user's next
  sign-in. Hash cost is bounded (bcrypt cost 12, argon2id memory, time and
  parallelism limits) so an imported hash cannot turn sign-in into a CPU sink.
  Existing addresses are skipped, never updated, and `emailVerified` defaults
  to false.

- **An `external` billing provider, for sales Rekey never sees.** Your own
  billing system, an invoicing tool or a marketplace posts signed events to
  `POST /api/v1/webhooks/billing/external/<slug>`, with the same signature
  scheme as the webhooks Rekey sends. Rekey activates, renews and cancels
  subscriptions from them, provisions entitlements and records payments. A trial
  the sender reports goes through the same one-trial-per-buyer ledger as
  checkout; a buyer who already had one is granted the subscription without the
  trial. Cancelling these subscriptions through Rekey is refused, since the money
  lives elsewhere. See `docs/external-billing.md`.

- **Subscription import.** To bring over the subscriptions sold before a billing
  system was connected, an import reads a paginated endpoint you host
  (`docs/external-billing-pull.md`) and records, per row, what would happen and
  why. Nothing is written until an operator applies the preview behind a typed
  confirmation. An import never overwrites a live subscription and never matches
  an erased user.

- **An operator support console.** From an end-user's page an operator can
  unlock the account, resend verification, send a password reset with a reason
  that lands in the audit trail, list and revoke sessions, and release every
  device. Workspace owners and admins can grant a subscription with no payment
  behind it (an invoiced sale, a comped account); this is controlled by
  `TENANT_SUBSCRIPTION_GRANTS`. Entitlement overrides and ending an
  impersonation are available in the panel too.

- **Email send control.** Per Application: a master switch, a switch per email
  event, and a suppression list. A mail that was not sent is logged as
  `suppressed` with the reason, and a suppressed send never hands a reset or
  magic-link token back to the caller. Turning off mail the live auth
  configuration depends on (password reset while password sign-in is on,
  verification while it is required) is refused with
  `EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG`, in both directions.

- **Operator permissions.** A workspace member can be restricted to scopes over
  seven areas (end-users, billing, auth config, developer, organizations,
  activity, overview), each read or write. The grant roles are presets over the
  same scopes, and a request gets the intersection of the two. A caller who
  cannot see an Application still gets 404; one who can see it but lacks the
  scope gets 403 naming the scope. `/me` returns the caller's scopes, and the
  panel builds its navigation from them. Nothing changes for an existing
  workspace until an admin restricts somebody.

- **A per-workspace switch for the operator MCP server.** A workspace owner can
  refuse every operator MCP access token for the workspace. Refresh keeps
  working while it is off, so turning it back on restores every agent without a
  new consent.

- **Token lifetimes are settings.** `END_USER_ACCESS_TOKEN_TTL_SECONDS`,
  `END_USER_REFRESH_TOKEN_TTL_DAYS`, `OPERATOR_ACCESS_TOKEN_TTL_SECONDS` and
  `OPERATOR_REFRESH_TOKEN_TTL_DAYS`. Unset keeps today's 15 minutes and 30 days.

  Ending a session no longer waits for its access token to expire. A password
  change, a password reset or signing out everywhere refuses every access token
  the person holds on its next use. Revoking one session, or releasing or
  blocking one device, refuses only that session's tokens, and the person's
  other sessions carry on without a refresh. The refusal uses the codes clients
  already refresh on. Access tokens issued before the upgrade carry no session
  id, so they run to their natural expiry. A token verified locally with
  `verifyAccessToken` cannot see a revocation; call the API where that matters.

- **Optional log retention, with an optional archive.** `LOG_RETENTION_DAYS`
  prunes `security_events`, `email_logs` and finished `webhook_deliveries`;
  `WEBHOOK_EVENT_RETENTION_DAYS` prunes inbound webhook receipts. **Unset keeps
  every row**, as before. With `LOG_ARCHIVE_S3_*` set, each batch is written to
  any S3-compatible store before it is deleted; a partial set of those settings
  refuses to boot. Erasure does not reach an archived copy.

- **Security events by the person they are about.**
  `GET /api/v1/tenant/security-events?endUserId=` returns events the person did
  and events done to them. The data export for a person now includes what
  operators and the system did to them, without the operator's id.

- **Look up an end-user from your backend.** `GET /api/v1/users?email=`,
  `GET /api/v1/users/:id` and `GET /api/v1/billing/entitlements/for-user` work
  with a secret key, so a licence server or support tool does not need the
  user's token. The publishable key is refused.

- **SDK.** `devices.list`, `devices.release`, `users.get`, `users.getByEmail`,
  `users.import`, `licenses.deactivate` and `billing.getEntitlementsFor`; an
  optional `device` on `refresh`, `completeOAuth`, `verifyMagicLink` and
  `verifyPasskeyAuthentication`; `RekeyError.details`. New webhook events:
  `device.registered`, `device.released`, `device.blocked`, `device.unblocked`,
  `device.limit_reached` and `license.deactivated`. Additive only; code that
  switches exhaustively over the event-name union will see the new names.

- Indexes: `security_events (application_id, type, created_at)`,
  `subscriptions (application_id, status)`, and `created_at` on `end_users`,
  `api_request_logs` and `webhook_deliveries`.
- DEPLOY.md: sizing `DATABASE_POOL_SIZE` per replica against Postgres or Neon
  `max_connections`, and a table of what is cached for how long.
- **The CLI and the standalone MCP package publish at 2.2.0 but do not cover
  the 2.2.0 API surface.** `@rekey.dev/cli` has no commands for devices,
  subscription import, log retention, erasure, external billing providers or
  operator scopes, and cannot create a plan with `trialDays`.
  `@rekey.dev/mcp` ships 9 tools against `/api/v1/admin/*` where the hosted
  operator MCP server exposes 41. Both are usable for what they already do and
  neither is a blocker for this release; the gap is tracked in
  [rekey-dev/rekey#527](https://github.com/rekey-dev/rekey/issues/527).

### Fixed

- **The end-user MCP billing tools refuse when billing is disabled.**
  `get_subscription`, `get_credits` and `list_licenses` answered for an
  Application with billing off, while the REST reads they mirror return
  `403 BILLING_DISABLED`. They now return an MCP tool error carrying
  `code: "BILLING_DISABLED"`, and every tool error that comes from the API's
  own refusals carries its `code`.
- **The panel names the API key behind a credit grant.** An
  `app.credits_granted_by_api_key` event read "system, reason GRANT" on the
  end-user Security and Overview tabs. The actor is now the key, by name and
  prefix, and the Security tab, audit log and Activity show the amount.
- **`GET /api/v1/billing/entitlements` no longer reads a paying user as entitled
  to nothing after they switch into a team.** Without `?organizationId=` it
  resolved the session's active organization in every Application, and in a
  user-billed one an organization holds no subscription, so the answer was
  `features: {}`. It now resolves the subject `include=entitlements`, the
  single-feature check and `GET /users/me/licenses` use: the organization only
  when `billingSubject: "org"` and the caller is still a member, otherwise the
  end-user. An explicit `?organizationId=` is unchanged (member-only). What
  this changes for a user-billed Application that reads an organization's
  credit pool is under **Breaking changes**.
- **Panel: minted secrets are always shown, and tables refresh after an
  action.** On a production build the panel's post-action re-render could be
  left suspended by React after its payload had arrived, so a webhook signing
  secret was minted and never shown, a redirect never landed, and tables kept
  their old rows until a reload. Forms now nudge that render until it commits,
  and the full-page reloads some forms used to work around it are gone.
  Every one-time secret (API keys, webhook signing secrets, invite links,
  licence keys, API tokens, impersonation tokens) is returned by its action to
  a "shown once" dialog with a copy button, instead of a cookie read by a
  redirect; no secret travels in a cookie or a URL any more. The end-user edit
  modal closes on save without the page blinking (rekey-dev/rekey#25). Activity and
  Security tabs show which operator acted, by email. Light-mode primary
  buttons use a darker teal with white text (5.47:1).
- **Plan checkout readiness ignores inbound-only providers when a real one is
  enabled.** With the external billing system enabled beside Stripe, every
  plan read `checkout.ready: false` with a `PROVIDER_INBOUND_ONLY` blocker,
  though buyers are only ever routed to Stripe. Readiness now judges the
  providers a buyer can be routed to; the inbound-only blocker appears only
  when nothing else can host a checkout.

- **A role edit can no longer be undone by a read already in flight.** The
  organization-role catalog cache stored whatever a read returned, so a catalog
  read that started before an edit committed could overwrite the invalidation
  and serve the old role tiers, which decide what a member may do, until the
  entry expired. The cache now discards a load that raced an invalidation.

- **A Next.js or Astro app can sign in when device binding is required.** The
  Next SDK narrowed `signIn`, `signUp` and `mfaVerify` to email and password, so
  an Application set to `deviceBinding: 'required'` refused every one of them
  with `DEVICE_FINGERPRINT_REQUIRED` and nobody could get in. All three now take
  `device`, and so do `auth()` and `refreshSession()`, which matters because
  binding is checked again on each rotation and a mismatch ends every session
  the person has. Astro takes the same field in its config. Omitting it sends
  nothing, so existing call sites are unchanged. The Next SDK also ships an
  `./errors` entry point that sorts a failed sign-in into wrong credentials, a
  device refusal carrying the devices to release, or `retry_later` for the new
  503, which is never read as a wrong password.

- **OIDC response bodies are capped, and panel banners no longer echo the URL.**
  Discovery, token and userinfo bodies from an OAuth or OIDC provider were read
  with no size limit, so an issuer an operator configured could stream an
  unbounded body into memory the whole API shares. They are now read through the
  same capped reader as the external billing pull, and a body over 1 MB fails the
  exchange. Separately, panel error banners fell back to the raw `?error=` value
  when a code was unknown, so a crafted link could put any sentence on the real
  panel host. An unknown code now shows a fixed generic sentence.

- **Imported bcrypt hashes are checked off the event loop.** `bcryptjs` is
  pure JavaScript, so each sign-in against a not-yet-migrated imported account
  blocked every request on the server for about 100 ms at a time (300 ms per
  check at cost 12). The check now runs on a small worker pool. When that pool
  is saturated the request answers 503 `PASSWORD_VERIFY_BUSY` with
  `Retry-After` instead of waiting without bound; it is never read as a wrong
  password and never counts toward lockout. (#511)

- **The customer portal asks what a billing provider can do, not its name.**
  A buyer who picked a payment option other than Stripe, PayPal or Razorpay
  was silently sent through the router's choice instead; the pick is now
  checked against the Application's provider list and forwarded, or refused
  with an explanation. "Managed through your billing account" is decided from
  the provider's capabilities. `GET /billing/subscription` adds
  `providerCapabilities` for that (additive, null when there is no provider).
- **An impersonation token can no longer mint a real session.**
  `POST /users/me/organizations/:id/switch` and
  `POST /users/me/organizations/clear-active-organization` re-mint a token pair and did not refuse impersonation. An operator's 5-minute
  impersonation token could call either, get back an ordinary 30-day refresh
  token with no `imp` claim, and keep a session as the end-user after the
  impersonation was ended: MFA skipped, nothing attributed to the operator. Both
  routes now answer 403 `IMPERSONATION_ACTION_FORBIDDEN`, and the service that
  mints every end-user pair refuses one requested from an impersonated session,
  so a future route cannot reopen it. Linking and unlinking an OAuth provider
  are refused the same way, since a linked identity signs in later.

- **Revoke-all now reaches MCP OAuth tokens.** An operator's password change or
  reset and sign-out everywhere revoked panel refresh tokens only. A stolen
  operator MCP refresh token kept minting hour-long `op_mcp_access` tokens,
  write scope included, and an already-issued one kept working until it
  expired. Revoke-all now revokes the operator's MCP refresh tokens in the same
  transaction, and the operator MCP endpoint and introspection refuse an access
  token issued before `sessionsInvalidBefore`. End-user MCP access tokens get
  the same check at the MCP endpoint, `/oauth/userinfo` and `/oauth/introspect`.
  A single-session revoke still leaves MCP connections alone.

- **A free plan's credits or licence can be claimed once per person, not once
  per organization.** `POST /billing/subscribe` reactivated a cancelled free-tier
  subscription for whatever beneficiary it was given, and credits and licences
  are keyed per beneficiary. A signed-in user could cancel, create an
  organization, activate again, and collect the plan's credits (or a new pooled
  licence) once per organization, with no limit. A free plan that materialises
  CREDIT or LICENSE is now claimable once per end-user per Application, recorded
  in a new `free_tier_claims` table that cancellation does not touch; another
  beneficiary gets `409 BILLING_FREE_TIER_ALREADY_CLAIMED`. Reactivating for the
  same beneficiary still works and issues nothing new. FEATURE and USAGE free
  plans are unchanged. Existing self-serve activations are backfilled as claims.
  Credits already issued are not clawed back.

- **Erasure now removes the person's address from email and webhook logs.**
  `DELETE .../end-users/:euid?erasure=true` tombstoned the end-user row but left
  the address in `email_logs.to_address`, in the new `email_suppressions` list, in
  the payloads of past `webhook_deliveries` (`user.created`, `password.changed`
  and others carry `email`) and in stored inbound billing receipts. The operator
  console kept showing it, and the new log archive would have uploaded it when the
  rows aged out.

  Erasure now tombstones the recipient, subject and any copy of the address in the
  error on the person's email log rows; deletes their suppression rows; rewrites
  `email`, device `fingerprint`, `metadata`, `label` and `description` in delivery
  payloads matched by the end-user id; and replaces the address in inbound
  receipts for that Application. Log and delivery rows, their status and counts,
  are kept. Nothing in another Application is touched. A new
  `(application_id, to_address)` index on `email_logs` keeps the update off a scan
  of the whole send history, and the erasure transaction timeout is now 60
  seconds. `docs/data-erasure.md` states what happens to rows archived before an
  erasure (they keep what they had; give the bucket its own retention).

- **A day-0 trialist is stored `TRIALING`, not `ACTIVE`.** `applyCheckoutCompleted`
  hard-wrote `ACTIVE` and never wrote `trialEndsAt`. Stripe's
  `customer.subscription.created` is not translated, and for a plain trial no
  `customer.subscription.updated` arrives until conversion, so the row read
  `ACTIVE` for the whole trial. Reported MRR sums `plan.amount` over
  `status: 'ACTIVE'`, so a 30-day trial on a $99 plan added **$99 of MRR on day
  zero against zero cash**.

  Both statuses are entitling, so what a trialist can DO is unchanged. What
  changes is that unpaid revenue stops being reported as revenue, and `TRIALING`
  (the status the Stripe mapper emits and the provider-switch refusal wording
  branches on) becomes reachable for hosted checkout again.

  `trialEndsAt` is now written from the days actually sent to the provider,
  taken from the trial ledger added in this release.

- **A seat override now reaches the licence.** `PATCH .../entitlement-overrides`
  with a SEATS quantity returned 200, echoed the new number and emitted
  `subscription.entitlements_updated`, while the licence went on refusing
  activations past the count it was issued with. The buyer paid for the seats and
  did not get them, and nothing reported the disagreement. Listed as a known issue
  in the 2.2.0 notes until now.

  The ceiling is reconciled from the write path, since that path never provisions
  and a provider-less subscription would otherwise never re-provision at all. It
  is computed as the **maximum** across every entitling subscription funding the
  pool, so one owner's renewal cannot lower a ceiling negotiated on another's:
  two owners can each hold a subscription on the same plan for the same
  organization, and both fund one pooled licence.

  Lowering a count does **not** revoke activations already in use. The next
  activation past the new ceiling is refused instead.

  `License` gains `entitlementKey`, defaulting to the empty string that existing
  rows and single-licence plans already use. A plan may carry more than one
  LICENSE entitlement, and both used to resolve to the same licence row, so
  whichever provisioned last silently overwrote the other.

- **A credit idempotency key is now scoped to the buyer.** `CreditLedger` was
  unique on `(applicationId, idempotencyKey)`, so a client-supplied key was
  treated as globally unique within the Application. But such a key names what
  is being paid **for**, not who is paying. The schema's own documented example
  is a lead id, and a lead identifies a lead, not a buyer.

  Two end users drawing down for the same lead sent the same key. The second
  found the first's ledger row, was told `applied: false`, **consumed for free**,
  and was handed another subject's `balanceAfter`. A shared work pool makes this
  the common path rather than an edge case.

  The uniqueness is now `(applicationId, subjectKey, idempotencyKey)`, matching
  what `UsageRecord` already does. Retries within one subject stay idempotent,
  which is what the key is for. **No action needed on upgrade:** widening a
  unique tuple can only be satisfied by data that already satisfied the narrower
  one, so the migration cannot fail on existing rows.

- **Buying the same one-off plan twice now delivers twice.** It charged twice
  and delivered once, permanently. The idempotency anchor for a provisioned
  purchase was the billing period, and a one-off plan (a credit pack, a
  perpetual licence) never gets a `currentPeriodEnd`, so both branches of that
  expression resolved to the same constant forever. The checkout upsert reuses
  one `(applicationId, endUserId, planId)` row, so the subscription id did not
  change either: the second purchase computed a ledger key identical to the
  first, the credit ledger saw the prior entry and applied nothing, and the
  balance never moved while a second SUCCEEDED payment was recorded.

  Nothing reported it. The webhook answered 200 and provisioning logged success.

  A one-off plan now anchors on the purchase (the provider checkout session)
  rather than on a period it does not have. Recurring plans are unchanged and
  still anchor on the period, which is what makes a renewal refill exactly once.

  This also changes a second case that was previously asserted as correct: a
  buyer who opens two checkout tabs for the same one-off plan and pays on both
  now receives both packs. It used to record both payments and grant one, so the
  operator kept the second charge and nothing surfaced the duplicate, and the
  payment is attributed to a subscription, so it never reached the
  unapplied-payment queue either. Two charges are two purchases; a buyer who did
  not mean to pay twice is made whole by refunding one.

  **If you sell credit packs, buyers who repurchased were charged and not
  credited.** Their payments are all recorded, so the affected purchases can be
  found by looking for more SUCCEEDED payments against a one-off plan than
  positive credit-ledger entries for the same buyer.

- **A personal subscription lookup no longer returns an organization's.**
  `endUserId` is required on every subscription, so an org-beneficiary row also
  carries the buying member's personal id. Two lookups filtered on `endUserId`
  alone and sorted newest-first, so an org purchase shadowed the buyer's own
  subscription: `getCurrentSubscription` (which callers cancel the result of, so
  a member cancelling their own plan could cancel the organization's) and the
  end-user MCP `get_subscription` tool, whose description says it answers for
  the signed-in user.

  Only affects deployments using org-beneficiary subscriptions where one end
  user both holds a personal subscription and is the buyer of record for an org:
  the ordinary shape of a team plan bought by its admin. The org-scoped
  lookups are unchanged.

- **Device security events are shown.** They were written with an application
  id but no workspace id, and the read path filtered on workspace, so the whole
  device audit trail was recorded and displayed nowhere.

- **An open-ended subscription grant cancels at period end.** With no period to
  schedule against, cancelling one ended it immediately.

- **The panel shows a change as soon as you save it.** Server actions
  redirected to the page the router had already cached, so the success banner
  appeared while the data did not move. Every mutation now invalidates the
  cache.

- **OIDC sign-in is bound to the issuer you configured.** A discovery document
  naming a different issuer is refused, ID tokens are checked for subject,
  issuer, audience and expiry (`OAUTH_ID_TOKEN_INVALID`), and discovery, token
  and userinfo requests connect only to addresses the SSRF guard approved.

- **End-user sign-in no longer reveals which accounts exist through response
  time.** Unknown addresses and password-less accounts are checked against a
  decoy hash, as operator sign-in already was.

- **The 16 KB metadata ceiling applies to every writer**, including
  organizations, plans, coupons, usage records, credit drawdowns and licences.
  Some of these were unbounded.

- **The super-admin plan-create route refuses a field it does not implement.**
  `POST /api/v1/admin/applications/:id/plans` builds SUBSCRIPTION plans, and its
  body schema silently dropped everything else. A caller asking for a LICENSE,
  USAGE or CREDIT plan got `201` and a subscription:
  `rekey plans create --kind LICENSE --credits-amount 500` reported success and
  created the wrong plan, with nothing to reveal it short of reading the
  pricing page. That body is closed now, so an unrecognised key, or a typo like
  `intervall`, answers `400 VALIDATION_ERROR` naming the field. Per-kind plans
  and `trialDays` are created on the tenant route,
  `POST /api/v1/tenant/applications/:id/plans`, which implements them.

- **The CLI no longer offers plan flags that cannot work.** `--kind`,
  `--license-kind`, `--license-duration-days`, `--license-seats-allowed`,
  `--meter-slug`, `--price-per-unit-cents` and `--credits-amount` are gone from
  `rekey plans create --help` and refused with `CLI_PLANS_KIND_UNSUPPORTED`,
  which names the panel and the tenant route, so a script written against the
  old contract gets an explanation rather than a wrong plan. Separately,
  **`rekey apps create` gains `--environment`** (`PRODUCTION`, `STAGING` or
  `DEVELOPMENT`): the admin route has always accepted the field and the CLI
  never sent it, so every Application it created was `DEVELOPMENT` with an
  `rp_test_` key.

- **Org-role changes now reach every API replica straight away.** The
  organization-role catalog cache never actually subscribed to its Redis
  invalidation channel: its only SUBSCRIBE was sent while the connection was
  still opening and was refused, so a role edit on one replica reached the
  others only when their 5 second cache expired. It now subscribes on every
  connect and reconnect, and serves nothing from cache while it is not
  subscribed.
- **One operator no longer rate-limits the whole panel.** The global limiter
  keyed operator requests on the IP they arrived from, which in Docker is the
  panel container for every operator, so the whole team shared 100 requests a
  minute and a single operator hit `429` within a few pages. It now keeps one
  bucket per secret API key (6000/min, `RATE_LIMIT_API_KEY_MAX`), per operator
  or signed-in end user (600/min, `RATE_LIMIT_AUTHENTICATED_MAX`), and only
  falls back to the client IP (100/min, `RATE_LIMIT_MAX`, unchanged) when the
  request has no identity. See [docs/rate-limits.md](docs/rate-limits.md).
- **Operator sign-in limits key on the operator's real IP.** Both self-host
  compose files now trust the panel's and portal's forwarded client IP, and
  only theirs: the two containers sit at fixed addresses on a private
  `rekey-edge` network (`REKEY_EDGE_SUBNET`, `REKEY_PANEL_EDGE_IP`,
  `REKEY_PORTAL_EDGE_IP` if the default subnet collides). Before, one person
  spraying the login page could exhaust the panel's shared bucket and lock
  every operator out. Sign-in limits themselves are unchanged. If you expose
  the panel with no proxy in front of it, set `TRUSTED_PROXIES=false`.
- **The API recognises your proxy by a shared secret.** Traefik sends
  `API_PROXY_SECRET` as `X-Rekey-Proxy-Secret` (a label in the compose files),
  and only then is `X-Forwarded-For` believed (`API_PROXY_HOPS` from the right;
  2 with a CDN that Traefik trusts). Without it, traffic through an
  unidentified proxy is never blocked by IP and falls back to per-key,
  per-account and per-Application limits; the API logs this at boot. Required
  in `docker-compose.api.yml`, which no longer trusts a hop count.
- **The hosted portal forwards the visitor's address** only for requests that
  carry `PORTAL_PROXY_SECRET` (added by Traefik) with
  `PORTAL_TRUSTED_PROXY_HOPS` set, so the API's per-IP limits count visitors
  rather than the portal. Its API calls now time out after 10 seconds.
- **Change password and the passkey step-up are credential routes.** They cap
  at 10 per minute per account and address, and a wrong password on either
  counts toward the account lockout like a failed sign-in. End-user sign-up caps at 10
  per minute per Application and address, `send-verification` at 10.
- **Rejected credentials are counted.** More than 100 401s a minute from one
  client IP (`RATE_LIMIT_AUTH_FAILURE_MAX`) refuses the address before any
  credential is checked, except for a verified secret key, and all operators
  and end users seen from one IP share a 3000/min ceiling
  (`RATE_LIMIT_AUTHENTICATED_IP_MAX`). Both apply only to an address that is
  the client's, never to a shared proxy.
- **`INTERNAL_CALLER_SECRET`** lets the panel and portal prove their calls
  when they reach the API through its public origin (the split Dokploy
  units): they send it as `X-Rekey-Caller-Secret`, and the API believes the
  one visitor address they send as `X-Rekey-Client-Ip`. Required in `docker-compose.api.yml`,
  `docker-compose.panel.yml` and `docker-compose.portal.yml`; see the Cloud
  checklist and admin-lockout recovery in DEPLOY.md.
- A blocked address is refused before any lookup except for a secret key that
  has already verified and is not revoked; the client address is decided before the first log
  line, and forwarded host and scheme are ignored unless the proxy sent them.
- `RATE_LIMIT_USAGE_MAX` now defaults to the per-key budget (6000) instead of
  1000.
- `POST /api/v1/tenant/auth/refresh` has its own per-IP bucket (60/min,
  `RATE_LIMIT_REFRESH_MAX`), and `GET /api/v1/portal/config/:slug` keys on the
  slug and client IP, with a per-IP ceiling across slugs.

- **The operator panel no longer freezes or errors when switching tabs under
  load.** Links no longer prefetch (21 background server renders on the first
  load of an end-user page, and one `GET /applications/:id` per card on
  `/applications`), and the end-user tabs, email sub-tabs and account pages
  show a loading skeleton on every switch. With prefetching on, 5 of 27 tab
  clicks in a headless run never committed; with it off, none did.
- **A save refreshes stale pages exactly once.** The refresh after a server
  action is tied to that action, fires even if the operator has already moved
  to another tab, waits until nothing on the landing page is still loading,
  and is fired again when Next discards it, at most three times in all. It could previously be
  discarded, leaving a pre-save render on the next tab.
- **A busy API is shown as busy.** A 429 or 503 now renders "The Rekey API is
  busy" with a countdown and a bounded automatic retry that honours
  Retry-After, instead of "Something went wrong" or an empty list that looked
  like real data. A 429 on the session refresh no longer signs the operator
  out. (A 503 there still does: the API may already have spent the token.)
- The authed layout fetches the operator and the workspace creation mode in
  parallel, and caches the creation mode for five minutes.

### Security

- **Credential routes cap their own request body** before it is read or
  rate-limited. See **Breaking changes** for the `413 PAYLOAD_TOO_LARGE` it
  answers.

- **The panel no longer forwards a client-chosen IP to the API.** With no
  proxy in front, a browser's own `X-Forwarded-For` became the address the
  API rate-limits operator sign-in and token refresh on. New
  `PANEL_TRUSTED_PROXIES` (default `0`) says how many proxies to believe, and
  the header is believed only when the proxy also presents
  `PANEL_PROXY_SECRET` as `X-Rekey-Proxy-Secret`, so a sibling container or a
  published port cannot pick the address either. Otherwise the panel reports
  the connection's address. **`docker-compose.prod.yml` now requires
  `PANEL_PROXY_SECRET`** and wires the Traefik header; the hosted panel
  compose uses 2 hops (Cloudflare, then Traefik).
- **The panel can prove its forwarded client IP to the API.** With
  `INTERNAL_CALLER_SECRET` set, every server-side panel call to the API carries
  it as `X-Rekey-Caller-Secret`, with the visitor's address in
  `X-Rekey-Client-Ip` when the panel validated one (omitted otherwise, never
  the panel's own address). The API can then believe it even when the call
  goes through a public origin. Optional; the panel and the API must share the
  value.

### Removed

- **A FEATURE override of `""` is refused** with
  `ENTITLEMENT_OVERRIDE_INVALID`. An empty string survives parsing but every
  `if (features.x)` gate reads it as absent, and a plan cannot carry one, so it
  was the one shape this module accepted while the resolver ignored it. Send
  `null` to remove an override.

- **A quantity on a licence with no seats is refused** with
  `ENTITLEMENT_OVERRIDE_INVALID`, where it was previously accepted. A licence
  quantity is its seat count; on a PERPETUAL or TIMED row no Rekey code reads it,
  so it was stored, reported sold, and delivered nowhere.

  It **is** on the wire (`quantity` appears in the resolved entitlement array
  and in `subscription.*` webhook payloads), so if you provision against it for a
  non-SEATS licence, that write path is now closed and the plan's `licenseKind`
  needs to be SEATS. Removing such an override still works: `null` deletes.

## 2.1.0

A minor release. Additive: nothing that worked in 2.0.0 stops working. Four
things to know before you take it:

- **TypeScript.** `OrganizationRole` widens from a three-value union to
  `string`, so an exhaustive `switch` over it now needs a default case. The
  three-value type is still exported, as `OrganizationBaseRole`.
- **Billing credential edits.** `PUT /billing-credentials/:provider` now
  distinguishes an ABSENT field from a field sent as an empty string. Absent
  keeps the stored value; empty still clears it. If you were relying on a
  partial body to blank the fields it omitted, it no longer does that.
- **Free trials are held.** A plan cannot carry `trialDays` in this release: a
  non-zero value is refused with `PLAN_TRIAL_UNAVAILABLE`, on the REST routes and
  through MCP alike. The field became writable during this cycle and two release
  reviews then found two ways it loses money, so it is held rather than shipped:
  a trial can currently be taken repeatedly by the same buyer, and a plan
  carrying both a trial and a CREDIT or LICENSE entitlement hands those over
  before the first payment. Setting it to `0`, and creating plans without it,
  are unaffected. `docs/specs/trial-eligibility.md` tracks what has to exist
  first.

- **Webhook event names.** `subscription.entitlements_updated` joins the
  catalog. `WebhookEventType` is an open string union so it keeps compiling, but
  an exhaustive `switch` over `z.infer<typeof WebhookEventTypeSchema>` gains a
  case. Nothing is delivered to an endpoint that has not subscribed to it.

### Added

- **An application can be promoted to production, and frozen when you would
  rather delete it.** `environment` stops being write-once: `POST
  /tenant/applications/:id/promote` moves DEVELOPMENT or STAGING to PRODUCTION,
  one way and once. Keys minted beforehand keep their `rp_test_` prefix and keep
  working, because the prefix is a label rather than a gate; revoking them would
  break an integration at the moment it went live.

  `POST /tenant/applications/:id/disable` is the reversible freeze standing in
  for the delete Rekey does not have. A disabled application refuses all
  end-user traffic at both API-key middlewares, serves no hosted portal, and
  dispatches no webhook, transactional email or dunning escalation, while every
  operator surface stays readable, because a freeze you cannot see into is a
  freeze you cannot undo. Nothing is deleted and `tokenGeneration` is untouched,
  so a token issued before the freeze still works after it.

  The two share one invariant: PRODUCTION-and-not-disabled applications must
  never exceed `maxProductionApps`. A disabled production application stops
  counting, which is what makes disable a usable substitute for delete, and
  re-enabling one consumes a slot and can be refused. All three doors into that
  count take a per-workspace advisory lock, because check-then-act let
  concurrent creates walk past the limit.

- **Per-subscription entitlement overrides.** `PATCH
  /tenant/applications/:id/subscriptions/:subId/entitlement-overrides`
  (billing-write) writes `Subscription.entitlementOverrides` as a sparse merge,
  with `null` removing an override. This is how you sell one customer a bespoke
  deal without minting a plan for one buyer.

  `entitlementOverrides` decided what a subscription granted and was read in
  five places and written in none, so the documented remedy for a negotiated
  allowance required SQL against production.

  Overrides merge over the plan's rows on every resolve, so FEATURE flags and
  USAGE allowances change at once. **Already-materialised grants do not
  backdate**: CREDIT is granted once per period against an idempotency anchor,
  so raising an allowance mid-period applies at the next renewal, and a licence
  already issued keeps the `seatsAllowed` it was issued with.

  New webhook event `subscription.entitlements_updated`, emitted only when the
  resolved entitlements actually change.

- **The applications list says which applications are not serving anyone.**
  Every row rendered identically apart from its environment, so "which of these
  is actually live?" meant opening each one. Rows now carry a badge when an
  application is disabled, when nobody can sign in (no auth method and no OAuth
  provider), or when a hosted portal is pinned to a DNS-unverified custom
  domain. Configuration is deliberately not badged: `invite_only` and
  `secret_only` are postures a whole workspace adopts, and badging them would
  chip every row while distinguishing none.

- **Organization roles are now a per-Application catalog, not a fixed enum.**
  `OWNER` / `ADMIN` / `MEMBER` are still there, seeded on every Application and
  undeletable, but an operator can now define their own names against a base tier:

  ```json
  { "name": "content-manager", "baseRole": "MEMBER", "description": "Drafts and edits content" }
  ```

  Rekey enforces the **tier**, never the name. A `content-manager` on tier
  MEMBER can do exactly what MEMBER can; the `canManage` ladder, the last-OWNER
  guard and the org-scoped billing writes all read `baseRole`. What the name
  means beyond that is your application's business.

  Authoring the catalog is operator-only (panel → Application → Organizations,
  `POST /tenant/applications/:id/organization-roles`, or the new
  `create_organization_role` / `update_organization_role` /
  `delete_organization_role` MCP tools; requires
  `authConfig.organizationsEnabled`). **Assigning** a role is unchanged and
  still belongs to the organization: an OWNER/ADMIN does it with their own
  end-user token via `PATCH /users/me/organizations/:id/members/:euid`.

- `GET /api/v1/users/me/organizations/roles` returns the assignable role names on
  the end-user credential, so an org-admin UI can populate a role picker.
  `rekey.organizations.listRoles()` in the Node SDK.

- `GET /api/v1/users/me/` and `GET /api/v1/auth/me` now also return
  `activeOrganizationRole` and `activeOrganizationBaseRole`. Both are null with
  no active organization, or when membership lapsed since the token was minted.

- An invitation may now **omit** `role`, in which case it lands on the
  Application's default organization role.

- Organization-role changes are audited: `app.organization_role_created`,
  `app.organization_role_updated`, `app.organization_role_deleted`.

- `ORGANIZATION_ROLE_RETIER_ORPHANS_OWNERS` (409) refuses moving a custom role
  off the OWNER tier while some organization's only owner holds it. A re-tier
  changes no membership row, so the per-member last-owner guard never runs;
  without this an operator could leave organizations with nobody able to manage
  members or authorize a charge.

### Fixed

- **An entitlement override could not un-cap a metered plan.** Quantity was
  validated with `Number.isFinite` and nothing else, so four values stored
  happily and then did the wrong thing at resolve time.

  The worst was a USAGE quota of `0`. Included quota only counts as a cap when
  the quantity is above zero **or** the row carries a `creditsPerUnit`; an
  unpriced hard cap overridden to `0`, which reads as "no free units", has
  neither, so the resolver reported the meter as unmetered. Tightening a plan
  removed its limit.

  Also refused now: a negative quantity, which did the same; a fraction or a
  value past 2147483647, which stored here and then threw against the 32-bit
  column inside provisioning at the *next* renewal, surfacing weeks later as a
  retrying 500 on the renewal webhook; and a CREDIT quantity of `0`, which did
  not mean "no credits this period" but "the grant never runs".

  Every one of these was already refused for a *plan*. The override path now
  delegates to the same per-kind validator rather than restating its rules, so
  the two cannot drift again.

- **Four error strings sent operators into a refusal.** A registered plan's
  price is immutable, so changing it means archiving the plan and creating a
  replacement. `PLAN_PRICE_IMMUTABLE`'s fix, the MCP `set_plan_active` and
  `update_plan` tool descriptions all said exactly that and none of them
  mentioned that the replacement needs a **different slug**, because archiving
  deliberately does not release the old one. Following any of them literally
  ended in `PLAN_SLUG_TAKEN`. An MCP agent following the tool text hit it every
  time.

  All four now name the slug requirement. `PLAN_SLUG_TAKEN`'s own archived-case
  fix was half wrong in the other direction: it offered "reactivate and edit it
  in place", which cannot change a price on a registered plan, which is the
  usual reason for wanting a replacement. It now says so.

- **A modal no longer discards what you typed when you click outside it.**
  Every panel dialog closed on any backdrop click, so a stray click next to the
  card threw away a half-filled form with no warning and no undo. A dialog you
  have started filling in now ignores the backdrop, and Esc asks before
  discarding. An untouched dialog still closes on both, and the close button
  always closes.

- **Editing a billing provider no longer forces you to retype its secret.**
  Stored credentials are encrypted and never sent to the panel, so every input
  in the edit dialog renders empty; submitting it overwrote each stored value
  with an empty string and was rejected, which meant changing a webhook URL
  required fetching the API key from the provider dashboard again. The dialog
  said "leaving a secret blank keeps the existing value" and could not do it.

  Now it can. A field omitted from the request keeps its stored value; a field
  sent as an explicit empty string is still cleared. First-time configuration
  still requires every field, a supplied key still rotates, and a
  carried-forward value still faces the provider's pattern check.

  Two consequences worth naming, both of which the first attempt at this got
  wrong. A partial edit no longer relabels the account's mode: for a provider
  whose keys do not state their environment (PayPal), an edit that omitted
  `mode` would have marked a live account as sandbox and pointed every call at
  the sandbox host. And non-secret fields are carried forward too, so a partial
  edit no longer drops PayPal's `webhookId` and 503s every inbound webhook.

- Two concurrent member changes can no longer both pass the last-owner guard.
  The guard counted owners and then wrote, so two demotions racing on an
  organization with exactly two owners both saw two, both passed, and both
  committed, leaving zero. Guard and write now run in one transaction behind a
  row lock.

### Performance

- The organization-role catalog is cached per Application on a short TTL, with
  every write invalidating it after commit. It was read on nearly every
  org-scoped request despite being operator-authored and near-immutable.
  Membership rows are not cached, so a role change for a PERSON still takes
  effect immediately.

### Changed

- **The panel, portal and admin test suites now run in CI.** All three have had
  a vitest suite for as long as they have existed and none of them had ever run:
  the filter listed only `packages/*` and two apps, and the job was gated on
  areas a front-end change does not touch, so such a pull request showed
  `Test: SKIPPED` beside a green `CI: SUCCESS`. Nineteen files were enforced by
  whoever remembered to run them locally. Self-hosters running the workflow get
  the same coverage.

- **`OrganizationMembership.role` and `OrganizationInvitation.role` are now
  strings**, holding a catalog name. Every previously valid value still spells
  the same and still works, so no stored data changes. TypeScript consumers that
  switched exhaustively over the old
  `OrganizationRole = 'OWNER' | 'ADMIN' | 'MEMBER'` union will now see a
  `string`: handle the default case. The old union is still exported, as
  `OrganizationBaseRole`, and remains the right type for the tier.

- The end-user role catalog is renamed **application role**. The model is
  `ApplicationRole`, the table `application_roles`, and the operator route
  `/tenant/applications/:id/application-roles`. The old `/end-user-roles` path
  still works. The public `EndUser.role` field and the `END_USER_ROLE_*` error
  codes are **unchanged**: they are wire contract.

  The rename exists because there are now two role axes and the old name said
  nothing about which one it governed. `EndUser.role` is app-wide: one value
  per (Application, end-user), identical in every organization that user belongs
  to, and Rekey never acts on it. `OrganizationMembership.role` is per
  (organization, end-user), and is the one Rekey enforces. See
  [docs/auth.md → Roles](docs/auth.md#roles-two-axes-and-which-one-you-want).

## 2.0.0

The first stable release. The release-candidate series ends here; `latest` on
npm now points at a stable version rather than an RC.

Everything below landed after rc.9. Two of them are behaviour changes an
existing rc integration can notice, and they are listed first for that reason.

### Changed

- **An Application now bills individuals OR organizations, never both.**
  `billingConfig.billingSubject` already decided this, but only one direction
  was enforced: an org-subject Application refused a checkout with no
  organization, while a user-subject one quietly ACCEPTED an `organizationId`
  and wrote an org-billed subscription beside the personal ones. Because
  `Subscription` is unique on `(applicationId, endUserId, planId)` with no
  beneficiary in the key, those two rows are one row, and whichever arrived
  second silently replaced the other while the subscription it replaced kept
  billing at its processor. A user-subject checkout that names an organization
  is now refused with `BILLING_ORGANIZATION_NOT_ACCEPTED`.

  If you were passing `organizationId` into a user-subject Application, switch
  that Application to `billingSubject: 'org'` or drop the parameter. Changing
  the subject is refused while subscriptions of the other subject are live
  (`BILLING_SUBJECT_CHANGE_BLOCKED`), because flipping it would strand them.

- **A succeeded Razorpay payment that matches no local subscription is now
  recorded.** It used to be dropped entirely: no `Payment` row, no log, no
  trace of the money anywhere. Operators running Razorpay should expect the
  first look at the new unapplied-payments queue to surface historical charges
  that were previously invisible.

### Added

- **Refunds, across Stripe, PayPal and Razorpay.** `refundPayment` on the
  provider interface, paired with a `capabilities.refunds` declaration so a
  provider that cannot refund says so rather than failing when an operator
  presses the button. Partial refunds are supported everywhere. Note that no
  provider returns its fee on a refund, so a refund costs the operator the
  original processing fee.

- **Unapplied payments: a queue for money that arrived for something Rekey
  never applied.** Usually a checkout that completed at the provider after
  Rekey stopped waiting for it, which means the customer most likely paid for
  something they expect to receive. Rekey never refunds these automatically;
  the operator decides between refunding, keeping the money and extending the
  customer's access, or closing the case with a note. Ordered oldest first,
  because refund windows close (PayPal at 180 days, Razorpay at six months)
  while card-network dispute windows stay open. Panel → Application →
  Unapplied, plus `GET/POST /api/v1/tenant/applications/:id/unapplied-payments`.

### Fixed

- **Concurrent checkouts could reach two processors.** The provider binding was
  read-then-act with nothing holding the two together, so two overlapping
  checkouts by one buyer both read a state in which nothing bound them and both
  proceeded. Measured: two concurrent checkouts on different plans naming
  different processors both returned 200 and left the buyer billable by Stripe
  AND PayPal. The binding decision is now serialised per buyer. The
  second-completion guard had the same shape and is now stated as a write
  predicate, so two completions arriving at once cannot both win.

- **Every Server Action answered 500 when the browser sent a malformed
  `Origin`.** Next reads the header with `new URL()` guarded only by a
  `typeof` check, and a browser sends the literal string `"null"` from an
  opaque origin — a sandboxed iframe, or a form POST that followed a
  cross-origin redirect. The action failed before any application code ran, so
  nothing saved, and because it never resolved the submit button sat on
  "Saving…" until the page was reloaded. Reported against the panel's OAuth
  provider form; it affected every Server Action in the panel, marketing,
  portal and admin.

- **The account funnel pages were never centred.** Sign-in, sign-up,
  forgot-password, reset, verify, account, error and not-found all capped their
  width without centring, so on any wide viewport the form sat against the left
  gutter.

- **The OAuth redirect URI field said the wrong thing.** It is the operator's
  own application callback, never a Rekey URL: the provider redirects the
  browser to their server, which then hands Rekey the code. The hint now says
  so, and warns that the provider compares the string byte for byte.

### Known issues

- Passkeys remain unavailable. The WebAuthn routes, SDK helpers and storage are
  built, but there is still no way to configure the relying party from the
  panel or the API, so no deployment can turn them on.
- A sign-in page cannot discover which OAuth providers an Application has
  configured; the consuming app must also carry the list in its own
  environment. Tracked as #463.

## 2.0.0-rc.9

Everything below was found the way rc.8 said it would have to be: by running
the product signed in, against a live deployment, and clicking. The suite was
green for every one of them.

Still a release candidate. The panel has not had a full signed-in click-through
of its mutation paths (see Known issues).

### Fixed

- **An API-key rejection now names the deployment that rejected it.** Keys
  belong to the deployment that minted them, and the commonest integration
  mistake is pointing half a configuration at one deployment and half at
  another — a server `REKEY_URL` still on localhost while the browser's
  `NEXT_PUBLIC_REKEY_URL` has moved to Cloud. The old message listed three
  states the key might be in and never mentioned the one thing that decides it:
  where it was checked. `API_KEY_INVALID` and `PUBLISHABLE_KEY_INVALID` now name
  the origin and say a key from another deployment is unknown here. Reported by
  a user who could not find which URL to use (rekey-dev/rekey#29), which the
  new `docs/api-url.md` answers.

- **Plans can be edited from the panel.** `plansService.update`, the REST
  `PATCH` and the `update_plan` MCP tool all shipped, so an agent could correct
  a plan while the operator who created it could not — the table offered only
  Entitlements, Archive and Reactivate. A plan created with a typo or a missing
  price had to be archived and re-created under a different slug. There is now
  an Edit action; it renames always, and edits the price only while no provider
  price exists, because a minted provider price is immutable and the API
  refuses to change it. That makes it the repair path for a plan whose
  registration FAILED. Reported as rekey-dev/rekey#30.

- **A duplicate-slug refusal says when the holder is an ARCHIVED plan.**
  Archiving flips `active` and keeps the row, so the slug stays reserved, and
  "a plan with that slug already exists" sent operators looking for a plan they
  believed they had removed. The message now says the existing plan is archived
  and the fix names both ways out: reactivate and edit it, or choose a
  different slug. The slug is deliberately not released — it is the public
  identifier integrations pass to checkout and read back off a subscription, so
  reusing it would silently change what an existing caller's `pro` means.

- **A buyer who already pays through one processor can no longer be checked
  out through another.** `Subscription.provider` is immutable for a row's
  lifetime, so a second checkout somewhere else never produced a changed
  subscription. It produced a SECOND one and two charges a month, with nothing
  in either processor's dashboard hinting at the other. The guard that existed
  keyed on (application, end-user, PLAN), so it only fired on re-buying the
  identical plan and missed the ordinary path: subscribed to `basic` through
  PayPal, upgrade to `pro`, get routed to Stripe. Checkout now resolves the
  processor the buyer is already on across the whole Application, before the
  geo router runs, and matches both the billing subject and the row the upsert
  will write (they are keyed differently, and an org checkout could otherwise
  rewrite a personal row's `provider` while leaving the other processor's
  subscription id on it). A `provider` that disagrees is refused with
  `BILLING_PROVIDER_SWITCH_BLOCKED`; a checkout that named none is pinned to
  the bound processor instead of being left to drift. One-off purchases
  neither bind nor are bound, since a credit pack or a perpetual licence is a
  single charge that creates no second billing relationship, while TIMED
  licences recur and stay guarded. A subscriber whose processor the operator
  has since disabled now gets `BILLING_BOUND_PROVIDER_UNAVAILABLE`, which
  names re-enabling it or cancel-then-rebuy rather than telling them to omit a
  `provider` they never sent.

- **Opening a checkout could move a live subscription to a different billing
  subject.** `beneficiaryOrgId` is not part of the `Subscription` uniqueness
  constraint, so a personal subscription to `pro` and an org-billed one to
  `pro` for the same buyer are one row. An owner of two organizations who
  opened a checkout for a plan the FIRST one already held rewrote that row:
  200 OK, still `ACTIVE`, still carrying the first organization's provider
  subscription id, now billed to the second. The first lost the entitlement,
  the second had it for free, the processor kept charging, and no payment was
  involved. A guard on the provider had been covering this by accident, and
  only when the geo router disagreed; pinning made the two agree by
  construction and removed the cover, so the refusal is now stated —
  `BILLING_SUBSCRIPTION_SUBJECT_CONFLICT`. It protects a LIVE subscription
  only: a checkout nobody completed can still change subject, because refusing
  there would tell a buyer to cancel something that does not exist.

- **Two checkout sessions on one subscription could both be completed.** One
  row deliberately carries several completable sessions, and checkout
  deliberately lets the second be opened at a different processor — but
  nothing stopped both being paid. `applyCheckoutCompleted` had no
  second-completion check and `ACTIVE → ACTIVE` is an allowed transition, so
  the second completion overwrote `providerSubId` and the first provider-side
  subscription became unreachable: cancel could not find it and it billed
  forever. The second completion is now refused, and the subscription it
  created is recorded on the row (`metadata.unappliedCompletions`) so an
  operator can find and cancel it. Relatedly, `Subscription.provider` is
  written by checkout before anybody has paid, so a buyer who opened Stripe,
  went back, opened PayPal and then paid at Stripe left the row naming one
  processor and carrying the other's id — which is the column `cancel` dials.
  The completion now stamps the processor whose session actually completed.

- **A provider-binding refusal could name a provider nobody can use, or tell a
  buyer to cancel something they never bought.** Three faults in the wording
  and ordering of the two refusals above, all reachable by an ordinary buyer.
  Landed after `v2.0.0-rc.9` was tagged, so the published rc.9 does not carry
  them; they ship with whatever release follows it.

  The switch refusal was decided before the router had looked at availability,
  so a subscriber bound to a DISABLED provider who named another one was told
  to check out through the disabled one. Availability is now settled first,
  whether or not the caller named a provider.

  Its remedy did not distinguish credentials that are disabled from
  credentials that were deleted. Cancellation dials the processor, so with the
  credentials gone a buyer whose row carries a provider subscription id can
  neither buy nor cancel; a checkout nobody finished carries no such id and
  stays cancellable either way. The two states now get different instructions.

  And a started checkout binds just as a subscription does, but was described
  as one ("already pays", "cancel the existing subscription") to somebody who
  had never paid. Both refusals now name an unfinished checkout for what it is,
  and say that no completed payment has been RECORDED rather than that nothing
  was charged, because a paid checkout whose webhook was lost sits in exactly
  that state. That wording is keyed on the row having no provider subscription
  id as well as being PENDING: Stripe's `paused`, and every status the codebase
  does not recognise, also map to PENDING while keeping the id, and those rows
  are paid. A trial gets its own wording on both refusals for the same reason.
  The portal and the marketing checkout repeated the assumption and were
  corrected.

  Two consequences worth knowing. A checkout by a buyer bound to an Application
  with no enabled providers at all now answers `409
  BILLING_BOUND_PROVIDER_UNAVAILABLE`, naming the provider that buyer actually
  uses, where it previously answered `400
  BILLING_CREDENTIALS_NOT_CONFIGURED`, which named whichever provider
  `billingConfig` mentioned and could be one the buyer has no relationship
  with. And the unfinished-checkout remedy deliberately quotes no duration: the
  24-hour window is measured from `updatedAt`, so re-opening the same checkout
  restarts it, and a number there would be a promise the code does not keep
  (rekey-dev/rekey#438).

- **A plan created before its billing provider was silently un-checkoutable.**
  Plans register with the provider at creation time, so a plan created before
  its Application had credentials has no price behind it, and connecting a
  provider afterwards does not reach back and repair it. Nothing surfaced that:
  the plan listed, it was `active`, `registrationStatus` read `NOT_REQUIRED`,
  and the first thing that disagreed was a buyer clicking Buy and getting a
  409. Providers now answer `planCheckoutBlocker()`, plans carry
  `checkout.ready`, the panel warns on both the Billing and Plans tabs, and
  `register_plan_with_provider` over MCP performs the repair.

- **`RekeyProvider` treated any failed session refetch as a signed-out user.**
  `catch { setUser(null) }` meant a CORS failure from a non-allowlisted origin
  flipped `useUser()`, `<SignedIn>` and `<SignedOut>` to signed-out the instant
  the page hydrated, on a page that server-rendered signed-in. The same shape
  turned any transient API outage into a fleet-wide sign-out. Only 401 and 403
  clear the user now.

- **The panel could hang on a blank page for five minutes.** No request carried
  a deadline, so a stalled fetch sat on undici's default. That is invisible on
  a page load and not invisible after a mutation, because Next renders `null`
  for the page subtree while a server action's redirect is in flight. Reads now
  time out at 15s, writes at 30s, the refresh exchange at 10s. A timed-out
  write reports that it MAY have applied, because we stopped listening, which
  is not the same as it not happening.

- **`SubscriptionDto` did not say which processor holds the subscription.** It
  carried `providerSubId` and not `provider`, which is an id belonging to
  nobody. `provider` is now on the DTO.

- **`ProvidersListDto` and `BillingProviderInfoDto` are exported from
  `@rekey.dev/node`.** `billing.getProviders()` returns the former and the
  package already imported it; the public export block omitted it.

- **`@rekey.dev/astro` no longer falls back to `https://api.rekey.dev` when
  `REKEY_URL` is unset — BREAKING.** The fallback did not fail: it sent every
  request this SDK makes to Rekey Cloud, carrying the deployment's
  `REKEY_SECRET` in an `Authorization` header, and on the session calls the
  **end-user's refresh token** (`auth.refresh`, `auth.signOut`) and **access
  token** (`getCurrentUser`) as well. The requests die there because the key is
  unknown at Rekey Cloud, so the only symptom was a puzzling 401 — by which
  point the credentials had left the operator's infrastructure.
  `@rekey.dev/node` and `@rekey.dev/nextjs` have always required the value; the
  three now agree, and the refusal names the Cloud, self-hosted and local
  answers. This SDK arrived after the pass that removed every other Rekey-owned
  default and reintroduced the pattern.

  **If you self-host with `@rekey.dev/astro` and never set `REKEY_URL`: set it,
  rotate that secret key, and treat any end-user session live during that
  period as disclosed.** `^2.0.0-rc.8` matches `2.0.0-rc.9`, so a lockfile
  refresh alone picks this up — deliberately, since it now fails loudly with
  the value it needs named in the message.

- **A self-hosted deployment's own `/docs` no longer advertises our API as a
  server.** The OpenAPI document hard-coded `https://api.rekey.dev` and
  `http://localhost:3030` in `servers`, which every deployment then served from
  its own Swagger UI. "Try it out" posts to the selected server, so an operator
  pasting their own key into their own docs page sent that credential to a host
  they never chose — the same shape as the astro fallback above, on a surface
  where the credential is typed in by hand. It now lists that deployment's own
  `API_URL`, and only that.

### Changed

- **The drop-in components look like Rekey.** Flat and editorial: 2px radii,
  squared badges and avatar, the user menu on a hairline instead of a drop
  shadow, uppercase letter-spaced badges, and the current plan marked with a
  solid rule rather than a tint.

- **Control radii no longer derive from the surface radius by subtraction.**
  A 2px surface radius made every input and button `calc(2px - 4px)`. Controls
  read `--rekey-radius-control`, exposed as
  `appearance.variables.borderRadiusControl`, which **defaults to whatever
  `borderRadius` is set to**. An integrator who set only `borderRadius` (the
  one knob the docs teach) keeps getting it applied to both, so upgrading
  changes nothing they did not ask for.

- **Every SDK now says which URL to use.** `apiUrl` / `REKEY_URL` is required
  and has no default, but the errors said only that it was required, and the
  READMEs showed `https://api.rekey.dev` labelled "Your Rekey deployment" —
  which reads as a placeholder, so a Rekey Cloud customer had nothing to go on.
  The missing-value errors in `@rekey.dev/node`, `@rekey.dev/nextjs` and
  `@rekey.dev/astro` now name the Cloud host, the self-hosted answer and the
  local one, and [docs/api-url.md](docs/api-url.md) covers it in full —
  including that Cloud is a single origin for every workspace, scoped by API
  key rather than by hostname, and how to verify an origin with `/health`
  before wiring any keys.
### Security

- **The four MCP read tools that live in the operator write-tool set enforce
  per-application grants.** `list_plans`, `list_plan_entitlements`,
  `list_usage_meters` and `list_api_keys` are declared next to the write tools
  but carry no `write`, `admin` or `minRole`, so the dispatcher's role gate does
  not apply to them — and they resolved their Application through a helper that
  checked the workspace and not the caller's grants. A workspace MEMBER with
  zero grants could read the plan and pricing catalogue, and API-key metadata,
  for every Application in the workspace. The REST routes enforce grants and so
  does the read-tool set; this file was the seam between them. No credential was
  exposed (the key hash is never returned) and nothing crossed a workspace
  boundary. The check is now applied to every app-targeted tool in the file, not
  only the reads, so a tool that grows a write later cannot forget to opt in.

### Known issues

- **A `Subscription`'s uniqueness constraint does not include
  `beneficiaryOrgId`**, so a personal subscription and an org-billed one for
  the same (end-user, plan) are the same row, and one buyer cannot hold one
  plan for two organizations at once. Checkout refuses rather than overwrites,
  but the refusal is the mitigation, not the fix: a checkout that is still
  PENDING can change subject, which means the earlier subject's session can
  still be paid after the row has moved. Flagged in `ORG_BILLING.md` §5,
  tracked as #431.

- **Fastify response schemas are documentation, not enforcement.** A route can
  emit fields its OpenAPI does not promise; `GET /billing/subscription` returns
  the raw row.

## 2.0.0-rc.8

The release that a security audit, an architecture review and three senior
review passes were spent on. Every fix below was found by reading the code
adversarially or by running it — none by the test suite, which was green
throughout.

Still a release candidate for one reason: nothing here has been exercised
against a live deployment by a real signed-in user. The starter kits shipped
green and were still broken; that lesson has not been paid for twice.

### Security

- **A publishable key could have us email a live login token to any domain.**
  The reset, magic-link and verification routes took a `{token}` URL template
  from the caller and rendered it into a link in a message we send — our
  branding, our SPF/DKIM — validated only for being parseable. The publishable
  key is public by design and served unauthenticated. So anyone could have us
  mail a victim a genuine, correctly-branded, deliverable email whose button
  carried a live single-use session token to a domain they controlled. One
  click was account takeover, and every signal a careful user checks said the
  mail was legitimate, because it was. `authConfig.redirectUrls` already
  existed for exactly this and was enforced nowhere; it is an origin allowlist
  now, failing closed.
- **Live auth tokens were being sent to Google Analytics.** The panel mounted
  analytics in the root layout with no `page_location` override, so GA4
  received the full URL — including `reset-password?token=`, `accept-invite`
  and `mfa-verify?challenge=`. The compose file also defaulted the measurement
  id to Rekey's own property on a self-hosted console.
- **An operator PAT ignored role demotion.** A token minted by an admin kept
  full workspace power after that person became a member, including minting
  Application secret keys — durable credentials outliving the token. Scopes
  bound what a token may do; they cannot say whether its holder is still
  allowed to do it.
- **The per-Application auth ceiling was per-IP, always.** It keyed on a field
  a parent hook could never see, so no aggregate per-Application cap existed:
  one password sprayed across many accounts from rotating IPs was bounded only
  per IP.

### Billing

- **A granted term never ended.** Entitlement resolution read status alone and
  nothing swept an elapsed period, so "comp this account for fourteen days" was
  a permanent grant. Shipped with a backfill, because making that column
  load-bearing retroactively would have expired every hand-provisioned
  subscription on deploy.
- **One webhook could rewrite every subscription in an application.** A payload
  with no subscription id collapsed the `where` clause; a single
  `subscription.deleted` cancelled the lot.
- **A chargeback opened a dunning case**, emailing the customer about the
  charge they were disputing.
- **A plan with two CREDIT entitlements granted one.** The buyer paid for 700
  credits and received 500.
- **PayPal money was wrong in both directions** for currencies with no minor
  unit: sales recorded at 100x, and plans registered at a hundredth of their
  price with a decimal point PayPal rejects outright.
- **Operator cancellation ended every provider-less subscription immediately**,
  mid-period, no refund — while the self-service path on the same row cancelled
  at period end.

### Added

- **Trials.** `Plan.trialDays`, `Subscription.trialEndsAt`, and `TRIALING`.
  Fail-closed per provider: a module must declare `capabilities.trials` before
  a plan carrying one can be checked out through it, because silently dropping
  a trial charges the buyer today for something the pricing page called free.

### Fixed

- Refresh, reset and verification tokens are pruned, with a thirty-day window
  so replay detection keeps working — deleting a revoked token immediately
  turns "this was rotated" into "unknown token".
- The panel no longer loses the whole console to one 403, and a decorative
  health probe can no longer hold it for five minutes.
- The OSS strip runs on every pull request. It had been broken on `main`,
  silently blocking every release.

### Performance

Email sends are bounded end to end, including the tenant-supplied SMTP path
where the per-phase timeouts allowed a 42-second stall. API-key auth is one
query, `lastUsedAt` writes are throttled, and the tenant filter moved into the
query itself rather than depending on every caller to remember it.

## 2.0.0-rc.7

A new package for Astro, and the session bug shipping it exposed in the Next.js
one.

Still a release candidate, and the reason is unchanged: everything below was
found by an adversarial review or by running the product, not by the test
suite. The `@rekey.dev/nextjs` fix in particular had been live since rc.6 and
passed every test that package has.

### Added

- **`@rekey.dev/astro`** — session handling for Astro 4 through 7: middleware
  that puts the session on `Astro.locals`, cookie helpers, sign-in and
  sign-out. The astro-starter kit carried ninety lines of this, and every other
  Astro app was going to write its own. Cookie names and lifetimes match
  `@rekey.dev/nextjs`, so moving an app between the two frameworks does not
  sign everybody out.

### Fixed

- **`@rekey.dev/nextjs` cleared the session for three of the six ways a refresh
  token can be dead.** `/auth/refresh` throws six terminal codes; the set held
  `EXPIRED`, `REUSED` and `USER_TOKEN_INVALID`. The two most common were
  missing: `REVOKED`, which is what "sign out my other devices" and an operator
  revoking a session produce, and `INVALID`, which is any stale cookie, a
  restored database or an app rebuilt from scratch. An unlisted code fell
  through to the "the API failed, keep the cookies" branch — correct for an
  outage, wrong for a token that is finished. The cookie was never cleared, so
  the browser re-presented a dead credential on every request for the next
  thirty days, each one a doomed round-trip, while the user looked at a
  signed-out page with no way to fix it. Both packages now match by prefix, so
  a seventh code added API-side cannot silently reopen it.
- **`USER_TOKEN_WRONG_APPLICATION` never reached the refresh path.** It is what
  a secret repointed at a different Application produces, or a second Rekey app
  writing `rekey_access` on a shared parent domain. Rethrowing left a cookie
  that could not be cleared.

### Changed

- **`clean-for-public.sh` runs on every pull request.** It used to run once per
  release, when a tag was pushed, which is the worst moment to learn it is
  broken — and in August it was, exiting 1 on `main` for a full day with the
  mirror publish and the npm release blocked behind it. Nobody noticed, because
  nothing else executed it.

## 2.0.0-rc.6

Metered billing, which is the half of "auth and billing" that was previously
only metering. Plus the SDK defects three starter kits found by being used.

Still a release candidate. Every fix below was found by running the product or
by an adversarial review, not by the test suite — six of them were in code that
typechecked, built and passed its own tests. That ratio is the reason this is
not the stable tag yet.

### Added

- **Usage past an included quota is charged against a prepaid credit balance.**
  A `USAGE` plan entitlement can carry `creditsPerUnit`; consumption beyond the
  included units draws down the subscriber's credits inside the same
  transaction that writes the usage record, so a unit recorded but not paid for
  cannot exist. A balance too low is refused with `402`, never billed into the
  negative. No payment provider is involved — the credit pack that funds the
  balance is an ordinary one-off charge.
- **`refreshSession()`** in `@rekey.dev/nextjs`, for route handlers and
  middleware that may persist a rotated session.
- **`<RekeyStyles>`** and a generated `@rekey.dev/react/styles.css`, for
  rendering the component stylesheet once or linking it as a file.
- **`isCancelScheduled(sub)`** in `@rekey.dev/shared-types`, for the question
  `cancelsAtPeriodEnd` was being misread as.
- **`docs/billing-architecture.md`** — the billing model, the decisions behind
  it and what they cost, and how postpaid billing and discount durations extend
  it without unpicking what is there.

### Fixed

- **`auth()` threw out of a render when the access token had expired.** It
  refreshes by writing cookies, which Next forbids during a render, so it did
  not return null — it threw. The access cookie lasts fifteen minutes and the
  refresh cookie thirty days, so every signed-in user hit this a quarter of an
  hour after signing in: a 500 on every route, including the sign-in page they
  would have used to recover. It now returns the refreshed session and persists
  it where it can.
- **A transient API failure signed users out.** The same function cleared both
  cookies on any refresh error, so a timeout destroyed the one credential that
  could have recovered the session. Only a verdict about the token itself
  clears it now.
- **`rekeyMiddleware` could protect the page it redirects to.** Supplying
  `publicRoutes` replaces the default list, so a caller who omitted their
  sign-in path — or named a custom `signInUrl` — got a redirect loop with
  nothing in the logs. `signInUrl` is exempt from the gate whatever the caller
  passes.
- **The React components had no styling when rendered server-only.** The
  stylesheet was injected from a client effect, so anywhere the components
  render without hydrating — Astro without a client directive — produced
  correct markup and no styling at all. It renders in the tree now.
- **`PricingTable` and `CheckoutButton` required a Next Server Action**, which
  made the billing components unusable in every other framework. They accept a
  URL as well.
- **Three ways entitlement resolution gave away paid quota.** Buying a credit
  pack deleted the free tier, because the fallback fired only at zero
  subscriptions and a one-off purchase creates one. A lapsed organization kept
  its included quota indefinitely. And `occurredAt` was unbounded, so usage
  could be backdated into a month whose quota was unspent.
- **Usage idempotency keys were not scoped to the subject**, so one subject's
  key returned another's record — on a priced meter, consumption nobody paid
  for.

### Changed

- **`cancelsAtPeriodEnd` is now `cancelEffect`**, returning `'period-end' |
  'immediate'`. It predicts what cancelling *now* would do; it never described
  a subscription already ending. Everyone who met it read it as the latter,
  including three of our own starter kits, which hid the cancel control from
  every healthy subscriber and mislabelled it for `PAST_DUE` ones. A
  discriminant cannot be mistaken for a state. Use `isCancelScheduled` for the
  state question.

## 2.0.0-rc.5

Everything here came out of running the product rather than from the test
suite, which is the reason this is a release candidate and not the stable tag.

### Fixed

- **The sign-in redirect was blocked by our own Content-Security-Policy.** The
  page is served by the API and its job is to redirect to the relying party on
  another origin; `form-action 'self'` forbade exactly that. Browsers enforce
  that directive across the redirect a form submission triggers, so the server
  issued a correct 302 and the browser silently declined to follow it. The same
  header blocked the Application's logo and the script that acknowledges a
  click. The page now sends its own policy. No headless client enforces CSP, so
  nothing in the suite could have caught this.
- **A declined payment said "an unexpected error occurred".** Every PayPal
  failure threw a plain Error and reached the caller as a generic 500. Seven
  call sites now answer `BILLING_PROVIDER_REFUSED` with PayPal's own error
  name, so a declined card says so. The provider's free text stays in the
  server log because it can name the account.
- **A refused OIDC token exchange said nothing.** Same shape: the issuer states
  the reason in a fixed vocabulary and it was discarded.
- **"Something went wrong" replaced accurate quota messages.** Creating a second
  production Application at the limit hid a message that named the limit and
  the current count. The panel now shows the API's own words when it has none
  better.
- **An OAuth sign-up the provider would not vouch for could not be recovered.**
  The account was created and every sign-in refused, with nothing sent that
  would let the person prove the address.
- **Five different sign-in failures answered one error code**, so a bug, a
  stale link and a forged callback were indistinguishable.

### Added

- **PKCE on the generic OIDC provider**, decided by the issuer's discovery
  document. Without it no issuer that mandates PKCE could be used at all, which
  includes Rekey's own Applications. The verifier is held server-side against
  the CSRF state and never given to the browser.
- **OAuth clients tab**: list what has registered against an Application,
  revoke it, and close open registration. Registration is unauthenticated by
  design and there was previously no way to audit or stop it.
- **Operator sign-in against one of the deployment's own Applications**, so
  buyers who already have an account do not keep a second password.
- **A sign-in screen that explains itself**: names the Application, carries its
  branding, echoes a failed email back, and links password reset.
- `PANEL_PRIMARY_SIGNIN=magic_link` for deployments whose operators never set a
  password.
- An Application's pooled mail now sends as `<Application> (via <Deployment>)`
  rather than the deployment's name alone.

## 2.0.0-rc.4

### Record a sale that no payment provider saw

`POST /api/v1/admin/applications/:id/subscriptions`

Until now the only way a subscription could become `ACTIVE` was a webhook from
Stripe, PayPal or Razorpay. If you sell by invoice, take a bank transfer, comp
an account, or are migrating off another billing system, there was no supported
way to record that at all — the closest thing to a documented procedure was
writing SQL against your production database.

A row written that way is inert. It skips the entitlement provisioner, so the
credits and licences the plan promises are never issued, and it emits nothing,
so every webhook consumer you have built on `subscription.activated` hears
nothing. Granting through this endpoint takes the same path a real activation
takes, so both happen:

```bash
curl -X POST https://api.example.com/api/v1/admin/applications/$APP_ID/subscriptions \
  -H "Authorization: Bearer $SUPER_ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"planSlug":"pro","email":"buyer@example.com","note":"invoice INV-2026-0031"}'
```

- **Idempotent.** A subscriber already `ACTIVE` or `PAST_DUE` on the plan comes
  back with `activated: false` and a `200` instead of a `201`; nothing is
  written, re-provisioned or re-announced. It will not extend a live period — to
  move a grant to a new term, cancel it and grant again.
- **The period is real.** Defaults to one plan interval from now, on calendar
  anniversaries; pass `currentPeriodEnd` for whatever term you agreed. A one-off
  purchase (credit pack, perpetual licence) gets none, because it has none.
- **Cancel already works on it.** A granted subscription carries no provider,
  which is exactly what lets the existing cancel path schedule it to end at
  period end and the local expiry terminate it when the date arrives.
- **Audited.** Every grant writes `app.subscription_granted` to the security
  event trail — who, for whom, on what plan, until when, and why — visible to
  the workspace that owns the Application.

Deliberately behind `SUPER_ADMIN_KEY` rather than a workspace role: it is the
only billing write that creates entitlement with nothing behind it but an
assertion, and on a deployment where the operator is also the buyer that is a
lever aimed at your own limits. See `decisions.md`, 2026-08-03.

**Rekey Cloud**: this is the missing half of "your workspace exists as soon as
you have paid" below. Cloud sells with checkout off, so no activation was ever
emitted and the provisioning that shipped for it fired for nobody. It does now.

### Cancelling a PayPal subscription now does what the screen says

If you pay through PayPal, cancelling was not doing what you were told it would.

**You keep the time you paid for.** Asking to cancel at the end of the period
said "you keep everything you paid for until <date>" and then took it away
within seconds — mid-period, with no refund. PayPal has only one kind of
cancellation and it takes effect immediately, so that promise had nothing behind
it. Your access now runs to the date you were shown, and the last charge is the
last one: nothing is billed after you cancel.

**The first month counts too.** For a brand-new PayPal subscription there was no
renewal date on file, so every cancellation in the first period was treated as
immediate whatever you chose — the most common case, and the one the promise was
least true for. The renewal date is now recorded when the subscription starts.

**Subscribing again gives you a working Cancel button.** If you cancelled and
later resubscribed, the new subscription inherited the old cancellation: your
account page showed "Cancelling — ends" with a date that had already passed, the
Cancel button was replaced by Resubscribe, and cancelling through the API
reported success without doing anything — while the payments carried on. A
resubscribe now starts clean, and you can always cancel again.

**A failed cancellation is reported as one.** If PayPal refuses a cancellation,
you now get an error and can try again. Previously it was recorded on our side
as cancelled while PayPal kept billing, so nothing on the screen or in the
account page showed that anything was still running.

The customer-facing portal also stops promising a period end it cannot deliver:
when a cancellation really will take effect immediately, it now says so before
you confirm, instead of after.

### rekey.dev can confirm your email address

There is now a page at `rekey.dev/verify` that redeems the link in your
confirmation email. Until now the email was sent, the link 404'd, and an account
that needed confirming could not be confirmed — so a sign-up that asked you to
check your inbox was a dead end.

It answers every state honestly, because most of them are recoverable and the
old behaviour was to say nothing:

- **Confirmed** — you are done, and it names the address it confirmed.
- **Already confirmed** — the link was used once already, which is *fine*: the
  address is confirmed. This is a success message, not an error. Corporate mail
  scanners follow links before you do, and you should not be told your account
  is broken because your employer's security software clicked first.
- **Expired** — links last 24 hours; ask for another from the same page.
- **This link is for an older address** — you changed your email after the link
  was sent.
- **Not valid** — mangled link, or the account is gone.
- **No code** — you reached the page without a link.

Every one of those except "we could not reach the server" offers a way forward
on the page itself, so nothing sends you to support to make progress.

### Sign-up and sign-in stopped lying about unconfirmed accounts

Signing up for Rekey Cloud with confirmation required used to answer
**"Could not create your account. Please try again."** The account *had* been
created. Pressing the button again then said the email was already taken, which
reads as "somebody else has your address". It now says your account exists and
points you at your inbox.

Signing in with a correct password on an unconfirmed address used to give a
generic failure, which sent people round the reset-password loop fixing a
password that was never wrong. It now tells you to confirm your address, with a
link to ask for another confirmation email.

### "Forgot password?" exists

rekey.dev's sign-in page had no password-reset link at all. It has one now, and
`rekey.dev/reset` — where the reset email points — is a real page.

### Sign in to Rekey Cloud with Google or Discord

rekey.dev now offers social sign-in. Both providers assert a confirmed email
address, so signing in this way normally skips confirmation entirely.

Rekey has supported these providers for your own applications for some time;
this is Rekey Cloud finally using them for its own. Operators wanting the same
on their own sites configure it per Application under
Panel → Application → OAuth — unchanged.

### Sign operators in with an account they already have

An Application that is an OpenID Provider can now be the login for the operator
panel itself. Set two variables and the panel accepts an ID Token your own
deployment minted:

```bash
OPERATOR_OIDC_ISSUER=https://api.example.com/api/v1/mcp/account
OPERATOR_OIDC_CLIENT_ID=<client_id from POST /oauth/register>
```

Someone signing in this way is matched to an existing operator **by verified
email**, so anyone who already has an operator account keeps it — same
workspaces, same MFA, same passkeys. Nothing is duplicated and nothing is
orphaned. A first-time sign-in creates an operator subject to
`OPERATOR_SIGNUP_MODE` exactly like any other, so this is not a way around an
invite-only deployment.

Off unless you set both variables — `POST /api/v1/tenant/auth/oidc/assert`
answers `404` otherwise. Limited to issuers your own deployment hosts; a
third-party IdP is not supported yet. See `docs/operator-oidc-assertion.md`.

### Your own server can finish a sign-in it already did

`POST /api/v1/mcp/:slug/oauth/authorize/grant`

The interactive `/oauth/authorize` asks the user for a password, because there
is no SSO session to reuse. That is correct for someone else's app and wrong for
**your** server, which already holds a live session for the user it is asking
about — it was re-prompting for a password it had just accepted.

Present your Application secret key together with the user's live access token
and you get an authorization code for one of your own registered clients,
redeemable at `/oauth/token` like any other:

```
POST /api/v1/mcp/account/oauth/authorize/grant
Authorization: Bearer rp_live_...
X-Rekey-User-Token: <the user's live access token>

{ "client_id": "...", "redirect_uri": "...",
  "code_challenge": "...", "code_challenge_method": "S256",
  "scope": "openid email" }
-> { "code": "...", "expires_in": 60 }
```

This grants nothing a secret key could not already do — and because it demands
a live user token, it cannot be used on someone who has not signed in. A
publishable key is refused, an impersonated session is refused, the code is
single-use and PKCE-bound like any other, and every use is recorded in your
security events as `user.session_handoff_granted` naming the user and the
client.

### BREAKING · Every list endpoint now returns `{items, page}` instead of a bare array

A functional audit called `GET /api/v1/tenant/applications/:id/end-users` with
no `limit`. There were 36 end-users in the database. It answered `200` with 25
rows, and **nothing in the response said the other 11 existed**:

```
GET /api/v1/tenant/applications/{id}/end-users     (no limit passed)
-> 200 [ ...25 rows... ]              actual rows in the database: 36
```

A client that does not pass `limit` could not tell a complete list from a
truncated one. Twenty-six list endpoints had that shape. A schema audit then
validated 86 operations against the published document and found the same thing
from the other side: the document declared `{items, page}` for those operations
and the handlers returned an array.

**Before**

```json
{
  "success": true,
  "data": [
    { "id": "eu_1", "email": "a@example.com" },
    { "id": "eu_2", "email": "b@example.com" }
  ]
}
```

**After**

```json
{
  "success": true,
  "data": {
    "items": [
      { "id": "eu_1", "email": "a@example.com" },
      { "id": "eu_2", "email": "b@example.com" }
    ],
    "page": { "total": 36, "limit": 25, "offset": 0, "hasMore": true }
  }
}
```

`page.total` is the count of rows matching the query, ignoring `limit`/`offset`.
`page.hasMore` is `offset + limit < total`. Both come from `pageMeta()` in
`apps/api/src/lib/pagination.ts`, which every one of these endpoints now uses.

**46 operations changed** — the 44 the document already declared `okPage` for,
plus the two request-log endpoints (below):

- **Public / end-user:** `GET /auth/passkeys`, `GET /auth/sessions`,
  `GET /users/me/organizations`, `GET /users/me/organizations/{id}/members`,
  `GET /billing/plans`, `GET /billing/payments`, `GET /credits/ledger`.
- **Operator (tenant):** `GET /tenant/applications` and its
  `/{id}/plans`, `/{id}/coupons`, `/{id}/payments`, `/{id}/dunning`,
  `/{id}/end-users`, `/{id}/licenses`, `/{id}/usage-meters`,
  `/{id}/organizations`, `/{id}/email-logs`, `/{id}/webhooks`,
  `/{id}/webhooks/{endpointId}/deliveries`,
  `/{id}/billing-credentials/webhook-events`;
  `GET /tenant/auth/sessions`, `GET /tenant/auth/api-tokens`,
  `GET /tenant/workspace/members`, `.../members/{id}/grants`,
  `.../invitations`, `.../email-logs`, `GET /tenant/security-events`,
  `GET /tenant/operator/applications`,
  `GET /tenant/operator/applications/{id}/api-keys`.
- **Super-admin:** `GET /admin/tenants`, `GET /admin/applications`,
  `GET /admin/applications/{id}/plans`, `.../coupons`,
  `GET /admin/operator-invites`, and the ten `GET /admin/metrics/*` list
  endpoints.

Three of those were wrong in their own particular way and are also fixed:

- `GET /tenant/security-events` returned `{ "events": [...] }` — a key that
  appeared in no schema anywhere.
- `GET /admin/operator-invites` and all ten `GET /admin/metrics/*` endpoints
  returned pagination **flattened** next to the rows
  (`{items, total, limit, offset}`), one level up from where the document
  declared it, and with no `hasMore` at all.

Two more moved for the same reason even though the document already described
them accurately: `GET /tenant/auth/requests` and
`GET /tenant/applications/{id}/requests` wrapped their rows as
`{ "requests": [...] }` with no total. Both are backed by `api_request_logs`,
which grows with every request the deployment serves, and the panel had to keep
an over-fetch probe alive purely for them. Their `page.total` counts what the
pruner has left rather than every request ever made — these are capped
convenience tails, and the endpoint descriptions say so — but it is still the
real answer to "is there another page".

**Nine list endpoints are deliberately unchanged** — they remain bare arrays
because they are bounded by construction and cannot truncate: a user's linked
OAuth identities, an Application's API keys (hard-capped at 25 on the write
path, on both the tenant and admin routes), a plan's entitlement bundle, the
three configured billing-credential slots, per-Application end-user roles, the
fixed email-template registry, and the two `.slice(0, 20)` top-N metrics
(`webhook-endpoint-health`, `payments-by-app`). They are enumerated with their
reasons in `ALLOWED_BARE_ARRAYS` in `apps/api/test/openapi-contract.test.ts`.

**Migrating.** Read `.items` where you read the array, and `page.hasMore` where
you inferred "is there a next page" from `rows.length === pageSize`:

```ts
// before
const plans = await rekey.billing.getPlans();
plans.map(render);

// after
const { items, page } = await rekey.billing.getPlans();
items.map(render);
if (page.hasMore) { /* fetch offset: page.offset + page.limit */ }
```

Every consumer in this repo moved with it: the operator panel (its
`splitPage()` over-fetch shim is gone — it existed only because there was no
`total` to read), the super-admin console, the hosted portal, the marketing
account page, `@rekey.dev/node`, `@rekey.dev/react`, `@rekey.dev/cli`
(`apps list` and `plans list` gained `--limit` / `--offset` and now report
"showing N of M"), and `@rekey.dev/mcp` (every list tool gained `limit`/`offset`
and its description tells the model to check `page.hasMore`).

Several endpoints that had no bound at all are now bounded as a side effect —
`GET /tenant/operator/applications`, `GET /tenant/workspace/members`,
`.../invitations`, `GET /tenant/auth/sessions`, `GET /auth/sessions`,
`GET /auth/passkeys` and `GET /tenant/auth/api-tokens` all ran an unbounded
`findMany`. They take `limit`/`offset` now, defaulting to 50.

`PageMeta`, `Paged<T>` and `ListPage` are exported from
`@rekey.dev/shared-types` (and re-exported from `@rekey.dev/node` and
`@rekey.dev/react`) so the API, the SDKs and the consoles name one shape.

### BREAKING · Application responses no longer carry the encrypted-credential columns

`GET /api/v1/tenant/applications/:id` (and the list, create and super-admin
equivalents) returned the Prisma row verbatim, which includes
`billingCredentialsCiphertext`, `oauthCredentialsCiphertext` and
`emailCredentialsCiphertext` — the AES-256-GCM ciphertexts of the operator's
payment-provider keys, their per-provider OAuth client secrets, and their SMTP
or Resend credentials. Measured, not inferred: the Application detail response
carried 15 fields the `Application` schema does not declare, and three of them
were those.

They are useless to a client (only the API holds the key) and they are the one
thing on that row that must never leave the process, so they are stripped at
the response boundary. The dedicated read surfaces
(`GET .../billing-credentials`, `GET .../email/config`) already reported
presence as a boolean and never the material; nothing in this repo read the
ciphertexts off a response.

### Rekey Cloud: your workspace exists as soon as you have paid

Paying is now what creates your workspace. Previously the workspace was made
when you pressed **Open your workspace** on the account page — so between
paying and finding that button you owned nothing, and if you closed the tab
there was nothing waiting for you when you came back.

Now the subscription going active creates your operator account, your workspace
and your ownership of it, and writes the ceiling your plan pays for. When you
next sign in to rekey.dev, it is already there. The button still works and still
does the right thing if you press it — pressing it twice, or pressing it after
this has already run, will never give you a second workspace.

**One condition: your email address has to be verified.** Your workspace is tied
to your rekey.dev account by your verified email — that is what lets you sign in
to panel.rekey.dev in one click, with no key to copy. If your address is not
verified yet, we will not create an account under it, because doing so would
mean handing your workspace to whoever verifies that address afterwards. Verify
your email and the workspace is created within the minute; nothing is lost in
the meantime and your plan's ceiling is applied the moment it appears.

### Fixed (Rekey Cloud): a workspace key you had not redeemed did not count against your plan

Your plan covers a set number of workspaces. Until now the account page only
counted the workspaces that had actually been created — so a key you had been
issued and not yet redeemed counted for nothing, and you could keep pressing
**Generate a new key** and collect as many live keys as you liked. Every one of
them still turns into a real workspace when somebody signs up with it, which
meant a one-workspace plan could quietly become any number of workspaces.

Keys you are holding now count towards your allowance, exactly like the
workspaces you have already made. Concretely, if your plan covers one workspace:

- You have no workspace and no key → **Generate a new key** issues one.
- You are holding that key and have not redeemed it → the account page says so,
  and points you at panel.rekey.dev/sign-up to redeem it.
- You lost the key (it is only ever shown once) → **Replace key** revokes the
  old one and issues you a fresh one. Anyone still holding the old key can no
  longer use it. Your allowance does not change, and you are never left with two
  working keys at the same time.
- You have redeemed it and the workspace exists → the page tells you the
  allowance is used up and how to ask for more, as it did before.

Nothing you are holding today stopped working when this shipped. Keys already
outstanding stay valid and redeemable; they simply start counting from now on,
so the next key you ask for is the first one this rule applies to.

### Fixed (Rekey Cloud): cancelling made your subscription disappear from the account page

Cancelling takes effect at the end of the period you have already paid for — you
keep everything until then. The account page did not say so. The moment you
cancelled, the subscription card was replaced by "You are on the free plan",
dropping your plan name, the status, and the date your access actually runs to,
with no way back except emailing us.

The account page now shows what is really true:

- **Cancelling.** Your plan, `Cancelling`, and **Ends** with the date. Plus a
  sentence saying you keep everything you paid for until then and that nothing
  is deleted afterwards — your applications keep serving, you just cannot add
  more — and a **Resubscribe** button if you change your mind.
- **Ended.** The date it ended, what the free plan gives you, and the same
  **Resubscribe** button.

The confirmation step is also more careful. Cancelling normally schedules the
end of your subscription for the date you are paid up to, but that is only
possible for a subscription your payment provider is managing. For anything else
— including a subscription we set up for you by hand — cancelling ends it
immediately with no refund for the rest of the period. The confirmation now says
which of the two you are about to get, in those words, before you confirm.

### Fixed (Rekey Cloud): the cancel confirmation warned you about a loss that no longer happens

Hours after the paragraph above was written, the API stopped requiring a payment
provider to schedule a cancellation — precisely because subscriptions we set up
by hand were being ended on the spot when their owner asked for the end of the
period. Every Rekey Cloud subscription is one of those. The confirmation dialog
was not updated, so it went on telling every subscriber on the site that
cancelling would cost them the remainder of a period they would in fact have
kept. The same defect as the original, pointed the other way: copy frightening
people out of a cancellation that was perfectly safe.

The dialog now says what actually happens:

- **An active subscription with a renewal date** — the ordinary case, whether or
  not a payment provider is involved — keeps everything you paid for until that
  date. Confirming reads **Yes, cancel at period end**.
- **A subscription whose last payment has not gone through**, or one with no
  renewal date recorded, still ends straight away, and each now says which of
  the two it is instead of "this cannot be scheduled". If you think you have
  paid for time you have not used, get in touch and we will sort it out.

The rule behind this is no longer written down twice. It lives in
`@rekey.dev/shared-types` as `cancelsAtPeriodEnd`, exported from
`@rekey.dev/node`, and the API cancels from that same function — so what a
confirmation dialog promises and what the server does cannot drift apart again.
If you have built your own cancel confirmation, call it rather than
re-implementing the rule:

```ts
import { cancelsAtPeriodEnd } from '@rekey.dev/node';

const sub = await rekey.billing.getSubscription(userAccessToken);
const message = sub && cancelsAtPeriodEnd(sub)
  ? `You keep access until ${sub.currentPeriodEnd}.`
  : 'Cancelling takes effect straight away.';
```

### Added: `GET /billing/subscription?includeEnded=true` — a cancelled subscription stops vanishing

`GET /api/v1/billing/subscription` answers with the ACTIVE, PAST_DUE or PENDING
subscription and `null` otherwise. `null` is also the answer for somebody who
has never subscribed, so once a subscription reached CANCELED there was no way
for a billing page to tell a former customer apart from a stranger. It said the
only thing it could: "you are on the free plan". Cancel, reload the next day,
and your plan, your status and your end date were gone.

Pass `?includeEnded=true` and the endpoint falls back to your most recent
CANCELED or EXPIRED subscription **when, and only when, the answer would
otherwise have been null**. It cannot replace a live subscription: someone who
cancelled and resubscribed still gets the one they are paying for, and an
unfinished checkout still comes back as PENDING. So it is safe to add to a call
you already make — though leave it off where you are deciding access, because
there the strict question is the one you want.

```ts
// Billing page — "your Standard subscription ended on 1 July", not a blank slate
const sub = await rekey.billing.getSubscription(token, { includeEnded: true });

// Entitlement check — unchanged, and should stay that way
const live = await rekey.billing.getSubscription(token);
```

Default behaviour is unchanged, so existing SDK, portal and integrator calls
carry on exactly as before. `getSubscription` in `@rekey.dev/node` also gained
the `organizationId` option it had been missing, which `@rekey.dev/react`
already had.

Rekey Cloud's own account page now uses it, so a buyer who cancelled last month
comes back to the plan they were on and the date it ended, with a Resubscribe
button — rather than the page it showed somebody who had never bought anything.

### Three response schemas that described something the endpoint never returns

- **`GET /users/me` and `GET /auth/me` were structurally unsatisfiable.** Both
  declared `allOf: [EndUser, {required: [activeOrganizationId]}]`, and the
  `EndUser` component carried `additionalProperties: false` (generated from a
  `.strict()` zod schema). No JSON object could ever validate: with the field
  it is "additional", without it it is "required". The generator now strips
  `additionalProperties: false` from every component, which is what
  `lib/openapi.ts` has always said it does — its own header states these
  schemas describe "a floor, not a ceiling", and its `fromZod` comment claimed
  to delete the flag while deleting only `$schema`. 40 of the 55 components
  were shipping closed. Both `me` endpoints additionally now declare the
  `role`, `updatedAt`, `erasedAt` and `erasedBy` fields they return.
- **`GET /tenant/applications/{id}/end-users/{euid}/export`** declared
  `{"type": "string"}` — because it is documented as a file download — and
  returns a JSON object. A generated client typed it `Promise<string>`. It now
  references a new `EndUserExport` component written field-for-field against
  `EndUserExportDocument` in `@rekey.dev/shared-types`.
- **Closed-schema violations** are gone with the change above: a response may
  now legitimately carry more than its schema names, which is what these
  handlers have always done.

`apps/api/test/openapi-contract.test.ts` gained two assertions that keep all of
this from sliding back: no component may declare `additionalProperties: false`,
and every entry in `ALLOWED_BARE_ARRAYS` must still name a live bare-array
operation (so the list cannot keep dead entries that later read as permission).

### The published OpenAPI document now describes responses

`/docs/json` — and the copy shipped at `apps/marketing/public/openapi.json` —
described **one** response across the entire API. 275 of 276 operations carried
nothing but:

```json
"200": { "description": "Default Response" }
```

Request bodies and query parameters were complete and accurate; responses were
absent. So you could not generate a typed client, the `{success, data}` /
`{success, error}` envelope appeared nowhere, no error shape was described at
all, and every response field an integrator used had to be discovered by calling
the endpoint and reading what came back. Two independent external audits called
it half a contract.

Now: **275 of 278 operations declare a response schema**, over **55 named
components** in `components.schemas`. The envelope is defined once and
referenced, not inlined 278 times. Domain objects (`Application`, `Plan`,
`EndUser`, `Subscription`, `Payment`, `Coupon`, `License`, `Organization`,
`WebhookEndpoint`, `CreditLedgerEntry`, …) are **derived from the same
`@rekey.dev/shared-types` zod schemas the SDKs compile against**, so the document
cannot drift from the types.

Error responses are declared per operation from what the handler actually
throws, not as a blanket 400/401/500 — a route that can answer `402
CREDITS_INSUFFICIENT` or `409 PLAN_SLUG_TAKEN` now says so, with the `code`
string you will switch on.

Three operations declare no 2xx body because they have none: `GET
/api/v1/mcp/{slug}` and `GET /api/v1/tenant/mcp` answer `405` unconditionally
(the endpoints are POST-only JSON-RPC), and `GET
/api/v1/tenant/mcp/oauth/authorize` only ever redirects or renders HTML.

**These schemas are documentation, not serialisation.** Fastify normally
compiles `schema.response` with fast-json-stringify, which drops any field the
schema does not declare. A pass-through serializer is installed so that adding
these schemas cannot silently truncate a live response — runtime output is
byte-identical to before. The guard against drift is
`apps/api/test/openapi-contract.test.ts`, which fails if any operation loses its
response schema, if any declares no failure mode, or if a list endpoint declares
a bare array.

### Fixed: the published OpenAPI document was never valid OpenAPI 3.0

Four request-body properties used the draft-07 type-array form
(`type: ['string','null']`, `type: ['integer','null']`), which OpenAPI 3.0 —
the version this document declares — does not allow. Every real validator
rejected the file, so anyone who tried to generate a client got a parse error at
the door. That is plausibly why nobody reported the missing response schemas:
you could not get far enough to notice.

They are now `nullable: true`, which Fastify's ajv treats identically at runtime
(verified: `null` accepted, the typed value accepted, a wrong type still 400s).
The affected fields were `maxActiveEndUsers` and `maxProductionApps` on `PUT
/api/v1/admin/tenants/{id}/limits`, `appUrl` on `PATCH
/api/v1/tenant/applications/{id}/auth-config`, and `defaultPlanSlug` on `PATCH
/api/v1/tenant/applications/{id}/billing-config`. The document is now validated
by `@apidevtools/swagger-parser` in the test suite.

### Fixed: the OpenAPI document announced itself as `1.1.1`

The version was a hardcoded string in `apps/api/src/lib/swagger.ts` and had gone
three minor versions stale — the document about to become the frozen 2.0.0
public contract described itself as a 1.x document to every client generator,
registry, and integrator diffing it against the previous release.

It is now derived from `@rekey.dev/shared-types`'s `package.json` (the version
the packages, API, panel and portal share), and the test suite asserts that the
document version, the package version, and the top CHANGELOG heading all agree —
so a release cannot bump one and forget the others.

### Changed: session cookies decide `Secure` from the request, not from `NODE_ENV`

**Operator-visible effect:** the panel, admin portal, hosted portal, rekey.dev
account pages and `@rekey.dev/nextjs` now set `Secure` on every cookie they
write whenever the request did not arrive as plain HTTP on a loopback host —
regardless of what `NODE_ENV` is set to.

Every cookie in the stack previously decided `Secure` with
`process.env.NODE_ENV === 'production'`. That is a build-time answer to a
request-time question, and it failed in the direction that costs you the
session: a deployment behind TLS whose `NODE_ENV` was unset, or `staging`, or
anything Next did not inline as exactly `"production"`, handed out session
cookies with no `Secure` flag. A browser will replay those over plain HTTP.
Nothing about it was visible — the apps worked normally.

The decision now reads `X-Forwarded-Proto` (first hop), falling back to the
`Host`. Loopback hosts (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`) are
treated as the developer machine they are and get no `Secure`; everything else
does. **If you terminate TLS somewhere the app cannot observe and your proxy
sets no `X-Forwarded-Proto`, set `REKEY_COOKIE_SECURE=false`** — otherwise the
browser will refuse the cookie and sign-in will not complete. That is the
intended failure: the insecure case is now something you opt into rather than
something you fall into.

### Changed: `docker-compose.yml` publishes on loopback by default

**Operator-visible effect:** after `docker compose --profile full up`, the API,
panel and portal are reachable at `localhost:3030` / `:3031` / `:3050` as
before, but no longer on the host's public interfaces. To expose them, set
`BIND_ADDRESS=0.0.0.0`.

Postgres and Redis were moved to loopback earlier for the same reason; the web
services were left publishing on `0.0.0.0` while `OPERATOR_SIGNUP_MODE`
defaulted to `open`. Together that meant bringing this stack up on a VPS to try
it out put an unauthenticated operator-signup endpoint on the internet, without
anyone choosing to. `docker-compose.prod.yml` — the file `DEPLOY.md` documents
for real deployments — is unaffected: it publishes no ports at all and routes
through Traefik.

`OPERATOR_SIGNUP_MODE` still defaults to `open`, because first boot has to be
able to create the first operator. The API now logs a `[SECURITY]` warning at
boot when it finds `open` under `NODE_ENV=production`, which covers deployments
that do not use this compose file. **If you set `BIND_ADDRESS=0.0.0.0`, set
`OPERATOR_SIGNUP_MODE=invite` in the same edit.**

### Added: `OPERATOR_MCP_DYNAMIC_REGISTRATION` closes anonymous MCP client registration

**Operator-visible effect:** none by default — the value is `open`, matching
today's behaviour, so Claude Desktop / Claude Code / Cursor keep connecting by
discovery alone. Set it to `disabled` once your clients are connected and
`POST /api/v1/tenant/mcp/oauth/register` answers `403
CLIENT_REGISTRATION_DISABLED`, with `registration_endpoint` dropped from the
RFC 8414 metadata. Clients that already hold a `client_id` are unaffected.

RFC 7591 registration on the operator authorization server was unconditionally
open, with no way to close it — unlike the per-Application MCP twin, which has
had `authConfig.dynamicClientRegistration` since it was written. Registering
grants no access on its own: an authorization code is only minted after an
operator signs into the panel and approves. What it does grant is an
*allowlisted* `redirect_uri` of the registrant's choosing, and `/oauth/authorize`
refuses any `redirect_uri` its client did not register. That allowlist entry is
the missing ingredient in a consent-phishing link.

The panel consent screen now also names the host the authorization code will be
delivered to, and says plainly that Rekey does not vouch for it.

### Fixed: operator MCP refresh-token reuse now revokes the whole family

**Operator-visible effect:** replaying an already-rotated operator MCP refresh
token revokes every live token for that operator, workspace and client, not just
the replayed one. Reconnect the MCP client to get a fresh grant.

Reuse detection refused only the presented token. On a leak that is backwards:
the attacker rotates first, so the replay is the *legitimate* client arriving
second — it got a single unexplained `invalid_grant` while the token the
attacker rotated into stayed valid for its full 30 days. The end-user refresh
path has burned the family on reuse for some time; this surface was left as a
seam. It now matches, including the same discrimination the end-user path makes:
a token that was rotated and then replayed burns the family, a token that was
deliberately revoked (sign-out) does not.

### Fixed: a well-formed request could make the API answer 500

An external black-box audit exercised all 276 operations and found two ways to
get a 500 out of a request that passed every auth check — one of them without
any credential at all.

**A NUL byte in any JSON string.** Postgres cannot store `\u0000` in a text
column, so it came back `22021 invalid byte sequence for encoding "UTF8"` and
19 routes turned that into a 500 — including `POST /api/v1/tenant/auth/sign-up`
and MCP dynamic client registration, both unauthenticated. A guard for exactly
this already existed for the query string; the body never got one. There is now
a `preValidation` hook that walks the whole parsed body — nested objects,
arrays, and object *keys* — and answers `400 INVALID_BODY`.

**An integer past what the column holds.** Every money and metering field was
written with a floor and no ceiling, so `Number.MAX_SAFE_INTEGER` passed
validation and Postgres answered `22003 value out of range for type integer`.
The audit reproduced it on usage quantity, plan amount and credit grants; the
same shape was present on 28 integer schemas in total, all now bounded — money
at 10^11 minor units, counts at `int4` range.

Neither was a privilege escalation: the audit confirmed cross-tenant isolation
and role gating held throughout (147 operations swept, zero leaks). They matter
because an unauthenticated caller could drive the error rate at will, and
because a 400 that names the field is the difference between a caller fixing
their own request and a caller filing a bug.

`GrantCreditsRequestSchema`, `TenantLimitsSchema` and `AuthConfigSchema` in
`@rekey.dev/shared-types` gained upper bounds to match. This narrows those
types: a value that was previously accepted and then failed at the database now
fails validation instead.

The published `openapi.json` was regenerated and picked up unrelated staleness
along with the new bounds — the MFA re-enrollment `code` requirement and the
organization-invitation email binding were both shipped without the document
being rebuilt.

### Behaviour change: a workspace MEMBER now starts with access to NO Application

**This changes what your existing members can see. Read the migration note.**

Per-application grants shipped with a back-compat rule: a MEMBER holding zero
grants kept the pre-grants behaviour — read-only access to **every** Application
in the workspace. That was written as an accommodation for members who predated
grants. But zero grants is also the state a freshly accepted MEMBER invitation
lands in, so the accommodation *was the live default*:

> Invite a contractor as MEMBER → they immediately read every Application's
> end-user roster (with email addresses), API-key metadata, billing-credential
> status, payments, webhooks, coupons, licences, organizations, email logs and
> per-app stats. An external audit confirmed 31 read endpoints on an
> Application nobody had granted them.

Grant-scoped access is now the default, not a mode the first grant opts you
into. A MEMBER with no grant on an Application gets `404 APPLICATION_NOT_FOUND`
— the same non-disclosure answer an ungranted Application already returned for
a member who held grants elsewhere. `GET /api/v1/tenant/applications` returns
`[]`. The operator MCP surface (`list_applications` and every tool built on it)
follows the same rule.

**Existing memberships are grandfathered, not broken.** The migration adds
`tenant_memberships.legacy_workspace_read` (default `false`) and backfills it
to `true` for every MEMBER row that already existed *and holds no grant*.
Those members keep exactly the access they have today. Only memberships created
from this release onward start closed. Revoking access your colleagues are
using right now, without an operator asking and on an upgrade whose timing they
do not control, would be an availability incident dressed as a security fix.

What changed for the grandfathered rows is that they are now **visible**:
`GET /api/v1/tenant/workspace/members` reports `legacyWorkspaceRead` per member,
so an owner can find everyone still on the blanket read and scope them. Setting
any grant on a membership clears the flag permanently.

One related fix: removing a member's **last** grant used to return them to
workspace-wide read — a de-scoping action that *widened* access. It now leaves
them with nothing, which is what the operator asked for.

**If you rely on the old behaviour**, grant explicitly:
`PUT /api/v1/tenant/workspace/members/:id/grants` with `APP_VIEWER`,
`APP_BILLING` or `APP_ADMIN` per Application.

### Contract change: config PATCH bodies reject unrecognised keys

`PATCH /api/v1/tenant/applications/:id/auth-config` answered **200** for a body
of entirely unrecognised keys and changed nothing:

```
PATCH …/auth-config
{"mfaa":"required","tokenAlgorithm":"none","sessionTtl":999999,"bogus":1}
→ 200, authConfig byte-identical afterwards
```

`mfaa` for `mfa` and `tokenAlgorithm` for `tokenAlg` — a one-character typo
silently no-opped the Application's **MFA policy** and **token signing
algorithm**, and the caller was told it succeeded. A patch body whose keys are
all optional has no shape left to fail on except the key names, so those are
now the check.

These bodies now answer `400 VALIDATION_ERROR` with an `issues` array naming
the offending key, matching `billing-config` (which already did this):

- `PATCH …/auth-config`
- `PATCH …/billing-config` (unchanged — the pattern the rest were aligned to)
- `PATCH …/portal`
- `PUT …/access` — the worst of them: `{"ipAllowlst": […]}` reported success
  while writing nothing, leaving an operator believing they had locked their
  secret keys to an office CIDR
- `POST …/end-user-roles`, `PATCH …/end-user-roles/:name`
- `PATCH …/usage-meters/:slug`

`PATCH …/usage-meters/:slug` was worse than the rest: it accepted the meter's
**own** fields, `{"name":"RENAMED","unit":"widget","active":true}`, applied only
`active`, and returned 200 echoing the *pre-edit* row — so the response itself
read as confirmation the rename had happened. `active` is the only editable
field and is now the only accepted one; its request body is also declared in
`/docs/json`, which previously published the operation with no `requestBody` at
all while `active` was in fact mandatory. Renaming a meter is deliberately not
implemented here: `slug` is what `Plan.meterSlug` binds against and `unit` is
the label every already-recorded usage row was measured in.

Injected `role` / `tenantId` / `applicationId` / `emailVerified` / `id` were
already correctly ignored on these bodies. The defect was that they were
ignored *silently*; callers are now told.

**If you send extra keys today**, they were already having no effect — you will
now get a 400 that names them instead of a 200 that hides them.

### Fixed: a payment-provider failure no longer surfaces as a 500 or a bogus 401

An exception from a provider SDK reached the global error handler unmapped, and
got whatever it could infer. A `StripeError` carries `.statusCode` and
`.message`, which was enough to be duck-typed as a framework 4xx:

```
POST /api/v1/billing/checkout        → 500 INTERNAL_ERROR ("contact support")
POST /api/v1/tenant/applications/{id}/plans
  → 401 {"code":"BAD_REQUEST","message":"Invalid API Key provided: sk_test_************2345",
         "fix":"Check the request shape against the route schema in /docs."}
```

Three signals disagreeing about one wrong stored credential — an upstream
status, a code meaning "your request was malformed", and a `fix` blaming the
caller's request shape — with a fragment of the operator's own key echoed back.
`POST …/billing-credentials/:provider/register-webhook` already did this right
(502, a stable code, an accurate `fix`); every provider call site now goes
through that same mapper.

All provider-SDK failures answer **502 `BILLING_PROVIDER_ERROR`** (documented in
`docs/errors.md`, so integrators can finally branch on "the provider, not the
caller, is at fault"). The mapper distinguishes who is reading:

- **Operator** routes (`/api/v1/tenant/*`) get the provider's own message,
  framed and length-bounded — they own the credential and it is the only thing
  that tells them which key is wrong.
- **End-user** routes (`/api/v1/billing/*`) do not. The caller is somebody's
  customer; they can do nothing about it and must never be shown the operator's
  provider internals. The provider's message goes to the server log against the
  response's `requestId`.

Affected: `POST /billing/checkout`, `POST /billing/subscription/cancel`,
`POST …/plans` (tenant and admin), and operator-side subscription cancellation.
The cancel case was the sharpest: the buyer was told their *request shape* was
wrong, with a 401, while the subscription they asked to cancel kept billing.

Two supporting changes: a 5xx `RekeyError` is now logged server-side (mapping an
upstream failure onto a clean 502 must not also erase it from the log), and any
unmapped provider-SDK error is caught by a last-resort guard in the error
handler rather than passing its status and message through.

### Fixed: three error responses were missing `requestId`

`POST /api/v1/tenant/applications/:id/licenses` built its 404 envelope by hand
instead of throwing the shared error type, so it bypassed the error handler and
returned neither the `requestId` field nor the `X-Request-Id` header — the sole
envelope break across 244 operations an external audit checked. Two more had the
same shape and are fixed alongside it: the 409 `EMAIL_ALREADY_EXISTS` on
end-user create, and the 405 on `GET` of the operator MCP endpoint.

The underlying problem was not three forgetful routes — it was that the envelope
is only guaranteed where `RekeyError` is thrown, and nothing enforced that. The
other 241 operations were consistent by habit. There is now a static test
asserting that every object literal in `apps/api/src` carrying `success: false`
also carries `requestId`; it fails with the exact `file:line` of the next one
somebody writes.

### Fixed: workspace audit surfaces now share one role floor

`GET /api/v1/tenant/workspace/email-logs` was readable by any MEMBER while
`GET /api/v1/tenant/security-events` was OWNER/ADMIN-only — the same class of
data (operator email addresses, subjects, delivery status vs. IPs and event
metadata) behind two different gates. Likewise `GET
/api/v1/tenant/workspace/invitations` was open to MEMBERs while the `POST` that
creates one was ADMIN-gated, so any member could read every pending invitee's
address and the workspace role they had been offered.

Both `GET`s now require **OWNER or ADMIN**, matching their siblings. `GET
/workspace/members` is deliberately unchanged — a member seeing the team roster
is normal collaboration, not an audit surface.

### Fixed (money): a plan the payment provider refused went on sale anyway

Creating a plan inserted the row and *then* registered it with Stripe. When the
provider refused — a rejected API key, a currency the account cannot take — the
create returned an error and the plan stayed committed, `active: true`, on the
public catalogue:

```
POST /api/v1/tenant/applications/{id}/plans  {"slug":"brokenplan", ...}
  → 401 "Invalid API Key provided: sk_test_****0001"

GET  /api/v1/billing/plans
  → 200 [... {"slug":"brokenplan","amount":4900,"active":true,"metadata":{}} ...]

POST /api/v1/billing/checkout  {"planSlug":"brokenplan", ...}
  → 500 {"code":"INTERNAL_ERROR","message":"An unexpected error occurred."}
```

Nothing on the row distinguished it from a working plan, and the real cause
(`Plan "…" has no Stripe priceId in metadata`) reached only the server log. It
could not be repaired either: re-`POST`ing the slug answered `409
PLAN_SLUG_TAKEN`, and `PATCH .../plans/{slug}` accepted exactly one field,
`{"active": boolean}`. The only way out was a new slug — which is not a remedy
for a slug already in a customer's pricing page.

Three changes:

**Registration is write-ahead.** A plan owed an eager registration is inserted
`active: false` with the new `registrationStatus: PENDING`, and is promoted to
`REGISTERED` + active only once the provider answers. A refusal settles it to
`FAILED` and records the provider's message in `registrationError`. The provider
call is a network call and is deliberately *not* wrapped in a database
transaction; the ordering is what makes it safe, so a refusal, a timeout, or a
process death all leave a plan nobody can buy. `PENDING` and `FAILED` plans are
excluded from the public catalogue and refuse activation with the new
`PLAN_NOT_REGISTERED_WITH_PROVIDER`.

**Plans are repairable in place, keeping their slug.**
`PATCH /api/v1/tenant/applications/{id}/plans/{slug}` (and the `/admin` twin) now
takes `active`, `name`, `metadata`, and — while the plan has never registered —
`amount`, `currency`, `interval`. That is the old immutability rule stated
honestly rather than loosened: a provider price object cannot be re-priced, but a
plan that has no price object has nothing to contradict. A registered plan
answers the new `PLAN_PRICE_IMMUTABLE`. New:
`POST /api/v1/tenant/applications/{id}/plans/{slug}/register` retries
registration and puts the plan back on sale. Idempotent.

**Checkout no longer 500s on a plan with no provider price.** The bare
`throw new Error(...)` in the Stripe provider is now a `409
PLAN_NOT_REGISTERED_WITH_PROVIDER` carrying a `fix` aimed at the operator, who is
the only party who can act on it.

Coupons were checked for the same commit-then-register shape and do not have it:
nothing is registered with a provider at coupon-create time — the discount is
minted per checkout and discarded if the session fails. There is a regression
test pinning that, so an eager registration added later fails it.

**Migration:** `20260802160000_plan_registration_status` adds
`plans.registration_status` and `plans.registration_error`. Existing rows with a
`metadata.stripe.priceId` backfill to `REGISTERED`; everything else to
`NOT_REQUIRED` — the migration cannot tell a broken Stripe plan from a healthy
Razorpay one, and guessing `FAILED` would take working plans off sale. A plan
broken by the old behaviour therefore keeps its row and now surfaces at checkout
as a 409 naming the repair, instead of a 500.

### Breaking: `verifyAccessToken` now requires `applicationId`

```ts
await verifyAccessToken(token, { applicationId: MY_APP_ID, jwksUrl });
```

The RS256 keypair is **deployment-wide** — `SigningKey` has no per-Application
column — and `eu_access` tokens carry no `iss`/`aud`. So a token minted for any
other Application on the same deployment verified here with a perfectly valid
signature, and a multi-app self-host accepted someone else's end-user as its
own.

The docs already told callers to compare `claims.applicationId` afterwards,
which is exactly the problem: it made the shortest correct path the one nobody
takes. It is now checked inside the function, and a mismatch raises
`USER_TOKEN_INVALID`.

This does **not** affect the HS256 default, where the key is derived per
Application as `HMAC-SHA256(JWT_SECRET, applicationId:tokenGeneration)` and a
foreign token fails the signature outright. It applies precisely to the RS256
opt-in — which is the only path this helper serves.


### Security: the self-host compose sent your payment webhooks to our server

`docker-compose.prod.yml` — the file DEPLOY.md tells you to deploy — carried
Rekey's own hostnames as **literals**, not variables:

```yaml
API_URL: https://api.rekey.dev
PUBLIC_WEBHOOK_BASE_URL: https://api.rekey.dev
PUBLIC_PORTAL_URL: https://portal.rekey.dev
CORS_ALLOWED_ORIGINS: https://panel.rekey.dev,https://rekey.dev,https://portal.rekey.dev
RESEND_DEFAULT_FROM: support@rekey.dev
```

`PUBLIC_WEBHOOK_BASE_URL` is the origin Rekey **auto-registers with
Stripe/PayPal**. A self-hoster who clicked "auto-configure webhook" therefore
configured their own payment provider to POST their customers' payment events
at `api.rekey.dev`. The same block sent their transactional mail as
`support@rekey.dev` and advertised `api.rekey.dev` as their MCP OAuth issuer.
The strip that produces the public mirror only removed the marketing service;
every one of these shipped verbatim.

Every deployment-specific value is now `${VAR}` with no Rekey default, and the
three hostnames (`API_HOST`, `PANEL_HOST`, `PORTAL_HOST`) have no default at
all — `docker compose` refuses to run until you set them. The file is now
explicitly the **self-host** stack; Rekey Cloud runs per-unit composes and
never used this one. `rekey.dev`'s landing page is no longer a service in it.

**If you deployed this file:** check the webhook endpoint registered in your
Stripe/PayPal dashboard, and re-run auto-configure once `API_HOST` is set.


### Fixed: no way to close operator registration on a self-host

`OPERATOR_SIGNUP_MODE` was absent from `docker-compose.prod.yml`. A compose
`environment:` block is an allowlist, so setting it in Dokploy did nothing and
self-serve operator sign-up stayed open on every deployment built from the
documented file — the same trap that file already warned about twice, for other
variables.

That block is now complete: every variable `apps/api/src/config/env.ts` reads is
named in it, including `OPERATOR_SIGNUP_MODE`, `WORKSPACE_CREATION`, the
WebAuthn and operator-OAuth settings, the rate limits and the pool sizing. All
of them are empty by default, and empty is the same as unset.


### Added: CI fails when a compose file cannot express a setting

`.github/scripts/check-compose-env.mjs` asserts that every key declared in
`env.ts` appears in the `environment:` block of each compose file that runs an
API — or is exempt with a written reason — and that the self-host compose
contains no Rekey hostname. It runs as its own CI job, in the shape of the
`prisma migrate diff --exit-code` step next to it.

This class of bug has now happened five times (`ADMIN_IP_ALLOWLIST`,
`DEFAULT_APP_URL`, `DEFAULT_TENANT_LIMITS`, `PANEL_URL`,
`OPERATOR_SIGNUP_MODE`), each time leaving behind a comment and no guard.
Comments do not fail builds.


### Fixed: CI ran none of the 119 tests on the money path

The test job filtered `@rekey.dev/api` plus `./packages/*`. The two commercial
apps — 70 tests and 49 tests over the checkout path, the entitlement gate and
webhook HMAC verification — were maintained, passing, and executed by nothing.
They are in the filter now; neither needs Postgres or Redis, so the job costs
seconds more.

`pnpm lint` was also documented in CONTRIBUTING.md as "lint all workspaces"
while every workspace's `lint` script is `echo "(eslint not yet wired)"`. The
doc now says so. Wiring it into CI was deliberately not done: a green check that
runs no rules is worse than an absent one.


### Fixed (money): a deferred activation asked the API to delete itself

The purchase order is pay → key → workspace, so `subscription.activated` always
lands before the workspace it configures exists. The billing service answered
that with **HTTP 200** and `action: 'deferred'`. The API maps any 2xx to
`SUCCEEDED` and permanently discards the event — and `subscription.activated`
fires once, on a real status transition, and is never re-emitted. The service
then held the only remaining copy in an in-memory `Map`, and added the event id
to its dedupe set, so even a hand-triggered redelivery came back `duplicate`.

It now answers **503 `WORKSPACE_NOT_READY`** and does not remember the id, so
the API's existing durable retry holds the event and redelivers it. No new
infrastructure. The in-memory queue stays as a backstop for buyers who take
longer than the API's retry budget, and is now correctly described as one.


### Fixed: the release workflow could succeed while shipping nothing

Three defects in `publish-public.yml`:

- **Silent failures.** Workflows never set `shell:`, so steps ran under
  `bash -e` with pipefail **off**, and two steps were `curl -sf … | jq -r`. A
  4xx made curl exit 22, the pipeline reported jq's 0, and `PR_NUMBER` /
  `MERGE_SHA` became empty strings **in a green step**. The job now sets
  `shell: bash` (pipefail on), captures HTTP status codes explicitly, and fails
  with the API's own message.
- **An unrecoverable window.** Between creating the tag ref and creating the
  Release there was no way back: a re-run died at `git commit` because the tree
  was identical, leaving the public repo with code and a tag but no Release —
  and the Release is what triggers npm publish. The commit is now
  `--allow-empty`, and the PR, merge, tag and Release steps all adopt what a
  previous attempt created.
- **Stale-version tags.** Nothing compared `${TAG#v}` to the package versions,
  so tagging without bumping produced a fully green run that published nothing.
  The workflow now refuses a tag that matches no package version, and prints
  every package's version in the run summary.

### Fixed: `@rekey.dev/node` had no request timeout

Every call passed no `signal` to `fetch`, so the effective deadline was undici's
`headersTimeout` — **five minutes**. Against a server that accepts the
connection and then goes silent, a call was measured still pending at 70
seconds; `@rekey.dev/nextjs`'s `auth()` makes three of those in sequence on the
refresh path, so one unreachable deployment could pin a request handler for a
quarter of an hour.

Requests now carry a **10-second deadline by default** — the same number
`apps/api` uses for its own outbound webhooks. Against the same black-hole
server the call now rejects at 10,006ms, or at 302ms with a per-call override.

- `RekeyConfig` gains `timeoutMs` and `signal`.
- `rekey.with({ timeoutMs, signal })` returns a scoped clone, so any single call
  can have its own deadline or be tied to an inbound request's lifetime.
- `timeoutMs: 0` opts out.
- `verifyAccessToken`'s JWKS fetch is bounded too — it usually sits in a hot
  request path.

### Fixed: transport failures were not `RekeyError`s

There was no try/catch around `fetch`, so `ECONNREFUSED`, DNS and TLS failures
escaped as bare `TypeError`s. The documented
`catch (e) { if (e instanceof RekeyError) … }` pattern missed all of them.

Every failure mode is now a `RekeyError`, with three codes because they call for
three different responses: **`REQUEST_ABORTED`** (your own `AbortSignal` fired),
**`REQUEST_TIMEOUT`** (retry, or raise `timeoutMs`), **`NETWORK_ERROR`** (check
the URL, DNS, reachability). The underlying error is on `error.cause`.

`RekeyErrorSchema` also now declares **`retryAfterSeconds`**. The API has always
sent it on `RATE_LIMITED` (mirroring the `Retry-After` header) and on the
idempotency conflict; it was simply never named, so it arrived untyped.

### Fixed: `<OrganizationProfile>` silently targeted nothing

`@rekey.dev/react` posted `<input name="endUserId" value={m.id} />`.
`OrganizationMemberDto` carries **both** `id` (the membership row) and
`endUserId` (the user), set from different columns — so **every role change and
every member removal in `<OrganizationProfile>` was a no-op**, with no error.

TypeScript could not see it: the component re-declared `OrgMember` as
`{ id, email, role }`, and the real DTO is structurally assignable to that, so
handing `organizations.listMembers()` straight to the component type-checked
cleanly. `OrgSummary`, `OrgInvitation`, `PricingPlan` and `ProviderOption` had
the same problem waiting to happen.

All five are now `Pick<…>` of the real DTO. Callers who assemble these by hand
still only owe the fields that render, but a column rename is now a compile
error in the SDK rather than a silent no-op in your app.

**Action required if you build `OrgMember[]` by hand:** add `endUserId`. If you
pass `organizations.listMembers()` through, nothing changes.

### Fixed: `require()` failed on all six packages

Every `exports` map declared only `types` and `import`. Node ≥22.12 can
`require()` a synchronous ESM module, but that path was never reached: CJS
resolution runs with conditions `["require","node"]`, which matched nothing, so
`require('@rekey.dev/node')` failed outright. Adding a `default` condition (no
CommonJS build involved) unblocks Jest-CJS, ts-node and every `require()`
consumer. Verified by actually requiring each built package.

### Changed: server-authored enums are now open unions

`WebhookEventEnvelope.type` was a closed 18-member union. Writing the exhaustive
`switch` the type invites means your build breaks when 2.1.0 adds a 19th event —
and the `never` in your default branch claims the case is impossible when it is
merely unreleased.

`WebhookEventType`, `SubscriptionStatusType` (`TRIALING` is coming),
`PlanKindType`, `CreditReasonType` and `PaymentStatusType` are now
`… | (string & {})`: the known literals still autocomplete, but a default branch
is required. The closed set is still exported for registries and label maps, as
`KnownWebhookEventType`, `KnownSubscriptionStatus`, `KnownPlanKind`,
`KnownCreditReason`, `KnownPaymentStatus`. Filter/query types you *send* stay
closed. Narrow an event name with the existing `isKnownWebhookEvent`.

**Action required:** an exhaustive `switch` over these needs a `default` branch.

### Changed: `@rekey.dev/react` no longer bundles zod

Importing anything that touches `RekeyBrowserClient` pulled in the shared-types
barrel, which evaluates ~60 `z.object(...)` calls at module scope, so zod came
along. `RekeyError` — the only value the package needs from shared-types — now
lives in a dependency-free `@rekey.dev/shared-types/error` entry, and both
packages declare `"sideEffects": false`.

Measured with esbuild over the built `dist/`, minified:

| import | before | after |
|---|---|---|
| `useUser` alone | 77,655 B (zod) | **346 B** |
| `RekeyBrowserClient` | 81,797 B (zod) | **4,397 B** |
| the whole barrel | 111,028 B (zod) | **37,248 B** |

Same class object via either import path, so `instanceof RekeyError` is
unaffected.

### Added: `@rekey.dev/nextjs/cookies`

`ACCESS_COOKIE` / `REFRESH_COOKIE` were reachable only from the root barrel,
which also re-exports the middleware (importing `next/server`) and the
secret-key server helpers. A client component that wanted a cookie name had to
pull all of that in — a guaranteed build break. The new subpath has no
dependencies. The root barrel keeps exporting them.

### Fixed: importing `@rekey.dev/mcp` or `@rekey.dev/cli` hijacked the host process

Both declare `main`/`types`/`exports` like libraries, and both did real work at
module scope: `@rekey.dev/mcp` read the environment and called `process.exit(1)`,
killing the importing process outright; `@rekey.dev/cli` ran
`program.parseAsync(process.argv)`, so it parsed *your* program's arguments and
printed its own help. Neither is catchable by an importer.

Both now run only when they are the process entry point, and expose
`createServer()` / `buildProgram()` for importers. The `rekey` and `rekey-mcp`
binaries behave exactly as before.

### Fixed: `applications.me().environment` was always `undefined`

`ApplicationDto.environment` was declared required, but `GET /api/v1/me` — the
documented SDK smoke test — does not return it. The field is now optional.
Narrow before use; a deployment that does send it still parses.

### Changed: internal deps use carets, and internal symbols stay unpublished

Workspace dependencies moved from `workspace:*` to `workspace:^`. pnpm published
the former as an **exact** pin, so `@rekey.dev/node@2.0.0` alongside
`@rekey.dev/react@2.1.0` installed two copies of shared-types — two `RekeyError`
classes, and `instanceof` silently false across the two packages — plus two
copies of zod.

`stripInternal` is now enabled in all six packages. `@internal`-marked symbols
were being published as public API; the JWKS test hook
(`_clearJwksCacheForTests`) and the positional `requestRaw` are gone from the
`.d.ts`.

`Rekey.request()` is the exception and is now **supported**: it is the escape
hatch for endpoints the SDK does not wrap yet. Its signature changed from
positional `(method, path, body?, headers?)` to
`(method, path, options?)` — done now, before 2.0.0 freezes it, because a fifth
positional argument could never be added later.

**Action required if you call `rekey.request(...)`:**
`request('POST', '/x', body, headers)` becomes `request('POST', '/x', { body, headers })`.

### Fixed: the portal quoted a different price than the SDK, on every plan shape

The hosted portal formats plan prices with its own helper, because the SDK's
`formatPrice` is in a `'use client'` module and the portal renders plans on the
server. The copy had drifted on **all six** plan shapes it can render:

| plan | `@rekey.dev/react` | portal (before) |
|---|---|---|
| Free tier | `Free` | `$0.00/month` |
| One-time licence | `$499` | `$499.00 one-time` |
| Credit pack | `$9 · 500 credits` | `$9.00 one-time` |
| ¥1000/mo subscription | `¥10 /month` | `¥10/month` |

The credit pack is the one that costs money: `one-time` erases the only fact
that distinguishes one credit pack from another, so the customer could not tell
what they were buying. And the helper's own docblock claimed it followed the
same rule as the SDK "which already got this right", so nobody would check.

Both now agree, in `apps/portal/src/lib/format.ts`, with the duplication and its
reason stated at the top of the file and every shape pinned by a test.

One difference is deliberate and marked as such: JPY, KRW, VND and the other
zero-decimal currencies have no minor unit, so a ¥1000 plan is ¥1000, not ¥10.
The portal now divides by the currency's actual exponent. `formatPrice` in
`@rekey.dev/react` still divides everything by 100 and needs the same fix.


### Fixed: no error boundary anywhere in the customer-facing portal

`getPortalConfig` throws on any non-404 response from the API, and it is the
first thing `[slug]/layout.tsx` does. With no `error.tsx` in the app, a single
API blip put **Next's default error page in front of a merchant's paying
customer** — on the app whose `not-found.tsx` is explicit that this audience
never sees a Rekey error code or an operator instruction.

The portal now has three boundaries: `[slug]/error.tsx` (keeps the merchant's
header and branding), `app/error.tsx` (catches the layout itself), and
`app/global-error.tsx`. All three speak to the customer — no codes, no digest,
and an explicit "nothing has been charged or changed".

The panel, admin and marketing apps also had gaps. Panel had a boundary for
`(authed)` only, so every unauthed route was bare — including
`/mcp-consent/review`, which resolves an OAuth request mid-consent. Admin and
marketing had none at all. Each app now has a root `error.tsx` and a
`global-error.tsx`; the global ones are inline-styled and import-free, because
`global-error` replaces the root layout and therefore never gets its stylesheet.


### Fixed: concurrent token refreshes signed customers and buyers out

The panel dedupes in-flight refresh exchanges because refresh tokens rotate and
are single-use: two concurrent exchanges of one token means one wins and the
other is told its token is spent, then bounced to sign-in. The portal and the
marketing site had the identical code and no dedupe.

The portal made it the common case rather than a race: `[slug]/layout.tsx` and
`[slug]/page.tsx` both call `getPortalUser`, and React renders them
concurrently — so the first navigation after the 15-minute access token expired
fired two refreshes in the same tick. Both apps now dedupe on the token, and
`getPortalUser` is `cache()`d per request so the layout and page share one read
instead of issuing two.


### Fixed: `GET /sign-out` in the panel was CSRF-triggerable

`<img src="https://panel.rekey.dev/sign-out">` on any page an operator visited
logged them out. The admin app had already fixed this by making its sign-out
POST-only; the panel could not copy that, because Next forbids cookie writes in
a Server Component and `api()` therefore `redirect()`s here — a GET — when it
finds an expired session.

The panel route now rejects a GET whose `Sec-Fetch-Site` is `cross-site` with
405, and accepts POST unconditionally. Same-origin, same-site, address-bar
(`none`) and non-browser clients are unaffected, so the internal redirect keeps
working.


### Changed: one status-tone map instead of five

`CANCELED` was grey in the panel and portal and **red in admin** — an app whose
own `environmentTone` docblock says it "reserves red for things that need
attention". `PAST_DUE` was amber for the operator and red for the customer, so
one account looked routine to support and alarming to the person paying.
Labels came out as `Past due`, `past due` and raw `PAST_DUE` depending on the
screen, the middle one via a non-global `replace('_', ' ')` that mangles any
two-underscore enum (`NOT_CONFIGURED` → `Not_configured`).

`apps/panel/src/components/StatusPill.tsx` is now the canonical map; the portal
and admin copies mirror it and say so. Two panel pages that had re-created their
own local maps use `<StatusPill>`. Red now means a fault: `FAILED`, `REVOKED`,
`SUSPENDED`, `EXHAUSTED`, `DOWN`. Endings are grey.


### Fixed: one payment, two formats — and a 100× hazard in the marketing app

The same payment rendered `$9.99` on the panel's payments page and `9.99 USD`
on the end-user detail page, from two formatters in the same app. The detail
page now uses the shared `formatMoney`.

`formatCurrency` in `apps/marketing/src/lib/utils.ts` is deleted. It formatted
its argument **without dividing by 100** while every other layer in the product
speaks minor units. It had zero call sites, which is what made it dangerous: a
generic, correct-looking helper in the shared utils of the app that runs
checkout, one import away from rendering a $9.99 plan as $999.00.


### Performance: the panel fetched the same application up to three times a page

Server Components resolve independently, so `applications/[id]/layout.tsx` and
the page inside it each fetched `GET /tenant/applications/:id` — and on
`plans`, `payments`, `dunning` and `coupons`, `<BillingModeBanner>` fetched it a
third time. `/tenant/auth/me` was fetched by the authed layout and again by
`/applications`, `/team`, `/workspace` and `/account/security`.

`lib/api.ts` gains `apiGet` / `getApplication` / `getMe`, memoised with
`React.cache`. This is per-request and per-render, not a data cache: two
components in one render share one response, the next navigation fetches again.

The audit log also lost a serial round-trip — its workspace-members read sat in
a `Promise.all` **over a single element**, so the per-actor fan-out could not
start until it resolved. Both waves now go together.


### Fixed: "Next →" onto an empty page

Every panel list inferred `hasMore` from `count === pageSize`, which is
confidently wrong whenever a result set is an exact multiple of the page size —
25 end users at 25/page rendered a Next arrow onto a page reading "No results".

All thirteen paged lists now ask the API for one row more than they render and
pass a `hasMore` they actually measured (`apps/panel/src/lib/paginate.ts`).
`<Pager>` keeps the old inference only as an explicit opt-out.

Note for anyone reading the original report: the tenant list endpoints do **not**
return `{total, limit, offset, hasMore}` and never have — `pageMeta` exists in
`apps/api/src/lib/pagination.ts` but only `GET /admin/operator-invites` uses it.
So no `count()` was being computed and thrown away. One case remains
un-fixable client-side: at 100 rows/page the over-fetch would be `limit=101`,
which `parsePagination` rejects, so that page size still falls back to the guess.


### Removed: a `localStorage` token client in the marketing app

`apps/marketing/src/lib/api.ts` read an auth token out of `localStorage` — in
the app whose `session.ts` docblock explains that this pattern turns "a single
XSS into session takeover". It had no importers, but it exported a
ready-configured axios instance named `api`, and its provider tree pulled
`@tanstack/react-query`, `axios` and `sonner` into every page for zero
consumers. Deleted, along with `hooks/use-api.ts`, `lib/react-query.ts`, the
query and toast providers, and the four dependencies.


### Added: tests for the three apps that had none

`apps/panel`, `apps/portal` and `apps/admin` had no test script. Each now has
the same setup as `apps/marketing` (one `vitest.config.ts` and a `server-only`
stub) and covers what is cheapest and most load-bearing:

- **portal** — `safeCssColor` / `safeHttpUrl`, the validators standing between
  operator-supplied values and an inline `style` and an `<img src>` on a
  customer-facing page; plus every plan-price shape.
- **admin** — `lib/auth.ts` end to end: `verifyKey`'s length pre-check before
  `timingSafeEqual` (which throws on mismatched lengths), `validateSession`'s
  sliding expiry, and `checkAndCountLoginAttempt`'s exactly-five-then-refuse.
- **panel** — the refresh dedup, proved with a counting fetch stub that 401s a
  reused token exactly as the API does; `describeUserAgent`'s order-dependent
  cascade including the `node|undici|next` branch that stops an operator
  revoking their own session; and the status and pagination helpers.

### Security: ten auth and authorization defects, from an adversarial review

Every one of these was reproduced against a running server. Several change
behaviour a caller can observe — those are called out as **contract change**.

**Operator failed sign-ins and lockouts are now recorded.** Ten failed operator
sign-ins produced zero rows in `security_events`. The lockout fired — the Redis
key was there with a TTL — and was invisible in every operator- and
admin-facing surface, including for a locked-out workspace OWNER, the account
that owns every application, key and payment credential in a workspace. Sign-in
now emits `operator.sign_in_failed` per attempt and `operator.locked_out` once
per lockout, attributed to the operator's primary workspace (an operator
failure happens before a workspace is chosen, and every reader of the audit log
is workspace-scoped, so `tenantId: null` would have been another way of writing
nothing). `GET /api/v1/admin/metrics/locked-accounts` gained `operators` and
`operatorsTotal` alongside the existing end-user `accounts`.

**MFA can no longer be removed with a stolen token.** `POST /auth/mfa/setup`
reset `enrolledAt` on an existing credential with no proof of anything, which
reached the same end as `/mfa/disable` without passing its guard. The operator
twin, `POST /tenant/auth/mfa/disable`, required no factor at all.
*Contract change:* both surfaces now demand a current authenticator or backup
code before re-enrolling over a completed enrollment, and the operator disable
route demands one too. The account password is deliberately not accepted while
an authenticator is enrolled. First-time setup is unaffected, as are secret-key
callers on the end-user surface.

**Passkey verification is no longer downgradeable.** *Contract change.* All four
WebAuthn ceremonies asked for user verification as "preferred" and verified with
the requirement off, while a passkey assertion mints a session directly and
skips the MFA challenge — so an authenticator that declined the PIN/biometric
turned password + TOTP into a touch, on both the end-user and operator
vocabularies. User verification is now **required** on both ends of both
ceremonies. A security key with no PIN configured is refused rather than
silently accepted. Operator passkey enrolment also gained the step-up the
end-user route has had.

**Organization invitations are bound to the invited email.** *Contract change.*
`POST /auth/organizations/accept-invitation` did not check that the accepting
session's address matched the invitation, so anyone holding a forwarded invite
link joined at the invited role — up to OWNER. It now answers 403
`ORGANIZATION_INVITATION_EMAIL_MISMATCH`. The operator twin has enforced this
all along; this is that check, ported.

**Impersonation is revocable, and bounded in what it can do.** *Contract change.*
`impersonation_audits.endedAt` was documented in the schema and written by no
code path, so a minted token ran to expiry no matter what anyone did. The audit
row is now created before the token and its id rides in the JWT, so
`POST /tenant/applications/:id/end-users/:euid/impersonate/end` (new,
OWNER/ADMIN) revokes every live session on that end-user immediately. Separately,
an impersonated session is now refused on the routes that rebind credentials —
password change, MFA setup/disable, passkey enrolment and removal — with 403
`IMPERSONATION_ACTION_FORBIDDEN`; those changes outlive the five-minute token
permanently, which is the one thing a lifetime cannot bound. Reads, billing and
profile edits are untouched. Tokens minted by an older build are refused.

**The operator surface is no longer an account-existence oracle.**
*Contract change.* `/tenant/auth/forgot-password` and
`/tenant/auth/magic-link/request` answered `delivered: false` for an address
with no operator account and `true` for one that had; both now return one
constant body whatever happened, matching the end-user surface's posture. Sign-in
skipped argon2 entirely for an unknown email (measured 9.0 ms vs 3.3 ms, no
overlap) and counted failures only for accounts that exist, so the 429 after ten
attempts answered the same question without any measurement — both are fixed.
Sign-up still answers 409 for a duplicate address, consistent with the end-user
surface, because a sign-up form has to tell a person why their account was not
created.

**Operator MCP read tools apply the role gate and per-application grants.**
*Contract change.* An `APP_VIEWER` MEMBER — granted sight of exactly one
Application — could self-grant an OAuth token and read another Application's
end-users plus the full workspace security log, IPs and user agents included,
while the REST equivalents answered 404 and 403 for the same account. Read tools
now resolve their Application set through the same matrix `lib/app-access.ts`
applies (including the legacy rule that a MEMBER with zero grants keeps
workspace-wide read), and `recent_security_events` / `list_invitations` require
OWNER or ADMIN, matching their REST routes. They are no longer listed to a
caller who cannot call them.

**Coupon `maxRedemptions` now bounds discounts, not just bookkeeping.**
*Contract change.* Five concurrent checkouts on a `maxRedemptions: 1` coupon
were all discounted at the provider and produced one redemption row: the
discount is committed at checkout, the limit was counted against rows written at
payment. Checkout now reserves the slot up front with a 30-minute expiring hold,
so the limit counts recorded redemptions plus in-flight checkouts. Losers get
400 `COUPON_REDEMPTION_LIMIT_REACHED`. The hold expires by itself, so an
abandoned checkout does not exhaust the coupon — which is why redemptions were
moved off checkout-creation in the first place.

**An unknown email `eventKey` is a 404, not a 500.** The preview and test-send
routes passed a URL path segment into a bare `throw new Error`, so a stale event
name in an operator's URL produced `INTERNAL_ERROR` and a page in the error log.
It now answers 404 `EMAIL_EVENT_UNKNOWN`, the same code the sibling GET/PUT
routes on the identical parameter already returned.

**`GET /api/v1/me` matches its published `ApplicationDto`.** The documented SDK
smoke test omitted `environment` — required in the schema, so callers read
`undefined` typed as an enum — and returned `authConfig` / `billingConfig` as
raw Prisma JSON, so `AuthConfigSchema`'s defaults never ran and a field added
after a row was written came back `undefined`. Both are now sent, and the
shaper's return type is the DTO, so the next divergence is a compile error.
### Fixed: the Developer section was unreachable on a phone

At a 375px viewport the application's primary nav measured 457px of pills
against a 375px box with `overflow-x: visible`, inside a `<main>` that clips
horizontal overflow. That is not "slightly cut off" — **API keys, Webhooks,
Requests, Access and Email could not be opened on a phone at all**, and
"Billing" was truncated mid-label. The secondary row had scrolled correctly for
a while; the primary row now gets the same `overflow-x-auto`, the same
scroll-the-active-item-into-view effect, and the same edge fade.

`<main>` moved from `overflow-x-hidden` to `overflow-x-clip` as part of this.
`hidden` silently makes the element a scroll container, and because `<main>` is
never height-constrained it was a scroll container that could never scroll —
which broke `position: sticky` for everything inside it.


### Fixed: billing sub-pages broke the nav when billing was off

On `/applications/{id}/plans` — and payments, coupons, revenue, dunning,
licenses, usage, portal — with billing disabled, the tab labelled **"Overview"
carried `aria-current="page"` and linked to the page you were already on**. No
sub-tab row rendered and there was no way back. It was one click from the
default landing page: the application Overview's Configuration list and the
get-started checklist both link into billing while billing is off.

The cause was the Billing group collapsing to a single child while disabled, so
`plans` matched no group at all and the `?? groups[0]` fallback marked Overview
active. The group now keeps its full child list in both states; only the link
target of the group pill changes.


### Fixed: a 404 rendered as a crash page

`/applications/<bad-id>/end-users` answered with "Something went wrong loading
this page… contact support (ref …)" and a single "Try again" button that could
never succeed. The UI could not distinguish "does not exist / not yours" from
"we are broken".

The panel API client now maps 404 to `notFound()` and 403 to `forbidden()` on
read requests, so both get a real page that keeps the chrome and offers a way
out. Mutations still surface a `PanelApiError` so server actions can re-render
a form with the operator's input intact. The generic error card also gained a
"Back to applications" link.


### Fixed: every primary button failed WCAG AA

Measured in-page: `#ffffff` on `#14b8a6` is **2.49:1** at 14px, where AA needs
4.5:1 and even the large-text exemption needs 3:1. Light theme's `#ffffff` on
`#0d9488` is 3.74:1, also failing. That was every primary CTA in the product —
Create application, New API key, New end-user, Save changes, Enable billing,
Mint key — while the destructive button passed at 4.83:1. The most-used control
had the worst contrast in the app.

The brand teal is unchanged. The label flips to ink (`--color-primary-fg`,
`#0a0a0a`), giving **5.29:1** in light and **7.95:1** in dark. Because the label
is now dark, light theme's hover step moves 600→500 rather than 600→700, so
hover brightens in both themes instead of only one; hover measures 7.95:1 and
10.64:1.

The publishable key in the application header also moved from
`--color-faint-fg` to `--color-muted-fg`: **3.72:1 → 7.85:1**, on a value the
operator is meant to read and copy character by character.


### Fixed: workspace deletion told self-hosted operators to email a vendor

The deletion flow ended in "Email support@rekey.dev from the OWNER address" —
hard-coded and unconditional. On a **self-hosted** deployment that instructs the
customer to email Rekey about rows in a database Rekey has no access to and
cannot touch. It is not merely unhelpful; it cannot be followed.

The address now comes from `PANEL_SUPPORT_EMAIL`. Unset — the default, and
therefore what every self-host sees — switches the copy to the truthful answer:
deletion is an operation you run against your own database, with the exact
`DELETE FROM tenants WHERE id = …` (everything under it cascades), a `pg_dump`
warning, and a copy button. Rekey Cloud sets the variable and keeps the manual
support path, where the friction is deliberate.


### Fixed: the audit log printed raw event keys for 44 of 54 event types

The label map had 10 entries against 54 emitted types, so ordinary setup
produced rows reading `app.plan_created / app.plan_created` — the key printed
twice, once as its own label. The same 10 entries populated the Event-type
filter, and a hand-typed `?type=` outside them was silently discarded.

All 54 are now labelled, the filter is built from the same map, unknown keys are
humanised rather than printed raw, and any syntactically valid `?type=` is
passed through to the API instead of being dropped.


### Fixed: the audit log and Activity identified people by CUID

Payments and Dunning show an email because their endpoints return one. The
audit log and Activity showed a 25-character CUID because
`GET /tenant/security-events` has no relations to join and no email in its
serializer. "Who is `cmsa91v4c000nv5h5txnjvvry`?" had no answer inside the
product. The panel now resolves actors a page at a time — operators from the
members list, end-users by id, deduped and capped — and links end-users to their
page, falling back to the CUID when a lookup fails.


### Added: per-user auth events, and an honest account of what isn't recorded

The end-user page showed "Failed sign-in attempts: 7" with no threshold, and
that user's events appeared nowhere: Activity is application-wide and had no
filters. The counter now reads "7 of 10" with the lockout duration, a
**Recent auth events** panel lists that user's last 20 events with reason codes
and IPs, and Activity gained an email filter.

Both surfaces state plainly that **failed sign-ins and lockouts are never
recorded as events** — the API increments a Redis counter and discards the
detail — so nobody concludes from an empty list that a locked-out user did
nothing.


### Added: webhook endpoint health, delivery detail, and bulk retry

An endpoint with 12 of 12 deliveries failing rendered "● Enabled" in green,
identical to a working one; finding it meant opening Details on every endpoint
in turn. The list gained a **Last 24h** column ("12/12 failed", amber/red) and a
banner when any endpoint is failing.

Delivery rows are now expandable, showing the delivery and event ids, response
status, error and next attempt — and the stored `payload` and `responseBody`
whenever the API serves them. **It does not yet:** the tenant delivery route
loads both fields and then drops them from its response, so the expanded row
explains that rather than showing an empty box. **Retry all failed** replaces
twelve individual Retry clicks.


### Fixed: access-control placeholders read as configured values

On `/applications/{id}/access`, empty IP-allowlist and CORS fields showed
example values (`10.0.0.0/8`, `https://app.example.com`) in the same mono face
as a real entry at 7.4:1 — indistinguishable from configuration, on a security
page. Placeholders are now dimmed and italic, prefixed "e.g.", and each field
states its live effect affirmatively the way the API-keys page already did:
"No IP allowlist set — secret keys may be used from any address."


### Added: a sticky save bar with a dirty guard on Auth methods and Access

Auth methods is 14 controls over ~1970px with one Save at the very bottom and no
dirty state; navigating away discarded everything silently. Both pages now share
a sticky footer that shows "Unsaved changes", promotes the Save button when
there is something to save, and confirms before an in-app link or a reload
throws the edits away.


### Fixed: the get-started checklist ticked billing with zero providers

"Enable billing and add a provider" was satisfied by `billingConfig.enabled`
alone, so the checklist reported production-ready on a state where checkout
fails with `BILLING_CREDENTIALS_NOT_CONFIGURED`. It now requires a configured
provider too, and says so when billing is on but unconfigured.


### Added: scopes and expiry on panel-minted API keys

The API has always accepted `scopes` and `expiresAt` on this endpoint; the panel
sent neither, so every panel-minted key was full-access and never expired. The
mint modal now offers both. Note that the API turns an empty `scopes` array into
`['*']`, so the panel omits the field entirely rather than posting `[]` — the UI
never says "no scopes" while minting a full-access key.


### Fixed: hydration mismatch on every page with a Modal

The dialog id came from a module-level counter, which does not agree between a
server process that has rendered other modals and a freshly loaded client:
server emitted `rekey-modal-2-title`, client `-3-`. React logged "This won't be
patched up" on every page containing a Modal. It now derives from `useId()`.


### Fixed: the slug field was a dead end

Typing "Northwind Store" left Slug empty and disabled the submit with nothing
naming the blocking field; a click during "Checking availability…" hit a
disabled button and did nothing at all. The slug is now prefilled from the name
(and stays linked until you edit it), the submit is never disabled — a blocked
submit focuses the field and says why — and a click during the check is held and
released when the answer arrives.


### Fixed: inconsistencies between comparable surfaces

One `<StatusPill>` replaces the divergent status rendering that showed uppercase
`FAILED` on /payments and title-case `Failed` on /revenue from two separate tone
maps. Empty states on /team use the shared `<EmptyState>`, and /coupons gained
the CTA that /applications already had. Confirm dialogs and the create modal now
render the same `<dialog>` chrome. Application sub-pages emitted two `<h1>`
elements (the layout's application name plus their own); `PageHeader` takes a
`level` so the nested ones are `<h2>`.

Also: "Active sessions" listed a device called `node` — the User-Agent of the
panel's own server-side fetch — on a page that says "Revoke any you don't
recognize". It is now labelled as the panel with a note saying revoking it signs
you out.

### Fixed: four consecutive commands failed on a fresh clone

Someone cloned the repo and followed `docs/quickstart.md` verbatim. Nothing
worked, in four different ways, none of them documented:

1. **`pnpm db:migrate:deploy`** → `Environment variable not found: DATABASE_URL`.
   The root script delegated to `apps/api`, so Prisma ran with CWD `apps/api`
   and `--schema ../../prisma/schema.prisma` — meaning it looked for `.env` in
   `apps/api/` and `prisma/`, never the root `.env` the docs had just told you
   to create. The four `db:*` scripts now run Prisma **from the repo root**,
   where its own dotenv loader finds that file. (This is what CI already did.)
2. **`pnpm dev`** → `ERR_MODULE_NOT_FOUND: @rekey.dev/shared-types/dist/index.js`.
   The `dev` task in `turbo.json` had no `dependsOn: ["^build"]`, so the apps
   started against workspace packages that had never been built. It has one now.
3. **`pnpm build`** → ~20 × `Module '"@prisma/client"' has no exported member
   'Prisma'`. The Prisma client had never been generated, `pnpm db:generate`
   existed, and no document mentioned it — `migrate deploy`, unlike
   `migrate dev`, does not generate. `build`, `dev`, `typecheck` and `test` now
   run it first.
4. **`pnpm dev`, again** → `Invalid environment variables: DATABASE_URL,
   JWT_SECRET, SUPER_ADMIN_KEY`. Nothing in the chain loaded the root `.env`:
   not pnpm, not turbo, not tsx, not the API. `dev` now runs under `dotenv-cli`,
   and the `dev` task passes the environment through to its children.

Fixed in the tooling rather than documented as a workaround, because four lines
of configuration beat four paragraphs telling people to work around it. The
docs were then rewritten to match, and the whole path re-run from a scratch
copy of the repo: install → configure → migrate → dev → bootstrap → first
end-user.

`@rekey.dev/api`'s own `db:*` scripts are unchanged; they still expect an
`apps/api/.env` if you invoke them directly from that directory.

### Fixed: `rekey --version` was an unknown option

`rekey version` worked; `rekey --version` — which is what everybody tries
first — printed `error: unknown option '--version'`. Both work now. The
subcommand stays, because it is the one that honours `--json`.

`rekey --help` also pointed at `packages/cli/AGENTS.md`, a monorepo path that
means nothing to someone who installed the package from npm. It now names the
`AGENTS.md` shipped inside the tarball, with a URL.

### Docs: the React component library, outbound webhooks, and a restore runbook

Three documents that should have existed:

- **`docs/react-components.md`** — `@rekey.dev/react` ships `SignIn`, `SignUp`,
  `UserButton`, `Protect`, `OrganizationSwitcher`, `CreateOrganization`,
  `OrganizationProfile`, `PricingTable`, `CheckoutButton` and `ProviderPicker`
  plus theming, and `docs/` mentioned none of them while the site promised
  "drop-in components". Props, defaults and a working example per component.
- **`docs/webhooks.md`** — the site served `/docs/webhooks` and the CHANGELOG
  referred to `docs/webhooks.md`, which did not exist. Envelope, signature
  verification, the delivery and retry schedule as the code actually
  implements it, and the full event catalog.
- **`DEPLOY.md` → Backup, restore, and getting your data out** — `pg_dump` /
  `pg_restore` mechanics, the `ENCRYPTION_KEY` caveat that makes a dump
  restorable or not, and how export works on a self-hosted deployment versus on
  Rekey Cloud.

Corrections in passing, each checked against the code rather than against the
previous sentence:

- `@rekey.dev/node`'s README said Rekey sends **13** webhook events and listed
  13. It sends **17** — `user.erased` and the three `dunning.*` events were
  missing.
- That README's three-step quickstart ended on `billing.getEntitlements()`,
  which throws `403 BILLING_DISABLED` on a new Application because
  `billingConfig.enabled` defaults to `false`. The precondition is now stated
  where the call is.
- `@rekey.dev/react`'s README claimed `GET /api/v1/billing/providers` is
  "secret-key guarded and rejects public keys". It accepts the publishable key,
  by design and with a comment saying so.
- `.env.example` said a missing `ENCRYPTION_KEY` makes the API "log a critical
  warning at boot". It refuses to boot. It also refuses to boot on the value
  `docker-compose.yml` shipped as a default before this release.
- `.env.example` claimed defaults for `PANEL_URL` and `PUBLIC_PORTAL_URL` that
  `config/env.ts` deliberately does not have — and set `PANEL_URL` to a
  placeholder domain, which is worse than leaving it unset.
- The README's Examples table had headers and no rows, and linked
  `github.com/EtherLabZ/Rekey/issues/184`, which 404s. The `examples/` apps were
  removed in #261; the README, both SDK READMEs and `docs/portal.md` now say so
  instead of linking into the hole.
- `CONTRIBUTING.md` asked for Node 20 (`engines` says 22) and said
  `docker compose up` boots the full stack (it needs `--profile full`).
- `/docs/sdk` was missing `billing.cancelSubscription`: the generated
  `sdk-reference.json` is committed and was only ever regenerated by hand. A
  `prebuild` hook now regenerates it before every marketing build.

### Fixed (money): two Applications sharing one payment provider lost each other's webhooks

Three provider ids were unique across the whole deployment rather than per
Application: `webhook_events (provider, provider_event_id)`,
`payments.provider_payment_id`, and `subscriptions.provider_sub_id`. That
assumed one Stripe / PayPal / Razorpay account per deployment. Two Applications
wired to the same account — a staging app beside production, or a cloned app,
which is the mundane way this happens rather than an attack — see the *same*
`evt_…`, charge and subscription ids, and collided:

* The second tenant's genuine `invoice.paid` hit the unique constraint, the
  pipeline read the first tenant's already-processed row, and answered
  `200 {received: true, processed: false, reason: "duplicate"}`. **The provider
  stops retrying on a 200, so that tenant's event was lost permanently and
  silently.**
* The payment applier's duplicate-recovery path then looked the charge up by
  `provider_payment_id` alone and returned **another tenant's payment id** into
  the victim's event stream.
* A subscription activation for the second tenant threw on the unique
  `provider_sub_id`, the webhook answered 5xx, and the provider retried an
  activation that could never succeed.

All three keys are now scoped by `application_id`. The migration creates each
new index before dropping the old one, so there is no window without an
idempotency guard; the new keys are strictly weaker than the ones they replace,
so it cannot fail on existing data.

Nothing changes for a deployment with one provider account per Application: a
replay of the same event id *within* one Application is still a duplicate.

### Fixed (money): billing events could be lost between the payment and the outbox

`applyPaymentSucceeded` committed money in a transaction and then, in a detached
`void (async () => …)()`, re-read the database to insert the outbound-webhook
delivery rows. A pod rotation or a connection-pool timeout in that gap lost
`payment.succeeded` **permanently** — the delivery poller only re-attempts rows
that already exist, and no row had been written. The comments called this a
transactional outbox; an outbox that starts after an un-retried async hop is not
one.

Delivery rows are now written inside the same `$transaction` as the state change
that causes them, across the inbound-webhook appliers, the dunning state machine
and the self-service/operator cancels. Only the first delivery *attempt* is
post-commit, and losing that costs latency rather than the event: the row is
`PENDING` with `nextAttemptAt` in the past, so the poller picks it up.

The remaining fire-and-forget emitters (the auth and user-lifecycle events,
which have no single transaction to join) now **log** when an enqueue fails.
They were `void emit(…).catch(() => undefined)`, which discarded the only signal
that an event had been dropped.

### Fixed: PayPal and Razorpay calls had no timeout, including on the webhook request path

Node's `fetch` has no default request timeout, and `providers/paypal.ts` made
eleven bare calls. The sharpest ran synchronously inside the inbound-webhook
handler: a wedged `api-m.paypal.com` held a Fastify handler open indefinitely,
PayPal retried and opened another, and the process ran out of connections while
`/health/live` — which touches neither PayPal nor the handler pool — stayed
green. Razorpay's SDK was constructed with no options at all, so its axios
client ran on `timeout: 0`; Stripe inherited its SDK's 80-second default.

Every provider call now carries a deadline: 10s for management calls, 4s for the
two on the webhook request path. Online verification stays on the request path —
PayPal's signature check *is* the authentication for that route — but an
unreachable PayPal now answers **503**, not `401 WEBHOOK_SIGNATURE_INVALID`.
Telling a provider its own signature was bad, when the fault is that we could
not reach the provider to ask, is how an endpoint gets disabled for someone
else's outage.

### Performance: operator lists, entitlement resolution, coupon stats, CORS refresh, pool sizing

* `end_users` had no `(application_id, created_at)` index, so the operator
  end-user list read every row for the application and sorted it. Measured on
  40k users in one app: **9.81 ms → 0.04 ms**, 590 buffers → 4.
  `payments`, `subscriptions`, `licenses` and `organizations` are the same query
  shape and get the same index.
* `GET /api/v1/billing/entitlements` — the call customer apps make on every page
  load — resolved each subscription's plan in a sequential `await` inside a
  loop. Now one `IN` query, grouped in memory: for a three-subscription subject,
  **3 queries / 2.21 ms → 1 query / 0.80 ms**. The same fix applies to the
  usage-quota lookup on `usage.record`.
* The coupon list pulled every redemption row to compute a count and a sum in
  JavaScript — no `take`, so a coupon's entire history crossed the wire. Now one
  `groupBy`: at 40k redemptions, **65.9 ms → 4.4 ms** and 40,000 rows → 1.
* The CORS origin cache ran `application.findMany()` with no `where` and no
  `take` every 30 seconds, forever, loading every Application in the deployment
  into memory. It now filters to applications that can contribute an origin and
  reads them in cursor-paged batches.
* Prisma's pool was never sized, so every deployment ran on `num_cpus * 2 + 1` —
  five connections on a 2-vCPU container, shared with a webhook worker that runs
  ten jobs concurrently. `DATABASE_POOL_SIZE` (default **20**) and
  `DATABASE_POOL_TIMEOUT_SECONDS` (default 10) now set `connection_limit` and
  `pool_timeout`; a value already in `DATABASE_URL` still wins.

### Fixed: the operator MCP 401 carried no `WWW-Authenticate` header

RFC 9728, which the MCP specification makes a MUST, uses the 401 itself to point
an undiscovered client at the authorization server. The operator MCP endpoint
set the header only on its **success** reply — that is, only on the one response
belonging to a client that already had a token. A spec-compliant client could
not discover the surface at all, and Claude specifically will not honour the
header on a 200.

The header is now set in the auth hook before it can throw, so it rides every
401 as well as the success reply. The per-Application MCP endpoint was already
correct; this was the operator surface only.


### Fixed: `verifyWebhookSignature` and RS256 `verifyAccessToken` threw on every npm install

**Both functions were unusable from a published package, in every released
version, including the stable `1.1.2`.** They lazily loaded Node's crypto with a
bare `require('node:crypto')` — but `@rekey.dev/node` is `"type": "module"` with
ESM-only `exports`, so in the built output `require` is not defined:

```
ReferenceError: require is not defined
```

`verifyWebhookSignature` is the function the docs tell you to gate billing on,
so anyone who followed that advice found it throwing the first time a webhook
arrived. Both now use `createRequire(import.meta.url)`, which is what
`@rekey.dev/mcp` already did correctly. The lazy load is kept — crypto is the
only Node builtin this SDK needs, and importing it eagerly would break the edge
runtimes that can otherwise use the rest of the client.

The signature scheme itself was never wrong: `HMAC-SHA256` over
`` `${t}.${rawBody}` ``, exactly as `docs/webhooks.md` describes. Only the helper
was broken.

Why it survived six releases: the tests imported the TypeScript source, which
vitest transpiles into an environment where CommonJS interop is available, so
they never touched the artifact that ships. It also does not reproduce under
`node -e`, because inline eval defines `globalThis.require` — it appears only in
a real `.mjs` file or a `"type": "module"` package. `packages/sdk-node/test/built-artifact.test.ts`
now runs against `dist/` in a spawned Node process, and `pnpm test` builds first
so it cannot drift.


### Security: `docker-compose.yml` shipped a working `ENCRYPTION_KEY` default

**Anyone who deployed the reference compose file without setting
`ENCRYPTION_KEY` has been encrypting with a key published in the repository.**
That key is AES-256-GCM over every stored provider credential (Stripe, PayPal,
Razorpay), OAuth client secret, TOTP seed, SMTP password and RS256 private
signing key — so a stolen database dump was decryptable by anyone with the
public source.

The default was easy to miss precisely because the file looked careful. Its
neighbours `JWT_SECRET` and `SUPER_ADMIN_KEY` defaulted to `change-me-in-prod`,
which is 17 characters, fails the 32-character minimum, and crashes the boot —
so an operator following the errors generated exactly those two secrets and
never learned a third existed. `ENCRYPTION_KEY`'s default was a valid 64-hex
string that satisfied both the schema and the production presence check, so it
never raised anything.

- The compose default is removed. `ENCRYPTION_KEY` is now required, and compose
  refuses to start without it.
- The API additionally **refuses to boot in production** if `ENCRYPTION_KEY` is
  the published value or a single repeated character, rather than warning. A
  deployment that copied the old file would otherwise keep working silently
  after upgrading, which is the whole problem.

**If you may be affected:** rotate the affected credentials **at the provider**
(Stripe, PayPal, Razorpay, your SMTP host, any OAuth app) and treat stored TOTP
seeds as known. Note that changing `ENCRYPTION_KEY` alone does not re-encrypt
existing rows — they were written under the old key and must be re-entered.

### Behaviour change: existing Applications begin sending a second email at sign-up

`authConfig.sendVerificationEmailOnSignUp` is new in this release and defaults
to **`true`**, so an Application that upgrades and changes nothing starts
posting the `email_verification` mail alongside `welcome` on every password
sign-up. Nothing breaks — delivery is fire-and-forget and cannot fail an
account creation — but your users will receive mail they did not receive
before, from your configured transport, against your sending quota.

Set `sendVerificationEmailOnSignUp: false` to keep the old behaviour. Full
entry, including what the switch does and does not cover: [email verification
is configurable per Application](#added-email-verification-is-configurable-per-application).

Filed here rather than under *Added* because "an existing deployment does
something new without being asked" is the thing a self-hoster reads a changelog
to find, and the original entry sat below three `### Breaking:` sections where
nobody skimming for it would.

### Behaviour change: the MCP JSON-RPC endpoint now requires the `mcp:account` scope

`POST /api/v1/mcp/<slug>` previously accepted any valid access token from the
Application's authorization server, whatever scope it carried. It now returns
403 `insufficient_scope` without `mcp:account`.

This tightens a **live** surface, so it is called out here rather than left
inside the OIDC feature entry. Clients that requested `mcp:account`, or no
scope at all (which still defaults to it), are unaffected; a token minted with
an unrecognised scope string is not. Refresh tokens issued before this release
carry no recorded scope and are read as `mcp:account` — exactly what they used
to be re-issued with, so existing sessions keep working. Full entry: [an
Application can be an OpenID Connect
provider](#added-an-application-can-be-an-openid-connect-provider).

### Fixed: a verification email with no button, and no way to ask for another

Two halves of the same lockout, both reproduced against a running server.

- **The mail went out with nothing to click.** When no verification link
  resolves — no `authConfig.appUrl`, no usable `redirectUrls` origin, no
  `DEFAULT_APP_URL` — `buildTokenUrl` returns `''` and the template drops the
  button, which is right for the welcome mail and useless for this one: the
  body says "click the button below to confirm this is your email address" and
  there is no button. With `sendVerificationEmailOnSignUp` defaulting on, every
  new user of such an Application got it. **Sign-up now skips the send
  entirely** in that case and records an `auth.email_delivery_failed` security
  event naming the setting to fix, rather than mailing a dead end. No token is
  minted either. The explicit `POST /auth/send-verification` is unchanged: it is
  an integrator call whose documented no-transport contract hands back
  `verificationToken` for the customer's own server to deliver, and refusing to
  mint would break integrations that never used our template.
- **New: `POST /api/v1/auth/resend-verification`.** Composed with
  `requireEmailVerification`, the above stranded users permanently: the gate
  denies the session that `/auth/send-verification` requires, so there was no
  self-service route back and the only fix was an operator marking the address
  verified by hand. The new route takes `{ email, verifyUrl? }` and no session.
  It is enumeration-safe by construction — a publishable-key caller gets one
  constant 200 body whether the address is unknown, already verified, erased or
  genuinely mailed, with the same flattening delay `/auth/forgot-password`
  uses, and it never raises `EMAIL_ALREADY_VERIFIED`. A secret-key caller gets
  the real outcome and the raw token when no transport is configured, matching
  `/auth/forgot-password` exactly. Rate-limited per (Application, address, IP)
  plus the per-Application auth ceiling, on the same cap as
  `/auth/forgot-password` — it is the same surface: an unauthenticated,
  address-keyed request that puts one email in flight.
- **`auth.resendVerificationEmail({ email, verifyUrl? })`** on `@rekey.dev/node`,
  binding the new route. Additive. `sendVerificationEmail` beside it still takes
  an access token, so it was no help to precisely the user who needs this.
  Branch on `emailSent` and deliver `verificationToken` yourself, the same shape
  `requestPasswordReset` returns. The browser SDKs are unchanged: `@rekey.dev/react`
  binds no unauthenticated credential-send today, not `/auth/forgot-password`
  either, so there is no sibling there to match.

`EMAIL_NOT_VERIFIED`'s `fix` string and `docs/errors.md` both said there was no
way to re-send. That is no longer true, and both now name the new route.

`apps/marketing/public/openapi.json`, which feeds the published API reference,
is regenerated here too — it is a checked-in `openapi:dump` artifact that nothing
in CI rebuilds or verifies, so the new route was absent from the reference. The
regenerated diff is exactly that one path, which is the good case; nothing keeps
it that way, and a drift check on the dump is still missing.

### Added: `oidcEnabled` has a panel toggle

Enabling the OpenID Provider was a hand-rolled `PATCH …/auth-config` — it was
excluded from the operator MCP write tools on the grounds that standing up a
public authentication surface is an operator-console decision, while the
console had no control for it. **Panel → Application → Auth → Security policy**
now has *Act as an OpenID Connect provider*, next to *Require a verified
email*, which the `email` claim depends on. The copy states what switching it
on publishes: an unauthenticated discovery document, `id_token`s, `/userinfo`,
and self-registering relying parties by default.
`docs/oidc-provider.md` no longer lists the missing UI under *Not built*.
`dynamicClientRegistration` still has no panel control.

### Added: end-users can edit their own `metadata`

`EndUser.metadata` was readable and unwritable. The schema advertises it as the
place for display name, avatar and custom fields, `GET /api/v1/users/me`
returns it, and every write path was operator-side — so an integrator could
show a profile and never let the user edit it.

- **`PATCH /api/v1/users/me`** (new public endpoint). Takes the publishable key
  plus the user's own JWT, like the `GET` beside it; the token is the
  authorizer, and there is no id anywhere in the route, so "someone else's
  record" is not a request it can express.
- **`auth.updateCurrentUser(accessToken, { metadata })`** on `@rekey.dev/node`.
  Additive.
- **Shallow-merged at the top level, not replaced.** A key you omit survives; a
  key you send replaces that top-level key wholesale (no deep merge); a key
  sent as `null` is deleted; `metadata: null` clears the object. Replace is the
  semantics that quietly destroys data — read, edit one key, write back, and
  everything another device wrote in between is gone with nothing in the
  request to say so.
- **The writable field list is a closed allowlist**, not a deny-list: a
  deny-list silently grants whatever column the next migration adds, `role`
  being the concrete danger. Unknown fields are **refused**, not stripped, so an
  integrator who tries `{ role: "admin" }` finds out immediately.
- Capped at 16KB serialized, measured **after** the merge.
- New error codes: **`END_USER_UPDATE_INVALID`** (400) for a body naming
  anything but `metadata`, and **`METADATA_TOO_LARGE`** (400) for the ceiling.
  Both are in [docs/errors.md](docs/errors.md). `METADATA_TOO_LARGE` is worth
  one note: it is *not* `PAYLOAD_TOO_LARGE` (413), which is the HTTP layer
  refusing a >1 MiB request body. Different status, different remedy — switch
  on the code, not the phrase.

The reserved `metadata.oidc` namespace and the post-merge cap on every other
writer arrived with the security review above; read that entry too if you are
integrating this.

### Fixed (security): eight findings across the new auth surfaces

An adversarial review of the three things that merged into this release within
an hour of each other — `PATCH /api/v1/users/me`, the OpenID Provider, and the
two email-verification switches — reproduced eight defects against a running
server. Most came from their **interaction**: the OIDC provider was designed on
the assumption that only an operator writes `EndUser.metadata`, which stopped
being true the moment the self-service PATCH route existed.

Read the two behaviour changes marked **breaking** below if you enabled
`oidcEnabled` from a pre-release build; nothing else needs action.

- **`requireEmailVerification` no longer misses sign-up.** It guarded sign-in
  only, so with the flag on `POST /auth/sign-up` returned 201 with a working
  access token and a 30-day refresh chain — to exactly the population the flag
  exists for. The gate moved to the single point every session is minted, so it
  now covers sign-up, sign-in, MFA verification, organization switching **and
  refresh**. Sign-up still creates the account and still sends the verification
  mail (now regardless of `sendVerificationEmailOnSignUp`, which could otherwise
  strand a new account with no way in); what it no longer returns is a session,
  answering 403 `EMAIL_NOT_VERIFIED` instead. Re-checking on refresh means
  switching the flag on ends unconfirmed sessions within one access-token
  lifetime rather than after 30 days.
- **BREAKING: the OIDC `email` scope now requires `requireEmailVerification`.**
  The provider was issuing `id_token`s carrying
  `"email": "…", "email_verified": false` for addresses nobody had proved, and
  relying parties that key local accounts on `email` routinely ignore
  `email_verified` — account takeover at every one of them. Rather than assert
  what it cannot stand behind, an Application that does not require verified
  addresses no longer offers the scope at all: `scopes_supported` and
  `claims_supported` both omit it in the discovery documents, and a request for
  `openid email` is granted `openid`. Where the scope IS granted,
  `email_verified` is now always `true`. Turn `requireEmailVerification` on to
  get the claim back.
- **BREAKING: OIDC `profile` claims moved to a reserved namespace.** They were
  read from the top level of `EndUser.metadata`, which the self-service PATCH
  route lets the end-user write: one request setting
  `preferred_username: "admin"` put that value verbatim into the `id_token` and
  `/userinfo`, and Grafana, Gitea, Argo CD, Vault, Nextcloud and Keycloak
  brokering all match local accounts on that claim. Claims now come from
  `metadata.oidc`, which is refused with 400 `METADATA_KEY_RESERVED` on every
  end-user-reachable write (`PATCH /users/me`, and sign-up with a publishable
  key) and writable with a secret key or the operator end-user routes. **Move
  your claims under `metadata.oidc`** — top-level `name`/`picture` are no longer
  emitted. One reserved namespace rather than five reserved claim names, so the
  self-service route can still edit the app's own `name` and `picture`. `picture`
  must now be an `https:` URL, and each claim is length-bounded.
- **An unsatisfiable scope request is `invalid_scope`, not a full grant.** The
  "client sent no scope" fallback fired on `granted.length === 0` whatever had
  been requested, so an Application with MCP on and OIDC **off** answered
  `scope=openid` — a request to sign someone in — with a working `mcp:account`
  token that reached `tools/list`. `scope=admin root` did the same. Only a
  request naming no `scope` parameter at all now falls back, which is the
  pre-OIDC MCP behaviour it was for.
- **A GDPR-erased end-user is refused on the OAuth/OIDC surface too.** The
  erasure check had landed on `/userinfo` alone: `tools/call get_profile`
  returned the user's metadata, `grant_type=refresh_token` returned a fresh
  access token, and a code minted pre-erasure still redeemed into an `id_token`.
  All four paths now enforce it. Erasure additionally hard-deletes unredeemed
  authorization codes (it already deleted refresh tokens of every kind).
- **The 16KB `metadata` ceiling applies to every writer.** It was enforced in
  `updateSelf` only, so a 200KB blob posted at sign-up was stored and then
  permanently bricked that user's own PATCH route — the cap is measured
  post-merge, so every later write failed on bytes they could no longer remove.
  Sign-up and both operator end-user routes now apply it. Separately, each OIDC
  claim is bounded when read: a 120KB `name` produced a 164,620-byte `id_token`
  and a 122KB `/userinfo` response.
- **Magic-link sign-in keeps the proof it collects.** `emailVerified: true` was
  set on the create branch only, so an existing user who signed in by magic link
  got a session while the flag stayed false — bypassing the verification gate,
  and shipping `email_verified: false` to relying parties forever. It is now set
  for existing users too (the stale-email guard is what makes that sound). This
  makes true the claim `shared-types` already made: "magic-link and OAuth
  sign-in each carry their own proof of the address".
- **New `authConfig.dynamicClientRegistration`, default `true`.** RFC 7591 open
  registration is defensible for MCP, whose clients self-register, and normally
  is not for a public OpenID Provider, where it lets anyone stand up a client
  with an attacker-chosen `client_name` and get a password prompt on the
  operator's own issuer origin. Set it to `false` once your relying parties are
  registered: `POST /oauth/register` then answers 403
  `CLIENT_REGISTRATION_DISABLED` and `registration_endpoint` disappears from
  both discovery documents. It defaults on because there is no operator-side
  client-creation surface yet, so `false` would break every deployment with MCP
  enabled and leave a new OpenID Provider unable to onboard anyone.

New error codes: `METADATA_KEY_RESERVED` (400) and
`CLIENT_REGISTRATION_DISABLED` (403). `EMAIL_NOT_VERIFIED` (403) is now also
returned by `POST /auth/sign-up` and `POST /auth/refresh`.

### Fixed (money): a single-use coupon could be redeemed forever on one-time purchases

**A coupon with `maxRedemptions: 1` discounted an unlimited number of one-off
checkouts.** Redemption was recorded in exactly one place — the successful-payment
webhook applier — and no provider emits a payment event for a one-time flow.
Stripe's `mode: 'payment'` session produces no invoice, and PayPal's
`PAYMENT.CAPTURE.COMPLETED` was registered with the provider but had no handler,
so it was acknowledged and discarded. The buyer genuinely paid less, credits were
granted, and `payments = 0, couponRedemption = 0`. The same code then discounted
their next purchase, and the one after that.

**One-time revenue also produced no `Payment` row at all**, so it appeared in no
payment listing, no revenue figure and no operator dashboard.

- Redemption is now recorded where fulfilment happens (checkout completion /
  order approval), as well as at payment success, and is **idempotent per
  (coupon, checkout session)** via a new unique index. Recurring flows are
  unaffected in count; one-time flows now record the one redemption they always
  owed.
- **Stripe** one-time checkouts write a SUCCEEDED `Payment` from the completion
  event itself (`payment_intent`, `amount_total`, gated on `payment_status:
  'paid'`) rather than from a newly subscribed `payment_intent.succeeded` — that
  event also fires for every invoice payment and would double-count against
  `invoice.paid` under a second provider id.
- **PayPal** `PAYMENT.CAPTURE.COMPLETED` is now translated, matched to the local
  row by the originating order id.
- **New column** `CouponRedemption.checkoutSessionId` + `discountAmount`
  (migration `20260801160000_coupon_redemption_per_checkout_session`). Existing
  rows keep NULL and are unaffected by the new index.

Operators who have run coupons on CREDIT packs or perpetual licences should
expect redemption counts to start rising, and should reconcile past one-time
sales against what the processor actually collected.

### Fixed (money): a renewal could be lost entirely because of a coupon

**A recurring coupon was redeemed again on every renewal, and once its limit was
reached the renewal payment was silently discarded.** `Subscription.metadata.couponId`
was stamped at checkout and never cleared, so every invoice redeemed it — while
the provider coupon is `duration: 'once'` and only ever discounted invoice #1.
Two consequences:

- **Accounting.** Two invoices produced two redemption rows for one discount, and
  the operator's coupon stats multiplied the discount by the number of periods a
  customer stayed.
- **Money.** With `maxRedemptionsPerUser: 1` — an ordinary configuration — the
  redemption threw from *inside* the payment transaction and rolled it back. The
  renewal webhook answered 500: the charge had settled at the provider, but there
  was no `Payment` row, the status and period were not mirrored, entitlements
  were not re-provisioned (credits not refilled, TIMED licences not extended),
  dunning did not recover, and the provider retried the poisoned event until it
  gave up.

Redemption now runs **after** the payment commits, never inside its transaction,
and reports a limit failure instead of raising it. `couponsService.recordRedemption`
is replaced by `redeemForCheckout`, which returns an outcome rather than throwing.

### Fixed (money): completing an older checkout session recorded nothing

The local subscription is upserted per (application, end-user, plan), and
`metadata.checkoutSessionId` was overwritten each time — but a Stripe Checkout
Session stays completable for about 24 hours, and so does the ad-hoc coupon
minted with it. A buyer who reopened checkout and then paid on the **first** tab
matched no local row: 200 OK, subscription still PENDING, no payment, no
redemption, no trace of a sale that really happened.

The row now remembers every session it has issued (bounded), and every lookup
matches any of them. Each session carries its own coupon, so completing an older
session redeems the code that session was priced with — not whichever code was
typed most recently.

### Fixed: an ACTIVE subscriber was downgraded to PENDING just for opening checkout

`createCheckoutSession` set `status: 'PENDING'` unconditionally on the existing
row. PENDING is not an entitling status, so an ACTIVE (or PAST_DUE) subscriber who
merely pressed Upgrade — or typed a coupon into the form now shown to *existing*
subscribers — lost entitlement on the spot, with no provider event having
happened. A checkout record is not a lifecycle event; only the provider's webhook
moves a paying subscription between states. A lapsed (CANCELED/EXPIRED) row still
returns to PENDING, which is what PENDING is for.

### Fixed: a dunning customer lost the entitlements they had paid for

`isEntitledStatus` counts PAST_DUE, `getCurrentSubscription` returns it, and the
whole point of the dunning window is to give the customer time to fix their card
— but `resolveForEndUser` filtered on ACTIVE only. The first failed charge
therefore stripped every feature flag they had bought, days or weeks before they
had actually run out of chances to pay. `includedQuotaFor` had the same gap read
the other way round: a dunning customer became **unmetered** rather than
under-entitled. Both now honour ACTIVE and PAST_DUE.

### Fixed: a per-subscription entitlement override could not add anything

`Subscription.entitlementOverrides` is how a bespoke deal is sold without minting
a private plan, but it could only rewrite an entitlement the plan already
carried. For the case it exists for — the plan does not describe this customer —
setting an override changed nothing at all. A **FEATURE** override can now add a
missing entitlement, with its `valueType` inferred from the value. Adding a
CREDIT / LICENSE / USAGE entitlement remains a plan-level decision: those
materialize real grants, and a bare number does not say what to grant.

### Fixed: coupon errors from the provider surfaced as a 500

A Stripe rejection while minting the ad-hoc checkout coupon escaped as an opaque
500, indistinguishable from an outage, so the one thing the caller could act on
— drop the code and buy at full price — never reached them. It is now
`COUPON_PROVIDER_REJECTED` (502). The coupon's `redeem_by` also gained an hour of
slack over the session's own ~24h expiry, so a last-minute completion is timed
out by the session rather than losing a race with its own discount, and a coupon
minted for a session that then failed to create is deleted rather than left live.

### Fixed (money): coupon discounts never reached the payment provider

**Every coupon applied at checkout charged the buyer the full price.** Checkout
validated the code, stamped `discountAmount` on the Subscription, returned it in
the checkout response, and redeemed the coupon when the payment landed — while
handing the provider a checkout input with no discount in it. Stripe, PayPal and
Razorpay were all told the full plan amount. Rekey's own books recorded a
discount that never happened, and the redemption was consumed for nothing.

This is a **behaviour change on what customers are charged.** After upgrading, a
checkout carrying a valid `couponCode` charges the discounted amount. Operators
who have been running coupons should expect their revenue per discounted
checkout to drop to what the coupon always said it would be, and should reconcile
past discounted checkouts against what the processor actually collected.

- **`CheckoutSessionInput.discount`** (`billing/providers/types.ts`) carries the
  resolved discount — amount in the smallest currency unit, currency, coupon id
  and code — into `createCheckoutSession` / `createOneTimeCheckout`. Optional, so
  a provider implementation written before this keeps compiling; a provider that
  cannot apply it must throw rather than ignore it.
- **`ProviderModule.capabilities.discounts`** (`{ oneTime, recurring }`,
  optional) declares what a provider can discount, and is exposed on
  `GET /api/v1/billing/providers` and in `BillingProviderCapabilitiesSchema`
  (`@rekey.dev/shared-types`). **Absent means "cannot"** — a module that says
  nothing gets the coupon refused rather than dropped.
- **Stripe** applies the discount as an ad-hoc Coupon on the Checkout Session for
  both flows (`amount_off`, `duration: 'once'`, single redemption, short expiry),
  so the buyer sees a subtotal and a discount line and the operator's Stripe
  records carry the Rekey coupon id.
- **PayPal** itemises the discount on one-time orders
  (`amount.breakdown.discount`, Orders v2). **Recurring PayPal checkouts with a
  coupon are now refused** with `BILLING_DISCOUNT_UNSUPPORTED` (400): Subscriptions
  v1 has no per-subscription discount, and the inline `plan` override would cut
  the price of *every* period against a single recorded redemption.
- **Razorpay** creates the one-time payment link for the net amount, recording
  the code in `notes`. **Recurring Razorpay checkouts with a coupon are refused**
  for the same reason — Offers are dashboard-created and not per-checkout.
- **New refusals**, both before anything is written or charged:
  `COUPON_NO_DISCOUNT` (400, the discount floors to zero) and
  `COUPON_FULL_DISCOUNT_UNSUPPORTED` (400, 100% off a one-time purchase — no
  provider checks out a zero-value order, and fulfilment hangs off a payment
  event that would never fire). 100% off a recurring plan is still allowed where
  the provider supports recurring discounts.
- **Marketing checkout** (rekey.dev) grew a collapsed "Have a coupon?" field on
  the upgrade form, with an optional Apply that prices the coupon through
  `POST /billing/coupons/validate` and shows what the first invoice will be
  before the buyer leaves for the provider.
- `docs/coupons.md` was corrected: it still claimed redemptions are recorded at
  apply-time, which stopped being true when that moved to payment-success.

### Breaking: test/live data modes removed, replaced by Application environments

"Test" meant three unrelated things in Rekey: a `DataMode` stamped on rows, a
mode on stored billing credentials, and a stub billing provider. Only the second
was coherent. `DataMode` covered `EndUser`, `Subscription` and `Payment` and
nothing else — so a "test" end-user still held real licences, burned real
credits, wrote real usage rows, joined real organizations, and fired real
outbound webhooks. The isolation the docs promised was not implemented. Rather
than extend a leaky flag across every model, isolation moves to the boundary
that was already real everywhere: the Application.

- **Removed `DataMode` entirely.** The `mode` column is dropped from `EndUser`,
  `Subscription` and `Payment`, and the enum is dropped from the database. This
  migration is destructive and the TEST/LIVE label on existing rows is not
  recoverable.
- **Removed the `mode` field from every payload that carried it**: operator
  end-user and payment listings, dunning cases, and the outbound webhook
  bodies for `user.*`, `subscription.*`, `payment.*` and `dunning.*`. Consumers
  reading `data.user.mode` (or the equivalent on the other events) must drop
  the field.
- **Removed the `?mode=TEST|LIVE` filter** from `GET /tenant/applications/:id/end-users`
  and `GET /tenant/applications/:id/payments`, and the `mode` argument from the
  operator MCP `recent_payments` / `recent_subscriptions` tools (those tools now
  report the Application's `environment` per row instead).
- **Removed error codes `DATA_MODE_MISMATCH`, `BILLING_MODE_MISMATCH` and
  `TEST_API_KEYS_DISABLED`.** Nothing raises them.
- **Added `Application.environment`** — `PRODUCTION | STAGING | DEVELOPMENT`,
  defaulting to `DEVELOPMENT`. It appears on every Application read surface and
  in `ApplicationDtoSchema` (`@rekey.dev/shared-types`), and is set at creation
  (`POST /api/v1/tenant/applications`). It is **immutable afterwards** — there
  is no endpoint that changes it, and no update path writes the column. Going
  live means creating a `PRODUCTION` Application, not converting an existing
  one. Note the new Application starts empty: plans, coupons, meters and
  webhook endpoints are not copied, and there is no clone flow yet.
- **API key prefixes are now derived, not chosen.** The `mode` field is removed
  from the body of every key-mint route (`POST /api/v1/admin/applications/:id/api-keys`,
  `POST /api/v1/tenant/applications/:id/api-keys`,
  `POST /api/v1/tenant/operator/applications/:id/api-keys`) and from the MCP
  `mint_api_key` tool. A `PRODUCTION` Application mints `rp_live_…`; `STAGING`
  and `DEVELOPMENT` mint `rp_test_…`. The prefix is descriptive only —
  no behaviour depends on it. Existing keys are unaffected.
- **Environment does NOT restrict which billing credentials an Application may
  hold.** Store live keys against a `DEVELOPMENT` Application if testing against
  a live processor is deliberately what you want — it is your processor account.
  (An earlier iteration of this branch enforced production-only-live /
  non-production-only-test and it was removed before release: PayPal sandbox and
  live client ids are byte-identical, so the rule could only ever hold for two
  of the three providers, and a safety property that silently does not apply to
  one provider is worse than none. Non-production abuse is a quota/rate-limit
  concern instead.)

### Breaking: stub billing providers removed

- **`StripeStubProvider`, `PaypalStubProvider` and `RazorpayStubProvider` are
  deleted.** Every provider now talks to the real processor. An Application with
  no credentials for the chosen provider fails with 400
  `BILLING_CREDENTIALS_NOT_CONFIGURED` — in **every** environment, development
  included. Previously Stripe silently fell back to a stub that returned a
  plausible checkout URL, so an integration could look complete while no money
  could ever move.
- **`BILLING_PROVIDER_NOT_CONFIGURED` is no longer raised** by the provider
  factory; the missing-credentials case is `BILLING_CREDENTIALS_NOT_CONFIGURED`
  for all three providers.
- **Removed the `REKEY_BILLING_FORCE_STUB` environment variable** and its
  production boot-guard. Setting it now does nothing.
- `pickProvider` no longer falls back to `billingConfig.provider` when an
  Application has no enabled credentials; it raises
  `BILLING_CREDENTIALS_NOT_CONFIGURED`.

- **Revenue numbers change on upgrade.** Per-application billing stats used to
  count `LIVE` rows only. With the column gone they count everything, so any
  subscriptions and payments previously stamped `TEST` now contribute to MRR,
  active-subscription counts, 30-day revenue and the 12-month series for their
  Application. Nothing is lost or double-counted, but expect a one-time step in
  the dashboard.
- **New error code** `BILLING_CREDENTIALS_MODE_CONTRADICTED`: the submitted
  `mode` contradicts what the key material says, and the key wins. The stored
  mode must not be a lie — the provider SDK authenticates with the key and
  ignores this column, so a live key recorded as `test` would make the panel,
  revenue stats and dunning all report something false.
- **`mode` on a credential write is now advisory at most.** For providers whose
  keys state their own mode (Stripe `sk_live_`/`sk_test_`, Razorpay
  `rzp_live_`/`rzp_test_`) the key decides and a contradicting `mode` in the
  request body is rejected. An explicit `mode` is honoured only where detection
  is impossible (PayPal). Callers that relied on labelling a live key as `test`
  will now get a 400 — that combination was never safe.
- **Plan creation no longer requires Stripe credentials.** `POST .../plans`
  registers eagerly with Stripe only when the Application actually has Stripe
  configured; PayPal-/Razorpay-only Applications create plans locally and
  register at first checkout, as they already did for those providers.

Self-hosters: **read `DEPLOY.md` → "Upgrading: Application environments" before
deploying** — migrations self-apply on `api` container start, so this one runs
without prompting. In short: after `prisma migrate deploy`, every existing
Application is `DEVELOPMENT`, and environment is immutable through the API — so
correct the ones serving real traffic **in SQL** (the UPDATE is in DEPLOY.md)
before minting new keys. Existing keys and stored credentials keep working
either way; only the prefix of newly minted keys depends on it.

### Breaking: `RELIPAY_*` environment-variable fallback removed

1.1.2 renamed every environment variable `RELIPAY_*` → `REKEY_*` and kept the
old name as a fallback read, noting the fallback would go in the next major.
This is that major.

- **`RELIPAY_URL`, `RELIPAY_SECRET`, `RELIPAY_OPERATOR_TOKEN`,
  `NEXT_PUBLIC_RELIPAY_URL` and `NEXT_PUBLIC_RELIPAY_PUBLIC_KEY` are no longer
  read anywhere.** Set the `REKEY_*` equivalent. Affected surfaces: the panel
  (`apps/panel`, incl. the audit-log and end-user export proxies), the admin app,
  the hosted portal, `@rekey.dev/nextjs` (both `/server` and `/client`),
  `@rekey.dev/cli` and `@rekey.dev/mcp`.
- **What an operator must do**: rename the variable in every `.env` file,
  compose file and hosting dashboard before deploying. Nothing else changes —
  the values are identical.
- Every site fails **loudly** when the variable is absent, which is why this was
  safe to remove: the panel raises `PANEL_API_URL_MISSING`, the admin app
  `ADMIN_API_URL_MISSING`, the portal and `@rekey.dev/nextjs` throw on first use,
  the MCP server exits 1 with a message naming `REKEY_URL`, and the CLI reports
  the missing `--api-url`. There is no path where a stale `RELIPAY_*` name
  silently points at the wrong thing.

### Breaking: deprecated billing-credential helpers removed

- **`billingCredentialsService.upsertStripe` / `.upsertPaypal` /
  `.upsertRazorpay` are deleted.** They were thin, `@deprecated`-tagged wrappers
  over `upsertCredentials(applicationId, provider, data, options)` since the
  provider-modules work (P3). Internal API only — no HTTP route, SDK export or
  MCP tool signature changes, so there is nothing for an operator to do. Callers
  inside this repo (including the operator MCP `set_billing_credentials` tool)
  now use `upsertCredentials` directly.
- `mfaService.confirm` now **requires** its `application` argument. It was
  optional for callers that predate the enrollment notification, and when absent
  the "two-factor was turned on" email and the `mfa.enabled` webhook were both
  silently skipped. Internal API only; the single caller always passed it.

### Fixed: the operator panel reported every end-user as "not locked"

Account lockout moved to the Redis brute-force limiter several releases ago, but
`GET /api/v1/tenant/applications/:id/end-users/:euid` — the payload behind the
panel's end-user detail page — still described lock state in terms of the
`EndUser` columns the limiter had stopped writing. The lock badge therefore read
"Lockout: none" for **every** account, including one the API was actively
refusing with 429 `TOO_MANY_FAILED_ATTEMPTS`. An operator investigating a
"locked out of my account" report was shown the opposite of the truth, and had
no working way to confirm a lockout from the panel.

- `lockedUntil` and `failedSignInAttempts` on that endpoint (and on the
  GDPR/DSAR export document, where `EndUserExportProfile` in
  `@rekey.dev/shared-types` declares them) now come from the limiter itself.
  `lockedUntil` is the lock's real expiry; below the lock threshold
  `failedSignInAttempts` is the live counter. Both fields are unchanged in name
  and type — nothing to update on the consumer side.
- `failedSignInAttempts` reports the policy threshold (10) while an account is
  locked, because the limiter consumes its counter at the moment it sets the
  lock. That is a documented floor on the failures that tripped the lock, not a
  surviving count — the same convention the super-admin locked-accounts list
  already used.
- Erasing an end-user now also drops their brute-force lock. The limiter's key
  embeds the address in plaintext (`bf:lock:eu:login:<appId>:<email>`) and the
  super-admin locked-accounts dashboard enumerates those keys, so an erasure
  used to leave the "erased" email readable there for the rest of its 15-minute
  TTL.

The super-admin `/locked-accounts` list and its overview KPI were already
sourced from Redis and are unaffected.

### Breaking: `EndUser.failed_sign_in_attempts` and `locked_until` dropped

**Destructive migration.** Both columns are dropped from `end_users`. Nothing
had written them since lockout moved to Redis, so no lockout state is lost —
every value in them was a stale zero/null. They are removed rather than left in
place because they had become a trap: they read as authoritative and were the
direct cause of the panel bug above. Lock state now has exactly one source, the
limiter. Read it via `getScopeLockState` (single account) or
`scanActiveLoginLocks` (enumerate) — never from a row.

`TenantUser` and the MFA-credential tables keep their own `locked_until`
columns; those are live and untouched.

### Kept deliberately (reviewed for removal in this major, and retained)

These look like removable back-compat shims and are not. Each is now documented
in place with the breakage that justifies it, so the question does not have to
be re-litigated:

- **The pre-SMTP email credential shape** `{ resend: { apiKey } }`
  (`normalizeCredentials`). The blobs are encrypted with `ENCRYPTION_KEY`, so no
  SQL migration can rewrite them, and the failure mode is silent: an Application
  configured before the multi-provider transport landed would just stop
  delivering its own verification and password-reset mail.
- **The wrapped `{provider, data}` billing-credential shape.** Same
  encrypted-at-rest problem, on the money path.
- **`authConfig.signupEnabled`.** Removing the legacy boolean → `signupMode`
  derivation would make an Application stored as `{ signupEnabled: false }`
  fall back to `public` — silently re-opening sign-up on an app the operator
  closed.
- **The per-provider webhook URLs** (`/api/v1/billing/webhook/{stripe,paypal,razorpay}`).
  They remain permanent aliases into the generic pipeline. Operators have pasted
  them into live provider dashboards; unregistering them 404s a real endpoint
  until the provider disables it, and subscriptions stop activating with nothing
  visible on the Rekey side.
- **`Tenant.ownerEmail`.** Its schema comment claimed it was kept for
  back-compat; that was wrong. It is required by the bootstrap admin path,
  written by operator signup and workspace-create, and read by the super-admin
  tenant list and its search predicate. The comment now says what it is (the
  address captured at creation) and what it is not (the current owner — that is
  `TenantMembership.role = OWNER`).
- **The `["*"]` API-key scope.** Also mislabelled as legacy: it is still
  `DEFAULT_SCOPES`, so every key minted without an explicit `scopes` array gets
  it. Comments corrected in three places.

### Breaking: Node 22+ required

- **The runtime floor moves from Node 20 to Node 22.** Node 20 left LTS, and
  GitHub Actions had already begun forcing our workflows onto a newer runtime.
  The Docker images now build on Node 24 (current LTS), CI runs Node 24, and
  the root `engines` field requires `>=22.0.0`.
- **The six published packages now declare `engines: { node: ">=22.0.0" }`.**
  They previously declared nothing at all, so npm gave consumers no signal
  about which runtime they needed. Installing on Node 20 will now warn (or
  fail, under `engine-strict`). The floor is 22 rather than 24 deliberately:
  22 is the oldest LTS line still receiving security fixes, and the SDKs do
  not use anything newer.
### Added: an Application can be an OpenID Connect provider

Rekey could already *consume* a third-party IdP (the `oidc` OAuth provider). It
can now *be* one. Off by default; opt in per Application with
`authConfig.oidcEnabled = true` (`PATCH /api/v1/tenant/applications/:id/auth-config`).
Full guide in [docs/oidc-provider.md](docs/oidc-provider.md).

- **No new authorization server.** The per-Application OAuth 2.1 AS that fronts
  the hosted MCP server *is* the OpenID Provider — same issuer
  (`/api/v1/mcp/<slug>`), same client registry, same authorization-code + PKCE
  grant. OIDC adds a discovery document, an `id_token`, and `/oauth/userinfo`.
- **No new signing key.** ID Tokens are RS256, signed with the deployment's
  existing active key and verifiable against the existing
  `GET /.well-known/jwks.json`.
- **`/.well-known/openid-configuration`** is served in both the suffix form OIDC
  Discovery 1.0 mandates and the path-insertion form RFC 8414 §3.1 defines, next
  to the existing OAuth metadata. Every advertised capability is implemented;
  unsupported features (`request`, `request_uri`, the `claims` parameter,
  `prompt=none`, implicit/hybrid flows) are advertised as unsupported and
  refused at the authorization endpoint with the spec's own error code.
- **`nonce` is supported end to end** and replayed into the ID Token, which also
  carries `auth_time` and `at_hash`. `sub` is the `EndUser` id — stable per user
  and, because `EndUser` rows are per-Application, never shared across
  Applications.
- **`/oauth/userinfo`** (GET + POST) returns `sub` plus only what the granted
  scopes authorise. `profile` claims are read from the reserved
  `EndUser.metadata.oidc` namespace through a strict allowlist of standard OIDC
  claim names, so app-internal keys in that blob are never emitted. (This
  shipped reading the top level of `metadata`; see the security entry at the top
  of this release for why it moved before the release was cut.)
- **`oidcEnabled` and `mcpEnabled` are independent.** Either mounts the shared
  grant endpoints; each resource still gates itself. Enabling single sign-on no
  longer requires also exposing an MCP tool server over your users' accounts.

Two behaviour changes on the existing MCP surface fall out of this, both
tightening:

- **The MCP JSON-RPC endpoint now requires the `mcp:account` scope**, returning
  403 `insufficient_scope` without it. Previously any valid access token from
  the AS was accepted whatever its scope. Clients that requested `mcp:account`
  (or no scope at all, which still defaults to it) are unaffected; a token minted
  with an unrecognised scope string is not.
- **The refresh grant re-issues the scope that was actually granted** instead of
  hard-coding `mcp:account`. The granted scope is now stored on the
  authorization code and carried down the refresh-token chain, so a grant can no
  longer widen across a refresh. Refresh tokens issued before this release have
  no recorded scope and are read as `mcp:account` — exactly what they used to be
  re-issued with.
- Requested scopes are now intersected with what the Application supports and
  the remainder dropped (RFC 6749 §3.3) rather than echoed onto the token. A
  non-empty authorization request with no grantable scope left is refused with
  `invalid_scope`; only a request naming no `scope` at all falls back to
  `mcp:account`. (As shipped, the fallback fired for both — see the security
  entry at the top of this release.)

New error code `OIDC_NOT_FOUND` (404) for the OIDC-only paths on an Application
that has not enabled OIDC.

**Type note (TypeScript consumers).** `oidcEnabled` and
`dynamicClientRegistration` are `.default()` fields on `AuthConfigSchema`, and
`AuthConfig` is the `z.infer` *output* type — so both are **required**
properties on it, as are the two email-verification switches. Four new required
properties in all for anyone constructing an `AuthConfig` object literal;
reading one, and the `PATCH …/auth-config` body, are unaffected.

`oidcEnabled` shipped with no operator-console control at all. It has one now —
see [`oidcEnabled` has a panel toggle](#added-oidcenabled-has-a-panel-toggle).

### Added: optional IP allowlist on the admin surface

- **`ADMIN_IP_ALLOWLIST`** (comma-separated IPs and/or CIDRs, v4 and v6) gates
  `/api/v1/admin/*` by network position. Unset — the default — changes nothing.
  When set, a request from any other address is refused with 403
  `ADMIN_IP_NOT_ALLOWED` **before** the key is examined, so the refusal reveals
  nothing about whether the caller's key was valid.
- Why it is worth setting: `SUPER_ADMIN_KEY` is a single shared secret covering
  every tenant and application in the deployment, so a leak is total. Pinning
  the admin surface to known addresses means a leaked key is not by itself
  sufficient. It is defence in depth, not a replacement for the key.
- Behind a reverse proxy set `TRUSTED_PROXIES` as well, or every request will
  appear to originate from the proxy and the allowlist will match the wrong
  thing.
- A malformed entry **fails the boot** rather than producing a gate that
  silently matches nothing — the failure mode where an operator believes they
  are protected while the list is effectively empty.

### Fixed: `rekey version` and the MCP handshake reported `0.0.0`

Both packages carried the version as a source literal that release never
touched, so the CLI printed `0.0.0` and `rekey-mcp` announced `0.0.0` in its
`initialize` handshake for the whole 1.x line — anything logging or gating on
either saw a version that was never published. Both now read `version` from
their own `package.json` at runtime, so a release cannot leave them stale
again.

### Added: email verification is configurable per Application

Email verification existed as plumbing — a token, a `/auth/send-verification`
endpoint, an `emailVerified` column — with nothing wired to either end. Sign-up
never sent the mail, and the column gated nothing. Two `authConfig` switches
close both halves, each settable from Panel → Application → Auth, the
`PATCH /api/v1/tenant/applications/:id/auth-config` body, and the operator MCP
`update_auth_config` tool.

- **`sendVerificationEmailOnSignUp`, default `true`.** Password sign-up now
  sends the `email_verification` mail alongside `welcome` instead of expecting
  the customer's server to call `sendVerificationEmail` itself. **This changes
  behaviour for existing Applications**: they start sending a second email at
  sign-up. Set it to `false` to keep the old behaviour. Delivery is
  fire-and-forget on the same contract as the welcome mail — an Application
  with no email transport logs a `no_transport` send, and no delivery failure
  can fail an account creation.
- **`requireEmailVerification`, default `false`.** When on, password sign-in
  refuses a user whose address is unconfirmed with **403 `EMAIL_NOT_VERIFIED`**
  (new code) instead of issuing a session. Deliberately not
  `INVALID_CREDENTIALS`: the password was right, and an app that cannot say why
  sends the user round the password-reset loop forever. The check runs after
  the password verifies, so it is neither an account-existence oracle nor a
  failed attempt against the lockout counter — a user waiting on their link
  cannot lock themselves out by retrying.
- Magic-link and OAuth sign-in satisfy the gate rather than skip it: each proves
  the address and records `emailVerified: true`, so neither sends a verification
  mail nor is blocked.
- Note before enabling the gate: it applies to accounts that already exist, and
  a blocked user cannot re-send their own link (`/auth/send-verification`
  requires a session). Operators can mark an address verified from
  Panel → Application → End-users. **No longer true as of the fix below**:
  `POST /auth/resend-verification` needs no session. Left standing because it
  is what shipped.
- The two bullets above are the corrected form. As first written this entry said
  the gate covered password **sign-in** only and that already-issued refresh
  tokens kept working — both were true of the code and both were the bug. See
  the security entry at the top of this release.
- One more prerequisite, added after the release was cut: a verification link
  has to be *buildable*. With no `appUrl`, no usable redirect origin and no
  `DEFAULT_APP_URL` the send is now skipped rather than mailing a button-less
  confirmation, and a user who never got theirs can ask for another without a
  session — see [a verification email with no
  button](#fixed-a-verification-email-with-no-button-and-no-way-to-ask-for-another).
- **Type note (TypeScript consumers).** `AuthConfig` is
  `z.infer<typeof AuthConfigSchema>`, the schema's *output* type, so a
  `.default()` field is **required** on it — not optional. Both switches are
  `.default()`, so both become required properties, and code that constructs an
  `AuthConfig` as an object literal stops compiling until it supplies them.
  *Consuming* an `AuthConfig` is unaffected, as is the `PATCH …/auth-config`
  request body, which stays all-optional.

### Added: `subscription.*` webhooks carry the resolved entitlements

- **`data.subscription.entitlements`** is now on every outbound
  `subscription.activated` / `subscription.canceled` / `subscription.past_due`
  delivery: the entitlements that subscription grants, with its
  `entitlementOverrides` already applied. Same array shape
  `GET /api/v1/billing/entitlements` returns, so the same parsing works on both.
- Additive — nothing was removed or renamed, and a consumer that ignores the
  field is unaffected.
- Why: `planSlug` cannot answer "how much did this customer buy". A
  per-subscription override is how a bespoke quantity is sold without minting a
  private plan, so two subscribers on one plan can hold different amounts. A
  consumer provisioning off the slug therefore provisioned the wrong thing for
  exactly the customers who had paid for something different — and, holding no
  user token, had no way to go and ask.
- Provision against `entitlements`; keep using `planSlug` for display.

### Other

- Removed `ProviderModule.createProvider`. The provider-module spec proposed it
  so a module could own its outbound construction, all three modules
  implemented it, and nothing ever called it — outbound providers are built by
  `getProviderForApplication` in `providers/index.ts`, which was never migrated
  onto the hook. Internal only: no published type, endpoint or payload changes.
- Environment variables renamed `RELIPAY_*` → `REKEY_*` across the API, panel, admin, portal, SDKs, CLI, and MCP server. As of 2.0.0 the old names are no longer read — see the breaking entry above.
- CI test database renamed `relipay_test` → `rekey_test`; default transactional-email from-name is now "Rekey".
- Removed a dead `seoTags` block from the marketing site's content data. It was superseded by `landingContent.seo` and had no readers.

## 1.1.2

ReliPay is now **Rekey**. This release moves the SDK packages to their new
home: install `@rekey.dev/node`, `@rekey.dev/react`, `@rekey.dev/nextjs`,
`@rekey.dev/cli`, `@rekey.dev/mcp`, `@rekey.dev/shared-types`. The old
`@relipay/*` packages are deprecated on npm and will receive no further
updates.

### Breaking changes (relative to `@relipay/*` 1.1.1)

- **Package scope**: `@relipay/<name>` → `@rekey.dev/<name>`. Update imports
  and dependencies; APIs are otherwise unchanged in this release.
- **Exported names**: `RelipayError` → `RekeyError` (plus the matching
  `RekeyErrorShape`/`RekeyErrorSchema`/`RekeyErrorPayload` types),
  `RelipayProvider` → `RekeyProvider`, `relipayMiddleware` →
  `rekeyMiddleware`, `relipayBrowser` → `rekeyBrowser`, and the `Relipay`
  client class is now `Rekey`. `instanceof` checks and named imports need the
  new names.
- **User-token header**: the SDK now sends `X-Rekey-User-Token` and servers
  from this version onward read only that header. A 1.1.1 (`@relipay/*`) SDK
  talking to a 1.1.2+ server will get 401s on per-user routes — upgrading the
  package is the fix.
- **CLI binaries**: `relipay` → `rekey`, `relipay-mcp` → `rekey-mcp`.

Self-hosters: your deployment domains, environment variable names
(`RELIPAY_URL` etc.), cookie names, and docker-compose service names are
unchanged in this release.

## 1.1.1

A follow-up pass on the parts of 1.1.0 that were still failing open, plus the
panel bugs people reported. One behaviour change on an operator endpoint is worth
reading before you upgrade.

### Changed behaviour

**Deleting an end-user now fails if the payment provider will not cancel their
subscription.** It used to delete anyway and log the failure. The problem with
that is timing: once the record is gone there is nothing left to retry from, so a
card kept being charged for a user the operator could no longer see. The endpoint
now answers 502 `PROVIDER_CANCEL_FAILED`, leaves the user in place, and records
the blocked attempt so you can see why.

Erasure is deliberately different. `?erasure=true` still succeeds even when the
provider call fails, because it answers a legal request with a deadline and
blocking that on a third party being down is the worse outcome. The tombstone
keeps the row, so the subscription stays findable. If you need to satisfy an
erasure request while a provider is down, use the erase path.

### Security

**A Redis outage no longer switches off brute-force protection.** Every Redis
error in the lockout code was being swallowed and read as "no failures, not
locked". Two things followed from that. Failed sign-ins stopped being counted, so
password guessing was unlimited. And an account that had already tripped a
lockout read as unlocked, so an attacker who had been locked out was let back in.

Credential endpoints now answer 503 when that store is unavailable. Sign-in is
briefly unavailable instead of unprotected. Reads and everything that is not an
auth endpoint keep working, so an outage degrades the product rather than opening
it or taking it down.

The rate limiter's auth tier fails closed for the same reason. That one matters
for `forgot-password` and `magic-link/request`, which have no lockout behind them
because they are not sign-in attempts, so a skipped limiter left them unbounded
and each request sends an email. The general limiter still fails open on purpose:
it protects throughput, not credentials, and failing it closed would turn a Redis
restart into a full outage.

**You can now see when this is happening.** The panel shows a banner naming the
unreachable dependency, and says plainly that credential endpoints are refusing
requests on purpose so nobody goes hunting for a bug that is not there. The
outage is also recorded in the security log with a start time, throttled to one
entry per dependency every five minutes.

**Plan and coupon changes are now audited.** Forty-seven kinds of operator action
were already recorded, including billing credential changes, but plans and
coupons were not, so a price change left no trail at all. During a billing
dispute nobody could say who moved a price or when.

### Fixed

**A browser can read its own user's profile.** `GET /users/me` accepts the
publishable key now. 1.1.0 opened MFA enrollment, password change, OAuth linking
and organization management to browser apps but left profile reads behind, so an
app could sign a user in and then not display their name.

`GET /me` stays server-only, deliberately. It returns the whole Application
including its auth and billing configuration, which is operator setup rather than
user data.

**Two panel bugs.** The delete confirmation dialog was not reliably centred: it
depended on a browser default rather than saying where it should sit, so it
landed off-centre for some people. Centring is now explicit. And the focus
outline on the End-users tab was being clipped by the scrolling tab strip, which
made it look broken for keyboard users. Focus rings on both tab rows are also
full-strength now instead of half-transparent, which was too faint to serve as an
indicator.

While fixing the dialog we found every confirmation dialog on a list page shared
the same element ids, so a screen reader announced the first row's name no matter
which row you were deleting. On a delete confirmation.

**`Idempotency-Key` works on `POST /usage/record`.** That route already deduped
retries through a body field; it now also accepts the header, so a client that
retries the same way everywhere does not need to know which mechanism each route
uses.

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

First stable release. All `@rekey.dev/*` packages publish under the `latest`
dist-tag. `npm install @rekey.dev/node` (no tag) now resolves.

Since `1.0.0-rc.1`: operator MCP write/operate tools (plan entitlements,
member management, credentials, end-user + mode controls, scoped + audited),
new Rekey brand/logo across the apps, panel MCP-consent and passkey
sign-in fixes, and marketing self-host guide + SEO updates.

Install:

```bash
npm install @rekey.dev/node
```

## 1.0.0-rc.1

First release candidate for the 1.0 line. Published under the `beta` npm
dist-tag (pre-release) so it can be smoke-tested end-to-end before `1.0.0`
stable promotes to `latest`.

- Cut the first public release from the new OSS home, `rekey-dev/rekey`.
- No API changes versus `0.1.0-beta.4`; this is a version-line bump to exercise
  the public release pipeline (clean mirror → GitHub Release → npm publish).

Install:

```bash
npm install @rekey.dev/node@beta
```
