# `@relipay/cli`

`relipay` — command-line interface for **[ReliPay](https://relipay.dev)** deployments. Designed for both human developers and AI agents.

> **What is ReliPay?** An auth + billing backend for your SaaS: sign-in (password, magic-link, passkeys, OAuth, MFA), subscriptions, usage, credits, licenses, and teams — behind one API, multi-tenant, provider-agnostic. Docs: **[relipay.dev/docs](https://relipay.dev/docs)**. This CLI manages a deployment — tenants, applications, API keys — from your terminal or an agent.

> **For AI agents**: start at [AGENTS.md](./AGENTS.md).

## Install

```bash
pnpm add -g @relipay/cli
# or per-project
pnpm add -D @relipay/cli
```

## Use

```bash
export RELIPAY_URL=http://localhost:3030
export SUPER_ADMIN_KEY=$(openssl rand -hex 32)  # whatever you set on the deployment

relipay doctor

relipay init \
  --tenant-name "Acme" --owner-email ops@acme.com \
  --app-name "Acme Prod" --app-slug acme-prod

relipay apps list
relipay plans create --app <id> --slug pro_monthly --name Pro --amount 999
relipay plans list --app <id>
```

Add `--json` to any command for machine-readable output.

## Status

Phase 2.0 scaffold. Everything below in "Implemented" is real and wired to the API; everything under "Planned" **does not exist yet** — invoking it prints commander's unknown-command error.

### Implemented

All commands talk to the **admin surface** (`/api/v1/admin/*`) and need `RELIPAY_URL` + `SUPER_ADMIN_KEY` (except `version`).

| Command | What it does |
|---|---|
| `relipay version` | Print the CLI version. No env needed. |
| `relipay doctor` | Config + connectivity diagnosis (`/health` probe, env checks). Run this first. |
| `relipay init` | One-shot bootstrap: create tenant → application → first API key. The `rawKey` is printed once at `data.apiKey.rawKey`. |
| `relipay apps list \| get <id> \| create` | Application CRUD. |
| `relipay plans list \| create \| set-active` | Plan management (`--amount` is the smallest currency unit — integer). |

### Planned (not yet implemented)

These are on the roadmap but **not shipped** — don't script against them yet:

- `relipay coupons …` — coupon management (today: panel or admin API).
- `relipay api-keys list/create/revoke` — key lifecycle (today: panel, admin API, or the [MCP server's](../mcp) `mint_api_key`).
- `relipay tunnel-webhooks` — the `stripe listen` equivalent for local webhook development.

See [AGENTS.md](./AGENTS.md) for the full agent-facing contract.

---

## About ReliPay

ReliPay is a self-hostable **auth + billing backend for SaaS** — one API for sign-in, subscriptions, usage, credits, licenses, and teams.

- Website + docs: **[relipay.dev](https://relipay.dev)** · [relipay.dev/docs](https://relipay.dev/docs)
- SDKs: [`@relipay/node`](https://www.npmjs.com/package/@relipay/node) (server) · [`@relipay/react`](https://www.npmjs.com/package/@relipay/react) (browser) · [`@relipay/nextjs`](https://www.npmjs.com/package/@relipay/nextjs) · [`@relipay/mcp`](https://www.npmjs.com/package/@relipay/mcp) (MCP server)
