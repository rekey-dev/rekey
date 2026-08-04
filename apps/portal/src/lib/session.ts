/**
 * Per-app portal session — httpOnly cookies, **scoped to the app's path**
 * (`/<slug>`) so app A's session can't be replayed on app B under the shared
 * portal host. Tokens never reach client JS.
 */

import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { RekeyBrowserClient } from '@rekey.dev/react';
import { rekeyApiUrl } from './env';
import { getPortalConfig } from './config';
import { cookieSecure } from './cookie-secure';

const ACCESS = 'rekey_portal_access';
const REFRESH = 'rekey_portal_refresh';
const ACCESS_MAX_AGE = 60 * 15; // 15 min
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

async function cookieOpts(slug: string, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: await cookieSecure(),
    path: `/${slug}`,
    maxAge,
  };
}

/** A publishable-key client for `slug`, or null if the app's portal isn't live. */
export async function portalClientFor(slug: string): Promise<RekeyBrowserClient | null> {
  const config = await getPortalConfig(slug);
  if (!config) return null;
  return new RekeyBrowserClient({ apiUrl: rekeyApiUrl(), publishableKey: config.publishableKey });
}

/**
 * Cookie writes are only allowed from server actions / route handlers. During a
 * Server Component render (e.g. the silent refresh inside `getPortalUser`) Next
 * throws "Cookies can only be modified in a Server Action or Route Handler" — we
 * swallow that one case so the request still renders with the fresh token; the
 * cookie lands on the next action-context write. Other errors propagate.
 */
function tolerateRenderContext(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('Cookies can only be modified')) return;
  throw err;
}

export async function setSession(slug: string, accessToken: string, refreshToken: string): Promise<void> {
  try {
    const jar = await cookies();
    jar.set(ACCESS, accessToken, await cookieOpts(slug, ACCESS_MAX_AGE));
    jar.set(REFRESH, refreshToken, await cookieOpts(slug, REFRESH_MAX_AGE));
  } catch (err) {
    tolerateRenderContext(err);
  }
}

export async function clearSession(slug: string): Promise<void> {
  try {
    const jar = await cookies();
    jar.set(ACCESS, '', await cookieOpts(slug, 0));
    jar.set(REFRESH, '', await cookieOpts(slug, 0));
  } catch (err) {
    tolerateRenderContext(err);
  }
}

export async function getAccessToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(ACCESS)?.value ?? null;
}

export async function getRefreshToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(REFRESH)?.value ?? null;
}

/**
 * In-flight refresh exchanges, keyed by the refresh token being spent.
 *
 * Refresh tokens rotate and are single-use: the first exchange invalidates the
 * presented token, so a second CONCURRENT exchange of the same token gets a
 * 401. That is correct server behaviour — reuse detection is a security
 * feature — but it means concurrent refreshers cannot both win, and the loser
 * here lands in the `catch` below, which clears the session and signs the
 * customer out mid-page.
 *
 * The portal makes that collision the default rather than a rare race:
 * `[slug]/layout.tsx` and `[slug]/page.tsx` BOTH call `getPortalUser(slug)`,
 * and React renders them concurrently. Fifteen minutes after signing in, the
 * next navigation fires two refreshes of the same token in the same tick; one
 * rotates the cookies and the other is told its token is already spent.
 *
 * This is the same failure the panel diagnosed in production and fixed in
 * `apps/panel/src/lib/api.ts` — "5 of 8 refreshes in a 40-minute session
 * returned 401, with pairs landing in the same millisecond". The panel's bug
 * report was a spec for a bug that was still live here.
 *
 * Keying on the token rather than using a bare module-level promise matters:
 * two different tokens (different customers, or a stale tab) must not share an
 * exchange. The entry is deleted in a `finally` so a later expiry refreshes
 * again rather than replaying a resolved promise.
 */
const inFlightRefreshes = new Map<string, ReturnType<RekeyBrowserClient['refresh']>>();

function dedupedRefresh(
  client: RekeyBrowserClient,
  refresh: string,
): ReturnType<RekeyBrowserClient['refresh']> {
  const existing = inFlightRefreshes.get(refresh);
  if (existing) return existing;
  const exchange = client.refresh(refresh).finally(() => {
    inFlightRefreshes.delete(refresh);
  });
  inFlightRefreshes.set(refresh, exchange);
  return exchange;
}

/**
 * Resolve the signed-in end-user for `slug`, refreshing once on an expired
 * access token. Returns null when signed out. Cookie writes only land when
 * called from a server action / route handler (Next limitation).
 *
 * `cache()`d per request, which is the other half of the fix above: the layout,
 * the page and the login redirect guard all ask the same question during one
 * render, and without memoisation each one issued its own `getCurrentUser`
 * round-trip. Deduping the refresh stops the sign-outs; deduping this stops the
 * duplicate reads that provoke them.
 */
export const getPortalUser = cache(async (slug: string) => {
  const client = await portalClientFor(slug);
  if (!client) return null;
  const access = await getAccessToken();
  if (access) {
    const user = await client.getCurrentUser(access);
    if (user) return { user, accessToken: access };
  }
  const refresh = await getRefreshToken();
  if (!refresh) return null;
  try {
    const fresh = await dedupedRefresh(client, refresh);
    await setSession(slug, fresh.accessToken, fresh.refreshToken);
    const user = await client.getCurrentUser(fresh.accessToken);
    return user ? { user, accessToken: fresh.accessToken } : null;
  } catch {
    await clearSession(slug);
    return null;
  }
});
