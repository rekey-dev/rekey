import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { operatorInvitesService } from './operator-invites.service.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';
import {
  PaginationQuery,
  parsePagination,
  pageMeta,
  paginationJsonSchema,
} from '../../lib/pagination.js';
import { recordSecurityEvent } from '../../lib/security-events.js';

const MintBody = z.object({
  note: z.string().min(1).max(200).optional(),
  expiresAt: z.string().datetime().optional(),
});

const InviteParams = z.object({ id: z.string().min(1).max(64) });

function adminContext(req: FastifyRequest): { ip: string | null; userAgent: string | null } {
  const ua = req.headers['user-agent'];
  return { ip: req.ip || null, userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null };
}

/**
 * Super-admin management of operator-invite keys. All under
 * /api/v1/admin/operator-invites — gated by SUPER_ADMIN_KEY. These keys gate
 * new-operator registration when OPERATOR_SIGNUP_MODE='invite'.
 */
export async function operatorInvitesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireSuperAdmin);

  app.post(
    '/',
    {
      schema: {
        tags: ['Admin · Operator Invites'],
        security: [{ superAdminKey: [] }],
        summary: 'Mint a single-use operator-invite key (raw key shown once)',
        description:
          'Returns the raw key in `data.rawToken`. **Show it to the recipient exactly once** — ' +
          'only its SHA-256 hash is stored, so the value is unrecoverable after this response. ' +
          'The key authorizes ONE new operator sign-up while OPERATOR_SIGNUP_MODE=invite.',
        body: {
          type: 'object',
          properties: {
            note: {
              type: 'string',
              minLength: 1,
              maxLength: 200,
              description: 'Optional human label, e.g. "for jane@acme.com".',
            },
            expiresAt: {
              type: 'string',
              format: 'date-time',
              description: 'Optional ISO-8601 expiry. Omit for a non-expiring (still single-use) key.',
            },
          },
        },
      },
    },
    async (req, reply) => {
      const body = MintBody.parse(req.body);
      const result = await operatorInvitesService.mint({
        ...(body.note !== undefined && { note: body.note }),
        ...(body.expiresAt !== undefined && { expiresAt: new Date(body.expiresAt) }),
      });
      void recordSecurityEvent({
        type: 'admin.operator_invite.minted',
        actorType: 'system',
        ...adminContext(req),
        metadata: { inviteId: result.invite.id, note: body.note ?? null, expiresAt: result.invite.expiresAt },
      });
      return reply.status(201).send({
        success: true,
        data: {
          invite: result.invite,
          rawToken: result.rawToken,
          warning:
            'Store this rawToken now — it is shown exactly once and cannot be recovered. It authorizes a single operator sign-up.',
        },
      });
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['Admin · Operator Invites'],
        security: [{ superAdminKey: [] }],
        summary: 'List operator-invite keys (newest first, paginated; never returns the hash)',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { items, total } = await operatorInvitesService.list({ take, skip });
      return { success: true, data: { items, ...pageMeta(total, take, skip) } };
    },
  );

  app.delete(
    '/:id',
    {
      schema: {
        tags: ['Admin · Operator Invites'],
        security: [{ superAdminKey: [] }],
        summary: 'Revoke an unused operator-invite key. Idempotent.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (req) => {
      const { id } = InviteParams.parse(req.params);
      const invite = await operatorInvitesService.revoke(id);
      void recordSecurityEvent({
        type: 'admin.operator_invite.revoked',
        actorType: 'system',
        ...adminContext(req),
        metadata: { inviteId: id },
      });
      return { success: true, data: invite };
    },
  );
}
