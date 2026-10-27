# AGENTS.md — `@rekey.dev/mcp`

You are an AI agent connected to Rekey via this MCP server. This file tells you what's safe to do and what's deliberately not exposed.

**The deployment-wide reads are self-host only (they need `SUPER_ADMIN_KEY`).** Those tools call the deployment-wide admin API. The billing tools and the write tools need `REKEY_OPERATOR_TOKEN` instead and work anywhere. A Rekey Cloud user has no `SUPER_ADMIN_KEY`; for them the right server is the hosted operator MCP at `https://api.rekey.dev/api/v1/tenant/mcp` (OAuth sign-in with their panel account, scoped to one workspace). See [rekey.dev/docs/mcp](https://rekey.dev/docs/mcp).

## What this server is

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets you introspect a Rekey deployment over stdio. It is the small server: 23 tools (9 deployment-wide reads with the admin key, 7 billing reads of one Application and 7 writes with the operator token). The hosted operator MCP at `/api/v1/tenant/mcp` is a separate, larger server, and nothing here reaches it. If the user wants something this server cannot do (devices, entitlements, cancelling a subscription, provider config), say so and point them at the hosted one rather than improvising. Wired into Claude Desktop / Cursor / Claude Code via:

```json
{
  "mcpServers": {
    "rekey": {
      "command": "npx",
      "args": ["-y", "@rekey.dev/mcp"],
      "env": {
        "REKEY_URL": "https://rekey.example.com",
        "SUPER_ADMIN_KEY": "...",
        "REKEY_OPERATOR_TOKEN": "rp_op_..."
      }
    }
  }
}
```

The server reads `REKEY_URL` plus at least one credential from its env: `SUPER_ADMIN_KEY` for the deployment-wide read tools, `REKEY_OPERATOR_TOKEN` for the billing tools and the write tools, or both. It exits with a clear stderr message when `REKEY_URL` or every credential is missing. Running with the operator token alone is a supported setup; the deployment-wide read tools then fail closed with `READ_REQUIRES_ADMIN_KEY`.

`REKEY_OPERATOR_TOKEN` is an operator personal-access-token (`rp_op_…`), minted in the Panel (or via `POST /api/v1/tenant/auth/api-tokens`), scoped to a single workspace and a set of permissions. The billing reads need `read`, the billing writes `applications:write`, and `mint_api_key` needs `keys:mint`; without the scope the server rejects the call (default-deny). The deployment-wide read tools never use this token.

## Tools

Deployment-wide read tools (authenticated with `SUPER_ADMIN_KEY`):

Paged tools take `limit` (1-100, default 50) and `offset`, and return
`{ items, page: { total, limit, offset, hasMore } }`. Always check `page.hasMore`
before telling the user you listed everything.

| Tool | What it does |
|---|---|
| `list_tenants` | Tenants in the deployment. Paged |
| `list_applications` | Applications, optionally filtered by `tenantId`. Paged |
| `get_application` | One Application by id (with authConfig + billingConfig, no secrets) |
| `list_plans` | Plans for an Application, each with `prices` (default first), `defaultPriceId` and `isFree`; `includeInactive` for deactivated ones. Paged |
| `list_coupons` | Coupons for an Application: `basisPoints` or per-currency `amounts`, and `coveredCurrencies`; `includeInactive` for deactivated ones. Paged |
| `list_api_keys` | Active API keys for an Application: metadata only, hash never returned |
| `list_payments` | Recent payments, filterable by `applicationId`/`status`/`q`, sortable by `createdAt`/`amount`, `limit` ≤ 200. Each `amount` is in minor units of the row's own `currency` |
| `get_payment_stats_by_app` | 30-day per-application payment health: succeeded/failed/pending/refunded counts, success rate, `volumeByCurrency` (one entry per currency, no total) |
| `get_billing_outbox_status` | Billing events waiting to reach the billing log: `pending`, `due`, `failing`, and the `stuck` rows |

Billing read tools of one Application (authenticated with `REKEY_OPERATOR_TOKEN`, scope `read`):

| Tool | What it does |
| --- | --- |
| `recent_billing_events` | The billing log of an Application, newest first. Args: `applicationId`, `type?` (array of event types), `tier?` (`PERMANENT`/`DIAGNOSTIC`), `endUserId?`, `subscriptionId?`, `paymentId?`, `currency?`, `from?`, `to?`, `limit?` (1-200), `cursor?`. Returns `{items, nextCursor}`; pass `nextCursor` back as `cursor`. |
| `preview_checkout_routing` | Which price and provider a buyer in `country` would get, and why, decided by the functions checkout runs. Args: `applicationId`, `country`, `plan?`, `countrySource?`, `endUserId?`, `currency?`, `onUnavailableCurrency?`, `provider?`, `couponCode?`. With `couponCode` each item carries the coupon's `discount` or `refusal`. Without `onUnavailableCurrency` the Application's default applies, and the result's `onUnavailableCurrency` says which rule was applied. Opens no checkout. |
| `get_price_fallbacks` | How often a buyer was charged a default price because their currency could not be charged, grouped by plan, currency and country. Args: `applicationId`, `from?`, `to?` (last 7 days by default, at most 31). |
| `get_billing_reconciliation` | The billing log compared with payments, refunds and subscriptions. Args: `applicationId`, `from?`, `to?`. `counts` is all zero when they agree. |
| `list_refunds` | The refunds of one payment, oldest first. Args: `applicationId`, `paymentId`, `limit?`, `offset?`. Paged. |
| `get_reporting_currency` | The currency an Application reports in. Args: `applicationId`. |
| `get_billing_stats` | One Application's MRR, 30-day revenue, unverified payments and 12-month series, one entry per currency, never added together. Args: `applicationId`. |

Write tools (authenticated with the scoped `REKEY_OPERATOR_TOKEN`):

| Tool | What it does |
| --- | --- |
| `mint_api_key` | Mint a new secret key for an Application. Args: `applicationId`, `name`, `scopes?`. Scope `keys:mint`. The prefix follows the Application's environment (`PRODUCTION` gives `rp_live_…`, otherwise `rp_test_…`) and is not selectable. The raw key is returned **exactly once**: surface it immediately and warn it is unrecoverable. |
| `set_plan_price` | Add a price in another currency to a plan, or change one. Args: `applicationId`, `plan` (id or slug), `currency`, `amount?`, `countries?`. Scope `applications:write`. `amount` is required to add a price and can change only until a provider has registered it. |
| `archive_plan_price` | Stop selling a plan in one currency. Args: `applicationId`, `plan`, `currency`. Scope `applications:write`. The row is kept, archived, when a subscription, a payment or a credit grant names it, and deleted when nothing does. |
| `create_coupon` | Create a coupon. Args: `applicationId`, `code`, `discountType` (`PERCENT`/`AMOUNT`), `basisPoints?`, `amounts?` (`[{currency, amountOff}]`), `currencies?`, `planSlugs?`, `startsAt?`, `endsAt?`, `maxRedemptions?`, `maxRedemptionsPerUser?`. Scope `applications:write`. |
| `update_coupon` | Change a coupon. Args: `applicationId`, `code`, `active?`, `basisPoints?`, `amounts?`, `currencies?`, `planSlugs?`. Scope `applications:write`. `amounts` replaces the whole set. |
| `set_reporting_currency` | Set the currency an Application reports in. Args: `applicationId`, `reportingCurrency`. Scope `applications:write`. Converts nothing. |

## Write-tool safety model

No write tool uses the all-powerful `SUPER_ADMIN_KEY`. Each authenticates as a **scoped operator** via `REKEY_OPERATOR_TOKEN`, a revocable `rp_op_…` personal-access-token bound to one workspace and a set of scopes. This is default-deny:

- No `REKEY_OPERATOR_TOKEN` configured: every write tool fails with `OPERATOR_TOKEN_MISSING`. None falls back to the admin key.
- PAT lacks the scope the tool needs: the server rejects with 403 (`OPERATOR_SCOPE_INSUFFICIENT` for `mint_api_key`, `SCOPE_INSUFFICIENT` for the billing tools).
- PAT bound to a different workspace than the Application's: `APPLICATION_NOT_FOUND` (404), same as a non-existent app (no cross-tenant oracle).
- PAT revoked or expired: 401, effective immediately.

Call a write tool only when the user **explicitly** asks for that change, and say what you are about to change before you do. There is no refund tool: a refund needs an operator session, so the user issues it in the Panel. A hosted deployment also runs an operator MCP server at `/api/v1/tenant/mcp` with a much larger tool set, including plan creation and subscription changes; that is a different server with its own OAuth and switches, not something this package reaches. For a mutation this server has no tool for:

1. Help them figure out what to do via the read-only tools.
2. Tell them to run the operation via `rekey <command>` (the CLI) or the Panel.
3. Never suggest they manually craft API calls if a CLI command exists for it.

## Errors

Every tool error is a JSON object with `error: { code, message, fix?, statusCode? }` in the response content (with `isError: true`). The `fix` field is the most useful — read it first, surface it to the user.

Notable codes:

- `TOOL_NOT_FOUND` — name doesn't match the registry. Call `list_tools`.
- `TOOL_ARGS_INVALID` — your input failed Zod validation. Check `inputSchema`.
- `APPLICATION_NOT_FOUND`, `TENANT_NOT_FOUND` — ids don't exist; list first.
- `ADMIN_AUTH_INVALID` — `SUPER_ADMIN_KEY` env is wrong. Tell the user to check their MCP config.

## Money rule

`amount` fields throughout Rekey are **integers in minor units of their currency** (cents for USD, whole yen for JPY). If you render `999 USD/MONTH`, format it as `$9.99/month`. Never assume two decimals: `100` is `$1.00` in USD but `¥100` (a hundred whole yen) in JPY. Read every amount with its `currency`, and never add amounts in different currencies: Rekey converts nothing, and every stats tool returns one entry per currency. A field named `…Cents` is minor units of its own currency too. Where a response carries `formatted`, show that.

## What NOT to do

- Don't combine multiple read calls into a single response without telling the user what you ran. Be explicit ("ran list_applications, then list_plans for app_xyz").
- Don't suggest mutating operations as inline `curl` commands. The CLI exists.
- Don't leak `metadata` content as commentary — it may contain operator-private notes.
- Don't try to enumerate other Tenants when the user asks about "their" data. Restrict to the Tenant they identified themselves with.
