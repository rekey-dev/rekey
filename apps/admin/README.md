# `@rekey.dev/admin` — super-admin dashboard (local-only)

Read-only super-admin UI for a Rekey deployment: tenants, applications,
end-users, orgs, subscriptions, payments, MRR, webhook health, services,
audit log, request log.

**This app is deliberately not deployed.** It runs locally against whichever
API you point it at (decision logged in `decisions.md`, 2026-07-28 — a
super-admin surface on the public internet is attack surface with no
day-to-day benefit).

## Run locally

```bash
REKEY_URL=https://api.rekey.dev SUPER_ADMIN_KEY=<your key> \
  pnpm --filter @rekey.dev/admin dev
```

Then open http://localhost:3034 and paste the same `SUPER_ADMIN_KEY` on the
login form. Sessions are in-memory (a restart signs you out) and the session
cookie is `Secure` when `NODE_ENV=production` — over plain-HTTP localhost,
run a dev build. See DEPLOY.md → "Super-admin dashboard" for the full quirks.
