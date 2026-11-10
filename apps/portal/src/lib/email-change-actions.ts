'use server';

/**
 * Changing the customer's email address. Asking mails a link to the new
 * address; the link's page confirms it with this session, or with the
 * account's password where nobody is signed in. No address, token or password
 * rides in a redirect.
 */

import { redirect } from 'next/navigation';
import { getPortalConfig } from './config';
import { customerCall } from './customer-call';
import { portalPublicBase } from './public-base';
import { clearEmailChangeLink, clearSession, getAccessToken, getEmailChangeLink } from './session';
import { isSessionRefusal } from './devices';
import { retryQuery } from './auth-error-copy';
import { profilePath } from './profile';
import { emailChangeConfirmPath, EMAIL_CHANGE_SENT } from './profile-copy';

export async function requestEmailChangeAction(slug: string, formData: FormData): Promise<void> {
  const newEmail = String(formData.get('newEmail') ?? '').trim();
  if (!newEmail) redirect(`${profilePath(slug)}?email_error=missing`);
  const [config, accessToken] = await Promise.all([getPortalConfig(slug), getAccessToken()]);
  if (!config || !accessToken) redirect(`/${slug}/login?reason=expired`);
  const result = await customerCall(config, accessToken, 'POST', '/api/v1/users/me/email', {
    newEmail,
    confirmUrl: `${await portalPublicBase(slug)}/email-change-link?token={token}`,
  });
  if (!result.ok) {
    if (isSessionRefusal(result.code)) redirect(`/${slug}/login?reason=expired`);
    redirect(`${profilePath(slug)}?email_error=${encodeURIComponent(result.code)}${retryQuery(result.retryAfterSeconds)}`);
  }
  redirect(`${profilePath(slug)}?done=${EMAIL_CHANGE_SENT}`);
}

/**
 * The API ends every session once the address changes, so the portal signs
 * out here too. A mistyped password keeps the link for another try; a dead
 * link is dropped.
 */
export async function confirmEmailChangeAction(slug: string, formData: FormData): Promise<void> {
  const page = emailChangeConfirmPath(slug);
  const [config, token, accessToken] = await Promise.all([getPortalConfig(slug), getEmailChangeLink(), getAccessToken()]);
  if (!config || !token) redirect(page);
  const password = String(formData.get('password') ?? '');
  const result = await customerCall(config, accessToken, 'POST', '/api/v1/auth/email-change/confirm', {
    token,
    ...(password && { password }),
  });
  if (!result.ok) {
    if (result.code === 'EMAIL_CHANGE_TOKEN_INVALID') await clearEmailChangeLink(slug);
    if (isSessionRefusal(result.code)) await clearSession(slug);
    redirect(`${page}?error=${encodeURIComponent(result.code)}${retryQuery(result.retryAfterSeconds)}`);
  }
  await clearEmailChangeLink(slug);
  await clearSession(slug);
  redirect(`${page}?done=1`);
}
