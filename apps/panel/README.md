# `@rekey.dev/panel`

Next.js 15 admin panel for Rekey deployments.

> **For AI agents**: see [AGENTS.md](./AGENTS.md).

## Run

```bash
RELIPAY_URL=http://localhost:3030 pnpm --filter @rekey.dev/panel dev
# → http://localhost:3031
```

Sign in with the deployment's `SUPER_ADMIN_KEY` (httpOnly cookie, never exposed to client JS).

## Build

```bash
pnpm --filter @rekey.dev/panel build
pnpm --filter @rekey.dev/panel start
```

## Required env

- `RELIPAY_URL` — base URL of the Rekey API

## Routes

- `/login` — paste admin key
- `/applications` — list (default landing)
- `/applications/[id]/{plans,coupons,api-keys}` — per-app inspection
- `/tenants` — tenant list

Mutations are intentionally not in v1 — operators create resources via `rekey <command>` (the CLI) or the admin API directly.
