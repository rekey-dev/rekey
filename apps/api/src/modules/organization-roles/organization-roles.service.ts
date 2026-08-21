/**
 * Per-Application catalog of ORGANIZATION role names.
 *
 * The org-scoped twin of `application-roles` (which governs `EndUser.role`,
 * one value per (Application, EndUser), app-wide). The two are deliberately
 * separate axes and must not be conflated:
 *
 *   EndUser.role                    → app-wide. "Is this person staff of the
 *                                     whole application?" Same value in every
 *                                     organization they belong to.
 *   OrganizationMembership.role     → per (organization, end-user). "What are
 *                                     they inside THIS agency?" A person in two
 *                                     agencies holds two independent values.
 *
 * Roles are free-form names ("editor", "reviewer", "content-manager") plus a
 * `baseRole` of OWNER / ADMIN / MEMBER. Rekey enforces its own invariants on
 * the BASE role only. The `canManage` ladder, the last-OWNER guard, and the
 * org-scoped billing writes all read `baseRole` and never the name. The name is
 * the customer app's vocabulary; Rekey stores it and hands it back.
 *
 * That split is what lets an agency CMS ship `editor` and `reviewer` (both on
 * baseRole MEMBER) without Rekey having to learn what either word means, while
 * still knowing that neither may demote an OWNER.
 *
 * WHO WRITES WHAT:
 *   - The CATALOG (which names exist) is operator-authored, via a tenant JWT and
 *     the panel or MCP. End-users cannot mint roles, so there is no path for an
 *     org member to invent a name that outranks their own.
 *   - ASSIGNMENT (who holds which name) is org-authored, by an OWNER/ADMIN using
 *     their own end-user access token, via
 *     `PATCH /users/me/organizations/:id/members/:euid` and
 *     `POST /users/me/organizations/:id/invitations`. No operator involved.
 *   - End-users can READ the catalog (`GET /users/me/organizations/roles`) so
 *     an org-admin UI can populate its role picker.
 *
 * Bootstrap: every Application is seeded with three built-in rows: OWNER,
 * ADMIN, MEMBER, each on its own base role, MEMBER marked default. Built-ins
 * cannot be renamed or deleted; they are the pre-catalog wire values, so every
 * membership row that predates this module keeps resolving.
 */

import type { OrganizationBaseRole, OrganizationRoleDef, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import {
  getOrganizationRoles,
  invalidateOrganizationRoles,
  organizationRoleTiers,
} from '../../lib/organization-role-cache.js';

/**
 * Custom role names are lowercase, mirroring the application-role catalog. The
 * three built-ins are uppercase and therefore unreachable by this pattern,
 * which is the point: `OWNER` is reserved, and an operator cannot mint a
 * lookalike that a reader would mistake for the real thing.
 */
const NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;

/** The three seeded rows. Order matters only for a stable listing. */
export const BUILT_IN_ROLES: ReadonlyArray<{
  name: string;
  description: string;
  baseRole: OrganizationBaseRole;
  isDefault: boolean;
}> = [
  {
    name: 'OWNER',
    description: 'Full control: manage the organization, its members and ownership transfer.',
    baseRole: 'OWNER',
    isDefault: false,
  },
  {
    name: 'ADMIN',
    description: 'Manage members below OWNER, and the organization profile.',
    baseRole: 'ADMIN',
    isDefault: false,
  },
  {
    name: 'MEMBER',
    description: 'Read-only access to the organization.',
    baseRole: 'MEMBER',
    isDefault: true,
  },
];

const BUILT_IN_NAMES = new Set(BUILT_IN_ROLES.map((r) => r.name));

export interface OrganizationRoleDto {
  name: string;
  description: string | null;
  baseRole: OrganizationBaseRole;
  isDefault: boolean;
  isBuiltIn: boolean;
  /** Holders are refused and the role cannot be newly assigned. */
  disabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function shape(r: OrganizationRoleDef): OrganizationRoleDto {
  return {
    name: r.name,
    description: r.description,
    baseRole: r.baseRole,
    isDefault: r.isDefault,
    isBuiltIn: r.isBuiltIn,
    disabled: r.disabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const organizationRolesService = {
  /** Full catalog for an Application, built-ins first then alphabetical. */
  async list(applicationId: string): Promise<OrganizationRoleDto[]> {
    return (await getOrganizationRoles(applicationId)).map(shape);
  },

  /**
   * Resolve one role NAME to its catalog row.
   *
   * Every write path that accepts a role name funnels through here, so an
   * unknown name is a 400 at the edge rather than a membership row holding a
   * value no gate can interpret.
   */
  async require(applicationId: string, name: string): Promise<OrganizationRoleDef> {
    const row = (await getOrganizationRoles(applicationId)).find((r) => r.name === name);
    if (!row) {
      throw new RekeyError({
        statusCode: 400,
        code: 'ORGANIZATION_ROLE_UNKNOWN',
        message: `Organization role "${name}" is not defined for this Application.`,
        fix: 'GET /api/v1/users/me/organizations/roles lists the assignable names. An operator creates new ones in the panel (Application → Users → Roles).',
      });
    }
    // A disabled role is still in the catalog, so it resolves, but it must not
    // be handed to anyone new. Existing holders are refused separately at the
    // membership gate, so revocation covers both directions.
    if (row.disabled) {
      throw new RekeyError({
        statusCode: 400,
        code: 'ORGANIZATION_ROLE_DISABLED',
        message: `Organization role "${name}" is disabled and cannot be assigned.`,
        fix: 'Re-enable it in the panel (Application → Users → Roles), or pick another role.',
      });
    }
    return row;
  },

  /**
   * The authority tier behind a role name. This is what every Rekey-side gate
   * compares. It never compares the name.
   */
  async baseRoleOf(applicationId: string, name: string): Promise<OrganizationBaseRole> {
    return (await this.require(applicationId, name)).baseRole;
  },

  /**
   * Base tier for a name already STORED on a membership or invitation, never
   * for caller-supplied input.
   *
   * Unknown names resolve to MEMBER, the least-privileged tier, instead of
   * throwing. Deletion is guarded, so an orphaned name should be unreachable;
   * if one exists anyway, a read must not 500 and a write gate must not treat
   * the unresolvable value as authority. `require` is the strict twin and is
   * what every caller-supplied role name goes through.
   */
  async baseRoleOrLeast(applicationId: string, name: string): Promise<OrganizationBaseRole> {
    return (await organizationRoleTiers(applicationId)).get(name) ?? 'MEMBER';
  },

  /**
   * Is a role name currently usable by the members holding it?
   *
   * False for a disabled role, and for a name the catalog no longer defines.
   * The membership gate calls this so revocation reaches existing holders and
   * not only new assignments.
   */
  async isUsable(applicationId: string, name: string): Promise<boolean> {
    const row = (await getOrganizationRoles(applicationId)).find((r) => r.name === name);
    return row !== undefined && !row.disabled;
  },

  /**
   * Whole catalog as name → base tier. For paths that resolve many memberships
   * at once (member listings) and would otherwise issue one query per row.
   * Same least-privilege fallback as `baseRoleOrLeast` at the lookup site.
   */
  async baseRoleMap(applicationId: string): Promise<Map<string, OrganizationBaseRole>> {
    return organizationRoleTiers(applicationId);
  },

  /**
   * Every role name in this Application that carries OWNER authority.
   *
   * The last-OWNER guard counts memberships by name, and an operator may have
   * defined more than one OWNER-tier name (say `founder`), so the guard has to
   * count all of them or it will happily delete the final owner of an org whose
   * owner happens to hold a custom name.
   */
  async ownerRoleNames(applicationId: string): Promise<string[]> {
    // Disabled roles are excluded: a holder of one cannot act, so counting them
    // as owners would let the last-owner guard pass on an organization that has
    // nobody able to do anything.
    return (await getOrganizationRoles(applicationId))
      .filter((r) => r.baseRole === 'OWNER' && !r.disabled)
      .map((r) => r.name);
  },

  /**
   * The role handed to a new member when a caller omits one. Reached from the
   * invitation path and from operator add-member, so the flag means the same
   * thing on both ways into an organization.
   */
  async getDefault(applicationId: string): Promise<OrganizationRoleDef> {
    const roles = await getOrganizationRoles(applicationId);
    // A disabled default would hand every new member a role that immediately
    // refuses them, so it is skipped exactly like a missing one.
    const def = roles.find((r) => r.isDefault && !r.disabled);
    if (def) return def;
    // The default was deleted or never seeded. Fall back to the built-in
    // MEMBER, which cannot be removed, before giving up.
    const member = roles.find((r) => r.name === 'MEMBER' && !r.disabled);
    if (member) return member;
    throw new RekeyError({
      statusCode: 500,
      code: 'NO_ORGANIZATION_ROLES',
      message: 'This Application has no organization roles defined.',
      fix: 'Re-seed the built-in roles from the panel (Application → Organizations → Roles).',
    });
  },

  /**
   * Seed the three built-ins. Idempotent, and safe to call inside an existing
   * transaction. `applicationsService.create` passes its `tx` so a new
   * Application and its role catalog commit together or not at all.
   */
  async seedBuiltIns(
    tx: Prisma.TransactionClient,
    applicationId: string,
  ): Promise<void> {
    for (const r of BUILT_IN_ROLES) {
      await tx.organizationRoleDef.upsert({
        where: { applicationId_name: { applicationId, name: r.name } },
        create: {
          applicationId,
          name: r.name,
          description: r.description,
          baseRole: r.baseRole,
          isDefault: r.isDefault,
          isBuiltIn: true,
        },
        update: {},
      });
    }
    // A fresh Application cannot have a cached snapshot, but a repair path
    // calling this on an existing one can, and an empty snapshot would make
    // `getDefault` throw NO_ORGANIZATION_ROLES right after seeding.
    invalidateOrganizationRoles(applicationId);
  },

  async create(input: {
    applicationId: string;
    name: string;
    description?: string;
    baseRole: OrganizationBaseRole;
    isDefault?: boolean;
  }): Promise<OrganizationRoleDto> {
    const name = input.name.trim();
    if (BUILT_IN_NAMES.has(name.toUpperCase())) {
      throw new RekeyError({
        statusCode: 409,
        code: 'ORGANIZATION_ROLE_NAME_RESERVED',
        message: `"${name}" is reserved. OWNER, ADMIN and MEMBER are built in.`,
        fix: 'Pick a distinct name (e.g. "content-manager") and set its baseRole to the tier you want it to inherit.',
      });
    }
    if (!NAME_RE.test(name)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'ORGANIZATION_ROLE_NAME_INVALID',
        message:
          'Role name must be lowercase letters, digits, hyphens, or underscores (2–40 chars, edges alphanumeric).',
        fix: 'Pick a name like "editor" or "content-manager".',
      });
    }
    // Invalidation happens AFTER the transaction commits, never inside it. An
    // invalidate mid-transaction lets a concurrent reader miss, reload the
    // still-uncommitted old rows, and re-cache them for a full TTL, which is
    // strictly worse than not invalidating at all.
    const created = await prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.organizationRoleDef.updateMany({
          where: { applicationId: input.applicationId, isDefault: true },
          data: { isDefault: false },
        });
      }
      try {
        const row = await tx.organizationRoleDef.create({
          data: {
            applicationId: input.applicationId,
            name,
            ...(input.description !== undefined && { description: input.description }),
            baseRole: input.baseRole,
            isDefault: input.isDefault ?? false,
            isBuiltIn: false,
          },
        });
        return row;
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') {
          throw new RekeyError({
            statusCode: 409,
            code: 'ORGANIZATION_ROLE_NAME_TAKEN',
            message: `Organization role "${name}" already exists for this Application.`,
            fix: 'Pick a different name or edit the existing role.',
          });
        }
        throw e;
      }
    });
    invalidateOrganizationRoles(input.applicationId);
    return shape(created);
  },

  /**
   * Update a role's description, base tier, or default flag. The NAME is
   * immutable, because memberships reference it by value and a rename would
   * silently orphan every row holding it. Delete-with-reassign is the rename path.
   *
   * Re-tiering a built-in is refused: dropping OWNER to ADMIN would strip
   * ownership authority from every org in the Application at once.
   */
  async update(args: {
    applicationId: string;
    name: string;
    description?: string | null;
    baseRole?: OrganizationBaseRole;
    isDefault?: boolean;
    /** Revoke (or restore) every holder's ability to act. */
    disabled?: boolean;
  }): Promise<OrganizationRoleDto> {
    const role = await prisma.organizationRoleDef.findUnique({
      where: { applicationId_name: { applicationId: args.applicationId, name: args.name } },
    });
    if (!role) {
      throw new RekeyError({
        statusCode: 404,
        code: 'ORGANIZATION_ROLE_NOT_FOUND',
        message: `Organization role "${args.name}" not found.`,
        fix: 'List roles to confirm the name.',
      });
    }
    if (role.isBuiltIn && args.baseRole !== undefined && args.baseRole !== role.baseRole) {
      throw new RekeyError({
        statusCode: 400,
        code: 'ORGANIZATION_ROLE_BUILT_IN_IMMUTABLE',
        message: `Cannot change the base tier of the built-in role "${role.name}".`,
        fix: 'Create a custom role with the tier you want instead; built-in tiers are what the last-OWNER guard and billing gates rely on.',
      });
    }
    // Moving a role OUT of the OWNER tier is the same act as reassigning its
    // holders down a tier, and it has the same consequence: any organization
    // whose only owner holds this name is left with nobody who can manage
    // members, transfer ownership, or authorize an org-scoped billing write.
    // `remove` already refuses that (ORGANIZATION_ROLE_REASSIGN_DEMOTES_OWNER);
    // this path reached the same outcome unguarded, and the per-member
    // last-OWNER guard never runs here because no membership row is touched.
    const losesOwnerAuthority =
      role.baseRole === 'OWNER' &&
      ((args.baseRole !== undefined && args.baseRole !== 'OWNER') ||
        (args.disabled === true && !role.disabled));
    if (losesOwnerAuthority) {
      // Disabling an OWNER-tier role strands an organization exactly like
      // re-tiering it down does: nobody left who can manage members, transfer
      // ownership, or authorize a charge, and no way to fix it from inside.
      // Same guard, both doors.
      const orphaned = await this.organizationsLeftWithoutOwner(args.applicationId, role.name);
      if (orphaned > 0) {
        const verb = args.disabled === true ? 'disable' : 'move off the OWNER tier';
        throw new RekeyError({
          statusCode: 409,
          code: 'ORGANIZATION_ROLE_RETIER_ORPHANS_OWNERS',
          message: `Cannot ${verb} "${role.name}": ${orphaned} organization${orphaned === 1 ? '' : 's'} would be left with no owner.`,
          fix: 'Give those organizations another OWNER-tier member first, or create a second OWNER-tier role and move them to it.',
        });
      }
    }
    const updated = await prisma.$transaction(async (tx) => {
      if (args.isDefault === true && !role.isDefault) {
        await tx.organizationRoleDef.updateMany({
          where: { applicationId: args.applicationId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.organizationRoleDef.update({
        where: { id: role.id },
        data: {
          ...(args.description !== undefined && { description: args.description }),
          ...(args.baseRole !== undefined && { baseRole: args.baseRole }),
          ...(args.isDefault !== undefined && { isDefault: args.isDefault }),
          ...(args.disabled !== undefined && { disabled: args.disabled }),
        },
      });
    });
    invalidateOrganizationRoles(args.applicationId);
    return shape(updated);
  },

  /**
   * How many organizations in this Application would have no OWNER-tier member
   * left if `roleName` stopped carrying OWNER authority.
   *
   * Counts organizations that have at least one member holding `roleName` and
   * no member holding any OTHER owner-tier name, so an org whose owners are
   * split across two owner-tier roles is correctly not counted.
   */
  async organizationsLeftWithoutOwner(applicationId: string, roleName: string): Promise<number> {
    // `ownerRoleNames` already excludes disabled roles, so a disabled OWNER-tier
    // role does not count as somebody else's rescue.
    const otherOwnerNames = (await this.ownerRoleNames(applicationId)).filter(
      (n) => n !== roleName,
    );
    const affected = await prisma.organizationMembership.findMany({
      where: { role: roleName, organization: { applicationId } },
      select: { organizationId: true },
      distinct: ['organizationId'],
    });
    if (affected.length === 0) return 0;
    const organizationIds = affected.map((a) => a.organizationId);
    // Organizations among those that still have an owner by some other name.
    const stillOwned = await prisma.organizationMembership.findMany({
      where: { organizationId: { in: organizationIds }, role: { in: otherOwnerNames } },
      select: { organizationId: true },
      distinct: ['organizationId'],
    });
    const safe = new Set(stillOwned.map((s) => s.organizationId));
    return organizationIds.filter((id) => !safe.has(id)).length;
  },

  /**
   * Delete a custom role.
   *
   * Refuses on built-ins, on the default role, and, unless `reassignTo` names
   * another catalog role, on any role still held by a membership or named by a
   * live invitation. Reassignment and delete run in one transaction, so no
   * concurrent read can observe a membership pointing at a role that no longer
   * exists.
   *
   * Pending invitations are counted alongside memberships deliberately. An
   * invitation stores the role NAME and is redeemed later; leaving one behind
   * would fail at accept time, long after the operator who deleted the role has
   * moved on.
   */
  async remove(args: {
    applicationId: string;
    name: string;
    reassignTo?: string;
  }): Promise<{ removed: boolean; reassignedMemberships: number; reassignedInvitations: number }> {
    const { applicationId, name, reassignTo } = args;
    const role = await prisma.organizationRoleDef.findUnique({
      where: { applicationId_name: { applicationId, name } },
    });
    if (!role) {
      throw new RekeyError({
        statusCode: 404,
        code: 'ORGANIZATION_ROLE_NOT_FOUND',
        message: `Organization role "${name}" not found.`,
        fix: 'List roles to confirm the name.',
      });
    }
    if (role.isBuiltIn) {
      throw new RekeyError({
        statusCode: 400,
        code: 'ORGANIZATION_ROLE_BUILT_IN_IMMUTABLE',
        message: `Cannot delete the built-in role "${name}".`,
        fix: 'OWNER, ADMIN and MEMBER are permanent. Delete a custom role instead.',
      });
    }
    if (role.isDefault) {
      throw new RekeyError({
        statusCode: 400,
        code: 'ORGANIZATION_ROLE_IS_DEFAULT',
        message: `Cannot delete "${name}". It is the default organization role for this Application.`,
        fix: 'Mark a different role as default first, then delete this one.',
      });
    }
    const orgScope = { organization: { applicationId } };
    const [memberCount, inviteCount] = await Promise.all([
      prisma.organizationMembership.count({ where: { role: name, ...orgScope } }),
      prisma.organizationInvitation.count({
        where: { role: name, acceptedAt: null, revokedAt: null, ...orgScope },
      }),
    ]);
    const inUse = memberCount + inviteCount;
    if (inUse > 0 && !reassignTo) {
      throw new RekeyError({
        statusCode: 400,
        code: 'ORGANIZATION_ROLE_IN_USE',
        message: `Cannot delete "${name}". ${memberCount} membership${memberCount === 1 ? '' : 's'} and ${inviteCount} pending invitation${inviteCount === 1 ? '' : 's'} still reference it.`,
        fix: 'Pass `reassignTo` with the name of another role to bulk-reassign + delete in one shot.',
      });
    }
    if (reassignTo) {
      if (reassignTo === name) {
        throw new RekeyError({
          statusCode: 400,
          code: 'ORGANIZATION_ROLE_REASSIGN_SELF',
          message: 'Cannot reassign to the role being deleted.',
          fix: 'Pick a different `reassignTo` target.',
        });
      }
      const target = await prisma.organizationRoleDef.findUnique({
        where: { applicationId_name: { applicationId, name: reassignTo } },
        select: { baseRole: true },
      });
      if (!target) {
        throw new RekeyError({
          statusCode: 400,
          code: 'ORGANIZATION_ROLE_REASSIGN_TARGET_UNKNOWN',
          message: `Target role "${reassignTo}" doesn't exist in this Application.`,
          fix: 'Pick an existing role from the catalog.',
        });
      }
      // Reassigning OWNER-tier holders down a tier would empty orgs of their
      // only owner without ever passing through the last-OWNER guard (that
      // guard sits on the per-member routes, not here). Refuse rather than
      // silently orphan every organization that used this role.
      if (role.baseRole === 'OWNER' && target.baseRole !== 'OWNER') {
        throw new RekeyError({
          statusCode: 400,
          code: 'ORGANIZATION_ROLE_REASSIGN_DEMOTES_OWNER',
          message: `"${name}" carries OWNER authority and "${reassignTo}" does not, so reassigning would leave organizations without an owner.`,
          fix: 'Pick a `reassignTo` role whose baseRole is also OWNER, or move those members individually first.',
        });
      }
    }
    const result = await prisma.$transaction(async (tx) => {
      let reassignedMemberships = 0;
      let reassignedInvitations = 0;
      // Reassign unconditionally when a target was given, rather than gating on
      // the `inUse` counts read above. Those counts were taken OUTSIDE this
      // transaction, so an assignment that commits in between would leave a
      // membership pointing at a name this transaction is about to delete. Such
      // an orphan resolves to MEMBER through `baseRoleOrLeast`, silently
      // demoting the member, and it is invisible to the last-OWNER guard, which
      // matches on owner-tier NAMES. `updateMany` over zero rows is a no-op, so
      // dropping the condition costs nothing and closes the window.
      if (reassignTo) {
        const m = await tx.organizationMembership.updateMany({
          where: { role: name, ...orgScope },
          data: { role: reassignTo },
        });
        reassignedMemberships = m.count;
        const i = await tx.organizationInvitation.updateMany({
          where: { role: name, acceptedAt: null, revokedAt: null, ...orgScope },
          data: { role: reassignTo },
        });
        reassignedInvitations = i.count;
      } else {
        // No reassign target: re-check inside the transaction that the role is
        // still unheld, so a concurrent assignment turns into a refusal rather
        // than an orphan.
        const [m, i] = await Promise.all([
          tx.organizationMembership.count({ where: { role: name, ...orgScope } }),
          tx.organizationInvitation.count({
            where: { role: name, acceptedAt: null, revokedAt: null, ...orgScope },
          }),
        ]);
        if (m + i > 0) {
          throw new RekeyError({
            statusCode: 400,
            code: 'ORGANIZATION_ROLE_IN_USE',
            message: `Cannot delete "${name}". ${m} membership${m === 1 ? '' : 's'} and ${i} pending invitation${i === 1 ? '' : 's'} still reference it.`,
            fix: 'Pass `reassignTo` with the name of another role to bulk-reassign + delete in one shot.',
          });
        }
      }
      await tx.organizationRoleDef.delete({ where: { id: role.id } });
      return { removed: true as const, reassignedMemberships, reassignedInvitations };
    });
    invalidateOrganizationRoles(applicationId);
    return result;
  },
};
