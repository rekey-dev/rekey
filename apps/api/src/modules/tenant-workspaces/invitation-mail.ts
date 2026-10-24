import type { TenantInvitation } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { buildTokenUrl } from '../../lib/app-url.js';
import { panelBaseUrl } from '../../lib/panel-url.js';
import { emailService } from '../email/email.service.js';
import { mayMailUnattended, OPERATOR_EMAIL_SCOPE } from '../email/auth-email-caps.js';

/**
 * Email a workspace invitation link to the address it was issued for. Returns
 * whether the mail went out. The invitation exists either way and its link is
 * shown to the inviter; only the mail is skipped once this mailbox has had its
 * share.
 *
 * @example
 * ```ts
 * const emailSent = await mailInvitation({ invitation, rawToken, inviterId });
 * ```
 */
export async function mailInvitation(args: {
  invitation: TenantInvitation;
  rawToken: string;
  inviterId: string;
  /** Optional URL with `{token}` substituted in the email body. */
  inviteUrl?: string;
}): Promise<boolean> {
  const { invitation, rawToken } = args;
  if (!(await mayMailUnattended(OPERATOR_EMAIL_SCOPE, invitation.email))) return false;
  const [inviter, tenant] = await Promise.all([
    prisma.tenantUser.findUnique({ where: { id: args.inviterId }, select: { name: true, email: true } }),
    prisma.tenant.findUnique({ where: { id: invitation.tenantId }, select: { name: true } }),
  ]);
  const mailed = await emailService.dispatchSystem({
    eventKey: 'workspace_invitation',
    to: invitation.email,
    tenantId: invitation.tenantId,
    variables: {
      inviteeEmail: invitation.email,
      inviterName: inviter?.name ?? inviter?.email ?? 'A teammate',
      workspaceName: tenant?.name ?? 'a workspace',
      // The link opens the operator panel, never a customer app. With no
      // panel URL configured it resolves to empty and the template drops the
      // button, rather than mailing a live token to a placeholder domain.
      inviteUrl: args.inviteUrl
        ? args.inviteUrl.replace('{token}', encodeURIComponent(rawToken))
        : buildTokenUrl(panelBaseUrl(), '/accept-invite', rawToken),
      expiresAtIso: invitation.expiresAt.toISOString(),
    },
  });
  return mailed.kind === 'sent';
}
