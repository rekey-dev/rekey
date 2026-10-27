/**
 * Operator MCP read tool for one webhook endpoint's delivery attempts, the
 * rows GET /applications/:id/webhooks/:endpointId/deliveries returns.
 */

import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { webhookService } from '../webhooks/webhook.service.js';
import type { OperatorTool } from './operator-tools.js';
import { loadAppInTenant } from './operator-write-tools.js';
import { ApplicationIdArg, defineTool } from './tool-definition.js';

/** Rows written before the write-time cap existed are capped again on read. */
const MAX_RESPONSE_BODY_CHARS = 4096;

export const operatorWebhookReadTools: OperatorTool[] = [
  defineTool({
    name: 'list_webhook_deliveries',
    description:
      "One webhook endpoint's delivery attempts, newest first: event, `status` (PENDING, SUCCEEDED or FAILED), " +
      '`attempts`, `responseStatus`, `error`, `nextAttemptAt`, the `payload` that was POSTed and the consumer\'s ' +
      '`responseBody` (at most 4 KiB). Filter by `status` or `eventType`. Endpoint ids come from ' +
      'recent_failed_webhook_deliveries or the panel.',
    args: z
      .object({
        applicationId: ApplicationIdArg,
        endpointId: z.string().min(1).max(200).describe('The webhook endpoint id.'),
        status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED']).optional(),
        eventType: z.string().min(1).max(100).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).max(1_000_000).default(0),
      })
      .strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'read');
      const endpoint = await prisma.webhookEndpoint.findFirst({
        where: { id: input.endpointId, applicationId: app.id },
        select: { id: true },
      });
      if (!endpoint) {
        throw new RekeyError({
          statusCode: 404,
          code: 'WEBHOOK_ENDPOINT_NOT_FOUND',
          message: 'Webhook endpoint not found in this application.',
          fix: 'Verify the endpoint id. recent_failed_webhook_deliveries lists endpoints that are failing.',
        });
      }
      const filters = {
        ...(input.status !== undefined && { status: input.status }),
        ...(input.eventType !== undefined && { eventType: input.eventType }),
      };
      const [rows, total] = await Promise.all([
        webhookService.listDeliveries(app.id, endpoint.id, { ...filters, limit: input.limit, offset: input.offset }),
        webhookService.countDeliveries(app.id, endpoint.id, filters),
      ]);
      return {
        deliveries: rows.map((r) => ({
          id: r.id,
          eventId: r.eventId,
          eventType: r.eventType,
          status: r.status,
          attempts: r.attempts,
          responseStatus: r.responseStatus,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
          nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
          payload: r.payload,
          responseBody: r.responseBody === null ? null : r.responseBody.slice(0, MAX_RESPONSE_BODY_CHARS),
        })),
        total,
        limit: input.limit,
        offset: input.offset,
        hasMore: input.offset + rows.length < total,
      };
    },
  }),
];
