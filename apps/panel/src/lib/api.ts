/**
 * Panel API client, calls the operator surface (`/api/v1/tenant/*`).
 *
 * Two cookies, both httpOnly + SameSite=Lax (see `setSessionCookies` for why
 * not Strict) + Secure whenever the request wasn't plain-HTTP loopback:
 *   - rekey_access , short-lived operator JWT (OPERATOR_ACCESS_TOKEN_TTL_SECONDS on the API)
 *   - rekey_refresh, long-lived opaque token (OPERATOR_REFRESH_TOKEN_TTL_DAYS)
 *
 * Auto-refresh on 401: when the access token expires, we exchange the
 * refresh token, rotate cookies, and retry the original request once.
 * If even refresh fails, both cookies are cleared and the user lands on
 * /login?reason=expired. A 429 or 503 is not a failure of either kind: it
 * throws a retryable busy error instead (see `lib/api-busy.ts`).
 *
 * Server-only module, never import from a client component.
 */

import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { forbidden, notFound, redirect } from 'next/navigation';
import { cookieSecure } from './cookie-secure';
import { CLIENT_IP_SOURCE_HEADER, clientIpFrom } from '@/lib/client-ip';
import { busyDigest, isApiBusyStatus, parseRetryAfter } from '@/lib/api-busy';

export const ACCESS_COOKIE = 'rekey_access';
export const REFRESH_COOKIE = 'rekey_refresh';

interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    fix?: string;
    docs?: string;
    requestId?: string;
    retryAfterSeconds?: number;
  };
}

export class PanelApiError extends Error {
  public readonly code: string;
  public readonly fix: string | undefined;
  public readonly statusCode: number;
  public readonly requestId: string | undefined;
  /** Set on a 429 / 503: how long the API asked us to wait. */
  public readonly retryAfterSeconds: number | undefined;
  /**
   * Set only on a busy error (429 / 503), and deliberately: it is the one
   * field Next forwards to a client error boundary in production. See
   * `lib/api-busy.ts`.
   */
  public readonly digest: string | undefined;
  constructor(args: {
    code: string;
    message: string;
    fix?: string;
    statusCode: number;
    requestId?: string;
    retryAfterSeconds?: number;
  }) {
    super(args.message);
    this.name = 'PanelApiError';
    this.code = args.code;
    this.fix = args.fix;
    this.statusCode = args.statusCode;
    this.requestId = args.requestId;
    this.retryAfterSeconds = args.retryAfterSeconds;
    this.digest =
      isApiBusyStatus(args.statusCode) && args.retryAfterSeconds !== undefined
        ? busyDigest(args.statusCode, args.retryAfterSeconds)
        : undefined;
  }
}

/**
 * The API answered "not now" (429 rate limited, 503 dependency down) rather
 * than "no". Retrying later will work; nothing about the request or the
 * session is wrong.
 */
export function isApiBusy(err: unknown): err is PanelApiError {
  return err instanceof PanelApiError && isApiBusyStatus(err.statusCode) && err.retryAfterSeconds !== undefined;
}

/**
 * For the `.catch(() => [])` reads: fall back on a real failure, but let a busy
 * API through to the error boundary.
 *
 * A secondary read that fails renders an empty list, which is fine when the
 * list is decoration and a lie when it is a claim about the account ("no API
 * keys", "no plans"). A 429 is the case where that lie was most common, since
 * the rate limit trips on exactly the reads a page makes in parallel, and it
 * is also the case with a correct answer: wait and retry. So a busy error is
 * rethrown, and `(authed)/error.tsx` shows "the API is busy, retrying in Ns"
 * instead of an empty section that looks like data.
 */
export function unlessBusy<T>(fallback: () => T): (err: unknown) => T {
  return (err) => {
    if (isApiBusy(err)) throw err;
    return fallback();
  };
}

function busyError(status: number, retryAfterSeconds: number, envelope?: ErrorEnvelope['error']): PanelApiError {
  const limited = status === 429;
  return new PanelApiError({
    code: envelope?.code ?? (limited ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE'),
    message:
      envelope?.message ??
      (limited
        ? 'The Rekey API is rate limiting this panel.'
        : 'The Rekey API is temporarily unavailable.'),
    fix: envelope?.fix ?? `Retry in ${retryAfterSeconds}s.`,
    statusCode: status,
    retryAfterSeconds,
    ...(envelope?.requestId ? { requestId: envelope.requestId } : {}),
  });
}

function apiUrl(): string {
  const url = process.env.REKEY_URL;
  if (!url) {
    throw new PanelApiError({
      code: 'PANEL_API_URL_MISSING',
      message: 'REKEY_URL is not set on the panel deployment.',
      fix: 'Set REKEY_URL=https://your-rekey.example.com in the panel environment.',
      statusCode: 500,
    });
  }
  return url.replace(/\/$/, '');
}

/**
 * Forward the operator's real client IP to the API. The browser→panel→API hop
 * otherwise hides it, the API sees the panel container's address (10.x inside
 * Docker), which is what ends up in the audit log / session list and what the
 * API's per-IP sign-in and refresh limits key on. Exactly one address, chosen
 * by `middleware.ts` from `PANEL_TRUSTED_PROXIES` and `PANEL_PROXY_SECRET` (see
 * `client-ip.ts` for why nothing but the configured proxy may choose it).
 * Best-effort: returns {} if headers aren't available.
 */
async function forwardedClientHeaders(): Promise<Record<string, string>> {
  try {
    const h = await headers();
    // Already reduced to one trusted address by `middleware.ts`.
    const ip = clientIpFrom(h.get('x-forwarded-for'));
    return ip ? { 'x-forwarded-for': ip } : {};
  } catch {
    return {};
  }
}

export const CALLER_SECRET_HEADER = 'x-rekey-caller-secret';

export const CLIENT_IP_HEADER = 'x-rekey-client-ip';

/**
 * Every server-side request header that identifies the panel to the API as a
 * caller, beyond the operator's own token: the one validated client IP in
 * `X-Forwarded-For`, and, when `INTERNAL_CALLER_SECRET` is set,
 * `X-Rekey-Caller-Secret` plus `X-Rekey-Client-Ip` (the visitor, only when
 * the middleware validated one).
 *
 * The secret lets the API believe the forwarded IP whatever network path the
 * call took. On Rekey Cloud the panel reaches the API through its public
 * origin (Cloudflare, then Traefik), so without it the API sees the panel
 * host's egress address for every operator.
 *
 * Only ever sent to `REKEY_URL`: every caller of this builds its URL from
 * `apiUrl()` or `REKEY_URL`. It is read from the server environment at request
 * time (no `NEXT_PUBLIC_` prefix, so never inlined into a client bundle),
 * never returned from a render, and never logged. Unset sends nothing extra.
 */
export async function apiCallerHeaders(): Promise<Record<string, string>> {
  const secret = process.env.INTERNAL_CALLER_SECRET?.trim();
  const forwarded = await forwardedClientHeaders();
  if (!secret) return forwarded;
  // With the secret, the API reads the visitor from `X-Rekey-Client-Ip`, not
  // from `X-Forwarded-For`, which the proxies between here and the API append
  // to. Sent only when the middleware vouched for the address as the
  // visitor's; otherwise omitted, never the panel's own, a proxy's, or a
  // placeholder.
  const visitor = await validatedVisitorIp();
  return {
    ...forwarded,
    [CALLER_SECRET_HEADER]: secret,
    ...(visitor ? { [CLIENT_IP_HEADER]: visitor } : {}),
  };
}

async function validatedVisitorIp(): Promise<string | null> {
  try {
    const h = await headers();
    const source = h.get(CLIENT_IP_SOURCE_HEADER);
    if (source !== 'peer' && source !== 'proxy') return null;
    return clientIpFrom(h.get('x-forwarded-for'));
  } catch {
    return null;
  }
}

const ONE_DAY = 60 * 60 * 24;

/** Seconds until an ISO instant, floored at one minute; null when absent or unparseable. */
function secondsUntil(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.max(60, Math.floor(ms / 1000));
}

/** The `exp` claim of a JWT, read without verifying (cookie lifetime only). */
function jwtExpiryIso(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cookie lifetimes for a session, from the auth response's expiries. Shared
 * with the route handlers (magic link, OAuth callback, cloud handoff) that set
 * cookies on a Response rather than through `cookies()`.
 */
export function sessionCookieMaxAges(result: {
  accessToken: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
}): { access: number; refresh: number } {
  return {
    access: secondsUntil(result.accessTokenExpiresAt ?? jwtExpiryIso(result.accessToken)) ?? 60 * 15,
    refresh: secondsUntil(result.refreshTokenExpiresAt) ?? ONE_DAY * 30,
  };
}

export async function setSessionCookies(args: {
  accessToken: string;
  refreshToken: string;
  /**
   * From the auth response. The API's lifetimes are deployment settings
   * (OPERATOR_*_TTL), so the cookies follow what the API says rather than a
   * constant of their own; without them the access cookie follows the JWT's
   * own expiry and the refresh cookie falls back to 30 days.
   */
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
}): Promise<void> {
  const jar = await cookies();
  const secure = await cookieSecure();
  const { access: accessMaxAge, refresh: refreshMaxAge } = sessionCookieMaxAges(args);
  // `lax`, not `strict`: an operator can legitimately ARRIVE at the panel via a
  // top-level cross-site navigation, most importantly the MCP OAuth consent
  // flow, which enters /mcp-consent through a redirect that originated at the
  // MCP client (claude). `strict` withholds the session on any cross-site-
  // initiated navigation, so the operator looked logged-out and was forced to
  // re-login on every connect attempt. `lax` sends the session on top-level GET
  // navigations while still withholding it on cross-site POST/subresource
  // requests (the CSRF surface). Next server actions carry their own origin check.
  jar.set(ACCESS_COOKIE, args.accessToken, {
    httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: accessMaxAge,
  });
  jar.set(REFRESH_COOKIE, args.refreshToken, {
    httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: refreshMaxAge,
  });
}

export async function clearSessionCookies(): Promise<void> {
  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}

/**
 * Best-effort cookie clear: doesn't throw if called from a server component
 * (Next 15 forbids cookie writes outside server actions / route handlers).
 * Used inside the `api()` 401 handler, if we can't clear inline, the
 * /sign-out redirect picks up and a Route Handler does it.
 */
async function clearSessionCookiesSafe(): Promise<boolean> {
  try {
    await clearSessionCookies();
    return true;
  } catch {
    return false;
  }
}

/** Same try/catch pattern for write, server components can't `set`. */
async function setSessionCookiesSafe(args: {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
}): Promise<boolean> {
  try {
    await setSessionCookies(args);
    return true;
  } catch {
    return false;
  }
}

/**
 * In-flight refresh exchanges, keyed by the refresh token being spent.
 *
 * Refresh tokens rotate and are single-use: the first exchange invalidates the
 * presented token, so a second concurrent exchange of the SAME token gets a
 * 401. That is correct server behaviour, reuse detection is a security
 * feature, but every RSC on a page calls `api()` independently, so a
 * navigation after the access token expires fires several 401s at
 * once and each one tried to refresh. One won; the rest were told their token
 * was already spent and bounced the operator to `/login?reason=expired`,
 * discarding whatever they had typed.
 *
 * Observed live: 5 of 8 refreshes in a 40-minute session returned 401, with
 * pairs landing in the same millisecond, throwing the operator out roughly
 * every quarter of an hour.
 *
 * Keying on the token rather than using a bare module-level promise matters:
 * two different tokens (different operators, or a stale tab) must not share an
 * exchange. The entry is deleted in a `finally` so a later expiry refreshes
 * again rather than replaying a resolved promise.
 */
const inFlightRefreshes = new Map<string, Promise<RefreshOutcome>>();

/**
 * What a refresh attempt came to.
 *
 *   - `ok`: new access token, cookies rotated.
 *   - `failed`: the session is over (refresh refused, no refresh cookie, or the
 *     new cookies could not be written from this context). The caller signs the
 *     operator out.
 *   - `busy`: the API said 429, and ONLY 429. The refresh route's limiter sets
 *     no hook, so it answers at `onRequest`, before the refresh handler runs
 *     and before the body is even parsed: a 429 never rotated anything, so the
 *     refresh token is unspent and the session is intact.
 *     Signing out here turned "the API is briefly overloaded" into "every
 *     operator on this deployment is logged out".
 *
 * Everything else that is not a success stays `failed`, a 503 included, on
 * purpose. The API's `refresh()` commits the rotation FIRST and only then reads
 * the user and memberships; if Postgres drops during those reads, the error
 * handler answers 503 with a Retry-After while the presented token is already
 * spent. Retrying it would present a spent token, the API would answer
 * `REFRESH_TOKEN_REUSED`, and reuse detection revokes every session the
 * operator has on every device. Signing out of this one session is the lesser
 * harm. A timeout or network error is `failed` for the same reason: the API may
 * have rotated before we stopped listening. (Moving those reads before the
 * rotation in the API would make a 503 safe to retry; that is an API change.)
 */
type RefreshOutcome =
  | { kind: 'ok'; accessToken: string }
  | { kind: 'failed' }
  | { kind: 'busy'; status: number; retryAfterSeconds: number; envelope?: ErrorEnvelope['error'] };

/**
 * Attempt token refresh. Concurrent callers presenting the same refresh token
 * share one exchange.
 */
async function tryRefresh(): Promise<RefreshOutcome> {
  const jar = await cookies();
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (!refresh) return { kind: 'failed' };

  const existing = inFlightRefreshes.get(refresh);
  if (existing) return existing;

  const exchange = exchangeRefreshToken(refresh).finally(() => {
    inFlightRefreshes.delete(refresh);
  });
  inFlightRefreshes.set(refresh, exchange);
  return exchange;
}

async function exchangeRefreshToken(refresh: string): Promise<RefreshOutcome> {
  try {
    const res = await fetch(`${apiUrl()}/api/v1/tenant/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await apiCallerHeaders()) },
      body: JSON.stringify({ refreshToken: refresh }),
      cache: 'no-store',
      // Every 401 in the panel waits on this one exchange, so a hung refresh
      // stalls the whole page rather than one request. Failing it returns null,
      // which the caller already treats as "could not refresh" and turns into a
      // sign-in bounce: a worse outcome than a working session, and a far
      // better one than a page that never renders.
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as
      | {
          success: true;
          data: { accessToken: string; refreshToken: string; accessTokenExpiresAt?: string; refreshTokenExpiresAt?: string };
        }
      | ErrorEnvelope;
    // 429 only: see `RefreshOutcome` for why a 503 here must sign out.
    if (res.status === 429) {
      const envelope = 'error' in json ? json.error : undefined;
      return {
        kind: 'busy',
        status: res.status,
        retryAfterSeconds: parseRetryAfter(res.headers.get('retry-after'), envelope?.retryAfterSeconds),
        ...(envelope ? { envelope } : {}),
      };
    }
    if (!res.ok || !('success' in json) || json.success === false) return { kind: 'failed' };
    const wrote = await setSessionCookiesSafe(json.data);
    if (!wrote) return { kind: 'failed' };
    return { kind: 'ok', accessToken: json.data.accessToken };
  } catch {
    return { kind: 'failed' };
  }
}

export interface RequestArgs {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  redirectOn401?: boolean;
  /**
   * Turn a 404/403 from the API into Next's `notFound()` / `forbidden()`
   * interrupts instead of a thrown `PanelApiError`.
   *
   * Defaults to TRUE for GET and false for everything else. A GET is a page
   * render: `/applications/<bad-id>/end-users` used to fall through to the
   * generic error boundary, which told the operator "Something went wrong…
   * contact support (ref …)" and offered a "Try again" button that could never
   * succeed, the UI could not tell "does not exist / not yours" apart from
   * "we are broken". A mutation is different: server actions catch
   * `PanelApiError` and re-render with a field-level message, and replacing
   * that with a whole-page 404 would lose the operator's typed input.
   */
  interruptOnAccessError?: boolean;
}

/**
 * How long a panel request may hang before it is a failure rather than a wait.
 *
 * Nothing here had a deadline, so a request that never got its headers back sat
 * on undici's default of FIVE MINUTES. That is what an operator experienced as
 * "saving goes blank and works if I refresh": while a server action's redirect
 * is in flight Next renders `null` for the page subtree, not loading.tsx, so a
 * hung fetch on the other side of that redirect is an empty page held open for
 * as long as the socket stays quiet. The record was written. Only the render
 * never arrived, and refreshing worked because it opened a new connection.
 *
 * Writes get longer because some of them are honestly slow: saving provider
 * credentials can register a webhook with Stripe, and registering a plan is a
 * round-trip to the provider. Reads have no such excuse.
 *
 * The point is not the exact number. It is that the failure becomes an error
 * boundary an operator can see and retry, instead of a blank page.
 */
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;

async function callOnce(
  method: string,
  path: string,
  body: unknown,
  accessToken: string | null,
): Promise<Response> {
  try {
    return await fetch(`${apiUrl()}${path}`, {
      method,
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(await apiCallerHeaders()),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
    });
  } catch (err) {
    // A timed-out WRITE is genuinely ambiguous and the message says so rather
    // than guessing. The request may well have been applied; we stopped
    // listening, which is not the same as it not happening. Telling an operator
    // "that failed" when it succeeded is how a provider gets configured twice.
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new PanelApiError({
        code: 'PANEL_UPSTREAM_TIMEOUT',
        message:
          method === 'GET'
            ? 'The Rekey API did not respond in time.'
            : 'The Rekey API did not respond in time. This change may or may not have been applied.',
        fix:
          method === 'GET'
            ? 'Retry. If it keeps happening, check the API deployment and its database and Redis dependencies.'
            : 'Reload this page and check whether the change is there before trying again.',
        statusCode: 504,
      });
    }
    throw err;
  }
}

export async function api<T>(args: RequestArgs): Promise<T> {
  const jar = await cookies();
  let access = jar.get(ACCESS_COOKIE)?.value ?? null;

  let res = await callOnce(args.method, args.path, args.body, access);

  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed.kind === 'ok') {
      access = refreshed.accessToken;
      res = await callOnce(args.method, args.path, args.body, access);
    } else if (refreshed.kind === 'busy') {
      // Not a sign-out: the session is fine, the API is just not answering yet.
      throw busyError(refreshed.status, refreshed.retryAfterSeconds, refreshed.envelope);
    }
  }

  const json = (await res.json().catch(() => ({}))) as
    | { success: true; data: T }
    | ErrorEnvelope;

  if (!res.ok || ('success' in json && json.success === false)) {
    if (isApiBusyStatus(res.status)) {
      const envelope = 'error' in json ? json.error : undefined;
      throw busyError(
        res.status,
        parseRetryAfter(res.headers.get('retry-after'), envelope?.retryAfterSeconds),
        envelope,
      );
    }
    if (res.status === 401) {
      if (args.redirectOn401 !== false) {
        // Server actions / route handlers can clear cookies inline. Server
        // components can't (Next 15), bounce through /sign-out which is a
        // Route Handler that does the clear and then redirects to /login.
        const cleared = await clearSessionCookiesSafe();
        if (cleared) {
          redirect('/login?reason=expired');
        } else {
          redirect('/sign-out?reason=expired');
        }
      }
    }
    // 404 → "this doesn't exist (or isn't yours)"; 403 → "you can't see this".
    // Both are answers, not failures, and both have a real page. Handled by the
    // HTTPAccessFallbackBoundary already in the tree, not-found.tsx and
    // forbidden.tsx, which keeps the chrome and offers a way back instead of
    // a dead "Try again".
    if (args.interruptOnAccessError ?? args.method === 'GET') {
      if (res.status === 404) notFound();
      if (res.status === 403) forbidden();
    }
    const err =
      'error' in json
        ? json.error
        : { code: 'PANEL_HTTP_ERROR', message: `HTTP ${res.status}` };
    throw new PanelApiError({ ...err, statusCode: res.status });
  }

  // No `revalidatePath` here, on purpose, even though every write goes through
  // this function. Every panel action ends in `redirect()`, and in Next 15.5 a
  // revalidation in the same action switches off the prefetch seed that lets
  // the redirect commit instantly, so the page renders blank for a full server
  // round-trip (vercel/next.js#73317). Calling it from here put that bug on
  // every save in the console at once.
  //
  // Freshness after a write comes from two other places instead:
  //   - the redirect destination is rendered by Next AFTER the action ran, and
  //     that render is what the router shows, so the page you land on is new;
  //   - `<RefreshAfterAction>` in `(authed)/layout.tsx` then runs one
  //     `router.refresh()`, which drops the other cached pages (up to
  //     `staleTimes.dynamic` old) that the action's response keeps around.
  // The full runtime walk-through is in `(authed)/layout.tsx`.

  return (json as { success: true; data: T }).data;
}

/**
 * The one-argument GET that `React.cache` can actually memoise.
 *
 * `api()` takes an options OBJECT, and a fresh object literal on every call is
 * a fresh cache key, so wrapping `api` itself in `cache()` would memoise
 * nothing. Reduced to `(path, interruptOnAccessError)`, two identical GETs in
 * one render hit the same entry.
 */
const cachedGet = cache(
  async (path: string, interruptOnAccessError: boolean): Promise<unknown> =>
    api<unknown>({ method: 'GET', path, interruptOnAccessError }),
);

/**
 * A GET that is fetched ONCE per request, however many components ask for it.
 *
 * Server Components have no shared render context: a layout and each of its
 * pages resolve independently, so every one of them that needs the same fact
 * fetches it again. In the panel that was not an edge case, it was the shape of
 * the whole app:
 *
 *   - `GET /tenant/applications/:id` is fetched by `applications/[id]/layout.tsx`
 *     (for the header and the nav) and then AGAIN by the page rendering inside
 *     it, 17 pages do this. Four of them (`plans`, `payments`, `dunning`,
 *     `coupons`) also render `<BillingModeBanner>`, which fetches it a THIRD
 *     time. Three identical round-trips to paint one screen.
 *   - `GET /tenant/auth/me` is fetched by `(authed)/layout.tsx` on every authed
 *     page, and again by `/applications`, `/team`, `/workspace` and
 *     `/account/security`.
 *
 * `cache()` is per-request and per-render, so this is not a data cache and
 * carries no staleness risk: two components in ONE render see one response;
 * the next navigation fetches again. (`api()` itself still sends
 * `cache: 'no-store'`.) Rejections memoise too, which is what we want, a 404
 * that becomes `notFound()` replays as the same interrupt rather than issuing a
 * second doomed request.
 *
 * Use this for any GET whose answer a page might ask for more than once. Use
 * `api()` directly for mutations, and for GETs whose path is unique per call
 * anyway (list pages with filters) where the memo is just overhead.
 */
export function apiGet<T>(path: string, opts?: { interruptOnAccessError?: boolean }): Promise<T> {
  return cachedGet(path, opts?.interruptOnAccessError ?? true) as Promise<T>;
}

/** The application record behind `/applications/[id]/*`. Memoised per request. */
export function getApplication(id: string): Promise<ApplicationRow> {
  return apiGet<ApplicationRow>(`/api/v1/tenant/applications/${encodeURIComponent(id)}`);
}

/**
 * The active workspace's ceilings and what is used against them.
 *
 * An ABSENT key under `limits` means unlimited for that resource, the default
 * for every workspace, and the state of every self-host that never sets one.
 * Never read a missing key as zero: doing so would disable the promote control
 * on every unlimited workspace, which is most of them.
 *
 * This is a hint for rendering, never the enforcement. The API re-checks every
 * quota on the acting endpoint, so a stale or wrong reading here produces a
 * clear 403, not a bypass.
 */
export function getWorkspaceLimits(): Promise<WorkspaceLimitsDto> {
  return apiGet<WorkspaceLimitsDto>('/api/v1/tenant/workspace/limits');
}

export interface WorkspaceLimitsDto {
  limits: {
    maxProductionApps?: number | null;
    maxActiveEndUsers?: number | null;
  };
  usage: {
    /** Production applications that are RUNNING, not disabled. */
    productionApps: number;
    activeEndUsers: number;
  };
}

/** The signed-in operator + their memberships. Memoised per request. */
export function getMe(): Promise<MeDto> {
  return apiGet<MeDto>('/api/v1/tenant/auth/me');
}

/**
 * Whether this deployment lets operators create additional workspaces
 * (`WORKSPACE_CREATION`), as a boolean for "render the affordance".
 *
 * Cached in the panel process, across requests, for five minutes. It is the
 * one read in the authed layout that is a DEPLOYMENT setting rather than a fact
 * about this operator or this request: the API answers it from its own
 * environment, the same for every caller, and it only changes when the API is
 * redeployed. It was costing one rate-limited call on every full render of
 * every authed page (hard loads, the render inside every save, and every
 * refresh), for an answer that had not changed since the API booted.
 *
 * Fails OPEN and never caches a failure, matching `fetchSignupMode` on the
 * sign-up page and `canManageApps` on the applications page: hiding a
 * capability the operator actually has is the worse error, and
 * `createWorkspace` in `(authed)/layout.tsx` handles the refusal properly if a
 * stale answer ever shows the button on a deployment that just turned it off.
 */
const CREATION_MODE_TTL_MS = 5 * 60_000;
let creationModeCache: { open: boolean; expiresAt: number } | null = null;

export async function getWorkspaceCreationOpen(now: number = Date.now()): Promise<boolean> {
  if (creationModeCache && creationModeCache.expiresAt > now) return creationModeCache.open;
  try {
    const d = await apiGet<{ mode: 'open' | 'disabled' }>('/api/v1/tenant/workspace/creation-mode', {
      interruptOnAccessError: false,
    });
    const open = d.mode !== 'disabled';
    creationModeCache = { open, expiresAt: now + CREATION_MODE_TTL_MS };
    return open;
  } catch {
    return true;
  }
}

/** Test seam: forget the cached creation mode. */
export function resetWorkspaceCreationModeCache(): void {
  creationModeCache = null;
}

/**
 * Whether this deployment lets operators grant subscriptions with no payment
 * provider behind them (`TENANT_SUBSCRIPTION_GRANTS`).
 *
 * A UX hint, like `creation-mode` and `signup-mode`: it decides whether the
 * affordance renders, never whether the action is allowed. The routes refuse
 * with `TENANT_SUBSCRIPTION_GRANTS_DISABLED` on their own. Degrades to
 * 'disabled' if the endpoint is unreachable; hiding a button on a deployment
 * that does support grants is recoverable by asking; offering one that 404s
 * teaches an operator to distrust the page.
 */
export function getSubscriptionGrantsMode(): Promise<'enabled' | 'disabled'> {
  return apiGet<{ mode: 'enabled' | 'disabled' }>(
    '/api/v1/tenant/workspace/subscription-grants-mode',
    { interruptOnAccessError: false },
  )
    .then((r) => r.mode)
    .catch(() => 'disabled' as const);
}

// ---------- DTOs ----------

export interface MeDto {
  user: { id: string; email: string; name: string | null };
  memberships: Array<{
    tenantId: string;
    tenantName: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    /** Resolved scopes in that workspace, or null when unrestricted (always null for OWNER/ADMIN). */
    scopes: string[] | null;
  }>;
  activeTenantId: string;
  activeRole: 'OWNER' | 'ADMIN' | 'MEMBER';
}

export interface ApplicationRow {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  /**
   * What this application IS. The isolation boundary in Rekey, real customers
   * and rehearsals live in different Applications, not different "modes".
   * The prefix its API keys carry follows from it; it does not restrict
   * which billing credentials the app may hold.
   */
  environment: 'PRODUCTION' | 'STAGING' | 'DEVELOPMENT';
  /**
   * When this application was PROMOTED into production, or null. Null on a
   * production application means it was created production rather than
   * promoted, the two are different events and only one has a date.
   */
  promotedAt?: string | null;
  /**
   * Set while the application is frozen. A disabled application refuses every
   * end-user request, serves no hosted portal and sends no mail, while every
   * operator surface (including this panel) stays fully readable. Nothing is
   * deleted; re-enabling restores it exactly.
   */
  disabledAt?: string | null;
  /** The operator's own note recorded at the time of the freeze. */
  disabledReason?: string | null;
  publicKey: string;
  /** Previous publishable key during a rotation grace window (null otherwise). */
  previousPublicKey?: string | null;
  /** When the previous publishable key stops verifying (null when not rotating). */
  previousPublicKeyValidUntil?: string | null;
  authConfig: {
    methods: string[];
    passwordMinLength: number;
    redirectUrls: string[];
    /** Base URL of the operator's own app. Canonical; redirectUrls infers it. */
    appUrl?: string;
    signupEnabled?: boolean;
    signupMode?: 'public' | 'secret_only' | 'invite_only';
    mfa?: 'off' | 'optional' | 'required';
    mcpEnabled?: boolean;
    /** Application acts as an OpenID Connect provider. Independent of `mcpEnabled`. */
    oidcEnabled?: boolean;
    organizationsEnabled?: boolean;
    passwordBreachCheckEnabled?: boolean;
    sendVerificationEmailOnSignUp?: boolean;
    requireEmailVerification?: boolean;
    /**
     * Whether a sign-in must carry a device fingerprint. `required` refuses
     * one that does not; `optional` binds the device when a fingerprint is
     * sent and lets the sign-in through when it is not.
     */
    deviceBinding?: 'optional' | 'required';
  };
  billingConfig: {
    /** Master switch. When false the whole billing surface is gated server-side. */
    enabled: boolean;
    /** Failed-payment recovery (reminders + day-14 auto-cancel). Off by default. */
    dunningEnabled?: boolean;
    /** Default billing subject: individual end-user, or their organization. */
    billingSubject?: 'user' | 'org';
    /**
     * Free-tier fallback. Slug of a plan whose FEATURE entitlements and
     * included usage quota apply to end-users with NO active subscription.
     * Read-time only: no Subscription row stands behind it, so a user on the
     * default plan shows an empty subscriptions list while still being
     * entitled. Unset = no free tier.
     */
    defaultPlanSlug?: string;
    provider: string;
    currency: string;
    metadata: Record<string, unknown>;
  };
  oauthConfig: Record<string, { clientId: string; redirectUri: string; scopes?: string[] }>;
  /** Per-app network access controls (CIDRs/IPs for secret keys; CORS origins). */
  ipAllowlist?: string[];
  corsOrigins?: string[];
  /** Hosted customer portal (Portal V2) settings. */
  hostedPortalEnabled?: boolean;
  portalDomain?: string | null;
  portalDomainVerifiedAt?: string | null;
  portalBranding?: Record<string, unknown>;
  /** Public MCP server URL, computed API-side from PUBLIC_WEBHOOK_BASE_URL/API_URL. */
  mcpUrl?: string;
  /**
   * How the caller reached this Application and their effective scopes on it.
   * The panel renders navigation from `scopes`: a section whose scope is
   * absent is not shown, rather than shown and refused. Optional only for the
   * moment between deploys; the API always sends it.
   */
  access?: { level: string; scopes: string[] };
  createdAt: string;
}

/** Per-application dashboard stats, GET /tenant/applications/:id/stats. */
export interface ApplicationStatsRow {
  users: {
    total: number;
    verified: number;
    newLast7d: number;
    newLast30d: number;
    signupTrend: Array<{ date: string; count: number }>;
  };
  security: {
    eventsLast30d: number;
    signInsLast30d: number;
    signUpsLast30d: number;
  };
  billing: {
    enabled: boolean;
    activeSubscriptions: number;
    plansActive: number;
    plansTotal: number;
  };
  usage: {
    creditsOutstanding: number;
    usageLast30d: number;
  };
}

export interface SecurityEventRow {
  id: string;
  type: string;
  actorType: string;
  actorId: string | null;
  applicationId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OperatorSessionRow {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
}

/** One row of the per-request access log (api_request_logs). */
export interface ApiRequestLogRow {
  id: string;
  method: string;
  routePath: string;
  statusCode: number;
  durationMs: number;
  applicationId: string | null;
  tenantId: string | null;
  operatorUserId: string | null;
  ip: string | null;
  /** The membership scope that admitted the request, when a scope gate ran. Null otherwise. */
  admittedScope?: string | null;
  createdAt: string;
}

export interface PlanRow {
  id: string;
  applicationId: string;
  slug: string;
  name: string;
  amount: number;
  currency: string;
  interval: 'MONTH' | 'YEAR';
  kind: 'SUBSCRIPTION' | 'LICENSE' | 'USAGE' | 'CREDIT';
  licenseKind: 'PERPETUAL' | 'TIMED' | 'SEATS' | null;
  licenseSeatsAllowed: number | null;
  licenseDurationDays: number | null;
  meterSlug: string | null;
  pricePerUnitCents: number | null;
  creditsAmount: number | null;
  active: boolean;
  /**
   * Whether this plan is registered with the payment provider.
   *
   * A plan is written un-purchasable FIRST and promoted only once the provider
   * accepts it, so PENDING/FAILED means the row exists but nothing can be sold
   * against it. FAILED carries the provider's own refusal in
   * `registrationError`, usually a bad stored credential.
   */
  registrationStatus: 'NOT_REQUIRED' | 'PENDING' | 'REGISTERED' | 'FAILED';
  registrationError: string | null;
  /**
   * Whether a buyer sent to checkout for this plan would actually get one.
   *
   * Distinct from `registrationStatus`, which only reports how the CREATE went.
   * `NOT_REQUIRED` covers two different plans: one on a provider that registers
   * lazily at first checkout (PayPal, Razorpay, fine), and one created before
   * this Application had any credentials, which was never registered and never
   * will be, because connecting a provider afterwards does not reach back and
   * repair plans that already exist. The second is the dangerous one and it is
   * invisible anywhere else: it lists, it is `active`, the pricing page renders
   * a Buy button, and the first thing that disagrees is a buyer clicking it.
   *
   * Optional because an older API predates the field. Treat absent as ready
   * rather than inventing a warning we cannot substantiate.
   */
  checkout?: {
    ready: boolean;
    blockers: Array<{
      /** null when the blocker belongs to no one provider (none configured). */
      provider: string | null;
      code: string;
      message: string;
      fix: string;
    }>;
  };
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OrgBillingDto {
  creditBalance: number;
  features: Record<string, boolean | number | string>;
  entitlements: PlanEntitlementRow[];
  subscriptions: Array<{
    id: string;
    planSlug: string;
    planName: string;
    status: string;
    ownerEndUserId: string;
    currentPeriodEnd: string | null;
  }>;
  // Licenses pooled to this org (seats shared by the team).
  licenses: Array<{
    id: string;
    kind: 'PERPETUAL' | 'TIMED' | 'SEATS';
    status: string;
    keyPrefix: string;
    seatsAllowed: number | null;
    ownerEndUserId: string;
    expiresAt: string | null;
  }>;
}

export interface PlanEntitlementRow {
  id: string;
  kind: 'FEATURE' | 'CREDIT' | 'LICENSE' | 'USAGE';
  key: string;
  valueType: 'BOOL' | 'INT' | 'STRING' | null;
  value: string | null;
  quantity: number | null;
  /** USAGE only, credits charged per unit past `quantity`. Null = hard cap. */
  creditsPerUnit?: number | null;
  licenseKind: 'PERPETUAL' | 'TIMED' | 'SEATS' | null;
  rollover: boolean;
  createdAt: string;
}

export interface UsageMeterRow {
  id: string;
  slug: string;
  name: string;
  unit: string;
  active: boolean;
  createdAt: string;
}

export interface CouponRow {
  id: string;
  code: string;
  discountType: 'PERCENT' | 'AMOUNT';
  amountOff: number;
  currency: string | null;
  planSlugs: string[];
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  maxRedemptions: number | null;
  maxRedemptionsPerUser: number | null;
  /** Times redeemed (rows in coupon_redemptions). */
  redemptionCount: number;
  /** Total discount granted across redemptions, smallest currency unit (best-effort). */
  totalDiscountIssued: number;
}

/** GET /tenant/applications/:id/billing/stats, revenue dashboard numbers. */
export interface BillingStatsRow {
  activeSubscriptions: number;
  pastDueSubscriptions: number;
  canceledLast30d: number;
  newSubscriptionsLast30d: number;
  /** Monthly recurring revenue, smallest currency unit (YEAR plans normalized /12). */
  mrrCents: number;
  /** Currency of `mrrCents` (dominant across active plans); null when no MRR. */
  mrrCurrency: string | null;
  /** True when active subscription plans span more than one currency. */
  mixedCurrencies: boolean;
  revenueLast30dCents: number;
  paymentsLast30d: { succeeded: number; failed: number };
  /** Last 12 UTC months, oldest first, gap-filled. `month` is `YYYY-MM`. */
  monthlyRevenue: Array<{ month: string; amountCents: number }>;
}

/** One row of GET /tenant/applications/:id/payments. */
export interface PaymentRow {
  id: string;
  endUserId: string | null;
  endUserEmail: string | null;
  subscriptionId: string | null;
  amount: number;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
  providerPaymentId: string | null;
  description: string | null;
  createdAt: string;
}

/** One row of GET /tenant/applications/:id/dunning, failed-payment recovery. */
export interface DunningCaseRow {
  id: string;
  subscriptionId: string;
  endUserId: string | null;
  endUserEmail: string | null;
  organizationId: string | null;
  status: 'OPEN' | 'RECOVERED' | 'EXHAUSTED' | 'CANCELED';
  planSlug: string;
  planName: string;
  failedAttempts: number;
  remindersSent: number;
  lastFailureAt: string | null;
  nextActionAt: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface UnappliedPaymentRow {
  id: string;
  paymentId: string;
  provider: string;
  amount: number;
  currency: string;
  refundedAmount: number;
  status: 'OPEN' | 'REFUNDED' | 'ENTITLEMENT_GRANTED' | 'DISMISSED';
  endUserId: string | null;
  endUserEmail: string | null;
  providerPaymentId: string | null;
  providerRefundId: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  openedAt: string;
  /** Whole days since the money arrived. Drives the urgency column. */
  ageDays: number;
  /** Whether Rekey can issue a refund through this provider at all. */
  refundable: boolean;
}

export interface EndUserRow {
  id: string;
  email: string;
  emailVerified: boolean;
  role: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * One row of an Application's APPLICATION-role catalog, which governs
 * `EndUser.role`: one value per (Application, end-user), identical in every
 * organization that user belongs to. The org-scoped twin is
 * `OrganizationRoleRow`.
 */
export interface ApplicationRoleRow {
  id: string;
  applicationId: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  metadata: Record<string, unknown> | null;
  memberCount: number;
  pendingInvitationCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * One row of an Application's ORGANIZATION-role catalog.
 *
 * Distinct from an end-user's application-wide role (`EndUserRow.role`), which
 * is one value per (Application, end-user). This one is per (organization,
 * end-user), so the same person can be `editor` in one agency and `OWNER` in
 * another. `baseRole` is the tier the API enforces on; `name` is your own
 * vocabulary and is never interpreted.
 */
export interface OrganizationRoleRow {
  name: string;
  description: string | null;
  baseRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  isDefault: boolean;
  isBuiltIn: boolean;
  /** Revoked: holders are refused and it cannot be assigned. Reversible. */
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMemberRow {
  id: string;
  endUserId: string;
  email: string;
  /** A catalog name. Not the 3-value tier; see OrganizationRoleRow. */
  role: string;
  /** The tier that name maps to. Drive any permission display off this. */
  baseRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  createdAt: string;
}

export interface OrganizationInvitationRow {
  id: string;
  email: string;
  /** A catalog name. */
  role: string;
  expiresAt: string;
  createdAt: string;
}

export interface OrganizationDetail {
  organization: {
    id: string;
    name: string;
    slug: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
  };
  members: OrganizationMemberRow[];
  invitations: OrganizationInvitationRow[];
}

export type EmailLogStatus = 'sent' | 'error' | 'no_transport' | 'suppressed';

export interface EmailLogRow {
  id: string;
  applicationId: string | null;
  toAddress: string;
  subject: string;
  eventKey: string | null;
  /** byo_resend | byo_smtp | default_resend | none */
  via: string;
  status: EmailLogStatus | string;
  messageId: string | null;
  error: string | null;
  createdAt: string;
}

/** Workspace-wide log row carries the owning app (null for system mail). */
export interface EmailLogWithApp extends EmailLogRow {
  application: { id: string; name: string; slug: string } | null;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Per-application role a workspace MEMBER can be granted (roadmap #8). */
export type ApplicationGrantRole = 'APP_ADMIN' | 'APP_BILLING' | 'APP_VIEWER';

export interface MemberGrantRow {
  applicationId: string;
  applicationName: string;
  applicationSlug: string;
  role: ApplicationGrantRole;
  createdAt: string;
}

export interface MemberRow {
  membershipId: string;
  tenantUserId: string;
  email: string;
  name: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  joinedAt: string;
  /**
   * Per-application grants. Only meaningful for MEMBER roles. ≥1 grant = the
   * member only sees/uses the granted applications. An empty list means the
   * member can access NO application, unless `legacyWorkspaceRead` is set.
   */
  /** Present for OWNER/ADMIN callers only, a MEMBER listing the roster gets the people, not their permissions. */
  grants?: MemberGrantRow[];
  /** The member's scopes as stored, or null when unrestricted. OWNER/ADMIN callers only. */
  scopes?: string[] | null;
  /**
   * True only for MEMBER memberships grandfathered by the 2.0.0-rc.3 backfill:
   * they keep the pre-grants workspace-wide READ over every application.
   * Setting any grant clears it permanently. Everything created since then is
   * `false`, so a grant-less member sees nothing at all, including anyone who
   * just accepted an invitation.
   */
  legacyWorkspaceRead?: boolean;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  expiresAt: string;
  createdAt: string;
  invitedById: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
}

export interface BillingCredentialsStatus {
  configured: boolean;
  provider: string | null;
}

/**
 * Billing provider name. Open string (P4): the set of providers is the API's
 * runtime provider-module registry, discovered via
 * `GET /tenant/applications/:id/billing/providers`, no compile-time union.
 */
export type BillingProviderName = string;

export interface BillingCredentialRow {
  provider: BillingProviderName;
  configured: boolean;
  enabled: boolean;
  mode: 'test' | 'live';
  countries: string[];
  priority: number;
  /** Whether the provider webhook secret/id is set (manually or auto-registered). */
  webhookConfigured: boolean;
}

/** What a provider module can do, from the registry, via discovery (P4). */
export interface BillingProviderCapabilities {
  /**
   * false → inbound only: the operator's own billing system posting events.
   * No checkout, no routing, no dashboard to register a webhook in. Absent
   * (an older API) means the provider hosts a checkout.
   */
  checkout?: boolean;
  oneTime: boolean;
  captureStep: boolean;
  /** false → no webhook-create API (Razorpay): manual dashboard setup only. */
  autoWebhookRegister: boolean;
  periodRotationEvents: boolean;
  onlineVerify: boolean;
}

/** One credential form field, as declared by the provider module (never a stored value). */
export interface BillingCredentialFieldInfo {
  key: string;
  label: string;
  /** true → render a password input; the API never echoes it back. */
  secret: boolean;
  optional: boolean;
  placeholder?: string;
  help?: string;
  /** Shape rule ('sk_', 'whsec_'…) reduced to its operator-readable message. */
  pattern?: { message: string };
}

/**
 * One entry of `GET /tenant/applications/:id/billing/providers` (P4): a
 * registered provider module + this application's configured status. Drives
 * the whole panel billing page, provider list, labels, credential forms,
 * webhook UX gating.
 */
export interface BillingProviderDescriptor {
  name: BillingProviderName;
  label: string;
  docsUrl: string;
  defaultCountries: string[];
  priority: number;
  capabilities: BillingProviderCapabilities;
  credentialFields: BillingCredentialFieldInfo[];
  configured: boolean;
  /** null until this application has credentials for the provider. */
  status: {
    enabled: boolean;
    mode: 'test' | 'live';
    countries: string[];
    priority: number;
    webhookConfigured: boolean;
  } | null;
}

// ---------- Unauth helpers (sign-in / sign-up / accept-invite) ----------

/**
 * Discriminated union returned by `/api/v1/tenant/auth/sign-in`. Branch on
 * `mfaRequired`:
 *   - `false` → full session, set cookies and proceed.
 *   - `true`  → MFA enrolled, collect TOTP/backup code and POST to
 *     `/api/v1/tenant/auth/mfa-verify` to receive an `AuthResponse`.
 */
export type SignInResponse =
  | (AuthResponse & { mfaRequired: false })
  | {
      mfaRequired: true;
      user: { id: string; email: string; name: string | null };
      mfaChallengeToken: string;
      mfaChallengeExpiresAt: string;
    };

export interface AuthResponse {
  user: { id: string; email: string; name: string | null };
  memberships: MeDto['memberships'];
  activeTenantId: string;
  activeRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}

export async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await apiCallerHeaders()) },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as
    | { success: true; data: T }
    | ErrorEnvelope;
  if (!res.ok || !('success' in json) || json.success === false) {
    const err =
      'error' in json
        ? json.error
        : { code: 'PANEL_HTTP_ERROR', message: `HTTP ${res.status}` };
    throw new PanelApiError({ ...err, statusCode: res.status });
  }
  return json.data;
}

export async function publicGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    headers: { ...(await apiCallerHeaders()) },
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as
    | { success: true; data: T }
    | ErrorEnvelope;
  if (!res.ok || !('success' in json) || json.success === false) {
    const err =
      'error' in json
        ? json.error
        : { code: 'PANEL_HTTP_ERROR', message: `HTTP ${res.status}` };
    throw new PanelApiError({ ...err, statusCode: res.status });
  }
  return json.data;
}

/**
 * Read `/health/ready`.
 *
 * Deliberately NOT routed through `publicGet`: the health endpoints answer a bare
 * `{status, db, redis}` object rather than the `{success, data}` envelope every
 * other route uses, so `publicGet` would treat a perfectly good response as a
 * protocol error and throw. They also answer 503 when a dependency is down, and
 * that body is exactly the one we want to read.
 *
 * Returns null on anything unparseable. A health probe must never be the reason a
 * page fails to render.
 */
export interface ReadyReport {
  status?: string;
  db?: 'ok' | 'unreachable';
  redis?: 'ok' | 'unreachable' | 'not_configured';
}

export async function getReadyReport(): Promise<ReadyReport | null> {
  try {
    const res = await fetch(`${apiUrl()}/health/ready`, {
      headers: await apiCallerHeaders(),
      // Short cache: enough that a burst of navigations shares one probe, short
      // enough that a resolved outage clears the banner promptly.
      next: { revalidate: 15 },
      // Bounded, because this runs in the authed layout. An API host that
      // accepts the connection and then hangs would otherwise hold the whole
      // console on undici's default 300-second headers timeout, no sidebar, no
      // skeleton, nothing, for a decorative banner. Two seconds is longer than
      // a healthy probe and shorter than a user's patience; a timeout lands in
      // the catch below and reports "no opinion", which renders nothing.
      signal: AbortSignal.timeout(2000),
    });
    const json = (await res.json().catch(() => null)) as ReadyReport | null;
    if (json === null || typeof json !== 'object') return null;
    return json;
  } catch {
    return null;
  }
}

/**
 * Carry an API refusal through a redirect so the page can show what it said.
 *
 * Every page keeps a local map of error code → sentence, and falls back to
 * "Something went wrong. Please try again." for anything unmapped. That is
 * fine for codes a page expects and actively wrong for the rest: the API
 * already answers with a precise, operator-facing message, "This workspace
 * has reached its limit of 1 production application (currently 1). Staging and
 * development applications are not counted", and the panel replaced it with a
 * sentence carrying no information at all.
 *
 * The map still wins where a page has better words. This only decides what
 * happens when it does not, and the answer should be the truth rather than a
 * shrug. It needs no per-code panel work, so a limit added to the API tomorrow
 * explains itself in the panel today, which is also why it suits a
 * self-hosted deployment whose limits are its own.
 *
 * ## Why the prose is not in the query string
 *
 * The obvious implementation puts `detail` and `fix` in the URL beside the
 * code. It was implemented that way first, and it is wrong: a query parameter
 * is written by whoever composes the link. That hands anyone who can get a
 * signed-in operator to click a URL the ability to render arbitrary text
 * inside the panel's own authenticated error banner, "Your workspace was
 * flagged, call this number to restore access", with the real hostname in the
 * address bar. It also drops the API's prose into browser history and the
 * `Referer` of the next outbound link, including on the signed-out pages.
 *
 * So the code stays in the URL, because the page legitimately branches on it
 * and it is not prose, and the message travels in a short-lived httpOnly
 * cookie instead. A cross-site link cannot set one. The cookie is bound to the
 * code it arrived with, so a stale one cannot attach itself to a later,
 * unrelated failure, and it expires on its own because a Server Component may
 * read cookies but not clear them.
 */
const ERROR_FLASH_COOKIE = 'rk_err';
/** Long enough to survive the redirect, short enough to be gone by the next mistake. */
const ERROR_FLASH_MAX_AGE = 30;

/**
 * Stash the API's message for the page we are about to redirect to, and return
 * the query string that page should be given.
 *
 * Server actions and route handlers may write cookies; this must not be called
 * from a render.
 */
export async function errorQuery(
  err: PanelApiError,
  extra?: Record<string, string>,
): Promise<string> {
  const jar = await cookies();
  jar.set(
    ERROR_FLASH_COOKIE,
    JSON.stringify({
      code: err.code,
      // Capped: a cookie is a header, and a hostile API is still a bound worth
      // having on something rendered to an operator.
      message: err.message ? err.message.slice(0, 300) : undefined,
      fix: err.fix ? err.fix.slice(0, 300) : undefined,
    }),
    {
      httpOnly: true,
      sameSite: 'strict',
      secure: await cookieSecure(),
      path: '/',
      maxAge: ERROR_FLASH_MAX_AGE,
    },
  );

  const params = new URLSearchParams({ error: err.code });
  for (const [k, v] of Object.entries(extra ?? {})) params.set(k, v);
  return params.toString();
}

/**
 * The API's own message and fix for `code`, if this request is the one that
 * followed the failure.
 *
 * Returns nothing when the cookie is absent, unparseable, or was written for a
 * different code, a page shows the API's words about the failure it is
 * displaying, or none.
 */
export async function readErrorFlash(
  code: string | undefined,
): Promise<{ detail?: string; fix?: string }> {
  if (!code) return {};
  const raw = (await cookies()).get(ERROR_FLASH_COOKIE)?.value;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { code: c, message, fix } = parsed as Record<string, unknown>;
    if (c !== code) return {};
    return {
      ...(typeof message === 'string' ? { detail: message } : {}),
      ...(typeof fix === 'string' ? { fix } : {}),
    };
  } catch {
    return {};
  }
}
