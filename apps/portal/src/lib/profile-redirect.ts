/**
 * Where a customer goes while the application's required profile questions
 * are unanswered. The API gates nothing on them; only completing onboarding is
 * refused (PROFILE_INCOMPLETE), and the portal sends that refusal here too.
 */

import { redirect } from 'next/navigation';
import { signInReturnPage } from './sign-in-return';

const PROFILE_INCOMPLETE = 'PROFILE_INCOMPLETE';

/**
 * @example
 * profileCompletePath('acme', 'devices'); // '/acme/profile/complete?return=devices'
 */
export function profileCompletePath(slug: string, page: unknown = null): string {
  const keyword = signInReturnPage(page);
  return `/${slug}/profile/complete${keyword ? `?return=${encodeURIComponent(keyword)}` : ''}`;
}

/**
 * Redirect to the profile questions when the API refused this call for
 * unanswered required fields; otherwise return and leave the response unread.
 */
export async function redirectWhenProfileIncomplete(slug: string, res: Response): Promise<void> {
  if (res.status !== 409) return;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: { code?: unknown } } | null;
  if (body?.error?.code === PROFILE_INCOMPLETE) redirect(profileCompletePath(slug));
}
