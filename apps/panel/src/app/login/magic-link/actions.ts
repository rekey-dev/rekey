'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { publicPost, setSessionCookies, PanelApiError, type SignInResponse } from '@/lib/api';
import { clearMfaChallenge, mfaVerifyPath, writeMfaChallenge } from '@/lib/mfa-challenge';
import { loginErrorCode } from '../error-messages';

/**
 * Spend the magic-link token and sign this browser in. Only a POST from the
 * panel's own page reaches it, which Next's Server Action origin check
 * enforces, so a link sent by someone else cannot sign the victim into the
 * sender's account, and a mail scanner fetching the link spends nothing.
 *
 * @example
 * <AuthCard action={continueMagicLinkSignIn}>…</AuthCard>
 */
export async function continueMagicLinkSignIn(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  if (!token) redirect('/login?error=magic_link_missing');

  let result: SignInResponse;
  try {
    result = await publicPost<SignInResponse>('/api/v1/tenant/auth/magic-link/verify', { token });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`/login?error=${loginErrorCode(err.code)}`);
    throw err;
  }

  const jar = await cookies();
  if (result.mfaRequired) {
    await writeMfaChallenge(jar, result.mfaChallengeToken);
    redirect(mfaVerifyPath({}));
  }
  clearMfaChallenge(jar);
  await setSessionCookies(result);
  redirect('/applications');
}
