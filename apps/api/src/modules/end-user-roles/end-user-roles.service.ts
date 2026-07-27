/**
 * Per-Application end-user role catalog.
 *
 * Roles are free-form names ("user", "admin", "editor"…) — we don't ship
 * an enum. The catalog table guarantees:
 *   - Uniqueness within an Application (no typo'd duplicates).
 *   - Existence: writes to EndUser.role validate against this list.
 *   - A single default role: assigned to every public sign-up.
 *
 * Operators manage the catalog through the panel (tenant JWT). End-users
 * never touch it — the SDK has no role-mutation surface, and the only
 * write paths to EndUser.role are operator-scoped.
 *
 * Bootstrap: every Application is seeded with a `user` role (isDefault).
 * See applications.service.create — it inserts the row in the same
 * transaction.
 */

import type { EndUserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';

const NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;

export const endUserRolesService = {
  async list(applicationId: string): Promise<EndUserRole[]> {
    return prisma.endUserRole.findMany({
      where: { applicationId },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  },

  async getDefault(applicationId: string): Promise<EndUserRole> {
    const def = await prisma.endUserRole.findFirst({
      where: { applicationId, isDefault: true },
    });
    if (!def) {
      // No default configured — fall back to any role with name "user", or
      // the first one. The bootstrap should always have created one but a
      // panel operator could have ended up here by deleting it.
      const any = await prisma.endUserRole.findFirst({
        where: { applicationId },
        orderBy: { createdAt: 'asc' },
      });
      if (!any) {
        throw new RekeyError({
          statusCode: 500,
          code: 'NO_END_USER_ROLES',
          message: 'This Application has no end-user roles defined.',
          fix: 'Create at least one role + mark it default via the panel.',
        });
      }
      return any;
    }
    return def;
  },

  /**
   * Throws if the role isn't in the catalog. Used by every write path that
   * touches EndUser.role.
   */
  async assertExists(applicationId: string, name: string): Promise<void> {
    const exists = await prisma.endUserRole.findUnique({
      where: { applicationId_name: { applicationId, name } },
      select: { id: true },
    });
    if (!exists) {
      throw new RekeyError({
        statusCode: 400,
        code: 'END_USER_ROLE_UNKNOWN',
        message: `Role "${name}" is not defined for this Application.`,
        fix: 'Pick an existing role or create it first via the panel.',
      });
    }
  },

  /**
   * Seed the bootstrap `user` role for a freshly-created Application. Idempotent.
   * Called from `applicationsService.create` inside the transaction.
   */
  async seedDefault(tx: typeof prisma, applicationId: string): Promise<void> {
    await tx.endUserRole.upsert({
      where: { applicationId_name: { applicationId, name: 'user' } },
      create: {
        applicationId,
        name: 'user',
        description: 'Default role assigned to public sign-ups.',
        isDefault: true,
      },
      update: {},
    });
  },

  async create(input: {
    applicationId: string;
    name: string;
    description?: string;
    isDefault?: boolean;
  }): Promise<EndUserRole> {
    const name = input.name.trim();
    if (!NAME_RE.test(name)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'END_USER_ROLE_NAME_INVALID',
        message:
          'Role name must be lowercase letters, digits, hyphens, or underscores (2–40 chars, edges alphanumeric).',
        fix: 'Pick a name like "admin" or "billing-only".',
      });
    }
    return prisma.$transaction(async (tx) => {
      // If marking this as default, demote the existing default first.
      if (input.isDefault) {
        await tx.endUserRole.updateMany({
          where: { applicationId: input.applicationId, isDefault: true },
          data: { isDefault: false },
        });
      }
      try {
        return await tx.endUserRole.create({
          data: {
            applicationId: input.applicationId,
            name,
            ...(input.description !== undefined && { description: input.description }),
            isDefault: input.isDefault ?? false,
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') {
          throw new RekeyError({
            statusCode: 409,
            code: 'END_USER_ROLE_NAME_TAKEN',
            message: `Role "${name}" already exists for this Application.`,
            fix: 'Pick a different name or edit the existing role.',
          });
        }
        throw e;
      }
    });
  },

  async update(args: {
    applicationId: string;
    name: string;
    description?: string | null;
    isDefault?: boolean;
  }): Promise<EndUserRole> {
    const role = await prisma.endUserRole.findUnique({
      where: { applicationId_name: { applicationId: args.applicationId, name: args.name } },
    });
    if (!role) {
      throw new RekeyError({
        statusCode: 404,
        code: 'END_USER_ROLE_NOT_FOUND',
        message: `Role "${args.name}" not found.`,
        fix: 'List roles to confirm the name.',
      });
    }
    return prisma.$transaction(async (tx) => {
      if (args.isDefault === true && !role.isDefault) {
        await tx.endUserRole.updateMany({
          where: { applicationId: args.applicationId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.endUserRole.update({
        where: { id: role.id },
        data: {
          ...(args.description !== undefined && { description: args.description }),
          ...(args.isDefault !== undefined && { isDefault: args.isDefault }),
        },
      });
    });
  },

  /**
   * Delete a role. Refuses if the role is the default. If any EndUser
   * still holds it, the caller must pass `reassignTo` (the name of
   * another role in this Application's catalog) — the service does the
   * bulk-update + delete atomically.
   *
   * `reassignTo` semantics:
   *   - Must exist in this Application's catalog.
   *   - Can be any role, including the default.
   *   - Reassignment + delete run in one transaction so a webhook firing
   *     mid-flight can't observe orphaned users.
   */
  async remove(args: {
    applicationId: string;
    name: string;
    reassignTo?: string;
  }): Promise<{ removed: boolean; reassigned: number }> {
    const { applicationId, name, reassignTo } = args;
    const role = await prisma.endUserRole.findUnique({
      where: { applicationId_name: { applicationId, name } },
    });
    if (!role) {
      throw new RekeyError({
        statusCode: 404,
        code: 'END_USER_ROLE_NOT_FOUND',
        message: `Role "${name}" not found.`,
        fix: 'List roles to confirm the name.',
      });
    }
    if (role.isDefault) {
      throw new RekeyError({
        statusCode: 400,
        code: 'END_USER_ROLE_IS_DEFAULT',
        message: `Cannot delete "${name}" — it's the default role for this Application.`,
        fix: 'Mark a different role as default first, then delete this one.',
      });
    }
    const inUse = await prisma.endUser.count({
      where: { applicationId, role: name },
    });
    if (inUse > 0 && !reassignTo) {
      throw new RekeyError({
        statusCode: 400,
        code: 'END_USER_ROLE_IN_USE',
        message: `Cannot delete "${name}" — ${inUse} end-user${inUse === 1 ? '' : 's'} still hold this role.`,
        fix: 'Pass `reassignTo` with the name of another role to bulk-reassign + delete in one shot.',
      });
    }
    if (reassignTo) {
      if (reassignTo === name) {
        throw new RekeyError({
          statusCode: 400,
          code: 'END_USER_ROLE_REASSIGN_SELF',
          message: 'Cannot reassign to the role being deleted.',
          fix: 'Pick a different `reassignTo` target.',
        });
      }
      const target = await prisma.endUserRole.findUnique({
        where: { applicationId_name: { applicationId, name: reassignTo } },
        select: { id: true },
      });
      if (!target) {
        throw new RekeyError({
          statusCode: 400,
          code: 'END_USER_ROLE_REASSIGN_TARGET_UNKNOWN',
          message: `Target role "${reassignTo}" doesn't exist in this Application.`,
          fix: 'Pick an existing role from the catalog.',
        });
      }
    }
    return prisma.$transaction(async (tx) => {
      let reassigned = 0;
      if (reassignTo && inUse > 0) {
        const result = await tx.endUser.updateMany({
          where: { applicationId, role: name },
          data: { role: reassignTo },
        });
        reassigned = result.count;
      }
      await tx.endUserRole.delete({ where: { id: role.id } });
      return { removed: true, reassigned };
    });
  },
};
