/**
 * Where sign-in lands when it was started from a page other than the
 * dashboard. The page is named by a keyword (`devices`, `invitation`,
 * `plan:<planSlug>` or `authorize:<requestId>`),
 * never a path taken from the URL, so `?return=` cannot send a customer
 * anywhere the portal did not list.
 *
 * Pure and runtime-neutral: the sign-in page and the actions both read it.
 */

import { planReviewPath } from './billing-subject';

export type SignInReturn = 'devices' | 'invitation' | `plan:${string}` | `authorize:${string}`;

/** The API's own plan slug rule (`SLUG_RE` in the plans service): nothing that could make a path. */
const PLAN_RETURN = /^plan:[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;
/** The API's authorization request id: 32 random bytes, base64url. */
const AUTHORIZE_RETURN = /^authorize:[A-Za-z0-9_-]{43}$/;

/**
 * @example
 * signInReturnPage('devices'); // 'devices'
 * signInReturnPage('plan:pro'); // 'plan:pro'
 * signInReturnPage('authorize:' + 'a'.repeat(43)); // 'authorize:aaa…'
 * signInReturnPage('plan:../x'); // null
 * signInReturnPage('//evil.com'); // null
 */
export function signInReturnPage(raw: unknown): SignInReturn | null {
  if (raw === 'devices' || raw === 'invitation') return raw;
  if (typeof raw === 'string' && PLAN_RETURN.test(raw)) return raw as `plan:${string}`;
  if (typeof raw === 'string' && AUTHORIZE_RETURN.test(raw)) return raw as `authorize:${string}`;
  return null;
}

/**
 * @example
 * afterSignInPath('acme', 'devices'); // '/acme/devices'
 * afterSignInPath('acme', 'plan:pro'); // '/acme/plans/pro'
 * afterSignInPath('acme', null); // '/acme'
 */
export function afterSignInPath(slug: string, page: SignInReturn | null): string {
  if (page === null) return `/${slug}`;
  if (page === 'devices') return `/${slug}/devices`;
  if (page === 'invitation') return `/${slug}/invitation`;
  if (page.startsWith('authorize:')) return `/${slug}/authorize/consent?request=${page.slice('authorize:'.length)}`;
  return planReviewPath(slug, page.slice('plan:'.length));
}

/**
 * The sign-in page for a signed-out visit to a plan's page, coming back to it.
 * A slug the API could not have issued signs in to the dashboard.
 *
 * @example
 * planSignInPath('acme', 'pro'); // '/acme/login?return=plan%3Apro'
 */
export function planSignInPath(slug: string, planSlug: string | null): string {
  const page = signInReturnPage(`plan:${planSlug ?? ''}`);
  return page ? `/${slug}/login?return=${encodeURIComponent(page)}` : `/${slug}/login`;
}
