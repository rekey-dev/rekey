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
import { moneyAmount, positiveBoundedInt } from '../../lib/bounded-int.js';
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
const CodeParams = z.object({ id: z.string().min(1), code: z.string().min(1) });
const ListQuery = z.object({ includeInactive: z.coerce.boolean().optional() }).merge(PaginationQuery);

const CreateBody = z.object({
  code: z.string().min(1).max(40),
  discountType: z.enum(['PERCENT', 'AMOUNT']),
  amountOff: moneyAmount(),
  currency: z.string().length(3).optional(),
  planSlugs: z.array(z.string().min(1).max(40)).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  maxRedemptions: positiveBoundedInt().optional(),
  maxRedemptionsPerUser: positiveBoundedInt().optional(),
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
        querystring: {
          type: 'object',
          properties: { includeInactive: { type: 'boolean' }, ...paginationJsonSchema },
        },
        response: {
          200: okPage(ref('Coupon'), 'A page of coupons for this application.'),
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
        couponsService.list(id, includeInactive ?? false, { take, skip }),
        couponsService.count(id, includeInactive ?? false),
      ]);
      return { success: true, data: paged(items, total, take, skip) };
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
          'Discount kinds: PERCENT (amountOff in basis points, so 1500 = 15%) ' +
          'or AMOUNT (amountOff in smallest currency unit). Codes are stored lowercase.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['code', 'discountType', 'amountOff'],
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 40 },
            discountType: { type: 'string', enum: ['PERCENT', 'AMOUNT'] },
            amountOff: { type: 'integer', minimum: 0, maximum: 2147483647 },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            planSlugs: { type: 'array', items: { type: 'string' } },
            startsAt: { type: 'string', format: 'date-time' },
            endsAt: { type: 'string', format: 'date-time' },
            maxRedemptions: { type: 'integer', minimum: 1, maximum: 2147483647 },
            maxRedemptionsPerUser: { type: 'integer', minimum: 1, maximum: 2147483647 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        response: {
          201: ok(ref('Coupon'), 'The created coupon.'),
          ...errs({
            400:
              'VALIDATION_ERROR — a field failed schema validation; or COUPON_CODE_INVALID — ' +
              'the code is not 1-40 alphanumerics/underscores/hyphens; or COUPON_AMOUNT_INVALID ' +
              '— `amountOff` is negative, or a PERCENT discount exceeds 10000 basis points.',
            ...SUPER_ADMIN_ERRORS,
            404: 'APPLICATION_NOT_FOUND — no application with that id.',
            409: 'COUPON_CODE_TAKEN — another coupon on this application already uses that code.',
          }),
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
        response: {
          200: ok(ref('Coupon'), 'The updated coupon.'),
          ...errs({
            400: 'VALIDATION_ERROR — `active` is missing or not a boolean.',
            ...SUPER_ADMIN_ERRORS,
            404: 'COUPON_NOT_FOUND — no coupon with that code on this application.',
          }),
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
        response: {
          200: ok(ref('ValidateCouponResult'), 'The discount this coupon resolves to for this plan.'),
          ...errs({
            400:
              'VALIDATION_ERROR — the body failed schema validation; or COUPON_INACTIVE / ' +
              'COUPON_NOT_YET_STARTED / COUPON_EXPIRED / COUPON_NOT_APPLICABLE / ' +
              'COUPON_CURRENCY_MISMATCH / COUPON_REDEMPTION_LIMIT_REACHED / ' +
              'COUPON_USER_LIMIT_REACHED — the coupon fails validation for this plan/user.',
            401:
              'API_KEY_MISSING / API_KEY_INVALID — the secret key is missing, malformed, or ' +
              'unknown/revoked/expired; or PUBLISHABLE_KEY_INVALID — the publishable key is ' +
              'unknown or has rotated out; or USER_TOKEN_MISSING — no X-Rekey-User-Token ' +
              'header; or USER_TOKEN_INVALID — the token is invalid/expired/wrong-secret; or ' +
              'USER_TOKEN_WRONG_APPLICATION — the token was issued for a different Application; ' +
              'or IMPERSONATION_SESSION_ENDED — the impersonation session behind this token has ended.',
            403:
              "IP_NOT_ALLOWED — caller IP outside the secret key's allowlist; or " +
              "ORIGIN_NOT_ALLOWED — the Origin is outside the publishable key's CORS allowlist; " +
              'or BILLING_DISABLED — billing is not enabled for this application.',
            404: 'PLAN_NOT_FOUND — no plan with that slug; or COUPON_NOT_FOUND — no active coupon matching the code.',
            429: 'RATE_LIMITED — too many requests. Honour the Retry-After header.',
          }),
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
          // A PROJECTION, not the row. This endpoint answers to anyone holding
          // the publishable key and a user token — a pricing page — and it used
          // to hand back the whole `Coupon`: `maxRedemptions`,
          // `maxRedemptionsPerUser`, the operator's private `metadata`, the
          // internal id, the full plan allow-list. None of that is a buyer's
          // business, and the limits in particular tell a scraper exactly how
          // much of a campaign is left to burn. What a buyer needs to render
          // "15% off" is the code, the kind of discount, and its size; the
          // money they actually care about is already `discountAmount` /
          // `amountAfterDiscount` below.
          coupon: {
            code: result.coupon.code,
            discountType: result.coupon.discountType,
            amountOff: result.coupon.amountOff,
            currency: result.coupon.currency,
          },
          plan: { slug: plan.slug, name: plan.name, amount: plan.amount, currency: plan.currency },
          discountAmount: result.discountAmount,
          amountAfterDiscount: result.amountAfterDiscount,
        },
      };
    },
  );
}
