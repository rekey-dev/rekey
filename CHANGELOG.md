# Changelog

Notable changes to Rekey, covering the self-hosted stack as well as the
`@rekey.dev/*` SDK packages. The packages share one version and release together
with the API, panel and portal.

## 2.0.0-rc.2

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
