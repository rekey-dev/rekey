# Self-hosted customer portal (reference example)

This is the **single-Application, self-hosted** customer billing portal — the original Portal V1. It authenticates to the ReliPay API with **one Application's secret key** from the environment (`RELIPAY_SECRET_KEY`), so one deployment serves exactly one Application.

It's kept here as a **reference** for operators who want to run their own portal (custom hosting, full control, willing to wire a secret key per app).

> **Most operators don't need this.** ReliPay now ships a **hosted, multi-app portal** (`apps/portal`) that any Application can turn on from **Panel → Application → Billing → Portal** — no deploy, no secret key. It's served at `portal.relipay.dev/<slug>`. See [docs/portal.md](../../docs/portal.md).

## When to use this example instead of the hosted portal

- You want the portal on your own domain/infra today (before the hosted custom-domain tier ships).
- You want to fork and heavily customize the UI.
- You're fine deploying + wiring `RELIPAY_SECRET_KEY` per Application.

## Run

```bash
cp .env.example .env.local   # set RELIPAY_URL + RELIPAY_SECRET_KEY
pnpm --filter relipay-portal-selfhost-example dev   # http://localhost:3050
```

Architecture (server actions + `@relipay/nextjs/server` + httpOnly cookies) mirrors `examples/nextjs-saas`.
