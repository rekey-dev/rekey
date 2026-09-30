/**
 * The operator MFA challenge token, carried between the first factor and
 * /mfa-verify in an httpOnly cookie rather than the URL.
 *
 * The token is a signed bearer credential for the second step of one sign-in.
 * In a query string it landed in the access log, browser history and anything
 * else that records URLs. The cookie is scoped to /mfa-verify, the only path
 * that reads it, and expires with the token.
 */

import { cookieSecure } from './cookie-secure';

export const MFA_CHALLENGE_COOKIE = 'rk_mfa_challenge';
export const MFA_CHALLENGE_PATH = '/mfa-verify';

/** The API's challenge lifetime, used when the token carries no readable `exp`. */
export const MFA_CHALLENGE_DEFAULT_MAX_AGE_SECONDS = 5 * 60;

interface ChallengeCookieSink {
  set(
    name: string,
    value: string,
    options: { httpOnly: true; sameSite: 'lax'; secure: boolean; path: string; maxAge: number },
  ): unknown;
}

interface ChallengeCookieEraser {
  delete(options: { name: string; path: string }): unknown;
}

/**
 * Seconds until the challenge token's `exp`, so the cookie dies with it. The
 * payload is read unverified: the API verifies the token, this only sizes a
 * cookie, and the result is clamped to the API's lifetime either way.
 *
 * @example
 * challengeMaxAge(token, Date.now()); // 300 for a freshly minted token
 */
export function challengeMaxAge(token: string, nowMs: number): number {
  const payload = token.split('.')[1];
  if (!payload) return MFA_CHALLENGE_DEFAULT_MAX_AGE_SECONDS;
  let exp: unknown;
  try {
    exp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
  } catch {
    return MFA_CHALLENGE_DEFAULT_MAX_AGE_SECONDS;
  }
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return MFA_CHALLENGE_DEFAULT_MAX_AGE_SECONDS;
  const remaining = Math.floor(exp - nowMs / 1000);
  return Math.max(1, Math.min(remaining, MFA_CHALLENGE_DEFAULT_MAX_AGE_SECONDS));
}

/**
 * Store the challenge on `jar`: the `cookies()` store in a Server Action, or a
 * Route Handler's response cookies.
 *
 * @example
 * await writeMfaChallenge(await cookies(), result.mfaChallengeToken);
 * redirect('/mfa-verify');
 */
export async function writeMfaChallenge(jar: ChallengeCookieSink, token: string): Promise<void> {
  jar.set(MFA_CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: await cookieSecure(),
    path: MFA_CHALLENGE_PATH,
    maxAge: challengeMaxAge(token, Date.now()),
  });
}

/**
 * Drop any pending challenge. Called whenever a sign-in completes, restarts or
 * ends, so an abandoned challenge does not outlive the attempt it belongs to.
 *
 * @example
 * clearMfaChallenge(res.cookies);
 */
export function clearMfaChallenge(jar: ChallengeCookieEraser): void {
  jar.delete({ name: MFA_CHALLENGE_COOKIE, path: MFA_CHALLENGE_PATH });
}

/**
 * The `/mfa-verify` URL, carrying only the non-secret `next` and `error`.
 *
 * @example
 * mfaVerifyPath({ next: '/team' }); // '/mfa-verify?next=%2Fteam'
 */
export function mfaVerifyPath(args: { next?: string | null; error?: string }): string {
  const query = new URLSearchParams();
  if (args.error) query.set('error', args.error);
  if (args.next) query.set('next', args.next);
  const qs = query.toString();
  return qs ? `${MFA_CHALLENGE_PATH}?${qs}` : MFA_CHALLENGE_PATH;
}
