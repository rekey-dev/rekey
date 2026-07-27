/**
 * Cookie-session helpers — mirrors examples/nextjs-saas/src/lib/session.ts.
 *
 * `auth()` from @rekey.dev/nextjs/server reads the httpOnly cookies, refreshes
 * once when the access token expired, and returns `{ user, accessToken }` or
 * null. The portal adds `requireSession()` (redirect to /login when signed
 * out) and `getAppName()` for the header.
 */

import 'server-only';
import './env'; // must run before @rekey.dev/nextjs/server builds its client
import { redirect } from 'next/navigation';
import { auth, type Session } from '@rekey.dev/nextjs/server';
import { rekey } from './relipay';

export type { Session };

/** Current session from cookies, or null when signed out. */
export async function getSession(): Promise<Session | null> {
  return auth();
}

/** Like getSession(), but bounce to /login when there's no session. */
export async function requireSession(): Promise<Session> {
  const session = await auth();
  if (!session) redirect('/login');
  return session;
}

/**
 * Display name for the portal header: PORTAL_APP_NAME override, else the
 * Application's own name from the API, else a neutral fallback.
 */
export async function getAppName(): Promise<string> {
  if (process.env.PORTAL_APP_NAME) return process.env.PORTAL_APP_NAME;
  try {
    const me = await rekey.applications.me();
    return me.name;
  } catch {
    return 'Billing portal';
  }
}
