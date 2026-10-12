'use server';

/**
 * Portal server actions. Each is bound to a `slug` by the page. They drive the
 * Application's PUBLISHABLE key (resolved per-slug) plus the end-user's own
 * token, never a secret key.
 */

import { redirect } from 'next/navigation';
import { RekeyError } from '@rekey.dev/react';
import {
  portalClientFor,
  setSession,
  clearSession,
  getRefreshToken,
  getAccessToken,
  setMfaChallenge,
  getMfaChallenge,
  clearMfaChallenge,
} from './session';
import { getPortalConfig } from './config';
import {
  PRESELECTED_PROVIDER_FIELD,
  checkoutRefusalCode,
  chosenProvider,
  resolveCheckoutProvider,
} from './provider-capabilities';
import { portalBaseUrl, rekeyApiUrl } from './env';
import { API_TIMEOUT_MS, forwardedClientHeaders } from './client-ip';
import { isMfaRestartCode, retryQuery } from './auth-error-copy';
import { planReviewPath } from './billing-subject';
import { couponCodeOf, isCouponRefusal } from './coupon-quote';

export async function signInAction(slug: string, formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const client = await portalClientFor(slug);
  if (!client) redirect(`/${slug}`); // portal not live → bounce to the 404 path
  try {
    const out = await client.signIn({ email, password });
    if (out.mfaRequired) {
      await setMfaChallenge(slug, out.mfaChallengeToken);
      redirect(`/${slug}/login?step=mfa`);
    }
    await setSession(slug, out.accessToken, out.refreshToken, out);
  } catch (err) {
    if (err instanceof RekeyError) {
      // Carry the email back so a mistyped password doesn't cost the customer
      // both fields. Never the password.
      redirect(
        `/${slug}/login?error=${encodeURIComponent(err.code)}${retryQuery(err.retryAfterSeconds)}&email=${encodeURIComponent(email)}`,
      );
    }
    throw err;
  }
  redirect(`/${slug}`);
}

export async function mfaVerifyAction(slug: string, formData: FormData): Promise<void> {
  const code = String(formData.get('code') ?? '').trim();
  const client = await portalClientFor(slug);
  if (!client) redirect(`/${slug}`);
  const challenge = await getMfaChallenge();
  if (!challenge) redirect(`/${slug}/login?reason=mfa_expired`);
  if (!code) redirect(`/${slug}/login?step=mfa`);
  try {
    const out = await client.mfaVerify({ mfaChallengeToken: challenge, code });
    await clearMfaChallenge(slug);
    await setSession(slug, out.accessToken, out.refreshToken, out);
  } catch (err) {
    if (err instanceof RekeyError) {
      if (isMfaRestartCode(err.code)) {
        await clearMfaChallenge(slug);
        redirect(`/${slug}/login?error=${encodeURIComponent(err.code)}`);
      }
      // Keep the challenge so a mistyped code doesn't force a fresh sign-in.
      redirect(
        `/${slug}/login?step=mfa&error=${encodeURIComponent(err.code)}${retryQuery(err.retryAfterSeconds)}`,
      );
    }
    throw err;
  }
  redirect(`/${slug}`);
}

/**
 * The browser SDK has no password-reset methods yet, but the API's
 * /forgot-password + /reset-password routes accept the publishable key,
 * call them directly with the same Bearer credential the SDK uses.
 */
async function publishablePost(
  slug: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; code?: string; retryAfterSeconds?: number }> {
  const config = await getPortalConfig(slug);
  if (!config) return { ok: false, code: 'PORTAL_NOT_FOUND' };
  let res: Response;
  try {
    res = await fetch(`${rekeyApiUrl()}${path}`, {
      method: 'POST',
      headers: {
        ...(await forwardedClientHeaders()),
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.publishableKey}`,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'NETWORK_ERROR' };
  }
  if (res.ok) return { ok: true };
  const json = (await res.json().catch(() => null)) as
    | { error?: { code?: string; retryAfterSeconds?: number } }
    | null;
  const retryAfterSeconds = json?.error?.retryAfterSeconds;
  return {
    ok: false,
    code: json?.error?.code ?? `HTTP_${res.status}`,
    ...(typeof retryAfterSeconds === 'number' && { retryAfterSeconds }),
  };
}

export async function forgotPasswordAction(slug: string, formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) redirect(`/${slug}/forgot-password?error=missing`);
  // The API answers the same way whether or not the address has an account, so
  // a failure here says nothing about the address: it was throttled, or the
  // request never ran. Only a success may tell the customer a link is coming.
  const result = await publishablePost(slug, '/api/v1/auth/forgot-password', {
    email,
    resetUrl: `${portalBaseUrl()}/${slug}/reset-password?token={token}`,
  });
  if (!result.ok) {
    redirect(
      `/${slug}/forgot-password?error=${encodeURIComponent(result.code ?? 'UNKNOWN')}${retryQuery(result.retryAfterSeconds)}`,
    );
  }
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
      `/${slug}/reset-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent(result.code ?? 'UNKNOWN')}${retryQuery(result.retryAfterSeconds)}`,
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
  await clearMfaChallenge(slug);
  redirect(`/${slug}/login`);
}

export async function cancelSubscriptionAction(
  slug: string,
  organizationId: string | null,
  subscriptionId: string,
): Promise<void> {
  const client = await portalClientFor(slug);
  const access = await getAccessToken();
  if (!client || !access) redirect(`/${slug}/login?reason=expired`);
  try {
    await client.cancelSubscription(access, {
      atPeriodEnd: true,
      subscriptionId,
      ...(organizationId && { organizationId }),
    });
  } catch (err) {
    if (err instanceof RekeyError) {
      redirect(`/${slug}?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`/${slug}?e=canceled&sub=${encodeURIComponent(subscriptionId)}`);
}

export async function checkoutAction(
  slug: string,
  organizationId: string | null,
  formData: FormData,
): Promise<void> {
  const planSlug = String(formData.get('planSlug') ?? '');
  // Present only when the review page had the API price this code.
  const couponField = formData.get('couponCode');
  const couponCode = couponCodeOf(typeof couponField === 'string' ? couponField : null);
  // The picker (when shown) posts the checked provider. Left on the one it
  // preselected, that is no choice and the API routes the checkout.
  const rawProvider = chosenProvider(
    String(formData.get('provider') ?? '').trim(),
    String(formData.get(PRESELECTED_PROVIDER_FIELD) ?? '').trim(),
  );
  const client = await portalClientFor(slug);
  const access = await getAccessToken();
  const config = await getPortalConfig(slug);
  if (!client || !access || !config) redirect(`/${slug}/login?reason=expired`);
  // Judge the pick against what this Application offers for checkout, from the
  // same public list that rendered the picker, instead of a list of names. If
  // that list cannot be read, forward the pick: checkout validates it too and
  // answers with the same codes.
  let provider: string | undefined;
  if (rawProvider !== '') {
    const [offered, forPlan] = await Promise.all([
      client.listBillingProviders().then(
        (r) => r.providers,
        () => null,
      ),
      client.listBillingProviders({ planSlug }).then(
        (r) => r.providers,
        () => null,
      ),
    ]);
    if (offered === null) {
      provider = rawProvider;
    } else {
      const choice = resolveCheckoutProvider(rawProvider, offered);
      if (choice.kind === 'refused') redirect(`/${slug}?error=${encodeURIComponent(choice.code)}`);
      if (choice.kind === 'provider') provider = choice.provider;
    }
    // A pick that cannot charge this plan at any of its prices is left off, so
    // the API routes the checkout instead of refusing it. The page does not offer such
    // a pick; a page rendered before the operator changed a provider can.
    if (provider !== undefined && forPlan !== null && !forPlan.some((p) => p.provider === provider)) {
      provider = undefined;
    }
  }
  let url: string;
  try {
    const result = await client.createCheckout(access, {
      planSlug,
      successUrl: `${portalBaseUrl()}/${slug}?checkout=success`,
      cancelUrl: `${portalBaseUrl()}/${slug}?checkout=canceled`,
      ...(provider && { provider }),
      ...(organizationId && { organizationId }),
      ...(couponCode !== null && { couponCode }),
    });
    url = result.url;
  } catch (err) {
    if (err instanceof RekeyError) {
      // Checkout judges a code again, and it is the decision. A code it
      // refuses goes back to the plan's page, which says why and leaves the
      // buyer free to continue at full price. Nothing was opened or charged.
      if (couponCode !== null && isCouponRefusal(err.code)) {
        redirect(`${planReviewPath(slug, planSlug)}?coupon=${encodeURIComponent(couponCode)}&refused=1`);
      }
      redirect(`/${slug}?error=${encodeURIComponent(checkoutRefusalCode(err.code, rawProvider !== ''))}`);
    }
    throw err;
  }
  redirect(url);
}
