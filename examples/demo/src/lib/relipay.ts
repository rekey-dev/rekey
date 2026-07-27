/**
 * Rekey SDK + session-cookie helpers.
 *
 * One module-level client (per Next dev/server lifecycle), used by every
 * server component, server action, and route handler in this demo. The
 * SDK only ever talks to Rekey from the server — the browser never sees
 * the secret key.
 *
 * Sessions live in two httpOnly cookies:
 *   - relipay_access  — short-lived (15 min) JWT, used as the user identifier
 *                       on per-user calls (X-Rekey-User-Token header).
 *   - relipay_refresh — long-lived (30 days) opaque token. When the access
 *                       token expires (the SDK throws USER_TOKEN_INVALID),
 *                       call rekey.auth.refresh() and rotate both cookies.
 *
 * In a production app you'd probably wrap protected pages in a small helper
 * that catches USER_TOKEN_INVALID and refreshes automatically. The demo keeps
 * it explicit so the model is visible.
 */

import { cookies } from 'next/headers';
import { Rekey, RekeyError } from '@rekey.dev/node';

if (!process.env.RELIPAY_URL) {
  throw new Error('RELIPAY_URL is missing — copy .env.local.example or rerun the bootstrap script.');
}
if (!process.env.RELIPAY_SECRET) {
  throw new Error('RELIPAY_SECRET is missing — get a key from the Rekey panel and put it in .env.local.');
}

export const rekey = new Rekey({
  apiUrl: process.env.RELIPAY_URL,
  secretKey: process.env.RELIPAY_SECRET,
});

export { RekeyError };

export const ACCESS_COOKIE = 'relipay_access';
export const REFRESH_COOKIE = 'relipay_refresh';

const ONE_DAY = 60 * 60 * 24;

/** Persist a fresh access + refresh pair as httpOnly cookies. */
export async function setSessionCookies(args: {
  accessToken: string;
  refreshToken: string;
}): Promise<void> {
  const jar = await cookies();
  const secure = process.env.NODE_ENV === 'production';
  // Access token lifetime mirrors Rekey's default (15 min). Browser clears
  // when the cookie expires; refresh handles re-issuance.
  jar.set(ACCESS_COOKIE, args.accessToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: 60 * 15,
  });
  jar.set(REFRESH_COOKIE, args.refreshToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: ONE_DAY * 30,
  });
}

/** Clear both session cookies. */
export async function clearSessionCookies(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

/** Read the access token cookie, or `null` if not signed in. */
export async function getAccessToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(ACCESS_COOKIE)?.value ?? null;
}

/** Read the refresh token cookie, or `null` if not signed in. */
export async function getRefreshToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(REFRESH_COOKIE)?.value ?? null;
}
