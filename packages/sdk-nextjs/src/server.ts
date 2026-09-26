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
 * Pure server module, never bundled to the browser.
 */

import * as React from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { Rekey, RekeyError } from '@rekey.dev/node';
import type { DeviceBindingRequest, EndUserDto } from '@rekey.dev/shared-types';
import { neverConnected } from '@rekey.dev/shared-types/transport';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_OPTS,
  REFRESH_COOKIE_OPTS,
  RACED_COOKIE,
  RACED_COOKIE_OPTS,
  accessCookieMaxAge,
  cookieSecureFrom,
} from './cookies.js';
import { DEFAULT_SIGN_IN_PATH, safeReturnPath } from './paths.js';
import {
  SESSION_INTERRUPTED_REASON,
  isGatewayFailure,
  mayRotateFrom,
  refreshInterstitial,
} from './refresh-guard.js';

export { DEFAULT_REFRESH_PATH, DEFAULT_SIGN_IN_PATH } from './paths.js';

/**
 * The cookie options to actually write with, `secure` resolved against THIS
 * request rather than against the build's NODE_ENV (see `cookieSecureFrom`),
 * and the access cookie sized to the token going into it (see
 * `accessCookieMaxAge`).
 */
async function accessOpts(tokens: TokenPair): Promise<typeof ACCESS_COOKIE_OPTS> {
  return {
    ...ACCESS_COOKIE_OPTS,
    secure: cookieSecureFrom(await headers()),
    maxAge: accessCookieMaxAge(tokens.accessToken, tokens.accessTokenExpiresAt),
  };
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
      '@rekey.dev/nextjs: REKEY_URL and REKEY_SECRET must be set on the server. ' +
        'REKEY_URL on Rekey Cloud is https://api.rekey.dev; self-hosted, it is your own ' +
        "deployment's public origin (locally, http://localhost:3030). REKEY_SECRET is the " +
        'secret key (rp_…) from Panel → Application → API Keys.',
    );
  }
  _client = new Rekey({ apiUrl, secretKey });
  return _client;
}

/**
 * How many proxies in front of this app append to `X-Forwarded-For`
 * (`REKEY_TRUSTED_PROXY_HOPS`, default 1). The visitor is that many entries
 * from the right: the rightmost entry is the one your own edge wrote, and the
 * leftmost is whatever the visitor typed. `0` forwards nothing, and is the
 * right setting when no proxy sits in front of the app.
 */
function trustedProxyHops(): number {
  const raw = process.env.REKEY_TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === '') return 1;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 10) : 1;
}

/**
 * The visitor's address, from the headers the proxy in front of this app
 * sets: the `REKEY_TRUSTED_PROXY_HOPS`-th entry from the right of
 * `X-Forwarded-For`, or `X-Real-IP` when there is no such header. Null when
 * neither gives one address. Never read from anything the page sends.
 *
 * It is only as good as that proxy, and a forged address is worse than a
 * missing one. With nothing in front of the app, the visitor writes these
 * headers, so a sign-in script that sends a new address on every request gets
 * a fresh per-IP bucket every time. That escapes the API's per-IP limit and
 * its cap on unattributed traffic, leaving only the per-account and overall
 * ceilings. So set `REKEY_TRUSTED_PROXY_HOPS=0` when no proxy sits in front of
 * the app, and set it to the real hop count when one does.
 */
export function visitorIpFrom(h: Headers, hops: number = trustedProxyHops()): string | null {
  if (hops <= 0) return null;
  const xff = h.get('x-forwarded-for');
  if (xff !== null) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    return parts.length >= hops ? (parts[parts.length - hops] ?? null) : null;
  }
  return h.get('x-real-ip')?.trim() || null;
}

/**
 * The client for a call made on the visitor's behalf: sign-in, sign-up, MFA.
 * Carries the visitor's address in `X-Rekey-Client-Ip` so the API's per-IP
 * sign-in limit counts the visitor rather than this server. `clientIp`
 * overrides the header-derived address; `null` sends none. `@rekey.dev/node`
 * sends it only when it is exactly one IP address.
 */
async function visitorClient(clientIp?: string | null): Promise<Rekey> {
  const ip = clientIp === undefined ? visitorIpFrom(await headers()) : clientIp;
  return ip ? client().with({ clientIp: ip }) : client();
}

/** The per-call address override every visitor-facing helper accepts. */
export interface VisitorOptions {
  /**
   * The visitor's IP address, forwarded to the API for its per-IP sign-in
   * limits. Defaults to the address in the request headers (see
   * `REKEY_TRUSTED_PROXY_HOPS`); pass `null` to send none.
   */
  clientIp?: string | null;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Present on every API result; absent for tokens handed to `createSession`. */
  accessTokenExpiresAt?: string;
}

export interface Session {
  user: EndUserDto;
  /** The access JWT, pass it to client components via the provider's `accessToken`. */
  accessToken: string;
}

/**
 * Identify the machine to the API, for an Application that binds sessions to
 * devices (docs/devices.md).
 *
 * Optional unless `authConfig.deviceBinding` is `'required'`, in which case
 * every primary sign-in refuses without it (`DEVICE_FINGERPRINT_REQUIRED`).
 * The fingerprint is yours to compute and opaque to Rekey: hash whatever you
 * consider "the same machine", keep it stable across launches, 8 to 256
 * characters.
 *
 * A browser has no such thing, and the browser SDKs deliberately never send
 * one. This is for a Next.js server that fronts a desktop or mobile client and
 * receives the fingerprint from it.
 */
export type { DeviceBindingRequest };

export {
  classifySignInError,
  type SignInFailure,
  type DeviceChoice,
} from './errors.js';

/**
 * Rotate a refresh token, naming the device when the caller has one.
 *
 * The two calls are kept apart rather than passing `{ device: undefined }`,
 * because an absent key and a present-undefined key are not the same thing to
 * a `.strict()` validator once they have been through JSON.
 */
async function rotate(token: string, device?: DeviceBindingRequest): Promise<TokenPair> {
  return device ? client().auth.refresh(token, { device }) : client().auth.refresh(token);
}

/**
 * Options shared by the two entry points that may rotate a refresh token.
 *
 * Passing `device` matters beyond sign-in. A chain bound at sign-in is checked
 * on every rotation: a different fingerprint is `REFRESH_TOKEN_DEVICE_MISMATCH`
 * and revokes every session the user has, so a client that identifies itself at
 * sign-in must keep identifying itself. An unbound chain is bound by the first
 * refresh that names a device, and a caller that passes nothing keeps exactly
 * the behaviour it had.
 */
export interface SessionDeviceOptions {
  device?: DeviceBindingRequest;
}

/**
 * Does this code mean the token itself is finished, as opposed to the request
 * having failed? Only a verdict justifies throwing the session away.
 *
 * Matched by prefix rather than a literal list. `/auth/refresh` throws six
 * `REFRESH_TOKEN_*` codes, EXPIRED, INVALID, REUSED, REVOKED, RACE and
 * WRONG_APPLICATION, and every one is a 401 saying this token will never work
 * again. The list here held three of them, so REVOKED ("sign out my other
 * devices") and INVALID (any stale cookie) fell through to "the API failed":
 * the dead cookie was never cleared, and the browser re-presented it on every
 * request for the next thirty days while the user saw a signed-out page.
 *
 * The one exception, `REFRESH_TOKEN_RACED`, is matched exactly and checked
 * before this (see {@link isRacedCode}), so the prefix rule stays whole for
 * every code the API adds later.
 */
function isTokenVerdict(code: string): boolean {
  return (
    code.startsWith('REFRESH_TOKEN_') ||
    code === 'USER_TOKEN_INVALID' ||
    code === 'USER_TOKEN_MISSING' ||
    code === 'USER_TOKEN_WRONG_APPLICATION'
  );
}

/**
 * `REFRESH_TOKEN_RACED`: the API rotated this token moments ago for another
 * request (a second tab, a second instance behind the load balancer) and its
 * replacement is still unused. Nothing was revoked and nothing was issued.
 *
 * It is the one `REFRESH_TOKEN_*` code that does not end the session: the
 * winning request's new pair is on its way to (or already in) the browser.
 * Clearing the cookies here would delete that pair and sign the user out, so
 * they are left alone and the browser retries with what it holds now.
 */
function isRacedCode(code: string): boolean {
  return code === 'REFRESH_TOKEN_RACED';
}

/**
 * The loop guard for a raced refresh, stored in {@link RACED_COOKIE} as a
 * digest of the token that raced, so it only ever matches that one token.
 *
 * The first `RACED` for a token sets it and leaves the session cookies alone.
 * A second `RACED` for the SAME token means the browser still holds the spent
 * token after a full round trip: the winner's pair did not reach it (a closed
 * tab, a dropped response). That one is treated as a verdict and the cookies
 * are cleared. Keeping the spent token is not safe: presented again once the
 * API's reuse window (15 seconds by default) has passed, it is
 * `REFRESH_TOKEN_REUSED`, which revokes every session the user has on every
 * device. And if the winner's pair does land after the clear, its Set-Cookie
 * simply restores the session.
 */
async function racedGuard(token: string, seen: string | undefined): Promise<{ repeat: boolean; mark: string }> {
  const mark = (await exchangeKey(token)).slice(0, 32);
  return { repeat: seen === mark, mark };
}

/**
 * What a failed refresh left behind.
 *
 *   - `raced`: `REFRESH_TOKEN_RACED`, see {@link isRacedCode}. Keep the
 *     cookies, once per token (see {@link racedGuard}).
 *   - `verdict`: the API says the token is finished. Clear the cookies.
 *   - `unspent`: the API refused before rotating, or the request provably never
 *     left this host. The token is still good: keep the cookies, try later.
 *   - `maybe-spent`: anything else. Clear the cookies.
 *
 * The API rotates the token FIRST and only then does the fallible rest (the
 * device write, the organization check, minting the access token). A 5xx, a
 * timeout, or a connection dropped mid-request can therefore arrive after the
 * token was spent. Keeping the cookie then means the next request presents a
 * spent token, the API answers `REFRESH_TOKEN_REUSED`, and reuse detection
 * revokes every session the user has on every device. Signing this browser out
 * is the lesser harm, and the panel does the same.
 *
 * The cost is real and deliberate: when the API itself fails mid-refresh, a
 * stale visitor is signed out rather than left to retry. Only failures that
 * cannot have rotated are kept:
 *
 *   - a 429 or any other 4xx: the API answered with a refusal, and every
 *     refusal after the rotation is re-coded as a `REFRESH_TOKEN_*` verdict
 *     (`refusalAfterRotation` in the API), so a 4xx without that prefix came
 *     before it. The refresh limiter answers before the handler even runs;
 *   - a connection that was never made: DNS failed (`ENOTFOUND`,
 *     `EAI_AGAIN`), the port refused it (`ECONNREFUSED`), or the connect timed
 *     out (`UND_ERR_CONNECT_TIMEOUT`). No byte of the request was sent;
 *   - a 502, 503 or 504 with no Rekey error envelope: a proxy answering for an
 *     API that is not listening, which is every API redeploy. Signing out
 *     here signed out every stale visitor on every deploy. A 5xx that does
 *     carry a Rekey code came from the API itself and stays `maybe-spent`.
 *
 * A timeout from the request deadline cannot tell a slow connect from a slow
 * answer, so it counts as spent.
 */
type RefreshFailure = 'raced' | 'verdict' | 'unspent' | 'maybe-spent';

function classifyRefreshFailure(err: RekeyError): RefreshFailure {
  if (isRacedCode(err.code)) return 'raced';
  if (isTokenVerdict(err.code)) return 'verdict';
  if (err.code === 'RATE_LIMITED') return 'unspent';
  if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
    return 'unspent';
  }
  if (err.code === 'NETWORK_ERROR' && neverConnected((err as { cause?: unknown }).cause)) {
    return 'unspent';
  }
  if (isGatewayFailure(err)) return 'unspent';
  return 'maybe-spent';
}

/**
 * Access-token failures that should fall through to a refresh attempt.
 *
 * `WRONG_APPLICATION` happens when the secret is repointed at another
 * Application, or a second Rekey app writes `rekey_access` on a shared parent
 * domain. Rethrowing left a cookie that could never be cleared.
 */
function isAccessTokenSpent(code: string): boolean {
  return (
    code === 'USER_TOKEN_INVALID' ||
    code === 'USER_TOKEN_MISSING' ||
    code === 'USER_TOKEN_WRONG_APPLICATION'
  );
}

/**
 * Can this context write cookies?
 *
 * Next seals the cookie jar outside an action or route handler; `set` and
 * `delete` both throw there. The probe deletes a cookie nobody sets, which is
 * a no-op when it succeeds and tells us where we are when it does not.
 *
 * This has to be asked BEFORE refreshing, not after. The API rotates the
 * refresh token on every use and treats a replay of a rotated token as a
 * compromise signal, `revokeAllForEndUser`, every session gone. So refreshing
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

/**
 * A cookie nothing ever sets, so deleting it changes nothing the app reads.
 * Where the delete succeeds (a Server Action or route handler), Next does send
 * a `__rekey_probe=; Max-Age=0` Set-Cookie on that response, which clears a
 * cookie the browser never had. Harmless, but it is visible.
 */
const PROBE_COOKIE = '__rekey_probe';

/**
 * `React.cache` where it exists, a pass-through where it does not.
 *
 * Read off the namespace rather than imported by name: React 18 has no
 * `cache`, and a named import of a missing export fails to link. In an App
 * Router request it memoizes for that request; in middleware, and anywhere
 * React is not rendering, it calls through every time, which is what the
 * pass-through does too.
 */
type RequestMemo = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R;
const requestMemo: RequestMemo =
  (React as unknown as { cache?: RequestMemo }).cache ?? ((fn) => fn);

/**
 * `/users/me` for one access token, once per request.
 *
 * A layout and a page that both call `auth()` used to cost two API calls per
 * render, one per component. Memoized by the token string, so it caches the
 * READ only: a refresh inside the same request produces a different access
 * token and therefore a fresh read, never the stale one. A refusal is cached
 * for the request too, which is what a second `auth()` would have got anyway.
 */
const currentUser = requestMemo((accessToken: string) => client().auth.getCurrentUser(accessToken));

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
 * one is how a blip becomes a mass logout. When the failure may have come
 * after the API rotated (a 5xx, a timeout), the cookies are cleared before
 * it throws, because presenting a possibly spent token again risks the API
 * revoking every session the user has.
 *
 * Two calls in one request (a layout and a page) read the user once.
 */
export async function auth(options?: SessionDeviceOptions): Promise<Session | null> {
  const jar = await cookies();
  const access = jar.get(ACCESS_COOKIE)?.value;
  if (access) {
    try {
      const user = await currentUser(access);
      return { user, accessToken: access };
    } catch (err) {
      if (!(err instanceof RekeyError) || !isAccessTokenSpent(err.code)) {
        throw err;
      }
    }
  }

  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (!refresh) return null;

  // Refreshing consumes the token. If the result cannot be stored, the browser
  // keeps presenting the old one and the API reads that replay as a leak,
  // revoking every session the user has. So a render reports "no session" and
  // leaves the token alone, recoverable, and the middleware repairs it on the
  // next request by routing through `refreshSession()` in a route handler.
  if (!(await canWriteCookies(jar))) return null;

  const fresh = await rotateInPlace(jar, refresh, options?.device);
  if (!fresh) return null;
  const user = await currentUser(fresh.accessToken);
  return { user, accessToken: fresh.accessToken };
}

/**
 * The rotation `auth()` and `refreshSession()` share, through the same
 * per-process exchange as the refresh route, so a Server Action and a
 * concurrent page load (or a second tab) presenting the same cookie get one
 * new pair between them instead of the second replaying a spent token.
 *
 * Writes the new pair, or clears the cookies when the token is finished or may
 * have been spent (see `classifyRefreshFailure`), and returns null only for a
 * verdict. Any other failure is rethrown: an unreachable API is not a
 * signed-out user, even when the cookies had to go.
 *
 * A `REFRESH_TOKEN_RACED` is rethrown with the session cookies untouched: this
 * request carried the old pair and cannot finish, but the user is still signed
 * in and a retry sends the browser's current cookies. A second one for the
 * same token is a verdict (see `racedGuard`).
 */
async function rotateInPlace(
  jar: Awaited<ReturnType<typeof cookies>>,
  refresh: string,
  device: DeviceBindingRequest | undefined,
): Promise<TokenPair | null> {
  let fresh: TokenPair;
  try {
    const exchange = await exchangeOnce(refresh, device);
    if (exchange === 'looping') throw new Error(COOKIES_NOT_KEPT);
    fresh = await exchange.pair;
  } catch (err) {
    if (!(err instanceof RekeyError)) throw err;
    let failure = classifyRefreshFailure(err);
    if (failure === 'raced') {
      const guard = await racedGuard(refresh, jar.get(RACED_COOKIE)?.value);
      if (!guard.repeat) {
        jar.set(RACED_COOKIE, guard.mark, { ...RACED_COOKIE_OPTS, secure: cookieSecureFrom(await headers()) });
        throw err;
      }
      failure = 'verdict';
    }
    if (failure !== 'unspent') {
      jar.delete(ACCESS_COOKIE);
      jar.delete(REFRESH_COOKIE);
    }
    if (failure === 'verdict') return null;
    throw err;
  }

  const [aOpts, rOpts] = await Promise.all([accessOpts(fresh), refreshOpts()]);
  jar.set(ACCESS_COOKIE, fresh.accessToken, aOpts);
  jar.set(REFRESH_COOKIE, fresh.refreshToken, rOpts);
  return fresh;
}

/**
 * Rotate the session and persist it. For a route handler or middleware, where
 * cookie writes are allowed.
 *
 * `auth()` refreshes too, but cannot always persist the result. Calling this
 * from a place that can, a `/api/session/refresh` route the middleware sends
 * stale sessions through, means the rotation is written once instead of
 * being redone on every render.
 *
 * Returns null when there is nothing to refresh or the token is spent, having
 * cleared the cookies in the latter case.
 */
export async function refreshSession(options?: SessionDeviceOptions): Promise<Session | null> {
  const jar = await cookies();
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (!refresh) return null;

  const fresh = await rotateInPlace(jar, refresh, options?.device);
  if (!fresh) return null;
  const user = await currentUser(fresh.accessToken);
  return { user, accessToken: fresh.accessToken };
}

/**
 * Sign-in outcome for the Next SDK. `kind === "session"` is the happy path;
 * `kind === "mfa_required"` means the user has MFA enrolled and the caller
 * must collect a TOTP / backup code and call `mfaVerify` to complete.
 *
 * No cookies are set on the `mfa_required` branch, the challenge token is
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

async function setSessionCookies(tokens: TokenPair): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, tokens.accessToken, await accessOpts(tokens));
  jar.set(REFRESH_COOKIE, tokens.refreshToken, await refreshOpts());
}

/**
 * Finalize a **browser** login into httpOnly session cookies.
 *
 * Use in a route handler when the client signed in with the publishable key
 * (via `@rekey.dev/nextjs/client`) and POSTed you the resulting tokens. This is
 * the secure hand-off: the tokens land in httpOnly cookies (out of JS), so the
 * rest of the app uses `auth()` exactly as it would for a server-action login.
 *
 * This sets cookies verbatim, front it with your own CSRF/origin checks; never
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
  await setSessionCookies({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
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
 *
 * Pass `device` to bind the session to a machine. It is required when the
 * Application sets `authConfig.deviceBinding: 'required'`. Without it that
 * Application refuses every sign-in with `DEVICE_FINGERPRINT_REQUIRED`, so
 * this SDK could not sign anyone in at all while the input was narrowed to
 * `{ email, password }`.
 *
 * On failure, run the error through {@link classifySignInError} before
 * rendering it: `DEVICE_LIMIT_REACHED` and `PASSWORD_VERIFY_BUSY` are not
 * wrong passwords, and showing them as one leaves the user with no way out.
 */
export async function signIn(
  input: {
    email: string;
    password: string;
    device?: DeviceBindingRequest;
  },
  options: VisitorOptions = {},
): Promise<SignInOutcome> {
  const result = await (await visitorClient(options.clientIp)).auth.signIn(input);
  if (result.mfaRequired) {
    return {
      kind: 'mfa_required',
      mfaChallengeToken: result.mfaChallengeToken,
      mfaChallengeExpiresAt: result.mfaChallengeExpiresAt,
      user: result.endUser,
    };
  }
  await setSessionCookies(result);
  return {
    kind: 'session',
    session: { user: result.endUser, accessToken: result.accessToken },
  };
}

/**
 * Server action: complete an MFA-required sign-in. Sets cookies on success.
 * Throws `RekeyError` with code `MFA_CODE_INVALID` /
 * `MFA_CHALLENGE_INVALID` on failure, surface the error message to the
 * user and prompt to retry.
 */
export async function mfaVerify(
  input: {
    mfaChallengeToken: string;
    code: string;
    device?: DeviceBindingRequest;
  },
  options: VisitorOptions = {},
): Promise<Session> {
  const result = await (await visitorClient(options.clientIp)).auth.mfaVerify(input);
  await setSessionCookies(result);
  return { user: result.endUser, accessToken: result.accessToken };
}

/**
 * Server action: sign up + create the user + start a session.
 *
 * Sign-up never returns mfa-required (the new user can't have MFA enrolled
 * yet), so this always sets cookies.
 */
export async function signUp(
  input: {
    email: string;
    password: string;
    metadata?: Record<string, unknown>;
    device?: DeviceBindingRequest;
  },
  options: VisitorOptions = {},
): Promise<Session> {
  const result = await (await visitorClient(options.clientIp)).auth.signUp(input);
  await setSessionCookies(result);
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

/**
 * Options for {@link rekeyRefreshHandler}. Every one is optional; the defaults
 * match `rekeyMiddleware`'s.
 */
export interface RefreshHandlerOptions {
  /**
   * Where a visitor goes when there is no session to repair: no refresh
   * cookie, or the API says the token is finished. Defaults to `/sign-in`,
   * the middleware's default. Receives `next` so sign-in can return there.
   */
  signInUrl?: string;
  /** Where to land when `next` is missing or refused. Defaults to `/`. */
  fallbackUrl?: string;
  /**
   * Name the machine on the rotation, for an Application that binds sessions
   * to devices. See {@link SessionDeviceOptions}.
   */
  device?: (
    req: Request,
  ) => DeviceBindingRequest | undefined | Promise<DeviceBindingRequest | undefined>;
}


/**
 * Refresh exchanges IN FLIGHT, keyed by a SHA-256 of the refresh token being
 * spent and the device it is spent for. Hashed so the map never holds a usable
 * credential as a key.
 *
 * Shared by `rekeyRefreshHandler`, `auth()` and `refreshSession()`, all three
 * of which rotate. Callers that present the same token while its exchange is
 * running wait on that one exchange instead of each spending the token: a
 * page and its prefetches, or a layout and a Server Action, arriving together.
 *
 * An entry is deleted the moment its exchange settles. A request that arrives
 * after that goes to the API with the token it holds, and the API decides: a
 * token rotated moments ago is `REFRESH_TOKEN_RACED` (refused, nothing
 * revoked), and the raced handling sends the browser back with whatever it
 * holds now. This map used to keep a settled pair for ten seconds and hand it
 * to any later request presenting the spent cookie, which re-issued a live
 * session to a copy of that cookie without the API ever seeing the request,
 * and skipped the API's device check.
 *
 * The device is part of the key because the API checks it on every rotation:
 * two callers naming different devices must each be asked about separately.
 *
 * **Per process.** Two instances behind a load balancer do not share this map;
 * a concurrent pair split across them is settled by the API's RACED answer.
 */
const exchanges = new Map<string, Promise<TokenPair>>();

/**
 * Tokens this process rotated in the last {@link SPENT_MEMORY_MS}, by digest,
 * with how many times each came back since. Holds no token and no pair, and
 * never answers for the API: it only notices a browser that keeps presenting
 * a token it was already sent the replacement for.
 */
const recentlySpent = new Map<string, { returns: number }>();
const SPENT_MEMORY_MS = 10_000;

/**
 * How many times one spent token may come back before the handler concludes
 * the browser is not keeping the cookies it is sent. A cookie that never
 * sticks does it on every lap (refresh, page, middleware, refresh), each lap
 * answered `REFRESH_TOKEN_RACED`, until the browser gives up on the redirects
 * with nothing to say why.
 */
const MAX_SPENT_RETURNS = 10;

const COOKIES_NOT_KEPT =
  'Rekey refreshed this session, but the browser keeps sending the old cookie back, ' +
  'so it is refusing the new one. The usual cause is a Secure cookie over plain HTTP on a ' +
  'host that is not localhost: serve the app over HTTPS, or set REKEY_COOKIE_SECURE=false ' +
  'for local development.';

async function exchangeKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Nothing awaits between the lookup and the insert below, so two callers that
 * both finished hashing cannot both miss the map and both rotate.
 */
async function exchangeOnce(
  token: string,
  device: DeviceBindingRequest | undefined,
): Promise<{ pair: Promise<TokenPair> } | 'looping'> {
  const tokenKey = await exchangeKey(token);
  const key = device ? `${tokenKey}:${await exchangeKey(JSON.stringify(device))}` : tokenKey;
  const existing = exchanges.get(key);
  if (existing) return { pair: existing };

  const spent = recentlySpent.get(tokenKey);
  if (spent && ++spent.returns > MAX_SPENT_RETURNS) return 'looping';

  const pair = rotate(token, device);
  exchanges.set(key, pair);
  const forget = () => {
    if (exchanges.get(key) === pair) exchanges.delete(key);
  };
  pair.then(() => {
    forget();
    if (recentlySpent.has(tokenKey)) return;
    recentlySpent.set(tokenKey, { returns: 0 });
    const timer = setTimeout(() => recentlySpent.delete(tokenKey), SPENT_MEMORY_MS);
    (timer as { unref?: () => void }).unref?.();
  }, forget);
  return { pair };
}

/**
 * A 303 to a path. Relative on purpose: behind a proxy `req.url` is the
 * internal bind address, and the browser resolves a relative Location against
 * the URL it actually requested.
 */
function seeOther(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

function plainText(status: number, body: string, extra: Record<string, string> = {}): NextResponse {
  return new NextResponse(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

const PLACEHOLDER_ORIGIN = 'https://next.invalid';

/**
 * `signInUrl` carrying `next`, relative when `signInUrl` was. `reason` is set
 * only when the session ended because the token may have been spent (the API
 * failed mid-refresh), so the sign-in page can say why.
 */
function signInWithNext(signInUrl: string, next: string, reason?: string): string {
  const url = new URL(signInUrl, PLACEHOLDER_ORIGIN);
  url.searchParams.set('next', next);
  if (reason) url.searchParams.set('reason', reason);
  return url.origin === PLACEHOLDER_ORIGIN ? `${url.pathname}${url.search}` : url.href;
}

/** One cookie's value from a `Cookie` header. */
function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return value || undefined;
    }
  }
  return undefined;
}

/**
 * The route `rekeyMiddleware` sends a stale session to. The whole of
 * `app/api/rekey/refresh/route.ts`:
 *
 * ```ts
 * import { rekeyRefreshHandler } from '@rekey.dev/nextjs/server';
 * export const GET = rekeyRefreshHandler();
 * ```
 *
 * It rotates the refresh cookie, writes both cookies onto a 303 back to `next`,
 * and never lets `next` leave the origin or point at the refresh route.
 *
 *   - rotated: 303 to `next` (or `fallbackUrl`) with both cookies set;
 *   - no refresh cookie: 303 to `signInUrl?next=…`, touching nothing;
 *   - the token is finished (any `REFRESH_TOKEN_*`, matched by prefix): both
 *     cookies cleared, 303 to `signInUrl?next=…`;
 *   - except `REFRESH_TOKEN_RACED` (another tab or instance rotated this token
 *     moments ago; nothing was revoked): 303 to `next` with both cookies
 *     untouched and only the `rekey_refresh_raced` loop guard set. The same
 *     token racing a second time is treated as finished;
 *   - a 5xx from the API itself, a timeout, or a connection lost
 *     mid-request: both cookies cleared, 303 to
 *     `signInUrl?next=…&reason=session_interrupted`. The API rotates before
 *     the work that can fail, so the token may already be spent, and
 *     presenting it again would make the API revoke every session the user has;
 *   - 429 or another non-verdict 4xx (refused before rotating), a connection
 *     that was never made (DNS, connection refused), or a 502/503/504 from a
 *     proxy with no Rekey error envelope (the API redeploying): 503 with
 *     `Retry-After` and the cookies left alone. The token is unspent, and
 *     redirecting back would only send the page here again;
 *   - the same spent token keeps coming back after its new pair was issued:
 *     500 saying the browser is refusing the cookies, without calling the API;
 *   - a cross-site request (`Sec-Fetch-Site` other than `same-origin` or
 *     `none`): a 200 page that asks for this URL again from this origin,
 *     without calling the API or touching a cookie (see `mayRotateFrom`).
 *
 * Requests presenting the same token at the same moment share one exchange.
 * One arriving after it finished goes to the API, which answers
 * `REFRESH_TOKEN_RACED` for a token it rotated moments ago: see `exchanges`.
 */
export function rekeyRefreshHandler(
  options: RefreshHandlerOptions = {},
): (req: Request) => Promise<Response> {
  const signInUrl = options.signInUrl ?? DEFAULT_SIGN_IN_PATH;
  const fallbackUrl = options.fallbackUrl ?? '/';

  return async function GET(req: Request): Promise<Response> {
    // Refusing the route's own path, wherever it is mounted, is what stops a
    // `next` from sending the browser straight back here.
    const url = new URL(req.url);
    const next = safeReturnPath(url.searchParams.get('next'), [url.pathname]) ?? fallbackUrl;

    const token = readCookie(req.headers.get('cookie'), REFRESH_COOKIE);
    if (!token) return seeOther(signInWithNext(signInUrl, next));

    // A cross-site navigation carries the Lax refresh cookie too. Rotating for
    // it would let the page that started it drop the new pair; see
    // `mayRotateFrom`. Ask again from this origin instead.
    if (!mayRotateFrom(req.headers)) {
      return refreshInterstitial(`${url.pathname}?next=${encodeURIComponent(next)}`);
    }

    const exchange = await exchangeOnce(token, await options.device?.(req));
    if (exchange === 'looping') return plainText(500, COOKIES_NOT_KEPT);

    let pair: TokenPair;
    try {
      pair = await exchange.pair;
    } catch (err) {
      // Not an API answer at all, a missing REKEY_SECRET for one: a bug to
      // surface, not a blip to retry. Transport failures are RekeyErrors.
      if (!(err instanceof RekeyError)) throw err;
      let failure = classifyRefreshFailure(err);
      // Another request won the rotation and nothing was revoked: back to
      // `next` with the session cookies untouched, so the browser's next
      // request carries the winner's pair. Once per token (`racedGuard`).
      if (failure === 'raced') {
        const guard = await racedGuard(token, readCookie(req.headers.get('cookie'), RACED_COOKIE));
        if (!guard.repeat) {
          const res = seeOther(next);
          res.cookies.set(RACED_COOKIE, guard.mark, { ...RACED_COOKIE_OPTS, secure: cookieSecureFrom(req.headers) });
          return res;
        }
        failure = 'verdict';
      }
      // A verdict, or a failure that may have come after the rotation: the
      // token is finished or may be, and presenting it again risks the API
      // revoking every session the user has. See `classifyRefreshFailure`.
      if (failure !== 'unspent') {
        const reason = failure === 'maybe-spent' ? SESSION_INTERRUPTED_REASON : undefined;
        const res = seeOther(signInWithNext(signInUrl, next, reason));
        res.cookies.delete(ACCESS_COOKIE);
        res.cookies.delete(REFRESH_COOKIE);
        return res;
      }
      const busy = err.statusCode === 429 || err.code === 'RATE_LIMITED';
      const retryAfter =
        typeof err.retryAfterSeconds === 'number' ? Math.max(1, Math.ceil(err.retryAfterSeconds)) : 5;
      return plainText(
        503,
        busy
          ? 'Rekey is busy. Reload this page in a moment; you are still signed in.'
          : 'Could not reach Rekey to refresh your session. Reload this page in a moment.',
        { 'Retry-After': String(retryAfter) },
      );
    }

    const secure = cookieSecureFrom(req.headers);
    const res = seeOther(next);
    res.cookies.set(ACCESS_COOKIE, pair.accessToken, {
      ...ACCESS_COOKIE_OPTS,
      secure,
      maxAge: accessCookieMaxAge(pair.accessToken, pair.accessTokenExpiresAt),
    });
    res.cookies.set(REFRESH_COOKIE, pair.refreshToken, { ...REFRESH_COOKIE_OPTS, secure });
    return res;
  };
}
