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
 *     the refresh cookie — the one credential that could have recovered the
 *     session — has been deleted.
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
 * `REFRESH_TOKEN_*` codes today — EXPIRED, INVALID, REUSED, REVOKED, RACE and
 * WRONG_APPLICATION — and every one of them is a 401 saying this token will
 * never work again. An enumerated list gets this right on the day it is
 * written and silently wrong the day a seventh is added: the missed code falls
 * through to "the API failed", the dead cookie is never cleared, and the
 * browser re-presents it on every request for the next thirty days while the
 * user sees a signed-out page. REVOKED alone covers "sign out my other
 * devices", which is not an edge case.
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
   * Defaults to `REKEY_URL`. Required — there is deliberately no fallback.
   *
   * On Rekey Cloud this is `https://api.rekey.dev`; self-hosted it is your own
   * deployment's public origin. This used to fall back to `api.rekey.dev`,
   * which meant a self-hosted deployment that forgot the variable sent its
   * `REKEY_SECRET` to a host its operator never chose. See the throw below.
   */
  apiUrl?: string;
  /**
   * Force the `Secure` flag instead of deciding per request. Only set this to
   * `false` when serving plain HTTP on a hostname that is not localhost — a
   * LAN box, or a proxy that sets no forwarded proto. Otherwise leave it.
   */
  cookieSecure?: boolean;
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
 * symmetric — see the module docblock.
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
  // that forgot `REKEY_URL` therefore did not fail — it sent its own
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
  // discarded in silence — in an app serving two Applications, that is one
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
 * `mfaRequired`, and the token-less arm carries a challenge instead — but the
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
  cookies.set(ACCESS_COOKIE, tokens.accessToken, { ...base, maxAge: ACCESS_MAX_AGE });
  cookies.set(REFRESH_COOKIE, tokens.refreshToken, { ...base, maxAge: REFRESH_MAX_AGE });
}

/** Clear both session cookies. */
export function clearSession(cookies: CookieJar): void {
  cookies.delete(ACCESS_COOKIE, { path: '/' });
  cookies.delete(REFRESH_COOKIE, { path: '/' });
}

/**
 * Resolve the session, refreshing when the access token has expired.
 *
 * Returns null when signed out. Throws only when the API failed in a way that
 * is not about the token — an unreachable API is not a signed-out user, and
 * reporting it as one is how a blip becomes a mass logout.
 */
export async function getSession(
  cookies: CookieJar,
  request: Request,
  config: RekeyAstroConfig = {},
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

  // Never spend a refresh token we cannot store the replacement for.
  //
  // The API rotates on every refresh: the presented token is revoked the
  // moment the new pair is issued, and a later replay of it reads as a stolen
  // credential, which revokes every session the user has on every device.
  // Astro throws from `cookies.set()` once the response has started — calling
  // getSession() from an imported component rather than middleware or
  // top-level frontmatter does exactly that. Without this probe the sequence
  // is: refresh succeeds, the old token is dead, setSession throws, the
  // browser still holds the spent token, and the next request signs the user
  // out everywhere. Reporting no session costs one redirect to sign-in.
  if (!canWrite(cookies)) return null;

  try {
    const fresh = await client.auth.refresh(refresh);
    setSession(cookies, request, fresh, config);
    return {
      user: await client.auth.getCurrentUser(fresh.accessToken),
      accessToken: fresh.accessToken,
    };
  } catch (err) {
    // Only a verdict about the token clears it. A timeout leaves the refresh
    // cookie alone so the next request can try again.
    if (err instanceof RekeyError && isTokenVerdict(err.code)) {
      clearSession(cookies);
      return null;
    }
    throw err;
  }
}

/** Deleting a cookie nothing ever sets. Never reaches the browser. */
const PROBE_COOKIE = '__rekey_probe';

/** Whether this context may still write cookies. See the call site. */
function canWrite(cookies: CookieJar): boolean {
  try {
    cookies.delete(PROBE_COOKIE, { path: '/' });
    return true;
  } catch {
    return false;
  }
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
    // can keep using it — the caller is told so it can retry or alert.
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
 * `/\evil.com` passes it, and browsers resolve that off-origin. Asking the same
 * parser the browser will use is the version that holds.
 */
export function safePath(next: string | null | undefined, fallback: string): string {
  // `String(form.get('next'))` on an absent field yields the literal "null",
  // which is truthy, resolves to the path `/null`, and sends every sign-in
  // without a `next` field to a 404 while the fallback sits there unused. It
  // is the idiom every Astro user reaches for, so it is handled here.
  if (!next || next === 'null' || next === 'undefined') return fallback;
  try {
    const url = new URL(next, 'http://internal.invalid');
    if (url.origin !== 'http://internal.invalid') return fallback;
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
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
 * It does NOT protect routes: whether a route needs a session is a property of
 * the route, so that check belongs in the page. It also never lets a failure
 * escape — this runs on every route, so an uncaught error would take down the
 * public pages, the sign-in page, and the sign-out endpoint that could clear a
 * poisoned cookie, leaving a visitor with no way back in.
 */
export function rekeyMiddleware(config: RekeyAstroConfig = {}) {
  return async function onRequest(
    context: MiddlewareContext,
    next: () => Promise<Response>,
  ): Promise<Response> {
    try {
      context.locals.session = await getSession(context.cookies, context.request, config);
    } catch (err) {
      // A misconfigured deploy must not present as "everybody is signed out".
      // Swallowing this renders the site perfectly, bounces every protected
      // page to sign-in, and leaves one log line per request as the only
      // evidence — the silent failure this package exists to refuse.
      if (err instanceof RekeyAstroConfigError) throw err;
      console.error('[rekey] session read failed, continuing signed out:', err);
      context.locals.session = null;
    }
    return next();
  };
}
