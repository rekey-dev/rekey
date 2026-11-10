/**
 * Pending organization invitations as an OWNER or ADMIN manages them after
 * creating one (list, resend with a fresh link), and as the invited person
 * first sees one (preview by token). Creating and accepting live in
 * `organizations.service.ts`.
 */

import type { Application } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { hashInviteToken, organizationsService, type InvitationDto } from './organizations.service.js';
import { maskEmail } from '../../lib/mask-email.js';

export interface PendingInvitationDto {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  invitedBy: { endUserId: string; email: string } | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface InvitationPreviewDto {
  organizationName: string;
  role: string;
  invitedEmail: string;
  invitedBy: string | null;
  expiresAt: Date;
}

interface OrganizationActor {
  application: Application;
  actorEndUserId: string;
  organizationId: string;
}

const PENDING = { acceptedAt: null, revokedAt: null } as const;

export const organizationInvitationsService = {
  /**
   * Invitations nobody has accepted or revoked, newest first, expired ones
   * included so they can be resent. OWNER or ADMIN tier, like revoke.
   */
  async listPending(
    args: OrganizationActor & { take?: number; skip?: number },
  ): Promise<{ rows: PendingInvitationDto[]; total: number }> {
    await organizationsService.requireRole(args, ['OWNER', 'ADMIN']);
    const where = { organizationId: args.organizationId, ...PENDING };
    const [rows, total] = await Promise.all([
      prisma.organizationInvitation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...(args.take !== undefined ? { take: args.take } : {}),
        ...(args.skip !== undefined ? { skip: args.skip } : {}),
      }),
      prisma.organizationInvitation.count({ where }),
    ]);
    const inviters = await prisma.endUser.findMany({
      where: { applicationId: args.application.id, id: { in: [...new Set(rows.map((r) => r.invitedById))] } },
      select: { id: true, email: true },
    });
    const emailOf = new Map(inviters.map((u) => [u.id, u.email]));
    return {
      total,
      rows: rows.map((r) => {
        const inviterEmail = emailOf.get(r.invitedById);
        return {
          id: r.id,
          organizationId: r.organizationId,
          email: r.email,
          role: r.role,
          invitedBy: inviterEmail === undefined ? null : { endUserId: r.invitedById, email: inviterEmail },
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
        };
      }),
    };
  },

  /**
   * Issue a fresh link for a pending invitation and revoke the old one. Only a
   * hash of each token is stored, so the old link cannot be shown again.
   * Goes through `createInvitation`, so the caller needs the same authority as
   * inviting that address at that role, and a fresh invitation id comes back.
   * The new invitation exists before the old one is revoked, so a failure
   * between the two leaves a working link rather than none.
   */
  async resend(
    args: OrganizationActor & { invitationId: string; inviteUrl?: string | undefined },
  ): Promise<{ rawToken: string; invitation: InvitationDto; emailSent: boolean }> {
    await organizationsService.requireMembership(args);
    const old = await prisma.organizationInvitation.findUnique({ where: { id: args.invitationId } });
    if (!old || old.organizationId !== args.organizationId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'ORGANIZATION_INVITATION_NOT_FOUND',
        message: 'Invitation not found.',
        fix: 'List invitations to confirm the id.',
      });
    }
    if (old.acceptedAt || old.revokedAt) {
      throw new RekeyError({
        statusCode: 409,
        code: 'ORGANIZATION_INVITATION_NOT_PENDING',
        message: 'That invitation was already accepted or revoked, so there is nothing to resend.',
        fix: 'Invite the address again with POST /api/v1/users/me/organizations/:id/invitations.',
      });
    }
    const fresh = await organizationsService.createInvitation({
      application: args.application,
      actorEndUserId: args.actorEndUserId,
      organizationId: args.organizationId,
      email: old.email,
      role: old.role,
      inviteUrl: args.inviteUrl,
    });
    await prisma.organizationInvitation.updateMany({
      where: { id: old.id, ...PENDING },
      data: { revokedAt: new Date() },
    });
    return fresh;
  },

  /**
   * What an invitation offers, read by its token with no session, for the page
   * the link opens.
   *
   * Security invariant: an anonymous caller holding a token learns only the
   * organization's name, the role, and masked addresses, and every token that
   * cannot be accepted here (unknown, expired, revoked, used, or another
   * Application's) gets the same refusal after the same two queries. Anything
   * more would let a guessed or leaked token map who is being invited where,
   * or tell a guesser which tokens once existed.
   */
  async preview(args: { application: { id: string }; rawToken: string }): Promise<InvitationPreviewDto> {
    const inv = await prisma.organizationInvitation.findUnique({
      where: { tokenHash: hashInviteToken(args.rawToken) },
      include: { organization: { select: { name: true, applicationId: true } } },
    });
    const inviter = await prisma.endUser.findFirst({
      where: { id: inv?.invitedById ?? '', applicationId: args.application.id },
      select: { email: true },
    });
    const usable =
      inv !== null &&
      inv.acceptedAt === null &&
      inv.revokedAt === null &&
      inv.expiresAt > new Date() &&
      inv.organization.applicationId === args.application.id;
    if (!usable) {
      throw new RekeyError({
        statusCode: 404,
        code: 'ORGANIZATION_INVITATION_UNAVAILABLE',
        message: 'This invitation is no longer valid.',
        fix: 'Ask the person who invited you to send a new invitation.',
      });
    }
    return {
      organizationName: inv.organization.name,
      role: inv.role,
      invitedEmail: maskEmail(inv.email),
      invitedBy: inviter ? maskEmail(inviter.email) : null,
      expiresAt: inv.expiresAt,
    };
  },
};
