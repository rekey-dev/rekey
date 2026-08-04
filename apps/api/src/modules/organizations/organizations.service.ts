/**
 * End-user organizations / teams.
 *
 * Mirrors the operator-side workspace model (`tenant-workspaces`) but
 * scoped *inside* an Application — distinct hierarchy:
 *
 *   Application
 *     └─ Organization (this module)
 *          └─ OrganizationMembership[]  (which EndUsers belong, with role)
 *          └─ OrganizationInvitation[]  (pending invites)
 *
 * Role rules (intentionally close to Clerk's contract):
 *   - OWNER: invite anyone, change anyone's role, remove anyone, transfer
 *     ownership. There must always be at least one OWNER per Org.
 *   - ADMIN: manage anyone below OWNER — so ADMINs can add, re-role and remove
 *     other ADMINs as well as MEMBERs (see `canManage`).
 *   - MEMBER: read-only.
 *
 * `authConfig.organizationsEnabled` gates org **creation** only
 * (`ensureOrgsEnabled` has one call site, in `create`). Turning the toggle off
 * does not freeze existing orgs: invitations can still be minted and accepted,
 * roles changed, members removed. That is deliberate — an operator disabling the
 * feature still needs to wind existing teams down — but it means this is not a
 * kill-switch, so don't rely on it to stop membership churn.
 *
 * The active organization for a session is carried on the `eu_access`
 * JWT as the `oid` claim (mirrors the operator-side `tid`). Users
 * without an active org get `oid: undefined`; switching org re-mints the
 * pair via `/me/organizations/:id/switch`. Invariants are enforced by
 * the service, not the JWT — the middleware re-confirms membership on
 * every request.
 */

import type { Organization, OrganizationMembership, OrganizationRole } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { AuthConfigSchema } from '@rekey.dev/shared-types';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function ensureOrgsEnabled(application: { authConfig: unknown }): void {
  const config = AuthConfigSchema.parse(application.authConfig);
  if (!config.organizationsEnabled) {
    throw new RekeyError({
      statusCode: 400,
      code: 'ORGANIZATIONS_NOT_ENABLED',
      message: 'Organizations are not enabled for this Application.',
      fix: 'Flip `authConfig.organizationsEnabled = true` on the Application (Panel → Application → Auth).',
    });
  }
}

/**
 * Role-level write authorisation. `caller` is the role of the operator
 * making the change; `target` is the role being assigned or removed.
 *
 *   OWNER → can assign/remove any role
 *   ADMIN → can assign/remove MEMBER and ADMIN only
 *   MEMBER → can do nothing
 */
function canManage(caller: OrganizationRole, target: OrganizationRole): boolean {
  if (caller === 'OWNER') return true;
  if (caller === 'ADMIN') return target !== 'OWNER';
  return false;
}

function hashInviteToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface OrganizationDto {
  id: string;
  applicationId: string;
  name: string;
  slug: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface MembershipDto {
  id: string;
  organizationId: string;
  endUserId: string;
  role: OrganizationRole;
  createdAt: Date;
}

export interface InvitationDto {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

function shape(o: Organization): OrganizationDto {
  return {
    id: o.id,
    applicationId: o.applicationId,
    name: o.name,
    slug: o.slug,
    metadata: o.metadata ?? null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

function shapeMembership(m: OrganizationMembership): MembershipDto {
  return {
    id: m.id,
    organizationId: m.organizationId,
    endUserId: m.endUserId,
    role: m.role,
    createdAt: m.createdAt,
  };
}

export const organizationsService = {
  /**
   * Create a new Organization with the calling EndUser as its OWNER.
   * Atomic — if either the org row or the membership row fails the whole
   * thing rolls back.
   */
  async create(args: {
    application: { id: string; authConfig: unknown };
    creatorEndUserId: string;
    name: string;
    slug: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ organization: OrganizationDto; membership: MembershipDto }> {
    ensureOrgsEnabled(args.application);
    const slug = args.slug.toLowerCase();
    if (!SLUG_RE.test(slug)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'ORGANIZATION_SLUG_INVALID',
        message: `Slug "${args.slug}" must be 1-40 chars of [a-z0-9-], start + end alphanumeric.`,
        fix: 'Use e.g. "acme-prod" or "team-42".',
      });
    }
    try {
      return await prisma.$transaction(async (tx) => {
        const org = await tx.organization.create({
          data: {
            applicationId: args.application.id,
            name: args.name,
            slug,
            ...(args.metadata !== undefined && { metadata: args.metadata as never }),
          },
        });
        const membership = await tx.organizationMembership.create({
          data: {
            organizationId: org.id,
            endUserId: args.creatorEndUserId,
            role: 'OWNER',
          },
        });
        return { organization: shape(org), membership: shapeMembership(membership) };
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new RekeyError({
          statusCode: 409,
          code: 'ORGANIZATION_SLUG_TAKEN',
          message: `An organization with slug "${slug}" already exists in this application.`,
          fix: 'Pick a different slug.',
        });
      }
      throw e;
    }
  },

  /** List organizations the caller is a member of (within their Application). */
  async listMine(args: {
    application: { id: string };
    endUserId: string;
    take?: number;
    skip?: number;
  }): Promise<Array<OrganizationDto & { role: OrganizationRole }>> {
    const rows = await prisma.organizationMembership.findMany({
      where: { endUserId: args.endUserId, organization: { applicationId: args.application.id } },
      include: { organization: true },
      orderBy: { createdAt: 'asc' },
      ...(args.take !== undefined ? { take: args.take } : {}),
      ...(args.skip !== undefined ? { skip: args.skip } : {}),
    });
    return rows.map((r) => ({ ...shape(r.organization), role: r.role }));
  },

  /** Total organizations `listMine` would return, ignoring take/skip. */
  async countMine(args: { application: { id: string }; endUserId: string }): Promise<number> {
    return prisma.organizationMembership.count({
      where: { endUserId: args.endUserId, organization: { applicationId: args.application.id } },
    });
  },

  /** Fetch one organization the caller is a member of, or 403 if not a member. */
  async get(args: {
    application: { id: string };
    endUserId: string;
    organizationId: string;
  }): Promise<OrganizationDto & { role: OrganizationRole }> {
    const m = await prisma.organizationMembership.findUnique({
      where: {
        organizationId_endUserId: {
          organizationId: args.organizationId,
          endUserId: args.endUserId,
        },
      },
      include: { organization: true },
    });
    if (!m || m.organization.applicationId !== args.application.id) {
      throw new RekeyError({
        statusCode: 403,
        code: 'ORGANIZATION_NOT_MEMBER',
        message: 'You are not a member of this organization.',
        fix: 'Ask an OWNER for an invitation.',
      });
    }
    return { ...shape(m.organization), role: m.role };
  },

  /** Metadata + name updates. OWNER or ADMIN (see `requireRole` below). */
  async update(args: {
    application: { id: string };
    actorEndUserId: string;
    organizationId: string;
    name?: string;
    metadata?: Record<string, unknown>;
  }): Promise<OrganizationDto> {
    const m = await this.requireRole(args, ['OWNER', 'ADMIN']);
    const updated = await prisma.organization.update({
      where: { id: m.organizationId },
      data: {
        ...(args.name !== undefined && { name: args.name }),
        ...(args.metadata !== undefined && { metadata: args.metadata as never }),
      },
    });
    return shape(updated);
  },

  /** List org members. Any member can list. */
  async listMembers(args: {
    application: { id: string };
    actorEndUserId: string;
    organizationId: string;
    take?: number;
    skip?: number;
  }): Promise<Array<MembershipDto & { email: string }>> {
    await this.requireMembership(args);
    const rows = await prisma.organizationMembership.findMany({
      where: { organizationId: args.organizationId },
      include: { endUser: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
      ...(args.take !== undefined ? { take: args.take } : {}),
      ...(args.skip !== undefined ? { skip: args.skip } : {}),
    });
    return rows.map((r) => ({ ...shapeMembership(r), email: r.endUser.email }));
  },

  /**
   * Total members of an org, ignoring take/skip.
   *
   * Runs the same `requireMembership` gate as `listMembers` rather than
   * trusting the caller to have run it — the two are invoked concurrently
   * from the route, so a count that skipped the check would leak a member
   * tally for an org the caller does not belong to.
   */
  async countMembers(args: {
    application: { id: string };
    actorEndUserId: string;
    organizationId: string;
  }): Promise<number> {
    await this.requireMembership(args);
    return prisma.organizationMembership.count({
      where: { organizationId: args.organizationId },
    });
  },

  /**
   * Create an invitation. Hash-only storage; raw shown once.
   * Caller's role must `canManage` the target role.
   */
  async createInvitation(args: {
    application: { id: string };
    actorEndUserId: string;
    organizationId: string;
    email: string;
    role: OrganizationRole;
  }): Promise<{ rawToken: string; invitation: InvitationDto }> {
    const actor = await this.requireMembership(args);
    if (!canManage(actor.role, args.role)) {
      throw new RekeyError({
        statusCode: 403,
        code: 'ORGANIZATION_ROLE_INSUFFICIENT',
        message: `Your role (${actor.role}) cannot invite to ${args.role}.`,
        fix: 'Ask an OWNER (or any role greater-than-or-equal to the target).',
      });
    }
    const email = args.email.toLowerCase();
    // Block invite to an already-member.
    const existing = await prisma.organizationMembership.findFirst({
      where: { organizationId: args.organizationId, endUser: { email } },
    });
    if (existing) {
      throw new RekeyError({
        statusCode: 409,
        code: 'ORGANIZATION_ALREADY_MEMBER',
        message: `${email} is already a member of this organization.`,
        fix: 'Use change-role on the existing membership instead.',
      });
    }
    const raw = randomBytes(32).toString('base64url');
    const invitation = await prisma.organizationInvitation.create({
      data: {
        organizationId: args.organizationId,
        email,
        role: args.role,
        tokenHash: hashInviteToken(raw),
        expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS),
        invitedById: args.actorEndUserId,
      },
    });
    return { rawToken: raw, invitation: shapeInvitation(invitation) };
  },

  /**
   * Accept an invitation. Caller must be authenticated — we use their EndUser
   * id for the membership row — and their email must MATCH the address the
   * invitation was issued to.
   *
   * That binding used to be absent, on the reasoning that "the customer's app
   * can decide whether to gate accept on email match. (Most apps do — at the
   * UI layer.)" Both halves were wrong. A UI-layer check is not a check: the
   * token travels by email, Slack, or text and the accept endpoint is reachable
   * with any authenticated session, so anyone who obtains a forwarded or leaked
   * invite link joins the organization at the invited role — up to OWNER, which
   * is organization takeover. And it is not the customer's decision to make,
   * because there is no field they can send to turn it on.
   *
   * The operator twin (`tenantWorkspacesService.acceptInvitation`) has enforced
   * this all along and names the same attack in its own comment. This is that
   * check, ported: same 403, same reasoning, one surface behind.
   *
   * **User-visible contract change.** An accept by a session whose email
   * differs from the invited address now answers 403
   * ORGANIZATION_INVITATION_EMAIL_MISMATCH instead of silently succeeding.
   * Integrations that invite `a@x.com` and accept as `b@x.com` will break, and
   * that is the point — they were relying on the hole.
   */
  async acceptInvitation(args: {
    application: { id: string };
    actorEndUserId: string;
    rawToken: string;
  }): Promise<MembershipDto> {
    const tokenHash = hashInviteToken(args.rawToken);
    return prisma.$transaction(async (tx) => {
      const inv = await tx.organizationInvitation.findUnique({
        where: { tokenHash },
        include: { organization: true },
      });
      if (!inv || inv.revokedAt || inv.acceptedAt) {
        throw new RekeyError({
          statusCode: 400,
          code: 'ORGANIZATION_INVITATION_NOT_USABLE',
          message: 'Invitation is missing, revoked, or already accepted.',
          fix: 'Ask an OWNER / ADMIN for a fresh invite.',
        });
      }
      if (inv.expiresAt <= new Date()) {
        throw new RekeyError({
          statusCode: 400,
          code: 'ORGANIZATION_INVITATION_EXPIRED',
          message: 'Invitation has expired.',
          fix: 'Ask an OWNER / ADMIN for a fresh invite.',
        });
      }
      if (inv.organization.applicationId !== args.application.id) {
        // Cross-Application: this invitation belongs to a different App.
        throw new RekeyError({
          statusCode: 401,
          code: 'ORGANIZATION_INVITATION_WRONG_APPLICATION',
          message: 'This invitation belongs to a different application.',
          fix: 'Use the secret key for the Application this invitation was created under.',
        });
      }
      // Bind the invitation to the address it was issued to. Checked AFTER the
      // Application scope so a token from another App still reports the
      // cross-Application error rather than leaking whose address it names.
      const accepting = await tx.endUser.findUniqueOrThrow({
        where: { id: args.actorEndUserId },
        select: { email: true },
      });
      if (accepting.email.toLowerCase() !== inv.email.toLowerCase()) {
        throw new RekeyError({
          statusCode: 403,
          code: 'ORGANIZATION_INVITATION_EMAIL_MISMATCH',
          message: 'This invitation was issued to a different email address.',
          fix: 'Sign in as the invited address, then accept — or ask an OWNER / ADMIN to re-invite the address you are signed in as.',
        });
      }
      // Idempotent member-already-joined check (concurrent accept retry).
      const existing = await tx.organizationMembership.findUnique({
        where: {
          organizationId_endUserId: {
            organizationId: inv.organizationId,
            endUserId: args.actorEndUserId,
          },
        },
      });
      let membership: OrganizationMembership;
      if (existing) {
        membership = existing;
      } else {
        try {
          membership = await tx.organizationMembership.create({
            data: {
              organizationId: inv.organizationId,
              endUserId: args.actorEndUserId,
              role: inv.role,
            },
          });
        } catch (e) {
          if ((e as { code?: string }).code === 'P2002') {
            membership = await tx.organizationMembership.findUniqueOrThrow({
              where: {
                organizationId_endUserId: {
                  organizationId: inv.organizationId,
                  endUserId: args.actorEndUserId,
                },
              },
            });
          } else {
            throw e;
          }
        }
      }
      await tx.organizationInvitation.update({
        where: { id: inv.id },
        data: { acceptedAt: new Date(), acceptedById: args.actorEndUserId },
      });
      return shapeMembership(membership);
    });
  },

  /** OWNER/ADMIN-only invitation revoke. Idempotent. */
  async revokeInvitation(args: {
    application: { id: string };
    actorEndUserId: string;
    organizationId: string;
    invitationId: string;
  }): Promise<{ revoked: boolean }> {
    await this.requireRole({ ...args }, ['OWNER', 'ADMIN']);
    const inv = await prisma.organizationInvitation.findUnique({
      where: { id: args.invitationId },
    });
    if (!inv || inv.organizationId !== args.organizationId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'ORGANIZATION_INVITATION_NOT_FOUND',
        message: 'Invitation not found.',
        fix: 'List invitations to confirm the id.',
      });
    }
    if (inv.revokedAt || inv.acceptedAt) {
      return { revoked: false };
    }
    await prisma.organizationInvitation.update({
      where: { id: inv.id },
      data: { revokedAt: new Date() },
    });
    return { revoked: true };
  },

  /**
   * Change a member's role. Caller must `canManage` BOTH the current and
   * target role. Refuses to downgrade the only OWNER (would orphan the org).
   */
  async setMemberRole(args: {
    application: { id: string };
    actorEndUserId: string;
    organizationId: string;
    targetEndUserId: string;
    newRole: OrganizationRole;
  }): Promise<MembershipDto> {
    const actor = await this.requireMembership(args);
    const target = await prisma.organizationMembership.findUnique({
      where: {
        organizationId_endUserId: {
          organizationId: args.organizationId,
          endUserId: args.targetEndUserId,
        },
      },
    });
    if (!target) {
      throw new RekeyError({
        statusCode: 404,
        code: 'ORGANIZATION_MEMBER_NOT_FOUND',
        message: 'That user is not a member of this organization.',
        fix: 'List members to confirm.',
      });
    }
    if (!canManage(actor.role, target.role) || !canManage(actor.role, args.newRole)) {
      throw new RekeyError({
        statusCode: 403,
        code: 'ORGANIZATION_ROLE_INSUFFICIENT',
        message: `Your role (${actor.role}) cannot change a ${target.role} to ${args.newRole}.`,
        fix: 'OWNER role can manage anyone; ADMIN can manage MEMBER/ADMIN only.',
      });
    }
    if (target.role === 'OWNER' && args.newRole !== 'OWNER') {
      // Last-OWNER guard: refuse if no other OWNER exists.
      const owners = await prisma.organizationMembership.count({
        where: { organizationId: args.organizationId, role: 'OWNER' },
      });
      if (owners <= 1) {
        throw new RekeyError({
          statusCode: 409,
          code: 'ORGANIZATION_LAST_OWNER',
          message: 'Cannot demote the last OWNER. Promote another member to OWNER first.',
          fix: 'Pick another member, set their role to OWNER, then retry this change.',
        });
      }
    }
    const updated = await prisma.organizationMembership.update({
      where: {
        organizationId_endUserId: {
          organizationId: args.organizationId,
          endUserId: args.targetEndUserId,
        },
      },
      data: { role: args.newRole },
    });
    return shapeMembership(updated);
  },

  /**
   * Remove a member. Caller must `canManage` the target's role. Cannot
   * remove the last OWNER.
   */
  async removeMember(args: {
    application: { id: string };
    actorEndUserId: string;
    organizationId: string;
    targetEndUserId: string;
  }): Promise<{ removed: boolean }> {
    const actor = await this.requireMembership(args);
    const target = await prisma.organizationMembership.findUnique({
      where: {
        organizationId_endUserId: {
          organizationId: args.organizationId,
          endUserId: args.targetEndUserId,
        },
      },
    });
    if (!target) return { removed: false };
    if (!canManage(actor.role, target.role) && actor.endUserId !== target.endUserId) {
      // Self-removal is allowed (= "leave org"); otherwise enforce the
      // role hierarchy.
      throw new RekeyError({
        statusCode: 403,
        code: 'ORGANIZATION_ROLE_INSUFFICIENT',
        message: `Your role (${actor.role}) cannot remove a ${target.role}.`,
        fix: 'Self-removal is always allowed; otherwise OWNER manages anyone, ADMIN manages MEMBER.',
      });
    }
    if (target.role === 'OWNER') {
      const owners = await prisma.organizationMembership.count({
        where: { organizationId: args.organizationId, role: 'OWNER' },
      });
      if (owners <= 1) {
        throw new RekeyError({
          statusCode: 409,
          code: 'ORGANIZATION_LAST_OWNER',
          message: 'Cannot remove the last OWNER. Transfer ownership first.',
          fix: 'Promote another member to OWNER before leaving or being removed.',
        });
      }
    }
    await prisma.organizationMembership.delete({
      where: {
        organizationId_endUserId: {
          organizationId: args.organizationId,
          endUserId: args.targetEndUserId,
        },
      },
    });
    return { removed: true };
  },

  /**
   * Caller self-leaves. An OWNER cannot leave: billing (payment + benefits) is
   * tied to the owner, and ownership transfer is operator-only (via the Panel /
   * support — see decisions 2026-05-27 22:55). A co-owner must demote themselves
   * to ADMIN first; a sole owner must have support re-point ownership. Non-owners
   * leave via removeMember (which keeps the last-OWNER guard for the admin path).
   */
  async leave(args: {
    application: { id: string };
    actorEndUserId: string;
    organizationId: string;
  }): Promise<{ removed: boolean }> {
    const membership = await this.requireMembership(args);
    if (membership.role === 'OWNER') {
      throw new RekeyError({
        statusCode: 409,
        code: 'ORGANIZATION_OWNER_CANNOT_LEAVE',
        message: 'An OWNER cannot leave — payment and benefits are tied to the owner.',
        fix: 'Transfer ownership first (via the Panel / Rekey support), or demote yourself to ADMIN if there is another OWNER.',
      });
    }
    return this.removeMember({
      application: args.application,
      actorEndUserId: args.actorEndUserId,
      organizationId: args.organizationId,
      targetEndUserId: args.actorEndUserId,
    });
  },

  /**
   * Internal — assert the caller is a member of the org under the given
   * Application. Returns the membership row (with role) on success.
   */
  async requireMembership(args: {
    application: { id: string };
    actorEndUserId: string;
    organizationId: string;
  }): Promise<OrganizationMembership> {
    const m = await prisma.organizationMembership.findUnique({
      where: {
        organizationId_endUserId: {
          organizationId: args.organizationId,
          endUserId: args.actorEndUserId,
        },
      },
      include: { organization: true },
    });
    if (!m || m.organization.applicationId !== args.application.id) {
      throw new RekeyError({
        statusCode: 403,
        code: 'ORGANIZATION_NOT_MEMBER',
        message: 'You are not a member of this organization.',
        fix: 'Ask an OWNER for an invitation.',
      });
    }
    return m;
  },

  /**
   * Non-throwing membership check. Returns true iff the end-user is a member of
   * the org under this Application. Used to *default* a subject to the session's
   * active org without 403-ing when membership lapsed (the explicit
   * `?organizationId=` path still uses `requireMembership`).
   */
  async isMember(args: {
    applicationId: string;
    endUserId: string;
    organizationId: string;
  }): Promise<boolean> {
    const m = await prisma.organizationMembership.findUnique({
      where: {
        organizationId_endUserId: { organizationId: args.organizationId, endUserId: args.endUserId },
      },
      include: { organization: { select: { applicationId: true } } },
    });
    return !!m && m.organization.applicationId === args.applicationId;
  },

  /** Internal — assert the caller's role is in `allowed`. */
  async requireRole(
    args: {
      application: { id: string };
      actorEndUserId: string;
      organizationId: string;
    },
    allowed: ReadonlyArray<OrganizationRole>,
  ): Promise<OrganizationMembership> {
    const m = await this.requireMembership(args);
    if (!allowed.includes(m.role)) {
      throw new RekeyError({
        statusCode: 403,
        code: 'ORGANIZATION_ROLE_INSUFFICIENT',
        message: `This action requires one of: ${allowed.join(', ')}. Your role: ${m.role}.`,
        fix: 'Ask an OWNER (or any role with greater authority).',
      });
    }
    return m;
  },

  // ---------------------------------------------------------------------------
  // Operator / admin surface (panel).
  //
  // Scoped by `applicationId` ONLY — there is no membership requirement
  // because the operator owns the Application, not the org. The end-user
  // CRUD above always proves membership; these methods deliberately don't.
  //
  // Intentionally NOT gated by `organizationsEnabled`: an operator may need
  // to inspect or clean up orgs that were created before the feature was
  // toggled off. The end-user-facing mutating routes stay gated.
  // ---------------------------------------------------------------------------

  /** List every org in an Application with member + pending-invite counts. */
  async adminList(args: {
    applicationId: string;
    take?: number;
    skip?: number;
  }): Promise<Array<OrganizationDto & { memberCount: number; pendingInvitationCount: number }>> {
    const rows = await prisma.organization.findMany({
      where: { applicationId: args.applicationId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            memberships: true,
            invitations: { where: { acceptedAt: null, revokedAt: null } },
          },
        },
      },
      ...(args.take !== undefined ? { take: args.take } : {}),
      ...(args.skip !== undefined ? { skip: args.skip } : {}),
    });
    return rows.map((r) => ({
      ...shape(r),
      memberCount: r._count.memberships,
      pendingInvitationCount: r._count.invitations,
    }));
  },

  /** Total organizations in an Application, ignoring take/skip. */
  async adminCount(args: { applicationId: string }): Promise<number> {
    return prisma.organization.count({ where: { applicationId: args.applicationId } });
  },

  /** Full operator view of one org: members (with email) + pending invitations. */
  async adminGet(args: {
    applicationId: string;
    organizationId: string;
  }): Promise<{
    organization: OrganizationDto;
    members: Array<MembershipDto & { email: string }>;
    invitations: InvitationDto[];
  }> {
    const org = await this.adminLoadOrThrow(args);
    const [members, invitations] = await Promise.all([
      prisma.organizationMembership.findMany({
        where: { organizationId: org.id },
        include: { endUser: { select: { email: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.organizationInvitation.findMany({
        where: { organizationId: org.id, acceptedAt: null, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      organization: shape(org),
      members: members.map((m) => ({ ...shapeMembership(m), email: m.endUser.email })),
      invitations: invitations.map(shapeInvitation),
    };
  },

  /**
   * Operator hard-delete of an org (moderation / cleanup). Cascades to
   * memberships + invitations via the schema's `onDelete: Cascade`.
   */
  async adminDelete(args: {
    applicationId: string;
    organizationId: string;
  }): Promise<{ deleted: boolean }> {
    const org = await this.adminLoadOrThrow(args);
    await prisma.organization.delete({ where: { id: org.id } });
    return { deleted: true };
  },

  /** Internal — load an org and assert it belongs to the Application, else 404. */
  async adminLoadOrThrow(args: {
    applicationId: string;
    organizationId: string;
  }): Promise<Organization> {
    const org = await prisma.organization.findUnique({ where: { id: args.organizationId } });
    if (!org || org.applicationId !== args.applicationId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'ORGANIZATION_NOT_FOUND',
        message: `Organization "${args.organizationId}" not found in this application.`,
        fix: 'List organizations to confirm the id.',
      });
    }
    return org;
  },

  /**
   * Operator-create an organization (no end-user caller). Optionally seed an
   * initial OWNER from an existing end-user of the app. Unlike the end-user
   * `create`, this assigns no caller membership and applies no role checks —
   * the operator is the app's administrator.
   */
  async adminCreate(args: {
    applicationId: string;
    name: string;
    slug: string;
    metadata?: Record<string, unknown>;
    ownerEndUserId?: string;
  }): Promise<OrganizationDto> {
    const slug = args.slug.toLowerCase();
    if (!SLUG_RE.test(slug)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'ORGANIZATION_SLUG_INVALID',
        message: `Slug "${args.slug}" must be 1-40 chars of [a-z0-9-], start + end alphanumeric.`,
        fix: 'Use e.g. "acme-prod" or "team-42".',
      });
    }
    if (args.ownerEndUserId) {
      await this.adminAssertEndUserInApp(args.applicationId, args.ownerEndUserId);
    }
    try {
      const org = await prisma.$transaction(async (tx) => {
        const created = await tx.organization.create({
          data: {
            applicationId: args.applicationId,
            name: args.name,
            slug,
            ...(args.metadata !== undefined && { metadata: args.metadata as never }),
          },
        });
        if (args.ownerEndUserId) {
          await tx.organizationMembership.create({
            data: { organizationId: created.id, endUserId: args.ownerEndUserId, role: 'OWNER' },
          });
        }
        return created;
      });
      return shape(org);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new RekeyError({
          statusCode: 409,
          code: 'ORGANIZATION_SLUG_TAKEN',
          message: `An organization with slug "${slug}" already exists in this application.`,
          fix: 'Pick a different slug.',
        });
      }
      throw e;
    }
  },

  /** Operator update of org name / metadata. */
  async adminUpdate(args: {
    applicationId: string;
    organizationId: string;
    name?: string;
    metadata?: Record<string, unknown>;
  }): Promise<OrganizationDto> {
    const org = await this.adminLoadOrThrow(args);
    const updated = await prisma.organization.update({
      where: { id: org.id },
      data: {
        ...(args.name !== undefined && { name: args.name }),
        ...(args.metadata !== undefined && { metadata: args.metadata as never }),
      },
    });
    return shape(updated);
  },

  /**
   * Operator add-member. Validates the end-user belongs to the app and isn't
   * already a member. No role-hierarchy check (operator authority).
   */
  async adminAddMember(args: {
    applicationId: string;
    organizationId: string;
    endUserId: string;
    role: OrganizationRole;
  }): Promise<MembershipDto & { email: string }> {
    await this.adminLoadOrThrow(args);
    const endUser = await this.adminAssertEndUserInApp(args.applicationId, args.endUserId);
    try {
      const m = await prisma.organizationMembership.create({
        data: {
          organizationId: args.organizationId,
          endUserId: args.endUserId,
          role: args.role,
        },
      });
      return { ...shapeMembership(m), email: endUser.email };
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new RekeyError({
          statusCode: 409,
          code: 'ORGANIZATION_ALREADY_MEMBER',
          message: 'That end-user is already a member of this organization.',
          fix: 'Use change-role on the existing membership instead.',
        });
      }
      throw e;
    }
  },

  /** Operator change a member's role. */
  async adminSetMemberRole(args: {
    applicationId: string;
    organizationId: string;
    endUserId: string;
    role: OrganizationRole;
  }): Promise<MembershipDto> {
    await this.adminLoadOrThrow(args);
    const existing = await prisma.organizationMembership.findUnique({
      where: {
        organizationId_endUserId: {
          organizationId: args.organizationId,
          endUserId: args.endUserId,
        },
      },
    });
    if (!existing) {
      throw new RekeyError({
        statusCode: 404,
        code: 'ORGANIZATION_MEMBER_NOT_FOUND',
        message: 'That end-user is not a member of this organization.',
        fix: 'Add them as a member first.',
      });
    }
    const updated = await prisma.organizationMembership.update({
      where: {
        organizationId_endUserId: {
          organizationId: args.organizationId,
          endUserId: args.endUserId,
        },
      },
      data: { role: args.role },
    });
    return shapeMembership(updated);
  },

  /** Operator remove a member. Idempotent. */
  async adminRemoveMember(args: {
    applicationId: string;
    organizationId: string;
    endUserId: string;
  }): Promise<{ removed: boolean }> {
    await this.adminLoadOrThrow(args);
    try {
      await prisma.organizationMembership.delete({
        where: {
          organizationId_endUserId: {
            organizationId: args.organizationId,
            endUserId: args.endUserId,
          },
        },
      });
      return { removed: true };
    } catch (e) {
      if ((e as { code?: string }).code === 'P2025') return { removed: false }; // already gone
      throw e;
    }
  },

  /** Internal — assert an end-user exists and belongs to the Application. */
  async adminAssertEndUserInApp(
    applicationId: string,
    endUserId: string,
  ): Promise<{ id: string; email: string }> {
    const eu = await prisma.endUser.findUnique({
      where: { id: endUserId },
      select: { id: true, email: true, applicationId: true },
    });
    if (!eu || eu.applicationId !== applicationId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'END_USER_NOT_FOUND',
        message: `End-user "${endUserId}" not found in this application.`,
        fix: 'List end-users to confirm the id.',
      });
    }
    return { id: eu.id, email: eu.email };
  },
};

function shapeInvitation(i: {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationRole;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}): InvitationDto {
  return {
    id: i.id,
    organizationId: i.organizationId,
    email: i.email,
    role: i.role,
    expiresAt: i.expiresAt,
    acceptedAt: i.acceptedAt,
    revokedAt: i.revokedAt,
    createdAt: i.createdAt,
  };
}
