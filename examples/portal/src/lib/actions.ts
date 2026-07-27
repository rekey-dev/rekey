'use server';

/**
 * Server Actions — every mutating Rekey call lives behind the
 * `'use server'` boundary so the Application secret key never reaches the
 * browser. Follows the examples/nextjs-saas convention: read FormData, do
 * the work, redirect with `?status=` / `?error=` for the page to render.
 * RekeyError codes are surfaced verbatim.
 */

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
// Importing ./env (via the named import) bridges RELIPAY_SECRET_KEY →
// RELIPAY_SECRET before the @rekey.dev/nextjs/server helpers build their client.
import { portalBaseUrl } from './env';
import { signIn as nextSignIn, signOut as nextSignOut } from '@rekey.dev/nextjs/server';
import { rekey, RekeyError } from './relipay';
import { requireSession } from './session';
import { cancelMySubscription } from './portal';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function signInAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const next = sanitizeNext(String(formData.get('next') ?? ''));
  if (!email || !password) redirect('/login?error=missing');
  try {
    const outcome = await nextSignIn({ email, password });
    if (outcome.kind === 'mfa_required') {
      // Portal v1 doesn't implement the TOTP second factor — MFA-enrolled
      // users sign in via the operator's own app or a magic link.
      redirect('/login?error=MFA_REQUIRED');
    }
  } catch (err) {
    if (err instanceof RekeyError) redirect(`/login?error=${encodeURIComponent(err.code)}`);
    throw err;
  }
  redirect(next ?? '/subscription');
}

export async function signOutAction(): Promise<void> {
  await nextSignOut('/login');
}

/**
 * Request a magic-link sign-in email. Enumeration-safe — the page always
 * shows "check your email". When the Application has no email transport
 * configured the API returns the raw token; the portal deliberately does
 * NOT surface it (anyone could type any email here) — configure transport
 * instead (docs/portal.md).
 */
export async function requestMagicLinkAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) redirect('/login?error=missing');
  try {
    await rekey.auth.requestMagicLink({
      email,
      // {token} is substituted by Rekey when it builds the email link.
      signInUrl: `${portalBaseUrl()}/api/auth/magic-link/verify?token={token}`,
    });
  } catch (err) {
    if (err instanceof RekeyError) redirect(`/login?error=${encodeURIComponent(err.code)}`);
    throw err;
  }
  redirect('/login?sent=1');
}

export async function changePasswordAction(formData: FormData): Promise<void> {
  const currentPassword = String(formData.get('currentPassword') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  if (!currentPassword || !newPassword) redirect('/account?error=missing');
  const session = await requireSession();
  try {
    await rekey.auth.changePassword(session.accessToken, { currentPassword, newPassword });
  } catch (err) {
    if (err instanceof RekeyError) redirect(`/account?error=${encodeURIComponent(err.code)}`);
    throw err;
  }
  // changePassword revokes every refresh token — the cookie session is dead.
  // Clear it and have the user sign in with the new password.
  await nextSignOut('/login?changed=1');
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

/** Start a hosted checkout for a plan (new subscription or plan change). */
export async function checkoutAction(formData: FormData): Promise<void> {
  const planSlug = String(formData.get('planSlug') ?? '');
  if (!planSlug) redirect('/plans?error=missing-plan');
  const session = await requireSession();
  try {
    const result = await rekey.billing.createCheckout(session.accessToken, {
      planSlug,
      successUrl: `${portalBaseUrl()}/subscription?checkout=success`,
      cancelUrl: `${portalBaseUrl()}/plans?checkout=canceled`,
    });
    if (result.url) redirect(result.url);
  } catch (err) {
    if (err instanceof RekeyError) redirect(`/plans?error=${encodeURIComponent(err.code)}`);
    throw err;
  }
  redirect('/plans?error=NO_CHECKOUT_URL');
}

/** Cancel the current subscription at period end (provider-backed) or now. */
export async function cancelSubscriptionAction(): Promise<void> {
  const session = await requireSession();
  try {
    await cancelMySubscription(session.accessToken);
  } catch (err) {
    if (err instanceof RekeyError) {
      redirect(`/subscription?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  revalidatePath('/subscription');
  redirect('/subscription?canceled=1');
}

/** Only allow same-site relative paths for post-login redirects. */
function sanitizeNext(next: string): string | null {
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  return next;
}
