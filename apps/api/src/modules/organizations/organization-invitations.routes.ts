/**
 * Pending-invitation routes, registered inside `organizationsAuthenticatedRoutes`
 * so they run behind the same key, scope and user-session hooks:
 *
 *   GET  /api/v1/users/me/organizations/:id/invitations                list pending
 *   POST /api/v1/users/me/organizations/:id/invitations/:invId/resend  fresh link, old one revoked
 *
 * And, with no user session (`organizationInvitationPreviewRoutes`):
 *
 *   POST /api/v1/auth/organizations/invitation-preview                  what a token offers
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { organizationInvitationsService } from './organization-invitations.service.js';
import type { InvitationDto } from './organizations.service.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';
import { ok, okPage, errs, ref } from '../../lib/openapi.js';
import { requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { invitationPreviewRateLimit } from '../../lib/rate-limit.js';
import { brandFromApplication } from '../email/defaults/brand.js';
import { ORG_AUTH_ERRORS } from './organization-route-errors.js';

const OrgParam = z.object({ id: z.string().min(1) });
const OrgInvParam = z.object({ id: z.string().min(1), invId: z.string().min(1) });

const MANAGER_403 =
  `${ORG_AUTH_ERRORS[403]} Or ORGANIZATION_NOT_MEMBER: the caller is not a member of this organization; ` +
  'or ORGANIZATION_ROLE_INSUFFICIENT: the caller is on the MEMBER tier (OWNER or ADMIN required).';

export const INVITATION_CREATED_SCHEMA = {
  type: 'object',
  properties: {
    invitation: ref('OrganizationInvitation'),
    token: {
      type: 'string',
      description: 'Raw invitation token. Shown exactly once, store it now.',
    },
    emailSent: {
      type: 'boolean',
      description:
        'Whether Rekey emailed the link to the invited address. False when no link page resolves, ' +
        "the address reached its auth-email cap, or the Application's email is switched off; share " +
        'the token yourself then.',
    },
    warning: { type: 'string' },
  },
  required: ['invitation', 'token', 'emailSent', 'warning'],
} as const;

/** `{token}` marks where the token goes; the origin must be one the Application registered. */
export const InviteUrl = z
  .string()
  .max(2048)
  .refine((v) => v.includes('{token}'), 'Must contain {token} where the invitation token goes.');

const ResendBody = z.object({ inviteUrl: InviteUrl.optional() });

export const INVITE_URL_JSON_SCHEMA = {
  type: 'string',
  maxLength: 2048,
  description:
    'The link to email, with `{token}` where the token goes (e.g. `https://app.acme.com/join?token={token}`). ' +
    "Must be on the Application's App URL or redirect-URL origins, or its own hosted portal. " +
    "Omit to link the app's `/accept-invitation` page on its App URL, else the hosted portal's `/invitation-link`.",
} as const;

export function invitationCreatedBody(result: { rawToken: string; invitation: InvitationDto; emailSent: boolean }): {
  invitation: Record<string, string>;
  token: string;
  emailSent: boolean;
  warning: string;
} {
  return {
    invitation: {
      id: result.invitation.id,
      organizationId: result.invitation.organizationId,
      email: result.invitation.email,
      role: result.invitation.role,
      expiresAt: result.invitation.expiresAt.toISOString(),
      createdAt: result.invitation.createdAt.toISOString(),
    },
    token: result.rawToken,
    emailSent: result.emailSent,
    warning: result.emailSent
      ? `Rekey emailed the invitation link to ${result.invitation.email}. The raw token is shown only in this response.`
      : 'No invitation email was sent. Share the raw token through your own channel; it is shown only in this response.',
  };
}

export async function registerPendingInvitationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/:id/invitations',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'List pending invitations (OWNER + ADMIN). Never returns a token.',
        description:
          'Invitations not yet accepted or revoked, newest first. Expired ones are included ' +
          '(compare `expiresAt`) so they can be resent. Only a hash of each token is stored, ' +
          'so no link can be read back: resend issues a fresh one.',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('OrganizationPendingInvitation'), 'A page of pending invitations.'),
          ...errs({ ...ORG_AUTH_ERRORS, 403: MANAGER_403 }),
        },
      },
    },
    async (req) => {
      const { id } = OrgParam.parse(req.params);
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { rows, total } = await organizationInvitationsService.listPending({
        application: req.application!,
        actorEndUserId: req.endUser!.id,
        organizationId: id,
        take,
        skip,
      });
      return {
        success: true,
        data: paged(
          rows.map((r) => ({
            id: r.id,
            organizationId: r.organizationId,
            email: r.email,
            role: r.role,
            invitedBy: r.invitedBy,
            createdAt: r.createdAt.toISOString(),
            expiresAt: r.expiresAt.toISOString(),
          })),
          total,
          take,
          skip,
        ),
      };
    },
  );

  app.post(
    '/:id/invitations/:invId/resend',
    {
      schema: {
        tags: ['Public · Organizations'],
        summary: 'Issue and email a fresh link for a pending invitation; the old link stops working',
        body: { type: 'object', nullable: true, properties: { inviteUrl: INVITE_URL_JSON_SCHEMA } },
        description:
          'Creates a new invitation for the same address and role with a fresh expiry, emails it ' +
          'like a new invitation, then revokes the old one. The new invitation has a new `id`. ' +
          'Needs the same authority as inviting that address at that role.',
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
        response: {
          201: ok(INVITATION_CREATED_SCHEMA, 'The new invitation, replacing the old one.'),
          ...errs({
            ...ORG_AUTH_ERRORS,
            403:
              `${ORG_AUTH_ERRORS[403]} Or ORGANIZATION_NOT_MEMBER: the caller is not a member ` +
              "of this organization; or ORGANIZATION_ROLE_INSUFFICIENT: the caller's role " +
              'cannot invite to the invitation\'s role.',
            400:
              'AUTH_URL_INVALID / AUTH_URL_NOT_ALLOWED: `inviteUrl` is not an http(s) URL on an origin ' +
              'this Application registered.',
            404: 'ORGANIZATION_INVITATION_NOT_FOUND: no invitation with that id in this organization.',
            409:
              'ORGANIZATION_INVITATION_NOT_PENDING: the invitation was already accepted or revoked; ' +
              'or ORGANIZATION_ALREADY_MEMBER: the address joined the organization another way.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id, invId } = OrgInvParam.parse(req.params);
      const body = ResendBody.parse(req.body ?? {});
      const result = await organizationInvitationsService.resend({
        application: req.application!,
        actorEndUserId: req.endUser!.id,
        organizationId: id,
        invitationId: invId,
        inviteUrl: body.inviteUrl,
      });
      return reply.status(201).send({ success: true, data: invitationCreatedBody(result) });
    },
  );
}

const PreviewBody = z.object({ token: z.string().min(1).max(512) });

/**
 * Reads an invitation by its token for the page its link opens, before the
 * invited person has signed in. The token travels in the body so it stays out
 * of access logs.
 */
export async function organizationInvitationPreviewRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireScope('auth:read'));

  app.post(
    '/invitation-preview',
    {
      config: { rateLimit: invitationPreviewRateLimit(20) },
      schema: {
        tags: ['Public · Organizations'],
        summary: 'What an invitation offers, read by its token. No user session needed.',
        description:
          'Returns the organization and Application names, the role, and the invited and ' +
          'inviting addresses masked (`j***@example.com`). A token that cannot be accepted, ' +
          'whether unknown, expired, revoked, already used or from another Application, gets ' +
          'the same 404 `ORGANIZATION_INVITATION_UNAVAILABLE`.',
        body: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 1, maxLength: 512 } },
        },
        security: [{ publishableKey: [] }, { apiKey: [] }],
        response: {
          200: ok(ref('OrganizationInvitationPreview'), 'What the invitation offers.'),
          ...errs({
            401: 'API_KEY_MISSING / API_KEY_INVALID / PUBLISHABLE_KEY_INVALID: missing or invalid Application credential.',
            403:
              'IP_NOT_ALLOWED / ORIGIN_NOT_ALLOWED: the caller is outside the presented key\'s allowlist; ' +
              'or API_KEY_SCOPE_INSUFFICIENT: a secret key without `auth:read`.',
            404: 'ORGANIZATION_INVITATION_UNAVAILABLE: the invitation cannot be accepted any more, or never existed.',
            429: 'RATE_LIMITED: too many previews from this address; wait `retryAfterSeconds`.',
          }),
        },
      },
    },
    async (req) => {
      const { token } = PreviewBody.parse(req.body);
      const preview = await organizationInvitationsService.preview({ application: req.application!, rawToken: token });
      return {
        success: true,
        data: {
          organizationName: preview.organizationName,
          applicationName: brandFromApplication(req.application!).name,
          role: preview.role,
          invitedEmail: preview.invitedEmail,
          invitedBy: preview.invitedBy,
          expiresAt: preview.expiresAt.toISOString(),
        },
      };
    },
  );
}
