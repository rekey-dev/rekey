/**
 * Copy for the portal's error boundaries, chosen by the page that failed.
 *
 * Only the account dashboard at `/<slug>` shows subscriptions and payments, so
 * only there does "nothing has been charged or changed" answer a worry the
 * customer actually has. On the sign-in and password pages it reads as though
 * money had been at stake.
 */

export interface BoundaryCopy {
  title: string;
  body: string;
}

const ACCOUNT_COPY: BoundaryCopy = {
  title: 'We couldn’t load your account just now',
  body:
    'This is a problem on our side. Your subscription and payment details are unaffected, and ' +
    'nothing has been charged or changed. Please try again in a moment.',
};

const PAGE_COPY: BoundaryCopy = {
  title: 'This page didn’t load',
  body:
    'Something went wrong on our side, not yours. Try again in a moment, and if it keeps ' +
    'happening, contact the business that runs this account.',
};

/**
 * True for the account dashboard, `/<slug>`, the one page that shows billing.
 *
 * @example
 * isAccountPage('/acme'); // true
 * isAccountPage('/acme/login'); // false
 */
export function isAccountPage(pathname: string | null): boolean {
  const segments = (pathname ?? '').split('/').filter(Boolean);
  return segments.length === 1;
}

/**
 * @example
 * boundaryCopy('/acme/login').title; // 'This page didn't load'
 */
export function boundaryCopy(pathname: string | null): BoundaryCopy {
  return isAccountPage(pathname) ? ACCOUNT_COPY : PAGE_COPY;
}
