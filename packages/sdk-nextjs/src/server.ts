/**
 * Server-side helpers for App Router server components, server actions,
 * and route handlers.
 *
 * Pattern:
 *   import { auth, signIn, signOut } from '@rekey.dev/nextjs/server';
 *
 *   // In a server component:
 *   const session = await auth(); // null when signed out, { user, accessToken } otherwise
 *
 *   // In a server action:
 *   await signIn({ email, password });   // sets cookies + returns the user
 *   await signOut();                     // revokes refresh + clears cookies
 *
 * The helpers expect:
 *   - `process.env.REKEY_URL` (the API URL)
 *   - `process.env.REKEY_SECRET` (the Application secret key, server-only)
 *
 * Pure server module — never bundled to the browser.
 */

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Rekey, RekeyError } from '@rekey.dev/node';
import type { EndUserDto } from '@rekey.dev/shared-types';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_OPTS,
  REFRESH_COOKIE_OPTS,
  cookieSecureFrom,
} from './cookies.js';

/**
 * The cookie options to actually write with, `secure` resolved against THIS
 * request rather than against the build's NODE_ENV. See `cookieSecureFrom`.
 */
async function accessOpts(): Promise<typeof ACCESS_COOKIE_OPTS> {
  return { ...ACCESS_COOKIE_OPTS, secure: cookieSecureFrom(await headers()) };
}

async function refreshOpts(): Promise<typeof REFRESH_COOKIE_OPTS> {
  return { ...REFRESH_COOKIE_OPTS, secure: cookieSecureFrom(await headers()) };
}

let _client: Rekey | null = null;
function client(): Rekey {
  if (_client) return _client;
  const apiUrl = process.env.REKEY_URL;
  const secretKey = process.env.REKEY_SECRET;
  if (!apiUrl || !secretKey) {
    throw new Error(
      '@rekey.dev/nextjs: REKEY_URL and REKEY_SECRET must be set on the server.',
    );
  }
  _client = new Rekey({ apiUrl, secretKey });
  return _client;
}

export interface Session {
  user: EndUserDto;
  /** The access JWT — pass it to client components via the provider's `accessToken`. */
  accessToken: string;
}

/**
 * Codes that mean the token itself is finished, as opposed to the request
 * having failed. Only these justify throwing the session away: a timeout or a
 * DNS blip must not delete the refresh cookie, because that is the one
 * credential that can recover the session and deleting it turns a two-second
 * outage into everybody signing in again.
 */
const TOKEN_IS_DEAD = new Set(['REFRESH_TOKEN_EXPIRED', 'REFRESH_TOKEN_REUSED', 'USER_TOKEN_INVALID']);

/**
 * Can this context write cookies?
 *
 * Next seals the cookie jar outside an action or route handler; `set` and
 * `delete` both throw there. The probe deletes a cookie nobody sets, which is
 * a no-op when it succeeds and tells us where we are when it does not.
 *
 * This has to be asked BEFORE refreshing, not after. The API rotates the
 * refresh token on every use and treats a replay of a rotated token as a
 * compromise signal — `revokeAllForEndUser`, every session gone. So refreshing
 * in a context that cannot persist the new token is not merely wasteful: the
 * browser keeps presenting the old one, and the next request destroys the
 * user's sessions everywhere. Silently, and harder than the 500 this function
 * used to throw.
 */
async function canWriteCookies(jar: Awaited<ReturnType<typeof cookies>>): Promise<boolean> {
  try {
    jar.delete(PROBE_COOKIE);
    return true;
  } catch {
    return false;
  }
}

/** Deleting a cookie nothing ever sets. Never reaches the browser. */
const PROBE_COOKIE = '__rekey_probe';

/**
 * Resolve the current session from cookies. Tries the access token first; on
 * `USER_TOKEN_INVALID` refreshes once. Returns null when signed out.
 *
 * **Never throws because of where it was called, and never spends a refresh
 * token it cannot store.** A server component may not write cookies, so from
 * one it reports no session rather than refreshing: the API rotates on every
 * refresh and treats a replay of the rotated token as a compromise, revoking
 * every session the user has. `rekeyMiddleware` repairs a stale session before
 * the render by routing through {@link refreshSession} in a route handler,
 * which is allowed to persist.
 *
 * It does still throw on a genuine API failure, which is deliberate: an
 * unreachable API is not the same as a signed-out user, and reporting it as
 * one is how a blip becomes a mass logout.
 */
export async function auth(): Promise<Session | null> {
  const jar = await cookies();
  const access = jar.get(ACCESS_COOKIE)?.value;
  if (access) {
    try {
      const user = await client().auth.getCurrentUser(access);
      return { user, accessToken: access };
    } catch (err) {
      if (!(err instanceof RekeyError) || err.code !== 'USER_TOKEN_INVALID') {
        throw err;
      }
    }
  }

  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (!refresh) return null;

  // Refreshing consumes the token. If the result cannot be stored, the browser
  // keeps presenting the old one and the API reads that replay as a leak,
  // revoking every session the user has. So a render reports "no session" and
  // leaves the token alone — recoverable, and the middleware repairs it on the
  // next request by routing through `refreshSession()` in a route handler.
  if (!(await canWriteCookies(jar))) return null;

  let fresh;
  try {
    fresh = await client().auth.refresh(refresh);
  } catch (err) {
    // Only a verdict about the token clears it. Anything else — a timeout, a
    // 500 from the API — leaves the cookies alone so the next request can try
    // again, and is reported rather than disguised as a signed-out user.
    if (err instanceof RekeyError && TOKEN_IS_DEAD.has(err.code)) {
      jar.delete(ACCESS_COOKIE);
      jar.delete(REFRESH_COOKIE);
      return null;
    }
    throw err;
  }

  const [aOpts, rOpts] = await Promise.all([accessOpts(), refreshOpts()]);
  jar.set(ACCESS_COOKIE, fresh.accessToken, aOpts);
  jar.set(REFRESH_COOKIE, fresh.refreshToken, rOpts);

  const user = await client().auth.getCurrentUser(fresh.accessToken);
  return { user, accessToken: fresh.accessToken };
}

/**
 * Rotate the session and persist it. For a route handler or middleware, where
 * cookie writes are allowed.
 *
 * `auth()` refreshes too, but cannot always persist the result. Calling this
 * from a place that can — a `/api/session/refresh` route the middleware sends
 * stale sessions through — means the rotation is written once instead of
 * being redone on every render.
 *
 * Returns null when there is nothing to refresh or the token is spent, having
 * cleared the cookies in the latter case.
 */
export async function refreshSession(): Promise<Session | null> {
  const jar = await cookies();
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (!refresh) return null;

  try {
    const fresh = await client().auth.refresh(refresh);
    jar.set(ACCESS_COOKIE, fresh.accessToken, await accessOpts());
    jar.set(REFRESH_COOKIE, fresh.refreshToken, await refreshOpts());
    const user = await client().auth.getCurrentUser(fresh.accessToken);
    return { user, accessToken: fresh.accessToken };
  } catch (err) {
    if (err instanceof RekeyError && TOKEN_IS_DEAD.has(err.code)) {
      jar.delete(ACCESS_COOKIE);
      jar.delete(REFRESH_COOKIE);
      return null;
    }
    throw err;
  }
}

/**
 * Sign-in outcome for the Next SDK. `kind === "session"` is the happy path;
 * `kind === "mfa_required"` means the user has MFA enrolled and the caller
 * must collect a TOTP / backup code and call `mfaVerify` to complete.
 *
 * No cookies are set on the `mfa_required` branch — the challenge token is
 * NOT a session and must never land in `rekey_access`.
 */
export type SignInOutcome =
  | { kind: 'session'; session: Session }
  | {
      kind: 'mfa_required';
      mfaChallengeToken: string;
      mfaChallengeExpiresAt: string;
      user: EndUserDto;
    };

async function setSessionCookies(accessToken: string, refreshToken: string): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, accessToken, await accessOpts());
  jar.set(REFRESH_COOKIE, refreshToken, await refreshOpts());
}

/**
 * Finalize a **browser** login into httpOnly session cookies.
 *
 * Use in a route handler when the client signed in with the publishable key
 * (via `@rekey.dev/nextjs/client`) and POSTed you the resulting tokens. This is
 * the secure hand-off: the tokens land in httpOnly cookies (out of JS), so the
 * rest of the app uses `auth()` exactly as it would for a server-action login.
 *
 * This sets cookies verbatim — front it with your own CSRF/origin checks; never
 * trust tokens from an untrusted origin.
 *
 * @example
 * ```ts
 * // app/api/auth/session/route.ts
 * import { createSession } from '@rekey.dev/nextjs/server';
 * export async function POST(req: Request) {
 *   const { accessToken, refreshToken } = await req.json();
 *   await createSession({ accessToken, refreshToken });
 *   return Response.json({ ok: true });
 * }
 * ```
 */
export async function createSession(tokens: {
  accessToken: string;
  refreshToken: string;
}): Promise<void> {
  await setSessionCookies(tokens.accessToken, tokens.refreshToken);
}

/**
 * Server action: sign in with email + password.
 *
 * Branches on the server's MFA verdict:
 *   - No MFA enrolled → cookies are set and `{ kind: "session" }` is returned.
 *   - MFA enrolled    → `{ kind: "mfa_required", mfaChallengeToken }` is
 *                       returned with **no cookies**. Pass the challenge
 *                       token + the user's code to `mfaVerify(...)` to
 *                       complete.
 */
export async function signIn(input: {
  email: string;
  password: string;
}): Promise<SignInOutcome> {
  const result = await client().auth.signIn(input);
  if (result.mfaRequired) {
    return {
      kind: 'mfa_required',
      mfaChallengeToken: result.mfaChallengeToken,
      mfaChallengeExpiresAt: result.mfaChallengeExpiresAt,
      user: result.endUser,
    };
  }
  await setSessionCookies(result.accessToken, result.refreshToken);
  return {
    kind: 'session',
    session: { user: result.endUser, accessToken: result.accessToken },
  };
}

/**
 * Server action: complete an MFA-required sign-in. Sets cookies on success.
 * Throws `RekeyError` with code `MFA_CODE_INVALID` /
 * `MFA_CHALLENGE_INVALID` on failure — surface the error message to the
 * user and prompt to retry.
 */
export async function mfaVerify(input: {
  mfaChallengeToken: string;
  code: string;
}): Promise<Session> {
  const result = await client().auth.mfaVerify(input);
  await setSessionCookies(result.accessToken, result.refreshToken);
  return { user: result.endUser, accessToken: result.accessToken };
}

/**
 * Server action: sign up + create the user + start a session.
 *
 * Sign-up never returns mfa-required (the new user can't have MFA enrolled
 * yet), so this always sets cookies.
 */
export async function signUp(input: {
  email: string;
  password: string;
  metadata?: Record<string, unknown>;
}): Promise<Session> {
  const result = await client().auth.signUp(input);
  await setSessionCookies(result.accessToken, result.refreshToken);
  return { user: result.endUser, accessToken: result.accessToken };
}

/**
 * Server action: revoke the refresh token + clear cookies. Optionally
 * pass `redirectTo` to bounce afterwards.
 */
export async function signOut(redirectTo?: string): Promise<void> {
  const jar = await cookies();
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (refresh) {
    await client().auth.signOut(refresh).catch(() => undefined);
  }
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
  if (redirectTo) redirect(redirectTo);
}
