# `@rekey.dev/mcp`

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Rekey](https://rekey.dev). Lets Claude Desktop, Cursor, and Claude Code introspect a deployment, read and change an Application's billing, and mint API keys, without screenshots or copy-paste from the panel.

**This is the small server.** It has 23 tools: 9 reads against the deployment-wide admin API, 7 billing reads of one Application, and 7 write tools. The hosted operator MCP that every deployment runs at `/api/v1/tenant/mcp` is a different, larger server, including organizations, devices, plan entitlements, subscription cancel and billing provider config. This package does not reach that server and is not a client for it. If the hosted one is available to you, it is usually the one to connect.

> **For AI agents connected through this server:** see [AGENTS.md](./AGENTS.md) for what's safe to call and the write-tool safety model.

```bash
# Run on demand (no global install needed):
npx -y @rekey.dev/mcp
```

It's a stdio MCP server — you don't run it by hand. Wire it into your MCP client's config (below) and the client launches it.

> **The deployment-wide reads are self-host only (they need `SUPER_ADMIN_KEY`).**
> Those tools authenticate with the deployment-wide `SUPER_ADMIN_KEY`, which
> only whoever runs the deployment holds. On **Rekey Cloud** you have no such
> key: use the hosted operator MCP at
> `https://api.rekey.dev/api/v1/tenant/mcp` instead. It signs you in with your
> panel account over OAuth, scopes the agent to one workspace, and needs
> nothing installed. Setup: [rekey.dev/docs/mcp](https://rekey.dev/docs/mcp).
> (The billing tools and the write tools work with a `REKEY_OPERATOR_TOKEN`
> alone, on either.)

## Setup

The server reads three env vars (set them in your MCP client config, not your shell):

| Env var | Required | What it's for | Where to get it |
| --- | --- | --- | --- |
| `REKEY_URL` | yes | Base URL of the deployment, e.g. `https://api.rekey.dev`. | Your Rekey deployment |
| `SUPER_ADMIN_KEY` | for the **deployment-wide read** tools | Authenticates the global read/introspection tools. | Deployment admin |
| `REKEY_OPERATOR_TOKEN` | for the **billing** tools and every **write** tool | A scoped operator **personal-access-token** (`rp_op_…`). | Panel, operator API tokens (or `POST /api/v1/tenant/auth/api-tokens`), with the scopes the agent should have: `billing:read` for the billing reads, `billing:write` for the billing writes, `keys:mint` for `mint_api_key` |

`REKEY_URL` plus **at least one** credential is required. Set `SUPER_ADMIN_KEY` for the deployment-wide read tools, `REKEY_OPERATOR_TOKEN` for the billing and write tools, or both. With the operator token alone (no master key) the deployment-wide read tools fail closed with `READ_REQUIRES_ADMIN_KEY`; with the admin key alone the operator tools fail closed with `OPERATOR_TOKEN_MISSING`. The server exits with a clear stderr message if `REKEY_URL` or every credential is missing.

> No write tool uses the all-powerful `SUPER_ADMIN_KEY`. Each authenticates
> as a **scoped operator** via `REKEY_OPERATOR_TOKEN`, which must carry the
> scope the tool needs and belong to the workspace that owns the target
> Application: default-deny, so an agent cannot change production unless you
> explicitly grant it. To give an agent read-only billing access, mint the
> token with `billing:read` and nothing else.

## Quickstart

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), or the equivalent on your platform:

```json
{
  "mcpServers": {
    "rekey": {
      "command": "npx",
      "args": ["-y", "@rekey.dev/mcp"],
      "env": {
        "REKEY_URL": "https://api.rekey.dev",
        "SUPER_ADMIN_KEY": "your-admin-key",
        "REKEY_OPERATOR_TOKEN": "rp_op_…"
      }
    }
  }
}
```

Restart Claude Desktop. Tools appear as `mcp__rekey__list_applications`, etc.

### Cursor

Settings → MCP → Add Server. Same `command` / `args` / `env` shape.

### Claude Code

Run `claude mcp add` and follow the prompts, or commit a project-scoped
`.mcp.json` at the repo root (same shape as the Claude Desktop config above).
Omit `REKEY_OPERATOR_TOKEN` if you only need the deployment-wide read tools,
or omit `SUPER_ADMIN_KEY` if the agent only needs the billing and write tools.

## Tools

**Deployment-wide read tools** (authenticated with `SUPER_ADMIN_KEY`):

> Tools marked **paged** take `limit` (1–100, default 50) and `offset`, and return
> `{ items, page: { total, limit, offset, hasMore } }`. Read `page.hasMore` before
> concluding you have seen everything — a list that stops at 50 of 90 used to look
> identical to a complete one.

| Tool | What it does |
| --- | --- |
| `list_tenants` | Tenants in the deployment. Paged — `limit`/`offset`, result is `{items, page}`. |
| `list_applications` | Applications, optionally filtered by `tenantId`. Paged. |
| `get_application` | One Application by id (with authConfig + billingConfig — no secrets). |
| `list_plans` | Plans for an Application; `includeInactive` for deactivated ones. Each plan carries `prices` (every price it sells at, the default first, with `id`, `currency`, `amount`, `countries`, `isDefault`, `registration`), `defaultPriceId` and `isFree`. Paged. |
| `list_coupons` | Coupons for an Application; `includeInactive` for deactivated ones. A PERCENT coupon carries `basisPoints`, an AMOUNT coupon `amounts` (one per currency); `coveredCurrencies` is where it works, null for anywhere. Paged. |
| `list_api_keys` | Active API keys for an Application — metadata only; the hash is never returned. |
| `list_payments` | Recent payments (newest first), filterable by `applicationId` / `status` (`PENDING`/`SUCCEEDED`/`FAILED`/`REFUNDED`), exact-match `q` (payment id / provider payment id / end-user id), `sort` (`createdAt`/`amount`), `order`, `limit` (≤200). Each row's `amount` is an integer in minor units of its own `currency`. |
| `get_payment_stats_by_app` | Per-application payment health over the last 30 days: succeeded/failed/pending/refunded counts, success rate, and `volumeByCurrency`, one `{currency, volumeCents, payments}` entry per currency. There is no total across currencies. |
| `get_billing_outbox_status` | Billing events waiting to reach the billing log, across every Application: `pending`, `due`, `failing`, and the `stuck` rows with their last error. |

**Billing read tools of one Application** (authenticated with `REKEY_OPERATOR_TOKEN`, scope `billing:read`):

| Tool | What it does |
| --- | --- |
| `recent_billing_events` | The billing log of an Application, newest first. Args: `applicationId`, `type?` (array of event types), `tier?` (`PERMANENT`/`DIAGNOSTIC`), `endUserId?`, `subscriptionId?`, `paymentId?`, `currency?`, `from?`, `to?`, `limit?` (1-200), `cursor?`, `include?` (`["actors"]`). Returns `{items, nextCursor, actors}`; pass `nextCursor` back as `cursor`. Entries name people by id; with `include: ["actors"]`, `actors` carries the email of each end user and the name and email of each operator named, and is null otherwise. |
| `preview_checkout_routing` | Which price and provider a buyer in `country` would get, and why, decided by the functions checkout runs. Args: `applicationId`, `country`, `plan?`, `countrySource?`, `endUserId?`, `currency?`, `onUnavailableCurrency?`, `provider?`, `couponCode?`. With `couponCode` each item carries the coupon's `discount` or `refusal`. Without `onUnavailableCurrency` the Application's default applies, and the result's `onUnavailableCurrency` says which rule was applied. Opens no checkout. |
| `get_price_fallbacks` | How often a buyer was charged a default price because their currency could not be charged, grouped by plan, currency and country. Args: `applicationId`, `from?`, `to?` (last 7 days by default, at most 31). |
| `get_billing_reconciliation` | The billing log compared with payments, refunds and subscriptions. Args: `applicationId`, `from?`, `to?`. `counts` is all zero when they agree. |
| `get_payment` | One payment by id, with the `provider` that took it, whether it is `refundable` through Rekey and the `refundBlockedReason` when it is not. Args: `applicationId`, `paymentId`. |
| `list_refunds` | The refunds of one payment, oldest first. Args: `applicationId`, `paymentId`, `limit?`, `offset?`. Paged. |
| `get_reporting_currency` | The currency an Application reports in. Args: `applicationId`. |
| `get_billing_stats` | One Application's MRR, 30-day revenue, unverified payments and 12-month series, one entry per currency, never added together. Args: `applicationId`. |

**Write tools** (authenticated with the scoped `REKEY_OPERATOR_TOKEN`):

| Tool | What it does |
| --- | --- |
| `mint_api_key` | Mint a new secret key for an Application. Args: `applicationId`, `name`, `scopes?`. Scope `keys:mint`. The prefix follows the Application's environment (`PRODUCTION` gives `rp_live_…`, otherwise `rp_test_…`) and is not selectable. The raw key is returned **exactly once**: surface it immediately and warn it is unrecoverable. |
| `set_plan_price` | Add a price in another currency to a plan, or change one. Args: `applicationId`, `plan` (id or slug), `currency`, `amount?`, `countries?`. Scope `billing:write`. `amount` is required to add a price and can change only until a provider has registered it. |
| `archive_plan_price` | Stop selling a plan in one currency. Args: `applicationId`, `plan`, `currency`. Scope `billing:write`. The row is kept, archived, when a subscription, a payment or a credit grant names it, and deleted when nothing does. |
| `create_coupon` | Create a coupon. Args: `applicationId`, `code`, `discountType` (`PERCENT`/`AMOUNT`), `basisPoints?`, `amounts?` (`[{currency, amountOff}]`), `currencies?`, `planSlugs?`, `startsAt?`, `endsAt?`, `maxRedemptions?`, `maxRedemptionsPerUser?`. Scope `billing:write`. |
| `update_coupon` | Change a coupon. Args: `applicationId`, `code`, `active?`, `basisPoints?`, `amounts?`, `currencies?`, `planSlugs?`, `endsAt?`, `maxRedemptions?`, `maxRedemptionsPerUser?`. Scope `billing:write`. `amounts` replaces the whole set. `endsAt` and the two caps take a value or `null` to remove it; a cap below what is already redeemed is refused with `COUPON_LIMIT_BELOW_REDEEMED`. |
| `set_reporting_currency` | Set the currency an Application reports in. Args: `applicationId`, `reportingCurrency`. Scope `billing:write`. Converts nothing. |
| `create_refund` | Refund a payment at its provider, in full or in part. Args: `applicationId`, `paymentId`, `amount?`, `reason?`, `idempotencyKey?`. Scope `billing:write`. **Moves money**: confirm the payment and the amount with the user first. |

### Write-tool failure modes (default-deny)

| Condition | Error |
| --- | --- |
| No `REKEY_OPERATOR_TOKEN` configured | `OPERATOR_TOKEN_MISSING`. Never falls back to the admin key. |
| PAT lacks the scope the tool needs | `OPERATOR_SCOPE_INSUFFICIENT` (403) for `mint_api_key`; `SCOPE_INSUFFICIENT` (403) for the billing tools. |
| PAT bound to a different workspace than the Application | `APPLICATION_NOT_FOUND` (404): no cross-tenant oracle. |
| PAT revoked / expired | `OPERATOR_TOKEN_INVALID` or `TENANT_SESSION_INVALID` (401). |

## Errors

Every tool error is a JSON object — `error: { code, message, fix?, statusCode? }` — in the response content (with `isError: true`). Read `fix` first. Common codes: `TOOL_NOT_FOUND`, `TOOL_ARGS_INVALID`, `APPLICATION_NOT_FOUND`, `ADMIN_AUTH_INVALID`.

## Gotchas

- **Money is an integer in minor units of its currency** (cents for USD, whole yen for JPY). `1900` with `USD` is $19.00; `5000` with `JPY` is ¥5,000, not ¥50. Always read an amount with its currency, and never add amounts in different currencies: nothing is converted. A field named `…Cents` (`volumeCents`, `mrrCents`) is minor units of its own currency too.
- **Only call a write tool when the user explicitly asks** for that change. `create_refund` moves money: confirm the payment and the amount first. For a mutation this server has no tool for, use the read tools to work out what to do, then the `rekey` CLI or the Panel. A hosted deployment also runs a separate operator MCP server at `/api/v1/tenant/mcp` with a far larger tool set; this package does not reach it.
- **Coupon discounts**: PERCENT uses basis points (`1500` = 15%). AMOUNT carries one amount per currency, in that currency's minor units, and works only in those currencies. `update_coupon` with `amounts` replaces the whole set.
- **Stats are per currency.** `get_payment_stats_by_app` and `get_billing_stats` return one entry per currency and no scalar total.

## Links

- Docs: [/docs](https://rekey.dev/docs) · [SDK guide](https://rekey.dev/docs/sdk) · [API reference](https://rekey.dev/docs/api) · [agent prompt](https://rekey.dev/docs/prompt)

## License

MIT
