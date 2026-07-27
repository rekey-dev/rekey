# rekey-demo

Reference Next.js 15 app demonstrating end-to-end auth via [`@rekey.dev/node`](../../packages/sdk-node).

> **Not** a published package — it consumes `@rekey.dev/node` as a `workspace:*` dependency, so it tracks whatever is built locally in this monorepo.

## What it demonstrates

- **Sign-up** (`/sign-up`) — email + password, server action calls `rekey.auth.signUp`, stores access + refresh tokens in httpOnly cookies, redirects to `/dashboard`.
- **Sign-in** (`/sign-in`) — server action calls `rekey.auth.signIn`. Surface `INVALID_CREDENTIALS` → friendly message.
- **Dashboard** (`/dashboard`) — protected. Resolves the current user via `rekey.auth.getCurrentUser(accessToken)` with **auto-refresh on expiry** (see `src/lib/session.ts`).
- **Change password** (`/change-password`) — authenticated; revokes other sessions on success.
- **Forgot password** (`/forgot-password`) — calls `rekey.auth.requestPasswordReset`. Rekey returns the reset token — **the calling app must email it**. The demo prints the link to the dev console + carries it via querystring (so you can click through without an email setup); a real app would hand the token to SendGrid / Resend / SES.
- **Reset password** (`/reset-password?token=…`) — single-use, kills all existing sessions on success.
- **Sign-out** — revokes the current refresh token, clears cookies.
- **Sign-out everywhere** — revokes every refresh token for the user.

## Cookie strategy

Two httpOnly cookies — `relipay_access` (15 min) and `relipay_refresh` (30 days). `requireUser()` in `src/lib/session.ts` is the single chokepoint: it tries the access token, and on `USER_TOKEN_INVALID` rotates via the refresh token before retrying. If even refresh fails, both cookies are cleared and the user lands on `/sign-in?reason=expired`.

## Run locally

Prerequisites:
- Rekey API running (postgres + API + panel)
- Copy `.env.example` → `.env.local` and set `RELIPAY_URL` (the API base) and
  `RELIPAY_SECRET` (an Application secret key, `rp_live_…` / `rp_test_…`)

```bash
cp .env.example .env.local   # then fill in RELIPAY_SECRET
pnpm install
pnpm dev
# → http://localhost:3032
```

## Files worth reading

- [`src/lib/relipay.ts`](src/lib/relipay.ts) — module-level SDK client + cookie helpers
- [`src/lib/session.ts`](src/lib/session.ts) — `requireUser()` with auto-refresh
- [`src/app/sign-up/page.tsx`](src/app/sign-up/page.tsx) — pattern for every auth form (server action → SDK call → cookie + redirect)
- [`src/app/dashboard/page.tsx`](src/app/dashboard/page.tsx) — protected page + sign-out + sign-out-everywhere

## What this demo deliberately doesn't show (yet)

- **Billing UI.** The SDK exposes `rekey.billing.getPlans/createCheckout/validateCoupon`, but a hosted-checkout flow against the stub provider would just open a placeholder URL. Real Stripe integration ships in Phase 3 of Rekey; the billing page lands then.
- **Client-side widgets.** Everything here is server-rendered. A `@rekey.dev/react` package with `<SignIn />` / `<UserButton />` ships in Phase 3.
- **Email delivery** for password reset. Rekey deliberately doesn't send email — your app calls SendGrid/Resend/SES with the returned token. The demo prints to console.
- **OAuth providers** (Google/GitHub). Server side is stubbed; flows ship later.
