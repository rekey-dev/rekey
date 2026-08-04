import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApplicationRole, TenantRole } from '@prisma/client';
import { tenantWorkspacesService, workspaceCreationMode } from './tenant-workspaces.service.js';
import { emailService } from '../email/email.service.js';
import {
  requireTenantSession,
  requireTenantRole,
} from '../../middleware/tenant-session.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';
import { ok, okPage, errs, ref, type JsonSchema } from '../../lib/openapi.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';

/**
 * The 401/403 pair every `/api/v1/tenant/workspace/*` route shares —
 * `requireTenantSession` runs as an `onRequest` hook, so these precede any
 * route-specific failure.
 */
const TENANT_SESSION_ERRORS = {
  401:
    'TENANT_SESSION_MISSING — no `Authorization: Bearer` header; or ' +
    'TENANT_SESSION_INVALID — the access token is invalid, expired, or the operator account no longer exists.',
  403: 'TENANT_MEMBERSHIP_REVOKED — the operator is no longer a member of the active workspace.',
} as const;

/** Extra 403 raised by the `requireTenantRole(['OWNER', 'ADMIN'])` preHandler. */
const OWNER_ADMIN_ROLE_ERROR =
  'TENANT_ROLE_INSUFFICIENT — the operator\'s live role in this workspace is below OWNER/ADMIN.';

// `MemberGrantRow`/`MemberRow`/`InvitationRow` (tenant-workspaces.service.ts) now match the
// registered `MemberGrant`/`WorkspaceMember`/`WorkspaceInvitation` components field-for-field —
// verified against the service return types. Referenced directly via `ref(...)` below instead of
// duplicating the shapes here.

/**
 * `acceptInvitation()` returns the raw `TenantMembership` Prisma row (`{id, tenantUserId,
 * tenantId, role, createdAt}`), NOT a `MemberRow` — it is created/read inside the transaction
 * before any `email`/`name`/`grants` join happens. This does NOT match `WorkspaceMember`
 * (`membershipId`/`email`/`joinedAt`/`grants` are all absent, and `id`/`createdAt` mean something
 * different here), so it is modelled inline rather than via `ref('WorkspaceMember')` — a prior
 * pass had this wrong. See the report for this handler/component mismatch.
 */
const AcceptedMembershipRow: JsonSchema = {
  type: 'object',
  description:
    'The raw membership row created (or reused, if already a member) by accepting this ' +
    'invitation. Not the enriched `WorkspaceMember` shape — no `email`/`name`/`grants`.',
  properties: {
    id: { type: 'string' },
    tenantUserId: { type: 'string' },
    tenantId: { type: 'string' },
    role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'tenantUserId', 'tenantId', 'role', 'createdAt'],
};

/**
 * `getWorkspace()` — a trimmed `Tenant` projection (id, name, createdAt only). This is NOT the
 * `Tenant` component: `ownerEmail` and `updatedAt` are both required there but this handler's
 * `prisma.tenant.findUnique({ select: {...} })` never fetches them, so `ref('Tenant')` would
 * over-promise. Modelled inline instead.
 */
const WorkspaceDetail: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'name', 'createdAt'],
};

/**
 * `createWorkspaceForUser()` / `renameWorkspace()` — id + name only. Also not the `Tenant`
 * component for the same reason as `WorkspaceDetail` above (missing required `ownerEmail` /
 * `updatedAt`).
 */
const WorkspaceSummary: JsonSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, name: { type: 'string' } },
  required: ['id', 'name'],
};

/**
 * A workspace-wide SYSTEM email send-log row (`emailService.listTenantLogs`) — the `EmailLog`
 * component's fields plus the joined `application` summary this endpoint alone includes.
 */
const WorkspaceEmailLogRow: JsonSchema = {
  allOf: [
    ref('EmailLog'),
    {
      type: 'object',
      properties: {
        application: {
          type: 'object',
          nullable: true,
          description: 'Null for system mail — this endpoint only ever returns system mail.',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            slug: { type: 'string' },
          },
          required: ['id', 'name', 'slug'],
        },
      },
    },
  ],
};

const WorkspaceLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
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
    '/creation-mode',
    {
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'Whether this deployment lets operators create additional workspaces',
        description:
          'UX hint, exactly like `GET /tenant/auth/signup-mode`: it lets the panel hide the ' +
          '"New workspace" affordance on a deployment where `POST /tenant/workspace` would ' +
          'refuse. Not a secret and not the enforcement — `assertWorkspaceCreationAllowed()` ' +
          'gates the creation path server-side regardless of what this reports.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: { mode: { type: 'string', enum: ['open', 'disabled'] } },
              required: ['mode'],
            },
            "The deployment's additional-workspace-creation mode.",
          ),
          ...errs(TENANT_SESSION_ERRORS),
        },
      },
    },
    async () => ({ success: true, data: { mode: workspaceCreationMode() } }),
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'Get the active workspace',
        response: {
          200: ok(WorkspaceDetail, 'The active workspace.'),
          ...errs({
            ...TENANT_SESSION_ERRORS,
            404: 'TENANT_NOT_FOUND — the active workspace no longer exists.',
          }),
        },
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
          'After creation, switch into it via POST /api/v1/tenant/auth/switch-workspace.\n\n' +
          'A deployment can turn this off with `WORKSPACE_CREATION=disabled`, in which case ' +
          'this route (and only this route) refuses with 403 `WORKSPACE_CREATION_DISABLED`.',
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string', minLength: 2, maxLength: 80 } },
        },
        response: {
          200: ok(WorkspaceSummary, 'The created workspace.'),
          ...errs({
            400: 'WORKSPACE_NAME_INVALID — name is not 2–80 characters after trimming.',
            ...TENANT_SESSION_ERRORS,
            403:
              `${TENANT_SESSION_ERRORS[403]} Or WORKSPACE_CREATION_DISABLED — this deployment ` +
              'has `WORKSPACE_CREATION=disabled`.',
          }),
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
        response: {
          200: ok(WorkspaceSummary, 'The renamed workspace.'),
          ...errs({
            400: 'WORKSPACE_NAME_INVALID — name is not 2–80 characters after trimming.',
            ...TENANT_SESSION_ERRORS,
            403: `${TENANT_SESSION_ERRORS[403]} Or ${OWNER_ADMIN_ROLE_ERROR}`,
          }),
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
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('WorkspaceMember'), 'A page of members of the active workspace.'),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            ...TENANT_SESSION_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const [items, total] = await Promise.all([
        tenantWorkspacesService.listMembers(req.tenantId!, { take, skip }),
        tenantWorkspacesService.countMembers(req.tenantId!),
      ]);
      return { success: true, data: paged(items, total, take, skip) };
    },
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
        response: {
          200: ok(
            {
              type: 'object',
              properties: { removed: { type: 'boolean', enum: [true] } },
              required: ['removed'],
            },
            'Member removed.',
          ),
          ...errs({
            ...TENANT_SESSION_ERRORS,
            403: `${TENANT_SESSION_ERRORS[403]} Or ${OWNER_ADMIN_ROLE_ERROR}`,
            404: 'MEMBERSHIP_NOT_FOUND — no membership with that id in this workspace.',
            400: 'CANNOT_REMOVE_LAST_OWNER — this is the workspace\'s only OWNER.',
          }),
        },
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
        response: {
          200: ok(ref('WorkspaceMember'), "The member's updated row."),
          ...errs({
            ...TENANT_SESSION_ERRORS,
            403: `${TENANT_SESSION_ERRORS[403]} Or ${OWNER_ADMIN_ROLE_ERROR}`,
            404: 'MEMBERSHIP_NOT_FOUND — no membership with that id in this workspace.',
            400: 'CANNOT_REMOVE_LAST_OWNER — this would demote the workspace\'s only OWNER.',
          }),
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
  // Semantics live in prisma `ApplicationGrant` + lib/app-access.ts: grants
  // are authoritative for a MEMBER, including when there are none (since
  // 2.0.0-rc.3 — a member with no grants reaches no Application). The single
  // exception is a membership carrying `legacyWorkspaceRead`, set only by the
  // 2.0.0-rc.3 backfill for memberships that predate that default.

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
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('MemberGrant'), "A page of the member's per-application grants."),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            ...TENANT_SESSION_ERRORS,
            403: `${TENANT_SESSION_ERRORS[403]} Or ${OWNER_ADMIN_ROLE_ERROR}`,
            404: 'MEMBERSHIP_NOT_FOUND — no membership with that id in this workspace.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = MemberIdParam.parse(req.params);
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { items, total } = await tenantWorkspacesService.listMemberGrants({
        tenantId: req.tenantId!,
        membershipId: id,
        take,
        skip,
      });
      return { success: true, data: paged(items, total, take, skip) };
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
          'full access.\n\n' +
          'Grants are how a MEMBER gets access at all: a member with none reaches no ' +
          'Application. Setting a grant also permanently clears `legacyWorkspaceRead` ' +
          'on memberships grandfathered by the 2.0.0-rc.3 backfill.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['applicationId', 'role'],
          properties: {
            applicationId: { type: 'string', minLength: 1 },
            role: { type: 'string', enum: ['APP_ADMIN', 'APP_BILLING', 'APP_VIEWER'] },
          },
        },
        response: {
          200: ok(ref('MemberGrant'), 'The upserted grant.'),
          ...errs({
            ...TENANT_SESSION_ERRORS,
            403: `${TENANT_SESSION_ERRORS[403]} Or ${OWNER_ADMIN_ROLE_ERROR}`,
            404:
              'MEMBERSHIP_NOT_FOUND — no membership with that id in this workspace; or ' +
              'APPLICATION_NOT_FOUND — no application with that id in this workspace.',
            400:
              'APP_GRANT_MEMBER_ONLY — this membership is OWNER/ADMIN, which already has ' +
              'full access to every Application.',
          }),
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
          'Removing the LAST grant leaves the member with access to no Application. ' +
          'Before 2.0.0-rc.3 it instead returned them to workspace-wide read — a ' +
          'de-scoping call that widened access. Re-grant to restore.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, applicationId: { type: 'string' } },
          required: ['id', 'applicationId'],
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: { removed: { type: 'boolean', enum: [true] } },
              required: ['removed'],
            },
            'Grant removed.',
          ),
          ...errs({
            ...TENANT_SESSION_ERRORS,
            403: `${TENANT_SESSION_ERRORS[403]} Or ${OWNER_ADMIN_ROLE_ERROR}`,
            404:
              'MEMBERSHIP_NOT_FOUND — no membership with that id in this workspace; or ' +
              'APP_GRANT_NOT_FOUND — no grant for that application on this membership.',
          }),
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
      // OWNER/ADMIN, matching the POST directly below. The two halves of one
      // resource disagreed: creating an invitation was ADMIN-gated while
      // reading the list of them — pending invitee addresses and the workspace
      // role each was offered — was open to any MEMBER. A role floor that only
      // covers the write half is not a role floor.
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'List invitations for this workspace',
        description: 'Requires the **OWNER or ADMIN** workspace role, same as creating one.',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('WorkspaceInvitation'), 'A page of invitations for this workspace, newest first.'),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            ...TENANT_SESSION_ERRORS,
            403:
              `${TENANT_SESSION_ERRORS[403]}; or TENANT_ROLE_INSUFFICIENT — listing invitations ` +
              'requires OWNER or ADMIN, same as creating one.',
          }),
        },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { items, total } = await tenantWorkspacesService.listInvitations(req.tenantId!, {
        take,
        skip,
      });
      return { success: true, data: paged(items, total, take, skip) };
    },
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
        response: {
          201: ok(
            {
              type: 'object',
              properties: {
                invitation: ref('WorkspaceInvitation'),
                token: {
                  type: 'string',
                  description: 'Raw invitation token. Shown exactly once — store it now.',
                },
                emailSent: { type: 'boolean' },
                warning: { type: 'string' },
              },
              required: ['invitation', 'token', 'emailSent', 'warning'],
            },
            'The created invitation.',
          ),
          ...errs({
            ...TENANT_SESSION_ERRORS,
            403:
              `${TENANT_SESSION_ERRORS[403]} Or TENANT_ROLE_INSUFFICIENT — an ADMIN caller ` +
              'tried to invite an ADMIN or OWNER (ADMIN may only invite MEMBER).',
            409: 'INVITE_TARGET_ALREADY_MEMBER — that email is already a member of this workspace.',
          }),
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
          /** True if Rekey sent the invitation email via the default Resend pool. False otherwise (caller forwards manually). */
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
        response: {
          200: ok(ref('WorkspaceInvitation'), 'The revoked invitation (idempotent — same row if already revoked).'),
          ...errs({
            ...TENANT_SESSION_ERRORS,
            403:
              `${TENANT_SESSION_ERRORS[403]} Or TENANT_ROLE_INSUFFICIENT — an ADMIN caller ` +
              "tried to revoke an ADMIN's or OWNER's invitation.",
            404: 'INVITATION_NOT_FOUND — no invitation with that id in this workspace.',
            400:
              'INVITATION_ALREADY_ACCEPTED — already accepted; remove the resulting member instead.',
          }),
        },
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
      // OWNER/ADMIN, matching GET /api/v1/tenant/security-events. Both are
      // workspace-level operator audit surfaces and they disagreed: the
      // security-events log was ADMIN-only on the stated grounds that it
      // "carries IPs and event metadata a plain MEMBER shouldn't see", while
      // this one handed any MEMBER every operator's email address plus the
      // subject and delivery status of workspace password-reset, magic-link
      // and invitation mail. Same class of data, same floor.
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Workspace'],
        security: [{ tenantSession: [] }],
        summary: 'List recent SYSTEM email send-logs for the workspace (operator/invite mail, not per-app)',
        description:
          'Requires the **OWNER or ADMIN** workspace role, same as the workspace security-event log.\n\n' +
          'System mail only — operator magic-link/password-reset + workspace invitations (sends not ' +
          'tied to an Application). Per-application email logs live under the Application itself.',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0, maximum: 2147483647 },
            status: { type: 'string', enum: ['sent', 'error', 'no_transport'] },
          },
        },
        response: {
          200: okPage(WorkspaceEmailLogRow, 'A page of system email send-logs for the workspace.'),
          ...errs(TENANT_SESSION_ERRORS),
        },
      },
    },
    async (req) => {
      const q = WorkspaceLogQuery.parse(req.query);
      // The service defaults to 100 when no limit is sent — mirror it so
      // `page.limit` describes the window that was served.
      const limit = q.limit ?? 100;
      const offset = q.offset ?? 0;
      const [rows, total] = await Promise.all([
        emailService.listTenantLogs({
          tenantId: req.tenantId!,
          systemOnly: true,
          limit,
          offset,
          ...(q.status !== undefined && { status: q.status }),
        }),
        emailService.countTenantLogs({
          tenantId: req.tenantId!,
          systemOnly: true,
          ...(q.status !== undefined && { status: q.status }),
        }),
      ]);
      return {
        success: true,
        data: paged(
          rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
          total,
          limit,
          offset,
        ),
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
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                tenantId: { type: 'string' },
                tenantName: { type: 'string' },
                role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
                invitedEmail: { type: 'string', format: 'email' },
                expiresAt: { type: 'string', format: 'date-time' },
              },
              required: ['tenantId', 'tenantName', 'role', 'invitedEmail', 'expiresAt'],
            },
            'The workspace + role this invitation grants, without consuming it.',
          ),
          ...errs({
            404: 'INVITATION_NOT_FOUND — the token is unknown.',
            400:
              'INVITATION_REVOKED — the invitation was revoked; or ' +
              'INVITATION_ALREADY_ACCEPTED — already used; or ' +
              'INVITATION_EXPIRED — past its `expiresAt`.',
          }),
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
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                membership: AcceptedMembershipRow,
                accessToken: { type: 'string' },
                accessTokenExpiresAt: { type: 'string', format: 'date-time' },
                refreshToken: { type: 'string' },
                refreshTokenExpiresAt: { type: 'string', format: 'date-time' },
              },
              required: [
                'membership',
                'accessToken',
                'accessTokenExpiresAt',
                'refreshToken',
                'refreshTokenExpiresAt',
              ],
            },
            'The new membership plus a session scoped to the joined workspace.',
          ),
          ...errs({
            ...TENANT_SESSION_ERRORS,
            400:
              'INVITATION_NOT_USABLE — missing, revoked, or already accepted; or ' +
              'INVITATION_EXPIRED — past its `expiresAt`.',
            403: `${TENANT_SESSION_ERRORS[403]} Or INVITATION_EMAIL_MISMATCH — the signed-in ` +
              "operator's email does not match the invitation's.",
          }),
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
