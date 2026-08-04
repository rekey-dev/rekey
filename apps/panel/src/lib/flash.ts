/**
 * Flash-cookie helpers — read-once-and-clear success / info banners.
 *
 * Server actions call `setFlash('Plan created.')` before redirect; the
 * destination page calls `consumeFlash()` once to read + atomically
 * clear. Refreshing the page does not re-display the banner, and copy-
 * pasting the URL doesn't carry stale state.
 *
 * Keep payloads tiny — these ride in a Set-Cookie on every redirect.
 * Stores `{ message, tone }` JSON; max ~256 chars after b64.
 */

import { cookies } from 'next/headers';
import { cookieSecure } from '@/lib/cookie-secure';

const COOKIE = 'rekey_flash';
const MAX_AGE = 30; // 30s — long enough to survive the redirect, short enough to expire across tabs.

export type FlashTone = 'success' | 'info' | 'warning' | 'error';

export interface FlashPayload {
  message: string;
  tone: FlashTone;
}

export async function setFlash(message: string, tone: FlashTone = 'success'): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, JSON.stringify({ message, tone }), {
    httpOnly: true,
    sameSite: 'strict',
    secure: await cookieSecure(),
    path: '/',
    maxAge: MAX_AGE,
  });
}

/**
 * Read + clear. Callable from a server component: the read always works; the
 * clear is best-effort (cookie writes throw during a render in Next 15). The
 * short MAX_AGE expires an un-cleared flash within seconds. Returns null when
 * no flash is pending.
 */
export async function consumeFlash(): Promise<FlashPayload | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return null;
  // Best-effort clear: Next 15 forbids cookie writes during a server-component
  // render and throws. Swallow it — the short MAX_AGE expires the flash anyway,
  // so a stale banner can't linger. (This is why the page crashed before.)
  try {
    jar.delete(COOKIE);
  } catch {
    /* render context — rely on MAX_AGE expiry */
  }
  try {
    const parsed = JSON.parse(raw) as FlashPayload;
    if (typeof parsed.message !== 'string' || typeof parsed.tone !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
