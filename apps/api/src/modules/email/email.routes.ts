/**
 * Tenant-facing email management routes.
 *
 *   GET    /api/v1/tenant/applications/:id/email-config
 *     Status: which transport will be used, whether creds are present,
 *     the current `from` address.
 *
 *   PUT    /api/v1/tenant/applications/:id/email-credentials
 *     Set BYO Resend API key + `from` address. Encrypted at rest.
 *
 *   DELETE /api/v1/tenant/applications/:id/email-credentials
 *     Revert to the default Resend pool (or no transport if unset).
 *
 *   GET    /api/v1/tenant/applications/:id/email-templates
 *     List events with customised/default status.
 *
 *   GET    /api/v1/tenant/applications/:id/email-templates/:eventKey
 *     Returns the active template (customised or built-in default), the
 *     opaque `designJson` (when customised), and the registered variable
 *     list for the panel builder to render preview chips.
 *
 *   PUT    /api/v1/tenant/applications/:id/email-templates/:eventKey
 *     Upsert a custom template. `bodyHtml` is the compiled HTML the
 *     panel produced from the Unlayer designJson — we don't recompile
 *     server-side.
 *
 *   DELETE /api/v1/tenant/applications/:id/email-templates/:eventKey
 *     Revert this event to the built-in default.
 *
 *   POST   /api/v1/tenant/applications/:id/email-templates/:eventKey/preview
 *     Render the active template with the event's sample values. Returns
 *     subject + html + text. No transport involved.
 *
 *   POST   /api/v1/tenant/applications/:id/email-templates/:eventKey/test-send
 *     Render + send to a specified address (typically the operator's own
 *     inbox). Uses the same transport selection as production sends.
 *
 * All routes require the operator's tenant session AND the Application
 * must belong to the operator's active workspace (re-uses
 * `ensureAppAccess` helper — which also enforces per-application grants).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import { emailService } from './email.service.js';
import { describeTransport, sendEmail, type EmailCredentials } from '../../lib/email-transport.js';
import { isKnownEvent } from './events.js';

const AppParam = z.object({ id: z.string().min(1) });
const EventParam = z.object({ id: z.string().min(1), eventKey: z.string().min(1).max(64) });

// Sender identity, shared by every provider.
const fromFields = {
  fromAddress: z.string().email().max(254),
  fromName: z.string().max(120).optional(),
  replyTo: z.string().email().max(254).optional(),
};

// Provider-discriminated credential body. Resend (API key) or SMTP
// (host/port/user/pass). A missing `provider` is coerced to 'resend' in the
// handler for backward compatibility with the old { apiKey, fromAddress } body.
const SetCredsBody = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('resend'),
    apiKey: z.string().min(1).max(256),
    ...fromFields,
  }),
  z.object({
    provider: z.literal('smtp'),
    host: z.string().min(1).max(255),
    port: z.coerce.number().int().min(1).max(65535),
    secure: z.boolean().optional(),
    user: z.string().min(1).max(255),
    pass: z.string().min(1).max(512),
    ...fromFields,
  }),
]);

const LogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.enum(['sent', 'error', 'no_transport']).optional(),
});

const UpsertTemplateBody = z.object({
  subject: z.string().min(1).max(998),
  designJson: z.unknown(),
  bodyHtml: z.string().min(1).max(1024 * 200), // 200 KB cap — enough for a complex template, blocks pathological abuse.
  bodyText: z.string().max(1024 * 50).nullable().optional(),
});

const TestSendBody = z.object({
  to: z.string().email().max(254),
});

// Access control: ensureAppAccess (lib/app-access.ts) checks workspace
// ownership AND per-application grants. Transport credentials + template
// mutations are 'write' (APP_ADMIN grant or workspace OWNER/ADMIN); config,
// logs, template reads, and previews are 'read'.

export async function tenantEmailRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  // ---------- Config + credentials ----------

  app.get(
    '/:id/email-config',
    {
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: "Get an Application's email config and effective transport",
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it (grant-less legacy members keep workspace-wide read).',
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const application = await prisma.application.findUniqueOrThrow({ where: { id } });
      const transport = describeTransport(application);
      return {
        success: true,
        data: {
          emailConfig: application.emailConfig,
          hasCustomCredentials: application.emailCredentialsCiphertext !== null,
          transport: transport.via,
          provider: transport.provider,
          effectiveFromAddress: transport.fromAddress,
        },
      };
    },
  );

  app.put(
    '/:id/email-credentials',
    {
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: "Set or rotate the Application's BYO email transport (Resend or SMTP) + sender",
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        body: {
          type: 'object',
          required: ['fromAddress'],
          properties: {
            provider: { type: 'string', enum: ['resend', 'smtp'] },
            // resend
            apiKey: { type: 'string', maxLength: 256 },
            // smtp
            host: { type: 'string', maxLength: 255 },
            port: { type: 'integer', minimum: 1, maximum: 65535 },
            secure: { type: 'boolean' },
            user: { type: 'string', maxLength: 255 },
            pass: { type: 'string', maxLength: 512 },
            // shared sender identity
            fromAddress: { type: 'string', format: 'email', maxLength: 254 },
            fromName: { type: 'string', maxLength: 120 },
            replyTo: { type: 'string', format: 'email', maxLength: 254 },
          },
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      // Back-compat: an absent `provider` means the legacy Resend-only body.
      const rawBody = (req.body ?? {}) as Record<string, unknown>;
      const body = SetCredsBody.parse({ ...rawBody, provider: rawBody.provider ?? 'resend' });
      const credentials: EmailCredentials =
        body.provider === 'resend'
          ? { provider: 'resend', apiKey: body.apiKey }
          : {
              provider: 'smtp',
              host: body.host,
              port: body.port,
              secure: body.secure ?? true,
              user: body.user,
              pass: body.pass,
            };
      await emailService.setCredentials({
        applicationId: id,
        credentials,
        fromAddress: body.fromAddress,
        fromName: body.fromName ?? null,
        replyTo: body.replyTo ?? null,
      });
      return { success: true, data: { configured: true, provider: body.provider } };
    },
  );

  app.delete(
    '/:id/email-credentials',
    {
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Revert this Application to the default (or no) email transport',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await emailService.removeCredentials(id);
      return { success: true, data: { configured: false } };
    },
  );

  // ---------- Send logs (read-only) ----------

  app.get(
    '/:id/email-logs',
    {
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'List recent email send-logs for this Application',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it (grant-less legacy members keep workspace-wide read).',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
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
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const q = LogQuery.parse(req.query);
      const rows = await emailService.listAppLogs({
        applicationId: id,
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

  // ---------- Templates ----------

  /**
   * Shared schema head for the three template READ routes below. They all sit
   * behind `requireTenantSession` (plugin hook) + `ensureAppAccess(id, 'read')`.
   */
  const templateReadSchema = {
    tags: ['Tenant · Email'],
    security: [{ tenantSession: [] }],
    description:
      'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
      'any grant on it (grant-less legacy members keep workspace-wide read).',
  };

  app.get(
    '/:id/email-templates',
    { schema: { ...templateReadSchema, summary: 'List customisable email events' } },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await emailService.listEvents(id) };
    },
  );

  app.get(
    '/:id/email-templates/:eventKey',
    { schema: { ...templateReadSchema, summary: 'Get the template for one event' } },
    async (req) => {
      const { id, eventKey } = EventParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      if (!isKnownEvent(eventKey)) {
        throw new RekeyError({
          statusCode: 404,
          code: 'EMAIL_EVENT_UNKNOWN',
          message: `Email event "${eventKey}" is not in the registry.`,
          fix: 'Use one of the events returned by GET /email-templates.',
        });
      }
      return { success: true, data: await emailService.getTemplate(id, eventKey) };
    },
  );

  app.put(
    '/:id/email-templates/:eventKey',
    {
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Upsert a customised template for one event',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
      },
    },
    async (req) => {
      const { id, eventKey } = EventParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = UpsertTemplateBody.parse(req.body);
      if (!isKnownEvent(eventKey)) {
        throw new RekeyError({
          statusCode: 404,
          code: 'EMAIL_EVENT_UNKNOWN',
          message: `Email event "${eventKey}" is not in the registry.`,
          fix: 'Use one of the events returned by GET /email-templates.',
        });
      }
      const row = await emailService.setTemplate({
        applicationId: id,
        eventKey,
        subject: body.subject,
        designJson: body.designJson,
        bodyHtml: body.bodyHtml,
        ...(body.bodyText !== undefined && { bodyText: body.bodyText }),
      });
      return { success: true, data: { id: row.id, eventKey: row.eventKey } };
    },
  );

  app.delete(
    '/:id/email-templates/:eventKey',
    {
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Revert one event to the built-in default template',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
      },
    },
    async (req) => {
      const { id, eventKey } = EventParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await emailService.deleteTemplate(id, eventKey);
      return { success: true, data: { reverted: true } };
    },
  );

  app.post(
    '/:id/email-templates/:eventKey/preview',
    {
      schema: {
        ...templateReadSchema,
        summary: 'Render a template against sample data (no email is sent)',
      },
    },
    async (req) => {
      const { id, eventKey } = EventParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await emailService.previewWithSamples(id, eventKey) };
    },
  );

  app.post(
    '/:id/email-templates/:eventKey/test-send',
    {
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Render the template with sample values and send to a chosen address',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        body: {
          type: 'object',
          required: ['to'],
          properties: { to: { type: 'string', format: 'email', maxLength: 254 } },
        },
      },
    },
    async (req) => {
      const { id, eventKey } = EventParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = TestSendBody.parse(req.body);
      const application = await prisma.application.findUniqueOrThrow({ where: { id } });
      const rendered = await emailService.previewWithSamples(id, eventKey);
      const outcome = await sendEmail(
        application,
        {
          to: body.to,
          subject: `[TEST] ${rendered.subject}`,
          html: rendered.html,
          text: rendered.text,
        },
        { eventKey },
      );
      return { success: true, data: outcome };
    },
  );
}
