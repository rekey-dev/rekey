/**
 * Workspace member + invitation management.
 *
 * Invitations are unique-per-recipient single-use links with an expiry
 * (7 days default). The owner generates an invite, gets the raw token
 * exactly once, and shares the URL `/accept-invite?token=…` via whatever
 * channel they like. The recipient signs in (or signs up first), then
 * POSTs the token to /tenant/invitations/accept.
 *
 * Role rules:
 *   - OWNER: invite anyone in any role, remove anyone, change anyone's
 *     role. There must always be at least one OWNER per Tenant.
 *   - ADMIN: invite, remove and re-role **MEMBERs only**. Anything touching an
 *     ADMIN or an OWNER requires OWNER (`ensureCanManage`) — an ADMIN cannot
 *     invite a second ADMIN, and gets 403 TENANT_ROLE_INSUFFICIENT if they try.
 *     Note this is stricter than the end-user-side `Organization` rules, where an
 *     org ADMIN may manage other ADMINs.
 *   - MEMBER: read-only.
 */

import type {
  ApplicationRole,
  TenantInvitation,
  TenantMembership,
  TenantRole,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import {
  generateInvitationToken,
  hashInvitationToken,
  defaultInvitationExpiry,
} from '../../lib/tenant-invitations.js';
import {
  issueTenantAccessToken,
} from '../../lib/tenant-jwt.js';
import { issueTenantRefreshToken } from '../../lib/tenant-refresh-tokens.js';
import { resolveNewTenantLimits } from '../../lib/tenant-limits.js';
import { env } from '../../config/env.js';
import { emailService } from '../email/email.service.js';
import { buildTokenUrl } from '../../lib/app-url.js';
import { panelBaseUrl } from '../../lib/panel-url.js';

/**
 * Deployment policy for CREATING another workspace (`WORKSPACE_CREATION`).
 *
 * Read live from `process.env` with the boot-validated value as the fallback,
 * matching `operatorSignupMode` — capturing it at module load would make the
 * gate untestable in-process, and an out-of-range live value must never quietly
 * widen the gate, so the boot value (which a typo would have crashed on) wins.
 */
export function workspaceCreationMode(): 'open' | 'disabled' {
  const raw = process.env.WORKSPACE_CREATION;
  return raw === 'open' || raw === 'disabled' ? raw : env.WORKSPACE_CREATION;
}

/**
 * Throw when this deployment does not allow an operator to create another
 * workspace.
 *
 * Why creation and nothing else: a workspace is the unit a deployment sizes
 * itself against (see `DEFAULT_TENANT_LIMITS`), and a ceiling per workspace is
 * worth nothing if any signed-in operator — including someone invited into a
 * team — can mint a fresh workspace with a fresh ceiling. Switching, listing,
 * renaming, leaving and everything else stay open, so an operator who already
 * belongs to several is completely unaffected.
 *
 * Default is 'open', i.e. exactly today's behaviour; a self-host that never
 * sets the variable never sees this.
 */
export function assertWorkspaceCreationAllowed(): void {
  if (workspaceCreationMode() !== 'disabled') return;
  throw new RekeyError({
    statusCode: 403,
    code: 'WORKSPACE_CREATION_DISABLED',
    message: 'Creating additional workspaces is disabled on this deployment.',
    fix:
      'Contact the deployment administrator to have a workspace created for you. ' +
      'Your existing workspaces are unaffected — you can still switch between them, ' +
      'invite members, and manage applications as usual.',
  });
}

export interface MemberGrantRow {
  applicationId: string;
  applicationName: string;
  applicationSlug: string;
  role: ApplicationRole;
  createdAt: Date;
}

export interface MemberRow {
  membershipId: string;
  tenantUserId: string;
  email: string;
  name: string | null;
  role: TenantRole;
  joinedAt: Date;
  /**
   * Per-application grants (roadmap #8). Only meaningful for MEMBER roles —
   * OWNER/ADMIN have implicit access to every Application. A MEMBER with an
   * empty list is in legacy mode: read-only on every Application.
   */
  grants: MemberGrantRow[];
}

export interface InvitationRow {
  id: string;
  email: string;
  role: TenantRole;
  expiresAt: Date;
  createdAt: Date;
  invitedById: string;
  // Status is derived: revoked > accepted > expired > pending.
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
}

function deriveStatus(inv: TenantInvitation): InvitationRow['status'] {
  if (inv.revokedAt) return 'revoked';
  if (inv.acceptedAt) return 'accepted';
  if (inv.expiresAt <= new Date()) return 'expired';
  return 'pending';
}

function shapeInvitation(inv: TenantInvitation): InvitationRow {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role,
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
    invitedById: inv.invitedById,
    status: deriveStatus(inv),
  };
}

/** Permission helper. Throws if `actor` cannot manage `target` role. */
function ensureCanManage(actor: TenantRole, target: TenantRole): void {
  // OWNER can do anything. ADMIN can manage MEMBER only. MEMBER can manage nothing.
  if (actor === 'OWNER') return;
  if (actor === 'ADMIN' && target === 'MEMBER') return;
  throw new RekeyError({
    statusCode: 403,
    code: 'TENANT_ROLE_INSUFFICIENT',
    message: `Your role (${actor}) cannot manage members with role ${target}.`,
    fix: 'Ask an OWNER to perform this action.',
  });
}

export const tenantWorkspacesService = {
  async listMembers(tenantId: string): Promise<MemberRow[]> {
    const rows = await prisma.tenantMembership.findMany({
      where: { tenantId },
      include: {
        tenantUser: { select: { email: true, name: true } },
        applicationGrants: {
          include: { application: { select: { id: true, name: true, slug: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      membershipId: r.id,
      tenantUserId: r.tenantUserId,
      email: r.tenantUser.email,
      name: r.tenantUser.name,
      role: r.role,
      joinedAt: r.createdAt,
      grants: r.applicationGrants.map((g) => ({
        applicationId: g.application.id,
        applicationName: g.application.name,
        applicationSlug: g.application.slug,
        role: g.role,
        createdAt: g.createdAt,
      })),
    }));
  },

  // ---------- Per-application grants (roadmap #8) ----------
  //
  // Grants attach to a MEMBER membership and scope what that member can do
  // per Application. OWNER/ADMIN never need them (implicit full access), so
  // setting one on a non-MEMBER membership is rejected — it would silently
  // do nothing and mislead the operator.

  async loadMembershipOrThrow(tenantId: string, membershipId: string): Promise<TenantMembership> {
    const membership = await prisma.tenantMembership.findUnique({
      where: { id: membershipId },
    });
    if (!membership || membership.tenantId !== tenantId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'MEMBERSHIP_NOT_FOUND',
        message: 'Membership not found in this workspace.',
        fix: 'List members to see what exists.',
      });
    }
    return membership;
  },

  async listMemberGrants(args: {
    tenantId: string;
    membershipId: string;
  }): Promise<MemberGrantRow[]> {
    await this.loadMembershipOrThrow(args.tenantId, args.membershipId);
    const grants = await prisma.applicationGrant.findMany({
      where: { tenantMembershipId: args.membershipId },
      include: { application: { select: { id: true, name: true, slug: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return grants.map((g) => ({
      applicationId: g.application.id,
      applicationName: g.application.name,
      applicationSlug: g.application.slug,
      role: g.role,
      createdAt: g.createdAt,
    }));
  },

  /** Upsert one grant — (membership, application) is unique, so re-setting changes the role. */
  async setMemberGrant(args: {
    tenantId: string;
    membershipId: string;
    applicationId: string;
    role: ApplicationRole;
  }): Promise<MemberGrantRow> {
    const membership = await this.loadMembershipOrThrow(args.tenantId, args.membershipId);
    if (membership.role !== 'MEMBER') {
      throw new RekeyError({
        statusCode: 400,
        code: 'APP_GRANT_MEMBER_ONLY',
        message: `Per-application grants only apply to MEMBER roles — this membership is ${membership.role} and already has full access to every Application.`,
        fix: 'Change the member role to MEMBER first (PATCH /api/v1/tenant/workspace/members/:id), then add grants.',
      });
    }
    const app = await prisma.application.findUnique({
      where: { id: args.applicationId },
      select: { id: true, tenantId: true, name: true, slug: true },
    });
    if (!app || app.tenantId !== args.tenantId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'APPLICATION_NOT_FOUND',
        message: `Application "${args.applicationId}" not found in this workspace.`,
        fix: 'List applications via GET /api/v1/tenant/applications.',
      });
    }
    const grant = await prisma.applicationGrant.upsert({
      where: {
        tenantMembershipId_applicationId: {
          tenantMembershipId: args.membershipId,
          applicationId: args.applicationId,
        },
      },
      create: {
        tenantMembershipId: args.membershipId,
        applicationId: args.applicationId,
        role: args.role,
      },
      update: { role: args.role },
    });
    return {
      applicationId: app.id,
      applicationName: app.name,
      applicationSlug: app.slug,
      role: grant.role,
      createdAt: grant.createdAt,
    };
  },

  async removeMemberGrant(args: {
    tenantId: string;
    membershipId: string;
    applicationId: string;
  }): Promise<void> {
    await this.loadMembershipOrThrow(args.tenantId, args.membershipId);
    const deleted = await prisma.applicationGrant.deleteMany({
      where: { tenantMembershipId: args.membershipId, applicationId: args.applicationId },
    });
    if (deleted.count === 0) {
      throw new RekeyError({
        statusCode: 404,
        code: 'APP_GRANT_NOT_FOUND',
        message: 'No grant for that application on this membership.',
        fix: 'List grants via GET /api/v1/tenant/workspace/members/:membershipId/grants.',
      });
    }
  },

  async listInvitations(tenantId: string): Promise<InvitationRow[]> {
    const rows = await prisma.tenantInvitation.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(shapeInvitation);
  },

  /**
   * Mint a new invitation. Returns the raw token (one-time-show) + the
   * record. Caller is responsible for assembling the share URL —
   * `${PANEL_URL}/accept-invite?token=${raw}`.
   */
  async createInvitation(input: {
    tenantId: string;
    invitedById: string;
    invitedByRole: TenantRole;
    email: string;
    role: TenantRole;
    /** Optional URL with `{token}` substituted in the email body. */
    inviteUrl?: string;
  }): Promise<{
    rawToken: string;
    emailSent: boolean;
    invitation: InvitationRow;
  }> {
    ensureCanManage(input.invitedByRole, input.role);

    const email = input.email.toLowerCase();
    // Block invites to existing members of this workspace — they'd just
    // confuse the recipient.
    const existing = await prisma.tenantMembership.findFirst({
      where: { tenantId: input.tenantId, tenantUser: { email } },
    });
    if (existing) {
      throw new RekeyError({
        statusCode: 409,
        code: 'INVITE_TARGET_ALREADY_MEMBER',
        message: `${email} is already a member of this workspace.`,
        fix: 'No invite needed — they can sign in directly.',
      });
    }

    const rawToken = generateInvitationToken();
    const tokenHash = hashInvitationToken(rawToken);
    const invitation = await prisma.tenantInvitation.create({
      data: {
        tenantId: input.tenantId,
        invitedById: input.invitedById,
        email,
        role: input.role,
        tokenHash,
        expiresAt: defaultInvitationExpiry(),
      },
    });

    // Fetch the inviter + workspace name for the email body.
    const [inviter, tenant] = await Promise.all([
      prisma.tenantUser.findUnique({
        where: { id: input.invitedById },
        select: { name: true, email: true },
      }),
      prisma.tenant.findUnique({
        where: { id: input.tenantId },
        select: { name: true },
      }),
    ]);

    const outcome = await emailService.dispatchSystem({
      eventKey: 'workspace_invitation',
      to: email,
      tenantId: input.tenantId,
      variables: {
        inviteeEmail: email,
        inviterName: inviter?.name ?? inviter?.email ?? 'A teammate',
        workspaceName: tenant?.name ?? 'a workspace',
        // An invitation is an OPERATOR-facing link, so its base is the panel,
        // not a customer app — `panelBaseUrl()` (PANEL_OAUTH_REDIRECT_BASE, or
        // inferred from CORS_ALLOWED_ORIGINS). It used to fall back to the
        // placeholder `your-panel.example.com`, which mailed a live invitation
        // token to a domain nobody owns. Empty now when nothing resolves, and
        // the template drops the button rather than rendering href="".
        inviteUrl: input.inviteUrl
          ? input.inviteUrl.replace('{token}', encodeURIComponent(rawToken))
          : buildTokenUrl(panelBaseUrl(), '/accept-invite', rawToken),
        expiresAtIso: invitation.expiresAt.toISOString(),
      },
    });

    return {
      rawToken,
      emailSent: outcome.kind === 'sent',
      invitation: shapeInvitation(invitation),
    };
  },

  async revokeInvitation(args: {
    tenantId: string;
    invitationId: string;
    actorRole: TenantRole;
  }): Promise<InvitationRow> {
    const inv = await prisma.tenantInvitation.findUnique({
      where: { id: args.invitationId },
    });
    if (!inv || inv.tenantId !== args.tenantId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'INVITATION_NOT_FOUND',
        message: 'Invitation not found in this workspace.',
        fix: 'List invitations to see what exists.',
      });
    }
    ensureCanManage(args.actorRole, inv.role);
    if (inv.acceptedAt) {
      throw new RekeyError({
        statusCode: 400,
        code: 'INVITATION_ALREADY_ACCEPTED',
        message: 'Invitation was already accepted; revoke the resulting membership instead.',
        fix: 'Use DELETE /tenant/workspace/members/:id to remove the member.',
      });
    }
    if (inv.revokedAt) return shapeInvitation(inv);
    const updated = await prisma.tenantInvitation.update({
      where: { id: inv.id },
      data: { revokedAt: new Date() },
    });
    return shapeInvitation(updated);
  },

  /**
   * Look up an invitation by raw token. Used by the panel's accept-invite
   * page to render the workspace name + role *before* the user clicks
   * "accept". Does not consume the token.
   */
  async previewInvitation(rawToken: string): Promise<{
    tenantId: string;
    tenantName: string;
    role: TenantRole;
    invitedEmail: string;
    expiresAt: Date;
  }> {
    const inv = await prisma.tenantInvitation.findUnique({
      where: { tokenHash: hashInvitationToken(rawToken) },
      include: { tenant: { select: { name: true } } },
    });
    if (!inv) {
      throw new RekeyError({
        statusCode: 404,
        code: 'INVITATION_NOT_FOUND',
        message: 'Invitation token is unknown.',
        fix: 'Ask the workspace owner for a fresh invite.',
      });
    }
    if (inv.revokedAt) {
      throw new RekeyError({
        statusCode: 400,
        code: 'INVITATION_REVOKED',
        message: 'This invitation has been revoked.',
        fix: 'Ask the workspace owner for a fresh invite.',
      });
    }
    if (inv.acceptedAt) {
      throw new RekeyError({
        statusCode: 400,
        code: 'INVITATION_ALREADY_ACCEPTED',
        message: 'This invitation has already been used.',
        fix: 'Sign in normally — you should already have access.',
      });
    }
    if (inv.expiresAt <= new Date()) {
      throw new RekeyError({
        statusCode: 400,
        code: 'INVITATION_EXPIRED',
        message: 'This invitation has expired.',
        fix: 'Ask the workspace owner for a fresh invite.',
      });
    }
    return {
      tenantId: inv.tenantId,
      tenantName: inv.tenant.name,
      role: inv.role,
      invitedEmail: inv.email,
      expiresAt: inv.expiresAt,
    };
  },

  /**
   * Accept an invitation: marks it consumed, creates a membership, returns
   * a fresh session scoped to the new workspace.
   */
  async acceptInvitation(args: {
    rawToken: string;
    tenantUserId: string;
  }): Promise<{
    membership: TenantMembership;
    accessToken: string;
    accessTokenExpiresAt: Date;
    refreshToken: string;
    refreshTokenExpiresAt: Date;
  }> {
    const tokenHash = hashInvitationToken(args.rawToken);

    return prisma.$transaction(async (tx) => {
      // Re-check inside txn so concurrent accepts don't both succeed.
      const inv = await tx.tenantInvitation.findUnique({ where: { tokenHash } });
      if (!inv || inv.revokedAt || inv.acceptedAt) {
        throw new RekeyError({
          statusCode: 400,
          code: 'INVITATION_NOT_USABLE',
          message: 'Invitation is missing, revoked, or already accepted.',
          fix: 'Ask the workspace owner for a fresh invite.',
        });
      }
      if (inv.expiresAt <= new Date()) {
        throw new RekeyError({
          statusCode: 400,
          code: 'INVITATION_EXPIRED',
          message: 'Invitation has expired.',
          fix: 'Ask the workspace owner for a fresh invite.',
        });
      }

      // Bind the invitation to the address it was issued to. Without this,
      // anyone who obtains a leaked/forwarded invite link could accept it and
      // join the workspace at the invited role (up to OWNER) = takeover. The
      // accepting session is `args.tenantUserId`; its email must match.
      const accepting = await tx.tenantUser.findUniqueOrThrow({
        where: { id: args.tenantUserId },
      });
      if (accepting.email.toLowerCase() !== inv.email.toLowerCase()) {
        throw new RekeyError({
          statusCode: 403,
          code: 'INVITATION_EMAIL_MISMATCH',
          message: 'This invitation was issued to a different email address.',
          fix: 'Sign in as the invited email, then accept — or ask the workspace owner to re-invite your address.',
        });
      }

      // Already a member somehow? Treat as accept-no-op. The find-then-
      // create has a narrow race window — two concurrent accepts could
      // both miss the find and both try the create. The DB unique
      // constraint catches the loser with P2002; we map that back to
      // "already member" and re-read.
      const existing = await tx.tenantMembership.findUnique({
        where: {
          tenantUserId_tenantId: {
            tenantUserId: args.tenantUserId,
            tenantId: inv.tenantId,
          },
        },
      });
      let membership: TenantMembership;
      if (existing) {
        membership = existing;
      } else {
        try {
          membership = await tx.tenantMembership.create({
            data: {
              tenantUserId: args.tenantUserId,
              tenantId: inv.tenantId,
              role: inv.role,
            },
          });
        } catch (e) {
          if ((e as { code?: string }).code === 'P2002') {
            membership = await tx.tenantMembership.findUniqueOrThrow({
              where: {
                tenantUserId_tenantId: {
                  tenantUserId: args.tenantUserId,
                  tenantId: inv.tenantId,
                },
              },
            });
          } else {
            throw e;
          }
        }
      }

      await tx.tenantInvitation.update({
        where: { id: inv.id },
        data: { acceptedAt: new Date(), acceptedById: args.tenantUserId },
      });

      // Issue a session scoped to the newly-joined workspace so the panel can
      // hop straight in.
      const access = issueTenantAccessToken(args.tenantUserId, inv.tenantId, inv.role);
      const refresh = await issueTenantRefreshToken(args.tenantUserId);
      return {
        membership,
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: refresh.raw,
        refreshTokenExpiresAt: refresh.record.expiresAt,
      };
    });
  },

  /**
   * Remove a member from this workspace. Cannot remove the last OWNER —
   * a workspace always has at least one OWNER.
   */
  async removeMember(args: {
    tenantId: string;
    membershipId: string;
    actorTenantUserId: string;
    actorRole: TenantRole;
  }): Promise<void> {
    const target = await prisma.tenantMembership.findUnique({
      where: { id: args.membershipId },
    });
    if (!target || target.tenantId !== args.tenantId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'MEMBERSHIP_NOT_FOUND',
        message: 'Membership not found in this workspace.',
        fix: 'List members to see what exists.',
      });
    }
    if (target.tenantUserId !== args.actorTenantUserId) {
      ensureCanManage(args.actorRole, target.role);
    }
    if (target.role === 'OWNER') {
      const owners = await prisma.tenantMembership.count({
        where: { tenantId: args.tenantId, role: 'OWNER' },
      });
      if (owners <= 1) {
        throw new RekeyError({
          statusCode: 400,
          code: 'CANNOT_REMOVE_LAST_OWNER',
          message: 'Cannot remove the last OWNER of a workspace.',
          fix: 'Promote another member to OWNER first, or delete the workspace.',
        });
      }
    }
    await prisma.tenantMembership.delete({ where: { id: target.id } });
  },

  async changeMemberRole(args: {
    tenantId: string;
    membershipId: string;
    actorRole: TenantRole;
    newRole: TenantRole;
  }): Promise<MemberRow> {
    const target = await prisma.tenantMembership.findUnique({
      where: { id: args.membershipId },
      include: { tenantUser: { select: { email: true, name: true } } },
    });
    if (!target || target.tenantId !== args.tenantId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'MEMBERSHIP_NOT_FOUND',
        message: 'Membership not found in this workspace.',
        fix: 'List members to see what exists.',
      });
    }
    // Actor must be allowed to manage both the OLD role (downgrade) and the NEW role (promote).
    ensureCanManage(args.actorRole, target.role);
    ensureCanManage(args.actorRole, args.newRole);

    if (target.role === 'OWNER' && args.newRole !== 'OWNER') {
      const owners = await prisma.tenantMembership.count({
        where: { tenantId: args.tenantId, role: 'OWNER' },
      });
      if (owners <= 1) {
        throw new RekeyError({
          statusCode: 400,
          code: 'CANNOT_REMOVE_LAST_OWNER',
          message: 'Cannot demote the last OWNER of a workspace.',
          fix: 'Promote another member to OWNER first.',
        });
      }
    }

    const updated = await prisma.tenantMembership.update({
      where: { id: target.id },
      data: { role: args.newRole },
      include: {
        tenantUser: { select: { email: true, name: true } },
        applicationGrants: {
          include: { application: { select: { id: true, name: true, slug: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return {
      membershipId: updated.id,
      tenantUserId: updated.tenantUserId,
      email: updated.tenantUser.email,
      name: updated.tenantUser.name,
      role: updated.role,
      joinedAt: updated.createdAt,
      // Grants survive role changes but are only consulted while the role is
      // MEMBER — promoting to ADMIN leaves them inert, demoting re-arms them.
      grants: updated.applicationGrants.map((g) => ({
        applicationId: g.application.id,
        applicationName: g.application.name,
        applicationSlug: g.application.slug,
        role: g.role,
        createdAt: g.createdAt,
      })),
    };
  },

  async getWorkspace(tenantId: string): Promise<{ id: string; name: string; createdAt: Date }> {
    const t = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, createdAt: true },
    });
    if (!t) {
      throw new RekeyError({
        statusCode: 404,
        code: 'TENANT_NOT_FOUND',
        message: 'Workspace not found.',
        fix: 'The workspace may have been deleted; switch to another from /tenants.',
      });
    }
    return t;
  },

  /**
   * Create a brand new Tenant for an already-signed-in operator. The caller
   * becomes OWNER. Used when one user wants to spin up a second workspace
   * (e.g. side project) without signing up a second account. Returns the
   * new tenantId — caller should then switch the active workspace via
   * /tenant/auth/switch-workspace.
   *
   * Gated by `WORKSPACE_CREATION`. The gate lives here rather than in the route
   * so it holds for any future caller (the MCP write surface, a CLI) rather
   * than only for the one HTTP verb it was written against.
   */
  async createWorkspaceForUser(args: {
    tenantUserId: string;
    name: string;
    actorEmail: string;
  }): Promise<{ id: string; name: string }> {
    assertWorkspaceCreationAllowed();
    const name = args.name.trim();
    if (name.length < 2 || name.length > 80) {
      throw new RekeyError({
        statusCode: 400,
        code: 'WORKSPACE_NAME_INVALID',
        message: 'Workspace name must be 2–80 characters.',
        fix: 'Pick a shorter or longer name.',
      });
    }
    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        // The deployment default applies here too — a second workspace must
        // not be a way to obtain a wider one than sign-up hands out.
        data: {
          name,
          ownerEmail: args.actorEmail.toLowerCase(),
          ...resolveNewTenantLimits(),
        },
      });
      await tx.tenantMembership.create({
        data: { tenantUserId: args.tenantUserId, tenantId: tenant.id, role: 'OWNER' },
      });
      return tenant;
    });
    return { id: result.id, name: result.name };
  },

  async renameWorkspace(args: { tenantId: string; name: string }): Promise<{ id: string; name: string }> {
    const name = args.name.trim();
    if (name.length < 2 || name.length > 80) {
      throw new RekeyError({
        statusCode: 400,
        code: 'WORKSPACE_NAME_INVALID',
        message: 'Workspace name must be 2–80 characters.',
        fix: 'Pick a shorter or longer name.',
      });
    }
    const updated = await prisma.tenant.update({
      where: { id: args.tenantId },
      data: { name },
      select: { id: true, name: true },
    });
    return updated;
  },
};
