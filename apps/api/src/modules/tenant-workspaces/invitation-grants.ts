import type { ApplicationGrantRole, Prisma, TenantRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { recordSecurityEventIn } from '../../lib/security-events.js';

/** One app a MEMBER invitation gives access to once it is accepted. */
export interface InvitationAppGrant {
  applicationId: string;
  role: ApplicationGrantRole;
}

/**
 * Refuse app grants an invitation cannot carry: grants on an OWNER or ADMIN
 * invitation (they already reach every app), or an app outside this workspace.
 *
 * @example
 * ```ts
 * await assertInvitationGrants('tnt_1', 'MEMBER', [{ applicationId: 'app_1', role: 'APP_VIEWER' }]);
 * ```
 */
export async function assertInvitationGrants(
  tenantId: string,
  role: TenantRole,
  grants: readonly InvitationAppGrant[],
): Promise<void> {
  if (grants.length === 0) return;
  if (role !== 'MEMBER') {
    throw new RekeyError({
      statusCode: 400,
      code: 'APP_GRANT_MEMBER_ONLY',
      message: `App access only applies to members. An invited ${role} gets full access to every application.`,
      fix: 'Send the invitation without appGrants, or invite them as MEMBER.',
    });
  }
  const ids = grants.map((g) => g.applicationId);
  const found = await prisma.application.findMany({
    where: { id: { in: ids }, tenantId },
    select: { id: true },
  });
  const known = new Set(found.map((a) => a.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new RekeyError({
      statusCode: 404,
      code: 'APPLICATION_NOT_FOUND',
      message: `Application${missing.length === 1 ? '' : 's'} not found in this workspace: ${missing.join(', ')}.`,
      fix: 'List applications via GET /api/v1/tenant/applications and use their ids.',
    });
  }
}

/**
 * Give a membership joining from an invitation the app grants the inviter
 * chose. Runs in the transaction that creates the membership, so the member
 * never exists without them. An app the member already has access to keeps
 * its role and is left out of the log. Like any grant, a new one ends a
 * backfilled membership's workspace-wide read, and each is in the security
 * log as set by whoever last chose the invitation's apps.
 *
 * @example
 * ```ts
 * await applyInvitationGrants(tx, invitation.id, membership.id);
 * ```
 */
export async function applyInvitationGrants(
  tx: Prisma.TransactionClient,
  invitationId: string,
  tenantMembershipId: string,
): Promise<void> {
  const chosen = await tx.tenantInvitationGrant.findMany({
    where: { invitationId },
    select: { applicationId: true, role: true, invitation: { select: { tenantId: true, invitedById: true } } },
  });
  const held = await tx.applicationGrant.findMany({ where: { tenantMembershipId }, select: { applicationId: true } });
  const alreadyHeld = new Set(held.map((h) => h.applicationId));
  const grants = chosen.filter((g) => !alreadyHeld.has(g.applicationId));
  if (grants.length === 0) return;
  await tx.applicationGrant.createMany({
    data: grants.map((g) => ({ tenantMembershipId, applicationId: g.applicationId, role: g.role })),
    skipDuplicates: true,
  });
  await tx.tenantMembership.update({ where: { id: tenantMembershipId }, data: { legacyWorkspaceRead: false } });
  for (const g of grants) {
    await recordSecurityEventIn(tx, {
      type: 'member.app_grant_set',
      actorType: 'operator',
      actorId: g.invitation.invitedById,
      tenantId: g.invitation.tenantId,
      applicationId: g.applicationId,
      metadata: { membershipId: tenantMembershipId, role: g.role, invitationId },
    });
  }
}
