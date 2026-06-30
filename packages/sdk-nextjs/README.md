# `@relipay/nextjs`

[ReliPay](https://relipay.dev) helpers for the **Next.js App Router** (14/15): route-gating middleware, server-side `auth()` / `signIn()` / `signUp()` / `signOut()`, and an httpOnly cookie session — built on top of [`@relipay/node`](../sdk-node).

> **For AI coding agents:** start at [AGENTS.md](./AGENTS.md).

```bash
npm i @relipay/nextjs
# or: pnpm add @relipay/nextjs / yarn add @relipay/nextjs
```

## Setup

Two credentials, two homes. The **secret key** powers the server (`auth()`, API routes); the **publishable key** powers browser login/register — it's public by design and safe to ship in client JS.

```bash
# Server-only (never NEXT_PUBLIC_):
RELIPAY_URL=https://api.relipay.dev
RELIPAY_SECRET=rp_live_…              # Application secret key (Panel → Application → API Keys)

# Browser-safe (exposed to client bundle):
NEXT_PUBLIC_RELIPAY_URL=https://api.relipay.dev
NEXT_PUBLIC_RELIPAY_PUBLIC_KEY=rp_pub_…   # Application publishable key
```

> **Never ship the secret key to the browser.** `@relipay/nextjs/server` pulls
> Node-only deps and reads `RELIPAY_SECRET`; importing it from a Client
> Component or middleware will fail to bundle (that's the safety net working).
> Browser code uses the **publishable** key via `@relipay/nextjs/client`.

### Three entrypoints

| Import | Runtime | Credential | Use case |
| --- | --- | --- | --- |
| `@relipay/nextjs/middleware` | **Edge** | none (cookie presence) | Gate routes in `middleware.ts` (cheap, no network). |
| `@relipay/nextjs/server` | **Node** | secret key | `auth()`, `signIn()`, `signUp()`, `createSession()` + your `@relipay/node` API calls. |
| `@relipay/nextjs/client` | **Browser** | publishable key | `relipayBrowser()` — sign-in/up, magic-link, passkey, license verify, plans from a Client Component, no backend round-trip. |

The split keeps the Edge bundle small and the secret key out of the browser — the `/client` module only imports the publishable-key browser client.

### Which login path?

Both are valid; pick per app:

- **Server-action login** (secret key, `/server`) — the browser never holds any Application key; tokens go straight into httpOnly cookies. Best default when you have a server. See [Quickstart](#quickstart) step 3.
- **Browser login** (publishable key, `/client`) — sign users in directly from a Client Component, then hand the tokens to a route handler that calls `createSession()` to set the same httpOnly cookies. Best for client-component-driven flows. See [Publishable login → secret-key API routes](#publishable-login--secret-key-api-routes).

## Quickstart

**1. Gate routes — `middleware.ts`:**

```ts
import { relipayMiddleware } from '@relipay/nextjs/middleware';

export default relipayMiddleware({
  signInUrl: '/login',
  publicRoutes: ['/', '/login', '/signup', '/forgot-password', '/api/auth'],
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
```

**2. Read the session — any server component:**

```tsx
import { auth } from '@relipay/nextjs/server';

export default async function Dashboard() {
  const session = await auth(); // { user, accessToken } | null
  if (!session) return null;    // middleware already redirected; defensive
  return <p>Hi {session.user.email}</p>;
}
```

**3. Sign in — a server action:**

```ts
'use server';
import { redirect } from 'next/navigation';
import { signIn } from '@relipay/nextjs/server';

export async function signInAction(fd: FormData) {
  const outcome = await signIn({
    email: String(fd.get('email')),
    password: String(fd.get('password')),
  });
  if (outcome.kind === 'mfa_required') redirect('/login?error=MFA_REQUIRED');
  redirect('/dashboard');
}
```

For everything `@relipay/nextjs` doesn't cover (billing, credits, usage, orgs, password reset, sessions), construct a [`@relipay/node`](../sdk-node) client in a server-only module and call it from server actions / route handlers — passing `session.accessToken` for per-user reads.

## Publishable login → secret-key API routes

The browser logs the user in with the **publishable** key; the resulting tokens are handed to a route handler that sets the httpOnly session cookies; everything server-side (`auth()`, your API routes) keeps using the **secret** key. No `'use server'` action needed for login.

**1. Client Component — register / sign in with the publishable key:**

```tsx
'use client';
import { relipayBrowser } from '@relipay/nextjs/client';
import { useRouter } from 'next/navigation';

export function LoginForm() {
  const router = useRouter();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    // signUp for register; signIn for login — both publishable-key authorized.
    const out = await relipayBrowser().signIn({
      email: String(fd.get('email')),
      password: String(fd.get('password')),
    });
    if (out.mfaRequired) {
      router.push(`/login/mfa?token=${out.mfaChallengeToken}`);
      return;
    }
    // Hand tokens to the server to set httpOnly cookies.
    await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: out.accessToken, refreshToken: out.refreshToken }),
    });
    router.push('/dashboard');
  }
  return (
    <form onSubmit={onSubmit}>
      <input name="email" type="email" required />
      <input name="password" type="password" required />
      <button type="submit">Sign in</button>
    </form>
  );
}
```

**2. Route handler — finalize the session into httpOnly cookies:**

```ts
// app/api/auth/session/route.ts
import { createSession } from '@relipay/nextjs/server';

export async function POST(req: Request) {
  const { accessToken, refreshToken } = await req.json();
  // Add your CSRF/origin check here — this sets cookies verbatim.
  await createSession({ accessToken, refreshToken });
  return Response.json({ ok: true });
}
```

**3. Secret-key API route — per-user data, server-side:**

```ts
// app/api/credits/route.ts
import { auth } from '@relipay/nextjs/server';
import { ReliPay } from '@relipay/node';

const relipay = new ReliPay({
  apiUrl: process.env.RELIPAY_URL!,
  secretKey: process.env.RELIPAY_SECRET!,   // secret key — server-only
});

export async function GET() {
  const session = await auth();             // from the httpOnly cookies
  if (!session) return new Response('Unauthorized', { status: 401 });
  const balance = await relipay.credits.getBalance({ endUserId: session.user.id });
  return Response.json(balance);
}
```

After this, `middleware.ts` and `auth()` work identically to the server-action path — the only difference is *where the login call ran* (browser vs server). Plans + license verification can also run straight from the browser: `relipayBrowser().getPlans()`, `relipayBrowser().verifyLicense({ key, machineFingerprint })`.

## Core API

### `@relipay/nextjs/middleware`
| Export | Description |
| --- | --- |
| `relipayMiddleware({ publicRoutes?, signInUrl? })` | Middleware that lets `publicRoutes` through and redirects unauthenticated requests to `signInUrl?next=…`. Gates on cookie *presence*; validity is checked deeper via `auth()`. |
| `MiddlewareConfig` | Type for the config object. |

### `@relipay/nextjs/server`
| Export | Description |
| --- | --- |
| `auth()` | Resolve the session from cookies. Tries the access token, refreshes-and-rotates once on expiry, returns `null` only when both fail. |
| `signIn({ email, password })` | Returns `{ kind: 'session' }` (cookies set) or `{ kind: 'mfa_required', mfaChallengeToken }` (**no cookies** — collect a code and complete via `mfaVerify`). |
| `mfaVerify({ mfaChallengeToken, code })` | Complete an MFA-required sign-in; sets cookies on success. |
| `signUp({ email, password, metadata? })` | Create the user + start a session (always sets cookies). |
| `createSession({ accessToken, refreshToken })` | Set the httpOnly session cookies from tokens a **browser** login produced. Use in a route handler to finalize a `@relipay/nextjs/client` sign-in. |
| `signOut(redirectTo?)` | Revoke the refresh token + clear cookies; optionally redirect. |
| `Session` / `SignInOutcome` | Session + sign-in result types. |

### `@relipay/nextjs/client` (browser — publishable key)
| Export | Description |
| --- | --- |
| `relipayBrowser({ apiUrl?, publishableKey? })` | Browser client configured from `NEXT_PUBLIC_RELIPAY_URL` + `NEXT_PUBLIC_RELIPAY_PUBLIC_KEY` (or overrides). Methods: `signIn`, `signUp`, `mfaVerify`, `requestMagicLink`, `verifyMagicLink`, `startPasskeyAuthentication`, `verifyPasskeyAuthentication`, `getPlans`, `verifyLicense`. |
| `RelipayBrowserClient` | The underlying class, re-exported from `@relipay/react`. |

### `@relipay/nextjs` (root)
| Export | Description |
| --- | --- |
| `mcpConnectionInfo({ apiUrl, appSlug })` | Build the MCP URL + `claude mcp add` command to render a "Connect to Claude" button (pure string-building). |
| `ACCESS_COOKIE` / `REFRESH_COOKIE` / `ACCESS_COOKIE_OPTS` / `REFRESH_COOKIE_OPTS` | Cookie names + options, for actions that need to write the token pair directly (e.g. after `organizations.switch`). |

## Cookie model

Two httpOnly cookies, set by `signIn` / `signUp`:

- `relipay_access` — 15 min (matches access-token lifetime).
- `relipay_refresh` — 30 days.

Both are `sameSite=lax` and `secure` in production only (so local `http://localhost` dev still works).

## Gotchas

- **`auth()` can only rotate from a server action or route handler.** Next.js forbids server components from writing cookies, so a stale-access read in a server component returns `null` instead of refreshing. Trigger `auth()` from the action driving the page, or accept the redirect.
- **Entitlements are resolved server-side.** Gate features by calling `relipay.billing.getEntitlements(session.accessToken, …)` from a server module — never from client state.
- **`billingSubject: 'org'` requires an `organizationId`.** On a per-team-billing Application, `createCheckout` without one throws `BILLING_ORGANIZATION_REQUIRED`. Read the live config via `relipay.applications.me()` and gate the checkout UI on it.
- **Switching active org returns a fresh token pair** — write both back into `ACCESS_COOKIE` / `REFRESH_COOKIE` with the exported opts, or later reads use the stale org view.
- **Checkout activation is async — and not your webhook.** Subscriptions flip to ACTIVE when the provider (Stripe/PayPal) calls **ReliPay's** webhook endpoint, which the operator configures in the panel; your Next.js app never receives or verifies that traffic. Re-fetch `getSubscription` / `getEntitlements` on your `successUrl` page. (The SDK's `verifyWebhookSignature` is only for webhooks ReliPay sends to *your* app — user-lifecycle events; see `docs/billing.md`.)
- **Don't import `@relipay/nextjs/server` from a Client Component or middleware** — it pulls Node-only deps.

## Links

- Docs: [/docs](https://relipay.dev/docs) · [SDK guide](https://relipay.dev/docs/sdk) · [API reference](https://relipay.dev/docs/api) · [agent prompt](https://relipay.dev/docs/prompt)
- Example: [`examples/nextjs-saas`](../../examples/nextjs-saas) — a complete App Router SaaS using this package end-to-end.

## License

MIT
