/**
 * Operator routes for lists, under /api/v1/tenant/applications/:id/lists.
 * Tenant session plus `ensureAppAccess`, gated by the `audience` scope, which
 * viewer and billing grants never hold.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CONTACT_CONSENT_TEXT_MAX_LENGTH,
  CONTACT_FIELD_TYPES,
  CONTACT_LAWFUL_BASES,
  CONTACT_LIST_KEY_RE,
  CONTACT_LIST_KINDS,
  ContactFieldSchemaSchema,
  type SecurityEventType,
} from '@rekey.dev/shared-types';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import { errs, ok, okPage } from '../../lib/openapi.js';
import { paged } from '../../lib/pagination.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';
import { listsService } from './lists.service.js';

const AppParam = z.object({ id: z.string().min(1) });
const ListParam = z.object({ id: z.string().min(1), listId: z.string().min(1) });

const settingsShape = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable(),
  kind: z.enum(CONTACT_LIST_KINDS),
  fieldSchema: ContactFieldSchemaSchema,
  lawfulBasis: z.enum(CONTACT_LAWFUL_BASES),
  consentText: z.string().trim().min(1).max(CONTACT_CONSENT_TEXT_MAX_LENGTH),
  blockDisposable: z.boolean(),
  submissionRetentionDays: z.number().int().min(1).max(3650).nullable(),
};

const CreateBody = z
  .object({ key: z.string().regex(CONTACT_LIST_KEY_RE), ...settingsShape })
  .partial()
  .required({ key: true, name: true })
  .strict();

const UpdateBody = z.object({ ...settingsShape, publicCapture: z.boolean() }).partial().strict();

const TENANT_SESSION_ERRORS = {
  401: 'TENANT_SESSION_MISSING / TENANT_SESSION_INVALID: no valid operator session.',
  429: 'RATE_LIMITED: too many requests. Honour the Retry-After header.',
} as const;
const READ_ERRORS = {
  ...TENANT_SESSION_ERRORS,
  403:
    'TENANT_MEMBERSHIP_REVOKED, or SCOPE_INSUFFICIENT: lists need the audience:read scope, which ' +
    'viewer and billing grants never include.',
  404: 'APPLICATION_NOT_FOUND: no Application with that id in this workspace (also for a MEMBER without a grant on it).',
};
const WRITE_ERRORS = {
  ...TENANT_SESSION_ERRORS,
  403:
    'TENANT_MEMBERSHIP_REVOKED, APP_ACCESS_DENIED (requires APP_ADMIN) or SCOPE_INSUFFICIENT ' +
    '(requires audience:write).',
  404: READ_ERRORS[404],
};
const NOT_FOUND = `${READ_ERRORS[404]}; or LIST_NOT_FOUND: no list with that id in this Application.`;
const QUOTA =
  "CONTACT_LIST_QUOTA_EXCEEDED: the workspace is at its maxContactLists limit (archived lists don't count).";

const FIELD_DEF = {
  type: 'object',
  properties: {
    name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' },
    label: { type: 'string', maxLength: 120 },
    type: { type: 'string', enum: [...CONTACT_FIELD_TYPES] },
    required: { type: 'boolean' },
    maxLength: { type: 'integer', minimum: 1, maximum: 2000 },
    options: { type: 'array', items: { type: 'string' }, description: 'Only for a select field.' },
  },
  required: ['name', 'label', 'type'],
} as const;

const COUNTS = {
  type: 'object',
  properties: {
    subscribed: { type: 'integer' },
    unsubscribed: { type: 'integer' },
    submissions: { type: 'integer' },
  },
  required: ['subscribed', 'unsubscribed', 'submissions'],
} as const;

const LIST_PROPERTIES = {
  id: { type: 'string' },
  applicationId: { type: 'string' },
  key: { type: 'string', description: 'Permanent. The SDK and the public routes name the list by it.' },
  name: { type: 'string' },
  description: { type: 'string', nullable: true },
  kind: { type: 'string', enum: [...CONTACT_LIST_KINDS] },
  fieldSchema: { type: 'array', items: FIELD_DEF },
  lawfulBasis: { type: 'string', enum: [...CONTACT_LAWFUL_BASES] },
  consentText: { type: 'string', nullable: true },
  consentVersion: { type: 'integer', description: 'Bumped on every consent text change. 0 before any text.' },
  publicCapture: {
    type: 'boolean',
    description: 'Whether a publishable key may subscribe to this list. Off until an operator turns it on.',
  },
  blockDisposable: { type: 'boolean' },
  submissionRetentionDays: { type: 'integer', nullable: true },
  archivedAt: { type: 'string', format: 'date-time', nullable: true },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  counts: COUNTS,
} as const;

const LIST = {
  type: 'object',
  properties: LIST_PROPERTIES,
  required: ['id', 'key', 'name', 'kind', 'lawfulBasis', 'consentVersion', 'publicCapture', 'counts'],
} as const;

const LIST_DETAIL = {
  type: 'object',
  properties: {
    ...LIST_PROPERTIES,
    consentVersions: {
      type: 'array',
      description: 'Every consent text the list has had, newest first.',
      items: {
        type: 'object',
        properties: {
          version: { type: 'integer' },
          text: { type: 'string' },
          createdBy: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['version', 'text', 'createdAt'],
      },
    },
  },
  required: [...LIST.required, 'consentVersions'],
} as const;

const SETTINGS_BODY_PROPERTIES = {
  name: { type: 'string', maxLength: 120 },
  description: { type: 'string', nullable: true, maxLength: 500 },
  kind: { type: 'string', enum: [...CONTACT_LIST_KINDS] },
  fieldSchema: { type: 'array', maxItems: 20, items: FIELD_DEF },
  lawfulBasis: { type: 'string', enum: [...CONTACT_LAWFUL_BASES] },
  consentText: {
    type: 'string',
    maxLength: CONTACT_CONSENT_TEXT_MAX_LENGTH,
    description: 'A new text gets the next consentVersion; the old one stays in the history.',
  },
  blockDisposable: { type: 'boolean' },
  submissionRetentionDays: { type: 'integer', nullable: true, minimum: 1, maximum: 3650 },
} as const;

const TAGS = ['Tenant · Lists'];
const SECURITY = [{ tenantSession: [] }];

function audit(
  req: FastifyRequest,
  type: SecurityEventType,
  applicationId: string,
  metadata: Record<string, unknown>,
): void {
  void recordSecurityEvent({
    type,
    actorType: 'operator',
    actorId: req.tenantUser!.id,
    tenantId: req.tenantId!,
    applicationId,
    ...requestContext(req),
    metadata,
  });
}

export async function tenantListsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/:id/lists',
    {
      config: { access: { scope: 'audience:read' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: "List this Application's lists, with member counts",
        description: 'Requires **read** access to this Application and the `audience:read` scope. Archived lists included.',
        response: { 200: okPage(LIST, 'Every list, oldest first.'), ...errs(READ_ERRORS) },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const items = await listsService.list(id);
      return { success: true, data: paged(items, items.length, items.length, 0) };
    },
  );

  app.post(
    '/:id/lists',
    {
      config: { access: { scope: 'audience:write' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Create a list',
        description:
          'Requires **write** access to this Application. `key` is permanent. A new list refuses ' +
          'publishable keys until `publicCapture` is turned on.',
        body: {
          type: 'object',
          required: ['key', 'name'],
          properties: { key: { type: 'string', pattern: CONTACT_LIST_KEY_RE.source }, ...SETTINGS_BODY_PROPERTIES },
        },
        response: {
          201: ok(LIST, 'The new list.'),
          ...errs({
            400: 'VALIDATION_ERROR: a field does not match its rule (see `issues`).',
            ...WRITE_ERRORS,
            403: `${WRITE_ERRORS[403]}; or ${QUOTA}`,
            409: 'LIST_KEY_TAKEN: the Application already has a list with this key.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = CreateBody.parse(req.body);
      const list = await listsService.create(req.tenantId!, id, req.tenantUser!.id, body);
      audit(req, 'app.contact_list.created', id, { listId: list.id, key: list.key });
      return reply.status(201).send({ success: true, data: list });
    },
  );

  app.get(
    '/:id/lists/:listId',
    {
      config: { access: { scope: 'audience:read' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Get one list, with its consent history',
        description: 'Requires **read** access to this Application and the `audience:read` scope.',
        response: { 200: ok(LIST_DETAIL, 'The list.'), ...errs({ ...READ_ERRORS, 404: NOT_FOUND }) },
      },
    },
    async (req) => {
      const { id, listId } = ListParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await listsService.get(id, listId) };
    },
  );

  app.patch(
    '/:id/lists/:listId',
    {
      config: { access: { scope: 'audience:write' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: "Change a list's settings",
        description:
          'Requires **write** access to this Application. Only the fields sent change. A different ' +
          '`consentText` becomes the next `consentVersion`, and browsers showing the old text are ' +
          'refused with `CONTACT_CONSENT_STALE` until they re-fetch the list.',
        body: {
          type: 'object',
          properties: {
            ...SETTINGS_BODY_PROPERTIES,
            publicCapture: {
              type: 'boolean',
              description:
                'Let a publishable key subscribe. Turning it on needs at least one browser origin in ' +
                'the Application Access settings (corsOrigins).',
            },
          },
        },
        response: {
          200: ok(LIST_DETAIL, 'The list after the change.'),
          ...errs({
            400: 'VALIDATION_ERROR: a field does not match its rule (see `issues`).',
            ...WRITE_ERRORS,
            404: NOT_FOUND,
            409: 'LIST_CAPTURE_UNPROTECTED: publicCapture needs at least one browser origin on the Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, listId } = ListParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const patch = UpdateBody.parse(req.body);
      const { list, changed } = await listsService.update(id, listId, req.tenantUser!.id, patch);
      if (changed.length > 0) audit(req, 'app.contact_list.updated', id, { listId, key: list.key, changed });
      return { success: true, data: list };
    },
  );

  app.post(
    '/:id/lists/:listId/archive',
    {
      config: { access: { scope: 'audience:write' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Archive a list',
        description:
          'Requires **write** access to this Application. An archived list refuses every subscribe, ' +
          'keeps its members and submissions, and does not count toward `maxContactLists`. Idempotent.',
        response: { 200: ok(LIST_DETAIL, 'The archived list.'), ...errs({ ...WRITE_ERRORS, 404: NOT_FOUND }) },
      },
    },
    async (req) => {
      const { id, listId } = ListParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const { list, changed } = await listsService.archive(id, listId);
      if (changed) audit(req, 'app.contact_list.archived', id, { listId, key: list.key });
      return { success: true, data: list };
    },
  );

  app.delete(
    '/:id/lists/:listId/archive',
    {
      config: { access: { scope: 'audience:write' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Restore an archived list',
        description:
          'Requires **write** access to this Application. The list counts toward `maxContactLists` ' +
          'again, so restoring can be refused at the limit. Idempotent.',
        response: {
          200: ok(LIST_DETAIL, 'The restored list.'),
          ...errs({ ...WRITE_ERRORS, 403: `${WRITE_ERRORS[403]}; or ${QUOTA}`, 404: NOT_FOUND }),
        },
      },
    },
    async (req) => {
      const { id, listId } = ListParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const { list, changed } = await listsService.restore(req.tenantId!, id, listId);
      if (changed) audit(req, 'app.contact_list.restored', id, { listId, key: list.key });
      return { success: true, data: list };
    },
  );
}
