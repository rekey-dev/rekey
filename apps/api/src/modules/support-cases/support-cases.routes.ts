/**
 * Operator support case routes under `/api/v1/tenant/applications/:id`.
 *
 * Operator-only on purpose, like banning: neither a secret key nor the
 * end-user can open, change or end a case. A leaked backend key must not be a
 * way to switch support capabilities on for an account.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SUPPORT_CASE_CLOSED_CAUSES } from '@rekey.dev/shared-types';
import { ok, okPage, errs } from '../../lib/openapi.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import { PaginationQuery, paged, paginationJsonSchema, parsePagination } from '../../lib/pagination.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { OPERATOR_END_USER_ERRORS as ERRORS, operatorActorOf } from '../end-user-bans/end-user-bans.routes.js';
import { addSupportCaseNote, SUPPORT_NOTE_MAX, SUPPORT_NOTES_PER_RESPONSE } from './support-case-notes.js';
import { operatorSupportActor } from './support-case-writes.js';
import {
  SUPPORT_CAPABILITIES_MAX,
  SUPPORT_DEVICES_MAX,
  SUPPORT_REASON_MAX,
  supportCasesService,
} from './support-cases.service.js';

const AppParams = z.object({ id: z.string().min(1) });
const Params = AppParams.extend({ euid: z.string().min(1) });
const Names = z.array(z.string());
const DeviceIds = z.array(z.string().min(1)).max(SUPPORT_DEVICES_MAX);
const OpenBody = z.object({ capabilities: Names, deviceIds: DeviceIds.optional(), reason: z.string() }).strict();
const PatchBody = z.object({ capabilities: Names.optional(), deviceIds: DeviceIds.nullable().optional() }).strict();
const NoteBody = z.object({ body: z.string() }).strict();
const ListQuery = PaginationQuery.extend({
  status: z.enum(['open', 'closed']).default('open'),
  endUserId: z.string().min(1).max(200).optional(),
});

const APP_PARAMS_SCHEMA = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } as const;
const PARAMS_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, euid: { type: 'string' } },
  required: ['id', 'euid'],
} as const;

const NULLABLE_STRING = { type: 'string', nullable: true } as const;
const NULLABLE_TIME = { type: 'string', format: 'date-time', nullable: true } as const;

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    body: { type: 'string', description: 'Operator-only free text. Never sent to the end-user or in a webhook.' },
    authorId: { type: 'string', description: 'Operator (TenantUser) id.' },
    authorEmail: { ...NULLABLE_STRING, description: "That operator's email, or null once they no longer exist." },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'body', 'authorId', 'authorEmail', 'createdAt'],
} as const;

const SUPPORT_CASE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    applicationId: { type: 'string' },
    endUserId: { type: 'string' },
    endUserEmail: { ...NULLABLE_STRING, description: 'Null once the end-user is erased or deleted.' },
    status: { type: 'string', enum: ['OPEN', 'CLOSED'] },
    capabilities: { type: 'array', items: { type: 'string' }, description: 'Catalogue names, sorted.' },
    scope: {
      type: 'string',
      enum: ['USER', 'DEVICES'],
      description: '`USER` covers every device. `DEVICES` covers only `deviceIds`.',
    },
    deviceIds: { type: 'array', items: { type: 'string' } },
    reason: { ...NULLABLE_STRING, description: 'Operator-only note. Null after the end-user is erased or deleted.' },
    openedBy: { ...NULLABLE_STRING, description: 'Operator (TenantUser) id.' },
    openedByEmail: { ...NULLABLE_STRING, description: "That operator's email, or null once they no longer exist." },
    openedAt: { type: 'string', format: 'date-time' },
    updatedAt: {
      type: 'string',
      format: 'date-time',
      description: 'When the capabilities or devices last changed, or when the case closed.',
    },
    closedBy: {
      ...NULLABLE_STRING,
      description:
        "The operator whose end, ban, delete, erasure, device release or device block closed the case. " +
        'Null while open, and when the end-user or a secret key released the last device.',
    },
    closedByEmail: NULLABLE_STRING,
    closedAt: NULLABLE_TIME,
    closedCause: { type: 'string', enum: [...SUPPORT_CASE_CLOSED_CAUSES], nullable: true },
    notes: {
      type: 'array',
      items: NOTE_SCHEMA,
      description:
        'Operator notes on the case, oldest first. Only on `GET .../end-users/:euid/support`, where one ' +
        `response carries at most ${SUPPORT_NOTES_PER_RESPONSE} notes across its cases, the newest ones.`,
    },
    noteCount: {
      type: 'integer',
      description:
        'How many notes the case has. On `GET .../support-cases` (no note bodies) and on ' +
        '`GET .../end-users/:euid/support`, where it can exceed the notes returned.',
    },
  },
  required: [
    'id', 'applicationId', 'endUserId', 'endUserEmail', 'status', 'capabilities', 'scope', 'deviceIds', 'reason',
    'openedBy', 'openedByEmail', 'openedAt', 'updatedAt', 'closedBy', 'closedByEmail', 'closedAt', 'closedCause',
  ],
} as const;

const NULLABLE_SUPPORT_CASE = { ...SUPPORT_CASE_SCHEMA, nullable: true } as const;

const EVENT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['end_user.support_opened', 'end_user.support_updated', 'end_user.support_closed'] },
    actorType: { type: 'string', enum: ['operator', 'end_user', 'system'] },
    actorId: NULLABLE_STRING,
    actorEmail: NULLABLE_STRING,
    metadata: {
      type: 'object',
      description: 'The case id, and the capabilities, scope and devices before and after. Never the reason.',
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'type', 'actorType', 'actorId', 'actorEmail', 'metadata', 'createdAt'],
} as const;

const CAPABILITY_ERRORS =
  `SUPPORT_CAPABILITIES_REQUIRED: \`capabilities\` is empty or names more than ${SUPPORT_CAPABILITIES_MAX}; or ` +
  'SUPPORT_CAPABILITY_UNKNOWN: a name is not in the catalogue';
const DEVICE_404 =
  "SUPPORT_CASE_DEVICE_NOT_FOUND: a device id does not exist or is not this end-user's (the same answer for both)";
const DEVICE_409 = 'SUPPORT_CASE_DEVICE_NOT_ACTIVE: a named device is released or blocked';
const DEVICES_EMPTY = 'SUPPORT_CASE_DEVICES_EMPTY: `deviceIds` is an empty list';

const CAPABILITIES_BODY = {
  type: 'array',
  items: { type: 'string' },
  description: `1 to ${SUPPORT_CAPABILITIES_MAX} names from the catalogue. Stored sorted and de-duplicated.`,
} as const;

export async function tenantSupportCaseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/:id/end-users/:euid/support',
    {
      config: { access: { scope: 'end-users:read' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "Get an end-user's support case, past cases and support events",
        description:
          'Requires **read** access to this Application. `open` is the open case or null, `history` ' +
          'the last 20 closed cases newest first, `events` the last 50 support security events ' +
          'newest first with the acting operator. Each case carries its operator `notes`, oldest ' +
          `first, at most ${SUPPORT_NOTES_PER_RESPONSE} across the response. The operator-only \`reason\` ` +
          'and notes are returned to every operator who can read end-users.',
        params: PARAMS_SCHEMA,
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                open: NULLABLE_SUPPORT_CASE,
                history: { type: 'array', items: SUPPORT_CASE_SCHEMA },
                events: { type: 'array', items: EVENT_SCHEMA },
              },
              required: ['open', 'history', 'events'],
            },
            'The support state of this end-user.',
          ),
          ...errs(ERRORS),
        },
      },
    },
    async (req) => {
      const { id, euid } = Params.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await supportCasesService.get(id, euid) };
    },
  );

  app.post(
    '/:id/end-users/:euid/support',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Open a support case on an end-user',
        description:
          'Requires **write** access to this Application. Puts the account in support mode: until ' +
          'the case is ended, `GET /auth/me?include=support` and `GET /users/:id/support` report ' +
          'these capabilities. A case never expires. Without `deviceIds` it covers every device; ' +
          'with them, only those, and an empty list is refused. A device that is later released or ' +
          'blocked leaves the case, and the case closes when that was its last device. It changes ' +
          'nothing about plans, entitlements or licences. The `reason` is operator-only and is ' +
          'never sent in a webhook.',
        params: PARAMS_SCHEMA,
        body: {
          type: 'object',
          required: ['capabilities', 'reason'],
          properties: {
            capabilities: CAPABILITIES_BODY,
            deviceIds: {
              type: 'array',
              items: { type: 'string' },
              maxItems: SUPPORT_DEVICES_MAX,
              description:
                'Omitted covers every device (scope `USER`). Otherwise scope `DEVICES`: ' +
                `1 to ${SUPPORT_DEVICES_MAX} ids, each an ACTIVE device of this end-user.`,
            },
            // Length is checked by the service after trimming, so a blank or
            // over-long reason gets SUPPORT_REASON_INVALID, not a schema error.
            reason: { type: 'string', description: `1 to ${SUPPORT_REASON_MAX} characters after trimming.` },
          },
        },
        response: {
          201: ok(SUPPORT_CASE_SCHEMA, 'The opened case.'),
          ...errs({
            ...ERRORS,
            400:
              `${CAPABILITY_ERRORS}; or SUPPORT_REASON_INVALID: \`reason\` is blank after trimming or longer ` +
              `than ${SUPPORT_REASON_MAX} characters; or ${DEVICES_EMPTY}; or BAD_REQUEST: \`reason\` or ` +
              '`capabilities` is missing; or VALIDATION_ERROR: the body has a key this route does not know.',
            403: `${ERRORS[403]} Or END_USER_BANNED: the end-user is banned; lift the ban first.`,
            404: `${ERRORS[404]} Or ${DEVICE_404}.`,
            409: `SUPPORT_CASE_ALREADY_OPEN: the end-user has an open case, named in \`details.caseId\`; or ${DEVICE_409}.`,
            410: 'END_USER_ERASED: the end-user was erased.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id, euid } = Params.parse(req.params);
      const body = OpenBody.parse(req.body ?? {});
      await ensureAppAccess(req, id, 'write');
      const opened = await supportCasesService.open({
        applicationId: id,
        endUserId: euid,
        capabilities: body.capabilities,
        deviceIds: body.deviceIds,
        reason: body.reason,
        actor: operatorSupportActor(operatorActorOf(req)),
      });
      return reply.status(201).send({ success: true, data: opened });
    },
  );

  app.patch(
    '/:id/end-users/:euid/support',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "Change an open support case's capabilities or devices",
        description:
          'Requires **write** access to this Application. The next read reports the new state. ' +
          '`deviceIds`: omitted leaves the scope alone, `null` widens the case to every device, a ' +
          'non-empty list limits it to those devices, an empty list is refused. A request that ' +
          'changes nothing returns the case untouched and sends no webhook. The reason cannot be changed.',
        params: PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: {
            capabilities: CAPABILITIES_BODY,
            deviceIds: {
              type: 'array',
              items: { type: 'string' },
              maxItems: SUPPORT_DEVICES_MAX,
              nullable: true,
              description: 'Null for every device, or the full list of ACTIVE device ids the case is limited to.',
            },
          },
        },
        response: {
          200: ok(SUPPORT_CASE_SCHEMA, 'The case as it now stands.'),
          ...errs({
            ...ERRORS,
            400: `${CAPABILITY_ERRORS}; or ${DEVICES_EMPTY}; or VALIDATION_ERROR: the body has a key this route does not know.`,
            404: `${ERRORS[404]} Or SUPPORT_CASE_NOT_OPEN: the end-user has no open case; or ${DEVICE_404}.`,
            409: `${DEVICE_409}.`,
          }),
        },
      },
    },
    async (req) => {
      const { id, euid } = Params.parse(req.params);
      const body = PatchBody.parse(req.body ?? {});
      await ensureAppAccess(req, id, 'write');
      const updated = await supportCasesService.update({
        applicationId: id,
        endUserId: euid,
        capabilities: body.capabilities,
        deviceIds: body.deviceIds,
        actor: operatorSupportActor(operatorActorOf(req)),
      });
      return { success: true, data: updated };
    },
  );

  app.post(
    '/:id/end-users/:euid/support/end',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "End an end-user's support case",
        description:
          'Requires **write** access to this Application. The capabilities stop being reported on ' +
          'the next read. Idempotent: `case` is null when no case was open.',
        params: PARAMS_SCHEMA,
        response: {
          200: ok(
            { type: 'object', properties: { case: NULLABLE_SUPPORT_CASE }, required: ['case'] },
            'The closed case, or null when none was open.',
          ),
          ...errs(ERRORS),
        },
      },
    },
    async (req) => {
      const { id, euid } = Params.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const data = await supportCasesService.end({ applicationId: id, endUserId: euid, actor: operatorSupportActor(operatorActorOf(req)) });
      return { success: true, data };
    },
  );

  app.post(
    '/:id/end-users/:euid/support/notes',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "Add a note to an end-user's open support case",
        description:
          'Requires **write** access to this Application. Notes are operator-only and append-only: ' +
          'there is no route to edit or delete one. A note is never sent to the end-user, in a ' +
          'webhook, in a security event or in the data export, and writes no webhook or security ' +
          "event itself. Erasing or deleting the end-user deletes their cases' notes.",
        params: PARAMS_SCHEMA,
        body: {
          type: 'object',
          required: ['body'],
          // Length is checked by the service after trimming, so a blank or
          // over-long note gets SUPPORT_NOTE_INVALID, not a schema error.
          properties: {
            body: { type: 'string', description: `1 to ${SUPPORT_NOTE_MAX} characters after trimming.` },
          },
        },
        response: {
          201: ok(NOTE_SCHEMA, 'The note.'),
          ...errs({
            ...ERRORS,
            400:
              `SUPPORT_NOTE_INVALID: \`body\` is blank after trimming or longer than ${SUPPORT_NOTE_MAX} ` +
              'characters; or BAD_REQUEST: `body` is missing; or VALIDATION_ERROR: the body has a key ' +
              'this route does not know.',
            404: `${ERRORS[404]} Or SUPPORT_CASE_NOT_OPEN: the end-user has no open case.`,
          }),
        },
      },
    },
    async (req, reply) => {
      const { id, euid } = Params.parse(req.params);
      const { body } = NoteBody.parse(req.body ?? {});
      await ensureAppAccess(req, id, 'write');
      const note = await addSupportCaseNote({
        applicationId: id,
        endUserId: euid,
        body,
        authorId: operatorActorOf(req).operatorUserId,
      });
      return reply.status(201).send({ success: true, data: note });
    },
  );

  app.get(
    '/:id/support-cases',
    {
      config: { access: { scope: 'end-users:read' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "List an Application's support cases",
        description:
          'Requires **read** access to this Application. `status=open` (the default) lists accounts ' +
          'in support mode, oldest case first, so the ones most likely forgotten lead. ' +
          '`status=closed` lists past cases, most recently opened first. Each case carries ' +
          '`noteCount`; read the notes themselves from `GET .../end-users/:euid/support`.',
        params: APP_PARAMS_SCHEMA,
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'closed'], default: 'open' },
            endUserId: { type: 'string', description: 'Only cases on this end-user.' },
            ...paginationJsonSchema,
          },
        },
        response: {
          200: okPage(SUPPORT_CASE_SCHEMA, 'A page of support cases.'),
          ...errs({
            400: 'VALIDATION_ERROR: a query parameter is out of range.',
            401: ERRORS[401],
            403: ERRORS[403],
            404: 'APPLICATION_NOT_FOUND: no application with that id in this workspace (also returned to a MEMBER holding no grant on it).',
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParams.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const query = ListQuery.parse(req.query);
      const { take, skip } = parsePagination(query);
      const { items, total } = await supportCasesService.list(id, {
        status: query.status === 'open' ? 'OPEN' : 'CLOSED',
        endUserId: query.endUserId,
        take,
        skip,
      });
      return { success: true, data: paged(items, total, take, skip) };
    },
  );
}
