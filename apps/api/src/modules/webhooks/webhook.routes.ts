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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const endpoints = await webhookService.listEndpoints(id);
      return {
        success: true,
        data: endpoints.map((e) => ({
          id: e.id,
          url: e.url,
          events: e.events,
          enabled: e.enabled,
          createdAt: e.createdAt.toISOString(),
        })),
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
          'any grant on it (grant-less legacy members keep workspace-wide read).',
      },
    },
    async (req) => {
      const { id, endpointId } = EndpointParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      await ensureEndpointInApp(id, endpointId);
      const rows = await webhookService.listDeliveries(id, endpointId);
      return {
        success: true,
        data: rows.map((r) => ({
          id: r.id,
          eventId: r.eventId,
          eventType: r.eventType,
          status: r.status,
          attempts: r.attempts,
          responseStatus: r.responseStatus,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
          nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
        })),
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
