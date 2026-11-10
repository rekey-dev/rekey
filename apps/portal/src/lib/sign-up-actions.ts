'use server';

import { redirect } from 'next/navigation';
import { RekeyError } from '@rekey.dev/react';
import { portalClientFor, rememberSignInEmail, rememberSignInReturn } from './session';
import { portalPublicBase } from './public-base';
import { retryQuery } from './auth-error-copy';
import { isSignUpSent } from './sign-up-copy';
import { completeSignIn } from './complete-sign-in';
import { SIGN_UP_HONEYPOT } from '@/components/sign-up-honeypot';

/**
 * Create an account with an email address and a password. Every refusal comes
 * back to the form with the address kept in a short cookie, never the password.
 */
export async function signUpAction(slug: string, formData: FormData): Promise<void> {
  const page = `/${slug}/sign-up`;
  await rememberSignInReturn(slug, formData.get('return'));
  // A bot gets the same answer a person who must confirm their address gets, and the API never hears of it.
  if (String(formData.get(SIGN_UP_HONEYPOT) ?? '') !== '') redirect(`${page}?sent=1`);
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const client = await portalClientFor(slug);
  if (!client) redirect(`/${slug}`);
  await rememberSignInEmail(slug, email);
  if (!email || !password) redirect(`${page}?error=missing`);
  try {
    await completeSignIn(
      slug,
      await client.signUp({ email, password, verifyUrl: `${await portalPublicBase(slug)}/verify-email?token={token}` }),
    );
  } catch (err) {
    if (err instanceof RekeyError) {
      if (isSignUpSent(err.code)) redirect(`${page}?sent=1`);
      redirect(`${page}?error=${encodeURIComponent(err.code)}${retryQuery(err.retryAfterSeconds)}`);
    }
    throw err;
  }
}
