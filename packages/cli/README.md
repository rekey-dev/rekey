# `@rekey.dev/cli`

> **ReliPay is now Rekey.** This package was previously published as the equivalent `@relipay/*` package, which is deprecated. Env vars renamed `RELIPAY_*` → `REKEY_*` (as of 2.0.0 the old names are no longer read — set `REKEY_*`). relipay.dev (the old domain) will redirect to rekey.dev after the domain migration.

`rekey` — command-line interface for **[Rekey](https://rekey.dev)** deployments. Designed for both human developers and AI agents.

> **What is Rekey?** An auth + billing backend for your SaaS: sign-in (password, magic-link, passkeys, OAuth, MFA), subscriptions, usage, credits, licenses, and teams — behind one API, multi-tenant, provider-agnostic. Docs: **[rekey.dev/docs](https://rekey.dev/docs)**. This CLI manages a deployment — tenants, applications, API keys — from your terminal or an agent.

> **For AI agents**: start at [AGENTS.md](./AGENTS.md).

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
rekey plans create --app <id> --slug pro_monthly --name Pro --amount 999
rekey plans list --app <id>
```

Add `--json` to any command for machine-readable output.

## Status

Phase 2.0 scaffold. Everything below in "Implemented" is real and wired to the API; everything under "Planned" **does not exist yet** — invoking it prints commander's unknown-command error.

### Implemented

All commands talk to the **admin surface** (`/api/v1/admin/*`) and need `REKEY_URL` + `SUPER_ADMIN_KEY` (except `version`).

| Command | What it does |
|---|---|
| `rekey version` | Print the CLI version. No env needed. `rekey --version` / `-V` print the same thing; the subcommand is the one that honours `--json`. |
| `rekey doctor` | Config + connectivity diagnosis (`/health` probe, env checks). Run this first. |
| `rekey init` | One-shot bootstrap: create tenant → application → first API key. The `rawKey` is printed once at `data.apiKey.rawKey`. |
| `rekey apps list \| get <id> \| create` | Application CRUD. |
| `rekey plans list \| create \| set-active` | Plan management (`--amount` is the smallest currency unit — integer). |

### Planned (not yet implemented)

These are on the roadmap but **not shipped** — don't script against them yet:

- `rekey coupons …` — coupon management (today: panel or admin API).
- `rekey api-keys list/create/revoke` — key lifecycle (today: panel, admin API, or the [MCP server's](https://www.npmjs.com/package/@rekey.dev/mcp) `mint_api_key`).
- `rekey tunnel-webhooks` — the `stripe listen` equivalent for local webhook development.

See [AGENTS.md](./AGENTS.md) for the full agent-facing contract.

---

## About Rekey

Rekey is a self-hostable **auth + billing backend for SaaS** — one API for sign-in, subscriptions, usage, credits, licenses, and teams.

- Website + docs: **[rekey.dev](https://rekey.dev)** · [rekey.dev/docs](https://rekey.dev/docs)
- SDKs: [`@rekey.dev/node`](https://www.npmjs.com/package/@rekey.dev/node) (server) · [`@rekey.dev/react`](https://www.npmjs.com/package/@rekey.dev/react) (browser) · [`@rekey.dev/nextjs`](https://www.npmjs.com/package/@rekey.dev/nextjs) · [`@rekey.dev/mcp`](https://www.npmjs.com/package/@rekey.dev/mcp) (MCP server)
