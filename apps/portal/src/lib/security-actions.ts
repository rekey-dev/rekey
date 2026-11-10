'use server';

/**
 * Security changes a signed-in customer makes for themselves. Each ends in a
 * redirect whose query carries a result or an error code, never a password,
 * code or token.
 */

import { redirect } from 'next/navigation';
import { getPortalConfig } from './config';
import { customerCall } from './customer-call';
import { clearSession, getAccessToken } from './session';
import { isSessionRefusal } from './devices';
import { retryQuery } from './auth-error-copy';
import { SECURITY_DONE } from './security-copy';
import { securityPath } from './security';

async function signedIn(slug: string) {
  const [config, accessToken] = await Promise.all([getPortalConfig(slug), getAccessToken()]);
  if (!config || !accessToken) redirect(`/${slug}/login?reason=expired`);
  return { config, accessToken };
}

async function signedOut(slug: string): Promise<never> {
  await clearSession(slug);
  redirect(`/${slug}/login`);
}

async function refused(slug: string, code: string, retryAfterSeconds?: number): Promise<never> {
  if (isSessionRefusal(code)) return signedOut(slug);
  redirect(`${securityPath(slug)}?error=${encodeURIComponent(code)}${retryQuery(retryAfterSeconds)}`);
}

/**
 * The API revokes every session on a password change, this one included, so
 * the customer signs in again with the new password.
 */
export async function changePasswordAction(slug: string, formData: FormData): Promise<void> {
  const currentPassword = String(formData.get('currentPassword') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  if (!currentPassword || !newPassword) redirect(`${securityPath(slug)}?error=missing`);
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(config, accessToken, 'POST', '/api/v1/auth/change-password', {
    currentPassword,
    newPassword,
  });
  if (!result.ok) return refused(slug, result.code, result.retryAfterSeconds);
  await clearSession(slug);
  redirect(`/${slug}/login?reason=reset`);
}

/** Step one of a first password: the API emails a code to the verified address. */
export async function sendPasswordCodeAction(slug: string): Promise<void> {
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(config, accessToken, 'POST', '/api/v1/auth/email-code', { purpose: 'set_password' });
  if (!result.ok) return refused(slug, result.code, result.retryAfterSeconds);
  redirect(`${securityPath(slug)}?done=${SECURITY_DONE.passwordCodeSent}`);
}

/**
 * Step two. The API ends every session once the password is set, this one
 * included, so the customer signs in again with it.
 */
export async function setPasswordAction(slug: string, formData: FormData): Promise<void> {
  const emailCode = String(formData.get('emailCode') ?? '').replace(/\s/g, '');
  const newPassword = String(formData.get('newPassword') ?? '');
  if (!emailCode || !newPassword) redirect(`${securityPath(slug)}?error=missing_password_code`);
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(config, accessToken, 'POST', '/api/v1/auth/set-password', { emailCode, newPassword });
  if (!result.ok) return refused(slug, result.code, result.retryAfterSeconds);
  await clearSession(slug);
  redirect(`/${slug}/login?reason=reset`);
}

export async function turnOffTwoFactorAction(slug: string, formData: FormData): Promise<void> {
  const code = String(formData.get('code') ?? '').replace(/\s/g, '');
  if (!code) redirect(`${securityPath(slug)}?error=missing`);
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(config, accessToken, 'POST', '/api/v1/auth/mfa/disable', { code });
  if (!result.ok) return refused(slug, result.code, result.retryAfterSeconds);
  redirect(`${securityPath(slug)}?done=${SECURITY_DONE.twoFactorOff}`);
}

/** Revoking the session this browser is using ends the portal session here too. */
export async function revokeSessionAction(slug: string, sessionId: string, current: boolean): Promise<void> {
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(
    config,
    accessToken,
    'DELETE',
    `/api/v1/auth/sessions/${encodeURIComponent(sessionId)}`,
  );
  if (!result.ok) return refused(slug, result.code, result.retryAfterSeconds);
  if (current) return signedOut(slug);
  redirect(`${securityPath(slug)}?done=${SECURITY_DONE.sessionRevoked}`);
}

export async function signOutEverywhereAction(slug: string): Promise<void> {
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(config, accessToken, 'POST', '/api/v1/auth/sign-out-everywhere', {});
  if (!result.ok) return refused(slug, result.code, result.retryAfterSeconds);
  return signedOut(slug);
}

export async function removeProviderAction(slug: string, provider: string): Promise<void> {
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(
    config,
    accessToken,
    'DELETE',
    `/api/v1/auth/oauth/${encodeURIComponent(provider)}`,
  );
  if (!result.ok) return refused(slug, result.code, result.retryAfterSeconds);
  redirect(`${securityPath(slug)}?done=${SECURITY_DONE.providerRemoved}`);
}
