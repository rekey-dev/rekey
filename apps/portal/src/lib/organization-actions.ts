'use server';

/**
 * Organization changes a signed-in customer makes for themselves. The API
 * decides every permission; these pass its refusals on as codes. The one
 * secret here, a new invitation's token, is emailed by the API and also comes
 * back in the invite action's response, never in a URL the portal redirects to.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { AuthResultDto, OrganizationInvitationDto } from '@rekey.dev/shared-types';
import { getPortalConfig } from './config';
import { customerCall } from './customer-call';
import { portalPublicBase } from './public-base';
import { clearSession, getAccessToken, setSession } from './session';
import { isSessionRefusal } from './devices';
import { organizationPath } from './organizations';
import { ORGANIZATION_DONE, invitationIsSpent, organizationErrorCopy, organizationSlug } from './organization-copy';
import { clearInvitationLink, getInvitationLink, invitationPath } from './invitation-link';

async function signedIn(slug: string) {
  const [config, accessToken] = await Promise.all([getPortalConfig(slug), getAccessToken()]);
  if (!config || !accessToken) redirect(`/${slug}/login?reason=expired`);
  return { config, accessToken };
}

function orgUrl(organizationId: string): string {
  return `/api/v1/users/me/organizations/${encodeURIComponent(organizationId)}`;
}

async function refused(slug: string, code: string): Promise<never> {
  if (isSessionRefusal(code)) {
    await clearSession(slug);
    redirect(`/${slug}/login?reason=expired`);
  }
  redirect(`${organizationPath(slug)}?error=${encodeURIComponent(code)}`);
}

/**
 * Switching re-mints the session with the organization in its `oid` claim, so
 * the new pair replaces the cookies the way a refresh does. The API keeps a
 * portal session a portal session.
 */
export async function switchOrganizationAction(slug: string, organizationId: string | null): Promise<void> {
  const { config, accessToken } = await signedIn(slug);
  const path = organizationId ? `${orgUrl(organizationId)}/switch` : '/api/v1/users/me/organizations/clear-active-organization';
  const result = await customerCall<AuthResultDto>(config, accessToken, 'POST', path, {});
  if (!result.ok) return refused(slug, result.code);
  await setSession(slug, result.data.accessToken, result.data.refreshToken, result.data);
  redirect(`${organizationPath(slug)}?done=${organizationId ? ORGANIZATION_DONE.switched : ORGANIZATION_DONE.personal}`);
}

export async function createOrganizationAction(slug: string, formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim();
  const orgSlug = organizationSlug(name);
  if (!name || !orgSlug) redirect(`${organizationPath(slug)}?error=missing`);
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(config, accessToken, 'POST', '/api/v1/users/me/organizations', { name, slug: orgSlug });
  if (!result.ok) return refused(slug, result.code);
  redirect(`${organizationPath(slug)}?done=${ORGANIZATION_DONE.created}`);
}

export type InviteState =
  | { status: 'idle' }
  | { status: 'refused'; message: string }
  | { status: 'invited'; invitation: OrganizationInvitationDto; link: string; emailSent: boolean };

type Invited = { invitation: OrganizationInvitationDto; token: string; emailSent: boolean };

/** The link the API emails, on the host this visitor is using; `{token}` is filled in by the API. */
async function inviteUrl(slug: string): Promise<string> {
  return `${await portalPublicBase(slug)}/invitation-link?token={token}`;
}

export async function inviteMemberAction(
  slug: string,
  organizationId: string,
  _previous: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const email = String(formData.get('email') ?? '').trim();
  const role = String(formData.get('role') ?? '');
  if (!email) return { status: 'refused', message: organizationErrorCopy('missing') };
  const { config, accessToken } = await signedIn(slug);
  const link = await inviteUrl(slug);
  const result = await customerCall<Invited>(config, accessToken, 'POST', `${orgUrl(organizationId)}/invitations`, {
    email,
    ...(role && { role }),
    inviteUrl: link,
  });
  if (!result.ok) {
    if (isSessionRefusal(result.code)) redirect(`/${slug}/login?reason=expired`);
    return { status: 'refused', message: organizationErrorCopy(result.code) };
  }
  // Re-render the page with this response, so the pending list shows the new
  // invitation. Not on resend: its row is replaced and would drop the link it shows.
  revalidatePath('/[slug]/organization', 'page');
  return invited(link, result.data);
}

function invited(link: string, data: Invited): InviteState {
  return {
    status: 'invited',
    invitation: data.invitation,
    link: link.replace('{token}', encodeURIComponent(data.token)),
    emailSent: data.emailSent,
  };
}

/** A fresh link for a pending invitation, emailed like a new one; the API revokes the old one. */
export async function resendInvitationAction(
  slug: string,
  organizationId: string,
  invitationId: string,
  _previous: InviteState,
): Promise<InviteState> {
  const { config, accessToken } = await signedIn(slug);
  const link = await inviteUrl(slug);
  const result = await customerCall<Invited>(
    config,
    accessToken,
    'POST',
    `${orgUrl(organizationId)}/invitations/${encodeURIComponent(invitationId)}/resend`,
    { inviteUrl: link },
  );
  if (!result.ok) {
    if (isSessionRefusal(result.code)) redirect(`/${slug}/login?reason=expired`);
    return { status: 'refused', message: organizationErrorCopy(result.code) };
  }
  return invited(link, result.data);
}

export async function revokeInvitationAction(slug: string, organizationId: string, invitationId: string): Promise<void> {
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(
    config,
    accessToken,
    'POST',
    `${orgUrl(organizationId)}/invitations/${encodeURIComponent(invitationId)}/revoke`,
    {},
  );
  if (!result.ok) return refused(slug, result.code);
  redirect(`${organizationPath(slug)}?done=${ORGANIZATION_DONE.revoked}`);
}

export async function changeMemberRoleAction(
  slug: string,
  organizationId: string,
  endUserId: string,
  formData: FormData,
): Promise<void> {
  const role = String(formData.get('role') ?? '');
  if (!role) redirect(`${organizationPath(slug)}?error=missing`);
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(
    config,
    accessToken,
    'PATCH',
    `${orgUrl(organizationId)}/members/${encodeURIComponent(endUserId)}`,
    { role },
  );
  if (!result.ok) return refused(slug, result.code);
  redirect(`${organizationPath(slug)}?done=${ORGANIZATION_DONE.roleChanged}`);
}

export async function removeMemberAction(slug: string, organizationId: string, endUserId: string): Promise<void> {
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(
    config,
    accessToken,
    'DELETE',
    `${orgUrl(organizationId)}/members/${encodeURIComponent(endUserId)}`,
  );
  if (!result.ok) return refused(slug, result.code);
  redirect(`${organizationPath(slug)}?done=${ORGANIZATION_DONE.removed}`);
}

export async function leaveOrganizationAction(slug: string, organizationId: string): Promise<void> {
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(config, accessToken, 'POST', `${orgUrl(organizationId)}/leave`, {});
  if (!result.ok) return refused(slug, result.code);
  redirect(`${organizationPath(slug)}?done=${ORGANIZATION_DONE.left}`);
}

/** The token comes from the cookie the link's landing route set, never from the form or the URL. */
export async function acceptInvitationAction(slug: string): Promise<void> {
  const token = await getInvitationLink();
  if (!token) redirect(invitationPath(slug));
  const [config, accessToken] = await Promise.all([getPortalConfig(slug), getAccessToken()]);
  if (!config || !accessToken) redirect(`/${slug}/login?return=invitation`);
  const result = await customerCall(config, accessToken, 'POST', '/api/v1/auth/organizations/accept-invitation', { token });
  if (!result.ok) {
    if (isSessionRefusal(result.code)) redirect(`/${slug}/login?return=invitation`);
    if (invitationIsSpent(result.code)) await clearInvitationLink(slug);
    redirect(`${invitationPath(slug)}?error=${encodeURIComponent(result.code)}`);
  }
  await clearInvitationLink(slug);
  redirect(`${organizationPath(slug)}?done=${ORGANIZATION_DONE.joined}`);
}
