import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { plansService } from './plans.service.js';
import { applicationsService } from '../applications/applications.service.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';
import { moneyAmount } from '../../lib/bounded-int.js';
import { ok, okPage, errs, ref } from '../../lib/openapi.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';

/** The 401/403 pair every `/api/v1/admin/*` route shares. */
const SUPER_ADMIN_ERRORS = {
  401:
    'ADMIN_AUTH_MISSING — no `Authorization: Bearer` header; or ADMIN_AUTH_INVALID — the ' +
    'value does not match `SUPER_ADMIN_KEY`.',
  403: 'ADMIN_IP_NOT_ALLOWED — the caller IP is outside `ADMIN_IP_ALLOWLIST`.',
  429: 'RATE_LIMITED — too many requests. Honour the Retry-After header.',
} as const;

const Params = z.object({ id: z.string().min(1) });
const PlanParams = z.object({ id: z.string().min(1), slug: z.string().min(1) });
const ListQuery = z.object({ includeInactive: z.coerce.boolean().optional() }).merge(PaginationQuery);

const CreateBody = z.object({
  slug: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  amount: moneyAmount(),
  currency: z.string().length(3).optional(),
  interval: z.enum(['MONTH', 'YEAR']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

/** Mirrors the tenant surface — see `tenant-applications.routes.ts`. */
const UpdateBody = z
  .object({
    active: z.boolean().optional(),
    name: z.string().min(1).max(120).optional(),
    amount: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    interval: z.enum(['MONTH', 'YEAR']).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: 'Send at least one field to change.',
  });

export async function plansRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireSuperAdmin);

  app.get(
    '/:id/plans',
    {
      schema: {
        tags: ['Admin · Plans'],
        security: [{ superAdminKey: [] }],
        summary: 'List plans for an application',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: { includeInactive: { type: 'boolean' }, ...paginationJsonSchema },
        },
        response: {
          // Handler returns a bare array — see the module report.
          200: okPage(ref('Plan'), 'Plans for this application.'),
          ...errs({
            400: 'VALIDATION_ERROR — `includeInactive` is not a boolean.',
            ...SUPER_ADMIN_ERRORS,
            404: 'APPLICATION_NOT_FOUND — no application with that id.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = Params.parse(req.params);
      const { includeInactive, ...page } = ListQuery.parse(req.query);
      await applicationsService.get(id);
      const { take, skip } = parsePagination(page);
      const [items, total] = await Promise.all([
        plansService.listForApplication(id, includeInactive ?? false, { take, skip }),
        plansService.countForApplication(id, includeInactive ?? false),
      ]);
      return { success: true, data: paged(items, total, take, skip) };
    },
  );

  app.post(
    '/:id/plans',
    {
      schema: {
        tags: ['Admin · Plans'],
        security: [{ superAdminKey: [] }],
        summary: 'Create a plan',
        description:
          'Creates a Plan locally, then registers it with Stripe if the Application has Stripe ' +
          'credentials stored. PayPal and Razorpay register the plan lazily at first checkout. ' +
          'Amount is in the smallest currency unit (cents/paise/sen — never a decimal float).',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['slug', 'name', 'amount'],
          properties: {
            slug: { type: 'string', minLength: 1, maxLength: 40 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            amount: { type: 'integer', minimum: 0, description: 'Smallest currency unit (e.g. cents).', maximum: 2147483647 },
            currency: { type: 'string', minLength: 3, maxLength: 3, description: 'ISO 4217. Defaults to USD.' },
            interval: { type: 'string', enum: ['MONTH', 'YEAR'] },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          201: ok(ref('Plan'), 'The created plan.'),
          ...errs({
            // This route's body has no `kind` field, so it always creates a
            // SUBSCRIPTION-kind plan — the LICENSE/USAGE/CREDIT per-kind
            // validation errors plansService.create() also defines
            // (PLAN_LICENSE_KIND_REQUIRED, PLAN_USAGE_CONFIG_REQUIRED,
            // PLAN_CREDITS_AMOUNT_REQUIRED, ...) can't be reached from here.
            400:
              'VALIDATION_ERROR — a field failed schema validation; or PLAN_SLUG_INVALID — the ' +
              'slug is not URL-safe; or PLAN_AMOUNT_INVALID — `amount` is negative.',
            ...SUPER_ADMIN_ERRORS,
            404: 'APPLICATION_NOT_FOUND — no application with that id.',
            409: 'PLAN_SLUG_TAKEN — another plan on this application already uses that slug.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = Params.parse(req.params);
      const body = CreateBody.parse(req.body);
      const plan = await plansService.create({
        applicationId: id,
        slug: body.slug,
        name: body.name,
        amount: body.amount,
        ...(body.currency !== undefined && { currency: body.currency }),
        ...(body.interval !== undefined && { interval: body.interval }),
        ...(body.metadata !== undefined && { metadata: body.metadata }),
      });
      return reply.status(201).send({ success: true, data: plan });
    },
  );

  app.patch(
    '/:id/plans/:slug',
    {
      schema: {
        tags: ['Admin · Plans'],
        security: [{ superAdminKey: [] }],
        summary: 'Update a plan',
        description:
          'Send any subset of the fields. `amount`, `currency` and `interval` are only accepted ' +
          'while the plan has not been registered with a payment provider (a provider price is ' +
          'immutable once minted); a registered plan answers `PLAN_PRICE_IMMUTABLE`. ' +
          '`active: true` on a plan with no provider price answers ' +
          '`PLAN_NOT_REGISTERED_WITH_PROVIDER`.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, slug: { type: 'string' } },
          required: ['id', 'slug'],
        },
        body: {
          type: 'object',
          properties: {
            active: { type: 'boolean' },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            amount: { type: 'integer', minimum: 0 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            interval: { type: 'string', enum: ['MONTH', 'YEAR'] },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          200: ok(ref('Plan'), 'The updated plan.'),
          ...errs({
            400: 'VALIDATION_ERROR — `active` is missing or not a boolean.',
            ...SUPER_ADMIN_ERRORS,
            404: 'PLAN_NOT_FOUND — no plan with that slug in this application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, slug } = PlanParams.parse(req.params);
      const body = UpdateBody.parse(req.body);
      return {
        success: true,
        data: await plansService.update(id, slug, {
          ...(body.active !== undefined && { active: body.active }),
          ...(body.name !== undefined && { name: body.name }),
          ...(body.amount !== undefined && { amount: body.amount }),
          ...(body.currency !== undefined && { currency: body.currency }),
          ...(body.interval !== undefined && { interval: body.interval }),
          ...(body.metadata !== undefined && { metadata: body.metadata }),
        }),
      };
    },
  );

  app.post(
    '/:id/plans/:slug/register',
    {
      schema: {
        tags: ['Admin · Plans'],
        security: [{ superAdminKey: [] }],
        summary: 'Register (or re-register) a plan with the payment provider',
        description:
          'Creates the Stripe Product + Price for a plan that has none and stores the price id. ' +
          'The repair for a plan whose registration was refused at create time — it keeps its ' +
          'slug and goes back on sale on success. Idempotent.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, slug: { type: 'string' } },
          required: ['id', 'slug'],
        },
        response: {
          200: ok(
            ref('Plan'),
            "The plan with its registrationStatus settled — REGISTERED if this attempt " +
              'succeeded, unchanged if it was already REGISTERED or NOT_REQUIRED.',
          ),
          ...errs({
            400: 'BILLING_CREDENTIALS_NOT_CONFIGURED — this application has no stripe credentials configured.',
            ...SUPER_ADMIN_ERRORS,
            404:
              'APPLICATION_NOT_FOUND — no application with that id; or PLAN_NOT_FOUND — no plan ' +
              'with that slug on this application.',
            502:
              'BILLING_PROVIDER_ERROR — stripe rejected the registration attempt (only reachable ' +
              'while the plan was PENDING/FAILED). The plan\'s registrationStatus is now FAILED ' +
              "with the provider's message attached (`registrationError`), and it stays off sale.",
          }),
        },
      },
    },
    async (req) => {
      const { id, slug } = PlanParams.parse(req.params);
      await applicationsService.get(id);
      return { success: true, data: await plansService.registerWithProvider(id, slug) };
    },
  );
}
