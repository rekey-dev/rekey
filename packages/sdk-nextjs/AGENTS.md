# AGENTS.md — `@rekey.dev/nextjs`

Next.js 14/15 App Router helpers built on top of `@rekey.dev/node`.

## Three entrypoints

| Import | Runtime | Credential | Use case |
|---|---|---|---|
| `@rekey.dev/nextjs/middleware` | **Edge** | none | Wire into `middleware.ts` to gate routes; `rejectMalformedActionOrigin()` for hand-written middleware |
| `@rekey.dev/nextjs/server`     | **Node** | secret key | `auth()`, `signIn()`, `signUp()`, `createSession()`, `signOut()` for server components / actions / route handlers; `rekeyRefreshHandler()` for the refresh route; `subscribeToList(key, formData)` to add a visitor to a list from a server action (always resolves `{ status: 'received' }`; needs the visitor IP) |
| `@rekey.dev/nextjs/client`     | **Browser** | publishable key | `rekeyBrowser()` — login/register/license/plans from a Client Component, no backend |
| `@rekey.dev/nextjs/errors`     | anywhere | none | `classifySignInError()`, for reading a failed sign-in without pulling the server entry |

The server split exists because middleware runs in Edge and can't import `@prisma/client` etc. that `@rekey.dev/node` pulls in transitively. The `/client` split keeps the secret key out of the browser bundle — it only carries the publishable-key browser client.

## Required env

```
# server-only:
REKEY_URL=https://your-rekey.example.com
REKEY_SECRET=rp_live_…                    # Application secret key
# browser-safe (only if you use @rekey.dev/nextjs/client):
NEXT_PUBLIC_REKEY_URL=https://your-rekey.example.com
NEXT_PUBLIC_REKEY_PUBLIC_KEY=rp_pub_…     # Application publishable key
```

## Browser login → cookie hand-off (publishable-key path)

When you want login/register to run in a Client Component (no `'use server'`):

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
```tsx
'use client';
import { rekeyBrowser } from '@rekey.dev/nextjs/client';
const out = await rekeyBrowser().signIn({ email, password });   // publishable key
if (!out.mfaRequired) {
  await fetch('/api/auth/session', { method: 'POST',
    body: JSON.stringify({ accessToken: out.accessToken, refreshToken: out.refreshToken }) });
}
```

```ts
// app/api/auth/session/route.ts — finalize into httpOnly cookies (secret-key side)
import { createSession } from '@rekey.dev/nextjs/server';
export async function POST(req: Request) {
  const { accessToken, refreshToken } = await req.json();
  await createSession({ accessToken, refreshToken });
  return Response.json({ ok: true });
}
```

After `createSession`, `auth()` + middleware behave identically to the server-action path. Never use the secret key in the browser. `usage.record` and `credits.consume` are secret-only and reject `rp_pub_` — they attribute consumption on the operator's behalf, so the subject must not be caller-chosen. Billing checkout and subscription-cancel *do* accept the publishable key, because they additionally require the end-user's own token and act only on that user.

## Five-line happy path

<!-- snippet: no-check several files or alternatives shown in one block, so names are declared twice -->
```ts
// middleware.ts
import { rekeyMiddleware } from '@rekey.dev/nextjs/middleware';
export default rekeyMiddleware({ publicRoutes: ['/sign-in', '/sign-up'] });
export const config = { matcher: ['/((?!_next|.*\\..*).*)'] };

// app/dashboard/page.tsx
import { auth } from '@rekey.dev/nextjs/server';
export default async function Dashboard() {
  const session = await auth();
  if (!session) return null; // middleware already redirected; defensive
  return <p>Hi {session.user.email}</p>;
}

// app/sign-in/actions.ts
'use server';
import { signIn } from '@rekey.dev/nextjs/server';
export async function signInAction(fd: FormData) {
  await signIn({ email: String(fd.get('email')), password: String(fd.get('password')) });
  redirect('/dashboard');
}
```

## Cookie model

Two httpOnly cookies, set by `signIn` / `signUp`:

- `rekey_access`  — 15 min, the user's JWT
- `rekey_refresh` — 30 days, the refresh token

`auth()` tries access first, falls back to refresh-and-rotate, returns `null` only when both fail. Auto-rotation in `auth()` works when called from a server action or a route handler (Next.js limitation: server components can't write cookies, so a stale-access read in a server component returns null instead of refreshing — handle this in your protected page by also calling `auth()` inside the action that triggered the page).

`rekeyMiddleware` sends a GET or HEAD with a refresh cookie and no access cookie to `/api/rekey/refresh?next=<path>` (`DEFAULT_REFRESH_PATH`). Any other method (a Server Action is a POST) is let through to refresh in place with `auth()` / `refreshSession()`, which may write cookies there. Create that route with one line, `export const GET = rekeyRefreshHandler();` in `app/api/rekey/refresh/route.ts`. Do not hand-write it: the handler validates `next` to a same-origin path, clears cookies only on a `REFRESH_TOKEN_*` verdict, keeps them on 429 or a network failure, keeps them on `REFRESH_TOKEN_RACED` (another request won the rotation; matched exactly, before the prefix rule, and once per token via the `rekey_refresh_raced` digest cookie), and answers a just-spent token with the pair it was exchanged for (per process, ten seconds) so a parallel request does not replay it and trigger theft detection.

## Device binding

An Application with `authConfig.deviceBinding: 'required'` refuses every primary sign-in that does not name its machine (`400 DEVICE_FINGERPRINT_REQUIRED`). `signIn`, `signUp` and `mfaVerify` all take `device: { fingerprint, label? }`, and `auth()` / `refreshSession()` take the same option so the rotation identifies the same machine. A bound chain refreshed from a different fingerprint is `REFRESH_TOKEN_DEVICE_MISMATCH` and revokes every session the user has. Omit it and nothing is sent. Browsers have no fingerprint worth having; this is for a Next server fronting a desktop or mobile client. See `docs/devices.md`.

## Reading a failed sign-in

`classifySignInError(err)` returns one of `invalid_credentials`, `device_required`, `device_limit` (carries `limit`, the `devices` to release, and `selfRelease`, false when the Application keeps release with its operators, so show "contact support" instead), `device_blocked`, `retry_later` (carries `retryAfterSeconds`), `other`, or `null` when the value is not an API error at all, in which case rethrow it.

Two of those must never be rendered as a wrong password: `DEVICE_LIMIT_REACHED` (correct credentials, the account is at its `max_devices` cap, and the device list is the only repair path since no token was issued) and `PASSWORD_VERIFY_BUSY` (the server never checked the password, and nothing was counted toward lockout). It does not retry for you; the wait belongs in the UI.

## What NOT to do

- Don't import `@rekey.dev/nextjs/server` from a client component or a middleware. It pulls Node-only deps; bundling will fail or balloon.
- Don't replace `rekeyMiddleware` with hand-written middleware that returns a bare `NextResponse.next()`. `rekeyMiddleware` answers a Server Action carrying `Origin: null` (sent from sandboxed iframes and other opaque origins) with a 403; without it Next 15 crashes on that header with a 500. Custom middleware should start with `return rejectMalformedActionOrigin(req) ?? NextResponse.next()`.
- Don't "fix" a malformed `Origin` by deleting the header. With no `Origin`, Next skips its CSRF origin check and runs the action, so stripping turns a crash into an unchecked cross-site action. Refuse it.
- Don't bypass the cookies (e.g. read `REKEY_SECRET` directly in a route handler to skip session). The whole point is the session check is the chokepoint.
- Don't loosen `httpOnly` or `sameSite=lax` without a reason. They're aligned with the panel and the demo for consistency.
