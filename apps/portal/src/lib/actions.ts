'use server';

/**
 * Portal server actions. Each is bound to a `slug` by the page. They drive the
 * Application's PUBLISHABLE key (resolved per-slug) plus the end-user's own
 * token — never a secret key.
 */

import { redirect } from 'next/navigation';
import { RelipayError } from '@relipay/react';
import { portalClientFor, setSession, clearSession, getRefreshToken, getAccessToken } from './session';
import { getPortalConfig } from './config';
import { portalBaseUrl } from './env';

export async function signInAction(slug: string, formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const client = await portalClientFor(slug);
  if (!client) redirect(`/${slug}`); // portal not live → bounce to the 404 path
  try {
    const out = await client.signIn({ email, password });
    if (out.mfaRequired) {
      // Portal v2.1 punts on MFA (same as v1) — surface a clear message.
      redirect(`/${slug}/login?error=MFA_REQUIRED`);
    }
    await setSession(slug, out.accessToken, out.refreshToken);
  } catch (err) {
    if (err instanceof RelipayError) {
      redirect(`/${slug}/login?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`/${slug}`);
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
    if (err instanceof RelipayError) {
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
    if (err instanceof RelipayError) {
      redirect(`/${slug}?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(url);
}
