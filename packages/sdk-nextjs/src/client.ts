'use client';

/**
 * Browser entrypoint — `@relipay/nextjs/client`.
 *
 * The ONLY ReliPay credential this touches is the Application **publishable**
 * key (`rp_pub_…`), which is public by design and safe to ship in client code.
 * Use it for the signed-out **bootstrap** flow — sign-up, sign-in, magic-link,
 * passkey, license verify, plan listing — straight from a Client Component,
 * with no server round-trip to start auth.
 *
 * The secret key (`rp_live_…`) NEVER belongs here — keep it on the server in
 * `@relipay/nextjs/server` for `auth()`, route handlers, and trusted API calls.
 *
 * Recommended Next.js shape (keeps tokens out of JS long-term):
 *   1. Client calls `relipayBrowser().signIn(...)` with the publishable key.
 *   2. Client POSTs the returned `{ accessToken, refreshToken }` to your route
 *      handler, which calls `createSession(...)` from `/server` to set the
 *      httpOnly session cookies.
 *   3. Server Components + API routes read the session via `auth()` (secret key).
 *
 * See the README "Publishable login → secret-key API routes" example.
 */

import { RelipayBrowserClient } from '@relipay/react';

export { RelipayBrowserClient } from '@relipay/react';

export interface RelipayBrowserOptions {
  /** Override the API URL. Defaults to `process.env.NEXT_PUBLIC_RELIPAY_URL`. */
  apiUrl?: string;
  /** Override the publishable key. Defaults to `process.env.NEXT_PUBLIC_RELIPAY_PUBLIC_KEY`. */
  publishableKey?: string;
}

let _cached: RelipayBrowserClient | null = null;

/**
 * Get a browser ReliPay client configured from `NEXT_PUBLIC_*` env (or the
 * passed overrides). Cached across calls when using env defaults.
 *
 * @example
 * ```tsx
 * 'use client';
 * import { relipayBrowser } from '@relipay/nextjs/client';
 *
 * async function onSubmit(email: string, password: string) {
 *   const out = await relipayBrowser().signIn({ email, password });
 *   if (out.mfaRequired) { /* prompt for code, then relipayBrowser().mfaVerify(...) *\/ }
 *   else {
 *     await fetch('/api/auth/session', {
 *       method: 'POST',
 *       body: JSON.stringify({ accessToken: out.accessToken, refreshToken: out.refreshToken }),
 *     });
 *   }
 * }
 * ```
 */
export function relipayBrowser(opts: RelipayBrowserOptions = {}): RelipayBrowserClient {
  const usingEnvDefaults = opts.apiUrl === undefined && opts.publishableKey === undefined;
  if (usingEnvDefaults && _cached) return _cached;

  const apiUrl = opts.apiUrl ?? process.env.NEXT_PUBLIC_RELIPAY_URL;
  const publishableKey = opts.publishableKey ?? process.env.NEXT_PUBLIC_RELIPAY_PUBLIC_KEY;
  if (!apiUrl) {
    throw new Error(
      '@relipay/nextjs/client: NEXT_PUBLIC_RELIPAY_URL is not set (or pass { apiUrl }).',
    );
  }
  if (!publishableKey) {
    throw new Error(
      '@relipay/nextjs/client: NEXT_PUBLIC_RELIPAY_PUBLIC_KEY is not set (or pass { publishableKey }). ' +
        'Copy the publishable key (rp_pub_…) from Panel → Application. Never put the secret key in the browser.',
    );
  }

  const client = new RelipayBrowserClient({ apiUrl, publishableKey });
  if (usingEnvDefaults) _cached = client;
  return client;
}
