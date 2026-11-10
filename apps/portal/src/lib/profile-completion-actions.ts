'use server';

import { redirect } from 'next/navigation';
import { getAccessToken } from './session';
import { getPortalConfig } from './config';
import { customerCall } from './customer-call';
import { isSessionRefusal } from './devices';
import { profileQuestions } from './profile-completion';
import { readProfileForm } from './profile-form';
import { profileSaveErrorCopy } from './profile-completion-copy';
import { afterSignInPath, signInReturnPage } from './sign-in-return';

export type ProfileFormState = {
  errors: Record<string, string>;
  formError: string | null;
  values: Record<string, string>;
};

/**
 * Save the customer's answers, then record onboarding as complete. Returns
 * to the form with every refusal; on success goes on to the page sign-in was
 * headed for.
 */
export async function saveProfileAction(
  slug: string,
  returnPage: string | null,
  _previous: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const [config, accessToken] = await Promise.all([getPortalConfig(slug), getAccessToken()]);
  if (!config || !accessToken) redirect(`/${slug}/login?reason=expired`);
  const fields = await profileQuestions(config.publishableKey);
  if (!fields) return { errors: {}, formError: profileSaveErrorCopy('SERVICE_UNAVAILABLE'), values: {} };

  const answers = readProfileForm(fields, {}, formData, { requireOnboarding: true });
  if (Object.keys(answers.errors).length > 0) {
    return { errors: answers.errors, formError: null, values: answers.draft };
  }
  const saved = await customerCall(config, accessToken, 'PATCH', '/api/v1/users/me/profile', answers.patch);
  if (!saved.ok) {
    if (isSessionRefusal(saved.code)) redirect(`/${slug}/login?reason=expired`);
    return { errors: {}, formError: profileSaveErrorCopy(saved.code, saved.retryAfterSeconds), values: answers.draft };
  }
  // Recorded for the operator only. A PROFILE_INCOMPLETE answer is redirected back to the questions inside the call.
  await customerCall(config, accessToken, 'POST', '/api/v1/users/me/onboarding/complete', {});
  redirect(afterSignInPath(slug, signInReturnPage(returnPage)));
}
