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
 *   - `process.env.RELIPAY_URL` (the API URL)
 *   - `process.env.RELIPAY_SECRET` (the Application secret key, server-only)
 *
 * Pure server module — never bundled to the browser.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Rekey, RekeyError } from '@rekey.dev/node';
import type { EndUserDto } from '@rekey.dev/shared-types';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_OPTS,
  REFRESH_COOKIE_OPTS,
} from './cookies.js';

let _client: Rekey | null = null;
function client(): Rekey {
  if (_client) return _client;
  const apiUrl = process.env.RELIPAY_URL;
  const secretKey = process.env.RELIPAY_SECRET;
  if (!apiUrl || !secretKey) {
    throw new Error(
      '@rekey.dev/nextjs: RELIPAY_URL and RELIPAY_SECRET must be set on the server.',
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
 * Resolve the current session from cookies. Tries access first; on
 * USER_TOKEN_INVALID, attempts refresh-and-retry once. Returns null when
 * signed out (or when refresh fails).
 *
 * Use from any server component. Cookie writes work in server actions and
 * route handlers (Next.js limitation: not in pure server-component reads).
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

  // Try refresh.
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (!refresh) return null;
  try {
    const fresh = await client().auth.refresh(refresh);
    jar.set(ACCESS_COOKIE, fresh.accessToken, ACCESS_COOKIE_OPTS);
    jar.set(REFRESH_COOKIE, fresh.refreshToken, REFRESH_COOKIE_OPTS);
    const user = await client().auth.getCurrentUser(fresh.accessToken);
    return { user, accessToken: fresh.accessToken };
  } catch {
    jar.delete(ACCESS_COOKIE);
    jar.delete(REFRESH_COOKIE);
    return null;
  }
}

/**
 * Sign-in outcome for the Next SDK. `kind === "session"` is the happy path;
 * `kind === "mfa_required"` means the user has MFA enrolled and the caller
 * must collect a TOTP / backup code and call `mfaVerify` to complete.
 *
 * No cookies are set on the `mfa_required` branch — the challenge token is
 * NOT a session and must never land in `relipay_access`.
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
  jar.set(ACCESS_COOKIE, accessToken, ACCESS_COOKIE_OPTS);
  jar.set(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTS);
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
