import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApplicationRole, TenantRole } from '@prisma/client';
import { tenantWorkspacesService } from './tenant-workspaces.service.js';
import { emailService } from '../email/email.service.js';
import {
  requireTenantSession,
  requireTenantRole,
} from '../../middleware/tenant-session.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';

const WorkspaceLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.enum(['sent', 'error', 'no_transport']).optional(),
});

const InviteBody = z.object({
  email: z.string().email().max(254),
  role: z.enum(['OWNER', 'ADMIN', 'MEMBER']),
});
const RenameBody = z.object({ name: z.string().min(2).max(80) });
const CreateBody = z.object({ name: z.string().min(2).max(80) });
const InvIdParam = z.object({ id: z.string().min(1) });
const MemberIdParam = z.object({ id: z.string().min(1) });
const RoleBody = z.object({ role: z.enum(['OWNER', 'ADMIN', 'MEMBER']) });
const GrantBody = z.object({
  applicationId: z.string().min(1),
  role: z.enum(['APP_ADMIN', 'APP_BILLING', 'APP_VIEWER']),
});
const GrantParam = z.object({ id: z.string().min(1), applicationId: z.string().min(1) });
const AcceptBody = z.object({ token: z.string().min(1).max(512) });
const PreviewQuery = z.object({ token: z.string().min(1).max(512) });

/**
 * Authenticated workspace routes — invitations + members.
 * Mounted under /api/v1/tenant/workspace.
 */
export async function tenantWorkspacesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/',
    {
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'Get the active workspace',
      },
    },
    async (req) => ({
      success: true,
      data: await tenantWorkspacesService.getWorkspace(req.tenantId!),
    }),
  );

  app.post(
    '/',
    {
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'Create a new workspace for the current operator (becomes OWNER)',
        description:
          'Lets a signed-in user spin up an additional Tenant without registering a new account. ' +
          'After creation, switch into it via POST /api/v1/tenant/auth/switch-workspace.',
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 2, maxLength: 80 } },
        },
      },
    },
    async (req) => {
      const body = CreateBody.parse(req.body);
      const created = await tenantWorkspacesService.createWorkspaceForUser({
        tenantUserId: req.tenantUser!.id,
        name: body.name,
        actorEmail: req.tenantUser!.email,
      });
      return { success: true, data: created };
    },
  );

  app.patch(
    '/',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'Rename the active workspace',
        description:
          'Requires the **OWNER or ADMIN** workspace role.',
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 2, maxLength: 80 } },
        },
      },
    },
    async (req) => {
      const body = RenameBody.parse(req.body);
      return {
        success: true,
        data: await tenantWorkspacesService.renameWorkspace({
          tenantId: req.tenantId!,
          name: body.name,
        }),
      };
    },
  );

  app.get(
    '/members',
    {
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'List members of the active workspace',
      },
    },
    async (req) => ({
      success: true,
      data: await tenantWorkspacesService.listMembers(req.tenantId!),
    }),
  );

  app.delete(
    '/members/:id',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'Remove a member from the workspace',
        description:
          'Requires the **OWNER or ADMIN** workspace role.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (req) => {
      const { id } = MemberIdParam.parse(req.params);
      await tenantWorkspacesService.removeMember({
        tenantId: req.tenantId!,
        membershipId: id,
        actorTenantUserId: req.tenantUser!.id,
        actorRole: req.tenantRole!,
      });
      return { success: true, data: { removed: true } };
    },
  );

  app.patch(
    '/members/:id',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: "Change a member's role",
        description:
          'Requires the **OWNER or ADMIN** workspace role.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['role'],
          properties: { role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] } },
        },
      },
    },
    async (req) => {
      const { id } = MemberIdParam.parse(req.params);
      const body = RoleBody.parse(req.body);
      const member = await tenantWorkspacesService.changeMemberRole({
        tenantId: req.tenantId!,
        membershipId: id,
        actorRole: req.tenantRole!,
        newRole: body.role as TenantRole,
      });
      return { success: true, data: member };
    },
  );

  // ---------- Per-application grants (roadmap #8) ----------
  //
  // Scope a MEMBER's access down to specific Applications. OWNER/ADMIN only
  // (members see their own access via GET /members, which includes grants).
  // Semantics live in prisma `ApplicationGrant` + lib/app-access.ts: a MEMBER
  // with zero grants keeps legacy workspace-wide read access; with ≥1 grant,
  // grants are authoritative.

  app.get(
    '/members/:id/grants',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: "List a member's per-application grants",
        description:
          'Requires the **OWNER or ADMIN** workspace role.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (req) => {
      const { id } = MemberIdParam.parse(req.params);
      return {
        success: true,
        data: await tenantWorkspacesService.listMemberGrants({
          tenantId: req.tenantId!,
          membershipId: id,
        }),
      };
    },
  );

  app.put(
    '/members/:id/grants',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'Grant (or change) a MEMBER\'s role on one Application',
        description:
          'Requires the **OWNER or ADMIN** workspace role.\n\n' +
          'Upserts the (member, application) grant: APP_ADMIN (full app read/write), ' +
          'APP_BILLING (read + billing/plans/coupons writes only), or APP_VIEWER ' +
          '(read-only). Only valid on MEMBER memberships — OWNER/ADMIN already have ' +
          'full access. The first grant a member receives switches them from legacy ' +
          'workspace-wide read access to grant-scoped access.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['applicationId', 'role'],
          properties: {
            applicationId: { type: 'string', minLength: 1 },
            role: { type: 'string', enum: ['APP_ADMIN', 'APP_BILLING', 'APP_VIEWER'] },
          },
        },
      },
    },
    async (req) => {
      const { id } = MemberIdParam.parse(req.params);
      const body = GrantBody.parse(req.body);
      const grant = await tenantWorkspacesService.setMemberGrant({
        tenantId: req.tenantId!,
        membershipId: id,
        applicationId: body.applicationId,
        role: body.role as ApplicationRole,
      });
      void recordSecurityEvent({
        type: 'member.app_grant_set',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: body.applicationId,
        ...requestContext(req),
        metadata: { membershipId: id, role: body.role },
      });
      return { success: true, data: grant };
    },
  );

  app.delete(
    '/members/:id/grants/:applicationId',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: "Remove a member's grant on one Application",
        description:
          'Requires the **OWNER or ADMIN** workspace role.\n\n' +
          'Careful with the LAST grant: removing it returns the member to legacy ' +
          'workspace-wide read-only access (zero grants = pre-grants behavior), it ' +
          'does NOT lock them out.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, applicationId: { type: 'string' } },
          required: ['id', 'applicationId'],
        },
      },
    },
    async (req) => {
      const { id, applicationId } = GrantParam.parse(req.params);
      await tenantWorkspacesService.removeMemberGrant({
        tenantId: req.tenantId!,
        membershipId: id,
        applicationId,
      });
      void recordSecurityEvent({
        type: 'member.app_grant_removed',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId,
        ...requestContext(req),
        metadata: { membershipId: id },
      });
      return { success: true, data: { removed: true } };
    },
  );

  app.get(
    '/invitations',
    {
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'List invitations for this workspace',
      },
    },
    async (req) => ({
      success: true,
      data: await tenantWorkspacesService.listInvitations(req.tenantId!),
    }),
  );

  app.post(
    '/invitations',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'Create an invitation. Returns a one-time-show token to share via the link.',
        description:
          'Requires the **OWNER or ADMIN** workspace role.',
        body: {
          type: 'object',
          required: ['email', 'role'],
          properties: {
            email: { type: 'string', format: 'email' },
            role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
          },
        },
      },
    },
    async (req, reply) => {
      const body = InviteBody.parse(req.body);
      const result = await tenantWorkspacesService.createInvitation({
        tenantId: req.tenantId!,
        invitedById: req.tenantUser!.id,
        invitedByRole: req.tenantRole!,
        email: body.email,
        role: body.role as TenantRole,
      });
      return reply.status(201).send({
        success: true,
        data: {
          invitation: result.invitation,
          /** Raw token. Even when emailSent is true we still return it so operators can re-share manually if delivery fails. */
          token: result.rawToken,
          /** True if ReliPay sent the invitation email via the default Resend pool. False otherwise (caller forwards manually). */
          emailSent: result.emailSent,
          warning: result.emailSent
            ? 'The invitation email was sent. The raw token is still here in case you need to re-share manually — it is shown only once.'
            : 'Store this token now — it is shown exactly once and cannot be recovered. Share via the URL: ' +
              '<panelUrl>/accept-invite?token=' + result.rawToken,
        },
      });
    },
  );

  app.delete(
    '/invitations/:id',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'Revoke a pending invitation',
        description:
          'Requires the **OWNER or ADMIN** workspace role.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    },
    async (req) => {
      const { id } = InvIdParam.parse(req.params);
      const inv = await tenantWorkspacesService.revokeInvitation({
        tenantId: req.tenantId!,
        invitationId: id,
        actorRole: req.tenantRole!,
      });
      return { success: true, data: inv };
    },
  );

  // ---------- Email logs (workspace-wide, read-only) ----------

  app.get(
    '/email-logs',
    {
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'List recent SYSTEM email send-logs for the workspace (operator/invite mail, not per-app)',
        description:
          'System mail only — operator magic-link/password-reset + workspace invitations (sends not ' +
          'tied to an Application). Per-application email logs live under the Application itself.',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0 },
            status: { type: 'string', enum: ['sent', 'error', 'no_transport'] },
          },
        },
      },
    },
    async (req) => {
      const q = WorkspaceLogQuery.parse(req.query);
      const rows = await emailService.listTenantLogs({
        tenantId: req.tenantId!,
        systemOnly: true,
        ...(q.limit !== undefined && { limit: q.limit }),
        ...(q.offset !== undefined && { offset: q.offset }),
        ...(q.status !== undefined && { status: q.status }),
      });
      return {
        success: true,
        data: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      };
    },
  );
}

/**
 * Endpoints for accepting / previewing an invitation token.
 *
 * - GET /preview is unauthenticated — the recipient can see the workspace
 *   name + role *before* they sign up, so they know what they're agreeing to.
 * - POST /accept requires a valid tenant session (the invitee must already
 *   have an account). The panel flow is: visit the invite URL → if not
 *   signed in, sign up or sign in → POST the token to accept.
 */
export async function tenantInvitationPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/preview',
    {
      schema: {
        tags: ['Tenant · Workspace'],
        security: [],
        summary: 'Preview an invitation by token (unauthenticated)',
        querystring: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 1, maxLength: 512 } },
        },
      },
    },
    async (req) => {
      const { token } = PreviewQuery.parse(req.query);
      const result = await tenantWorkspacesService.previewInvitation(token);
      return { success: true, data: result };
    },
  );
}

export async function tenantInvitationAuthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.post(
    '/accept',
    {
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'Accept an invitation. Returns a session scoped to the joined workspace.',
        body: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 1, maxLength: 512 } },
        },
      },
    },
    async (req) => {
      const body = AcceptBody.parse(req.body);
      const result = await tenantWorkspacesService.acceptInvitation({
        rawToken: body.token,
        tenantUserId: req.tenantUser!.id,
      });
      return {
        success: true,
        data: {
          membership: result.membership,
          accessToken: result.accessToken,
          accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
          refreshToken: result.refreshToken,
          refreshTokenExpiresAt: result.refreshTokenExpiresAt.toISOString(),
        },
      };
    },
  );
}
