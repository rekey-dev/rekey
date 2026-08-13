# `@rekey.dev/astro`

[Rekey](https://rekey.dev) session handling for **Astro** (4, 5, 6 and 7): middleware that puts the session on `Astro.locals`, cookie helpers, and sign-in/sign-out — built on [`@rekey.dev/node`](https://www.npmjs.com/package/@rekey.dev/node).

```bash
npm i @rekey.dev/astro
# or: pnpm add @rekey.dev/astro / yarn add @rekey.dev/astro
```

Requires an SSR adapter and `output: 'server'`. Sessions are httpOnly cookies read on the server; there is nothing to prerender.

## Why this exists

Astro gives you `cookies` and `locals` and leaves the rest to you, so every Astro app that talks to Rekey ends up writing the same ninety lines. Two of those lines are easy to get wrong, and both fail in the silent direction — no error, no red build, just a bad afternoon that costs more than it should. Those two lines are the reason this package is not "a thin wrapper you could write yourself":

**Only a verdict about the token clears it.** The obvious refresh handler catches everything and signs the user out. That turns a thirty-second API blip into a mass logout, because the refresh cookie — the one credential that could have recovered every session — has been deleted from every browser. Users do not come back from that on their own; they get a login screen and no explanation. `getSession` clears cookies only when the API returns a verdict about the token itself — any `REFRESH_TOKEN_*` code, or a `USER_TOKEN_*` one. Anything else throws, so the cookie survives and the next request tries again. It is matched by prefix rather than a fixed list, because a list is right the day it is written and silently wrong the day the API adds a code.

**`Secure` is a per-request decision.** `import.meta.env.PROD` is a build-time answer to a request-time question, and the two ways of guessing wrong are not equally bad: mark a cookie `Secure` on plain HTTP and the browser refuses it — loud, one variable to fix. Omit it on HTTPS and a session credential travels in cleartext — silent, and you find out from someone else. This package reads `x-forwarded-proto` and `Host` per request, treats localhost as the secure context browsers already consider it, and leans `Secure` when it cannot tell.

It deliberately does *not* read `x-forwarded-host`: a client can send that header, so letting it decide would let anyone ask for a session cookie without `Secure`.

## Setup

```bash
REKEY_URL=https://api.rekey.dev   # Rekey Cloud; self-hosted, use your own origin
REKEY_SECRET=rp_live_…            # Application secret key (Panel → Application → API Keys)
```

**`https://api.rekey.dev` is Rekey Cloud's API** — one origin for every Cloud
workspace, scoped by your API key rather than by the URL. Self-hosting, point
`REKEY_URL` at your own deployment's public origin (`http://localhost:3030`
locally). Both variables are required and neither has a default; see
[docs/api-url.md](../../docs/api-url.md).

> **Breaking, from `2.0.0-rc.9`.** Up to and including `2.0.0-rc.8`, `REKEY_URL`
> fell back to `https://api.rekey.dev` when unset. It no longer does — it throws.
>
> If you self-host and were relying on that fallback, every request this SDK made
> went to Rekey Cloud carrying credentials: your `REKEY_SECRET` in an
> `Authorization` header on all of them, plus the **end-user's refresh token**
> (`auth.refresh`, `auth.signOut`) and **access token** (`getCurrentUser`) on the
> session calls. Set `REKEY_URL`, rotate the secret key, and treat any end-user
> session that was live during that period as disclosed.
>
> Note that `^2.0.0-rc.8` matches `2.0.0-rc.9`, so a lockfile refresh alone will
> pick this up. That is deliberate: it fails immediately, loudly, and with the
> value it needs named in the message.

> The built server reads `process.env`, not `.env`. Vite loads `.env` for `astro dev`; in production, pass the variables through your process manager or platform. This is the single most common "works locally, 500s on deploy".

Astro secrets belong in [`astro:env`](https://docs.astro.build/en/guides/environment-variables/), never `import.meta.env` — Vite inlines the latter into `dist/`, which ships your secret key to anyone who reads the bundle.

## Middleware

```ts
// src/middleware.ts
import { rekeyMiddleware } from '@rekey.dev/astro';

export const onRequest = rekeyMiddleware();
```

```ts
// src/env.d.ts
declare namespace App {
  interface Locals {
    session: import('@rekey.dev/astro').Session | null;
  }
}
```

The middleware resolves the session, refreshes it when the access token has expired, and sets `Astro.locals.session`. It does **not** gate routes: whether a route needs a session is a property of that route, so the check lives in the page.

```astro
---
// src/pages/dashboard.astro
if (!Astro.locals.session) return Astro.redirect('/sign-in?next=/dashboard');
const { user } = Astro.locals.session;
---
<p>Signed in as {user.email}</p>
```

If the session read fails outright, the middleware logs and continues signed out rather than throwing. It runs on every route, so an uncaught error there would take down your public pages, your sign-in page, and the sign-out endpoint that could have cleared a poisoned cookie — leaving a visitor with no way back in.

The one exception is a `RekeyAstroConfigError` — a missing or malformed `REKEY_SECRET` — which is rethrown. A deploy with no credentials would otherwise render perfectly while signing out every user and bouncing every protected page to sign-in, with a log line per request as the only clue. A misconfigured deploy should fail like a misconfigured deploy.

`getSession` must be called from middleware or top-level frontmatter, not from an imported component. Refreshing writes cookies, and Astro throws once the response has started; the package detects that and reports no session rather than spending a refresh token it cannot store, but the result is a signed-in user seeing a signed-out page.

## Signing in

```astro
---
// src/pages/sign-in.astro
import { rekey, setSession, safePath, cookieSecureFor } from '@rekey.dev/astro';
import { RekeyError } from '@rekey.dev/node';

const next = safePath(Astro.url.searchParams.get('next'), '/dashboard');
let error: string | null = null;

if (Astro.request.method === 'POST') {
  const form = await Astro.request.formData();
  let result;
  try {
    result = await rekey().auth.signIn({
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
  } catch (err) {
    // Only the one code means "wrong password". Catching everything here turns
    // a rate limit, a timeout, or a disabled sign-in method into an accusation
    // that the user typed their own password wrong.
    if (err instanceof RekeyError && err.code === 'INVALID_CREDENTIALS') {
      error = 'Email or password is incorrect.';
    } else {
      throw err;
    }
  }

  // signIn returns a union. The MFA arm carries a challenge token, not a
  // session — check it before you reach for the tokens. The challenge is a
  // credential, so it goes in a cookie rather than the URL: query strings end
  // up in access logs and Referer headers.
  if (result?.mfaRequired) {
    Astro.cookies.set('rekey_mfa', result.mfaChallengeToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 300,
      secure: cookieSecureFor(Astro.request),
    });
    return Astro.redirect('/mfa');
  }

  if (result) {
    setSession(Astro.cookies, Astro.request, result);
    return Astro.redirect(safePath(form.get('next') as string | null, '/dashboard'));
  }
}
---

<form method="POST">
  <input type="hidden" name="next" value={next} />
  <label>Email <input type="email" name="email" required /></label>
  <label>Password <input type="password" name="password" required /></label>
  {error && <p role="alert">{error}</p>}
  <button type="submit">Sign in</button>
</form>
```

`SignInOutcomeDto` is discriminated on `mfaRequired`, but the shared DTOs are inferred from Zod schemas typed as `any`, so skipping that branch **type-checks cleanly** and then writes `undefined` into your session cookies. `setSession` throws rather than let that through, but the branch is yours to write. The second factor goes to `auth.mfaVerify({ mfaChallengeToken, code })`, which returns a real session.

Pass `form.get('next')` to `safePath` directly rather than through `String(...)`. `String(null)` is the string `"null"`, which is truthy and resolves to the path `/null` — so the fallback never fires and a sign-in without a `next` field lands on a 404. `safePath` special-cases that string anyway, because it is the idiom everyone reaches for, but not every helper you write will.

### Running behind a TLS proxy

Astro's `security.checkOrigin` (on by default since 4.9) rejects `POST`/`PUT`/`PATCH`/`DELETE` form submissions whose `Origin` header does not match **the URL of the request itself**. Behind a proxy that terminates TLS, Astro builds that URL from the connection it actually received — `http://10.0.0.4:4321` — while the browser sends `Origin: https://app.example`. They never match, so every form on the site 403s in production and works perfectly on localhost.

The fix is to let Astro see the public host, which needs `security.allowedDomains` (Astro 5.14.2+):

```js
// astro.config.mjs
export default defineConfig({
  output: 'server',
  security: {
    allowedDomains: [{ hostname: 'app.example', protocol: 'https' }],
  },
});
```

That is an allowlist of `X-Forwarded-Host` values, not blanket trust: a host the operator did not list is ignored and the connection's own host is used. Which is why it does not contradict this package refusing to read the same header for its cookie decision — the package has no allowlist to check against, so for it the header is only ever a claim from the client.

On Astro versions without `allowedDomains`, either configure the proxy to preserve the original host, or set `security: { checkOrigin: false }` and enforce CSRF yourself. Turning the check off without replacing it leaves your forms open to cross-site submission.

## Signing out

```ts
// src/pages/sign-out.ts
import type { APIRoute } from 'astro';
import { signOut } from '@rekey.dev/astro';

export const POST: APIRoute = async ({ cookies, redirect }) => {
  const result = await signOut(cookies);
  // Cookies are cleared either way. `revoked: false` means the API could not
  // be reached, so the refresh token is still live server-side — worth a log
  // line, because the user has been told they signed out.
  if (!result.revoked) console.error('[rekey] sign-out not revoked:', result.error);
  return redirect('/');
};
```

`signOut` revokes the refresh token server-side, then clears the cookies. Clearing alone signs the *browser* out; a thirty-day token that is still valid after someone clicks "Sign out" is a credential anyone holding a copy can keep using. It returns `{ revoked }` rather than swallowing failures, because "the token was already dead" and "the API did not answer" are different facts and only one of them means the user is actually signed out. Make it a POST — a GET sign-out can be fired by any `<img>` tag on any site.

## API

| Export | Purpose |
| --- | --- |
| `rekeyMiddleware(config?)` | Astro middleware; sets `locals.session`. |
| `getSession(cookies, request, config?)` | Resolve the session, refreshing if needed. `null` when signed out; throws when the API failed. |
| `setSession(cookies, request, tokens, config?)` | Write both cookies with the right flags. |
| `clearSession(cookies)` | Delete both cookies. |
| `signOut(cookies, config?)` | Revoke the refresh token, then clear. Returns `{ revoked }`. |
| `safePath(next, fallback)` | Reduce a caller-supplied `next` to a path on this site. |
| `rekey(config?)` | The `@rekey.dev/node` client, built on first use. |
| `cookieSecureFor(request, override?)` | The per-request `Secure` decision, for cookies of your own. |
| `ACCESS_COOKIE` / `REFRESH_COOKIE` | Cookie names, shared with `@rekey.dev/nextjs`. |
| `RekeyAstroConfigError` | Thrown for a misconfigured deploy; the middleware lets it through. |

`config` accepts `secretKey`, `apiUrl` and `cookieSecure`, defaulting to `REKEY_SECRET`, `REKEY_URL` and `REKEY_COOKIE_SECURE`. You only need `cookieSecure` when serving plain HTTP on a hostname that is not localhost.

### `safePath`

```ts
safePath('/dashboard?tab=usage', '/'); // → '/dashboard?tab=usage'
safePath('//evil.com', '/');           // → '/'
safePath('/\\evil.com', '/');          // → '/'
```

The obvious check — `startsWith('/') && !startsWith('//')` — passes `/\evil.com`, and browsers resolve that off-origin. Asking the same URL parser the browser will use is the version that holds.

## Cookie names

`rekey_access` (15 minutes) and `rekey_refresh` (30 days), matching `@rekey.dev/nextjs` on purpose: an app that moves between the two frameworks keeps its sessions instead of signing everybody out on deploy day.

## Licence

MIT
