/**
 * End-user sign-up policy — the single chokepoint that decides whether a
 * given request is allowed to CREATE a new end-user.
 *
 * Driven by `authConfig.signupMode` (see @relipay/shared-types):
 *   - `public`      — any caller may create users.
 *   - `secret_only` — only a server-side SECRET key may; a publishable
 *                     (`rp_pub_*`) request is refused. Sign-IN is unaffected —
 *                     this gates creation only.
 *   - `invite_only` — nobody may self-sign-up; operators invite instead.
 *
 * `authKind` comes from the api-key-auth middleware (`request.authKind`).
 * It is `undefined` only on code paths with no key context — treat that as
 * "not a publishable browser caller" (i.e. server-side), so it never trips
 * the `secret_only` guard. Every public sign-up entry point runs through
 * `requirePublishableOrSecretKey`, which always sets it, so in practice it is
 * defined at all real call sites.
 */

import type { AuthConfig } from '@relipay/shared-types';
import { RelipayError } from './error.js';

export type AuthKind = 'secret' | 'publishable';

/**
 * Predicate form — `true` when this caller may create an end-user. Use when
 * the caller needs to branch silently (e.g. enumeration-safe magic-link
 * request) rather than surface a specific error.
 */
export function signupAllowed(
  config: Pick<AuthConfig, 'signupMode'>,
  authKind: AuthKind | undefined,
): boolean {
  if (config.signupMode === 'invite_only') return false;
  if (config.signupMode === 'secret_only' && authKind === 'publishable') return false;
  return true;
}

/**
 * Throwing form — call immediately before any end-user create. Throws the
 * precise error for the failing mode so the SDK/caller can react:
 *   - `invite_only`              → 403 `SIGNUP_DISABLED`
 *   - `secret_only` + publishable → 403 `SIGNUP_REQUIRES_SECRET_KEY`
 */
export function assertSignupAllowed(
  config: Pick<AuthConfig, 'signupMode'>,
  authKind: AuthKind | undefined,
): void {
  if (config.signupMode === 'invite_only') {
    throw new RelipayError({
      statusCode: 403,
      code: 'SIGNUP_DISABLED',
      message: 'Public sign-up is disabled for this application.',
      fix: 'Operators must invite end-users via the panel (Auth → Invite end-user) instead.',
    });
  }
  if (config.signupMode === 'secret_only' && authKind === 'publishable') {
    throw new RelipayError({
      statusCode: 403,
      code: 'SIGNUP_REQUIRES_SECRET_KEY',
      message:
        'This application only allows creating end-users with a server-side secret key. ' +
        'The publishable key can sign existing users in, but cannot create them.',
      fix: 'Call sign-up from your server with a secret key (rp_live_… / rp_test_…). Keep the publishable key for browser sign-in only.',
    });
  }
}
