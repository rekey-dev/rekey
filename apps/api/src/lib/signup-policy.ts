/**
 * End-user sign-up policy, the single chokepoint that decides whether a
 * given request is allowed to CREATE a new end-user.
 *
 * Driven by `authConfig.signupMode` (see @rekey.dev/shared-types):
 *   - `public`     , any caller may create users.
 *   - `secret_only`, only a server-side SECRET key may; a publishable
 *                     (`rp_pub_*`) request is refused. Sign-IN is unaffected,
 *                     this gates creation only.
 *   - `invite_only`, nobody may self-sign-up; an operator creates the user
 *                     (panel or tenant route) or imports it with a secret key.
 *
 * and then by `authConfig.signupRestrictions`, the email domain rules. Only
 * self sign-up passes through here: operator-created, imported and
 * billing-synced users never do, so the rules never apply to them.
 *
 * `authKind` comes from the api-key-auth middleware (`request.authKind`).
 * It is `undefined` only on code paths with no key context, treat that as
 * "not a publishable browser caller" (i.e. server-side), so it never trips
 * the `secret_only` guard. Every public sign-up entry point runs through
 * `requirePublishableOrSecretKey`, which always sets it, so in practice it is
 * defined at all real call sites.
 */

import {
  domainMatchesRule,
  normalizeDomain,
  type AuthConfig,
  type SignupRestrictions,
} from '@rekey.dev/shared-types';
import { RekeyError } from './error.js';
import { isDisposableDomain } from './disposable-domains.js';

export type AuthKind = 'secret' | 'publishable';

type SignupPolicy = Pick<AuthConfig, 'signupMode' | 'signupRestrictions'>;

/**
 * Whether the operator's domain rules let this address self sign-up.
 *
 * A null email is not judged here: the one caller that can hold one (an OAuth
 * provider that returned no address) refuses it next with the more precise
 * `OAUTH_NO_EMAIL`.
 */
export function emailDomainAllowed(
  restrictions: SignupRestrictions | undefined,
  email: string | null,
): boolean {
  if (!restrictions || email === null) return true;
  const allowed = restrictions.allowedDomains ?? [];
  const at = email.lastIndexOf('@');
  const domain = at === -1 ? null : normalizeDomain(email.slice(at + 1));
  if (domain === null) return allowed.length === 0 && restrictions.blockDisposable !== true;
  if ((restrictions.blockedDomains ?? []).some((rule) => domainMatchesRule(domain, rule))) {
    return false;
  }
  if (restrictions.blockDisposable === true && isDisposableDomain(domain)) return false;
  return allowed.length === 0 || allowed.some((rule) => domainMatchesRule(domain, rule));
}

/**
 * Predicate form, `true` when this caller may create an end-user with this
 * email. Use when the caller needs to branch silently (e.g. enumeration-safe
 * magic-link request) rather than surface a specific error.
 */
export function signupAllowed(
  config: SignupPolicy,
  authKind: AuthKind | undefined,
  email: string | null,
): boolean {
  if (config.signupMode === 'invite_only') return false;
  if (config.signupMode === 'secret_only' && authKind === 'publishable') return false;
  return emailDomainAllowed(config.signupRestrictions, email);
}

/**
 * Throwing form, call immediately before any self sign-up create. Throws the
 * precise error for the failing rule so the SDK/caller can react:
 *   - `invite_only`              → 403 `SIGNUP_DISABLED`
 *   - `secret_only` + publishable → 403 `SIGNUP_REQUIRES_SECRET_KEY`
 *   - `signupRestrictions`        → 403 `SIGNUP_EMAIL_DOMAIN_NOT_ALLOWED`
 */
export function assertSignupAllowed(
  config: SignupPolicy,
  authKind: AuthKind | undefined,
  email: string | null,
): void {
  if (config.signupMode === 'invite_only') {
    throw new RekeyError({
      statusCode: 403,
      code: 'SIGNUP_DISABLED',
      message: 'Public sign-up is disabled for this application.',
      fix:
        'Create the end-user as an operator instead: the panel End-users page ("+ New end-user"), ' +
        'POST /api/v1/tenant/applications/:id/end-users, or POST /api/v1/users/import with a secret key. ' +
        'Or set signupMode to public or secret_only.',
    });
  }
  if (config.signupMode === 'secret_only' && authKind === 'publishable') {
    throw new RekeyError({
      statusCode: 403,
      code: 'SIGNUP_REQUIRES_SECRET_KEY',
      message:
        'This application only allows creating end-users with a server-side secret key. ' +
        'The publishable key can sign existing users in, but cannot create them.',
      fix: 'Call sign-up from your server with a secret key (rp_live_… / rp_test_…). Keep the publishable key for browser sign-in only.',
    });
  }
  if (!emailDomainAllowed(config.signupRestrictions, email)) {
    // The person signing up reads this message, so it never names the allowed
    // domains: that list belongs to the operator and is often a customer list.
    throw new RekeyError({
      statusCode: 403,
      code: 'SIGNUP_EMAIL_DOMAIN_NOT_ALLOWED',
      message: 'Sign-up with this email address is not allowed for this application.',
      fix:
        'Sign up with a different email address. Operators choose which domains may sign up ' +
        'with `authConfig.signupRestrictions` (Panel → Application → Auth → Sign-up email rules), ' +
        'and can still create this user with POST /api/v1/tenant/applications/:id/end-users.',
    });
  }
}
