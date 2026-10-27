'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { publicPost, setSessionCookies, PanelApiError, type SignInResponse } from '@/lib/api';
import { clearMfaChallenge, mfaVerifyPath, writeMfaChallenge } from '@/lib/mfa-challenge';
import { loginErrorCode } from '../../error-messages';
import { CLOUD_HANDOFF_COOKIE, clearCloudHandoff } from '../handoff-cookie';

/**
 * Spend a held Cloud handoff once the operator has confirmed the switch.
 *
 * @example
 * <AuthCard action={confirmCloudHandoff}>…</AuthCard>
 */
export async function confirmCloudHandoff(): Promise<void> {
  const jar = await cookies();
  const idToken = jar.get(CLOUD_HANDOFF_COOKIE)?.value ?? '';
  clearCloudHandoff(jar);
  if (!idToken) redirect('/login?error=cloud_handoff');

  let result: SignInResponse;
  try {
    result = await publicPost<SignInResponse>('/api/v1/tenant/auth/oidc/assert', { idToken });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`/login?error=${loginErrorCode(err.code)}`);
    throw err;
  }

  if (result.mfaRequired) {
    await writeMfaChallenge(jar, result.mfaChallengeToken);
    redirect(mfaVerifyPath({}));
  }
  clearMfaChallenge(jar);
  await setSessionCookies(result);
  redirect('/applications?e=login_cloud');
}

/**
 * Drop the held handoff and stay in the current session.
 *
 * @example
 * <ActionForm action={cancelCloudHandoff}>…</ActionForm>
 */
export async function cancelCloudHandoff(): Promise<void> {
  clearCloudHandoff(await cookies());
  redirect('/applications');
}
