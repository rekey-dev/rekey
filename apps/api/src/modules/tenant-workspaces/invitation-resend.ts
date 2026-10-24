import type { TenantRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import {
  defaultInvitationExpiry,
  generateInvitationToken,
  hashInvitationToken,
} from '../../lib/tenant-invitations.js';
import { assertOperatorVerifiedForCredential } from '../tenant-auth/operator-confirmation.js';
import { mailInvitation } from './invitation-mail.js';
import { assertInvitationGrants, type InvitationAppGrant } from './invitation-grants.js';
import { ensureCanManage } from './tenant-workspaces.service.js';

/**
 * Send a pending invitation again: a fresh link and a fresh expiry, mailed to
 * the same address at the same role. The previous link stops working, so a
 * link the inviter lost or shared by mistake is retired by the same click.
 *
 * Expired invitations can be resent too; revoked and accepted ones cannot.
 * Passing `appGrants` replaces the apps a MEMBER gets on joining; leaving it
 * out keeps the ones chosen before.
 *
 * @example
 * ```ts
 * const { rawToken, emailSent } = await resendInvitation({ tenantId, invitationId, actorId, actorRole });
 * ```
 */
export async function resendInvitation(args: {
  tenantId: string;
  invitationId: string;
  actorId: string;
  actorRole: TenantRole;
  appGrants?: InvitationAppGrant[];
}): Promise<{ rawToken: string; emailSent: boolean; expiresAt: Date; appGrants: InvitationAppGrant[] }> {
  const inv = await prisma.tenantInvitation.findUnique({ where: { id: args.invitationId } });
  if (!inv || inv.tenantId !== args.tenantId) {
    throw new RekeyError({
      statusCode: 404,
      code: 'INVITATION_NOT_FOUND',
      message: 'Invitation not found in this workspace.',
      fix: 'List invitations to see what exists.',
    });
  }
  ensureCanManage(args.actorRole, inv.role);
  await assertOperatorVerifiedForCredential(args.actorId, 'invite someone to the workspace');
  if (inv.acceptedAt || inv.revokedAt) {
    throw new RekeyError({
      statusCode: 400,
      code: 'INVITATION_NOT_USABLE',
      message: 'This invitation was already accepted or withdrawn, so it cannot be sent again.',
      fix: 'Send a new invitation instead.',
    });
  }

  const member = await prisma.tenantMembership.findFirst({
    where: { tenantId: args.tenantId, tenantUser: { email: inv.email } },
  });
  if (member) {
    throw new RekeyError({
      statusCode: 409,
      code: 'INVITE_TARGET_ALREADY_MEMBER',
      message: `${inv.email} is already a member of this workspace.`,
      fix: 'No invite needed, they can sign in directly. Withdraw this invitation.',
    });
  }

  const { appGrants } = args;
  if (appGrants) await assertInvitationGrants(args.tenantId, inv.role, appGrants);

  const rawToken = generateInvitationToken();
  const expiresAt = defaultInvitationExpiry();
  const grants = await prisma.$transaction(async (tx) => {
    const rotated = await tx.tenantInvitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null },
      // Whoever replaces the apps is who the security log names as granting them.
      data: { tokenHash: hashInvitationToken(rawToken), expiresAt, ...(appGrants && { invitedById: args.actorId }) },
    });
    if (rotated.count !== 1) {
      throw new RekeyError({
        statusCode: 400,
        code: 'INVITATION_NOT_USABLE',
        message: 'This invitation was accepted or withdrawn a moment ago.',
        fix: 'Refresh the invitation list.',
      });
    }
    if (appGrants) {
      await tx.tenantInvitationGrant.deleteMany({ where: { invitationId: inv.id } });
      await tx.tenantInvitationGrant.createMany({
        data: appGrants.map((g) => ({ invitationId: inv.id, applicationId: g.applicationId, role: g.role })),
      });
    }
    return tx.tenantInvitationGrant.findMany({
      where: { invitationId: inv.id },
      select: { applicationId: true, role: true },
    });
  });
  const emailSent = await mailInvitation({
    invitation: { ...inv, expiresAt },
    rawToken,
    inviterId: args.actorId,
  });
  return { rawToken, emailSent, expiresAt, appGrants: grants };
}
