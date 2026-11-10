'use server';

import { redirect } from 'next/navigation';
import { rememberSignInReturn } from './session';
import {
  beginSocialSignIn,
  publishableKeyPost,
  socialSignInProviders,
  socialSignInReturnUrl,
} from './social-sign-in';
import { socialSignInFailurePath } from './social-sign-in-failure';

/** Send the browser to `provider` to sign in, returning to this portal's landing page. */
export async function startSocialSignInAction(slug: string, provider: string, formData: FormData): Promise<void> {
  if (!(await socialSignInProviders(slug)).some((p) => p.id === provider)) {
    redirect(socialSignInFailurePath(slug, 'OAUTH_PROVIDER_UNKNOWN', provider));
  }
  await rememberSignInReturn(slug, formData.get('return'));
  const state = await beginSocialSignIn(slug, provider);
  const started = await publishableKeyPost<{ authorizationUrl: string }>(
    slug,
    `/api/v1/auth/oauth/${encodeURIComponent(provider)}/start`,
    { state, redirectUri: await socialSignInReturnUrl(slug) },
  );
  if (!started.ok) redirect(socialSignInFailurePath(slug, started.code, provider, started.retryAfterSeconds));
  redirect(started.data.authorizationUrl);
}
