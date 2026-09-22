/**
 * Public usage endpoints, the customer's app reports/aggregates here.
 * Tenant operator routes for meter CRUD live in tenant-applications.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UsageMeter } from '@prisma/client';
import { usageService, type UsageQuotaSubject } from './usage.service.js';
import { requireApiKey, requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { requireBillingEnabled } from '../../middleware/billing-enabled.js';
import { organizationsService } from '../organizations/organizations.service.js';
import { resolveSelfBillingSubject } from '../billing/self-subject.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { env } from '../../config/env.js';
import { resolveGlobalBudgets } from '../../lib/rate-limit.js';
import { positiveBoundedInt } from '../../lib/bounded-int.js';
import { assertMetadataWithinLimit } from '../../lib/metadata-limit.js';
import { ok, okPage, errs, ref } from '../../lib/openapi.js';

/**
 * Auth/gate errors shared by every route in this file: `requireApiKey`
 * (secret key only) + `requireBillingEnabled`, then the per-route `requireScope`.
 */
const READ_GATE_ERRORS = {
  401:
    'API_KEY_MISSING — no Authorization header; or API_KEY_INVALID — the presented credential ' +
    'is not a valid Application secret key, or is unknown/revoked/expired.',
  403:
    "IP_NOT_ALLOWED — caller IP outside the key's allowlist; or BILLING_DISABLED — billing is " +
    'not enabled for this application; or API_KEY_SCOPE_INSUFFICIENT — the key lacks the ' +
    '`billing:read` scope.',
  429: 'RATE_LIMITED — too many requests. Honour the Retry-After header.',
} as const;

const WRITE_GATE_ERRORS = {
  401: READ_GATE_ERRORS[401],
  403: READ_GATE_ERRORS[403].replace('billing:read', 'billing:write'),
  429: READ_GATE_ERRORS[429],
} as const;

const RecordBody = z.object({
  meterSlug: z.string().min(1).max(40),
  // Positive integers only. Negative/zero quantities would let a billing:write
  // key deflate a metered total below true consumption (under-billing) or poison
  // aggregates, usage events represent consumption, which is never negative.
  quantity: positiveBoundedInt(),
  endUserId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  occurredAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
  // OPTIONAL: a retry-safe key (mirrors credits.consume). Same (meter, key)
  // twice → one record. Omit for the historical each-call-counts behavior.
  idempotencyKey: z.string().min(1).max(255).optional(),
});

/** Validate the optional usage subject (end-user OR org, not both) against
 *  the calling Application. Usage may also be subject-less (app-level). */
async function assertSubjectInApp(
  applicationId: string,
  subject: { endUserId?: string | undefined; organizationId?: string | undefined },
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
      where: { id: subject.endUserId, applicationId },
      select: { id: true },
    });
    if (!eu) {
      throw new RekeyError({
        statusCode: 404,
        code: 'END_USER_NOT_FOUND',
        message: `End-user "${subject.endUserId}" not found in this Application.`,
        fix: 'Pass the id of an end-user that belongs to the Application this key names.',
      });
    }
  }
}

const meterParam = z.string().min(1).max(40).optional();

const SelfRemainingQuery = z.object({
  meter: meterParam,
  organizationId: z.string().min(1).optional(),
});

const ForUserRemainingQuery = z
  .object({
    meter: meterParam,
    endUserId: z.string().min(1).optional(),
    organizationId: z.string().min(1).optional(),
  })
  .refine((q) => Boolean(q.endUserId) || Boolean(q.organizationId), {
    message: 'Pass endUserId, organizationId, or both.',
  });

/** The `meter` querystring shared by both remaining reads. */
const METER_QUERY_PROPERTY = {
  type: 'string',
  minLength: 1,
  maxLength: 40,
  description: 'One meter slug. Omit to report every meter on the Application.',
} as const;

const REMAINING_DESCRIPTION =
  'Per meter: the included quota the subject\'s plans grant (`included`, null when there is ' +
  'none, which means records are not capped), units recorded this period (`used`), what ' +
  'is left (`remaining`), the credits charged per unit past the quota (`creditsPerUnit`, ' +
  'null means a record past it is refused with 402 USAGE_QUOTA_EXCEEDED), and the period ' +
  'window. The period is the calendar month in UTC, the window `POST /usage/record` ' +
  'enforces in, and the numbers come from the same code, so a record of more than ' +
  '`remaining` units is exactly the one that is refused (or charged).';

function catalogueEntry(meter: UsageMeter): Record<string, unknown> {
  return {
    id: meter.id,
    slug: meter.slug,
    name: meter.name,
    unit: meter.unit,
    active: meter.active,
    creditsPerUnit: meter.creditsPerUnit,
    createdAt: meter.createdAt.toISOString(),
  };
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
      // Higher per-API-key cap for ingestion, keyed per key via the global
      // keyGenerator, so one customer's high scan volume doesn't starve others.
      config: {
        // RATE_LIMIT_USAGE_MAX, else the per-key budget (see config/env.ts).
        rateLimit: {
          max: env.RATE_LIMIT_USAGE_MAX ?? resolveGlobalBudgets(env).apiKey,
          timeWindow: env.RATE_LIMIT_WINDOW_MS,
        },
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
          'Requires an Application **secret** key with the `billing:write` scope (or ' +
          '`*`, the mint default). The publishable key is rejected, call this from your server.',
        security: [{ apiKey: [] }],
        body: {
          type: 'object',
          required: ['meterSlug', 'quantity'],
          properties: {
            meterSlug: { type: 'string', minLength: 1, maxLength: 40 },
            quantity: { type: 'integer', minimum: 1, maximum: 2147483647 },
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
        response: {
          201: ok(ref('UsageRecord'), 'The recorded usage event.'),
          ...errs({
            400:
              'VALIDATION_ERROR — the body failed schema validation; or ' +
              'IDEMPOTENCY_KEY_INVALID — the Idempotency-Key header is empty or exceeds 200 ' +
              'characters; or USAGE_SUBJECT_AMBIGUOUS — both `endUserId` and `organizationId` ' +
              'were passed; or USAGE_METER_INACTIVE — the meter exists but does not accept records; ' +
              'or METADATA_TOO_LARGE — `metadata` exceeds the 16KB limit.',
            ...WRITE_GATE_ERRORS,
            402: 'USAGE_QUOTA_EXCEEDED — the subject\'s plan-included quota for this meter is exhausted this period.',
            404:
              'USAGE_METER_NOT_FOUND — no meter with that slug in this application; or ' +
              'ORGANIZATION_NOT_FOUND — `organizationId` does not name an organization in this ' +
              'application; or END_USER_NOT_FOUND — `endUserId` does not name an end-user in ' +
              'this application.',
            409:
              'IDEMPOTENCY_KEY_IN_FLIGHT — a request with this Idempotency-Key is still being ' +
              'processed; or IDEMPOTENCY_KEY_REUSED — the key was already used for a different ' +
              'method, path, or body.',
          }),
        },
      },
    },
    async (req, reply) => {
      const body = RecordBody.parse(req.body);
      // Usage rows are the highest-volume table in the schema and are never
      // updated, so an oversized blob here is multiplied by the ingestion rate
      // rather than held to one row per subject.
      if (body.metadata) assertMetadataWithinLimit(body.metadata);
      await assertSubjectInApp(req.application!.id, body);
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
      // Shaped into UsageRecordDto rather than sent raw. The row stores
      // `meterId`, and `applicationId` lives on the meter, not the record, so
      // returning it raw omitted BOTH fields the published DTO requires while
      // shipping an internal id the caller cannot resolve.
      return reply.status(201).send({
        success: true,
        data: {
          id: record.id,
          applicationId: req.application!.id,
          meterSlug: body.meterSlug,
          quantity: record.quantity,
          endUserId: record.endUserId,
          organizationId: record.organizationId,
          occurredAt: record.occurredAt.toISOString(),
        },
      });
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
        response: {
          200: ok(ref('UsageAggregate'), 'Summed quantity for the meter over the requested window.'),
          ...errs({
            400:
              'VALIDATION_ERROR — the querystring failed schema validation; or ' +
              'USAGE_SUBJECT_AMBIGUOUS — both `endUserId` and `organizationId` were passed.',
            ...READ_GATE_ERRORS,
            404:
              'USAGE_METER_NOT_FOUND — no meter with that slug; or ORGANIZATION_NOT_FOUND — ' +
              '`organizationId` does not name an organization in this application; or ' +
              'END_USER_NOT_FOUND — `endUserId` does not name an end-user in this application.',
          }),
        },
      },
    },
    async (req) => {
      const q = AggregateQuery.parse(req.query);
      await assertSubjectInApp(req.application!.id, q);
      const result = await usageService.aggregate({
        applicationId: req.application!.id,
        meterSlug: q.meterSlug,
        ...(q.from !== undefined && { from: new Date(q.from) }),
        ...(q.to !== undefined && { to: new Date(q.to) }),
        ...(q.endUserId !== undefined && { endUserId: q.endUserId }),
        ...(q.organizationId !== undefined && { organizationId: q.organizationId }),
      });
      // Echo the meter and window back. They are inputs, but a caller holding
      // several aggregate responses has no other way to tell them apart, and
      // the published DTO has always promised them.
      return {
        success: true,
        data: {
          meterSlug: q.meterSlug,
          total: result.total,
          count: result.count,
          from: q.from ?? null,
          to: q.to ?? null,
        },
      };
    },
  );

  app.get(
    '/remaining/for-user',
    {
      onRequest: requireScope('billing:read'),
      schema: {
        tags: ['Public · Usage'],
        summary: "Read a named subject's included quota, usage and remaining units this period",
        description:
          'The same answer `GET /usage/remaining` gives a signed-in end-user, for a subject ' +
          'you name instead: `?endUserId=` for a personal quota, `?organizationId=` for an ' +
          'organization pool, or both to read the organization as that member (the end-user ' +
          'must belong to it). For your own backend, which holds a secret key but not the ' +
          'user\'s session. Accepts a narrow `billing:read` key.\n\n' +
          REMAINING_DESCRIPTION,
        security: [{ apiKey: [] }],
        querystring: {
          type: 'object',
          properties: {
            meter: METER_QUERY_PROPERTY,
            endUserId: { type: 'string', minLength: 1 },
            organizationId: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: ok(ref('UsageRemaining'), "The subject's standing per meter this period."),
          ...errs({
            400: 'VALIDATION_ERROR: pass `endUserId`, `organizationId`, or both.',
            ...READ_GATE_ERRORS,
            403:
              READ_GATE_ERRORS[403] +
              ' Or ORGANIZATION_NOT_MEMBER: both ids were passed and the end-user is not a ' +
              'member of the organization.',
            404:
              'USAGE_METER_NOT_FOUND: `meter` names no meter in this application; or ' +
              'ORGANIZATION_NOT_FOUND / END_USER_NOT_FOUND: an id names no subject in this ' +
              'application.',
          }),
        },
      },
    },
    async (req) => {
      const q = ForUserRemainingQuery.parse(req.query);
      const application = req.application!;
      if (q.endUserId) await assertSubjectInApp(application.id, { endUserId: q.endUserId });
      if (q.organizationId) await assertSubjectInApp(application.id, { organizationId: q.organizationId });
      if (q.endUserId && q.organizationId) {
        await organizationsService.requireMembership({
          application,
          actorEndUserId: q.endUserId,
          organizationId: q.organizationId,
        });
      }
      const subject: UsageQuotaSubject = q.organizationId
        ? { organizationId: q.organizationId }
        : { endUserId: q.endUserId! };
      return {
        success: true,
        data: await usageService.remaining({ applicationId: application.id, subject, meterSlug: q.meter }),
      };
    },
  );

  app.get(
    '/meters',
    {
      onRequest: requireScope('billing:read'),
      schema: {
        tags: ['Public · Usage'],
        summary: 'List the usage meters on this Application',
        description:
          'The meter catalogue, oldest first: the slug `POST /usage/record` takes as ' +
          '`meterSlug`, what a unit counts, whether the meter accepts records, and its ' +
          'fallback price in credits. Lets a backend learn the slugs instead of hard-coding ' +
          'them. Accepts a narrow `billing:read` key. Secret key only.',
        security: [{ apiKey: [] }],
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('UsageMeterCatalogueEntry'), 'A page of usage meters.'),
          ...errs({
            400: 'VALIDATION_ERROR: `limit` or `offset` is out of range.',
            ...READ_GATE_ERRORS,
          }),
        },
      },
    },
    async (req) => {
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const applicationId = req.application!.id;
      const [meters, total] = await Promise.all([
        usageService.listMeters(applicationId, { take, skip }),
        usageService.countMeters(applicationId),
      ]);
      return { success: true, data: paged(meters.map(catalogueEntry), total, take, skip) };
    },
  );
}

/**
 * The signed-in end-user's own usage reads. A separate plugin because the one
 * above is secret-key only for the whole plugin (`requireApiKey` as a plugin
 * hook), and this is for a browser holding the publishable key and the user's
 * token, as `GET /billing/entitlements` is.
 */
export async function usageSelfRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/remaining',
    {
      onRequest: [requirePublishableOrSecretKey, requireBillingEnabled, requireScope('billing:read'), requireUserSession],
      schema: {
        tags: ['Public · Usage'],
        summary: "Read the signed-in end-user's included quota, usage and remaining units this period",
        description:
          'Whose quota: the token holder\'s personal one; in an Application that bills ' +
          'organizations (`billingSubject: "org"`) the session\'s active organization\'s ' +
          'while the caller is still a member; or, with `?organizationId=` (member-only), ' +
          'that organization\'s. Requires the user token.\n\n' +
          REMAINING_DESCRIPTION,
        security: [{ apiKey: [], userToken: [] }, { publishableKey: [], userToken: [] }],
        querystring: {
          type: 'object',
          properties: {
            meter: METER_QUERY_PROPERTY,
            organizationId: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: ok(ref('UsageRemaining'), "The caller's standing per meter this period."),
          ...errs({
            400: 'VALIDATION_ERROR: the querystring failed schema validation.',
            401:
              'API_KEY_MISSING / API_KEY_INVALID / PUBLISHABLE_KEY_INVALID: the Application key ' +
              'is missing or unknown; or USER_TOKEN_MISSING / USER_TOKEN_INVALID / ' +
              'USER_TOKEN_WRONG_APPLICATION / IMPERSONATION_SESSION_ENDED: the user token is ' +
              'absent, invalid, for another Application, or from an ended impersonation.',
            403:
              "IP_NOT_ALLOWED / ORIGIN_NOT_ALLOWED: outside the key's allowlist; or " +
              'BILLING_DISABLED; or API_KEY_SCOPE_INSUFFICIENT: a secret key lacks `billing:read`; ' +
              'or ORGANIZATION_NOT_MEMBER: `organizationId` names an organization the caller is ' +
              'not a member of.',
            404: 'USAGE_METER_NOT_FOUND: `meter` names no meter in this application.',
            429: 'RATE_LIMITED: too many requests. Honour the Retry-After header.',
          }),
        },
      },
    },
    async (req) => {
      const q = SelfRemainingQuery.parse(req.query);
      const subject = await resolveSelfBillingSubject(req, q.organizationId);
      return {
        success: true,
        data: await usageService.remaining({
          applicationId: req.application!.id,
          subject,
          meterSlug: q.meter,
        }),
      };
    },
  );
}
