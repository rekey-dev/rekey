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
 *     panel produced from the Unlayer designJson, we don't recompile
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
 * `ensureAppAccess` helper, which also enforces per-application grants).
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
import { ok, okArray, okPage, errs, ref } from '../../lib/openapi.js';
import {
  paged,
  paginationJsonSchema,
  parsePagination,
  PaginationQuery,
} from '../../lib/pagination.js';

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
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  // `suppressed` is the fourth outcome, written by the email kill switch
  // (application off, event off, or the address on the suppression list). It
  // has to be filterable: the Settings and Templates copy sends an operator
  // here to find out WHY a mail did not go, and without it the query 400s.
  status: z.enum(['sent', 'error', 'no_transport', 'suppressed']).optional(),
});

const UpsertTemplateBody = z.object({
  subject: z.string().min(1).max(998),
  designJson: z.unknown(),
  bodyHtml: z.string().min(1).max(1024 * 200), // 200 KB cap, enough for a complex template, blocks pathological abuse.
  bodyText: z.string().max(1024 * 50).nullable().optional(),
});

const TestSendBody = z.object({
  to: z.string().email().max(254),
});

// Access control: ensureAppAccess (lib/app-access.ts) checks workspace
// ownership AND per-application grants. Transport credentials + template
// mutations are 'write' (APP_ADMIN grant or workspace OWNER/ADMIN); config,
// logs, template reads, and previews are 'read'.

/** Every route here sits behind `requireTenantSession` (plugin `onRequest` hook). */
const TENANT_SESSION_ERRORS = {
  401:
    'TENANT_SESSION_MISSING — no `Authorization: Bearer <accessToken>` header; or ' +
    'TENANT_SESSION_INVALID — the token is invalid, expired, or the operator account no ' +
    'longer exists.',
  429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
} as const;

/** Errors from `ensureAppAccess(req, id, 'read')`. */
const APP_READ_ERRORS = {
  ...TENANT_SESSION_ERRORS,
  403: 'TENANT_MEMBERSHIP_REVOKED — you are no longer a member of this workspace.',
  404:
    'APPLICATION_NOT_FOUND — no Application with that id in this workspace (also returned, ' +
    'without disclosing existence, when a MEMBER holds no grant on it).',
};

/** Errors from `ensureAppAccess(req, id, 'write')`. */
const APP_WRITE_ERRORS = {
  ...TENANT_SESSION_ERRORS,
  403:
    'TENANT_MEMBERSHIP_REVOKED — you are no longer a member of this workspace; or ' +
    'TENANT_ROLE_INSUFFICIENT — a legacy MEMBER (no application grants anywhere) cannot ' +
    'write; or APP_ACCESS_DENIED — your application grant role does not allow this action ' +
    '(requires APP_ADMIN).',
  404:
    'APPLICATION_NOT_FOUND — no Application with that id in this workspace (also returned, ' +
    'without disclosing existence, when a MEMBER holds no grant on it).',
};

/** `EMAIL_EVENT_UNKNOWN`, folded into the same 404 status as `APPLICATION_NOT_FOUND`. */
const EMAIL_EVENT_UNKNOWN_DESC =
  'EMAIL_EVENT_UNKNOWN — `eventKey` is not in the event registry (see GET .../email-templates).';

/** One suppressed address, as the routes return it. */
const EMAIL_SUPPRESSION = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    applicationId: { type: 'string' },
    address: { type: 'string', format: 'email' },
    reason: { type: 'string', enum: ['manual', 'bounce', 'complaint', 'unsubscribe'] },
    note: { type: 'string', nullable: true },
    createdBy: { type: 'string', nullable: true, description: 'Operator id, or null when Rekey added it.' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'applicationId', 'address', 'reason', 'note', 'createdBy', 'createdAt'],
} as const;

export async function tenantEmailRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  // ---------- Send control: master switch, per-event, suppressions ----------
  //
  // Until these existed `dispatch` had no gate at all: an Application with a
  // transport configured sent everything it was asked to send, and there was no
  // way to stop it, not globally, not per event, not for one address. A
  // product whose own backend already sends transactional mail therefore
  // delivered two of everything, with no lever.

  app.get(
    '/:id/email-send-control',
    {
      config: { access: { scope: 'developer:read' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Get the master switch and every email event with its state',
        description:
          'Requires **read** access to this Application.\n\n' +
          'Each event reports whether it is enabled, whether its template has been customised, and, ' +
          'when it cannot currently be switched off, why, as `essentialBlocker`. Three of the ' +
          'nine are load-bearing: disabling one silently removes the only way a user completes a ' +
          'flow the Application still offers, so they are refused while that flow is live rather ' +
          'than merely warned about.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                emailsEnabled: {
                  type: 'boolean',
                  description: 'Master switch. False stops every Application-scoped email.',
                },
                events: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      key: { type: 'string' },
                      label: { type: 'string' },
                      enabled: { type: 'boolean' },
                      customised: { type: 'boolean' },
                      essentialBlocker: {
                        type: 'object',
                        nullable: true,
                        description:
                          'Present when this event cannot be disabled right now; null when it can.',
                        properties: {
                          code: { type: 'string' },
                          message: { type: 'string' },
                          fix: { type: 'string' },
                        },
                        required: ['code', 'message', 'fix'],
                      },
                      systemScoped: {
                        type: 'boolean',
                        description:
                          'True for an event Rekey sends to the WORKSPACE (workspace_invitation, ' +
                          'billing_unapplied_payment) rather than one this Application sends to its ' +
                          'end-users. Those go out through an ungated system path, so no switch ' +
                          'here reaches them and none is offered.',
                      },
                    },
                    required: [
                      'key',
                      'label',
                      'enabled',
                      'customised',
                      'essentialBlocker',
                      'systemScoped',
                    ],
                  },
                },
              },
              required: ['emailsEnabled', 'events'],
            },
            'The master switch and the per-event state.',
          ),
          ...errs(APP_READ_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const application = await prisma.application.findUniqueOrThrow({ where: { id } });
      return { success: true, data: await emailService.getSendControl(application) };
    },
  );

  app.patch(
    '/:id/email-send-control',
    {
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Turn every email for this Application on or off',
        description:
          'Requires **write** access to this Application.\n\n' +
          '`false` stops every Application-scoped email: verification, reset, magic link, welcome, ' +
          'dunning, all of it. Each attempted send is still RECORDED, with `status: "suppressed"`, ' +
          'so the Delivery view can answer "why did they not get it".\n\n' +
          'Workspace and operator mail (invitations, operator MFA) is deliberately unaffected: an ' +
          'Application-level switch must not be able to lock operators out of their own workspace.\n\n' +
          '**This does not hand you the tokens instead.** A suppressed send reports as a failed ' +
          'send, so a reset or magic-link token is withheld rather than returned to the caller. If ' +
          'your own backend needs to deliver those, leave email on and remove the transport ' +
          'credentials, that is the documented no-transport contract.\n\n' +
          'Refused with 409 while the live auth config depends on any email this would silence: ' +
          'password sign-in needs the reset email, magic-link sign-in IS its email, and required ' +
          'verification needs the verification email. Turn those methods off first.',
        body: {
          type: 'object',
          required: ['emailsEnabled'],
          properties: { emailsEnabled: { type: 'boolean' } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: { emailsEnabled: { type: 'boolean' } },
              required: ['emailsEnabled'],
            },
            'The new state of the master switch.',
          ),
          ...errs({
            ...APP_WRITE_ERRORS,
            409: 'EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG: a live auth method depends on an email this switch would silence.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = z.object({ emailsEnabled: z.boolean() }).parse(req.body);
      await emailService.setEmailsEnabled(id, body.emailsEnabled);
      return { success: true, data: { emailsEnabled: body.emailsEnabled } };
    },
  );

  app.patch(
    '/:id/email-send-control/:eventKey',
    {
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Turn one email event on or off',
        description:
          'Requires **write** access to this Application.\n\n' +
          'Independent of whether the template is customised: turning an event off must not require ' +
          'rewriting its body first, and deleting a customisation must not re-enable something ' +
          'somebody switched off.\n\n' +
          'Refused with 409 while the live auth config depends on the event, the password-reset ' +
          'mail while password sign-in is on, the magic-link mail while magic-link sign-in is on, ' +
          'the verification mail while verification is required. The refusal names the setting to ' +
          'change first.',
        body: {
          type: 'object',
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: { enabled: { type: 'boolean' } },
              required: ['enabled'],
            },
            'The new state of this event.',
          ),
          ...errs({
            ...APP_WRITE_ERRORS,
            404: `${APP_WRITE_ERRORS[404]}; or ${EMAIL_EVENT_UNKNOWN_DESC}`,
            409: 'EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG — a live auth method depends on this email.',
          }),
        },
      },
    },
    async (req) => {
      const { id, eventKey } = EventParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      if (!isKnownEvent(eventKey)) {
        throw new RekeyError({
          statusCode: 404,
          code: 'EMAIL_EVENT_UNKNOWN',
          message: `Email event "${eventKey}" is not in the registry.`,
          fix: 'Use one of the events returned by GET /api/v1/tenant/applications/:id/email-send-control.',
        });
      }
      const body = z.object({ enabled: z.boolean() }).parse(req.body);
      const application = await prisma.application.findUniqueOrThrow({ where: { id } });
      await emailService.setEventEnabled(application, eventKey, body.enabled);
      return { success: true, data: { enabled: body.enabled } };
    },
  );

  app.get(
    '/:id/email-suppressions',
    {
      config: { access: { scope: 'developer:read' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'List addresses this Application will not email',
        description:
          'Requires **read** access to this Application. Newest first. The narrowest of the three ' +
          'gates, and the only one about a person rather than about configuration.',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(EMAIL_SUPPRESSION, 'A page of suppressed addresses.'),
          ...errs(APP_READ_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const { items, total } = await emailService.listSuppressions(id, { take, skip });
      return { success: true, data: paged(items, total, take, skip) };
    },
  );

  app.post(
    '/:id/email-suppressions',
    {
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Stop emailing one address',
        description:
          'Requires **write** access to this Application.\n\n' +
          'Outranks every other gate, including a password reset: an address that hard-bounced ' +
          'cannot receive one anyway, and mailing a complainant again is how a sending domain gets ' +
          'blocked.\n\n' +
          'Idempotent on the address, re-adding updates the reason and note rather than failing.',
        body: {
          type: 'object',
          required: ['address'],
          properties: {
            address: { type: 'string', format: 'email', maxLength: 254 },
            reason: {
              type: 'string',
              enum: ['manual', 'bounce', 'complaint', 'unsubscribe'],
              default: 'manual',
            },
            note: { type: 'string', maxLength: 500 },
          },
        },
        response: {
          201: ok(EMAIL_SUPPRESSION, 'The suppressed address.'),
          ...errs(APP_WRITE_ERRORS),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = z
        .object({
          address: z.string().email().max(254),
          reason: z.enum(['manual', 'bounce', 'complaint', 'unsubscribe']).default('manual'),
          note: z.string().max(500).optional(),
        })
        .parse(req.body);
      const row = await emailService.addSuppression({
        applicationId: id,
        address: body.address,
        reason: body.reason,
        ...(body.note !== undefined && { note: body.note }),
        createdBy: req.tenantUser?.id ?? null,
      });
      return reply.status(201).send({ success: true, data: row });
    },
  );

  app.delete(
    '/:id/email-suppressions/:address',
    {
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Start emailing an address again',
        description:
          'Requires **write** access to this Application. Idempotent: an address that is not ' +
          'suppressed answers `removed: false` rather than 404.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: { removed: { type: 'boolean' } },
              required: ['removed'],
            },
            'Whether this call removed a suppression.',
          ),
          ...errs(APP_WRITE_ERRORS),
        },
      },
    },
    async (req) => {
      const { id, address } = z
        .object({ id: z.string().min(1), address: z.string().min(1).max(254) })
        .parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const removed = await emailService.removeSuppression(id, address);
      return { success: true, data: { removed } };
    },
  );

  app.get(
    '/:id/email-stats',
    {
      config: { access: { scope: 'developer:read' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Send outcomes over a recent window',
        description:
          'Requires **read** access to this Application. Counted from `email_logs`, so ' +
          '`suppressed` is visible alongside `sent`, a suppression is an outcome, not an absence.',
        querystring: {
          type: 'object',
          properties: { hours: { type: 'integer', minimum: 1, maximum: 720, default: 24 } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                sent: { type: 'integer' },
                error: { type: 'integer' },
                noTransport: { type: 'integer' },
                suppressed: { type: 'integer' },
              },
              required: ['sent', 'error', 'noTransport', 'suppressed'],
            },
            'Counts by outcome over the window.',
          ),
          ...errs(APP_READ_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { hours } = z
        .object({ hours: z.coerce.number().int().min(1).max(720).default(24) })
        .parse(req.query);
      return { success: true, data: await emailService.sendStats(id, hours) };
    },
  );

  // ---------- Config + credentials ----------

  app.get(
    '/:id/email-config',
    {
      config: { access: { scope: 'developer:read' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: "Get an Application's email config and effective transport",
        description:
          'Requires **read** access to this Application, OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                emailConfig: {
                  type: 'object',
                  nullable: true,
                  description: 'The `{fromAddress, fromName?, replyTo?}` sender identity, or null if unset.',
                  properties: {
                    fromAddress: { type: 'string', format: 'email' },
                    fromName: { type: 'string' },
                    replyTo: { type: 'string', format: 'email' },
                  },
                },
                hasCustomCredentials: {
                  type: 'boolean',
                  description: 'True when this Application has BYO Resend/SMTP credentials configured.',
                },
                transport: {
                  type: 'string',
                  enum: ['byo_resend', 'byo_smtp', 'default_resend', 'none'],
                  description: 'Which transport a send would actually use right now.',
                },
                provider: {
                  type: 'string',
                  enum: ['resend', 'smtp', 'default', 'none'],
                },
                effectiveFromAddress: {
                  type: 'string',
                  nullable: true,
                  description: 'The `from` address a send would use, or null when no transport is configured.',
                },
              },
              required: ['hasCustomCredentials', 'transport', 'provider', 'effectiveFromAddress'],
            },
            "The Application's email config and effective transport.",
          ),
          ...errs(APP_READ_ERRORS),
        },
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
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: "Set or rotate the Application's BYO email transport (Resend or SMTP) + sender",
        description:
          'Requires **write** access to this Application, OWNER/ADMIN, or a MEMBER with an ' +
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
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                configured: { type: 'boolean', enum: [true] },
                provider: { type: 'string', enum: ['resend', 'smtp'] },
              },
              required: ['configured', 'provider'],
            },
            'Credentials stored.',
          ),
          ...errs({
            400:
              'VALIDATION_ERROR — the body does not match the discriminated `resend`/`smtp` ' +
              'credential shape for the given (or defaulted) `provider`.',
            ...APP_WRITE_ERRORS,
          }),
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
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Revert this Application to the default (or no) email transport',
        description:
          'Requires **write** access to this Application, OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: { configured: { type: 'boolean', enum: [false] } },
              required: ['configured'],
            },
            'Reverted to the default (or no) transport.',
          ),
          ...errs(APP_WRITE_ERRORS),
        },
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
      config: { access: { scope: 'developer:read' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'List recent email send-logs for this Application',
        description:
          'Requires **read** access to this Application, OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0, maximum: 2147483647 },
            status: { type: 'string', enum: ['sent', 'error', 'no_transport', 'suppressed'] },
          },
        },
        response: {
          // The item shape is `EmailLogRow` (email.service.ts), which matches the
          // corrected `EmailLog` component field-for-field.
          200: okPage(ref('EmailLog'), 'A page of email send-log rows for this Application, newest first.'),
          ...errs(APP_READ_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const q = LogQuery.parse(req.query);
      // The service defaults to 100 when no limit is sent, mirror it so
      // `page.limit` describes the window that was served.
      const limit = q.limit ?? 100;
      const offset = q.offset ?? 0;
      const [rows, total] = await Promise.all([
        emailService.listAppLogs({
          applicationId: id,
          limit,
          offset,
          ...(q.status !== undefined && { status: q.status }),
        }),
        emailService.countAppLogs({
          applicationId: id,
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

  // ---------- Templates ----------

  /**
   * Shared schema head for the three template READ routes below. They all sit
   * behind `requireTenantSession` (plugin hook) + `ensureAppAccess(id, 'read')`.
   */
  const templateReadSchema = {
    tags: ['Tenant · Email'],
    security: [{ tenantSession: [] }],
    description:
      'Requires **read** access to this Application, OWNER/ADMIN, or a MEMBER holding ' +
      'any grant on it. A MEMBER with no grant on this Application gets 404.',
  };

  app.get(
    '/:id/email-templates',
    {
      config: { access: { scope: 'developer:read' } },
      schema: {
        ...templateReadSchema,
        summary: 'List customisable email events',
        response: {
          // Bounded by construction, the fixed EMAIL_EVENTS registry, not
          // tenant data. A bare array is correct here, not a defect.
          200: okArray(
            {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Event key, e.g. "verify_email".' },
                label: { type: 'string' },
                customised: { type: 'boolean', description: 'True when this Application has overridden it.' },
              },
              required: ['key', 'label', 'customised'],
            },
            'Every event this Application can customise, and whether it has been.',
          ),
          ...errs(APP_READ_ERRORS),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await emailService.listEvents(id) };
    },
  );

  app.get(
    '/:id/email-templates/:eventKey',
    {
      config: { access: { scope: 'developer:read' } },
      schema: {
        ...templateReadSchema,
        summary: 'Get the template for one event',
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                subject: { type: 'string' },
                bodyHtml: { type: 'string' },
                bodyText: { type: 'string', nullable: true },
                customised: {
                  type: 'boolean',
                  description: 'True when this came from a saved EmailTemplate row rather than the built-in default.',
                },
                designJson: {
                  nullable: true,
                  description: 'Opaque Unlayer design document, present only when `customised` is true.',
                },
                variables: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Template variables the panel builder may offer as preview chips.',
                },
              },
              required: ['subject', 'bodyHtml', 'bodyText', 'customised', 'designJson', 'variables'],
            },
            'The active template (customised or built-in default) for this event.',
          ),
          ...errs({ ...APP_READ_ERRORS, 404: `${APP_READ_ERRORS[404]}; or ${EMAIL_EVENT_UNKNOWN_DESC}` }),
        },
      },
    },
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
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Upsert a customised template for one event',
        description:
          'Requires **write** access to this Application, OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: { id: { type: 'string' }, eventKey: { type: 'string' } },
              required: ['id', 'eventKey'],
            },
            'The saved template row (id + eventKey only).',
          ),
          ...errs({
            400: 'VALIDATION_ERROR — `subject`, `bodyHtml`, or `bodyText` failed schema validation.',
            ...APP_WRITE_ERRORS,
            404: `${APP_WRITE_ERRORS[404]}; or ${EMAIL_EVENT_UNKNOWN_DESC}`,
          }),
        },
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
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Revert one event to the built-in default template',
        description:
          'Requires **write** access to this Application, OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: { reverted: { type: 'boolean', enum: [true] } },
              required: ['reverted'],
            },
            // An unknown `eventKey` is silently a no-op (see emailService.deleteTemplate),
            // this always answers 200, never EMAIL_EVENT_UNKNOWN.
            'Reverted (or already at default, this is idempotent and does not 404 on an ' +
              'unknown eventKey).',
          ),
          ...errs(APP_WRITE_ERRORS),
        },
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
      config: { access: { scope: 'developer:read' } },
      schema: {
        ...templateReadSchema,
        summary: 'Render a template against sample data (no email is sent)',
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                subject: { type: 'string' },
                html: { type: 'string' },
                text: { type: 'string' },
                customised: { type: 'boolean' },
              },
              required: ['subject', 'html', 'text', 'customised'],
            },
            "The event's sample values rendered through the active template.",
          ),
          ...errs({ ...APP_READ_ERRORS, 404: `${APP_READ_ERRORS[404]}; or ${EMAIL_EVENT_UNKNOWN_DESC}` }),
        },
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
      config: { access: { scope: 'developer:write' } },
      schema: {
        tags: ['Tenant · Email'],
        security: [{ tenantSession: [] }],
        summary: 'Render the template with sample values and send to a chosen address',
        description:
          'Requires **write** access to this Application, OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        body: {
          type: 'object',
          required: ['to'],
          properties: { to: { type: 'string', format: 'email', maxLength: 254 } },
        },
        response: {
          200: ok(
            {
              type: 'object',
              description:
                'The transport outcome. `kind: "sent"`, delivered; `kind: "no_transport"`, no ' +
                'Resend/SMTP transport configured (BYO or default pool); `kind: "error"`, the ' +
                'provider rejected or the send failed.',
              properties: {
                kind: { type: 'string', enum: ['sent', 'no_transport', 'error'] },
                messageId: {
                  type: 'string',
                  nullable: true,
                  description: 'Present when `kind` is "sent".',
                },
                via: {
                  type: 'string',
                  enum: ['byo_resend', 'byo_smtp', 'default_resend'],
                  description: 'Present when `kind` is "sent".',
                },
                message: {
                  type: 'string',
                  description: 'Present when `kind` is "error", a tenant-safe failure description.',
                },
              },
              required: ['kind'],
            },
            'The test send outcome.',
          ),
          ...errs({
            400: 'VALIDATION_ERROR — `to` is missing or not a valid email.',
            ...APP_WRITE_ERRORS,
            404: `${APP_WRITE_ERRORS[404]}; or ${EMAIL_EVENT_UNKNOWN_DESC}`,
            409:
              'EMAIL_ADDRESS_SUPPRESSED — that address is on this Application’s suppression ' +
              'list. A test send deliberately bypasses the master switch and the per-event ' +
              'switch, but never the suppression list: mailing a hard-bounced or complaining ' +
              'address again is how a sending domain gets blocked.',
          }),
        },
      },
    },
    async (req) => {
      const { id, eventKey } = EventParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = TestSendBody.parse(req.body);
      const application = await prisma.application.findUniqueOrThrow({ where: { id } });
      const rendered = await emailService.previewWithSamples(id, eventKey);
      // A test send deliberately IGNORES the Application's master switch and
      // the per-event switch: an operator configuring transport has to be able
      // to prove it works before turning sending back on, and that is the
      // whole purpose of this route.
      //
      // It does NOT ignore the SUPPRESSION LIST. That list holds addresses
      // that hard-bounced or filed a complaint, and mailing a complainant
      // again is how a sending domain gets blocked. "It was only a test" is
      // not a distinction the receiving mailbox provider makes.
      const suppressed = await emailService.addressSuppression(id, body.to);
      if (suppressed !== null) {
        throw new RekeyError({
          statusCode: 409,
          code: 'EMAIL_ADDRESS_SUPPRESSED',
          message: `${body.to} is on this Application's suppression list (${suppressed.reason}).`,
          fix: 'Test with a different address. Sending to a hard-bounced or complaining address again is how a sending domain gets blocked, remove it from Email → Suppressions only if you know the bounce is resolved.',
        });
      }
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
