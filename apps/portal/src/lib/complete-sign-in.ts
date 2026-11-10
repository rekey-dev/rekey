/**
 * Where every way in ends: password, sign-in link, sign-up and social sign-in.
 * Not a Server Action module, so none of this is callable from a browser.
 */

import 'server-only';
import { redirect } from 'next/navigation';
import type { RekeyBrowserClient } from '@rekey.dev/react';
import {
  clearSignInEmail,
  clearSignInReturn,
  getSignInReturn,
  setMfaChallenge,
  setSession,
} from './session';
import { twoFactorSetUpPath } from './two-factor-redirect';
import { afterSignInPath } from './sign-in-return';

/** A session, the MFA step, or required two-factor setup. */
export async function completeSignIn(
  slug: string,
  out: Awaited<ReturnType<RekeyBrowserClient['signIn']>>,
): Promise<never> {
  await clearSignInEmail(slug);
  if (out.mfaRequired) {
    await setMfaChallenge(slug, out.mfaChallengeToken);
    redirect(`/${slug}/login?step=mfa`);
  }
  await setSession(slug, out.accessToken, out.refreshToken, out);
  // Required setup reads the remembered page itself, for its own continue link.
  if (out.mfaEnrollmentRequired) redirect(twoFactorSetUpPath(slug));
  redirect(await takeSignInDestination(slug));
}

export async function takeSignInDestination(slug: string): Promise<string> {
  const page = await getSignInReturn();
  if (page) await clearSignInReturn(slug);
  return afterSignInPath(slug, page);
}
