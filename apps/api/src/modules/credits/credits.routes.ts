/**
 * Public credits endpoints — the customer's backend reads balances and draws
 * credits down (server-to-server, secret key).
 *
 * Subject: pass `endUserId` for a personal balance OR `organizationId` for a
 * shared org pool (exactly one). The secret key already scopes to the
 * Application, so the backend may manage any subject inside its own app.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { creditsService, type CreditSubjectInput } from './credits.service.js';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { requireApiKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireBillingEnabled } from '../../middleware/billing-enabled.js';

const subjectFields = {
  endUserId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
};
const exactlyOneSubject = (d: {
  endUserId?: string | undefined;
  organizationId?: string | undefined;
}): boolean => Boolean(d.endUserId) !== Boolean(d.organizationId);
const subjectRefine = { message: 'Pass exactly one of endUserId or organizationId.' };

const BalanceQuery = z.object(subjectFields).refine(exactlyOneSubject, subjectRefine);
const LedgerQuery = z
  .object({
    ...subjectFields,
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .refine(exactlyOneSubject, subjectRefine);
const ConsumeBody = z
  .object({
    ...subjectFields,
    amount: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    description: z.string().max(500).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine(exactlyOneSubject, subjectRefine);

/** Validate + resolve the subject against the calling Application. */
async function resolveSubject(
  applicationId: string,
  input: { endUserId?: string | undefined; organizationId?: string | undefined },
): Promise<{ subject: CreditSubjectInput; label: { endUserId?: string; organizationId?: string } }> {
  if (input.organizationId) {
    const org = await prisma.organization.findFirst({
      where: { id: input.organizationId, applicationId },
      select: { id: true },
    });
    if (!org) {
      throw new RekeyError({
        statusCode: 404,
        code: 'ORGANIZATION_NOT_FOUND',
        message: `Organization "${input.organizationId}" not found in this Application.`,
        fix: 'Pass the id of an organization in the Application this key is scoped to.',
      });
    }
    return { subject: { organizationId: input.organizationId }, label: { organizationId: input.organizationId } };
  }
  const eu = await prisma.endUser.findFirst({
    where: { id: input.endUserId!, applicationId },
    select: { id: true },
  });
  if (!eu) {
    throw new RekeyError({
      statusCode: 404,
      code: 'END_USER_NOT_FOUND',
      message: `End-user "${input.endUserId}" not found in this Application.`,
      fix: 'Pass the id of an end-user that belongs to the Application this key names.',
    });
  }
  return { subject: { endUserId: input.endUserId! }, label: { endUserId: input.endUserId! } };
}

export async function creditsPublicRoutes(app: FastifyInstance): Promise<void> {
  // Server-side only: `requireApiKey` rejects the publishable key outright.
  app.addHook('onRequest', requireApiKey);
  app.addHook('onRequest', requireBillingEnabled);
  // Scope is per-route, not per-plugin: the reads take `billing:read` so a
  // deliberately-narrow read-only key works. `billing:write` implies
  // `billing:read` in SCOPE_IMPLICATIONS, so existing write keys are unaffected.

  app.get(
    '/balance',
    {
      onRequest: requireScope('billing:read'),
      schema: {
        tags: ['Public · Credits'],
        summary: "Get a subject's current credit balance (end-user or org)",
        description:
          'Accepts a narrow `billing:read` key, since this only reads. A `billing:write` ' +
          'key also works, because write implies read. Secret key only; the publishable ' +
          'key is rejected.',
        security: [{ apiKey: [] }],
        querystring: {
          type: 'object',
          properties: { endUserId: { type: 'string' }, organizationId: { type: 'string' } },
        },
      },
    },
    async (req) => {
      const applicationId = req.application!.id;
      const { subject, label } = await resolveSubject(applicationId, BalanceQuery.parse(req.query));
      const balance = await creditsService.getBalance(applicationId, subject);
      return { success: true, data: { applicationId, ...label, balance } };
    },
  );

  app.post(
    '/consume',
    {
      onRequest: requireScope('billing:write'),
      // Generic Idempotency-Key HEADER support (scoped to the Application).
      // Distinct from the body-level `idempotencyKey` below, which dedupes at
      // the credit-ledger level and keeps working unchanged — the header is
      // the route-agnostic mechanism, the body field the ledger-native one.
      config: { idempotency: true },
      schema: {
        tags: ['Public · Credits'],
        summary: 'Deduct credits from a subject (idempotent)',
        description:
          'Atomically debits `amount` from the end-user or org pool. 402 CREDITS_INSUFFICIENT ' +
          'when too low. Pass `idempotencyKey` (or an `Idempotency-Key` header) to make retries safe.',
        security: [{ apiKey: [] }],
        body: {
          type: 'object',
          required: ['amount'],
          properties: {
            endUserId: { type: 'string' },
            organizationId: { type: 'string' },
            amount: { type: 'integer', minimum: 1 },
            idempotencyKey: { type: 'string', minLength: 1, maxLength: 200 },
            description: { type: 'string', maxLength: 500 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    async (req) => {
      const applicationId = req.application!.id;
      const body = ConsumeBody.parse(req.body);
      const { subject } = await resolveSubject(applicationId, body);
      const result = await creditsService.consume({
        applicationId,
        ...subject,
        amount: body.amount,
        ...(body.idempotencyKey !== undefined && { idempotencyKey: body.idempotencyKey }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.metadata !== undefined && { metadata: body.metadata }),
      });
      return { success: true, data: result };
    },
  );

  app.get(
    '/ledger',
    {
      onRequest: requireScope('billing:read'),
      schema: {
        tags: ['Public · Credits'],
        summary: "List a subject's recent credit ledger entries (newest first)",
        description:
          'Accepts a narrow `billing:read` key, like `GET /balance`. Secret key only; the ' +
          'publishable key is rejected.',
        security: [{ apiKey: [] }],
        querystring: {
          type: 'object',
          properties: {
            endUserId: { type: 'string' },
            organizationId: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (req) => {
      const applicationId = req.application!.id;
      const q = LedgerQuery.parse(req.query);
      const { subject } = await resolveSubject(applicationId, q);
      const entries = await creditsService.listLedger(applicationId, subject, {
        limit: q.limit ?? 50,
        ...(q.offset !== undefined && { offset: q.offset }),
      });
      return { success: true, data: entries };
    },
  );
}
