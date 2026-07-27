/**
 * Public usage endpoints — the customer's app reports/aggregates here.
 * Tenant operator routes for meter CRUD live in tenant-applications.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { usageService } from './usage.service.js';
import { requireApiKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireBillingEnabled } from '../../middleware/billing-enabled.js';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { env } from '../../config/env.js';

const RecordBody = z.object({
  meterSlug: z.string().min(1).max(40),
  // Positive integers only. Negative/zero quantities would let a billing:write
  // key deflate a metered total below true consumption (under-billing) or poison
  // aggregates — usage events represent consumption, which is never negative.
  quantity: z.number().int().positive(),
  endUserId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  occurredAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
  // OPTIONAL: a retry-safe key (mirrors credits.consume). Same (meter, key)
  // twice → one record. Omit for the historical each-call-counts behavior.
  idempotencyKey: z.string().min(1).max(255).optional(),
});

/** Validate the optional usage subject (end-user OR org, not both) against
 *  the calling Application. Usage may also be subject-less (app-level).
 *  Test/live isolation: when `mode` is set, end-users of the other mode are
 *  invisible (orgs carry no mode in v1). */
async function assertSubjectInApp(
  applicationId: string,
  subject: { endUserId?: string | undefined; organizationId?: string | undefined },
  mode?: import('@prisma/client').DataMode,
): Promise<void> {
  if (subject.endUserId && subject.organizationId) {
    throw new RekeyError({
      statusCode: 400,
      code: 'USAGE_SUBJECT_AMBIGUOUS',
      message: 'Pass at most one of endUserId or organizationId.',
      fix: 'Attribute usage to a single subject (or neither for app-level usage).',
    });
  }
  if (subject.organizationId) {
    const org = await prisma.organization.findFirst({
      where: { id: subject.organizationId, applicationId },
      select: { id: true },
    });
    if (!org) {
      throw new RekeyError({
        statusCode: 404,
        code: 'ORGANIZATION_NOT_FOUND',
        message: `Organization "${subject.organizationId}" not found in this Application.`,
        fix: 'Pass the id of an organization in the Application this key is scoped to.',
      });
    }
  } else if (subject.endUserId) {
    const eu = await prisma.endUser.findFirst({
      where: { id: subject.endUserId, applicationId, ...(mode !== undefined && { mode }) },
      select: { id: true },
    });
    if (!eu) {
      throw new RekeyError({
        statusCode: 404,
        code: 'END_USER_NOT_FOUND',
        message: `End-user "${subject.endUserId}" not found in this Application.`,
        fix: 'Pass the id of an end-user that belongs to this Application (and matches the key\'s test/live mode).',
      });
    }
  }
}

const AggregateQuery = z.object({
  meterSlug: z.string().min(1).max(40),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  endUserId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
});

export async function usagePublicRoutes(app: FastifyInstance): Promise<void> {
  // Server-side only: `requireApiKey` rejects the publishable key outright, so
  // usage can never be recorded (or read) from browser code.
  app.addHook('onRequest', requireApiKey);
  app.addHook('onRequest', requireBillingEnabled);
  // Scope is per-route: recording usage feeds metered billing (`billing:write`),
  // but `/aggregate` only reads, so a deliberately-narrow `billing:read` key can
  // call it. `billing:write` implies `billing:read`, so write keys still work.

  app.post(
    '/record',
    {
      onRequest: requireScope('billing:write'),
      // Higher per-API-key cap for ingestion — keyed per key via the global
      // keyGenerator, so one customer's high scan volume doesn't starve others.
      config: {
        rateLimit: { max: env.RATE_LIMIT_USAGE_MAX, timeWindow: env.RATE_LIMIT_WINDOW_MS },
        // Accept the generic `Idempotency-Key` header as well as the body-level
        // `idempotencyKey` below. The body key dedupes at the RECORD level via
        // the unique (meterId, idempotencyKey) constraint; the header replays the
        // whole HTTP response. `POST /credits/consume` already offers both, and a
        // client retrying blindly should not have to know which mechanism a given
        // route happens to implement.
        idempotency: true,
      },
      schema: {
        tags: ['Public · Usage'],
        summary: 'Record a usage event against a named meter',
        description:
          'Requires an Application **secret** key with the `billing:write` scope (or the ' +
          'legacy `*`). The publishable key is rejected — call this from your server.',
        security: [{ apiKey: [] }],
        body: {
          type: 'object',
          required: ['meterSlug', 'quantity'],
          properties: {
            meterSlug: { type: 'string', minLength: 1, maxLength: 40 },
            quantity: { type: 'integer', minimum: 1 },
            endUserId: { type: 'string' },
            organizationId: { type: 'string' },
            occurredAt: { type: 'string', format: 'date-time' },
            metadata: { type: 'object', additionalProperties: true },
            idempotencyKey: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              description:
                'Optional. A retried record with the same (meter, key) returns the original ' +
                'UsageRecord instead of double-counting. Omit for each-call-counts behavior.',
            },
          },
        },
      },
    },
    async (req, reply) => {
      const body = RecordBody.parse(req.body);
      await assertSubjectInApp(req.application!.id, body, req.dataMode);
      const record = await usageService.record({
        applicationId: req.application!.id,
        meterSlug: body.meterSlug,
        quantity: body.quantity,
        ...(body.endUserId !== undefined && { endUserId: body.endUserId }),
        ...(body.organizationId !== undefined && { organizationId: body.organizationId }),
        ...(body.occurredAt !== undefined && { occurredAt: new Date(body.occurredAt) }),
        ...(body.metadata !== undefined && { metadata: body.metadata }),
        ...(body.idempotencyKey !== undefined && { idempotencyKey: body.idempotencyKey }),
      });
      return reply.status(201).send({ success: true, data: record });
    },
  );

  app.get(
    '/aggregate',
    {
      onRequest: requireScope('billing:read'),
      schema: {
        tags: ['Public · Usage'],
        summary: 'Sum recorded quantity for a meter (with optional time window + end-user filter)',
        description:
          'Accepts a narrow `billing:read` key, since this only reads. A `billing:write` key ' +
          'also works, because write implies read. Secret key only; the publishable key is ' +
          'rejected.',
        querystring: {
          type: 'object',
          required: ['meterSlug'],
          properties: {
            meterSlug: { type: 'string', minLength: 1, maxLength: 40 },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            endUserId: { type: 'string' },
            organizationId: { type: 'string' },
          },
        },
        security: [{ apiKey: [] }],
      },
    },
    async (req) => {
      const q = AggregateQuery.parse(req.query);
      await assertSubjectInApp(req.application!.id, q, req.dataMode);
      const result = await usageService.aggregate({
        applicationId: req.application!.id,
        meterSlug: q.meterSlug,
        ...(q.from !== undefined && { from: new Date(q.from) }),
        ...(q.to !== undefined && { to: new Date(q.to) }),
        ...(q.endUserId !== undefined && { endUserId: q.endUserId }),
        ...(q.organizationId !== undefined && { organizationId: q.organizationId }),
      });
      return { success: true, data: result };
    },
  );
}
