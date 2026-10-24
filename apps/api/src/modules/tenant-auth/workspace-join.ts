import type { Prisma, TenantRole } from '@prisma/client';
import { resolveNewTenantLimits } from '../../lib/tenant-limits.js';
import type { ResolvedSignupInvite } from './operator-signup-policy.js';
import { applyInvitationGrants } from '../tenant-workspaces/invitation-grants.js';

/**
 * Give a just-created operator their first membership: the workspace a bound
 * invite names, at its role (with the app grants a teammate invitation
 * carries), or a new workspace they OWN. Runs inside the
 * operator-creation transaction, before the invite is consumed.
 *
 * @example
 * ```ts
 * const { tenantId, role } = await joinOrCreateWorkspace(tx, { userId, email, invite, workspaceName });
 * ```
 */
export async function joinOrCreateWorkspace(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    email: string;
    invite: ResolvedSignupInvite | null;
    workspaceName: string;
  },
): Promise<{ tenantId: string; role: TenantRole }> {
  const bound = input.invite?.workspace;
  if (bound) {
    const membership = await tx.tenantMembership.create({
      data: { tenantUserId: input.userId, tenantId: bound.tenantId, role: bound.role },
    });
    if (input.invite?.kind === 'workspace-invitation') {
      await applyInvitationGrants(tx, input.invite.inviteId, membership.id);
    }
    return { tenantId: bound.tenantId, role: bound.role };
  }
  // `resolveNewTenantLimits()` stamps the deployment's DEFAULT_TENANT_LIMITS
  // on the workspace, so neither sign-up path lands in a wider one.
  const tenant = await tx.tenant.create({
    data: { name: input.workspaceName, ownerEmail: input.email, ...resolveNewTenantLimits() },
  });
  await tx.tenantMembership.create({
    data: { tenantUserId: input.userId, tenantId: tenant.id, role: 'OWNER' },
  });
  return { tenantId: tenant.id, role: 'OWNER' };
}
