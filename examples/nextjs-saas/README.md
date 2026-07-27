# Rekey Next.js SaaS boilerplate

A complete, idiomatic **Next.js 15 (App Router) + TypeScript + Tailwind** SaaS
starter that demonstrates the Rekey SDK **end to end**:

- **Auth** — sign-up, sign-in, sign-out, magic links, password reset, and
  multi-session management (list / revoke / sign-out-everywhere).
- **Billing** — public plan catalog, hosted checkout, an entitlement-gated
  feature (scan analytics is Pro-only), prepaid credits (balance / buy / ledger)
  and the `?upgraded` / `?bought` return handling.
- **Organizations** — create, list, switch (storing the returned token pair),
  members and invites.
- **Usage** — monthly usage aggregate for the active subject.

It uses the three SDK layers the way they're meant to be used:

| Layer | Package | Where |
| --- | --- | --- |
| Browser auth state | `@rekey.dev/react` (`RelipayProvider`, `useUser`, `SignedIn/SignedOut`) | client components — **public key only** |
| Cookie session + auth actions | `@rekey.dev/nextjs/server` (`auth`, `signIn`, `signUp`, `signOut`) + `@rekey.dev/nextjs/middleware` | server |
| Everything else (billing, credits, usage, orgs, sessions) | `@rekey.dev/node` | server only — **secret key**, never shipped to the browser |

## Org-scoped billing

The deployed demo application (`qr`) is configured with
`organizationsEnabled = true` and `billingConfig.billingSubject = 'org'`, so an
individual cannot hold a subscription. The app reads this via
`rekey.applications.me()` and **drives the UI from it**: when `billingSubject`
is `'org'` the user must create or switch to a team before checkout. Without an
active team, checkout returns `BILLING_ORGANIZATION_REQUIRED` — surfaced in the
UI, and pre-empted by a gate on the dashboard / billing pages.

## Run it locally

1. Copy the env template and fill in your keys (the `.env.local` file is
   **gitignored** — never commit it; `RELIPAY_SECRET` is a live secret):

   ```bash
   cp .env.local.example .env.local
   # set RELIPAY_SECRET (rp_live_… / rp_test_…) and NEXT_PUBLIC_RELIPAY_PUBLIC_KEY
   ```

2. Install (from the monorepo root) and start the dev server:

   ```bash
   pnpm install
   pnpm --filter rekey-nextjs-saas dev
   ```

   The app runs at **http://localhost:3040**.

3. Typecheck / production build:

   ```bash
   pnpm --filter rekey-nextjs-saas typecheck
   pnpm --filter rekey-nextjs-saas build
   ```

## Pages

- `/` — marketing landing with live pricing (`billing.getPlans()`).
- `/login`, `/signup` — auth, plus a magic-link option.
- `/forgot-password`, `/reset-password` — password reset (the reset token is
  shown in-app when the application has no email transport).
- `/dashboard` — entitlement-gated overview (Pro-only analytics).
- `/billing` — plans, checkout, credits.
- `/team` — organizations: create / switch / members / invites.
- `/account` — sessions, sign-out-everywhere, MCP connect helper.

## Notes

- Secrets live only in `.env.local` (gitignored). The browser only ever holds
  the user's JWT, surfaced through the `RelipayProvider`.
- `productSlug`s and entitlement keys (`qr_scans`, `pro_monthly`,
  `qr_bulk_pack`, `analytics`, `max_qr_codes`) match what the `qr` application is
  provisioned with — see `examples/qr-saas` for the provisioning script.
- Email transport: when the application has email configured, magic-link and
  password-reset tokens are emailed (not returned in the API response). The demo
  surfaces the raw token only when no transport is configured.
