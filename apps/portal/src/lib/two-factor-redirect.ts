/**
 * Where a customer goes when the application requires two-factor and they
 * have not set it up. The API refuses such a session with
 * MFA_ENROLLMENT_REQUIRED on everything but enrolment, so every call the
 * portal makes with the customer's token passes its response through here.
 */

import { redirect } from 'next/navigation';

const MFA_ENROLLMENT_REQUIRED = 'MFA_ENROLLMENT_REQUIRED';

export function twoFactorSetUpPath(slug: string): string {
  return `/${slug}/two-factor/set-up`;
}

/**
 * Redirect to the set-up page when the API refused this call for missing
 * enrolment; otherwise return and leave the response unread.
 *
 * @example
 * await redirectWhenTwoFactorRequired('acme', res); // throws NEXT_REDIRECT to /acme/two-factor/set-up
 */
export async function redirectWhenTwoFactorRequired(slug: string, res: Response): Promise<void> {
  if (res.status !== 403) return;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: { code?: unknown } } | null;
  if (body?.error?.code === MFA_ENROLLMENT_REQUIRED) redirect(twoFactorSetUpPath(slug));
}
