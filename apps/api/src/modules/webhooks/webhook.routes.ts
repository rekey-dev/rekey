/**
 * Tenant-facing webhook management routes.
 *
 *   GET    /api/v1/tenant/applications/:id/webhooks
 *     List endpoints for this Application.
 *
 *   POST   /api/v1/tenant/applications/:id/webhooks
 *     Create. Returns the signing `secret` exactly once — same contract
 *     as API keys. Callers must store it.
 *
 *   PATCH  /api/v1/tenant/applications/:id/webhooks/:endpointId
 *     Edit url/events/enabled.
 *
 *   DELETE /api/v1/tenant/applications/:id/webhooks/:endpointId
 *     HARD delete — the row is removed and cascades away its WebhookDelivery
 *     history. To pause an endpoint without losing the delivery log, PATCH it
 *     with `{ enabled: false }` instead.
 *
 *   POST   /api/v1/tenant/applications/:id/webhooks/:endpointId/rotate-secret
 *     Replace the signing secret. Returns the new raw value once.
 *
 *   GET    /api/v1/tenant/applications/:id/webhooks/:endpointId/deliveries
 *     Recent deliveries for debugging — includes the request body and the
 *     response status/body we got back.
 *
 *   POST   /api/v1/tenant/applications/:id/webhooks/:endpointId/deliveries/:deliveryId/retry
 *     Force a retry of a failed/pending delivery.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import { webhookService } from './webhook.service.js';
import { KNOWN_WEBHOOK_EVENTS } from './events.js';
import { isWebhookUrlSafe } from '../../lib/webhook-signing.js';
import { env } from '../../config/env.js';
import { ok, okPage, errs, ref } from '../../lib/openapi.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';

/**
 * Ceiling on the stored `responseBody` this route returns per delivery.
 *
 * The delivery worker already stops reading at 4 KiB (MAX_RESPONSE_BODY_BYTES
 * in webhook.service.ts), so this only matters for rows written before that cap
 * existed. Re-applied here rather than trusted, because a page of 50 rows is
 * what an operator loads to debug a failure and the size of it should not
 * depend on a historical value.
 */
const MAX_RESPONSE_BODY_CHARS = 4096;

const AppParam = z.object({ id: z.string().min(1) });
const EndpointParam = z.object({
  id: z.string().min(1),
  endpointId: z.string().min(1),
});
const DeliveryParam = z.object({
  id: z.string().min(1),
  endpointId: z.string().min(1),
  deliveryId: z.string().min(1),
});

const EVENT_VALUES = ['*', ...KNOWN_WEBHOOK_EVENTS] as const;

const CreateBody = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.enum(EVENT_VALUES)).min(1),
});

const UpdateBody = z.object({
  url: z.string().url().max(2048).optional(),
  events: z.array(z.enum(EVENT_VALUES)).min(1).optional(),
  enabled: z.boolean().optional(),
});

// Access control: ensureAppAccess (lib/app-access.ts) checks workspace
// ownership AND per-application grants. Webhook endpoints carry signing
// secrets, so mutations are 'write' (APP_ADMIN grant or workspace
// OWNER/ADMIN); listings/deliveries are 'read'.

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

/** `WEBHOOK_ENDPOINT_NOT_FOUND`, from `ensureEndpointInApp` — folded into the write/read 404. */
const ENDPOINT_NOT_FOUND_DESC =
  'WEBHOOK_ENDPOINT_NOT_FOUND — no webhook endpoint with that id on this Application.';

const WebhookEndpointSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    url: { type: 'string', format: 'uri' },
    events: { type: 'array', items: { type: 'string' }, description: '`["*"]` means every event.' },
    enabled: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'url', 'events', 'enabled', 'createdAt'],
} as const;

async function ensureEndpointInApp(applicationId: string, endpointId: string): Promise<void> {
  const ep = await prisma.webhookEndpoint.findUnique({
    where: { id: endpointId },
    select: { applicationId: true },
  });
  if (!ep || ep.applicationId !== applicationId) {
    throw new RekeyError({
      statusCode: 404,
      code: 'WEBHOOK_ENDPOINT_NOT_FOUND',
      message: 'Webhook endpoint not found in this application.',
      fix: 'Verify the endpoint id.',
    });
  }
}

export async function tenantWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/:id/webhooks',
    {
      schema: {
        tags: ['Tenant · Webhooks'],
        security: [{ tenantSession: [] }],
        summary: 'List webhook endpoints for an Application',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(WebhookEndpointSchema, 'A page of webhook endpoints for this Application.'),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            ...APP_READ_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      // Default page size 100, matching the hard `take: 100` this route used
      // before it could page — so an existing caller sees the same rows.
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query), 100);
      const [endpoints, total] = await Promise.all([
        webhookService.listEndpoints(id, { take, skip }),
        webhookService.countEndpoints(id),
      ]);
      return {
        success: true,
        data: paged(
          endpoints.map((e) => ({
            id: e.id,
            url: e.url,
            events: e.events,
            enabled: e.enabled,
            createdAt: e.createdAt.toISOString(),
          })),
          total,
          take,
          skip,
        ),
      };
    },
  );

  app.post(
    '/:id/webhooks',
    {
      schema: {
        tags: ['Tenant · Webhooks'],
        security: [{ tenantSession: [] }],
        summary: 'Create a webhook endpoint. Returns the signing secret once.',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        body: {
          type: 'object',
          required: ['url', 'events'],
          properties: {
            url: { type: 'string', format: 'uri', maxLength: 2048 },
            events: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
        },
        response: {
          201: ok(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                url: { type: 'string', format: 'uri' },
                events: { type: 'array', items: { type: 'string' } },
                enabled: { type: 'boolean' },
                createdAt: { type: 'string', format: 'date-time' },
                secret: {
                  type: 'string',
                  description:
                    'The signing secret, in plaintext. Shown exactly ONCE — store it now. ' +
                    'Use it to verify the `X-Rekey-Signature` header on inbound deliveries.',
                },
                warning: { type: 'string' },
              },
              required: ['id', 'url', 'events', 'enabled', 'createdAt', 'secret', 'warning'],
            },
            'The created endpoint, including the signing secret (shown once).',
          ),
          ...errs({
            400:
              'VALIDATION_ERROR — `url` or `events` failed schema validation; or ' +
              'WEBHOOK_URL_UNSAFE — the URL resolves to a private/loopback/link-local address ' +
              '(unless `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` on a self-hosted deploy).',
            ...APP_WRITE_ERRORS,
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const body = CreateBody.parse(req.body);
      const safety = isWebhookUrlSafe(body.url, {
        allowPrivate: env.WEBHOOK_ALLOW_PRIVATE_TARGETS ?? false,
      });
      if (!safety.ok) {
        throw new RekeyError({
          statusCode: 400,
          code: 'WEBHOOK_URL_UNSAFE',
          message: `Webhook URL is not allowed: ${safety.reason}`,
          fix: 'Use a public HTTPS URL. To enable private targets on a self-hosted deploy, set WEBHOOK_ALLOW_PRIVATE_TARGETS=true.',
        });
      }
      const result = await webhookService.createEndpoint({
        applicationId: id,
        url: body.url,
        events: body.events,
      });
      return reply.status(201).send({
        success: true,
        data: {
          id: result.endpoint.id,
          url: result.endpoint.url,
          events: result.endpoint.events,
          enabled: result.endpoint.enabled,
          createdAt: result.endpoint.createdAt.toISOString(),
          secret: result.secret,
          warning:
            'Store this secret now — it is shown exactly once. Use it to verify the X-Rekey-Signature header on inbound deliveries.',
        },
      });
    },
  );

  app.patch(
    '/:id/webhooks/:endpointId',
    {
      schema: {
        tags: ['Tenant · Webhooks'],
        security: [{ tenantSession: [] }],
        summary: 'Update an endpoint',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        response: {
          200: ok(
            {
              type: 'object',
              // NOTE: unlike GET (list) and POST (create), this handler does not
              // return `createdAt` — see the module report.
              properties: {
                id: { type: 'string' },
                url: { type: 'string', format: 'uri' },
                events: { type: 'array', items: { type: 'string' } },
                enabled: { type: 'boolean' },
              },
              required: ['id', 'url', 'events', 'enabled'],
            },
            'The updated endpoint.',
          ),
          ...errs({
            400:
              'VALIDATION_ERROR — `url` or `events` failed schema validation; or ' +
              'WEBHOOK_URL_UNSAFE — the new URL resolves to a private/loopback/link-local address.',
            ...APP_WRITE_ERRORS,
            404: `${APP_WRITE_ERRORS[404]}; or ${ENDPOINT_NOT_FOUND_DESC}`,
          }),
        },
      },
    },
    async (req) => {
      const { id, endpointId } = EndpointParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await ensureEndpointInApp(id, endpointId);
      const body = UpdateBody.parse(req.body);
      if (body.url !== undefined) {
        const safety = isWebhookUrlSafe(body.url, {
          allowPrivate: env.WEBHOOK_ALLOW_PRIVATE_TARGETS ?? false,
        });
        if (!safety.ok) {
          throw new RekeyError({
            statusCode: 400,
            code: 'WEBHOOK_URL_UNSAFE',
            message: `Webhook URL is not allowed: ${safety.reason}`,
            fix: 'Use a public HTTPS URL. To enable private targets on a self-hosted deploy, set WEBHOOK_ALLOW_PRIVATE_TARGETS=true.',
          });
        }
      }
      const updated = await webhookService.updateEndpoint({
        applicationId: id,
        endpointId,
        ...(body.url !== undefined && { url: body.url }),
        ...(body.events !== undefined && { events: body.events }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
      });
      return {
        success: true,
        data: {
          id: updated.id,
          url: updated.url,
          events: updated.events,
          enabled: updated.enabled,
        },
      };
    },
  );

  app.delete(
    '/:id/webhooks/:endpointId',
    {
      schema: {
        tags: ['Tenant · Webhooks'],
        security: [{ tenantSession: [] }],
        summary: 'Remove an endpoint',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: { deleted: { type: 'boolean', enum: [true] } },
              required: ['deleted'],
            },
            // deleteEndpoint is a scoped deleteMany with no existence check —
            // this always answers 200, even when endpointId does not exist
            // (or belongs to a different Application). Idempotent by design.
            'Deleted (idempotent — also 200 when the id did not exist).',
          ),
          ...errs(APP_WRITE_ERRORS),
        },
      },
    },
    async (req) => {
      const { id, endpointId } = EndpointParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await webhookService.deleteEndpoint(id, endpointId);
      return { success: true, data: { deleted: true } };
    },
  );

  app.post(
    '/:id/webhooks/:endpointId/rotate-secret',
    {
      schema: {
        tags: ['Tenant · Webhooks'],
        security: [{ tenantSession: [] }],
        summary: 'Rotate the endpoint\'s signing secret. Returns the new value once.',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                secret: {
                  type: 'string',
                  description: 'The new signing secret, in plaintext. Shown exactly ONCE.',
                },
                warning: { type: 'string' },
              },
              required: ['secret', 'warning'],
            },
            'The new signing secret (shown once).',
          ),
          ...errs({ ...APP_WRITE_ERRORS, 404: `${APP_WRITE_ERRORS[404]}; or ${ENDPOINT_NOT_FOUND_DESC}` }),
        },
      },
    },
    async (req) => {
      const { id, endpointId } = EndpointParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await ensureEndpointInApp(id, endpointId);
      const secret = await webhookService.rotateSecret(id, endpointId);
      return {
        success: true,
        data: {
          secret,
          warning:
            'Update your consumer immediately with the new secret. Existing in-flight deliveries are signed with the new value already; old signatures will fail to verify.',
        },
      };
    },
  );

  app.get(
    '/:id/webhooks/:endpointId/deliveries',
    {
      schema: {
        tags: ['Tenant · Webhooks'],
        security: [{ tenantSession: [] }],
        summary: 'List recent delivery attempts for an endpoint',
        description:
          'Requires **read** access to this Application — OWNER/ADMIN, or a MEMBER holding ' +
          'any grant on it. A MEMBER with no grant on this Application gets 404.\n\n' +
          'Each row carries the `payload` that was POSTed and the consumer\'s `responseBody` ' +
          '(truncated) — the two things you actually need when an endpoint is failing. ' +
          'Filter with `?status=FAILED` and page with `limit` / `offset`.',
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED'] },
            eventType: { type: 'string', maxLength: 100 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0, maximum: 2147483647 },
          },
        },
        response: {
          200: okPage(
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                eventId: { type: 'string' },
                eventType: { type: 'string' },
                status: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED'] },
                attempts: { type: 'integer' },
                responseStatus: { type: 'integer', nullable: true },
                error: { type: 'string', nullable: true },
                createdAt: { type: 'string', format: 'date-time' },
                nextAttemptAt: { type: 'string', format: 'date-time', nullable: true },
                payload: {
                  type: 'object',
                  description: 'The event envelope that was POSTed to the endpoint.',
                },
                responseBody: {
                  type: 'string',
                  nullable: true,
                  description: "The consumer's response body, truncated to 4 KiB.",
                },
              },
              required: [
                'id',
                'eventId',
                'eventType',
                'status',
                'attempts',
                'responseStatus',
                'error',
                'createdAt',
                'nextAttemptAt',
                'payload',
                'responseBody',
              ],
            },
            'Recent delivery attempts for this endpoint, newest first.',
          ),
          ...errs({ ...APP_READ_ERRORS, 404: `${APP_READ_ERRORS[404]}; or ${ENDPOINT_NOT_FOUND_DESC}` }),
        },
      },
    },
    async (req) => {
      const { id, endpointId } = EndpointParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      await ensureEndpointInApp(id, endpointId);
      // Not `.strict()`, unlike the billing-config PATCH body. An unknown key
      // in a PATCH body is a typo'd instruction that would otherwise be
      // silently dropped; an unknown key on a GET query string is a
      // cache-buster or an analytics param, and 400-ing those breaks callers
      // for no benefit. A bad VALUE for a known param is still refused.
      const q = z
        .object({
          status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']).optional(),
          eventType: z.string().min(1).max(100).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
        })
        .parse(req.query ?? {});
      const filters = {
        ...(q.status !== undefined && { status: q.status }),
        ...(q.eventType !== undefined && { eventType: q.eventType }),
      };
      // The service clamps limit to 1..100 and defaults it to 50 — mirror both
      // so `page` describes the window that was served.
      const limit = Math.min(q.limit ?? 50, 100);
      const offset = q.offset ?? 0;
      const [rows, total] = await Promise.all([
        webhookService.listDeliveries(id, endpointId, { ...filters, limit, offset }),
        webhookService.countDeliveries(id, endpointId, filters),
      ]);
      return {
        success: true,
        data: paged(
          rows.map((r) => ({
            id: r.id,
            eventId: r.eventId,
            eventType: r.eventType,
            status: r.status,
            attempts: r.attempts,
            responseStatus: r.responseStatus,
            error: r.error,
            createdAt: r.createdAt.toISOString(),
            nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
            // The two fields this route read out of the database and then threw
            // away, while its own docblock said it returned them. An operator
            // looking at "12/12 failing" needs to see what was sent and what came
            // back; without these the page can only say that it failed.
            //
            // Neither is a new disclosure: `payload` is the event this operator's
            // own Application emitted, and `responseBody` is their own consumer's
            // reply. Both are already capped at write time (4 KiB for the
            // response body, see webhook.service.ts) and re-capped here so a row
            // written before that cap existed cannot bloat this page.
            payload: r.payload,
            responseBody:
              r.responseBody === null ? null : r.responseBody.slice(0, MAX_RESPONSE_BODY_CHARS),
          })),
          total,
          limit,
          offset,
        ),
      };
    },
  );

  app.post(
    '/:id/webhooks/:endpointId/deliveries/:deliveryId/retry',
    {
      schema: {
        tags: ['Tenant · Webhooks'],
        security: [{ tenantSession: [] }],
        summary: 'Force a re-attempt of a failed delivery',
        description:
          'Requires **write** access to this Application — OWNER/ADMIN, or a MEMBER with an ' +
          '`APP_ADMIN` grant on it.',
        response: {
          200: ok(ref('RetryWebhookDeliveryResult'), 'The retry was queued.'),
          ...errs({
            ...APP_WRITE_ERRORS,
            404:
              `${APP_WRITE_ERRORS[404]}; or ${ENDPOINT_NOT_FOUND_DESC}; or ` +
              'WEBHOOK_DELIVERY_NOT_FOUND — no delivery with that id on this endpoint, or it ' +
              'already SUCCEEDED.',
          }),
        },
      },
    },
    async (req) => {
      const { id, endpointId, deliveryId } = DeliveryParam.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await ensureEndpointInApp(id, endpointId);
      const queued = await webhookService.retryDelivery(id, endpointId, deliveryId);
      if (!queued) {
        throw new RekeyError({
          statusCode: 404,
          code: 'WEBHOOK_DELIVERY_NOT_FOUND',
          message: 'Delivery not found in this endpoint (or it already succeeded).',
          fix: 'List deliveries via GET .../deliveries and retry a PENDING or FAILED row.',
        });
      }
      return { success: true, data: { queued: true } };
    },
  );
}
