# Migrating from 2.1 to 2.2

This page takes a deployment and its integrations from **2.1.0** to **2.2.0**.
"Before" in every table is 2.1.0. "After" is 2.2.0.

On a 2.2 release candidate? Follow the same page from the top: every step is
safe to repeat, and the tables say what your code has to look like at the end.

2.2 is a minor release with breaking changes. The largest is how money is
held: a plan's price is a price row, a plan can be sold in several currencies,
coupons hold an amount per currency, refunds are records, and money is
reported per currency. Sign-up, sign-in and operator accounts changed too.
Nothing old is kept working beside the new shape: a removed field is refused
with an error that says what to send.

## Who needs to read what

| You | Read |
|---|---|
| Run a self-hosted deployment | [Before you upgrade](#before-you-upgrade), [Upgrade steps](#upgrade-steps), [Environment and compose](#environment-and-compose), [Database](#database), [After you upgrade](#after-you-upgrade) |
| Integrate with an SDK or the REST API | [Auth](#auth), [Sessions](#sessions-and-refresh), [Billing](#billing), [Webhooks](#outbound-webhooks), [API keys](#api-keys-and-scopes), [Error codes](#error-codes), and the table for each package you use under [SDK packages](#sdk-packages) |
| Operate Applications in the panel | [Operators](#operators), [Panel](#panel), [After you upgrade](#after-you-upgrade) |
| Write an agent or an MCP client | [MCP](#mcp), [API keys](#api-keys-and-scopes), [CLI](#cli) |

## Before you upgrade

**1. Take a database backup. There is no rollback.** The migrations drop the
columns that held a plan's price and a coupon's amount. No earlier version
runs against the migrated database. Going back means restoring the backup and
starting the 2.1 images against it; everything written after the backup is
lost.

**2. Plan to replace every API instance together.** `prisma migrate deploy`
runs when the new `api` container starts. A 2.1 instance still serving after
that answers 500 on every request that reads a plan, a coupon or an operator,
and cannot create refresh tokens. It never writes a wrong value, but it must
be stopped, not left to drain. The table of what fails after which migration
is in [DEPLOY.md](../DEPLOY.md#replace-every-api-instance-together).

**3. Run the preflight.** `docs/upgrades/billing-money-model.preflight.sql`
is read-only. Part A runs on 2.1.0:

```bash
psql "$READ_ONLY_DATABASE_URL" -f docs/upgrades/billing-money-model.preflight.sql
```

psql carries on past a failed query, so the Part B and Part C queries, which
need tables 2.1.0 does not have, report a missing relation and can be ignored.

| Query | What it lists | On a hit |
|---|---|---|
| A1 | Plans, payments and fixed coupons holding money in HUF, TWD, ISK, UGX or MGA | **The upgrade refuses to start.** See [the five currencies](#the-five-currencies-whose-stored-scale-changed). |
| A2 | Plans and fixed coupons whose currency is not a three-letter code (or is missing), and payments recorded in one | **The upgrade stops part way**, at `price_and_coupon_column_drop_checks`, rather than drop an amount it cannot place. Set `currency` to the ISO 4217 code that was meant, or delete a plan or coupon nobody uses. A payment row does not stop the upgrade; correct it so reports can total it. |
| A3 | Percentage coupons whose rate is outside 0 to 10000 basis points | **The upgrade stops part way.** Set `amount_off` to the rate in basis points (1500 is 15 percent), or delete the coupon. |
| A4 | Plans priced in a three-decimal currency (BHD, IQD, JOD, KWD, LYD, OMR, TND) | The upgrade runs. 2.2 does not sell in these: re-price or retire each plan. |
| A5 | Plans with a per-unit price | `pricePerUnitCents` is removed from the API; nothing ever charged it. The stored figure moves to the plan's `metadata.pricePerUnitCents`, where nothing reads it. A USAGE plan stays metered. For any other kind at amount 0, give the plan a price or clear the per-unit price first, so it is recorded as free. |
| A6 | Provider registrations stored on plans | **Save the output.** After the upgrade the same ids must be on each plan's default price. |
| A8 | Applications whose `billing_config.currency` is not a three-letter code | **The upgrade stops part way.** Write the ISO 4217 code that was meant, or remove the key to take the default. |
| A9 | Plans whose per-unit price cannot be kept in their metadata (the metadata is not an object, or already holds a different `pricePerUnitCents`) | **The upgrade stops part way.** Correct the metadata, or clear the per-unit price. |
| A10 | Plans with a negative amount | **The upgrade stops part way.** Set the amount the plan charges, or 0. |
| A7 | Webhook endpoints stored with an `http://` URL | Each receives nothing after the upgrade in production. See [the https rule](#the-https-rule). |

When a migration stops, that migration has changed nothing, and **the
migrations before it stay applied**: on an upgrade from 2.1.0 the database is
then part way to 2.2.0, where neither the 2.1 API nor the 2.2 API runs. The
message names each table, how many rows, and the preflight query that lists
them (Part C of the file reads the part-way schema). Correct the rows, run the
`prisma migrate resolve --rolled-back <name>` command the message gives, and
start the `api` container again: the deploy carries on from the migration
that stopped. No migration guesses a value for a row it cannot place. This is
why the preflight comes first: a hit found before the upgrade costs no
downtime.

### The five currencies whose stored scale changed

2.2 changes how a stored amount in five currencies is sent to a provider:

| Currency | Provider | A stored amount was sent as | It is now sent as |
|---|---|---|---|
| HUF, TWD | PayPal | The stored number: `5000` went out as "5000" | Whole units: `5000` goes out as "50" |
| ISK, UGX | Stripe | The stored number | The stored number multiplied by 100 |
| MGA | Stripe | The stored number | The stored number divided by 100 |

The same stored number would mean a different amount of money after the
upgrade, and nothing can rescale a row without knowing which provider it was
written for. So the first money migration refuses to run while query A1
returns a row. For each row, check the provider's own record of the price or
the charge, then rewrite the stored amount to the new scale, or remove a row
that is not real money. If you have live subscribers among them, plan the
change before you deploy.

### Environment and compose

| Setting | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| `PANEL_PROXY_SECRET`, `API_PROXY_SECRET`, `PORTAL_PROXY_SECRET` | Not present | Required by `docker-compose.prod.yml`. Compose refuses to render without them | Generate each with `openssl rand -hex 32` and add it to `.env` before you pull. |
| `INTERNAL_CALLER_SECRET` | Not present | Required by `docker-compose.prod.yml`; one value shared by the API, panel and portal | The same. |
| `JWT_SECRET`, `SUPER_ADMIN_KEY` in `docker-compose.yml` (development) | A weak default | Required | Set both in `.env`. |
| The `redis` service | `redis:7-alpine` | `valkey/valkey:8.1-alpine`, on a **new volume**, so the store starts empty | Nothing to migrate. Rate-limit counters, lockouts and caches reset. Remove the old volume when you are satisfied. |
| Redis reachability | Auth email was sent uncounted when Redis was down | `/auth/forgot-password`, `/auth/magic-link/request` and `/auth/resend-verification` answer 503 `DEPENDENCY_UNAVAILABLE` when Redis is unreachable. A Redis command gets one second, then credential routes answer 503 instead of hanging | Monitor Redis. Treat 503 with `Retry-After` as retryable. |
| `PUBLIC_PORTAL_URL` (API) and `PORTAL_BASE_URL` (portal) | Independent | Must name the same origin, or portal password resets are refused with `AUTH_URL_NOT_ALLOWED` | Set both to the portal's public origin. |
| `RATE_LIMIT_API_KEY_MAX` | Default 6000 a minute | Default 30000 a minute | Remove an explicit 6000 to get the new default. |
| `ADMIN_IP_ALLOWLIST` | A request through an unidentified proxy was matched on the proxy's address | Answered 403 `ADMIN_IP_UNVERIFIABLE` | Set the proxy secrets above so the API can identify its proxy. |
| Clocks | Not significant | Tokens that name no session are compared to a revocation by the issuing instance's clock | Keep NTP running on every API instance. |
| New optional settings | | `AUTH_EMAIL_RECIPIENT_HOURLY_CAP`, `AUTH_EMAIL_RECIPIENT_DAILY_CAP`, `CHECKOUT_LIMIT_PER_IP_HOUR`, `CHECKOUT_LIMIT_PER_APP_HOUR`, `EMAIL_SEND_DAILY_CAP`, `EMAIL_UNSUBSCRIBE_SECRET`, `REFRESH_TOKEN_REUSE_WINDOW_SECONDS`, `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_APP_MAX_IN_FLIGHT`, `OPERATOR_AUTH_CACHE_TTL_MS`, `TRUST_CF_IPCOUNTRY`, `ANALYTICS_ROLLUP_ENABLED`, `LOG_RETENTION_DAYS` and the others in `.env.example` | Unset keeps the default. |
| `NEXT_PUBLIC_PORTAL_URL` (panel build argument) | The portal origin the Portal page showed | Removed. The page shows the API's `PUBLIC_PORTAL_URL` | Set `PUBLIC_PORTAL_URL` on the API and delete the build argument. |

### The https rule

A deployment running with `NODE_ENV=production` sends webhooks only to
`https://` URLs. Creating or changing an endpoint to `http://` answers 400
`URL_NOT_HTTPS`. An endpoint already stored as `http://` receives nothing:
each delivery records an error starting `URL_NOT_HTTPS:`. An OIDC sign-in
provider whose issuer or discovered endpoints are `http://` is refused at save
and at sign-in. To keep delivering to http services on your own private
network, set `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`. Development deployments
are unchanged.

## Upgrade steps

Do these in order, in one sitting.

1. **Back up the database** and confirm the backup restores.
2. **Run the preflight** and correct every row the bold entries above name.
3. **Set the new environment variables** from the table above.
4. **Deploy the API.** The migrations run on start. Verify:

   ```bash
   curl -fsS https://api.example.com/health        # {"db":"ok","redis":"ok"}
   curl -fsS https://api.example.com/health/ready  # "version":"2.2.0"
   ```

   If the container does not start, read its log: a migration that stopped
   says which rows to correct and which command to run.
5. **Stop every API instance of the old version.**
6. **Deploy the portal and the panel**, the portal first or both together.
   Verify by signing in to the panel and opening an Application's Billing,
   Setup, Status page.
7. **Check the deployment's money setup:**

   ```bash
   export REKEY_URL=https://api.example.com
   export REKEY_OPERATOR_TOKEN=rp_op_...
   npx @rekey.dev/cli@2.2.0 doctor
   ```

   `doctor` reports a plan that cannot be sold as priced, a provider with no
   currency, a price no enabled provider can charge, and billing events that
   did not reach the billing log. A `skipped` check did not run for want of a
   credential.
8. **Upgrade every `@rekey.dev/*` package to 2.2.0** in each app that
   integrates, and make the changes in the tables below. Verify with your
   type-check: a removed field does not compile.
9. Work through [After you upgrade](#after-you-upgrade).

A 2.1 SDK against a 2.2 API keeps working for sign-in and reads, and is
refused wherever it sends a removed field or the `x-country` header: plan
create and update, coupon create, and any checkout, provider list or coupon
quote that names a country. Ship your apps on the 2.2 packages straight after
the API.

## Auth

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| An account whose address was never confirmed | Kept its password and sessions when the real owner later signed in by magic link, social sign-in or reset | The first magic-link sign-in, social sign-in (provider-verified, same address) or completed reset marks it verified and removes the password (a reset sets the new one), every session, passkeys, second factor, other linked providers and device bindings. The user id, role, metadata, profile, subscriptions, credits and licences stay | Expect it. The user gets the `account_claimed` email; you get `user.updated` with `changed: ["emailVerified", "credentials"]` and the security event `auth.unverified_account_claimed`. |
| Users your server creates | Created as given | Unverified unless you say otherwise, so the rule above applies to them | Send `emailVerified: true` on `POST /api/v1/auth/sign-up` (secret key only) and per user on `POST /api/v1/users/import` for every address you verified yourself. |
| `emailVerified: true` from a publishable key | Not accepted | Refused with `EMAIL_VERIFIED_REQUIRES_SECRET_KEY` | Send it from your server. |
| Passkey registration, MFA setup, provider linking | Open to any signed-in user | 403 `EMAIL_NOT_VERIFIED` for a user whose address is unverified, whatever `requireEmailVerification` is | Verify the address before offering enrolment. |
| Sign-up for an address that already has an account, with `requireEmailVerification` on, from a publishable key | 409 `EMAIL_ALREADY_EXISTS` | The same 403 `EMAIL_NOT_VERIFIED` as a new address; the owner is emailed instead | A form that waited for `EMAIL_ALREADY_EXISTS` to say "sign in instead" shows "check your inbox" for `EMAIL_NOT_VERIFIED`. Secret keys still get the 409. |
| Browser sign-ups per address | 10 a minute | Also 30 an hour per Application while `requireEmailVerification` is off; the 31st answers 429 `RATE_LIMITED` | Handle the 429. |
| Auth email to one mailbox | Unlimited | 5 an hour and 15 a UTC day per Application, counted per recipient (`a+1@` and `a+2@` are one mailbox). Over it a secret key gets 429 `AUTH_EMAIL_RECIPIENT_CAPPED`; a publishable key gets the usual 200 and nothing is sent | Handle the 429 on your server. |
| `/auth/forgot-password`, `/auth/magic-link/request`, `/auth/resend-verification` from a publishable key | Answered after the mail was sent | Answer before the mail is built, in the same time for any address. The body is unchanged | Nothing. |
| `resetUrl`, `signInUrl`, `verifyUrl` on those routes | A disallowed URL for an unknown address got the constant 200 | 400 `AUTH_URL_NOT_ALLOWED` for any address | Register the origin as the App URL or a redirect URL. |
| `requireEmailVerification` | Could be switched on with nowhere to send a verification link | 409 `EMAIL_VERIFICATION_URL_REQUIRED` without an App URL or redirect URL | Set the App URL first. |
| MFA codes and challenge tokens | Reusable inside their window | Single use: `MFA_CODE_REUSED`, `MFA_CHALLENGE_USED`. A spent backup code answers `MFA_BACKUP_CODE_USED` | Ask the user for a fresh code. |
| A sign-in in flight while every session of the account was ended | Got a session | Refused: a password answers `INVALID_CREDENTIALS`, a refresh token `REFRESH_TOKEN_REVOKED`, a link, provider, passkey or second factor the new `CREDENTIAL_SUPERSEDED` | Treat `CREDENTIAL_SUPERSEDED` like any failed sign-in. |
| A second-factor step open during the upgrade | | Answers 401 `MFA_CHALLENGE_INVALID` | The user signs in again. |
| `EMAIL_NOT_VERIFIED` | One meaning, and a `fix` text | Two meanings (sign-in refused; no new sign-in method on an unverified account), and a different `fix` | Branch on the code and the route, never on the text. |
| Credential routes with a large body | Parsed up to 1 MiB | 413 `PAYLOAD_TOO_LARGE` above their own cap | Keep sign-up `metadata` small. |
| `GET /api/v1/auth/me` | Not limited per user | 600 a minute per end user | Cache it per request. |
| A banned or erased end user | | `END_USER_BANNED`, `END_USER_ERASED`; the Next.js, Astro and React packages treat both as signed out | Nothing with the SDKs. By hand, clear the session on either code. |
| An impersonation token | Could switch organization and link providers | 403 `IMPERSONATION_ACTION_FORBIDDEN` | Do those as the user. |

Accounts verified by 2.1 are not changed by the upgrade. docs/auth.md
("Accounts verified before 2.2.0") has a query that lists the ones worth a
look.

## Sessions and refresh

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| A refresh token replayed moments after its rotation | Treated as theft: every session ended | 401 `REFRESH_TOKEN_RACED` inside `REFRESH_TOKEN_REUSE_WINDOW_SECONDS` (15 by default), and nothing is revoked | Retry with the current token. |
| A refresh token from before a revocation of every session, replayed | Ended every session again | 401 `REFRESH_TOKEN_REVOKED`, and nothing is revoked | Sign in again. |
| `@rekey.dev/nextjs` `rekeyMiddleware` | Refreshed inline | Redirects GET and HEAD to a refresh route; a Server Action with a bad `Origin` gets 403 | Add `export const GET = rekeyRefreshHandler();` in `app/api/rekey/refresh/route.ts`, replacing any hand-written one. |
| `@rekey.dev/astro` `getSession` outside `rekeyMiddleware` | Refreshed | Does not refresh unless you pass `{ refresh: true }` | Install the middleware or pass the option. |
| A refresh that may have spent the token (5xx, timeout) | Kept the cookies | The Next.js and Astro packages sign the browser out | Nothing. |
| A cross-site navigation to a refresh route | Rotated | Answered with an interstitial page | Nothing. |
| Access tokens that name no session (MCP access tokens, MFA challenges) minted by 2.1 | | Refused once after the upgrade | An MCP client refreshes on the 401; its grant is untouched. |
| Session rows from a secret-key sign-in | Recorded your server's User-Agent | Record the visitor's, when the SDK sends it | Upgrade `@rekey.dev/nextjs`, or use `visitorClient` in Astro. Send `clientIp` from a hand-written backend. |

## Operators

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| An operator's email address | Never confirmed | **Every operator who signed up with a password is unconfirmed after the upgrade**, unless they had already signed in by emailed link, Google or GitHub. No migration confirms anyone. The panel shows a notice with "Send confirmation email" on every page | Each operator signs in, sends the email and opens the link once. It keeps their password, sessions, passkeys, tokens and MCP grants. |
| What waits for a confirmed address | Nothing | 403 `EMAIL_NOT_VERIFIED` on: inviting, changing a member's role, scopes or grants, creating a workspace, minting an Application API key, rotating the publishable key, creating or changing a webhook endpoint, storing provider credentials, configuring a sign-in provider, changing `appUrl` or `redirectUrls`, the IP allowlist and CORS origins, email credentials and built-in templates, adding a passkey or two-factor, creating a personal access token, approving an MCP client. Reads, plans, prices, coupons, revoking and deleting stay open | Confirm first. Existing tokens keep working for everything else. |
| Confirming another way | | A magic link, a Google or GitHub sign-in or a completed reset on an unconfirmed operator removes the password, sessions, passkeys, second factor, personal access tokens and MCP grants | Prefer the confirmation link. |
| A deployment that cannot send operator mail and has no operator sign-in provider | | Refuses none of the above | See [tenant-auth.md](tenant-auth.md). |
| `GET /api/v1/tenant/auth/me` | | Adds `emailConfirmation: { required, byEmail }` | Optional. |
| Erasing or cascade-deleting an end user | Workspace ADMIN | Workspace OWNER only | Have an OWNER do it. |
| End-user IP addresses | Shown in full | Masked to the network below OWNER and ADMIN, and for a credential without `activity:read` | Use a credential with `activity:read`. |
| The `APP_BILLING` grant role | Could not manage provider credentials or refund | Can do both | Review who holds it. |
| Operator sign-up without a workspace name | `BAD_REQUEST` | `WORKSPACE_NAME_REQUIRED` | Handle the code. |
| `PUT .../email-credentials` | A body with no `provider` was read as Resend | `provider` is required: `"resend"` or `"smtp"` | Send it. |
| `GET`, `POST`, `PATCH`, `DELETE .../applications/:id/end-user-roles` | A hidden alias of `/application-roles` | Removed (404) | Call `/api/v1/tenant/applications/:id/application-roles`. The `END_USER_ROLE_*` error codes are unchanged. |
| A built-in email template test send | Mailed any address | Needs a confirmed operator; on an Application with no email provider of its own it sends only to the caller's own address (`EMAIL_TEST_RECIPIENT_NOT_ALLOWED`) | Send the test to yourself. |

## Billing

The rule that changes most code: an amount is still an integer in the minor
unit of its currency, but **you no longer pick or format the price yourself**.
The API resolves which price a buyer is charged and returns it with a
`formatted` text. Show that. Do not pick a price out of `plan.prices`: the one
you pick is not the one checkout charges.

### Plans and prices

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| A plan's price | `amount` and `currency` on the plan | A price row. The plan carries `price` (resolved for the caller, or `null` for a plan with no flat price) and `prices[]` | Render `plan.price.formatted`. |
| `POST .../plans` (tenant and admin) | `{ slug, name, amount, currency?, ... }` | `{ slug, name, price?: { currency, amount }, ... }`. Leaving `price` out makes a plan with no flat price | Send `price`. `amount`, `currency` or `pricePerUnitCents` at the top level answer 400 `BILLING_FIELD_REMOVED`. |
| `PATCH .../plans/:slug` | `amount?`, `currency?` | `price?: { currency, amount } \| null`; `null` makes the plan free. Also `localPrices: 'INHERIT' \| 'TRUSTED' \| 'OFF'` | Send both fields of `price` together. |
| A plan in a response | Carried `amount`, `currency`, `pricePerUnitCents` | Carries none of them. `price`, `prices[]`, `defaultPriceId`, `isFree`. A per-unit figure you had stored is under `metadata.pricePerUnitCents` in the operator's plan, unread | Read `price`. |
| A free plan | `plan.amount === 0` | `plan.isFree` | Replace the comparison. A usage plan with no base fee has no price and is not free. |
| `GET /api/v1/billing/plans` (public) | The operator's plan: `applicationId`, `active`, `metadata`, timestamps | A fixed list of fields and nothing else. Takes `?country=` from a server caller and reads the user token when present | Stop reading the removed fields. Pass the buyer's country and token so `price` is theirs. |
| A plan with a trial | `trialDays` refused with `PLAN_TRIAL_UNAVAILABLE` | Accepted on SUBSCRIPTION plans. A buyer gets one trial per Application; a repeat answers 409 `BILLING_TRIAL_ALREADY_USED` | Retry with `allowWithoutTrial: true` and a new `Idempotency-Key` to sell at full price. |
| A plan carrying CREDIT or LICENSE entitlements and `trialDays` | Accepted | `PLAN_TRIAL_MATERIALISES_ENTITLEMENTS` | Drop one of the two. |
| An unknown field on the admin plan route | Dropped silently | 400 `VALIDATION_ERROR` naming it | Fix the field name. |
| A price that something refers to | Edited in place | Archived and replaced; an in-place edit answers `PLAN_PRICE_REFERENCED` | Use the price routes: `PUT`, `DELETE .../plans/:planId/prices/:currency`. |
| The free-tier default plan | Any plan | Must cost nothing: 409 `BILLING_FREE_PLAN_NOT_FREE` | Nominate a free plan. |

### Checkout, routing and fallback

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| The buyer's country | `x-country` header, or `country` in the body | `country` in the body of a POST, `?country=` on a GET. `x-country` answers 400 `BILLING_FIELD_REMOVED` | Send `country` from your server, or set `visitorCountryHint` on the SDK client. |
| Which price is charged | The plan's one price | The plan's price for the buyer's country and currency, when an enabled provider can charge it | Read `price` on the checkout result. |
| A local price no enabled provider can charge | | **The buyer is charged the default price**, `priceFallback` on the result says so, and the fallback is logged | Show `priceFallbackMessage(checkout.priceFallback)` before you redirect. Pass `onUnavailableCurrency: 'refuse'`, or set it as the Application default, to refuse instead (`BILLING_NO_PROVIDER_FOR_CURRENCY`). |
| `POST /api/v1/billing/checkout` body | `planSlug`, `provider?`, `country?`, URLs, `couponCode?` | Adds `currency` and `onUnavailableCurrency` | Optional. |
| The checkout result | `url`, `subscription`, `discountAmount`, `provider` | Adds `price`, `priceFallback`, `currency`, `unitAmount`, `mode`, `checkoutSessionId`, `warnings`, all always present | A fixture or mock needs the new fields. |
| `successUrl`, `cancelUrl` | Any URL | Not http(s) answers 400 `CHECKOUT_RETURN_URL_INVALID`. An unregistered origin still works and comes back in `warnings` as `CHECKOUT_RETURN_URL_UNREGISTERED` | Register each origin as the App URL or a redirect URL. |
| Checkout creation | Unlimited | 10 an hour and 30 a day per end user, 20 an hour per IP, 1000 an hour per Application: 429 `CHECKOUT_RATE_LIMITED` | Do not open a checkout on page load. |
| A second checkout while the first is being paid | Opened | 409 `CHECKOUT_PAYMENT_IN_PROGRESS`, or 503 `CHECKOUT_PAYMENT_STATUS_UNAVAILABLE` when the provider cannot be asked | Wait for the first to settle. |
| Buying the same one-off plan twice | Charged twice, delivered once | Delivers twice | Nothing. |
| A charge that matches no checkout or price | Dropped | Recorded as an unverified payment with an unapplied case. It grants nothing until an operator applies it | Review unapplied cases in the panel. |
| Stripe Checkout | Card only | Whatever the account enables; an unpaid `checkout.session.completed` activates nothing | Press Auto-configure so the endpoint receives `checkout.session.async_payment_succeeded` and `charge.refunded`. |
| A Stripe event whose `livemode` contradicts the credential's mode | Applied | 409 `WEBHOOK_MODE_MISMATCH`, retried by Stripe | Fix the stored mode. |

### Coupons

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| A percentage coupon | `discountType: "PERCENT"`, `amountOff: 1500` | `discountType: "PERCENT"`, `basisPoints: 1500`, optionally `currencies: ["USD"]` | Rename `amountOff` to `basisPoints`. |
| A fixed coupon | `discountType: "AMOUNT"`, `amountOff: 500`, `currency: "USD"` | `discountType: "AMOUNT"`, `amounts: [{ "currency": "USD", "amountOff": 500 }]` | Move the pair into `amounts`, with one entry per currency the coupon should work in. |
| `amountOff` or `currency` at the top level of a create or update | Accepted | 400 `BILLING_FIELD_REMOVED` | Send the new shape. |
| A fixed coupon in a currency it has no amount for | `COUPON_CURRENCY_MISMATCH` at checkout | `COUPON_CURRENCY_NOT_COVERED` at the quote and at checkout. Nothing is converted | Show its `message` and let the buyer continue without the code. |
| Percentage rounding | Rounded down | Rounded toward the buyer: 15% of $19.99 takes $3.00 | Read the quote instead of computing. |
| `POST /api/v1/billing/coupons/validate` | `{ code, planSlug }`; result `plan: { slug, name, amount, currency }`, `coupon: { code, discountType, amountOff, currency }` | Also takes `country`, `currency`, `onUnavailableCurrency`, `provider`, `organizationId`. Result `plan: { slug, name }`, `coupon: { code, discountType, basisPoints }`, plus `price`, `priceFallback`, `currency`, `amount`, `formatted: { discount, total }` | Send what the checkout will send. Render `formatted.discount` and `formatted.total`. |
| `PATCH .../coupons/:code` | Changed `active` | Also `basisPoints`, `amounts`, `currencies`, `planSlugs`, `endsAt`, `maxRedemptions`, `maxRedemptionsPerUser` | A cap below what is already redeemed answers 409 `COUPON_LIMIT_BELOW_REDEEMED`. |
| Coupon totals | One total | `discountIssuedByCurrency`, one row per currency | Sum nothing across currencies. |

Existing fixed coupons were given one amount, in their old currency.

### Subscriptions and entitlements

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| End-user subscription responses (`GET /billing/subscription`, cancel, subscribe, checkout's `subscription`) | The stored row | An allowlist. `metadata` keeps only `checkoutSessionId` and `oneTime` | Stop reading other keys. |
| What a subscription costs | Read from its plan | `price: { id, currency, amount, formatted } \| null` on the subscription: what this subscriber pays. `null` when it has no price of its own; nothing is borrowed from the plan | Show `subscription.price.formatted`. |
| `GET /api/v1/billing/subscription` | The newest row, PENDING included | A live subscription before an unfinished checkout, a paid plan before a free one | A "confirming" state keyed on PENDING needs another signal. |
| `billing.subscribe()` | A subscription | Can return `subscription: null` | Handle `null`. |
| `GET /api/v1/billing/entitlements` without `?organizationId=` | The active organization | The end user, on a user-billed Application | Pass `organizationId` when you mean the organization. |
| `entitlements[]` order | Subscription rows first | Free-tier rows first; an override beats the free tier | Read `features`, not `entitlements.find()`. |
| A free plan that grants credits or a licence | Claimable repeatedly | Once per end user: 409 `BILLING_FREE_TIER_ALREADY_CLAIMED` | Nothing. |
| A grant for a second subject on a plan the user already holds | Overwrote | 409 `BILLING_SUBSCRIPTION_SUBJECT_CONFLICT` | Cancel the first. |
| Cancelling a checkout that never completed | Accepted | 409 `SUBSCRIPTION_CHECKOUT_UNFINISHED` | Let it expire. |
| `POST /usage/record` with a reused `idempotencyKey` and another quantity | Accepted | 409 `IDEMPOTENCY_KEY_REUSED`. A record waiting over 2 seconds answers 503 `USAGE_RECORD_BUSY` | Use a new key per record; retry the 503. |
| A FEATURE override of `""`, a quantity on a licence with no seats | Accepted | `ENTITLEMENT_OVERRIDE_INVALID` | Send `null` to remove an override. |

### Payments and refunds

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| A refund | A total on the payment | A record. Several per payment, partial ones, and operator-started ones: `GET`, `POST .../payments/:paymentId/refunds` | Subscribe to `payment.refunded` if you act on refunds. |
| A payment row | `amount`, `currency`, `status` | Adds `refundedAmount`, `verification` (`verified` or `unverified`), `provider`, `refundable`, `refundBlockedReason` | Net paid is `amount - refundedAmount`. **Never count an `unverified` payment as revenue.** |
| Stripe renewals and failed renewals | Dropped | Recorded: renewals create payments, refill credits and extend timed licences | Nothing. |
| A refund past the payment, or of an invoice paid outside the provider | Applied | `BILLING_REFUND_EXCEEDS_PAYMENT`, `BILLING_PAYMENT_NOT_REFUNDABLE` | Refund it at the provider. |

### Stats and the reporting currency

Money is reported per currency and never added across currencies. Nothing is
converted.

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| `mrrCents`, `mrrCurrency`, `mixedCurrencies` on billing stats | One figure in the dominant currency, and a flag | `mrr: { currency, mrrCents, activeSubscriptions }[]` | Render one row per currency. |
| `revenueLast30dCents` | One figure | `revenueLast30d: { currency, grossCents, refundedCents, netCents, payments }[]`, verified payments only | The same. |
| `monthlyRevenue` | One series | One series per currency | Chart one line per currency. |
| New on billing stats | | `reportingCurrency`, `unverified`, `unpricedLiveSubscriptions` | A fixture or mock needs them. |
| MRR | Counted every active subscription at its plan's price | Counts a subscription at its own price and leaves out one that has none | Price the subscriptions `unpricedLiveSubscriptions` counts. |
| `billingConfig.currency` | The Application's default currency | `billingConfig.reportingCurrency`, set with `PUT .../billing/reporting-currency`. Stored values were carried over | Rename where you read it. |
| `billingConfig` in an Application response | As stored | Complete: every setting present at its default | Stop guarding against `undefined`. |
| Super-admin metrics | `mrrCents`, `volumeCents`, `sort=mrrCents` | Per currency; `sort=mrr` | Read the per-currency lists. |
| Overview and billing stats | Computed per request | Cached: fresh for 60 seconds, served stale for up to 15 minutes while refreshing | Do not expect a write to show at once. |

### Providers and their currencies

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| A provider account's currencies | Not recorded: any | `currencies`, chosen from the provider's `supportedCurrencies`. **Empty means none**: the provider is used for no checkout | The upgrade gives every existing account a list (below). Check each. |
| A code the provider does not publish | | Refused on save with `BILLING_PROVIDER_CURRENCY_NOT_OFFERED` | Choose from `supportedCurrencies`. |
| A provider saved without `currencies` | | Stored with the provider's `preselectedCurrencies` | Nothing. |
| `GET /api/v1/billing/providers` | Country in `x-country` | `?country=` and `?planSlug=`; adds `countrySource`, `routedProvider`, and `currencies` per provider | Preselect `routedProvider` in a picker. |

What the upgrade gives an existing account: a Stripe account gets every
currency Stripe lists; a PayPal account gets PayPal's cross-border currencies
and a Razorpay account gets INR, each plus every currency that Application
has already sold in on that provider; any other provider gets every currency
a price may be in. A Razorpay account that sells outside INR and has not yet
sold there needs its other currencies ticked.

### The billing log and support mode

Both are new and change nothing you already call. The billing log is an
append-only record per Application of every money change; see
[billing-log.md](billing-log.md). Support mode lets an operator open a case on
an end user; while one is open your app can read it from
`GET /api/v1/auth/me?include=support`; see [support-mode.md](support-mode.md).

## Outbound webhooks

| Event | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| Endpoints subscribed to `*` | | Start receiving `credit.granted`, `credit.consumed`, `credit.adjusted`, `payment.refunded`, `user.updated`, `user.banned`, `user.unbanned`, `user.onboarding_completed`, `user.onboarding_skipped`, `contact.subscribed`, `contact.submission.created`, `contact.unsubscribed`, `subscription.trial_will_end`, `support.opened`, `support.updated`, `support.closed` | Ignore event types you do not handle. `credit.consumed` fires once per charged usage record. |
| `payment.succeeded`, `payment.failed` | `data.payment` | Adds `refundedAmount` and `verification` | **Do not provision on a `payment.succeeded` whose `verification` is `unverified`.** |
| `subscription.*` `amount`, `currency` | The plan's price | The subscription's own price. `currency` is `null`, with `amount: 0`, when it has none | Handle `null`. Do not substitute a default currency. |
| `subscription.*` `entitlements` | `[]` when unresolved | Left out when the grant cannot be resolved | Absent means unknown: do not downgrade on it. |
| `subscription.activated` | Could arrive once per provider delivery | Once | Nothing. |
| `user.updated` | In the event list, never sent | Sent when a value changed, with `data.changed` and `via` (`oauth`, `password_reset`, `mfa`, `server` among them) | A handler that switches on `via` or `changed` needs a default. |
| `session.created` | | Adds `platform` and `country` | Optional. |
| Delivery | Unbounded | At most 4 sends in flight to one endpoint and 8 for one Application; `WEBHOOK_TIMEOUT_MS` 10 seconds | Answer quickly. |
| Endpoints per Application | Unlimited | 100: `WEBHOOK_ENDPOINT_LIMIT_REACHED` | Merge endpoints. |
| `http://` endpoints in production | Delivered | Not delivered, and refused on save with `URL_NOT_HTTPS` | See [the https rule](#the-https-rule). |

The full shapes are in [webhooks.md](webhooks.md).

## API keys and scopes

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| `*` on an API key | Every scope | Every standard scope. `credits:grant` and `contacts:read` are elevated and no existing key holds them | Mint a key that names the elevated scope. |
| An unknown scope at mint | 201 with a scope that matched nothing | 400 `API_KEY_SCOPE_UNKNOWN` (`OPERATOR_SCOPE_UNKNOWN` for an operator token) | Use a scope from `details.valid`. |
| `POST .../mcp/:slug/oauth/authorize/grant` | Any secret key | Needs `auth:write` | Use a key that has it. |
| An `auth:read` secret key | | Can read the signed-in user's organizations, sessions, passkeys, MFA status and linked identities | Review keys that hold it. |
| Rate limits | 6000 a minute per secret key | 30000 a minute; MCP token introspection counts against the key's own budget | Nothing. |

## Error codes

Removed, renamed, or changed in meaning. Every new code is in
[errors.md](errors.md).

| Code | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| `PLAN_AMOUNT_INVALID` | A negative plan `amount` | Gone | Handle `PLAN_PRICE_AMOUNT_INVALID`. |
| `PLAN_TRIAL_UNAVAILABLE` | Any `trialDays` | Gone: trials are sold | Remove it. |
| `COUPON_CURRENCY_MISMATCH` | A fixed coupon in another currency | Gone | Handle `COUPON_CURRENCY_NOT_COVERED`. |
| `BILLING_FIELD_REMOVED` | Not present | A removed plan field, a removed coupon field, or the `x-country` header | Fix the request as its `fix` says. |
| `EMAIL_NOT_VERIFIED` | Sign-in refused | Also: no new sign-in method on an unverified account, and an operator action that waits for a confirmed address | Branch on the route. |
| `EMAIL_ALREADY_EXISTS` | Every duplicate sign-up | Not sent to a publishable key when `requireEmailVerification` is on | See [Auth](#auth). |
| `DEPENDENCY_UNAVAILABLE` (503) | Redis or the database down | Also a busy connection pool (`details.reason`), and auth email routes without Redis | Retry after `Retry-After`. |
| `BILLING_CREDENTIALS_NOT_CONFIGURED` | Any Application with no usable provider | An Application whose only provider is inbound-only answers `BILLING_PROVIDER_INBOUND_ONLY` | Handle both. |
| `fix` texts on billing errors | Named the old single Billing page | Name the new panel paths | Match on `code`, never on `fix`. |

## SDK packages

Upgrade all of them together: they share one version.

### `@rekey.dev/node`

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| `billing.getPlans` | `getPlans(page?)` | `getPlans(page?, { country?, accessToken? })` | Pass the buyer's country and token. |
| A plan from `getPlans` | `PlanDto` with `amount`, `currency`, `metadata` | `PublicPlanDto`: `price`, `prices`, `isFree`, `checkout` and a fixed list of plan fields | Render `plan.price?.formatted`. |
| `billing.createCheckout` | Sent `country` as `x-country` | Sends it in the body; takes `currency` and `onUnavailableCurrency`; the result carries `price` and `priceFallback` | Check `priceFallback` before redirecting. |
| `billing.validateCoupon` | `{ code, planSlug }` | Also `country`, `currency`, `onUnavailableCurrency`, `provider`, `organizationId` | Send what the checkout will send. |
| `billing.getProviders` | `getProviders(country?)` | `getProviders(country?, { planSlug? })` | Optional. |
| `billing.subscribe` | A subscription | `SelfSubscriptionDto \| null` | Handle `null`. |
| `usage.record` | No `idempotencyKey` | Accepts `idempotencyKey` | Send one. |
| Operator calls | Hand-written `fetch` | `RekeyOperator`, with an operator token: plans and prices, coupons, payments and refunds, the billing log, stats, the routing preview, billing settings | Replace hand-written calls. |
| Money helpers | None | `formatMoney`, `validatePriceAmount`, `priceFallbackMessage`, `isSellableCurrency` and the rest of the currency registry | Remove every fixed divisor and every list of zero-decimal currencies. |

```ts
import { formatMoney, priceFallbackMessage } from '@rekey.dev/node';

export async function pricingAndCheckout(userAccessToken: string, country: string) {
  // 2.1.0: `${plan.amount / 100} ${plan.currency}` for every plan.
  const { items } = await rekey.billing.getPlans(undefined, { country, accessToken: userAccessToken });
  const labels = items.map((plan) => plan.price?.formatted ?? (plan.isFree ? 'Free' : 'Usage based'));

  // 2.1.0: `const { url } = await createCheckout(...)`, then redirect.
  const checkout = await rekey.billing.createCheckout(userAccessToken, { planSlug: 'pro', country, successUrl, cancelUrl });
  const notice = checkout.priceFallback ? priceFallbackMessage(checkout.priceFallback) : null;

  // An amount you hold yourself, such as a payment row.
  const example = formatMoney(149900, 'INR'); // '₹1,499.00'
  return { labels, url: checkout.url, notice, example };
}
```

### `@rekey.dev/react`

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| `PricingPlan` | `amount`, `currency` | `price`, `prices`, `isFree`, `checkout`. No `amount`, no `currency` | Pass the `items` of `getPlans()` as they are. |
| `<PricingTable>` | Divided `amount` by 100 and prefixed a symbol | Renders `price.formatted`, a note when a local price is unavailable, and a plan that cannot be bought as unavailable | Nothing, once `plans` carries `price`. |
| `formatPrice` | Exported | Removed | Use `formatMoney(amount, currency)`. |
| `client.getPlans` | `getPlans(page?)` | `getPlans(page?, { accessToken? })` | Pass the token for a signed-in buyer. |
| `client.listBillingProviders` | Sent the country as `x-country` | Sends `?country=`; takes `planSlug` | Nothing in your code. |
| `ProviderOption.currencies` | Not present | The account's currencies. Empty means none | Pass providers as `getProviders()` returned them. |
| New | | `<PriceFallbackNotice>`, `<CouponQuote>`, `client.validateCoupon`, `<NewsletterForm>`, the money helpers | Optional. |
| A banned or erased user | Threw on every page | Treated as signed out | Nothing. |

### `@rekey.dev/nextjs` and `@rekey.dev/astro`

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| The refresh route (Next.js) | Hand-written, or none | `rekeyRefreshHandler()` | Add it; see [Sessions](#sessions-and-refresh). |
| A pricing page | Called `rekey.billing.getPlans()` | Call it through a client scoped with the visitor's country hint and the session's token | Next.js: `rekey.with({ visitorCountryHint: await visitorCountryHint() })`. Astro: `visitorClient(context)`. |
| A checkout action | Redirected to `url` | Check `priceFallback` first | Show the notice, then redirect. |
| The access cookie's `maxAge` (Next.js) | A fixed default | Follows the access token's own lifetime | Nothing. |
| `getSession` (Astro) | Refreshed anywhere | Refreshes only inside `rekeyMiddleware`, or with `{ refresh: true }` | Install the middleware. |

### `@rekey.dev/shared-types`

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| `PlanDtoSchema` | One schema for both readers, with `amount`, `currency`, `pricePerUnitCents` | `PlanDtoSchema` (operator) without those three, and a strict `PublicPlanDtoSchema` | Parse a `GET /billing/plans` row with `PublicPlanDtoSchema`. |
| `CouponDtoSchema` | `amountOff`, `currency` | `basisPoints`, `amounts[]`, `currencies[]`, `coveredCurrencies` | See [Coupons](#coupons). |
| `CheckoutResultDtoSchema` | `url`, `subscription`, `discountAmount`, `provider` | Adds the fields in [Checkout](#checkout-routing-and-fallback), all required | Update fixtures. |
| `ApplicationDtoSchema` | `environment` optional, and not sent by `GET /api/v1/me` | `environment`, `supportEmail`, `reportingTimezone`, `promotedAt`, `disabledAt`, `disabledReason` are required (null where there is no value), and every route that returns an Application sends them | Remove the guards. A fixture or mock needs the fields. |
| `AuthResultDtoSchema` | No `deviceId`, no `isNewUser` | Both required: `deviceId` is null when the client sent no fingerprint | Route new users to onboarding on `isNewUser`. A fixture needs both. |
| `EndUserExport` | No ban, profile, onboarding, support or contact sections | `endUser.bannedAt`, `profile`, `onboardingCompletedAt`, `onboardingSkippedAt`, `createdVia`, and `supportCases` and `contacts`, all required | An archive reader can rely on them. |
| `BillingConfigSchema` | `currency` | `reportingCurrency`, `onUnavailableCurrency`, `localPrices` | Rename. |
| The billing stats schema | Scalars | Per currency | See [Stats](#stats-and-the-reporting-currency). |
| New exports | | The currency registry, `BILLING_MONEY_ERROR_CODES`, the refund, billing log, reporting, routing preview, list, profile and support schemas | Listed in the package README. |

## CLI

| Command | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| `rekey plans create` | `--amount`, `--currency`, `--interval`, and `--kind`, `--license-kind`, `--license-duration-days`, `--license-seats-allowed`, `--meter-slug`, `--price-per-unit-cents`, `--credits-amount` | `--amount`, `--currency`, `--interval`. Sends `price: { currency, amount }`, and no price for `--amount 0`. The other seven flags answer `CLI_PLANS_KIND_UNSUPPORTED` | Create a per-kind plan in the panel or with the tenant route. |
| `rekey plans list` | Printed the integer amount and the currency code | Prints money for a person, such as `$19.00`. `--json` carries the integer and the code | Parse `--json`, not the text. |
| Usage errors under `--json` | Plain text | JSON on stderr (`CLI_USAGE_ERROR`), exit 1 | Parse stderr as JSON. |
| `rekey doctor` | Connection checks | Also checks each Application's money setup | Run it after the upgrade. |
| New | | `plans prices`, `plans local-prices`, `coupons`, `billing log`, `billing preview`, `billing reconciliation`, `billing price-fallbacks`, `billing reporting-currency`, `billing unavailable-currency`, `payments show`, `refunds`, `lists`, `users`, `analytics` | Most take an operator token (`REKEY_OPERATOR_TOKEN`). |

## MCP

Operator MCP server (`/api/v1/tenant/mcp`):

| Tool | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| `update_auth_config`, `create_webhook_endpoint`, `update_webhook_endpoint`, `change_member_role` | Write tools | **Admin tools.** A write-only connection gets `OPERATOR_MCP_ADMIN_REQUIRED` in the tool result. A personal access token cannot call them over MCP | Reconnect and approve admin access on the consent page. |
| `invite_member`, `remove_member`, the organization role and member tools | Acted on any role | Act on MEMBER-tier roles only with write access | The same. |
| `create_plan` | `amount`, `currency`, `pricePerUnitCents` | `price: { currency, amount }`. The old inputs are refused | Send `price`. |
| `update_plan` | Name, licence seats and duration, credit amount | Also `localPrices` (`INHERIT`, `TRUSTED`, `OFF`) | Optional. |
| A plan in a tool result | `amount`, `currency` | `price`, `prices` | Read `price`. |
| `get_workspace_overview` | `mrrMinor`, one sum | `currencies`, one entry per currency | Read the list. |
| `recent_subscriptions`, `get_end_user` | A currency on every subscription | A null currency for a subscription with no price of its own | Handle `null`. |
| `create_webhook_endpoint`, `update_webhook_endpoint` | Any URL | Refuse a private or loopback URL (`WEBHOOK_URL_UNSAFE`) and, in production, `http://` | Use a public https URL. |
| Tools that wait for a confirmed operator | | `invite_member`, `change_member_role`, `mint_api_key`, `create_webhook_endpoint`, `update_webhook_endpoint`, `configure_billing_provider`, `update_auth_config` (for `appUrl` or `redirectUrls`) | The operator confirms their email. |
| New tools | | Prices, coupons, refunds (`create_refund` is an admin tool), the billing log, the routing preview, the reporting currency, devices, lists, support cases, analytics | Listed in [mcp.md](mcp.md). |

End-user MCP: a hosted authorize page must ask for consent before a code is
minted (`POST /api/v1/mcp/:slug/oauth/authorize/preview` describes the
request), and an access token minted by 2.1 is refused once; the client
refreshes. `@rekey.dev/mcp`, the local admin server, gains read tools for
billing and, with an operator token, payments, coupons, refunds and prices.

## Panel

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| The panel and the API | A panel could run against an older API and hide what it did not find | The panel reads only the API of its own release | Deploy the API first, then the panel, in one sitting. |
| Forms | Worked without JavaScript | Need JavaScript to submit | Enable scripts. |
| Billing | One page | Setup tabs (Status, Providers, Checkout page, Events, Settings), plan prices, coupons per currency, a Billing log, a payment page with refunds. Old `/billing?edit=` links redirect | Update bookmarks. |
| Two-factor sign-in | The challenge in the URL | In a cookie; an old `?challenge=` or `?mfa=` link is ignored (panel and portal) | Sign in again. |
| End-user page, email page, Team | Single pages | Tabs | Update bookmarks. |

## Database

For anyone who reads or writes the database directly.

| What | Before (2.1.0) | After (2.2.0) | What to do |
|---|---|---|---|
| A plan's price | `plans.amount`, `plans.currency` | The `plan_prices` row `plans.default_price_id` names. The two columns and `plans.price_per_unit_cents` are **dropped**; a per-unit figure is kept as `metadata ->> 'pricePerUnitCents'` | Join `plan_prices`. `plans.is_free` says whether a plan with no price is free. |
| A coupon's discount | `coupons.amount_off`, `coupons.currency` | `coupons.basis_points` for a percentage; `coupon_amounts` rows for a fixed amount. The two columns are **dropped** | Read the new places. |
| What a subscription pays | Its plan's price | `subscriptions.plan_price_id`, `currency`, `unit_amount`: all set or all null, enforced. `currency` is the price row's currency, which the API keeps and no constraint holds | Read them; do not fall back to the plan. |
| A refund | `payments.refunded_amount` | Also one `refunds` row per refund | Read `refunds` for the history. |
| `billing_config ->> 'currency'` | The default currency | Removed; `reportingCurrency` | Rename. |
| `tenant_users.failed_sign_in_attempts`, `locked_until`; `failed_attempts`, `locked_until` on `mfa_credentials` and `tenant_mfa_credentials` | Present, unused | Dropped. Lockout lives in Redis | Remove them from reports. |
| Constraints | | A price row a subscription names cannot be deleted; a percentage coupon has a rate and a fixed one has none; a free plan has no default price; `currencies` is never NULL | Write through the API. |

## New in 2.2 you can adopt later

None of these change what you already call.

- More than one currency per plan, and prices by country: [currencies.md](currencies.md)
- The billing log and reconciliation: [billing-log.md](billing-log.md)
- Refunds from the panel and the API: [billing.md](billing.md)
- The Rekey checkout page: [billing.md](billing.md#the-rekey-checkout-page-beta)
- An inbound-only provider for your own billing system: [external-billing.md](external-billing.md)
- Contact lists, waitlists and forms: [lists.md](lists.md)
- Profile fields and onboarding: [profile-fields.md](profile-fields.md)
- Support mode: [support-mode.md](support-mode.md)
- Devices: [devices.md](devices.md)
- Custom email templates: [email-templates.md](email-templates.md)
- User analytics: [analytics.md](analytics.md)
- Organization roles: [organization-roles.md](organization-roles.md)
- Operator and stdio MCP tools: [mcp.md](mcp.md)

## After you upgrade

1. **Operators confirm their email.** Each operator signs in to the panel,
   presses "Send confirmation email" and opens the link. Until then they
   cannot invite, mint keys, or change webhooks, providers or sign-in
   settings.
2. **Check each provider's currency list** under Billing, Setup, Providers,
   and run `rekey doctor`. Tick the currencies a Razorpay or PayPal account
   sells in beyond what the upgrade gave it.
3. **Compare provider registrations** with the output you saved from
   preflight query A6. The ids must be the same.
4. **Re-consent MCP clients that need admin tools.** An agent that changed
   auth settings, webhooks or member roles reconnects and approves admin
   access.
5. **Move `http://` webhook endpoints** to https, then retry their failed
   deliveries from the endpoint's page.
6. **Press Auto-configure for Stripe and PayPal** so each webhook endpoint
   listens for the events 2.2 reads.
7. **Send `emailVerified: true`** from your server for the users it creates
   whose addresses you verified.
8. **Price the subscriptions that have none.** Billing, Overview shows how
   many live subscriptions on a paid plan record no price of their own; they
   are in no MRR figure until an operator sets one.
