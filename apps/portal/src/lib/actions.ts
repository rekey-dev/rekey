'use server';

/**
 * Portal server actions. Each is bound to a `slug` by the page. They drive the
 * Application's PUBLISHABLE key (resolved per-slug) plus the end-user's own
 * token, never a secret key.
 */

import { redirect } from 'next/navigation';
import { RekeyError } from '@rekey.dev/react';
import { CANCEL_REASONS } from '@rekey.dev/shared-types';
import {
  portalClientFor,
  setSession,
  clearSession,
  getRefreshToken,
  getAccessToken,
  getMfaChallenge,
  clearMfaChallenge,
  getSignInLink,
  clearSignInLink,
  getVerifyEmailLink,
  clearVerifyEmailLink,
  rememberSignInReturn,
  rememberSignInEmail,
  getResetPasswordLink,
  clearResetPasswordLink,
} from './session';
import { getPortalConfig } from './config';
import {
  PRESELECTED_PROVIDER_FIELD,
  checkoutRefusalCode,
  chosenProvider,
  resolveCheckoutProvider,
} from './provider-capabilities';
import { rekeyApiUrl } from './env';
import { portalPublicBase } from './public-base';
import { API_TIMEOUT_MS, publishableKeyCallHeaders } from './client-ip';
import {
  isMfaRestartCode,
  retryQuery,
  signInLinkRequestFailureShown,
  verificationResendFailureShown,
} from './auth-error-copy';
import { planReviewPath } from './billing-subject';
import { customerCall } from './customer-call';
import { completeSignIn, takeSignInDestination } from './complete-sign-in';
import { devicesSignInPath, devicesPath, isSessionRefusal } from './devices';
import { couponCodeOf, isCouponRefusal } from './coupon-quote';

export async function signInAction(slug: string, formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  await rememberSignInReturn(slug, formData.get('return'));
  const client = await portalClientFor(slug);
  if (!client) redirect(`/${slug}`); // portal not live → bounce to the 404 path
  try {
    await completeSignIn(slug, await client.signIn({ email, password }));
  } catch (err) {
    if (err instanceof RekeyError) {
      // Keep the email so a mistyped password doesn't cost the customer both
      // fields. In a cookie, not the URL; never the password.
      await rememberSignInEmail(slug, email);
      redirect(`/${slug}/login?error=${encodeURIComponent(err.code)}${retryQuery(err.retryAfterSeconds)}`);
    }
    throw err;
  }
}

export async function requestSignInLinkAction(slug: string, formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  await rememberSignInReturn(slug, formData.get('return'));
  if (!email) redirect(`/${slug}/login?link_error=missing`);
  const result = await publishablePost(slug, '/api/v1/auth/magic-link/request', {
    email,
    signInUrl: `${await portalPublicBase(slug)}/sign-in-link?token={token}`,
  });
  // Any other refusal reads as a send, so the page never says whether the
  // address has an account.
  if (!result.ok && signInLinkRequestFailureShown(result.code ?? 'UNKNOWN')) {
    redirect(
      `/${slug}/login?link_error=${encodeURIComponent(result.code ?? 'UNKNOWN')}${retryQuery(result.retryAfterSeconds)}`,
    );
  }
  redirect(`/${slug}/login?link=sent`);
}

export async function signInWithLinkAction(slug: string): Promise<void> {
  const token = await getSignInLink();
  if (!token) redirect(`/${slug}/login?step=link`);
  const client = await portalClientFor(slug);
  if (!client) redirect(`/${slug}`);
  // Single-use: whatever the API answers, this cookie is done. An unspent
  // token is still in the email, and opening the link again restores it.
  await clearSignInLink(slug);
  try {
    await completeSignIn(slug, await client.verifyMagicLink({ token }));
  } catch (err) {
    if (err instanceof RekeyError) {
      redirect(`/${slug}/login?error=${encodeURIComponent(err.code)}${retryQuery(err.retryAfterSeconds)}`);
    }
    throw err;
  }
}

const RESEND_RETURN_PATHS = { login: 'login', link: 'verify-email/confirm', 'sign-up': 'sign-up' } as const;

/** Ends on the same neutral state whatever the address, unless every address would fail alike. */
export async function resendVerificationAction(
  slug: string,
  from: keyof typeof RESEND_RETURN_PATHS,
  formData: FormData,
): Promise<void> {
  const back = `/${slug}/${RESEND_RETURN_PATHS[from]}`;
  const email = String(formData.get('email') ?? '').trim();
  if (!email) redirect(`${back}?resend_error=missing`);
  const result = await publishablePost(slug, '/api/v1/auth/resend-verification', {
    email,
    verifyUrl: `${await portalPublicBase(slug)}/verify-email?token={token}`,
  });
  if (!result.ok && verificationResendFailureShown(result.code ?? 'UNKNOWN')) {
    redirect(
      `${back}?resend_error=${encodeURIComponent(result.code ?? 'UNKNOWN')}${retryQuery(result.retryAfterSeconds)}`,
    );
  }
  redirect(`${back}?resend=sent`);
}

export async function confirmEmailAction(slug: string): Promise<void> {
  const page = `/${slug}/verify-email/confirm`;
  const token = await getVerifyEmailLink();
  if (!token) redirect(page);
  await clearVerifyEmailLink(slug);
  const result = await publishablePost(slug, '/api/v1/auth/verify-email', { token });
  if (!result.ok) {
    redirect(`${page}?error=${encodeURIComponent(result.code ?? 'UNKNOWN')}${retryQuery(result.retryAfterSeconds)}`);
  }
  redirect(`${page}?done=1`);
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
  redirect(await takeSignInDestination(slug));
}

/**
 * The browser SDK has no password-reset or email-confirmation methods yet, but
 * those API routes accept the publishable key, so they are called directly with
 * the same Bearer credential the SDK uses.
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
        ...(await publishableKeyCallHeaders()),
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
    resetUrl: `${await portalPublicBase(slug)}/reset-password-link?token={token}`,
  });
  if (!result.ok) {
    redirect(
      `/${slug}/forgot-password?error=${encodeURIComponent(result.code ?? 'UNKNOWN')}${retryQuery(result.retryAfterSeconds)}`,
    );
  }
  redirect(`/${slug}/forgot-password?sent=1`);
}

/** The token comes from the cookie the emailed link's landing route set, never from the form or the URL. */
export async function resetPasswordAction(slug: string, formData: FormData): Promise<void> {
  const token = await getResetPasswordLink();
  const newPassword = String(formData.get('newPassword') ?? '');
  if (!token) redirect(`/${slug}/reset-password`);
  if (!newPassword) redirect(`/${slug}/login`);
  const result = await publishablePost(slug, '/api/v1/auth/reset-password', {
    token,
    newPassword,
  });
  if (!result.ok) {
    redirect(
      `/${slug}/reset-password?error=${encodeURIComponent(result.code ?? 'UNKNOWN')}${retryQuery(result.retryAfterSeconds)}`,
    );
  }
  await clearResetPasswordLink(slug);
  redirect(`/${slug}/login?reason=reset`);
}

async function endSession(slug: string): Promise<void> {
  const client = await portalClientFor(slug);
  const refresh = await getRefreshToken();
  if (client && refresh) {
    await client.signOut(refresh).catch(() => undefined);
  }
  await clearSession(slug);
  await clearMfaChallenge(slug);
}

export async function signOutAction(slug: string): Promise<void> {
  await endSession(slug);
  redirect(`/${slug}/login`);
}

/** Sign out, then sign in again landing back on `page`, as "Not you?" on the invitation page does. */
export async function signOutAndReturnAction(slug: string, page: 'invitation'): Promise<void> {
  await endSession(slug);
  redirect(`/${slug}/login?return=${page}`);
}

export async function cancelSubscriptionAction(
  slug: string,
  organizationId: string | null,
  subscriptionId: string,
  formData: FormData,
): Promise<void> {
  const client = await portalClientFor(slug);
  const access = await getAccessToken();
  if (!client || !access) redirect(`/${slug}/login?reason=expired`);
  const reason = CANCEL_REASONS.find((r) => r === formData.get('reason'));
  try {
    await client.cancelSubscription(access, {
      atPeriodEnd: true,
      subscriptionId,
      ...(reason && { reason }),
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
      successUrl: `${await portalPublicBase(slug)}?checkout=success`,
      cancelUrl: `${await portalPublicBase(slug)}?checkout=canceled`,
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

export async function removeDeviceAction(slug: string, deviceId: string): Promise<void> {
  const [config, access] = await Promise.all([getPortalConfig(slug), getAccessToken()]);
  if (!config || !access) redirect(devicesSignInPath(slug));
  const result = await customerCall(config, access, 'DELETE', `/api/v1/users/me/devices/${encodeURIComponent(deviceId)}`);
  if (!result.ok) {
    if (isSessionRefusal(result.code)) redirect(devicesSignInPath(slug));
    redirect(`${devicesPath(slug)}?error=${encodeURIComponent(result.code)}`);
  }
  redirect(`${devicesPath(slug)}?removed=${encodeURIComponent(deviceId)}`);
}
