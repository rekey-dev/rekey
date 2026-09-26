/**
 * Per-app portal session, httpOnly cookies, **scoped to the app's path**
 * (`/<slug>`) so app A's session can't be replayed on app B under the shared
 * portal host. Tokens never reach client JS.
 */

import 'server-only';
import { createHash } from 'node:crypto';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { RekeyBrowserClient, RekeyError } from '@rekey.dev/react';
import { neverConnected } from '@rekey.dev/shared-types/transport';
import { rekeyApiUrl } from './env';
import { PortalConfigUnavailableError, getPortalConfig, type PortalConfig } from './config';
import { cookieSecure } from './cookie-secure';
import { API_TIMEOUT_MS, forwardedClientHeaders } from './client-ip';
import {
  RACED_COOKIE,
  RACED_MARK_MAX_AGE_SECONDS,
  REFRESH_RACED_CODE,
  RETURN_TO_HEADER,
  isGatewayFailure,
  racedMark,
  refreshRouteFor,
  wasIssuedRecently,
} from './session-refresh';

export const ACCESS = 'rekey_portal_access';
export const REFRESH = 'rekey_portal_refresh';
// Fallbacks only: the API's lifetimes are deployment settings and every auth
// response carries the expiries, which `writeSession` prefers.
const ACCESS_MAX_AGE = 60 * 15;
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

function secondsUntil(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  return Number.isNaN(ms) ? null : Math.max(60, Math.floor(ms / 1000));
}

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
  // The SDK's calls run on the portal server too (sign-in, MFA, refresh), so
  // they carry the vouched visitor address and a timeout like every other
  // portal call (lib/client-ip.ts). Sign-in limits are per client IP.
  const forwarded = await forwardedClientHeaders();
  const portalFetch: typeof fetch = (input, init) => {
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(forwarded)) merged.set(name, value);
    return fetch(input, { ...init, headers: merged, signal: init?.signal ?? AbortSignal.timeout(API_TIMEOUT_MS) });
  };
  return new RekeyBrowserClient({
    apiUrl: rekeyApiUrl(),
    publishableKey: config.publishableKey,
    fetch: portalFetch,
  });
}

type Expiries = { accessTokenExpiresAt?: string; refreshTokenExpiresAt?: string };

/** Anything cookies can be set on: the `cookies()` jar, or a response's. */
interface CookieSink {
  set(
    name: string,
    value: string,
    options: { httpOnly: boolean; sameSite: 'lax'; secure: boolean; path: string; maxAge: number },
  ): unknown;
}

/**
 * The session cookies for `slug`, written to `sink`. The refresh route writes
 * them onto its own redirect response.
 */
export async function writeSession(
  sink: CookieSink,
  slug: string,
  accessToken: string,
  refreshToken: string,
  expiries: Expiries = {},
): Promise<void> {
  sink.set(ACCESS, accessToken, await cookieOpts(slug, secondsUntil(expiries.accessTokenExpiresAt) ?? ACCESS_MAX_AGE));
  sink.set(REFRESH, refreshToken, await cookieOpts(slug, secondsUntil(expiries.refreshTokenExpiresAt) ?? REFRESH_MAX_AGE));
}

/** Both session cookies for `slug`, expired, written to `sink`. */
export async function clearSessionOn(sink: CookieSink, slug: string): Promise<void> {
  sink.set(ACCESS, '', await cookieOpts(slug, 0));
  sink.set(REFRESH, '', await cookieOpts(slug, 0));
}

/**
 * Server Actions and Route Handlers only. A Server Component render cannot
 * write cookies and this throws there, deliberately. The render-time caller
 * used to be the silent refresh in `getPortalUser`, and swallowing the error
 * there is what left a spent refresh token in the browser.
 */
export async function setSession(
  slug: string,
  accessToken: string,
  refreshToken: string,
  expiries: Expiries = {},
): Promise<void> {
  await writeSession(await cookies(), slug, accessToken, refreshToken, expiries);
}

export async function clearSession(slug: string): Promise<void> {
  await clearSessionOn(await cookies(), slug);
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
 * Refresh exchanges IN FLIGHT, keyed by a SHA-256 digest of the refresh token
 * being spent (never the token itself).
 *
 * Refresh tokens rotate and are single-use: the first exchange invalidates the
 * presented token, and a second exchange of the same token is refused. So
 * callers presenting the same token at the same moment wait on one exchange.
 * The portal used to make that collision the default: `[slug]/layout.tsx` and
 * `[slug]/page.tsx` both call `getPortalUser(slug)` and React renders them
 * concurrently, the same failure the panel diagnosed in production ("5 of 8
 * refreshes in a 40-minute session returned 401").
 *
 * An entry is deleted the moment its exchange settles. A request that arrives
 * after that (a prefetch or a second tab sent before the new cookie landed)
 * goes to the API with the token it holds, and the API decides: a token it
 * rotated moments ago is `REFRESH_TOKEN_RACED`, refused with nothing revoked,
 * and the raced handling sends the browser back with whatever it holds by
 * then. This map used to keep a settled pair for ten seconds and hand it to
 * any later request presenting the spent cookie, which re-issued a live
 * session to a copy of that cookie without the API ever seeing the request.
 *
 * Keyed per token, not a bare module-level promise: two different tokens
 * (different customers, or a stale tab) must not share an exchange.
 */
const refreshExchanges = new Map<string, Promise<RefreshOutcome>>();

/**
 * What a refresh came to.
 *
 *   - `ok`: rotated. The caller must persist `fresh`.
 *   - `busy`: the token is unspent and the session intact. A 429 (the API's
 *     limiter answers before the refresh handler runs), or a 502/503/504 with
 *     no Rekey error body (a proxy answering while the API restarts: the
 *     request never reached it), or a connection that was never made
 *     (refused, DNS failure, connect timeout).
 *   - `failed`: anything else, and the session is treated as over. That
 *     includes a 5xx the API itself answered, or a timeout: the API may have
 *     rotated before we stopped listening, and presenting the token again
 *     would be a replay. Those set `interrupted`, so sign-in can say the
 *     session was interrupted rather than expired.
 *   - `raced`: `REFRESH_TOKEN_RACED`. Another request rotated this token
 *     moments ago and nothing was revoked, so the session lives on in the pair
 *     that request received. The caller leaves the session cookies alone,
 *     writes `mark` to `RACED_COOKIE` and lets the browser retry with what it
 *     holds next. Returned once per token: when the browser already carries
 *     this token's mark it comes back as `failed` (see `RACED_COOKIE` in
 *     `lib/session-refresh.ts` for why a repeat clears the spent token).
 */
export type RefreshOutcome =
  | { kind: 'ok'; fresh: Awaited<ReturnType<RekeyBrowserClient['refresh']>> }
  | { kind: 'busy'; retryAfterSeconds: number }
  | { kind: 'raced'; mark: string }
  | { kind: 'failed'; interrupted?: boolean };

async function exchange(client: RekeyBrowserClient, refresh: string): Promise<RefreshOutcome> {
  try {
    return { kind: 'ok', fresh: await client.refresh(refresh) };
  } catch (err) {
    if (err instanceof RekeyError && err.statusCode === 429) {
      return { kind: 'busy', retryAfterSeconds: err.retryAfterSeconds ?? 5 };
    }
    if (err instanceof RekeyError && isGatewayFailure(err)) {
      return { kind: 'busy', retryAfterSeconds: err.retryAfterSeconds ?? 5 };
    }
    // The browser client lets `fetch`'s own error through. A refused
    // connection or a failed DNS lookup never reached the API: every self-host
    // redeploy, where the portal talks to the API container directly.
    if (neverConnected(err instanceof RekeyError ? err.cause : err)) {
      return { kind: 'busy', retryAfterSeconds: 5 };
    }
    // The one refusal that is not terminal, checked before the rest fall
    // through to `failed`.
    if (err instanceof RekeyError && err.statusCode === 401 && err.code === REFRESH_RACED_CODE) {
      return { kind: 'raced', mark: await racedMark(refresh) };
    }
    // A refusal is a verdict on the token. Anything else (the API's own 5xx,
    // a timeout, a dropped connection) may have come after the rotation.
    const refused = err instanceof RekeyError && typeof err.statusCode === 'number' && err.statusCode < 500;
    return refused ? { kind: 'failed' } : { kind: 'failed', interrupted: true };
  }
}

/**
 * Spend `refresh` for a new pair. Only call it where the result can be
 * written: a Server Action or a Route Handler.
 *
 * `seenMark` is the browser's `RACED_COOKIE` value, if any: the loop guard is
 * per browser, so it is applied here rather than inside the exchange that
 * concurrent callers share.
 */
export async function refreshPortalSession(
  client: RekeyBrowserClient,
  refresh: string,
  seenMark?: string | null,
): Promise<RefreshOutcome> {
  const outcome = await sharedExchange(client, refresh);
  if (outcome.kind === 'raced' && seenMark === outcome.mark) return { kind: 'failed' };
  return outcome;
}

/** Set the raced-refresh loop guard for `slug`. Touches no session cookie. */
export async function writeRacedMark(sink: CookieSink, slug: string, mark: string): Promise<void> {
  sink.set(RACED_COOKIE, mark, await cookieOpts(slug, RACED_MARK_MAX_AGE_SECONDS));
}

function sharedExchange(client: RekeyBrowserClient, refresh: string): Promise<RefreshOutcome> {
  // Hashed synchronously: nothing may await between this lookup and the
  // insert below, or two concurrent callers could both miss and both rotate.
  const key = createHash('sha256').update(refresh).digest('hex');
  const existing = refreshExchanges.get(key);
  if (existing) return existing;
  const pending = exchange(client, refresh);
  refreshExchanges.set(key, pending);
  void pending.finally(() => {
    if (refreshExchanges.get(key) === pending) refreshExchanges.delete(key);
  });
  return pending;
}

/**
 * Can this context write cookies?
 *
 * Next seals the cookie jar outside a Server Action or Route Handler; `set` and
 * `delete` both throw there. The probe deletes a cookie nobody sets. Same probe
 * as `canWriteCookies` in `@rekey.dev/nextjs/server`, and asked for the same
 * reason: BEFORE refreshing, because a refresh whose result cannot be stored
 * leaves the browser holding a spent token, and its next request is a replay.
 */
async function canWriteCookies(jar: Awaited<ReturnType<typeof cookies>>): Promise<boolean> {
  try {
    jar.delete(PROBE_COOKIE);
    return true;
  } catch {
    return false;
  }
}

/** Deleting a cookie nothing ever sets. */
const PROBE_COOKIE = '__rekey_probe';

/**
 * `getPortalConfig` for a page render.
 *
 * When the lookup fails (the API is redeploying, or not listening) and the
 * visitor holds a refresh cookie, this redirects to the refresh route instead
 * of throwing. That route answers the 503 retry page with `Retry-After`, keeps
 * the cookies, and once the API is back refreshes and returns the visitor to
 * the page they asked for. Without a session there is nothing to keep, and the
 * error propagates to the error page as before.
 */
export async function getPortalConfigOrRefresh(slug: string): Promise<PortalConfig | null> {
  try {
    return await getPortalConfig(slug);
  } catch (err) {
    if (err instanceof PortalConfigUnavailableError && (await getRefreshToken())) {
      redirect(refreshRouteFor(slug, (await headers()).get(RETURN_TO_HEADER)));
    }
    throw err;
  }
}

/**
 * Resolve the signed-in end-user for `slug`. Returns null when signed out.
 *
 * **Never spends a refresh token it cannot store.** From a Server Component,
 * which cannot write cookies, an expired access token is not refreshed here:
 * the render redirects to `/<slug>/session/refresh`, which rotates, writes
 * the cookies and comes back. The middleware sends most stale sessions there
 * before anything renders; this covers an access cookie the API refused.
 * From a Server Action or Route Handler it refreshes in place.
 *
 * A token minted in the last minute that the API still refuses is not sent
 * round again, since that is the refresh route's own result and another lap
 * would only rotate again. It reads as signed out.
 *
 * `cache()`d per request: the layout, the page and the login redirect guard
 * all ask the same question during one render.
 */
export const getPortalUser = cache(async (slug: string) => {
  if (!(await getPortalConfigOrRefresh(slug))) return null;
  const client = await portalClientFor(slug);
  if (!client) return null;
  const access = await getAccessToken();
  if (access) {
    const user = await client.getCurrentUser(access);
    if (user) return { user, accessToken: access };
  }
  const refresh = await getRefreshToken();
  if (!refresh) return null;
  if (wasIssuedRecently(access)) return null;

  const jar = await cookies();
  if (!(await canWriteCookies(jar))) {
    redirect(refreshRouteFor(slug, (await headers()).get(RETURN_TO_HEADER)));
  }

  const outcome = await refreshPortalSession(client, refresh, jar.get(RACED_COOKIE)?.value);
  if (outcome.kind === 'busy') return null;
  if (outcome.kind === 'raced') {
    // Signed out for THIS request only, as with `busy`: the session cookies
    // stay, so the next request carries the pair the winning request stored.
    await writeRacedMark(jar, slug, outcome.mark);
    return null;
  }
  if (outcome.kind === 'failed') {
    await clearSession(slug);
    return null;
  }
  const { fresh } = outcome;
  await setSession(slug, fresh.accessToken, fresh.refreshToken, fresh);
  const user = await client.getCurrentUser(fresh.accessToken);
  return user ? { user, accessToken: fresh.accessToken } : null;
});
