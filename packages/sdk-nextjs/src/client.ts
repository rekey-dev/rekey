'use client';

/**
 * Browser entrypoint — `@rekey.dev/nextjs/client`.
 *
 * The ONLY Rekey credential this touches is the Application **publishable**
 * key (`rp_pub_…`), which is public by design and safe to ship in client code.
 * Use it for the signed-out **bootstrap** flow — sign-up, sign-in, magic-link,
 * passkey, license verify, plan listing — straight from a Client Component,
 * with no server round-trip to start auth.
 *
 * The secret key (`rp_live_…`) NEVER belongs here — keep it on the server in
 * `@rekey.dev/nextjs/server` for `auth()`, route handlers, and trusted API calls.
 *
 * Recommended Next.js shape (keeps tokens out of JS long-term):
 *   1. Client calls `rekeyBrowser().signIn(...)` with the publishable key.
 *   2. Client POSTs the returned `{ accessToken, refreshToken }` to your route
 *      handler, which calls `createSession(...)` from `/server` to set the
 *      httpOnly session cookies.
 *   3. Server Components + API routes read the session via `auth()` (secret key).
 *
 * See the README "Publishable login → secret-key API routes" example.
 */

import { RekeyBrowserClient } from '@rekey.dev/react';

export { RekeyBrowserClient } from '@rekey.dev/react';

export interface RekeyBrowserOptions {
  /** Override the API URL. Defaults to `process.env.NEXT_PUBLIC_REKEY_URL`. */
  apiUrl?: string;
  /** Override the publishable key. Defaults to `process.env.NEXT_PUBLIC_REKEY_PUBLIC_KEY`. */
  publishableKey?: string;
}

let _cached: RekeyBrowserClient | null = null;

/**
 * Get a browser Rekey client configured from `NEXT_PUBLIC_*` env (or the
 * passed overrides). Cached across calls when using env defaults.
 *
 * @example
 * ```tsx
 * 'use client';
 * import { rekeyBrowser } from '@rekey.dev/nextjs/client';
 *
 * async function onSubmit(email: string, password: string) {
 *   const out = await rekeyBrowser().signIn({ email, password });
 *   if (out.mfaRequired) { /* prompt for code, then rekeyBrowser().mfaVerify(...) *\/ }
 *   else {
 *     await fetch('/api/auth/session', {
 *       method: 'POST',
 *       body: JSON.stringify({ accessToken: out.accessToken, refreshToken: out.refreshToken }),
 *     });
 *   }
 * }
 * ```
 */
export function rekeyBrowser(opts: RekeyBrowserOptions = {}): RekeyBrowserClient {
  const usingEnvDefaults = opts.apiUrl === undefined && opts.publishableKey === undefined;
  if (usingEnvDefaults && _cached) return _cached;

  const apiUrl = opts.apiUrl ?? process.env.NEXT_PUBLIC_REKEY_URL;
  const publishableKey = opts.publishableKey ?? process.env.NEXT_PUBLIC_REKEY_PUBLIC_KEY;
  if (!apiUrl) {
    throw new Error(
      '@rekey.dev/nextjs/client: NEXT_PUBLIC_REKEY_URL is not set (or pass { apiUrl }).',
    );
  }
  if (!publishableKey) {
    throw new Error(
      '@rekey.dev/nextjs/client: NEXT_PUBLIC_REKEY_PUBLIC_KEY is not set (or pass { publishableKey }). ' +
        'Copy the publishable key (rp_pub_…) from Panel → Application. Never put the secret key in the browser.',
    );
  }

  const client = new RekeyBrowserClient({ apiUrl, publishableKey });
  if (usingEnvDefaults) _cached = client;
  return client;
}
