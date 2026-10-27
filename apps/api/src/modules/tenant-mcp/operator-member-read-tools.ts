/**
 * Operator MCP read tool for a workspace member's per-application grants, the
 * rows GET /workspace/members/:id/grants returns. OWNER/ADMIN, like that route.
 */

import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { tenantWorkspacesService } from '../tenant-workspaces/tenant-workspaces.service.js';
import type { OperatorTool } from './operator-tools.js';
import { defineTool } from './tool-definition.js';

export const operatorMemberReadTools: OperatorTool[] = [
  defineTool({
    name: 'list_member_grants',
    description:
      "A workspace member's per-application grants: application id, name and slug, and the role on it " +
      '(APP_ADMIN, APP_BILLING or APP_VIEWER). Only a MEMBER has grants; an OWNER or ADMIN reaches every ' +
      'application and lists none. Requires the OWNER or ADMIN workspace role.',
    minRole: 'ADMIN',
    args: z
      .object({ tenantUserId: z.string().min(1).max(200).describe('The member, from list_members.') })
      .strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, input) => {
      const membership = await prisma.tenantMembership.findUnique({
        where: { tenantUserId_tenantId: { tenantUserId: input.tenantUserId, tenantId: ctx.tenantId } },
        select: { id: true, role: true },
      });
      if (!membership) {
        throw new RekeyError({
          statusCode: 404,
          code: 'MEMBERSHIP_NOT_FOUND',
          message: 'Membership not found in this workspace.',
          fix: 'Call list_members for the tenantUserId of each member.',
        });
      }
      const { items, total } = await tenantWorkspacesService.listMemberGrants({
        tenantId: ctx.tenantId,
        membershipId: membership.id,
        take: 100,
      });
      return { tenantUserId: input.tenantUserId, role: membership.role, grants: items, total };
    },
  }),
];
