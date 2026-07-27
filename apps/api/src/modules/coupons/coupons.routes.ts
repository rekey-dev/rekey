import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CouponDiscountType } from '@prisma/client';
import { couponsService } from './coupons.service.js';
import { applicationsService } from '../applications/applications.service.js';
import { plansService } from '../plans/plans.service.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';
import { requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { requireBillingEnabled } from '../../middleware/billing-enabled.js';

const Params = z.object({ id: z.string().min(1) });
const CodeParams = z.object({ id: z.string().min(1), code: z.string().min(1) });
const ListQuery = z.object({ includeInactive: z.coerce.boolean().optional() });

const CreateBody = z.object({
  code: z.string().min(1).max(40),
  discountType: z.enum(['PERCENT', 'AMOUNT']),
  amountOff: z.number().int().min(0),
  currency: z.string().length(3).optional(),
  planSlugs: z.array(z.string().min(1).max(40)).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  maxRedemptions: z.number().int().min(1).optional(),
  maxRedemptionsPerUser: z.number().int().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});
const ActiveBody = z.object({ active: z.boolean() });
const ValidateBody = z.object({
  code: z.string().min(1).max(40),
  planSlug: z.string().min(1).max(40),
});

/** Admin coupon management — gated by SUPER_ADMIN_KEY. */
export async function couponsAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireSuperAdmin);

  app.get(
    '/:id/coupons',
    {
      schema: {
        tags: ['Admin · Coupons'],
        security: [{ superAdminKey: [] }],
        summary: 'List coupons for an application',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: { type: 'object', properties: { includeInactive: { type: 'boolean' } } },
      },
    },
    async (req) => {
      const { id } = Params.parse(req.params);
      const { includeInactive } = ListQuery.parse(req.query);
      await applicationsService.get(id);
      return { success: true, data: await couponsService.list(id, includeInactive ?? false) };
    },
  );

  app.post(
    '/:id/coupons',
    {
      schema: {
        tags: ['Admin · Coupons'],
        security: [{ superAdminKey: [] }],
        summary: 'Create a coupon',
        description:
          'Discount kinds: PERCENT (amountOff in basis-points × 10, so 1500 = 15%) ' +
          'or AMOUNT (amountOff in smallest currency unit). Codes are stored lowercase.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['code', 'discountType', 'amountOff'],
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 40 },
            discountType: { type: 'string', enum: ['PERCENT', 'AMOUNT'] },
            amountOff: { type: 'integer', minimum: 0 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            planSlugs: { type: 'array', items: { type: 'string' } },
            startsAt: { type: 'string', format: 'date-time' },
            endsAt: { type: 'string', format: 'date-time' },
            maxRedemptions: { type: 'integer', minimum: 1 },
            maxRedemptionsPerUser: { type: 'integer', minimum: 1 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = Params.parse(req.params);
      const body = CreateBody.parse(req.body);
      await applicationsService.get(id);
      const coupon = await couponsService.create({
        applicationId: id,
        code: body.code,
        discountType: body.discountType as CouponDiscountType,
        amountOff: body.amountOff,
        ...(body.currency !== undefined && { currency: body.currency }),
        ...(body.planSlugs !== undefined && { planSlugs: body.planSlugs }),
        ...(body.startsAt !== undefined && { startsAt: new Date(body.startsAt) }),
        ...(body.endsAt !== undefined && { endsAt: new Date(body.endsAt) }),
        ...(body.maxRedemptions !== undefined && { maxRedemptions: body.maxRedemptions }),
        ...(body.maxRedemptionsPerUser !== undefined && {
          maxRedemptionsPerUser: body.maxRedemptionsPerUser,
        }),
        ...(body.metadata !== undefined && { metadata: body.metadata }),
      });
      return reply.status(201).send({ success: true, data: coupon });
    },
  );

  app.patch(
    '/:id/coupons/:code',
    {
      schema: {
        tags: ['Admin · Coupons'],
        security: [{ superAdminKey: [] }],
        summary: "Toggle a coupon's active flag",
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, code: { type: 'string' } },
          required: ['id', 'code'],
        },
        body: {
          type: 'object',
          required: ['active'],
          properties: { active: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const { id, code } = CodeParams.parse(req.params);
      const body = ActiveBody.parse(req.body);
      return { success: true, data: await couponsService.setActive(id, code, body.active) };
    },
  );
}

/**
 * Coupon validation endpoint — POST /api/v1/billing/coupons/validate.
 *
 * Used by pricing pages to render "$50 off" before submitting the actual
 * checkout, so it accepts the publishable key exactly like `POST
 * /billing/checkout` (which takes the same `couponCode`).
 *
 * The user JWT is not optional decoration: it is the authorizer, and per-user
 * redemption limits are evaluated against `req.endUser`.
 *
 * `billing:read` binds SECRET-key callers only. `requireScope` no-ops for a
 * publishable request, because a publishable key carries no scopes to check —
 * the origin allowlist and the user session are what constrain it instead.
 */
export async function couponsPublicRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireBillingEnabled);
  app.addHook('onRequest', requireScope('billing:read'));
  app.addHook('onRequest', requireUserSession);

  app.post(
    '/validate',
    {
      schema: {
        tags: ['Public · Billing'],
        summary: 'Validate a coupon for the current user against a plan',
        description:
          'Returns the discounted amount on success. Surfaces a precise RekeyError ' +
          'on every failure mode so the panel / pricing page can render a useful message.\n\n' +
          'Callable from a browser with the publishable key, or from your server ' +
          'with a secret key carrying the `billing:read` scope. Either way the ' +
          'end-user JWT is required, because per-user redemption limits are ' +
          'checked against that user.',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        body: {
          type: 'object',
          required: ['code', 'planSlug'],
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 40 },
            planSlug: { type: 'string', minLength: 1, maxLength: 40 },
          },
        },
      },
    },
    async (req) => {
      const body = ValidateBody.parse(req.body);
      const plan = await plansService.getBySlug(req.application!.id, body.planSlug);
      const result = await couponsService.validate({
        applicationId: req.application!.id,
        endUserId: req.endUser!.id,
        code: body.code,
        planSlug: plan.slug,
        amount: plan.amount,
        currency: plan.currency,
      });
      return {
        success: true,
        data: {
          coupon: result.coupon,
          plan: { slug: plan.slug, name: plan.name, amount: plan.amount, currency: plan.currency },
          discountAmount: result.discountAmount,
          amountAfterDiscount: result.amountAfterDiscount,
        },
      };
    },
  );
}
