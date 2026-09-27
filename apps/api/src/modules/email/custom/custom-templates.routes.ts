/**
 * Operator routes for custom email templates, under
 * /api/v1/tenant/applications/:id. Tenant session plus `ensureAppAccess`,
 * like the built-in template routes next door.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CUSTOM_EMAIL_CATEGORIES } from '@rekey.dev/shared-types';
import { RekeyError } from '../../../lib/error.js';
import { requireTenantSession } from '../../../middleware/tenant-session.js';
import { ensureAppAccess } from '../../../lib/app-access.js';
import { errs, ok, okPage } from '../../../lib/openapi.js';
import { paged } from '../../../lib/pagination.js';
import { customTemplatesService, type DraftFields } from './custom-templates.service.js';
import { testSendCustomTemplate } from './custom-send.service.js';
import { FromNameSchema, LinkDomainsSchema, TemplateKeySchema, VariableSchemaSchema } from './template-rules.js';

const AppParam = z.object({ id: z.string().min(1) });
const KeyParam = z.object({ id: z.string().min(1), key: z.string().min(1).max(64) });

const draftShape = {
  name: z.string().trim().min(1).max(120),
  category: z.enum(CUSTOM_EMAIL_CATEGORIES),
  fromName: FromNameSchema.nullable(),
  subject: z.string().min(1).max(998),
  designJson: z.unknown(),
  bodyHtml: z.string().min(1).max(1024 * 200),
  bodyText: z.string().max(1024 * 50).nullable(),
  variableSchema: VariableSchemaSchema,
  linkDomains: LinkDomainsSchema,
};

const CreateBody = z
  .object({
    key: TemplateKeySchema,
    ...draftShape,
    fromName: draftShape.fromName.default(null),
    bodyText: draftShape.bodyText.default(null),
    designJson: z.unknown().optional(),
    variableSchema: draftShape.variableSchema.default([]),
    linkDomains: draftShape.linkDomains.default([]),
  })
  .strict();

const UpdateBody = z.object(draftShape).partial().strict();

const PreviewBody = z
  .object({ variables: z.record(z.string().max(2048)).optional() })
  .strict()
  .default({});

const SettingsBody = z.object({ recipientsMustBeEndUsers: z.boolean() }).strict();

const TENANT_SESSION_ERRORS = {
  401: 'TENANT_SESSION_MISSING / TENANT_SESSION_INVALID: no valid operator session.',
  429: 'RATE_LIMITED: too many requests. Honour the Retry-After header.',
} as const;
const READ_ERRORS = {
  ...TENANT_SESSION_ERRORS,
  403: 'TENANT_MEMBERSHIP_REVOKED: you are no longer a member of this workspace.',
  404: 'APPLICATION_NOT_FOUND: no Application with that id in this workspace (also for a MEMBER without a grant on it).',
};
const WRITE_ERRORS = {
  ...TENANT_SESSION_ERRORS,
  403:
    'TENANT_MEMBERSHIP_REVOKED, TENANT_ROLE_INSUFFICIENT or APP_ACCESS_DENIED: your role or grant does ' +
    'not allow writing to this Application (requires APP_ADMIN).',
  404: READ_ERRORS[404],
};
const NOT_FOUND = `${READ_ERRORS[404]}; or EMAIL_TEMPLATE_NOT_FOUND: no custom template with that key.`;

const VARIABLE_DEF = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    type: { type: 'string', enum: ['string', 'number', 'url', 'date'] },
    required: { type: 'boolean' },
    maxLength: { type: 'integer', minimum: 1, maximum: 2048 },
    sample: { type: 'string' },
  },
  required: ['name', 'type'],
} as const;

const TEMPLATE = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    applicationId: { type: 'string' },
    key: { type: 'string' },
    name: { type: 'string' },
    category: { type: 'string', enum: ['critical', 'notification'] },
    fromName: { type: 'string', nullable: true },
    subject: { type: 'string' },
    designJson: { nullable: true, description: 'Opaque Unlayer design document, stored for the editor.' },
    bodyHtml: { type: 'string' },
    bodyText: { type: 'string', nullable: true },
    variableSchema: { type: 'array', items: VARIABLE_DEF },
    linkDomains: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: ['draft', 'published'] },
    version: { type: 'integer', description: 'Latest published version, 0 before the first publish.' },
    publishedAt: { type: 'string', format: 'date-time', nullable: true },
    hasUnpublishedChanges: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'key', 'name', 'category', 'subject', 'bodyHtml', 'status', 'version', 'hasUnpublishedChanges'],
} as const;

const DRAFT_BODY_PROPERTIES = {
  name: { type: 'string', maxLength: 120 },
  category: { type: 'string', enum: ['critical', 'notification'] },
  fromName: { type: 'string', nullable: true, maxLength: 120 },
  subject: { type: 'string', maxLength: 998 },
  designJson: { description: 'Opaque Unlayer design document.' },
  bodyHtml: { type: 'string', maxLength: 204800 },
  bodyText: { type: 'string', nullable: true, maxLength: 51200 },
  variableSchema: { type: 'array', maxItems: 50, items: VARIABLE_DEF },
  linkDomains: { type: 'array', maxItems: 20, items: { type: 'string' } },
} as const;

const SETTINGS = {
  type: 'object',
  properties: {
    eligible: {
      type: 'boolean',
      description: "True when the Application sends through its own Resend or SMTP provider, which custom templates require.",
    },
    transport: { type: 'string', enum: ['byo_resend', 'byo_smtp', 'default_resend', 'none'] },
    fromAddress: { type: 'string', nullable: true },
    recipientsMustBeEndUsers: { type: 'boolean' },
    caps: {
      type: 'object',
      properties: { daily: { type: 'integer' }, recipientHourly: { type: 'integer' } },
      required: ['daily', 'recipientHourly'],
    },
  },
  required: ['eligible', 'transport', 'fromAddress', 'recipientsMustBeEndUsers', 'caps'],
} as const;

const TAGS = ['Tenant · Email'];
const SECURITY = [{ tenantSession: [] }];

export async function customEmailTemplateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/:id/custom-email-settings',
    {
      config: { access: { scope: 'developer:read' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Whether this Application can send custom templates, and its send settings',
        description: 'Requires **read** access to this Application.',
        response: { 200: ok(SETTINGS, 'Eligibility and settings.'), ...errs(READ_ERRORS) },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await customTemplatesService.settings(id) };
    },
  );

  app.patch(
    '/:id/custom-email-settings',
    {
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Change who custom templates may be sent to',
        description:
          'Requires **write** access to this Application. `recipientsMustBeEndUsers: true` makes ' +
          '`POST /api/v1/email/send` refuse any address that is not an end user of this Application.',
        body: {
          type: 'object',
          required: ['recipientsMustBeEndUsers'],
          properties: { recipientsMustBeEndUsers: { type: 'boolean' } },
        },
        response: {
          200: ok(SETTINGS, 'The settings after the change.'),
          ...errs({ 400: 'VALIDATION_ERROR: the body does not match.', ...WRITE_ERRORS }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = SettingsBody.parse(req.body);
      return { success: true, data: await customTemplatesService.settings(id, body) };
    },
  );

  app.get(
    '/:id/custom-email-templates',
    {
      config: { access: { scope: 'developer:read' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: "List this Application's custom email templates",
        description: 'Requires **read** access to this Application. At most 200 per Application, all returned.',
        response: { 200: okPage(TEMPLATE, 'Every custom template, by key.'), ...errs(READ_ERRORS) },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const items = await customTemplatesService.list(id);
      return { success: true, data: paged(items, items.length, items.length, 0) };
    },
  );

  app.post(
    '/:id/custom-email-templates',
    {
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Create a custom email template as a draft',
        description:
          'Requires **write** access to this Application. A draft can be created without a custom ' +
          'transport; publishing needs one. `key` is permanent and cannot be a built-in email key.',
        body: {
          type: 'object',
          required: ['key', 'name', 'category', 'subject', 'bodyHtml'],
          properties: { key: { type: 'string', pattern: '^[a-z][a-z0-9_]{2,63}$' }, ...DRAFT_BODY_PROPERTIES },
        },
        response: {
          201: ok(TEMPLATE, 'The new draft.'),
          ...errs({
            400: 'VALIDATION_ERROR: a field does not match its rule (see `issues`).',
            ...WRITE_ERRORS,
            409:
              'EMAIL_TEMPLATE_KEY_TAKEN: the Application already has a template with this key; or ' +
              'EMAIL_TEMPLATE_LIMIT_REACHED: the Application holds 200 templates.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const { key, ...fields } = CreateBody.parse(req.body);
      const created = await customTemplatesService.create(id, key, fields as DraftFields);
      return reply.status(201).send({ success: true, data: created });
    },
  );

  app.get(
    '/:id/custom-email-templates/:key',
    {
      config: { access: { scope: 'developer:read' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Get one custom template draft',
        description: 'Requires **read** access to this Application.',
        response: { 200: ok(TEMPLATE, 'The draft and its publish state.'), ...errs({ ...READ_ERRORS, 404: NOT_FOUND }) },
      },
    },
    async (req) => {
      const { id, key } = KeyParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await customTemplatesService.get(id, key) };
    },
  );

  app.patch(
    '/:id/custom-email-templates/:key',
    {
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Edit a custom template draft',
        description:
          'Requires **write** access to this Application. Changes the draft only: sends keep using the ' +
          'latest published version until the draft is published again. `key` cannot change.',
        body: { type: 'object', properties: DRAFT_BODY_PROPERTIES },
        response: {
          200: ok(TEMPLATE, 'The draft after the edit.'),
          ...errs({
            400: 'VALIDATION_ERROR: a field does not match its rule (see `issues`).',
            ...WRITE_ERRORS,
            404: NOT_FOUND,
          }),
        },
      },
    },
    async (req) => {
      const { id, key } = KeyParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const patch = UpdateBody.parse(req.body);
      return { success: true, data: await customTemplatesService.update(id, key, patch as Partial<DraftFields>) };
    },
  );

  app.delete(
    '/:id/custom-email-templates/:key',
    {
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Delete a custom template',
        description:
          'Requires **write** access to this Application. A backend still sending this key gets ' +
          '`EMAIL_TEMPLATE_NOT_FOUND` from then on. The template is soft-deleted: its published ' +
          'versions are kept for history, and creating the same key again reuses it as a draft and ' +
          'continues the version numbers.',
        response: {
          200: ok(
            { type: 'object', properties: { deleted: { type: 'boolean', enum: [true] } }, required: ['deleted'] },
            'Deleted.',
          ),
          ...errs({ ...WRITE_ERRORS, 404: NOT_FOUND }),
        },
      },
    },
    async (req) => {
      const { id, key } = KeyParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await customTemplatesService.remove(id, key);
      return { success: true, data: { deleted: true } };
    },
  );

  app.post(
    '/:id/custom-email-templates/:key/publish',
    {
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Publish the draft as the next version',
        description:
          'Requires **write** access to this Application. Checks that every variable the content uses ' +
          'is declared, that a variable starting a link is a `url`, and that `url` variables have link ' +
          "domains. Refused unless the Application sends through its own Resend or SMTP provider.",
        response: {
          200: ok(TEMPLATE, 'The template with its new version number.'),
          ...errs({
            400: 'EMAIL_TEMPLATE_INVALID: the draft breaks a publish rule (see `details.issues`).',
            ...WRITE_ERRORS,
            403: `${WRITE_ERRORS[403]}; or EMAIL_TRANSPORT_NOT_CUSTOM: the Application has no Resend or SMTP provider of its own.`,
            404: NOT_FOUND,
            409: 'EMAIL_SENDER_DOMAIN_MISMATCH: the Application has no From address.',
          }),
        },
      },
    },
    async (req) => {
      const { id, key } = KeyParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      return {
        success: true,
        data: await customTemplatesService.publish(id, key, req.tenantUser?.id ?? null),
      };
    },
  );

  app.post(
    '/:id/custom-email-templates/:key/preview',
    {
      config: { access: { scope: 'developer:read' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Render the draft with sample values (no email is sent)',
        description:
          'Requires **read** access to this Application. Uses each variable’s `sample`, a typed ' +
          'placeholder, or the values passed here. A variable the draft uses but does not declare ' +
          'renders as its literal `{{name}}` token and is listed in `undeclared`; publish refuses ' +
          'such a draft. Show the HTML only in a sandboxed frame: it is operator-authored and not sanitised.',
        body: {
          type: 'object',
          properties: { variables: { type: 'object', additionalProperties: { type: 'string' } } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                subject: { type: 'string' },
                html: { type: 'string' },
                text: { type: 'string' },
                fromName: { type: 'string', nullable: true },
                category: { type: 'string', enum: ['critical', 'notification'] },
                undeclared: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Variables the draft uses without declaring them. Empty when the draft can publish.',
                },
              },
              required: ['subject', 'html', 'text', 'fromName', 'category', 'undeclared'],
            },
            'The rendered draft.',
          ),
          ...errs({ 400: 'VALIDATION_ERROR: the body does not match.', ...READ_ERRORS, 404: NOT_FOUND }),
        },
      },
    },
    async (req) => {
      const { id, key } = KeyParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const body = PreviewBody.parse(req.body ?? {});
      return { success: true, data: await customTemplatesService.preview(id, key, body.variables) };
    },
  );

  app.post(
    '/:id/custom-email-templates/:key/test-send',
    {
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: TAGS,
        security: SECURITY,
        summary: 'Send the draft with sample values to your own address',
        description:
          'Requires **write** access to this Application. Always sends to the signed-in operator’s ' +
          'own email address; there is no recipient field. Needs the same own provider as a real ' +
          'send, honours the suppression list, and counts against the send caps.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['sent', 'error'] },
                to: { type: 'string', description: 'The operator address it was sent to.' },
                messageId: { type: 'string', nullable: true },
                via: { type: 'string', enum: ['byo_resend', 'byo_smtp'] },
                message: { type: 'string', description: 'Present when `kind` is "error".' },
              },
              required: ['kind', 'to'],
            },
            'The test send outcome.',
          ),
          ...errs({
            ...WRITE_ERRORS,
            403: `${WRITE_ERRORS[403]}; or EMAIL_TRANSPORT_NOT_CUSTOM: the Application has no Resend or SMTP provider of its own.`,
            404: NOT_FOUND,
            409:
              'EMAIL_ADDRESS_SUPPRESSED: your address is on the suppression list; or ' +
              'EMAIL_SENDER_DOMAIN_MISMATCH: the Application has no From address.',
            429: 'EMAIL_RATE_LIMITED: a send cap is reached; or RATE_LIMITED. Honour Retry-After.',
          }),
        },
      },
    },
    async (req) => {
      const { id, key } = KeyParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const to = req.tenantUser?.email;
      if (!to) {
        throw new RekeyError({
          statusCode: 401,
          code: 'TENANT_SESSION_INVALID',
          message: 'This session has no operator email address to send to.',
          fix: 'Sign in to the panel again.',
        });
      }
      const outcome = await testSendCustomTemplate(id, key, to);
      return { success: true, data: { ...outcome, to } };
    },
  );
}
