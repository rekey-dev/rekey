'use server';

/**
 * Portal server actions. Each is bound to a `slug` by the page. They drive the
 * Application's PUBLISHABLE key (resolved per-slug) plus the end-user's own
 * token — never a secret key.
 */

import { redirect } from 'next/navigation';
import { RekeyError } from '@rekey.dev/react';
import { portalClientFor, setSession, clearSession, getRefreshToken, getAccessToken } from './session';
import { getPortalConfig } from './config';
import { portalBaseUrl, rekeyApiUrl } from './env';

export async function signInAction(slug: string, formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const client = await portalClientFor(slug);
  if (!client) redirect(`/${slug}`); // portal not live → bounce to the 404 path
  try {
    const out = await client.signIn({ email, password });
    if (out.mfaRequired) {
      // MFA-enrolled user: hand the single-use, short-lived challenge token to
      // the code step (same pattern the operator panel uses).
      redirect(`/${slug}/login?mfa=${encodeURIComponent(out.mfaChallengeToken)}`);
    }
    await setSession(slug, out.accessToken, out.refreshToken);
  } catch (err) {
    if (err instanceof RekeyError) {
      // Carry the email back so a mistyped password doesn't cost the customer
      // both fields. Never the password.
      redirect(
        `/${slug}/login?error=${encodeURIComponent(err.code)}&email=${encodeURIComponent(email)}`,
      );
    }
    throw err;
  }
  redirect(`/${slug}`);
}

export async function mfaVerifyAction(slug: string, formData: FormData): Promise<void> {
  const challenge = String(formData.get('challenge') ?? '').trim();
  const code = String(formData.get('code') ?? '').trim();
  const client = await portalClientFor(slug);
  if (!client) redirect(`/${slug}`);
  if (!challenge || !code) redirect(`/${slug}/login`);
  try {
    const out = await client.mfaVerify({ mfaChallengeToken: challenge, code });
    await setSession(slug, out.accessToken, out.refreshToken);
  } catch (err) {
    if (err instanceof RekeyError) {
      // Keep the challenge so a mistyped code doesn't force a fresh sign-in.
      redirect(
        `/${slug}/login?mfa=${encodeURIComponent(challenge)}&error=${encodeURIComponent(err.code)}`,
      );
    }
    throw err;
  }
  redirect(`/${slug}`);
}

/**
 * The browser SDK has no password-reset methods yet, but the API's
 * /forgot-password + /reset-password routes accept the publishable key —
 * call them directly with the same Bearer credential the SDK uses.
 */
async function publishablePost(
  slug: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; code?: string }> {
  const config = await getPortalConfig(slug);
  if (!config) return { ok: false, code: 'PORTAL_NOT_FOUND' };
  const res = await fetch(`${rekeyApiUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.publishableKey}`,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (res.ok) return { ok: true };
  const json = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  return { ok: false, code: json?.error?.code ?? `HTTP_${res.status}` };
}

export async function forgotPasswordAction(slug: string, formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) redirect(`/${slug}/forgot-password?error=missing`);
  // Enumeration-safe on the API side — always confirm the same way. resetUrl
  // points the emailed link back at this portal's reset page.
  await publishablePost(slug, '/api/v1/auth/forgot-password', {
    email,
    resetUrl: `${portalBaseUrl()}/${slug}/reset-password`,
  });
  redirect(`/${slug}/forgot-password?sent=1`);
}

export async function resetPasswordAction(slug: string, formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '').trim();
  const newPassword = String(formData.get('newPassword') ?? '');
  if (!token || !newPassword) redirect(`/${slug}/login`);
  const result = await publishablePost(slug, '/api/v1/auth/reset-password', {
    token,
    newPassword,
  });
  if (!result.ok) {
    redirect(
      `/${slug}/reset-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent(result.code ?? 'UNKNOWN')}`,
    );
  }
  redirect(`/${slug}/login?reason=reset`);
}

export async function signOutAction(slug: string): Promise<void> {
  const client = await portalClientFor(slug);
  const refresh = await getRefreshToken();
  if (client && refresh) {
    await client.signOut(refresh).catch(() => undefined);
  }
  await clearSession(slug);
  redirect(`/${slug}/login`);
}

export async function cancelSubscriptionAction(slug: string, organizationId: string | null): Promise<void> {
  const client = await portalClientFor(slug);
  const access = await getAccessToken();
  if (!client || !access) redirect(`/${slug}/login?reason=expired`);
  try {
    await client.cancelSubscription(access, {
      atPeriodEnd: true,
      ...(organizationId && { organizationId }),
    });
  } catch (err) {
    if (err instanceof RekeyError) {
      redirect(`/${slug}?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`/${slug}?e=canceled`);
}

export async function checkoutAction(
  slug: string,
  organizationId: string | null,
  formData: FormData,
): Promise<void> {
  const planSlug = String(formData.get('planSlug') ?? '');
  // The picker (when shown) posts the user's chosen provider; absent, the
  // server-side geo router picks. Only forward known provider ids.
  const rawProvider = String(formData.get('provider') ?? '');
  const provider =
    rawProvider === 'stripe' || rawProvider === 'paypal' || rawProvider === 'razorpay'
      ? rawProvider
      : undefined;
  const client = await portalClientFor(slug);
  const access = await getAccessToken();
  const config = await getPortalConfig(slug);
  if (!client || !access || !config) redirect(`/${slug}/login?reason=expired`);
  let url: string;
  try {
    const result = await client.createCheckout(access, {
      planSlug,
      successUrl: `${portalBaseUrl()}/${slug}?checkout=success`,
      cancelUrl: `${portalBaseUrl()}/${slug}?checkout=canceled`,
      ...(provider && { provider }),
      ...(organizationId && { organizationId }),
    });
    url = result.url;
  } catch (err) {
    if (err instanceof RekeyError) {
      redirect(`/${slug}?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(url);
}
