# `@rekey.dev/cli`

> **ReliPay is now Rekey.** This package was previously published as the equivalent `@relipay/*` package, which is deprecated. Env vars renamed `RELIPAY_*` → `REKEY_*` (as of 2.0.0 the old names are no longer read — set `REKEY_*`). relipay.dev (the old domain) will redirect to rekey.dev after the domain migration.

`rekey` — command-line interface for **[Rekey](https://rekey.dev)** deployments. Designed for both human developers and AI agents.

> **Which commands need which credential.** `init`, `apps` and
> `plans list|create|set-active` call the deployment-wide admin API
> (`/api/v1/admin/*`) with `SUPER_ADMIN_KEY`, which only whoever runs the
> deployment holds. A Rekey Cloud workspace has no such key, so on Cloud use
> the panel (panel.rekey.dev) for what `rekey init` does, and the hosted
> operator MCP ([rekey.dev/docs/mcp](https://rekey.dev/docs/mcp)) to give an
> agent your workspace. `plans prices`, `coupons`, `billing`, `payments`, `refunds`,
> `analytics` and the money checks of `doctor` take an operator personal
> access token (`REKEY_OPERATOR_TOKEN`), and `lists` an Application secret key
> (`REKEY_SECRET`): those work on Cloud too. The Cloud quickstart is
> [rekey.dev/docs/quickstart](https://rekey.dev/docs/quickstart).

> **What is Rekey?** An auth + billing backend for your SaaS: sign-in (password, magic-link, passkeys, OAuth, MFA), subscriptions, usage, credits, licenses, and teams — behind one API, multi-tenant, provider-agnostic. Docs: **[rekey.dev/docs](https://rekey.dev/docs)**. This CLI manages a deployment — tenants, applications, API keys — from your terminal or an agent.

> **For AI agents**: start at [AGENTS.md](../../AGENTS.md).

## Install

```bash
pnpm add -g @rekey.dev/cli
# or per-project
pnpm add -D @rekey.dev/cli
```

## Use

```bash
export REKEY_URL=http://localhost:3030
export SUPER_ADMIN_KEY=$(openssl rand -hex 32)  # whatever you set on the deployment

rekey doctor

rekey init \
  --tenant-name "Acme" --owner-email ops@acme.com \
  --app-name "Acme Prod" --app-slug acme-prod

rekey apps list
rekey plans create --app <id> --slug pro_monthly --name Pro --amount 1900
rekey plans list --app <id>

# With an operator personal access token (panel, Account, API tokens)
export REKEY_OPERATOR_TOKEN=rp_op_...
rekey plans prices add pro_monthly INR 149900 --app <id>
rekey plans local-prices pro_monthly off --app <id>   # inherit | trusted | off
rekey coupons create --app <id> --code LAUNCH --percent 15
rekey billing preview --app <id> --country IN --coupon LAUNCH
rekey billing log --app <id> --type checkout.price_fallback
rekey doctor
```

An amount is a whole number of minor units of its currency: `1900` is $19.00,
`5000` is ¥5,000, `149900` is ₹1,499.00.

Add `--json` to any command for machine-readable output.

## Status

Ships with the 2.2.0 release line. Everything below in "Implemented" is real and wired to the API; everything under "Planned" **does not exist yet**, invoking it prints commander's unknown-command error.

### Implemented

`version` needs no environment. `doctor` needs `REKEY_URL`, and reports what it could not check for want of a credential as `skipped`. The **Needs** column names the credential each other command takes: `admin` is `SUPER_ADMIN_KEY`, `operator` is `REKEY_OPERATOR_TOKEN` (scope `billing:read` to read, `billing:write` to change), `secret` is `REKEY_SECRET`.

| Command | Needs | What it does |
|---|---|---|
| `rekey version` | none | Print the CLI version. `rekey --version` / `-V` print the same thing; the subcommand is the one that honours `--json`. |
| `rekey doctor [--app <id>]` | `REKEY_URL` | Config and connectivity (`/health` probe, env checks), then the money checks below. Exits non-zero when any check is `fail`. Run this first. |
| `rekey init` | admin | One-shot bootstrap: create tenant, owner invite, application, first API key. With `--json` the document is `{ tenant, ownerInvite, application, apiKey }` at the top level, with no `success`/`data` envelope on the success path, so the secret is at **`apiKey.rawKey`**, printed exactly once. (The `{ success: false, error }` envelope appears only on failure, on stderr.) `ownerInvite` is `{ email, role, expiresAt, token, url, signupMode, nextStep }`: a single-use link, valid 7 days, that makes `--owner-email` the tenant's OWNER when they sign up or sign in through it. `url` is null when the API has no `PANEL_URL`; open `<panel>/accept-invite?token=<token>` instead. `signupMode` is read from `GET /api/v1/tenant/auth/signup-mode` (null if that fails) and `nextStep` is worded for it: in `closed` mode only an existing account can accept. Without the link the owner has no way into the tenant: signing up normally creates a separate, empty workspace. Against an API too old to bind the invite to the tenant, `init` revokes the key and fails with `CLI_INVITE_UNBOUND` before creating the Application; upgrade the API to 2.2.0 or later. |
| `rekey apps list \| get <id> \| create` | admin | Application CRUD. `create` takes `--environment PRODUCTION\|STAGING\|DEVELOPMENT`, which fixes the key prefix (`rp_live_` / `rp_test_`) and defaults to DEVELOPMENT. |
| `rekey plans list \| create \| set-active` | admin | Plan management. `list` prints each plan with every price it sells at. `create --amount` is an integer in minor units of `--currency`, and makes **SUBSCRIPTION** plans only, see below. |
| `rekey plans prices list <plan> --app <id>` | operator | Every price of a plan, the default one first, with its id and its registration at the provider. `<plan>` is the plan's id or slug. |
| `rekey plans prices add <plan> <currency> <amount> --app <id> [--countries IN,NP]` | operator | Add a price in another currency. `<amount>` is an integer in minor units of `<currency>`. Without `--countries` the price applies wherever its currency is the local one. |
| `rekey plans prices update <plan> <currency> --app <id> [--amount <n>] [--countries IN,NP]` | operator | Change a price's amount, its countries, or both. The amount can change only until a provider has registered the price (`PLAN_PRICE_IMMUTABLE`). `add` and `update` call the same route, which creates the price when the plan has none in that currency. |
| `rekey plans prices archive <plan> <currency> --app <id>` | operator | Stop selling the plan in that currency. The price row is kept, archived, when a subscription, a payment or a credit grant names it, and deleted when nothing does. Refused with `PLAN_PRICE_IN_USE` while a live subscription or an open checkout is on it. |
| `rekey plans local-prices <slug> <inherit\|trusted\|off> --app <id>` | operator | Set whether a buyer's country may select one of the plan's prices in another currency. `inherit` follows the Application setting, `trusted` needs a country your server declared or a trusted proxy vouched for, `off` charges every buyer the default price unless your server names a currency. The change is written to the billing log. |
| `rekey coupons list --app <id>` | operator | Coupons, active and inactive, with what each has taken off per currency. |
| `rekey coupons show <code> --app <id>` | operator | One coupon. |
| `rekey coupons create --app <id> --code X (--percent 15 \| --basis-points 1500 \| --amount USD=500 --amount INR=40000) [--currencies USD,EUR] [--plans pro,team] [--starts-at ISO] [--ends-at ISO] [--max-redemptions n] [--max-redemptions-per-user n]` | operator | Create a percentage coupon, or a fixed one with an amount per currency. A fixed coupon works only in the currencies it has an amount in. `--currencies` limits a percentage coupon. |
| `rekey coupons update <code> --app <id> [--active true\|false] [--basis-points n] [--amount CUR=n ...] [--currencies ...] [--plans ...] [--ends-at ISO\|none] [--max-redemptions n\|none] [--max-redemptions-per-user n\|none]` | operator | Change a coupon. `--amount` replaces the whole set of amounts. `none` removes the end date or a cap. A cap below what is already redeemed is refused with `COUPON_LIMIT_BELOW_REDEEMED`. |
| `rekey billing log --app <id> [--type a,b] [--tier permanent\|diagnostic] [--end-user id] [--subscription id] [--payment id] [--currency INR] [--from ISO] [--to ISO] [--limit n] [--cursor c] [--all [--max n]] [--include actors]` | operator | The billing log, newest first: `{ items, nextCursor, actors }` with `--json`. `--all` follows the cursor to the end, or to `--max` entries (default 1000). `--include actors` adds who the end users and operators named are (end users need a token with `end-users:read`); the text output then prints an email or a name in place of an id. |
| `rekey billing preview --app <id> --country IN [--plan <slug\|id>] [--coupon CODE] [--country-source declared\|vouched\|hint] [--currency INR] [--provider name] [--end-user id] [--on-unavailable-currency fallback\|refuse]` | operator | Which price and provider a buyer in a country would get, and what a coupon would take off, decided by the functions checkout runs. Opens no checkout. |
| `rekey billing reporting-currency get --app <id>` / `set <CODE> --app <id>` | operator | Read or set the currency the stats lead with. Nothing is converted into it. |
| `rekey billing unavailable-currency get --app <id>` / `set fallback\|refuse --app <id>` | operator | Read or set what a checkout does when the server names a currency no provider can charge and the request does not say: charge the plan's default price, or refuse. |
| `rekey billing reconciliation --app <id> [--from ISO] [--to ISO]` | operator | Compare the billing log with payments, refunds and subscriptions. Last 7 days by default, at most 31. |
| `rekey billing price-fallbacks --app <id> [--from ISO] [--to ISO]` | operator | Count the checkouts that charged a default price because the buyer's currency could not be charged. |
| `rekey payments show <paymentId> --app <id>` | operator | One payment: amount, refunded total, provider, and whether it can be refunded through Rekey, with the reason when it cannot. |
| `rekey refunds list <paymentId> --app <id>` | operator | The refunds of a payment, oldest first. |
| `rekey refunds create <paymentId> --app <id> [--amount n] [--reason "..."] [--idempotency-key k]` | operator | Refund a payment at its provider. Without `--amount`, everything not yet refunded. |
| `rekey lists ls` / `rekey lists export <key> [--format csv\|jsonl] [--status subscribed\|unsubscribed\|all] [--out <file>]` | secret | Read an Application's lists and their members. `export` needs a key minted with `contacts:read`. |
| `rekey analytics users --app <id> [--range 30d] [--sections kpis,activity]` | operator | The Users overview of one Application. |

#### What `rekey doctor` checks

Each check is `ok`, `warn`, `fail` or `skipped`, with a `message` and a `fix`. `skipped` means the check did not run, usually because a credential is not set; it is not a pass. With `REKEY_OPERATOR_TOKEN` the money checks run on every Application the token can see, or on `--app <id>` only.

| Check | Trips when | Status |
|---|---|---|
| `plan-currencies` | an active plan has a price in a currency that cannot be sold, or at an amount the currency cannot be priced at | `fail` |
| `provider-currencies` | a provider stores a currency it cannot charge, or an enabled provider has no currency and so is used for no checkout | `fail` for the first, `warn` for the second |
| `price-providers` | no enabled provider can charge a live price | `fail` for a default price, `warn` for an additional one |
| `coupon-coverage` | an active coupon covers none of the currencies its plans are priced in | `fail` |
| `unapplied-payments` | there are open unapplied payments | `warn` |
| `unpriced-subscriptions` | a live subscription on a plan that has a price records no price of its own (`unpricedLiveSubscriptions` of the billing stats is above 0) | `warn` |
| `reconciliation` | the billing log and the records disagree over the last 7 days | `fail` |
| `billing-outbox` | billing events keep failing to reach the log. Needs `SUPER_ADMIN_KEY`; `skipped` without it | `fail` |

#### `plans create` is subscription-only

The super-admin route behind it implements SUBSCRIPTION plans and nothing else. This command used to carry `--kind`, `--license-kind`, `--meter-slug`, `--credits-amount` and friends; the route discarded them and answered 201, so `--kind LICENSE` reported success and created a subscription. Those flags are refused now, and the route rejects an unknown key instead of dropping it.

Create LICENSE, USAGE and CREDIT plans in the panel, or with `POST /api/v1/tenant/applications/:id/plans` and an operator token, which implements every kind (and `trialDays`).

### Planned (not yet implemented)

These are on the roadmap but **not shipped** — don't script against them yet:

- `rekey api-keys list/create/revoke` — key lifecycle (today: panel, admin API, or the [MCP server's](https://www.npmjs.com/package/@rekey.dev/mcp) `mint_api_key`).
- `rekey tunnel-webhooks` — the `stripe listen` equivalent for local webhook development.

See [AGENTS.md](../../AGENTS.md) for the full agent-facing contract.

---

## About Rekey

Rekey is a self-hostable **auth + billing backend for SaaS** — one API for sign-in, subscriptions, usage, credits, licenses, and teams.

- Website + docs: **[rekey.dev](https://rekey.dev)** · [rekey.dev/docs](https://rekey.dev/docs)
- SDKs: [`@rekey.dev/node`](https://www.npmjs.com/package/@rekey.dev/node) (server) · [`@rekey.dev/react`](https://www.npmjs.com/package/@rekey.dev/react) (browser) · [`@rekey.dev/nextjs`](https://www.npmjs.com/package/@rekey.dev/nextjs) · [`@rekey.dev/mcp`](https://www.npmjs.com/package/@rekey.dev/mcp) (MCP server)
