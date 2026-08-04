/**
 * Shared cookie names + helpers. Used by both middleware (Edge runtime) and
 * server-component code (Node runtime) — must stay edge-compatible
 * (no Node-only deps, no `node:crypto`).
 */

export const ACCESS_COOKIE = 'rekey_access';
export const REFRESH_COOKIE = 'rekey_refresh';

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
 * These constants used to decide it with `process.env.NODE_ENV === 'production'`
 * — a BUILD-time answer to a REQUEST-time question, and one that fails in the
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
 * Edge-runtime compatible, and deliberately dependency-free — this module is
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
 * with an insecure cookie on a real host — an opt-in, not something you fall
 * into); then `X-Forwarded-Proto`'s first hop; then the host, where anything
 * that is not loopback is treated as internet-facing.
 *
 * The fallback is deliberately fail-secure. Guessing wrong on a real host
 * means the browser refuses the cookie — loud, immediate, one env var to fix.
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

export const ACCESS_COOKIE_OPTS: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: true,
  path: '/',
  maxAge: 60 * 15, // 15 minutes (matches access token lifetime)
};

export const REFRESH_COOKIE_OPTS: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: true,
  path: '/',
  maxAge: 60 * 60 * 24 * 30, // 30 days
};
