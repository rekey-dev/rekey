# AGENTS.md — `@rekey.dev/cli`

You are an AI agent reading the Rekey CLI. This file tells you how to use it correctly on the first try.

**Three credentials, by command.** `init`, `apps` and `plans list|create|set-active` drive the deployment-wide admin API and need `SUPER_ADMIN_KEY`, which only whoever runs the deployment holds. If the user is on Rekey Cloud (`REKEY_URL=https://api.rekey.dev`) they do not have that key and never will: do not ask them for it. Point them at the panel for bootstrap and at the hosted operator MCP (`https://api.rekey.dev/api/v1/tenant/mcp`, see [rekey.dev/docs/mcp](https://rekey.dev/docs/mcp)) for agent access. `plans prices`, `coupons`, `billing`, `payments`, `refunds`, `analytics` and the money checks of `doctor` take an operator personal access token, and `lists` an Application secret key; those work anywhere, Rekey Cloud included.

## Two design rules

1. **Every command is non-interactive when given enough flags.** No required prompts, no spinners, no readline. An agent can call `rekey init --tenant-name X --owner-email Y --app-name Z --app-slug s --json` and parse stdout without ever touching a TTY.
2. **`--json` is the structured-output toggle.** Pass it on any command and stdout is a single JSON document. Without it, the same data renders as friendly text. Errors always go to stderr; exit code is 0 on success, non-zero on failure.

## Required env (or flag overrides)

| Var | Override flag | Used for |
|---|---|---|
| `REKEY_URL` | `--api-url <url>` | Where the API is. e.g. `http://localhost:3030` or `https://rekey.example.com`. |
| `SUPER_ADMIN_KEY` | `--admin-key <hex>` | Bootstrap admin credential, for `init`, `apps`, `plans list`, `plans create`, `plans set-active`, and the `billing-outbox` check of `doctor`. |
| `REKEY_SECRET` | `--secret-key <key>` | An Application secret key, for `lists`. |
| `REKEY_OPERATOR_TOKEN` | `--operator-token <token>` | An operator personal access token, for `plans prices`, `coupons`, `billing`, `payments`, `refunds`, `analytics` and the money checks of `doctor`. Reads need the `read` scope; `plans local-prices`, `plans prices add|update|archive`, `coupons create|update` and `billing reporting-currency set` need `applications:write`. Issuing a refund and changing the unavailable-currency default need an operator session: do them in the panel. |

`rekey doctor` checks these and returns a structured report. Read its output before invoking other commands when you're not sure of the env state.

## Commands you should know

```
rekey version                                    # CLI version (--json aware)
rekey --version                                  # same value, plain string
rekey doctor [--app <id>]                        # config, connectivity and money checks
rekey init --tenant-name … --owner-email …       # one-shot bootstrap
            --app-name … --app-slug …
rekey apps list [--tenant <id>]                  # Application CRUD
rekey apps get <id>
rekey apps create --tenant <id> --name … --slug …
rekey plans list --app <id> [--include-inactive]
rekey plans create --app <id> --slug … --name …
                    --amount <int> [--currency USD] [--interval MONTH|YEAR]
rekey plans set-active --app <id> --slug … --active true|false
rekey lists ls                                   # needs REKEY_SECRET
rekey lists export <key> [--format csv|jsonl]    # key minted with contacts:read
                    [--status subscribed|unsubscribed|all] [--out <file>]

# Everything below needs REKEY_OPERATOR_TOKEN
rekey analytics users --app <id> [--range 30d] [--sections kpis,activity] [--platform ios]
rekey plans prices list <plan> --app <id>
rekey plans prices add <plan> <currency> <amount> --app <id> [--countries IN,NP]
rekey plans prices update <plan> <currency> --app <id> [--amount <n>] [--countries IN,NP]
rekey plans prices archive <plan> <currency> --app <id>
rekey coupons list --app <id>
rekey coupons show <code> --app <id>
rekey coupons create --app <id> --code X
        (--percent 15 | --basis-points 1500 | --amount USD=500 --amount INR=40000)
        [--currencies USD,EUR] [--plans pro,team] [--starts-at ISO] [--ends-at ISO]
        [--max-redemptions n] [--max-redemptions-per-user n]
rekey coupons update <code> --app <id> [--active true|false] [--basis-points n]
        [--amount CUR=n ...] [--currencies ...] [--plans ...] [--ends-at ISO|none]
        [--max-redemptions n|none] [--max-redemptions-per-user n|none]
rekey billing log --app <id> [--type a,b] [--tier permanent|diagnostic]
        [--end-user id] [--subscription id] [--payment id] [--currency INR]
        [--from ISO] [--to ISO] [--limit n] [--cursor c] [--all [--max n]]
rekey billing preview --app <id> --country IN [--plan <slug|id>] [--coupon CODE]
        [--country-source declared|vouched|hint] [--currency INR] [--provider name]
        [--end-user id] [--on-unavailable-currency fallback|refuse]
rekey billing reporting-currency get --app <id>
rekey billing reporting-currency set <CODE> --app <id>
rekey billing unavailable-currency get --app <id>
rekey billing reconciliation --app <id> [--from ISO] [--to ISO]
rekey billing price-fallbacks --app <id> [--from ISO] [--to ISO]
rekey payments show <paymentId> --app <id>
rekey refunds list <paymentId> --app <id>
```

`lists` acts as one Application, so it takes that Application's secret key (`REKEY_SECRET` or `--secret-key`) and works on Rekey Cloud too. `lists export` writes the members to stdout, or to `--out`; with `--out` and `--json`, stdout is a summary `{ key, format, status, count, file }`. CSV cells starting with `=`, `+`, `-` or `@` are prefixed with `'` so a spreadsheet never runs them.

`analytics users` returns the Insights page of one Application (`GET /api/v1/tenant/applications/:id/analytics/users`) as the API sends it: per-section envelopes, each naming its timezone. Every filter flag is passed through unchanged (`--created-via` becomes `createdVia`), and the API's `code` and `fix` come back on failure.

Add `--json` to any of them. Every error envelope (text or JSON) carries `code`, `message`, and `fix`. Read `fix` first.

## Money

Every amount is a whole number of **minor units of its currency**: `1900` is $19.00 in USD, `5000` is ¥5,000 in JPY (yen has no smaller unit), `149900` is ₹1,499.00 in INR. Amounts are never floats and never converted between currencies. The CLI refuses a decimal, a zero or negative price, a currency a price cannot be in (three-decimal currencies such as KWD), and a HUF or TWD amount that does not end in `00`, before any request is sent. Text output prints money for a person (`$19.00`, `¥5,000`); `--json` output carries the integer and the currency code.

- **`plans prices`**: `<plan>` is the plan's id or slug. `list` prints every price, the default one first, with its id and where it stands at the provider (`registration`). `add` and `update` call one route (`PUT …/plans/:plan/prices/:currency`), which creates the price when the plan has none in that currency and changes it otherwise; the amount can change only until a provider has registered the price (`PLAN_PRICE_IMMUTABLE` after that), `--countries` at any time, and `--countries ""` means wherever the currency is the local one. `archive` stops selling the plan in that currency: the row is kept, archived, when a subscription, a payment or a credit grant names it, and deleted when nothing does. It is refused with `PLAN_PRICE_IN_USE` while a live subscription or an open checkout is on the price. A plan's default price is changed through the plan, not here (`PLAN_PRICE_IS_DEFAULT`).
- **`coupons`**: a percentage coupon (`--percent 15`, or `--basis-points 1500`) works in any currency unless `--currencies` limits it. A fixed coupon takes one `--amount CUR=n` per currency and works only in those currencies. On `update`, `--amount` replaces the whole set: a currency you leave out stops working. A coupon's type cannot change. Codes are stored lower-case. `list` prints what each coupon has taken off, per currency. On `coupons update`, `--ends-at`, `--max-redemptions` and `--max-redemptions-per-user` each take a value or `none`, which removes the end date or the cap. A cap below the redemptions already held is refused with `COUPON_LIMIT_BELOW_REDEEMED`; the error's `fix` names the lowest value that is accepted.
- **`billing log`** prints `{ items, nextCursor, actors }` with `--json`, newest first. `--include actors` fills `actors` with who the end users and operators named are; without it `actors` is null. `--all` follows `nextCursor` until the end or until `--max` entries (default 1000); when it stops at `--max`, `nextCursor` is the cursor to continue from. `--tier` is sent upper-case (`PERMANENT`, `DIAGNOSTIC`).
- **`billing preview`** opens no checkout and writes nothing. With `--currency` and no `--on-unavailable-currency`, the Application's default (`billingConfig.onUnavailableCurrency`) applies, as at checkout; `onUnavailableCurrency` in the result is the rule applied, and the text output says it on its first line. Each item carries `summary`, a `priceFallback` when the buyer's currency cannot be charged and the default price is charged instead, and, with `--coupon`, the coupon's `discount` or the `refusal` a checkout carrying it would get.
- **`billing reconciliation`** and **`billing price-fallbacks`** cover the last 7 days unless `--from` and `--to` say otherwise, at most 31. Dates are ISO 8601: a bare date is midnight UTC, and a time needs its zone.
- **`payments show`** prints one payment. With `--json`, `refundable` says whether a refund from the panel would reach the provider, and `refundBlockedReason` why not (`payment_not_succeeded`, `no_provider_charge_id`, `already_refunded`, `provider_unknown`, `provider_cannot_refund`, `provider_not_configured`).

## `rekey doctor`

`--json` prints `{ checks: [...] }`. Each check has `name`, `status`, `message`, a `fix` when it is not `ok`, and `applicationId` when it is about one Application. `status` is `ok`, `warn`, `fail` or `skipped`. The exit code is non-zero when any check is `fail`. **`skipped` is a check that did not run**, usually for want of a credential: do not read it as a pass.

With `REKEY_OPERATOR_TOKEN` (scope `read`) it checks every Application the token can see, or only `--app <id>`. It sends read-only requests.

| Check | Trips when | Status |
|---|---|---|
| `api-url` | `REKEY_URL` is not set | `fail` |
| `admin-key` | `SUPER_ADMIN_KEY` is not set | `warn` |
| `health` | `/health` does not answer 200 | `fail` |
| `applications` | the operator token cannot list Applications | `fail` |
| `plan-currencies` | an active plan has a price in a currency that cannot be sold, or at an amount the currency cannot be priced at | `fail` |
| `provider-currencies` | a provider stores a currency it cannot charge (`unsupportedCurrencies`), or an enabled provider has an empty `currencies` list, which means none | `fail` for the first, `warn` for the second |
| `price-providers` | no enabled provider can charge a live price | `fail` for a default price, `warn` for an additional one |
| `coupon-coverage` | an active, unexpired coupon covers none of the currencies its plans are priced in | `fail` |
| `unapplied-payments` | there are open unapplied payments | `warn` |
| `unpriced-subscriptions` | `unpricedLiveSubscriptions` of `GET .../billing/stats` is above 0: live subscriptions (ACTIVE, TRIALING, PAST_DUE) on a plan that has a price, with no price of their own. The `fix` names the grant route that prices them | `warn` |
| `reconciliation` | the billing log and the records disagree over the last 7 days | `fail` |
| `billing-outbox` | billing events keep failing to reach the log (needs `SUPER_ADMIN_KEY`, else `skipped`) | `fail` |

Without an operator token the money checks are `skipped` with a fix naming `REKEY_OPERATOR_TOKEN`. A check whose read the token is not allowed (403) is `skipped`; any other API error makes it `fail`.

With `--json`, a malformed invocation (unknown option or command, missing required option) is the same JSON envelope on stderr with code `CLI_USAGE_ERROR`. `--limit` must be an integer from 1 to 100 and `--offset` a non-negative integer; anything else fails with `CLI_LIST_LIMIT_INVALID` or `CLI_LIST_OFFSET_INVALID` before a request is sent.

## What you should always do

1. **Run `rekey doctor --json` first** if you're not sure the environment is wired up. Parse the `checks` array; act on `fix` for any non-`ok`.
2. **Use `--json`.** Text output is for humans; for agents it's lossy.
3. **An amount is minor units of its currency.** `999` is $9.99 in USD, `5000` is ¥5,000 in JPY. Floats are rejected so nothing is rounded.
4. **Save the rawKey from `init`.** It's printed once and is unrecoverable. The structured `init` output puts it at `apiKey.rawKey`.
5. **Hand the owner invite from `init` to `--owner-email`.** `ownerInvite.url` (or `<panel>/accept-invite?token=` + `ownerInvite.token` when `url` is null) is the only way that address becomes the tenant's OWNER: the admin routes write no membership, and a plain panel sign-up creates a separate workspace. It is single-use, bound to that email, and expires at `ownerInvite.expiresAt` (7 days). Relay `ownerInvite.nextStep` with it: it is worded for the deployment's sign-up mode (`ownerInvite.signupMode`). Never print it anywhere but to the person running `init`. If `init` fails with `CLI_INVITE_UNBOUND`, the API is older than 2.2.0: the tenant exists without an Application, and the fix names the call to mint its invite after upgrading.
6. **`plans create` makes SUBSCRIPTION plans only.** For a LICENSE, USAGE or CREDIT plan use `POST /api/v1/tenant/applications/:id/plans` with an operator token, or the panel. Asking this command for one fails with `CLI_PLANS_KIND_UNSUPPORTED` rather than creating the wrong plan.
7. **Pass `--environment` to `apps create`** when you want anything other than a DEVELOPMENT app. It is fixed at creation; raising it afterwards is a one-way `POST /api/v1/tenant/applications/:id/promote`. The environment decides whether keys are `rp_live_` or `rp_test_`.

## What you should never do

- Don't `npm install` `commander` or `yargs` to wrap this CLI. Call it directly.
- Don't pipe stdout through filters that swallow exit code (e.g. `rekey … | head`). Use `--json` and `jq`.
- Don't pass decimal money values like `--amount 9.99`, and don't multiply by 100 without checking the currency: JPY and KRW have no minor unit. The CLI rejects fractional amounts on purpose.
- Don't wrap commands in `expect`-style auto-input. There's nothing to type.

## Status

Ships with the 2.2.0 release line. `init`, `doctor`, `apps`, `plans`, `coupons`, `billing`, `payments`, `refunds`, `lists`, `analytics` and `version` are wired. Future:

- `rekey tunnel-webhooks` (the `stripe listen` equivalent: forwards a local server endpoint to the panel for development)
- `rekey api-keys list/create/revoke`
