/**
 * Per-app portal session — httpOnly cookies, **scoped to the app's path**
 * (`/<slug>`) so app A's session can't be replayed on app B under the shared
 * portal host. Tokens never reach client JS.
 */

import 'server-only';
import { cookies } from 'next/headers';
import { RekeyBrowserClient } from '@rekey.dev/react';
import { rekeyApiUrl } from './env';
import { getPortalConfig } from './config';

const ACCESS = 'rekey_portal_access';
const REFRESH = 'rekey_portal_refresh';
const ACCESS_MAX_AGE = 60 * 15; // 15 min
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function cookieOpts(slug: string, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
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
    jar.set(ACCESS, accessToken, cookieOpts(slug, ACCESS_MAX_AGE));
    jar.set(REFRESH, refreshToken, cookieOpts(slug, REFRESH_MAX_AGE));
  } catch (err) {
    tolerateRenderContext(err);
  }
}

export async function clearSession(slug: string): Promise<void> {
  try {
    const jar = await cookies();
    jar.set(ACCESS, '', cookieOpts(slug, 0));
    jar.set(REFRESH, '', cookieOpts(slug, 0));
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
 * Resolve the signed-in end-user for `slug`, refreshing once on an expired
 * access token. Returns null when signed out. Cookie writes only land when
 * called from a server action / route handler (Next limitation).
 */
export async function getPortalUser(slug: string) {
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
    const fresh = await client.refresh(refresh);
    await setSession(slug, fresh.accessToken, fresh.refreshToken);
    const user = await client.getCurrentUser(fresh.accessToken);
    return user ? { user, accessToken: fresh.accessToken } : null;
  } catch {
    await clearSession(slug);
    return null;
  }
}
