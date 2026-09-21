# `@rekey.dev/nextjs`

> **ReliPay is now Rekey.** This package was previously published as the equivalent `@relipay/*` package, which is deprecated. Env vars renamed `RELIPAY_*` → `REKEY_*` (as of 2.0.0 the old names are no longer read — set `REKEY_*`). relipay.dev (the old domain) will redirect to rekey.dev after the domain migration.

[Rekey](https://rekey.dev) helpers for the **Next.js App Router** (14, 15 and 16): route-gating middleware, server-side `auth()` / `signIn()` / `signUp()` / `signOut()`, and an httpOnly cookie session — built on top of [`@rekey.dev/node`](https://www.npmjs.com/package/@rekey.dev/node).

> **For AI coding agents:** start at [AGENTS.md](../../AGENTS.md).

```bash
npm i @rekey.dev/nextjs
# or: pnpm add @rekey.dev/nextjs / yarn add @rekey.dev/nextjs
```

## Setup

Two credentials, two homes. The **secret key** powers the server (`auth()`, API routes); the **publishable key** powers browser login/register — it's public by design and safe to ship in client JS.

```bash
# Server-only (never NEXT_PUBLIC_):
REKEY_URL=https://api.rekey.dev
REKEY_SECRET=rp_live_…              # Application secret key (Panel → Application → API Keys)

# Browser-safe (exposed to client bundle):
NEXT_PUBLIC_REKEY_URL=https://api.rekey.dev
NEXT_PUBLIC_REKEY_PUBLIC_KEY=rp_pub_…   # Application publishable key
```

**`https://api.rekey.dev` is Rekey Cloud's API**, the same origin for every
Cloud workspace — requests are scoped by your API key, not by the URL. Self-hosting,
use your own deployment's public origin instead (`http://localhost:3030` locally).
Both URL variables are the same origin; the `NEXT_PUBLIC_` prefix only tells the
bundler it may be inlined. There is no default for either — see
[docs/api-url.md](../../docs/api-url.md) for why, and for how to verify the origin
before wiring keys.

> **Never ship the secret key to the browser.** `@rekey.dev/nextjs/server` pulls
> Node-only deps and reads `REKEY_SECRET`; importing it from a Client
> Component or middleware will fail to bundle (that's the safety net working).
> Browser code uses the **publishable** key via `@rekey.dev/nextjs/client`.

### Entrypoints

| Import | Runtime | Credential | Use case |
| --- | --- | --- | --- |
| `@rekey.dev/nextjs/middleware` | **Edge** | none (cookie presence) | Gate routes in `middleware.ts` (cheap, no network). |
| `@rekey.dev/nextjs/server` | **Node** | secret key | `auth()`, `signIn()`, `signUp()`, `createSession()` + your `@rekey.dev/node` API calls. |
| `@rekey.dev/nextjs/client` | **Browser** | publishable key | `rekeyBrowser()` — sign-in/up, magic-link, passkey, license verify, plans from a Client Component, no backend round-trip. |
| `@rekey.dev/nextjs/cookies` | **anywhere** | none | `ACCESS_COOKIE` / `REFRESH_COOKIE` / `*_OPTS` / `cookieSecureFrom()`. Zero dependencies — import cookie names from **here**, not from the root barrel. |
| `@rekey.dev/nextjs/errors` | **anywhere** | none | `classifySignInError()` + its types. Zero dependencies, safe from a Client Component rendering a failure a server action returned. |

The split keeps the Edge bundle small and the secret key out of the browser — the `/client` module only imports the publishable-key browser client.

> **Import the cookie constants from `/cookies`, not from the root.** The root
> barrel re-exports `./server`, which pulls `next/server` and reads
> `REKEY_SECRET`; importing it from a Client Component is a build error. The
> `/cookies` entry exists precisely so a client component never has to.

### Which login path?

Both are valid; pick per app:

- **Server-action login** (secret key, `/server`) — the browser never holds any Application key; tokens go straight into httpOnly cookies. Best default when you have a server. See [Quickstart](#quickstart) step 3.
- **Browser login** (publishable key, `/client`) — sign users in directly from a Client Component, then hand the tokens to a route handler that calls `createSession()` to set the same httpOnly cookies. Best for client-component-driven flows. See [Publishable login → secret-key API routes](#publishable-login--secret-key-api-routes).

## Quickstart

**1. Gate routes — `middleware.ts`:**

```ts
import { rekeyMiddleware } from '@rekey.dev/nextjs/middleware';

export default rekeyMiddleware({
  signInUrl: '/login',
  publicRoutes: ['/', '/login', '/signup', '/forgot-password', '/api/auth'],
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
```

**2. Keep sessions alive — `app/api/rekey/refresh/route.ts`:**

The middleware above sends a visitor whose access cookie has lapsed to
`/api/rekey/refresh` before it decides they are signed out. That route is
yours to create, and without it every signed-in visitor hits a 404 about
fifteen minutes in. `refreshSession` rotates the tokens and writes the new
cookies, which a server component cannot always do.

```ts
// app/api/rekey/refresh/route.ts
import { NextResponse } from 'next/server';
import { refreshSession } from '@rekey.dev/nextjs/server';

export async function GET(req: Request) {
  const next = new URL(req.url).searchParams.get('next') ?? '/';
  await refreshSession();
  return NextResponse.redirect(new URL(next, req.url));
}
```

Pass `refreshUrl` to `rekeyMiddleware` to put it somewhere else, or
`refreshUrl: false` to turn the hop off and let stale sessions go to the sign-in
page instead.

**3. Read the session — any server component:**

```tsx
import { auth } from '@rekey.dev/nextjs/server';

export default async function Dashboard() {
  const session = await auth(); // { user, accessToken } | null
  if (!session) return null;    // middleware already redirected; defensive
  return <p>Hi {session.user.email}</p>;
}
```

**4. Sign in — a server action:**

```ts
'use server';
import { redirect } from 'next/navigation';
import { signIn } from '@rekey.dev/nextjs/server';

export async function signInAction(fd: FormData) {
  const outcome = await signIn({
    email: String(fd.get('email')),
    password: String(fd.get('password')),
  });
  if (outcome.kind === 'mfa_required') redirect('/login?error=MFA_REQUIRED');
  redirect('/dashboard');
}
```

See [Device binding](#device-binding) for `deviceBinding: 'required'` Applications, and [Reading a failed sign-in](#reading-a-failed-sign-in) before you render the error.

For everything `@rekey.dev/nextjs` doesn't cover (billing, credits, usage, orgs, password reset, sessions), construct a [`@rekey.dev/node`](https://www.npmjs.com/package/@rekey.dev/node) client in a server-only module and call it from server actions / route handlers — passing `session.accessToken` for per-user reads.

## Publishable login → secret-key API routes

The browser logs the user in with the **publishable** key; the resulting tokens are handed to a route handler that sets the httpOnly session cookies; everything server-side (`auth()`, your API routes) keeps using the **secret** key. No `'use server'` action needed for login.

**1. Client Component — register / sign in with the publishable key:**

```tsx
'use client';
import { rekeyBrowser } from '@rekey.dev/nextjs/client';
import { useRouter } from 'next/navigation';

export function LoginForm() {
  const router = useRouter();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    // signUp for register; signIn for login — both publishable-key authorized.
    const out = await rekeyBrowser().signIn({
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
import { createSession } from '@rekey.dev/nextjs/server';

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
import { auth } from '@rekey.dev/nextjs/server';
import { Rekey } from '@rekey.dev/node';

const rekey = new Rekey({
  apiUrl: process.env.REKEY_URL!,
  secretKey: process.env.REKEY_SECRET!,   // secret key — server-only
});

export async function GET() {
  const session = await auth();             // from the httpOnly cookies
  if (!session) return new Response('Unauthorized', { status: 401 });
  const balance = await rekey.credits.getBalance({ endUserId: session.user.id });
  return Response.json(balance);
}
```

After this, `middleware.ts` and `auth()` work identically to the server-action path — the only difference is *where the login call ran* (browser vs server). Plans + license verification can also run straight from the browser: `rekeyBrowser().getPlans()` (which resolves to `{items, page}`, like every list method), `rekeyBrowser().verifyLicense({ key, machineFingerprint })`.

## Device binding

If your Application sets `authConfig.deviceBinding: 'required'`, every primary sign-in must name the machine it came from or the API answers `400 DEVICE_FINGERPRINT_REQUIRED` and issues no token. Pass `device` to `signIn`, `signUp` and `mfaVerify`:

```ts
'use server';
import { signIn } from '@rekey.dev/nextjs/server';

export async function signInAction(fd: FormData) {
  const outcome = await signIn({
    email: String(fd.get('email')),
    password: String(fd.get('password')),
    // Computed by your client and POSTed to this action. Opaque to Rekey,
    // stable across launches, 8 to 256 characters.
    device: { fingerprint: String(fd.get('fingerprint')), label: 'Work laptop' },
  });
  // …
}
```

**Keep sending it on refresh.** A chain bound at sign-in is checked on every rotation: a bound chain refreshed from a different fingerprint is `REFRESH_TOKEN_DEVICE_MISMATCH`, which Rekey treats as a stolen token and answers by revoking every session that user has. `auth()` and `refreshSession()` both take the same option:

```ts
const session = await auth({ device: { fingerprint } });
```

Pass nothing and nothing changes: no key is sent, an unbound chain stays unbound, and every existing call site keeps working. A browser cannot produce a fingerprint worth having, so this is for a Next.js server fronting a desktop or mobile client that computes one. Full model: [docs/devices.md](https://github.com/rekey-dev/rekey/blob/main/docs/devices.md).

## Reading a failed sign-in

Two common refusals are not the user's password, and rendering them as one leaves people stuck:

- **`DEVICE_LIMIT_REACHED` (403)**: the account is at its `max_devices` entitlement. The error carries the active devices filling the cap, and that list is the whole repair path: no token was issued, so the user cannot release a device from inside your app.
- **`PASSWORD_VERIFY_BUSY` (503)**: the server was saturated and did **not check the password**. Nothing was counted toward lockout and the credentials may be right. "Email or password is incorrect" is simply false here, and it sends the user to password reset to fix a problem that is not theirs.

`classifySignInError` turns a thrown error into the arms a sign-in page has to render:

```ts
import { signIn, classifySignInError } from '@rekey.dev/nextjs/server';

try {
  await signIn({ email, password, device });
} catch (err) {
  const failure = classifySignInError(err);
  if (!failure) throw err;           // not an API error, so a real crash
  switch (failure.kind) {
    case 'invalid_credentials': return { error: 'Email or password is incorrect.' };
    case 'device_required':     return { error: 'This app must be signed in from a registered device.' };
    case 'device_limit':        return { devices: failure.devices, limit: failure.limit };
    case 'device_blocked':      return { error: 'This device was blocked. Contact support.' };
    case 'retry_later':         return { error: `Server busy. Try again in ${failure.retryAfterSeconds ?? 5}s.` };
    case 'other':               return { error: failure.code };
  }
}
```

It reads `error.code`, `error.details` and `error.retryAfterSeconds`, all of which the API has always sent, and is duck-typed rather than `instanceof`-based, so it still works on a failure that crossed a server-action boundary and lost its prototype. It does **not** retry for you: a retry inside a server action holds the request open and adds load to a server that is already shedding it, so the wait belongs in your UI where the user can see and cancel it. `release a device` has no UI here either; the devices are handed back as data for you to render. Release goes through your own backend (`rekey.devices.release(...)`) or an operator, since the refused sign-in issued no user token.

Codes and `details` shapes: [docs/errors.md](https://github.com/rekey-dev/rekey/blob/main/docs/errors.md).

## Core API

### `@rekey.dev/nextjs/middleware`
| Export | Description |
| --- | --- |
| `rekeyMiddleware({ publicRoutes?, signInUrl? })` | Middleware that lets `publicRoutes` through and redirects unauthenticated requests to `signInUrl?next=…`. Gates on cookie *presence*; validity is checked deeper via `auth()`. |
| `MiddlewareConfig` | Type for the config object. |

### `@rekey.dev/nextjs/server`
| Export | Description |
| --- | --- |
| `auth({ device? })` | Resolve the session from cookies. Tries the access token, refreshes-and-rotates once on expiry, returns `null` only when both fail. `device` is carried into the rotation, see [Device binding](#device-binding). |
| `refreshSession({ device? })` | Rotate and persist from a route handler or middleware, where cookie writes are allowed. |
| `signIn({ email, password, device? })` | Returns `{ kind: 'session' }` (cookies set) or `{ kind: 'mfa_required', mfaChallengeToken }` (**no cookies**: collect a code and complete via `mfaVerify`). |
| `mfaVerify({ mfaChallengeToken, code, device? })` | Complete an MFA-required sign-in; sets cookies on success. |
| `signUp({ email, password, metadata?, device? })` | Create the user + start a session (always sets cookies). |
| `createSession({ accessToken, refreshToken })` | Set the httpOnly session cookies from tokens a **browser** login produced. Use in a route handler to finalize a `@rekey.dev/nextjs/client` sign-in. |
| `signOut(redirectTo?)` | Revoke the refresh token + clear cookies; optionally redirect. |
| `classifySignInError(err)` | Turn a thrown sign-in failure into `invalid_credentials` / `device_required` / `device_limit` / `device_blocked` / `retry_later` / `other`. `null` means it was not an API error, so rethrow it. See [Reading a failed sign-in](#reading-a-failed-sign-in). |
| `Session` / `SignInOutcome` / `SignInFailure` / `DeviceChoice` / `DeviceBindingRequest` | Session, sign-in result, and failure types. |

`classifySignInError` and its types are also available dependency-free from `@rekey.dev/nextjs/errors`, so a Client Component can render a failure a server action handed it without pulling in the server entry.

### `@rekey.dev/nextjs/client` (browser — publishable key)
| Export | Description |
| --- | --- |
| `rekeyBrowser({ apiUrl?, publishableKey? })` | Browser client configured from `NEXT_PUBLIC_REKEY_URL` + `NEXT_PUBLIC_REKEY_PUBLIC_KEY` (or overrides). Methods: `signIn`, `signUp`, `mfaVerify`, `requestMagicLink`, `verifyMagicLink`, `startPasskeyAuthentication`, `verifyPasskeyAuthentication`, `getPlans`, `verifyLicense`. |
| `RekeyBrowserClient` | The underlying class, re-exported from `@rekey.dev/react`. |

### `@rekey.dev/nextjs` (root)
| Export | Description |
| --- | --- |
| `mcpConnectionInfo({ apiUrl, appSlug })` | Build the MCP URL + `claude mcp add` command to render a "Connect to Claude" button (pure string-building). |
| `ACCESS_COOKIE` / `REFRESH_COOKIE` / `ACCESS_COOKIE_OPTS` / `REFRESH_COOKIE_OPTS` | Re-exported here for convenience, but **import them from `@rekey.dev/nextjs/cookies`** — that entry is dependency-free and safe from a Client Component, while this barrel is a server entry. |

### `@rekey.dev/nextjs/cookies` (dependency-free)
| Export | Description |
| --- | --- |
| `ACCESS_COOKIE` / `REFRESH_COOKIE` | `"rekey_access"` / `"rekey_refresh"`. |
| `ACCESS_COOKIE_OPTS` / `REFRESH_COOKIE_OPTS` | Cookie options, for actions that write the token pair directly (e.g. after `organizations.switch`). |
| `cookieSecureFrom(headers)` | The per-request `Secure` decision — see [Cookie model](#cookie-model). |

## Cookie model

Two httpOnly cookies, set by `signIn` / `signUp`:

- `rekey_access` — 15 min (matches access-token lifetime).
- `rekey_refresh` — 30 days.

Both are `sameSite=lax`, `httpOnly`, and carry `Secure` **unless the request
arrived as plain HTTP on a loopback host** — so local `http://localhost` dev
still works, and a TLS deployment gets `Secure` whatever `NODE_ENV` happens to
be. The decision is made per request, in this order:

1. `REKEY_COOKIE_SECURE=true` / `=false`, if set — wins outright.
2. `X-Forwarded-Proto` (first hop) — `https` ⇒ `Secure`.
3. Otherwise the `Host`: `localhost` / `127.0.0.1` / `[::1]` / `*.localhost` ⇒
   not `Secure`; anything else ⇒ `Secure`.

Rule 3 is fail-secure. If you serve a **public hostname over plain HTTP**, the
browser will refuse the cookie and sign-in will appear to do nothing — set
`REKEY_COOKIE_SECURE=false` if that is genuinely what you want. This replaced a
`process.env.NODE_ENV === 'production'` check, which answered a request-time
question at build time and silently emitted cookies without `Secure` on any
deployment where Next did not inline `NODE_ENV` as exactly `"production"`.

`cookieSecureFrom(headers)` is exported from `@rekey.dev/nextjs/cookies` if you
need the same decision for a cookie of your own.

## Gotchas

- **`auth()` can only rotate from a server action or route handler.** Next.js forbids server components from writing cookies, so a stale-access read in a server component returns `null` instead of refreshing. Trigger `auth()` from the action driving the page, or accept the redirect.
- **Entitlements are resolved server-side.** Gate features by calling `rekey.billing.getEntitlements(session.accessToken, …)` from a server module — never from client state.
- **`billingSubject: 'org'` requires an `organizationId`.** On a per-team-billing Application, `createCheckout` without one throws `BILLING_ORGANIZATION_REQUIRED`. Read the live config via `rekey.applications.me()` and gate the checkout UI on it.
- **Switching active org returns a fresh token pair** — write both back into `ACCESS_COOKIE` / `REFRESH_COOKIE` with the exported opts, or later reads use the stale org view.
- **Checkout activation is async — and not your webhook.** Subscriptions flip to ACTIVE when the provider (Stripe/PayPal) calls **Rekey's** webhook endpoint, which the operator configures in the panel; your Next.js app never receives or verifies that traffic. Re-fetch `getSubscription` / `getEntitlements` on your `successUrl` page. (The SDK's `verifyWebhookSignature` is only for webhooks Rekey sends to *your* app — user-lifecycle events; see `docs/billing.md`.)
- **Don't import `@rekey.dev/nextjs/server` from a Client Component or middleware** — it pulls Node-only deps.

## Links

- Docs: [/docs](https://rekey.dev/docs) · [SDK guide](https://rekey.dev/docs/sdk) · [API reference](https://rekey.dev/docs/api) · [agent prompt](https://rekey.dev/docs/prompt)
- Component reference: [docs/react-components.md](https://github.com/rekey-dev/rekey/blob/main/docs/react-components.md) — the `<SignIn>` / `<PricingTable>` family these helpers pair with, including the matching Server Actions. (The `examples/` apps were removed pending a rebuilt set.)

## License

MIT
