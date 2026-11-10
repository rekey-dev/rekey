/**
 * Paths of the authorization pages, and the request id they carry. Pure and
 * runtime-neutral: pages, actions and the landing route all read it.
 */

import { signInReturnPage } from './sign-in-return';

/**
 * The request id when it has the exact shape the API issues, else null.
 *
 * @example
 * authorizeRequestId('a'.repeat(43)); // 'aaa…'
 * authorizeRequestId('../x'); // null
 */
export function authorizeRequestId(raw: unknown): string | null {
  return typeof raw === 'string' && signInReturnPage(`authorize:${raw}`) ? raw : null;
}

/** @example authorizeConsentPath('acme', id); // '/acme/authorize/consent?request=<id>' */
export function authorizeConsentPath(slug: string, id: string | null): string {
  return id ? `/${slug}/authorize/consent?request=${id}` : `/${slug}/authorize/consent`;
}

export function authorizeDonePath(slug: string): string {
  return `/${slug}/authorize/done`;
}

/** @example authorizeSignInPath('acme', id); // '/acme/login?return=authorize%3A<id>' */
export function authorizeSignInPath(slug: string, id: string): string {
  return `/${slug}/login?return=${encodeURIComponent(`authorize:${id}`)}`;
}
