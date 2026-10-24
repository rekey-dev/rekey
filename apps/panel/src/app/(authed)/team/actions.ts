'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, errorQuery, PanelApiError, type InvitationRow } from '@/lib/api';
import type { OneTimeSecret, RevealResult } from '@/lib/one-time-secret';
import { publicHttpUrl } from '@/lib/public-url';

interface InviteCreateResponse {
  invitation: InvitationRow;
  token: string;
  emailSent: boolean;
}

interface InviteResendResponse {
  token: string;
  emailSent: boolean;
}

/**
 * PANEL_URL is server-only and on some deploys is an in-cluster host (e.g.
 * http://panel:3031); `publicHttpUrl()` keeps that out of what the operator
 * copies. When it doesn't look public the link carries a visible sentinel
 * rather than a relative path, because a relative path pasted into a chat
 * message is silently useless to the recipient.
 */
function inviteLink(token: string): string {
  const panelBase = publicHttpUrl(process.env.PANEL_URL ?? '') ?? '<set PANEL_URL>';
  return `${panelBase}/accept-invite?token=${token}`;
}

function inviteSecret(
  email: string,
  token: string,
  emailSent: boolean,
  extra: { flag?: string; note?: string } = {},
): OneTimeSecret {
  return {
    title: emailSent ? `Invitation sent to ${email}` : `Send ${email} this link`,
    value: inviteLink(token),
    ...(extra.flag !== undefined && { flag: extra.flag }),
    reissuable: true,
    notes: [
      emailSent
        ? 'They will get an email with a button to join. You can also share the link above yourself.'
        : 'Email is not set up here, so copy the link and send it to them yourself.',
      `It only works for ${email} and expires in 7 days.`,
      ...(extra.note ? [extra.note] : []),
    ],
  };
}

// The token joins a workspace, so it is a credential: in a URL it lands in
// browser history and access logs. It goes back in the action's response to
// the dialog `RevealActionForm` opens, and the page is revalidated so the
// pending invitation is already in the list behind it.
export async function invite(formData: FormData): Promise<RevealResult> {
  const email = String(formData.get('email') ?? '').trim();
  const role = String(formData.get('role') ?? 'MEMBER');
  if (!email) redirect('/team?newInvite=1&error=missing');
  // The app picker is only visible for Member; owners and admins reach every app.
  const appGrants =
    role === 'MEMBER'
      ? formData.getAll('appId').map((id) => ({
          applicationId: String(id),
          role: String(formData.get(`appRole.${String(id)}`) ?? 'APP_VIEWER'),
        }))
      : [];
  let result: InviteCreateResponse;
  try {
    result = await api<InviteCreateResponse>({
      method: 'POST',
      path: '/api/v1/tenant/workspace/invitations',
      body: { email, role, ...(appGrants.length > 0 && { appGrants }) },
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`/team?${await errorQuery(err, { newInvite: '1' })}`);
    throw err;
  }
  revalidatePath('/team');
  return { secret: inviteSecret(result.invitation.email, result.token, result.emailSent, {
    flag: 'member_invited',
    ...(result.invitation.role === 'MEMBER' && result.invitation.appGrants.length === 0 && {
      note: 'You gave them no apps, so they will see nothing until you choose some on the App access tab.',
    }),
  }) };
}

export async function resendInvite(invitationId: string, email: string): Promise<RevealResult> {
  let result: InviteResendResponse;
  try {
    result = await api<InviteResendResponse>({
      method: 'POST',
      path: `/api/v1/tenant/workspace/invitations/${encodeURIComponent(invitationId)}/resend`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`/team?${await errorQuery(err)}`);
    throw err;
  }
  revalidatePath('/team');
  return { secret: inviteSecret(email, result.token, result.emailSent, {
    note: 'This is a new link. Any link you sent before no longer works.',
  }) };
}

export async function revokeInvite(invitationId: string): Promise<void> {
  try {
    await api({
      method: 'DELETE',
      path: `/api/v1/tenant/workspace/invitations/${encodeURIComponent(invitationId)}`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`/team?${await errorQuery(err)}`);
    throw err;
  }
  redirect('/team');
}

export async function removeMember(membershipId: string): Promise<void> {
  try {
    await api({
      method: 'DELETE',
      path: `/api/v1/tenant/workspace/members/${encodeURIComponent(membershipId)}`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`/team?${await errorQuery(err)}`);
    throw err;
  }
  redirect('/team');
}

export async function changeRole(membershipId: string, formData: FormData): Promise<void> {
  const role = String(formData.get('role') ?? 'MEMBER');
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/workspace/members/${encodeURIComponent(membershipId)}`,
      body: { role },
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`/team?${await errorQuery(err)}`);
    throw err;
  }
  redirect('/team');
}
