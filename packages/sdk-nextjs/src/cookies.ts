/**
 * Shared cookie names + helpers. Used by both middleware (Edge runtime) and
 * server-component code (Node runtime), must stay edge-compatible
 * (no Node-only deps, no `node:crypto`).
 */

export const ACCESS_COOKIE = 'rekey_access';
export const REFRESH_COOKIE = 'rekey_refresh';
/**
 * The loop guard for a `REFRESH_TOKEN_RACED` answer: a digest of the refresh
 * token that raced, never the token. See `racedGuard` in `server.ts`.
 */
export const RACED_COOKIE = 'rekey_refresh_raced';

export interface CookieOptions {
  httpOnly?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  secure?: boolean;
  path?: string;
  maxAge?: number;
}

/**
 * `secure: true` instructs browsers to refuse setting the cookie over plain
 * HTTP. That is the only correct posture anywhere but local development.
 *
 * These constants used to decide it with `process.env.NODE_ENV === 'production'`,
 * a BUILD-time answer to a REQUEST-time question, and one that fails in the
 * direction that costs you the session. A Next app behind TLS whose NODE_ENV
 * was unset, or `staging`, or anything the bundler did not inline as exactly
 * `"production"`, emitted its session cookies WITHOUT `Secure`, and a browser
 * will replay those over plain HTTP to anyone who can force one downgraded
 * request. Nothing about that is visible in the app.
 *
 * `secure` is still `true` here so the constants are safe to spread verbatim,
 * but the real decision now happens per-request in `cookieSecureFrom` below,
 * which `./server.js` applies at set time.
 *
 * Edge-runtime compatible, and deliberately dependency-free, this module is
 * the one entrypoint a client component can import for nothing but the cookie
 * names.
 */

/** Hosts a browser already treats as a secure context over plain HTTP. */
function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith('[')
    ? (host.slice(1, host.indexOf(']')) ?? '')
    : (host.split(':')[0] ?? '');
  const h = bare.trim().toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h.endsWith('.localhost')
  );
}

/**
 * Whether a cookie written on this request must carry `Secure`.
 *
 * Precedence: an explicit `REKEY_COOKIE_SECURE` wins (the only way to end up
 * with an insecure cookie on a real host, an opt-in, not something you fall
 * into); then `X-Forwarded-Proto`'s first hop; then the host, where anything
 * that is not loopback is treated as internet-facing.
 *
 * The fallback is deliberately fail-secure. Guessing wrong on a real host
 * means the browser refuses the cookie, loud, immediate, one env var to fix.
 * Guessing wrong the other way means a session credential in cleartext.
 */
export function cookieSecureFrom(headers: {
  get(name: string): string | null;
}): boolean {
  const override = (process.env.REKEY_COOKIE_SECURE ?? '').trim().toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;

  const proto = (headers.get('x-forwarded-proto') ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  if (proto === 'https') return true;

  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? '';
  return !isLoopbackHost(host);
}

/** The API's default `END_USER_ACCESS_TOKEN_TTL_SECONDS`. */
const DEFAULT_ACCESS_TTL_SECONDS = 60 * 15;

/** The API's ceiling for `END_USER_ACCESS_TOKEN_TTL_SECONDS`. */
const MAX_ACCESS_TTL_SECONDS = 24 * 60 * 60;

function jwtTimes(token: string): { iat?: number; exp?: number } | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as { iat?: unknown; exp?: unknown };
    return {
      ...(typeof claims.iat === 'number' ? { iat: claims.iat } : {}),
      ...(typeof claims.exp === 'number' ? { exp: claims.exp } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * How long the access cookie should live: as long as the token in it, never
 * a fixed fifteen minutes.
 *
 * The API's `END_USER_ACCESS_TOKEN_TTL_SECONDS` can be anything from 60
 * seconds to a day. A cookie that outlives its token is the worst case: the
 * middleware sees the cookie and lets the page render, the render's `auth()`
 * finds the token refused, and a render cannot refresh, so the signed-in user
 * is shown a signed-out page until the cookie finally expires. A cookie that
 * dies with its token sends the next request through the refresh route
 * instead.
 *
 * Read from the JWT's own `exp - iat` first, both stamped by the API's clock,
 * so a skewed clock here cannot shrink the cookie to nothing and send every
 * request through a refresh. It is shortened to the time actually left when
 * that is smaller (a token handed to `createSession` some seconds after it was
 * minted). `accessTokenExpiresAt` is the fallback for a token that is not a
 * readable JWT, then the API's default.
 *
 * Read without verifying: it only sizes a cookie, and a forged claim can do no
 * more than make its bearer refresh sooner or later than necessary.
 *
 * @internal
 */
export function accessCookieMaxAge(
  accessToken: string,
  accessTokenExpiresAt?: string,
  now: number = Date.now(),
): number {
  const nowSeconds = Math.floor(now / 1000);
  const clamp = (seconds: number) => Math.min(MAX_ACCESS_TTL_SECONDS, Math.max(1, Math.floor(seconds)));

  const times = jwtTimes(accessToken);
  if (times?.exp !== undefined && times.iat !== undefined && times.exp > times.iat) {
    const lifetime = times.exp - times.iat;
    const left = times.exp - nowSeconds;
    return clamp(left > 0 && left < lifetime ? left : lifetime);
  }

  if (accessTokenExpiresAt) {
    const at = Date.parse(accessTokenExpiresAt);
    if (Number.isFinite(at) && at > now) return clamp((at - now) / 1000);
  }

  return DEFAULT_ACCESS_TTL_SECONDS;
}

export const ACCESS_COOKIE_OPTS: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: true,
  path: '/',
  // The API's default access-token lifetime, and only a fallback: every write
  // sizes the cookie from the token itself, see `accessCookieMaxAge`.
  maxAge: DEFAULT_ACCESS_TTL_SECONDS,
};

export const REFRESH_COOKIE_OPTS: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: true,
  path: '/',
  maxAge: 60 * 60 * 24 * 30, // 30 days
};

export const RACED_COOKIE_OPTS: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: true,
  path: '/',
  // Outlasts the API's reuse window (15 seconds by default) with margin;
  // nothing reads it after that.
  maxAge: 60,
};
