/**
 * Required profile questions for a signed-in customer. Each page asks the API
 * for the questions and reads the answers from the session's own user, so a
 * question the operator adds later is asked on the next page load.
 */

import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { ProfileField } from '@rekey.dev/shared-types';
import { getPortalConfig } from './config';
import { rekeyApiUrl } from './env';
import { API_TIMEOUT_MS, publishableKeyCallHeaders } from './client-ip';
import { outstandingProfileFields } from './profile-form';
import { profileCompletePath } from './profile-redirect';

/**
 * The questions a customer may answer, or null when the API could not say.
 * Cached per request: the guard and the page both ask.
 */
export const profileQuestions = cache(async (publishableKey: string): Promise<ProfileField[] | null> => {
  try {
    const res = await fetch(`${rekeyApiUrl()}/api/v1/profile-schema`, {
      headers: { ...(await publishableKeyCallHeaders()), Authorization: `Bearer ${publishableKey}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { data?: { fields?: ProfileField[] } } | null;
    return json?.data?.fields ?? null;
  } catch {
    return null;
  }
});

/**
 * Send the customer to the questions while a required one is unanswered.
 * Questions the API cannot list read as answered: an outage should not lock a
 * customer out of their billing.
 */
export async function redirectWhileProfileOutstanding(
  slug: string,
  user: { profile?: Record<string, unknown> | undefined },
  /** The sign-in return keyword for the page asking, to come back to it. */
  page: unknown,
): Promise<void> {
  const config = await getPortalConfig(slug);
  if (!config) return;
  const fields = await profileQuestions(config.publishableKey);
  if (fields && outstandingProfileFields(fields, user.profile).length > 0) redirect(profileCompletePath(slug, page));
}
