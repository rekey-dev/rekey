/**
 * Rekey session handling for Astro.
 *
 * ## Why this package exists
 *
 * The Astro starter carried this as ninety lines of application code, and
 * every Astro user was going to write their own version of it. Two of those
 * lines decide whether a bad afternoon costs you your users' sessions, and
 * both fail in the silent direction:
 *
 *   - **Only a verdict about the token clears it.** Treat any thrown error as
 *     "signed out" and a thirty-second API blip becomes a mass logout, because
 *     the refresh cookie, the one credential that could have recovered the
 *     session, has been deleted.
 *   - **`Secure` is decided per request, not per build.** `import.meta.env.PROD`
 *     is a build-time answer to a request-time question. Guess wrong on a real
 *     host and the browser refuses the cookie, which is loud and takes one
 *     variable to fix. Guess wrong the other way and a session credential
 *     travels in cleartext, which is silent.
 *
 * Cookie names and lifetimes match `@rekey.dev/nextjs` deliberately, so an app
 * that moves between the two frameworks does not sign everybody out.
 *
 * ## Usage
 *
 * ```ts
 * // src/middleware.ts
 * import { rekeyMiddleware } from '@rekey.dev/astro';
 * export const onRequest = rekeyMiddleware();
 * ```
 *
 * ```astro
 * ---
 * // any page
 * const session = Astro.locals.session;
 * if (!session) return Astro.redirect('/sign-in?next=/dashboard');
 * ---
 * ```
 */

import { Rekey, RekeyError } from '@rekey.dev/node';

/** Matches `@rekey.dev/nextjs` so a session survives a framework move. */
export const ACCESS_COOKIE = 'rekey_access';
export const REFRESH_COOKIE = 'rekey_refresh';

/** Access-token lifetime, in seconds. Mirrors the API's own. */
const ACCESS_MAX_AGE = 60 * 15;
/** Refresh-token lifetime, in seconds. */
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Does this code mean the token itself is finished, as opposed to the request
 * having failed? Only a verdict justifies throwing the session away.
 *
 * Matched by prefix rather than a literal list. The API has six
 * `REFRESH_TOKEN_*` codes today, EXPIRED, INVALID, REUSED, REVOKED, RACE and
 * WRONG_APPLICATION, and every one of them is a 401 saying this token will
 * never work again. An enumerated list gets this right on the day it is
 * written and silently wrong the day a seventh is added: the missed code falls
 * through to "the API failed", the dead cookie is never cleared, and the
 * browser re-presents it on every request for the next thirty days while the
 * user sees a signed-out page. REVOKED alone covers "sign out my other
 * devices", which is not an edge case.
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
 * request (a second tab, a second instance) and its replacement is still
 * unused. Nothing was revoked and nothing was issued.
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
 * The loop guard for a raced refresh: a digest of the refresh token that
 * raced, never the token, so it only ever matches that one token.
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
export const RACED_COOKIE = 'rekey_refresh_raced';
/** Outlasts the API's reuse window with margin; nothing reads it after that. */
const RACED_MAX_AGE = 60;

async function racedMark(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Access-token failures that should fall through to a refresh attempt rather
 * than being reported as an outage.
 *
 * `WRONG_APPLICATION` belongs here: it happens when the secret is repointed at
 * another Application, or a second Rekey app writes `rekey_access` on a shared
 * parent domain. Rethrowing instead left the cookie in place forever.
 */
function isAccessTokenSpent(code: string): boolean {
  return (
    code === 'USER_TOKEN_INVALID' ||
    code === 'USER_TOKEN_MISSING' ||
    code === 'USER_TOKEN_WRONG_APPLICATION'
  );
}

/** Thrown when the package is misconfigured, as opposed to the API failing. */
export class RekeyAstroConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RekeyAstroConfigError';
  }
}

/** What `getCurrentUser` returns, including the fields beyond `EndUserDto`. */
export type SessionUser = Awaited<ReturnType<Rekey['auth']['getCurrentUser']>>;

export interface Session {
  user: SessionUser;
  accessToken: string;
}

/**
 * What `signOut` managed to do. Cookies are always cleared; `revoked` says
 * whether the refresh token is also dead server-side.
 */
export type SignOutResult = { revoked: true } | { revoked: false; error: unknown };

/** The subset of `AstroCookies` this package uses, so Astro is not a hard dep. */
interface CookieJar {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, opts: Record<string, unknown>): void;
  delete(name: string, opts?: Record<string, unknown>): void;
}

export interface RekeyAstroConfig {
  /** Defaults to `REKEY_SECRET` from the environment. */
  secretKey?: string;
  /**
   * Defaults to `REKEY_URL`. Required, there is deliberately no fallback.
   *
   * On Rekey Cloud this is `https://api.rekey.dev`; self-hosted it is your own
   * deployment's public origin. This used to fall back to `api.rekey.dev`,
   * which meant a self-hosted deployment that forgot the variable sent its
   * `REKEY_SECRET` to a host its operator never chose. See the throw below.
   */
  apiUrl?: string;
  /**
   * Force the `Secure` flag instead of deciding per request. Only set this to
   * `false` when serving plain HTTP on a hostname that is not localhost, a
   * LAN box, or a proxy that sets no forwarded proto. Otherwise leave it.
   */
  cookieSecure?: boolean;
  /**
   * The machine this session belongs to, for an Application that binds
   * sessions to devices (docs/devices.md).
   *
   * This matters on refresh and not only at sign-in. The API binds a chain at
   * sign-in and re-checks it on every rotation: a bound chain refreshed from a
   * different fingerprint is `REFRESH_TOKEN_DEVICE_MISMATCH`, which is treated
   * as a stolen token and revokes every session the user has. The middleware
   * (and `getSession` with `refresh: true`) rotates, so a site that signs users in with a `device` and then refreshes
   * without one is refreshing as an unidentified machine. Leave it unset and
   * nothing changes: no key is sent, and an unbound chain stays unbound.
   *
   * A browser cannot produce a fingerprint worth having, so this is for a site
   * fronting a desktop or mobile client that computes one.
   */
  device?: { fingerprint: string; label?: string };
}

/** Hosts a browser already treats as a secure context over plain HTTP. */
function isLoopback(host: string): boolean {
  const bare = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : (host.split(':')[0] ?? '');
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
 * Deliberately reads `x-forwarded-proto` but NOT `x-forwarded-host`: a client
 * can send the latter, and letting it decide would let somebody ask for a
 * session cookie without `Secure`. The `Host` header is set by the connection.
 *
 * The fallback leans secure, because the two failure directions are not
 * symmetric, see the module docblock.
 */
export function cookieSecureFor(request: Request, override?: boolean): boolean {
  if (override !== undefined) return override;
  // Same precedence as `@rekey.dev/nextjs`: an operator who has to override
  // this on a platform where they cannot patch code needs an env var.
  const env = readEnv('REKEY_COOKIE_SECURE');
  if (env === 'true') return true;
  if (env === 'false') return false;
  const proto = (request.headers.get('x-forwarded-proto') ?? '').split(',')[0]?.trim().toLowerCase();
  if (proto === 'https') return true;
  return !isLoopback(request.headers.get('host') ?? '');
}

function readEnv(name: string): string | undefined {
  // `process` is not guaranteed in every Astro runtime; read defensively so
  // this module can be imported in an edge build without exploding.
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

let cached: { key: string; client: Rekey } | undefined;

/**
 * The server client, built on first use.
 *
 * The constructor validates the key, so building it at module scope would make
 * a missing variable an unhandled throw during module evaluation rather than
 * an error you can catch and report.
 */
export function rekey(config: RekeyAstroConfig = {}): Rekey {
  const secretKey = config.secretKey ?? readEnv('REKEY_SECRET');
  if (!secretKey) {
    throw new RekeyAstroConfigError(
      '@rekey.dev/astro: REKEY_SECRET is not set. Note the built server reads ' +
        'process.env, not .env — Vite loads .env for `astro dev` only.',
    );
  }
  // No fallback, deliberately, and this one is not a convenience question.
  //
  // It used to default to `https://api.rekey.dev`. A self-hosted deployment
  // that forgot `REKEY_URL` therefore did not fail, it sent its own
  // `REKEY_SECRET`, in an Authorization header, to a host its operator never
  // chose. The request fails at that host (the key is unknown there), but the
  // credential has already left, and the only symptom is a confusing 401.
  //
  // `decisions.md` (2026-07-30, "removed every default that quietly pointed a
  // self-hosted deployment at Rekey-owned values") settled this for the panel
  // and marketing apps; this SDK arrived after that pass and reintroduced the
  // pattern. The other SDKs (`@rekey.dev/node`, `@rekey.dev/nextjs`) have
  // always required the value. This makes the three agree.
  const apiUrl = config.apiUrl ?? readEnv('REKEY_URL');
  if (!apiUrl) {
    throw new RekeyAstroConfigError(
      '@rekey.dev/astro: REKEY_URL is not set. On Rekey Cloud it is ' +
        "https://api.rekey.dev; self-hosted it is your own deployment's public origin " +
        '(locally, http://localhost:3030). Note the built server reads process.env, not ' +
        '.env — Vite loads .env for `astro dev` only.',
    );
  }

  // Keyed on the resolved config, not just "have we built one". A single
  // cached client meant the first caller won and every later config was
  // discarded in silence, in an app serving two Applications, that is one
  // tenant's requests going out with the other's credential.
  const key = `${secretKey}\u0000${apiUrl}`;
  if (cached?.key === key) return cached.client;

  try {
    const client = new Rekey({ secretKey, apiUrl });
    cached = { key, client };
    return client;
  } catch (err) {
    // The constructor validates the key shape. That is a deployment mistake,
    // not an API failure, and it must not be reported as "signed out".
    throw new RekeyAstroConfigError(
      `@rekey.dev/astro: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Write both session cookies.
 *
 * The runtime check is not paranoia. `signIn` returns a union discriminated on
 * `mfaRequired`, and the token-less arm carries a challenge instead, but the
 * shared DTOs are inferred from Zod schemas typed as `any`, so handing this
 * function an MFA outcome type-checks cleanly and then writes the string
 * "undefined" into a session cookie. Failing loudly here costs one line and
 * turns a session that is silently broken into a stack trace naming the cause.
 */
export function setSession(
  cookies: CookieJar,
  request: Request,
  tokens: { accessToken: string; refreshToken: string },
  config: RekeyAstroConfig = {},
): void {
  if (!tokens?.accessToken || !tokens.refreshToken) {
    throw new Error(
      '@rekey.dev/astro: setSession got no tokens. If this came from signIn(), ' +
        'check `mfaRequired` first — that arm returns an mfaChallengeToken, not a session.',
    );
  }
  const base = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: cookieSecureFor(request, config.cookieSecure),
  } as const;
  resolvedByMiddleware.delete(cookies);
  cookies.set(ACCESS_COOKIE, tokens.accessToken, { ...base, maxAge: ACCESS_MAX_AGE });
  cookies.set(REFRESH_COOKIE, tokens.refreshToken, { ...base, maxAge: REFRESH_MAX_AGE });
}

/** Clear both session cookies. */
export function clearSession(cookies: CookieJar): void {
  // What the middleware resolved is stale once the cookies change.
  resolvedByMiddleware.delete(cookies);
  cookies.delete(ACCESS_COOKIE, { path: '/' });
  cookies.delete(REFRESH_COOKIE, { path: '/' });
}

export interface GetSessionOptions {
  /**
   * Rotate the refresh token when the access token has expired. Off by
   * default, and only safe where the response has not started yet: an API
   * endpoint, or the top-level frontmatter of a page (not a layout, and not an
   * imported component). `rekeyMiddleware` already does this for every
   * request, and once it has run this option does nothing.
   *
   * Why it is not the default: the API rotates on every refresh, the spent
   * token is dead the moment the new pair is issued, and a later replay of it
   * reads as a stolen credential, which revokes every session the user has on
   * every device. Astro gives no reliable way to ask whether the response has
   * started. In production `cookies.set()` after that point only logs a
   * warning, so the new pair is dropped in silence while the browser keeps the
   * spent token, and its next request signs the user out everywhere.
   */
  refresh?: boolean;
}

/**
 * What the middleware resolved for a request, keyed on that request's cookie
 * jar (Astro hands the middleware and the page the same instance). Recorded
 * whatever the outcome, including a failure, so a jar the middleware has seen
 * is never rotated again in that request: the one rotation a request gets
 * happens before `next()`, where the replacement cookies are certain to reach
 * the browser. Dropped when `setSession` or `clearSession` changes the
 * cookies, after which the jar holds either a fresh access token or no
 * refresh token, so there is nothing left to rotate.
 */
const resolvedByMiddleware = new WeakMap<object, Session | null>();

/** Set by `astro dev` on the request once the response has gone out. */
const RESPONSE_SENT = Symbol.for('astro.responseSent');

function responseSent(request: Request): boolean {
  return (request as unknown as Record<symbol, unknown>)[RESPONSE_SENT] === true;
}

let warnedNoRefresh = false;

/**
 * Resolve the session.
 *
 * Inside a request `rekeyMiddleware` handled, this returns what the middleware
 * resolved (the same value as `Astro.locals.session`), without another API
 * call. Anywhere else it reads the access token and does NOT refresh unless
 * asked to with `{ refresh: true }`, see {@link GetSessionOptions}: when the
 * access token has expired it returns null and leaves the refresh token alone,
 * so the next request's middleware can rotate it safely.
 *
 * Returns null when signed out. Throws only when the API failed in a way that
 * is not about the token, an unreachable API is not a signed-out user, and
 * reporting it as one is how a blip becomes a mass logout.
 */
export async function getSession(
  cookies: CookieJar,
  request: Request,
  config: RekeyAstroConfig = {},
  options: GetSessionOptions = {},
): Promise<Session | null> {
  if (resolvedByMiddleware.has(cookies)) return resolvedByMiddleware.get(cookies) ?? null;
  return resolveSession(cookies, request, config, options.refresh === true);
}

/**
 * May this request rotate the refresh token?
 *
 * Only when the browser says it came from this origin (`same-origin`) or from
 * the user (`none`: typed, bookmarked, reloaded). The refresh cookie is
 * SameSite=Lax, so a cross-site top-level navigation carries it: a page on
 * another site could start one and abort it after the API rotated, dropping
 * the new cookies. The browser keeps the spent token, and its next refresh is
 * the replay that makes the API revoke every session the user has. A request
 * without the header is an older browser, or not a browser, and proceeds.
 * `same-site` is refused too: a sibling subdomain is not this origin.
 */
function mayRotateFrom(headers: Headers): boolean {
  const site = headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}

/** Thrown to the middleware when a cross-site request would have rotated. */
class CrossSiteRefreshDeferred extends Error {}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A tiny page that asks for `sameOriginPath` again from this origin, touching
 * no cookie. The meta refresh (and the link, for a browser that ignores it)
 * is a navigation this origin starts, so it arrives as `same-origin` and the
 * middleware rotates then. A redirect would not do: a redirect chain keeps
 * its cross-site marking. No script; framing refused; and
 * `Cross-Origin-Opener-Policy` cuts the link to a cross-site opener, so the
 * page that opened this one cannot navigate it away mid-refresh.
 */
function refreshInterstitial(sameOriginPath: string): Response {
  const href = escapeHtml(sameOriginPath);
  const body =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="robots" content="noindex">' +
    `<meta http-equiv="refresh" content="0;url=${href}">` +
    '<title>Continuing</title></head><body>' +
    `<p><a href="${href}">Continue</a></p>` +
    '</body></html>';
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

async function resolveSession(
  cookies: CookieJar,
  request: Request,
  config: RekeyAstroConfig,
  mayRotate: boolean,
  fromMiddleware = false,
): Promise<Session | null> {
  const client = rekey(config);
  const access = cookies.get(ACCESS_COOKIE)?.value;

  if (access) {
    try {
      return { user: await client.auth.getCurrentUser(access), accessToken: access };
    } catch (err) {
      if (!(err instanceof RekeyError) || !isAccessTokenSpent(err.code)) throw err;
    }
  }

  const refresh = cookies.get(REFRESH_COOKIE)?.value;
  if (!refresh) return null;

  // Never rotate for a request another site started. See mayRotateFrom.
  // Signed out for this request only; the cookies stay as they are.
  if (mayRotate && !mayRotateFrom(request.headers)) {
    if (fromMiddleware) throw new CrossSiteRefreshDeferred();
    return null;
  }

  // Never spend a refresh token we cannot store the replacement for. See
  // GetSessionOptions for why this is opt-in. The dev-server flag is a second
  // line only: production Astro never sets it, so it cannot be the guard.
  if (!mayRotate || responseSent(request)) {
    if (!warnedNoRefresh) {
      warnedNoRefresh = true;
      console.warn(
        '[rekey] getSession found an expired access token and did not refresh it, ' +
          'because refreshing here could spend the refresh token without storing its ' +
          'replacement. Add rekeyMiddleware() to src/middleware.ts, or pass ' +
          '{ refresh: true } from an API endpoint or top-level page frontmatter.',
      );
    }
    return null;
  }

  let fresh: { accessToken: string; refreshToken: string };
  try {
    // Two calls rather than `{ device: undefined }`: the API bodies are
    // strict, and a present-but-undefined key is not an absent one once it has
    // been through JSON.
    fresh = config.device
      ? await client.auth.refresh(refresh, { device: config.device })
      : await client.auth.refresh(refresh);
  } catch (err) {
    if (!(err instanceof RekeyError)) throw err;
    let failure = classifyRefreshFailure(err);
    if (failure === 'raced') {
      // Rethrown with the session cookies untouched: this request carried the
      // old pair and cannot finish, but the user is still signed in. Once per
      // token, see RACED_COOKIE.
      const mark = await racedMark(refresh);
      if (cookies.get(RACED_COOKIE)?.value !== mark) {
        cookies.set(RACED_COOKIE, mark, {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure: cookieSecureFor(request, config.cookieSecure),
          maxAge: RACED_MAX_AGE,
        });
        throw err;
      }
      failure = 'verdict';
    }
    if (failure !== 'unspent') clearSession(cookies);
    if (failure === 'verdict') return null;
    throw err;
  }
  setSession(cookies, request, fresh, config);
  return {
    user: await client.auth.getCurrentUser(fresh.accessToken),
    accessToken: fresh.accessToken,
  };
}

/**
 * What a failed refresh left behind. The same rules as `@rekey.dev/nextjs`.
 *
 *   - `raced`: `REFRESH_TOKEN_RACED`, see {@link isRacedCode}. Keep the
 *     cookies and throw, once per token (see {@link RACED_COOKIE}).
 *   - `verdict`: the API says the token is finished. Clear the cookies.
 *   - `unspent`: the API refused before rotating, or the request provably never
 *     left this host. The token is still good: keep the cookies, try later.
 *   - `maybe-spent`: anything else. Clear the cookies, and still throw.
 *
 * The API rotates the token FIRST and only then does the fallible rest (the
 * device write, the organization check, minting the access token). A 5xx, a
 * timeout, or a connection dropped mid-request can therefore arrive after the
 * token was spent. Keeping the cookie then means the next request presents a
 * spent token, the API answers `REFRESH_TOKEN_REUSED`, and reuse detection
 * revokes every session the user has on every device. Signing this browser out
 * is the lesser harm. Only failures that cannot have rotated are kept:
 *
 *   - a 429 or any other 4xx: every refusal after the rotation is re-coded as
 *     a `REFRESH_TOKEN_*` verdict by the API, so a 4xx without that prefix came
 *     before it, and the refresh limiter answers before the handler runs;
 *   - a connection that was never made (DNS failure, connection refused,
 *     connect timeout): no byte of the request was sent;
 *   - a 502, 503 or 504 with no Rekey error envelope: a proxy answering while
 *     the API restarts (see {@link isGatewayFailure}).
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
 * A 502, 503 or 504 that did not come from Rekey: no Rekey error envelope, so
 * `@rekey.dev/node` reports it as `UNKNOWN_ERROR`. That is a proxy in front of
 * the API answering for it, almost always because the API is restarting
 * (every deploy) and nothing is listening yet. The refresh never reached the
 * API, so the token is unspent. A 5xx WITH a Rekey code is the API itself
 * answering, possibly after it rotated, and is not this.
 */
function isGatewayFailure(err: RekeyError): boolean {
  const status = err.statusCode;
  if (status !== 502 && status !== 503 && status !== 504) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code !== 'string' || code === '' || code === 'UNKNOWN_ERROR';
}

/** Transport codes that mean no connection was ever made, so nothing was sent. */
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Walks `fetch failed` down to the socket error. Node reports a refused
 * `localhost` as an AggregateError over both address families, so every one of
 * those has to be a never-connected error too.
 */
function neverConnected(cause: unknown, depth = 0): boolean {
  if (!cause || typeof cause !== 'object' || depth > 5) return false;
  const c = cause as { code?: unknown; errors?: unknown; cause?: unknown };
  if (Array.isArray(c.errors) && c.errors.length > 0) {
    return c.errors.every((e) => neverConnected(e, depth + 1));
  }
  if (typeof c.code === 'string') return NEVER_CONNECTED.has(c.code);
  return neverConnected(c.cause, depth + 1);
}

/**
 * Revoke the refresh token, then clear the cookies.
 *
 * Clearing alone signs the browser out; revoking signs the *session* out. A
 * thirty-day token that is still valid server-side after somebody clicks
 * "Sign out" is a credential anyone holding a copy can keep using.
 */
export async function signOut(
  cookies: CookieJar,
  config: RekeyAstroConfig = {},
): Promise<SignOutResult> {
  const refresh = cookies.get(REFRESH_COOKIE)?.value;
  if (!refresh) {
    clearSession(cookies);
    return { revoked: true };
  }

  try {
    await rekey(config).auth.signOut(refresh);
    clearSession(cookies);
    return { revoked: true };
  } catch (err) {
    // The cookies go either way: the person clicked sign out, and the browser
    // must stop presenting the credential.
    clearSession(cookies);

    // But whether the token is dead server-side is a different question, and
    // collapsing the two is the exact mistake getSession exists to avoid. A
    // token that is already expired or revoked needs no revoking. A timeout
    // means a thirty-day credential is still live and anyone holding a copy
    // can keep using it, the caller is told so it can retry or alert.
    if (err instanceof RekeyError && isTokenVerdict(err.code)) {
      return { revoked: true };
    }
    return { revoked: false, error: err };
  }
}

/**
 * Reduce a caller-supplied `next` value to a path on this site.
 *
 * `startsWith('/') && !startsWith('//')` is the obvious check and it is wrong:
 * `/\evil.com` passes it, and browsers resolve that off-origin. Parsing alone
 * is wrong too, and this function used to rely on it: WHATWG URL collapses dot
 * segments, so `/..//evil.com`, `/x/..//evil.com`, `/%2e%2e//evil.com` and
 * `/.//evil.com` all parse to the pathname `//evil.com`, which a browser reads
 * as a protocol-relative URL to another host.
 *
 * So the input is refused outright, rather than cleaned, when it has a control
 * character (a browser strips tab, CR and LF before parsing, so `/\t/evil.com`
 * becomes `//evil.com`), any backslash (browsers read `\` as `/`), or does not
 * start with exactly one `/`. What survives is resolved against a placeholder
 * origin, must still be on it, and is rebuilt from the PARSED url. The rebuilt
 * value is checked again, because parsing is not a no-op: it must start with
 * exactly one `/` whatever the input looked like.
 *
 * An encoded slash, backslash or control character in the path is refused
 * too. A browser leaves those encoded, so they are not an escape on their own,
 * but a proxy or a sign-in page that decodes `next` once before using it would
 * turn `/..%2f/evil.com` back into something that is.
 *
 * The layers overlap on purpose. Keep all of them. The same rules live in
 * `@rekey.dev/nextjs` (`safeReturnPath`); the copy is deliberate, so neither
 * published package depends on the other.
 */
export function safePath(next: string | null | undefined, fallback: string): string {
  // `String(form.get('next'))` on an absent field yields the literal "null",
  // which is truthy, resolves to the path `/null`, and sends every sign-in
  // without a `next` field to a 404 while the fallback sits there unused. It
  // is the idiom every Astro user reaches for, so it is handled here.
  if (!next || next === 'null' || next === 'undefined') return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(next) || next.includes('\\')) return fallback;
  if (!isSingleSlashPath(next)) return fallback;

  let url: URL;
  try {
    url = new URL(next, PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return fallback;
  if (ENCODED_SEPARATOR_OR_CONTROL.test(url.pathname)) return fallback;
  const rebuilt = `${url.pathname}${url.search}${url.hash}`;
  return isSingleSlashPath(rebuilt) ? rebuilt : fallback;
}

const PLACEHOLDER_ORIGIN = 'http://internal.invalid';

/** `%2F`, `%5C`, or an encoded C0 control or DEL, in either case. */
const ENCODED_SEPARATOR_OR_CONTROL = /%(?:2f|5c|[01][0-9a-f]|7f)/i;

/** Starts with exactly one `/`, not `//` or `/\` (which a browser reads as `//`). */
function isSingleSlashPath(value: string): boolean {
  return value.startsWith('/') && value[1] !== '/' && value[1] !== '\\';
}

/** The middleware context this package needs. Structural, so Astro stays a peer. */
interface MiddlewareContext {
  cookies: CookieJar;
  request: Request;
  locals: Record<string, unknown>;
}

/**
 * Astro middleware that puts the session on `Astro.locals.session`.
 *
 * One refresh refusal does not end the session: `REFRESH_TOKEN_RACED`, a
 * second tab having rotated the same token moments earlier. A GET or HEAD is
 * then answered with a 303 to its own URL, cookies untouched, so the browser
 * comes back with the winner's pair; any other method continues signed out for
 * that request only. The same token racing twice is treated as finished.
 *
 * This is where a request refreshes an expired session, and the only place it
 * does by default: before `next()`, the response has not started, so the
 * rotated cookies are certain to reach the browser. `getSession` called later
 * in the same request returns what this resolved and never rotates again.
 *
 * It does NOT protect routes: whether a route needs a session is a property of
 * the route, so that check belongs in the page. It also never lets a failure
 * escape, this runs on every route, so an uncaught error would take down the
 * public pages, the sign-in page, and the sign-out endpoint that could clear a
 * poisoned cookie, leaving a visitor with no way back in.
 */
export function rekeyMiddleware(config: RekeyAstroConfig = {}) {
  return async function onRequest(
    context: MiddlewareContext,
    next: () => Promise<Response>,
  ): Promise<Response> {
    // The one place a request rotates the refresh token: before next(), so
    // the replacement cookies are certain to make it into the response.
    try {
      const session = await resolveSession(context.cookies, context.request, config, true, true);
      context.locals.session = session;
      resolvedByMiddleware.set(context.cookies, session);
    } catch (err) {
      // A cross-site request whose session needs a rotation. A page load is
      // asked for again from this origin; anything else is signed out for
      // this one request. Either way no cookie is touched.
      if (err instanceof CrossSiteRefreshDeferred) {
        const { method } = context.request;
        const dest = context.request.headers.get('sec-fetch-dest');
        if ((method === 'GET' || method === 'HEAD') && (dest === null || dest === 'document')) {
          const url = new URL(context.request.url);
          return refreshInterstitial(safePath(`${url.pathname}${url.search}`, '/'));
        }
        context.locals.session = null;
        resolvedByMiddleware.set(context.cookies, null);
        return next();
      }
      // A misconfigured deploy must not present as "everybody is signed out".
      // Swallowing this renders the site perfectly, bounces every protected
      // page to sign-in, and leaves one log line per request as the only
      // evidence, the silent failure this package exists to refuse.
      if (err instanceof RekeyAstroConfigError) throw err;
      // Another request (a second tab) won the rotation and nothing was
      // revoked. A page load goes round again to its own URL, so the browser
      // sends the cookies it holds now, the winner's pair; the redirect
      // carries only the loop guard. Anything else (a form POST, whose body
      // a redirect would drop) renders signed out for this one request with
      // the session cookies kept.
      if (err instanceof RekeyError && isRacedCode(err.code)) {
        const method = context.request.method;
        if (method === 'GET' || method === 'HEAD') {
          const url = new URL(context.request.url);
          // Through safePath: a request for `//evil.example/x` has that as
          // its pathname, and echoed raw it is a protocol-relative redirect.
          const back = safePath(`${url.pathname}${url.search}`, '/');
          return new Response(null, {
            status: 303,
            headers: { Location: back, 'Cache-Control': 'no-store' },
          });
        }
        context.locals.session = null;
        resolvedByMiddleware.set(context.cookies, null);
        return next();
      }
      console.error('[rekey] session read failed, continuing signed out:', err);
      context.locals.session = null;
      resolvedByMiddleware.set(context.cookies, null);
    }
    return next();
  };
}
