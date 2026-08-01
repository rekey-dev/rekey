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
 * HTTP. That is the only correct posture in production. In local dev over
 * http://localhost it silently drops the cookie and the user appears to be
 * permanently signed-out — env-branch keeps both environments working
 * without forcing developers to run a TLS terminator locally.
 *
 * Edge-runtime compatible: `process.env.NODE_ENV` is available in both Edge
 * and Node Next.js runtimes (statically inlined by the bundler).
 */
const IS_PROD = process.env.NODE_ENV === 'production';

export const ACCESS_COOKIE_OPTS: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PROD,
  path: '/',
  maxAge: 60 * 15, // 15 minutes (matches access token lifetime)
};

export const REFRESH_COOKIE_OPTS: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PROD,
  path: '/',
  maxAge: 60 * 60 * 24 * 30, // 30 days
};
