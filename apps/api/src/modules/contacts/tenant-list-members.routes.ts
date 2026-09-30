/**
 * Operator routes for the people on one list, under
 * /api/v1/tenant/applications/:id/lists/:listId. Reads need `audience:read`;
 * the CSV export is a floor (OWNER or ADMIN), like the DSAR export, because
 * it hands every address on the list to whoever downloads it.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LIST_MEMBER_STATUSES } from '@rekey.dev/shared-types';
import { ensureAppAccess } from '../../lib/app-access.js';
import { errs, ok, okPage, raw } from '../../lib/openapi.js';
import { PaginationQuery, paginationJsonSchema, parsePagination } from '../../lib/pagination.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';
import { requireTenantRole, requireTenantSession } from '../../middleware/tenant-session.js';
import { exportMembersCsv, operatorMembers, operatorSubmissions, operatorUnsubscribe } from './list-reads.service.js';

const ListParam = z.object({ id: z.string().min(1), listId: z.string().min(1) });
const MemberParam = ListParam.extend({ memberId: z.string().min(1) });
const MembersQuery = PaginationQuery.extend({
  status: z.enum(LIST_MEMBER_STATUSES).optional(),
  search: z.string().trim().min(1).max(254).optional(),
});

const TAGS = ['Tenant · Lists'];
const SECURITY = [{ tenantSession: [] }];

const SESSION_ERRORS = {
  401: 'TENANT_SESSION_MISSING / TENANT_SESSION_INVALID: no valid operator session.',
  429: 'RATE_LIMITED: too many requests. Honour the Retry-After header.',
} as const;
const NOT_FOUND =
  'APPLICATION_NOT_FOUND: no Application with that id in this workspace; or LIST_NOT_FOUND: no list with that id in it.';
const READ_403 = 'TENANT_MEMBERSHIP_REVOKED, or SCOPE_INSUFFICIENT: needs audience:read.';

const MEMBER = {
  type: 'object',
  properties: {
    memberId: { type: 'string' },
    contactId: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string', nullable: true },
    status: { type: 'string', enum: [...LIST_MEMBER_STATUSES] },
    source: { type: 'string', enum: ['publishable', 'secret', 'operator'] },
    consentVersion: { type: 'integer', nullable: true },
    consentAt: { type: 'string', format: 'date-time', nullable: true },
    consentIpPrefix: { type: 'string', nullable: true, description: 'IPv4 /24 or IPv6 /48 of the visitor.' },
    sourceUrl: { type: 'string', nullable: true },
    subscribedAt: { type: 'string', format: 'date-time' },
    unsubscribedAt: { type: 'string', format: 'date-time', nullable: true },
    endUserId: {
      type: 'string',
      nullable: true,
      description: 'The end user with this address in the same Application, if there is one.',
    },
  },
  required: ['memberId', 'contactId', 'email', 'status', 'source', 'subscribedAt'],
} as const;

const SUBMISSION = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    contactId: { type: 'string' },
    email: { type: 'string' },
    fields: { type: 'object', additionalProperties: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'contactId', 'email', 'fields', 'createdAt'],
} as const;

export async function tenantListMembersRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/:id/lists/:listId/members',
    {
      config: { access: { scope: 'audience:read' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: "A list's members, newest first",
        description:
          'Requires **read** access to this Application and `audience:read`. `search` matches the ' +
          'address or the name. `endUserId` is set when the address is also an end user here.',
        querystring: {
          type: 'object',
          properties: {
            ...paginationJsonSchema,
            status: { type: 'string', enum: [...LIST_MEMBER_STATUSES] },
            search: { type: 'string', maxLength: 254 },
          },
        },
        response: {
          200: okPage(MEMBER, 'A page of members.'),
          ...errs({ ...SESSION_ERRORS, 403: READ_403, 404: NOT_FOUND }),
        },
      },
    },
    async (req) => {
      const { id, listId } = ListParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const query = MembersQuery.parse(req.query);
      const { take, skip } = parsePagination(query);
      return {
        success: true,
        data: await operatorMembers(id, listId, { status: query.status, search: query.search, take, skip }),
      };
    },
  );

  app.get(
    '/:id/lists/:listId/submissions',
    {
      config: { access: { scope: 'audience:read' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: "A list's stored submissions, newest first",
        description: 'Requires **read** access to this Application and `audience:read`.',
        querystring: { type: 'object', properties: paginationJsonSchema },
        response: {
          200: okPage(SUBMISSION, 'A page of submissions.'),
          ...errs({ ...SESSION_ERRORS, 403: READ_403, 404: NOT_FOUND }),
        },
      },
    },
    async (req) => {
      const { id, listId } = ListParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await operatorSubmissions(id, listId, parsePagination(PaginationQuery.parse(req.query))) };
    },
  );

  app.post(
    '/:id/lists/:listId/members/:memberId/unsubscribe',
    {
      config: { access: { scope: 'audience:write' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Take someone off a list',
        description:
          'Requires **write** access to this Application and `audience:write`. Sends ' +
          '`contact.unsubscribed` once. Idempotent. There is no operator re-subscribe: only the person, ' +
          'through your server with consent, can join again.',
        response: {
          200: ok(MEMBER, 'The member after the change.'),
          ...errs({
            ...SESSION_ERRORS,
            403: 'TENANT_MEMBERSHIP_REVOKED, APP_ACCESS_DENIED (requires APP_ADMIN) or SCOPE_INSUFFICIENT (requires audience:write).',
            404: `${NOT_FOUND}; or LIST_MEMBER_NOT_FOUND.`,
          }),
        },
      },
    },
    async (req) => {
      const { id, listId, memberId } = MemberParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const { member } = await operatorUnsubscribe(id, listId, memberId);
      return { success: true, data: member };
    },
  );

  app.get(
    '/:id/lists/:listId/export.csv',
    {
      config: { access: { floor: true } },
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: "Download a list's members as CSV",
        description:
          'Requires the **OWNER or ADMIN** workspace role; no grant or scope unlocks it. Every member ' +
          'with their consent proof. Cells starting with `= + - @` are prefixed with `\'` so a ' +
          'spreadsheet never runs them. Records an `app.contacts_exported` security event.',
        response: {
          200: raw('CSV, one member per row, with a header row.', 'text/csv'),
          ...errs({
            ...SESSION_ERRORS,
            403: 'TENANT_ROLE_INSUFFICIENT: requires the OWNER or ADMIN workspace role.',
            404: NOT_FOUND,
          }),
        },
      },
    },
    async (req, reply) => {
      const { id, listId } = ListParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { key, csv, count } = await exportMembersCsv(id, listId);
      void recordSecurityEvent({
        type: 'app.contacts_exported',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { listId, key, count },
      });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${key}-members.csv"`)
        .send(csv);
    },
  );
}
