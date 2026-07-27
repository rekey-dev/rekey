/**
 * End-user organization routes. Two plugins, registered under different
 * prefixes in `app.ts`:
 *
 *   - `organizationsAuthenticatedRoutes` (the 13 routes listed below, under
 *     `/api/v1/users/me/organizations`)
 *   - `organizationsAcceptInvitationRoutes` (under `/api/v1/auth/organizations`)
 *
 * Both accept the **publishable OR secret** key plus the end-user JWT, so a
 * browser-only portal can manage teams and accept invitations with no secret
 * key. The JWT is the authorizer: it is bound to the Application and carries
 * the test/live mode check.
 *
 *   POST   /api/v1/users/me/organizations                            create
 *   GET    /api/v1/users/me/organizations                            list-mine
 *   GET    /api/v1/users/me/organizations/:id                        get
 *   PATCH  /api/v1/users/me/organizations/:id                        update (name/metadata)
 *   GET    /api/v1/users/me/organizations/:id/members                list members
 *   POST   /api/v1/users/me/organizations/:id/invitations            create invite
 *   POST   /api/v1/users/me/organizations/:id/invitations/:invId/revoke
 *   DELETE /api/v1/users/me/organizations/:id/members/:euid          remove a member (or self)
 *   PATCH  /api/v1/users/me/organizations/:id/members/:euid          change member role
 *   POST   /api/v1/users/me/organizations/:id/leave                  self-remove
 *
 * Accept an invitation lives separately because the caller may not yet
 * be a member:
 *
 *   POST   /api/v1/auth/organizations/accept-invitation              consume token
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { organizationsService } from './organizations.service.js';
import { authService } from '../auth/auth.service.js';
import { requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { PaginationQuery, parsePagination, paginationJsonSchema } from '../../lib/pagination.js';

const OrgRoleZ = z.enum(['OWNER', 'ADMIN', 'MEMBER']);

const CreateOrgBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(40),
  metadata: z.record(z.unknown()).optional(),
});

const UpdateOrgBody = z.object({
  name: z.string().min(1).max(120).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const InviteBody = z.object({
  email: z.string().email().max(254),
  role: OrgRoleZ,
});

const ChangeRoleBody = z.object({
  role: OrgRoleZ,
});

const AcceptBody = z.object({
  token: z.string().min(1).max(512),
});

const OrgParam = z.object({ id: z.string().min(1) });
const OrgMemberParam = z.object({ id: z.string().min(1), euid: z.string().min(1) });
const OrgInvParam = z.object({ id: z.string().min(1), invId: z.string().min(1) });

/**
 * Routes mounted under `/api/v1/users/me/organizations`. Credential:
 * **publishable OR secret** key in `Authorization: Bearer`, AND the end-user
 * JWT in `X-Rekey-User-Token` — both, always.
 */
export async function organizationsAuthenticatedRoutes(app: FastifyInstance): Promise<void> {
  // End-user self-service team management — list/create orgs, members, invites,
  // role changes. All require the caller's own user token (requireUserSession)
  // and are role-gated per route, so they accept the publishable key too (a
  // browser portal manages teams + billing with no secret key), exactly like
  // the self-service billing tier.
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireScope('auth:write'));
  app.addHook('onRequest', requireUserSession);

  app.post(
    '/',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'Create an organization; caller becomes the OWNER',
        body: {
          type: 'object',
          required: ['name', 'slug'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            slug: { type: 'string', minLength: 1, maxLength: 40 },
            metadata: { type: 'object' },
          },
        },
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
      },
    },
    async (req, reply) => {
      const body = CreateOrgBody.parse(req.body);
      const result = await organizationsService.create({
        application: req.application!,
        creatorEndUserId: req.endUser!.id,
        name: body.name,
        slug: body.slug,
        ...(body.metadata !== undefined && { metadata: body.metadata }),
      });
      return reply.status(201).send({ success: true, data: shapeOrgWithMembership(result) });
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'List the caller\'s organizations (with their role in each)',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const rows = await organizationsService.listMine({
        application: req.application!,
        endUserId: req.endUser!.id,
        take,
        skip,
      });
      return {
        success: true,
        data: rows.map((r) => ({ ...shapeOrg(r), role: r.role })),
      };
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'Fetch one organization the caller belongs to',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
      },
    },
    async (req) => {
      const { id } = OrgParam.parse(req.params);
      const row = await organizationsService.get({
        application: req.application!,
        endUserId: req.endUser!.id,
        organizationId: id,
      });
      return { success: true, data: { ...shapeOrg(row), role: row.role } };
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'Update org name / metadata (OWNER + ADMIN)',
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            metadata: { type: 'object' },
          },
        },
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
      },
    },
    async (req) => {
      const { id } = OrgParam.parse(req.params);
      const body = UpdateOrgBody.parse(req.body);
      const result = await organizationsService.update({
        application: req.application!,
        actorEndUserId: req.endUser!.id,
        organizationId: id,
        ...(body.name !== undefined && { name: body.name }),
        ...(body.metadata !== undefined && { metadata: body.metadata }),
      });
      return { success: true, data: shapeOrg(result) };
    },
  );

  app.get(
    '/:id/members',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'List members of an org the caller belongs to',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
      },
    },
    async (req) => {
      const { id } = OrgParam.parse(req.params);
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const rows = await organizationsService.listMembers({
        application: req.application!,
        actorEndUserId: req.endUser!.id,
        organizationId: id,
        take,
        skip,
      });
      return {
        success: true,
        data: rows.map((r) => ({
          id: r.id,
          organizationId: r.organizationId,
          endUserId: r.endUserId,
          email: r.email,
          role: r.role,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  );

  app.post(
    '/:id/invitations',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'Invite a user (OWNER + ADMIN). Returns the raw token once.',
        body: {
          type: 'object',
          required: ['email', 'role'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
          },
        },
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
      },
    },
    async (req, reply) => {
      const { id } = OrgParam.parse(req.params);
      const body = InviteBody.parse(req.body);
      const result = await organizationsService.createInvitation({
        application: req.application!,
        actorEndUserId: req.endUser!.id,
        organizationId: id,
        email: body.email,
        role: body.role,
      });
      return reply.status(201).send({
        success: true,
        data: {
          invitation: {
            id: result.invitation.id,
            organizationId: result.invitation.organizationId,
            email: result.invitation.email,
            role: result.invitation.role,
            expiresAt: result.invitation.expiresAt.toISOString(),
            createdAt: result.invitation.createdAt.toISOString(),
          },
          token: result.rawToken,
          warning:
            'Raw token shown ONCE. Share via your own channel — Rekey does not send organisation-invitation email at this time (planned).',
        },
      });
    },
  );

  app.post(
    '/:id/invitations/:invId/revoke',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'Revoke a pending invitation (OWNER + ADMIN)',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
      },
    },
    async (req) => {
      const { id, invId } = OrgInvParam.parse(req.params);
      const result = await organizationsService.revokeInvitation({
        application: req.application!,
        actorEndUserId: req.endUser!.id,
        organizationId: id,
        invitationId: invId,
      });
      return { success: true, data: result };
    },
  );

  app.patch(
    '/:id/members/:euid',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'Change a member\'s role (OWNER manages anyone; ADMIN manages MEMBER + ADMIN)',
        body: {
          type: 'object',
          required: ['role'],
          properties: { role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] } },
        },
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
      },
    },
    async (req) => {
      const { id, euid } = OrgMemberParam.parse(req.params);
      const body = ChangeRoleBody.parse(req.body);
      const result = await organizationsService.setMemberRole({
        application: req.application!,
        actorEndUserId: req.endUser!.id,
        organizationId: id,
        targetEndUserId: euid,
        newRole: body.role,
      });
      return {
        success: true,
        data: {
          id: result.id,
          organizationId: result.organizationId,
          endUserId: result.endUserId,
          role: result.role,
        },
      };
    },
  );

  app.delete(
    '/:id/members/:euid',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'Remove a member (or self). Refuses removing the last OWNER.',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
      },
    },
    async (req) => {
      const { id, euid } = OrgMemberParam.parse(req.params);
      const result = await organizationsService.removeMember({
        application: req.application!,
        actorEndUserId: req.endUser!.id,
        organizationId: id,
        targetEndUserId: euid,
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/:id/leave',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'Self-leave. OWNERs cannot leave (billing is tied to them) — transfer ownership first.',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
      },
    },
    async (req) => {
      const { id } = OrgParam.parse(req.params);
      const result = await organizationsService.leave({
        application: req.application!,
        actorEndUserId: req.endUser!.id,
        organizationId: id,
      });
      return { success: true, data: result };
    },
  );

  // Active-org switch (the `oid` claim). Re-mints the {access, refresh} pair so
  // the new active org is carried on the token + persisted on the refresh row.
  app.post(
    '/:id/switch',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'Make an org the session\'s active org; re-mints the token pair with the `oid` claim',
        description:
          'Member-only. Returns a fresh {accessToken, refreshToken} pair carrying the active org. ' +
          'Read endpoints (e.g. GET /billing/entitlements) then default to this org\'s view + pool ' +
          'without an explicit `organizationId`. The active org survives refresh until you switch ' +
          'again, clear it, or leave the org.',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
      },
    },
    async (req) => {
      const { id } = OrgParam.parse(req.params);
      await organizationsService.requireMembership({
        application: req.application!,
        actorEndUserId: req.endUser!.id,
        organizationId: id,
      });
      const result = await authService.switchActiveOrganization({
        application: req.application!,
        endUserId: req.endUser!.id,
        activeOrganizationId: id,
        device: { userAgent: req.headers['user-agent'] ?? null, ip: req.ip },
      });
      return { success: true, data: result };
    },
  );

  app.post(
    '/clear-active-organization',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'Clear the active org (back to the personal pool); re-mints the token pair',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
      },
    },
    async (req) => {
      const result = await authService.switchActiveOrganization({
        application: req.application!,
        endUserId: req.endUser!.id,
        activeOrganizationId: null,
        device: { userAgent: req.headers['user-agent'] ?? null, ip: req.ip },
      });
      return { success: true, data: result };
    },
  );
}

/**
 * Accept-invitation requires authentication (we need the caller's EndUser
 * id for the membership row) but is logically separate from the
 * "authenticated org admin" surface above — mounted under /auth/organizations.
 *
 * Same credential as the plugin above: publishable or secret key, plus the
 * invitee's own end-user JWT. Two bearer secrets have to line up — the session
 * proves who is accepting, and the invitation token proves they were asked.
 */
export async function organizationsAcceptInvitationRoutes(app: FastifyInstance): Promise<void> {
  // Accepts the publishable key, like the create/list invite siblings above:
  // `requireUserSession` is the real gate (the invitee's own JWT, bound to this
  // Application) and the invitation token is a second bearer secret. Without
  // this a browser portal could create and list invites but never accept one.
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireScope('auth:write'));
  app.addHook('onRequest', requireUserSession);

  app.post(
    '/accept-invitation',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'Accept an organization invitation. Creates the membership.',
        description:
          'Callable from a browser with the publishable key plus the invitee\'s own ' +
          'end-user token. Creating an invitation already accepted the publishable ' +
          'key, so requiring a secret key here left the flow dead-ended: a portal ' +
          'could invite someone but never let them accept.',
        body: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 1, maxLength: 512 } },
        },
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
      },
    },
    async (req) => {
      const body = AcceptBody.parse(req.body);
      const result = await organizationsService.acceptInvitation({
        application: req.application!,
        actorEndUserId: req.endUser!.id,
        rawToken: body.token,
      });
      return {
        success: true,
        data: {
          membership: {
            id: result.id,
            organizationId: result.organizationId,
            endUserId: result.endUserId,
            role: result.role,
            createdAt: result.createdAt.toISOString(),
          },
        },
      };
    },
  );
}

// ---------- Shaping helpers ----------

function shapeOrg(o: {
  id: string;
  applicationId: string;
  name: string;
  slug: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): {
  id: string;
  applicationId: string;
  name: string;
  slug: string;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: o.id,
    applicationId: o.applicationId,
    name: o.name,
    slug: o.slug,
    metadata: o.metadata ?? null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

function shapeOrgWithMembership(args: {
  organization: {
    id: string;
    applicationId: string;
    name: string;
    slug: string;
    metadata: unknown;
    createdAt: Date;
    updatedAt: Date;
  };
  membership: { id: string; organizationId: string; endUserId: string; role: string; createdAt: Date };
}): Record<string, unknown> {
  return {
    organization: shapeOrg(args.organization),
    membership: {
      id: args.membership.id,
      organizationId: args.membership.organizationId,
      endUserId: args.membership.endUserId,
      role: args.membership.role,
      createdAt: args.membership.createdAt.toISOString(),
    },
  };
}
