import { retryQuery } from './auth-error-copy';
import { isSocialSignInCode } from './social-sign-in-copy';

/**
 * The sign-in page for a social sign-in that ended in `code`. Codes only this
 * path has carry the provider for the message; codes every sign-in shares use
 * the page's usual `?error=`, so EMAIL_NOT_VERIFIED still offers a new link.
 *
 * @example
 * socialSignInFailurePath('acme', 'OAUTH_CANCELED', 'google'); // '/acme/login?social_error=OAUTH_CANCELED&provider=google'
 * socialSignInFailurePath('acme', 'END_USER_BANNED', 'google'); // '/acme/login?error=END_USER_BANNED'
 */
export function socialSignInFailurePath(
  slug: string,
  code: string,
  provider: string,
  retryAfterSeconds?: number,
): string {
  const c = encodeURIComponent(code);
  if (isSocialSignInCode(code)) return `/${slug}/login?social_error=${c}&provider=${encodeURIComponent(provider)}`;
  return `/${slug}/login?error=${c}${retryQuery(retryAfterSeconds)}`;
}
