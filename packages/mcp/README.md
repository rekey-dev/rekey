# `@rekey.dev/mcp`

> **ReliPay is now Rekey.** This package was previously published as the equivalent `@relipay/*` package, which is deprecated. Env vars renamed `RELIPAY_*` → `REKEY_*` (as of 2.0.0 the old names are no longer read — set `REKEY_*`). relipay.dev (the old domain) will redirect to rekey.dev after the domain migration.

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Rekey](https://rekey.dev). Lets Claude Desktop, Cursor, and Claude Code introspect a deployment — and mint API keys — directly, without screenshots or copy-paste from the panel.

> **For AI agents connected through this server:** see [AGENTS.md](../../AGENTS.md) for what's safe to call and the write-tool safety model.

```bash
# Run on demand (no global install needed):
npx -y @rekey.dev/mcp
```

It's a stdio MCP server — you don't run it by hand. Wire it into your MCP client's config (below) and the client launches it.

## Setup

The server reads three env vars (set them in your MCP client config, not your shell):

| Env var | Required | What it's for | Where to get it |
| --- | --- | --- | --- |
| `REKEY_URL` | yes | Base URL of the deployment, e.g. `https://api.rekey.dev`. | Your Rekey deployment |
| `SUPER_ADMIN_KEY` | for **read** tools | Authenticates the global read/introspection tools. | Deployment admin |
| `REKEY_OPERATOR_TOKEN` | for `mint_api_key` | A scoped operator **personal-access-token** (`rp_op_…`). | Panel → operator API tokens (or `POST /api/v1/tenant/auth/api-tokens`), scoped to `keys:mint` |

`REKEY_URL` plus **at least one** credential is required. Set `SUPER_ADMIN_KEY` for the read tools, `REKEY_OPERATOR_TOKEN` for the `keys:mint` write tool, or both. An agent that should only mint keys can run with the operator token alone (no master key) — the read tools then fail closed with `READ_REQUIRES_ADMIN_KEY`. The server exits with a clear stderr message if `REKEY_URL` or every credential is missing.

> The `mint_api_key` write tool does **not** use the all-powerful
> `SUPER_ADMIN_KEY`. It authenticates as a **scoped operator** via
> `REKEY_OPERATOR_TOKEN`, which must carry the `keys:mint` scope and belong to
> the workspace that owns the target Application — default-deny, so an agent
> can't mutate production unless you explicitly grant it.

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
Omit `REKEY_OPERATOR_TOKEN` if you only need read tools, or omit
`SUPER_ADMIN_KEY` if the agent only needs the `mint_api_key` write tool.

## Tools

**Read tools** (authenticated with `SUPER_ADMIN_KEY`):

> Tools marked **paged** take `limit` (1–100, default 50) and `offset`, and return
> `{ items, page: { total, limit, offset, hasMore } }`. Read `page.hasMore` before
> concluding you have seen everything — a list that stops at 50 of 90 used to look
> identical to a complete one.

| Tool | What it does |
| --- | --- |
| `list_tenants` | Tenants in the deployment. Paged — `limit`/`offset`, result is `{items, page}`. |
| `list_applications` | Applications, optionally filtered by `tenantId`. Paged. |
| `get_application` | One Application by id (with authConfig + billingConfig — no secrets). |
| `list_plans` | Plans for an Application; `includeInactive` for archived ones. Paged. |
| `list_coupons` | Coupons for an Application; `includeInactive` for deactivated ones. Paged. |
| `list_api_keys` | Active API keys for an Application — metadata only; the hash is never returned. |
| `list_payments` | Recent payments (newest first), filterable by `applicationId` / `status` (`PENDING`/`SUCCEEDED`/`FAILED`/`REFUNDED`), exact-match `q` (payment id / provider payment id / end-user id), `sort` (`createdAt`/`amount`), `order`, `limit` (≤200). Amounts are integers in the smallest currency unit. |
| `get_payment_stats_by_app` | Per-application payment health over the last 30 days — succeeded/failed/pending/refunded counts, success rate, SUCCEEDED volume (`volumeCents`). The panel's richer per-app Billing Overview (`MRR`, 12-month series) lives at the **panel-session-only** endpoint `/api/v1/tenant/applications/:id/billing/stats` and is not reachable with this server's credentials. |

**Write tools** (authenticated with the scoped `REKEY_OPERATOR_TOKEN`):

| Tool | What it does |
| --- | --- |
| `mint_api_key` | Mint a new secret key for an Application. Args: `applicationId`, `name`, `scopes?`. The prefix follows the Application's environment (`PRODUCTION` → `rp_live_…`, otherwise `rp_test_…`) and is not selectable. The raw key is returned **exactly once** — surface it immediately and warn it's unrecoverable. |

### `mint_api_key` failure modes (default-deny)

| Condition | Error |
| --- | --- |
| No `REKEY_OPERATOR_TOKEN` configured | `OPERATOR_TOKEN_MISSING` — never falls back to the admin key. |
| PAT lacks the `keys:mint` scope | `OPERATOR_SCOPE_INSUFFICIENT` (403). |
| PAT bound to a different workspace than the Application | `APPLICATION_NOT_FOUND` (404) — no cross-tenant oracle. |
| PAT revoked / expired | `OPERATOR_TOKEN_INVALID` (401). |

## Errors

Every tool error is a JSON object — `error: { code, message, fix?, statusCode? }` — in the response content (with `isError: true`). Read `fix` first. Common codes: `TOOL_NOT_FOUND`, `TOOL_ARGS_INVALID`, `APPLICATION_NOT_FOUND`, `ADMIN_AUTH_INVALID`.

## Gotchas

- **Money is integers in the smallest currency unit** (cents/paise/sen). Render `999 USD/MONTH` as `$9.99/month` — never assume a `.00` decimal (`¥100` is a hundred whole yen).
- **Only call `mint_api_key` when the user explicitly asks** to create/mint a key. For other mutations (create plan, refund, deactivate coupon — not yet exposed), use the read tools to figure out what to do, then the `rekey` CLI or the Panel.
- **Coupon discounts**: PERCENT uses basis points (`1500` = 15%); AMOUNT uses the smallest currency unit.

## Links

- Docs: [/docs](https://rekey.dev/docs) · [SDK guide](https://rekey.dev/docs/sdk) · [API reference](https://rekey.dev/docs/api) · [agent prompt](https://rekey.dev/docs/prompt)

## License

MIT
