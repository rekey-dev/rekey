/**
 * Operator coupon routes, `/api/v1/tenant/applications/:id/coupons`.
 *
 * Registered inside `tenantApplicationsRoutes`, so the tenant-session hook
 * and the path prefix are that plugin's.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensureAppAccess } from '../../lib/app-access.js';
import { ok, okPage, errs, ref } from '../../lib/openapi.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';
import { serializeCoupon, serializeCouponWithStats } from './coupon-dto.js';
import {
  CREATE_COUPON_400,
  CREATE_COUPON_BODY_JSON_SCHEMA,
  CREATE_COUPON_DESCRIPTION,
  UPDATE_COUPON_400,
  UPDATE_COUPON_409,
  UPDATE_COUPON_BODY_JSON_SCHEMA,
  UPDATE_COUPON_DESCRIPTION,
  createCouponInput,
  updateCouponInput,
} from './coupon-route-schemas.js';
import { couponsService } from './coupons.service.js';

const AppParam = z.object({ id: z.string().min(1) });
const CouponCodeParam = z.object({ id: z.string().min(1), code: z.string().min(1) });

const APP_ID_PARAM = { type: 'string', description: 'The Application id.' } as const;
const APP_PARAMS = { type: 'object', properties: { id: APP_ID_PARAM }, required: ['id'] } as const;
const CODE_PARAMS = {
  type: 'object',
  properties: { id: APP_ID_PARAM, code: { type: 'string', description: 'The coupon code. Any case.' } },
  required: ['id', 'code'],
} as const;

const SESSION_401 =
  'TENANT_SESSION_MISSING: no `Authorization: Bearer` header; or TENANT_SESSION_INVALID: ' +
  'the token is invalid, expired, or the operator account no longer exists.';
const APP_404 =
  'APPLICATION_NOT_FOUND: no application with that id in this workspace (also returned to a ' +
  'MEMBER with per-app grants who holds no grant on it, so its existence is not disclosed)';

const READ_ERRORS = {
  401: SESSION_401,
  403:
    'TENANT_MEMBERSHIP_REVOKED: the operator is no longer a member of this workspace; or ' +
    'SCOPE_INSUFFICIENT: the operator token or membership does not hold the `billing:read` scope.',
} as const;

const BILLING_WRITE_ERRORS = {
  401: SESSION_401,
  403:
    'TENANT_MEMBERSHIP_REVOKED: the operator is no longer a member of this workspace; or ' +
    'TENANT_ROLE_INSUFFICIENT: a legacy MEMBER (zero application grants) attempted a billing ' +
    "write; or APP_ACCESS_DENIED: the operator's grant on this Application (needs APP_BILLING " +
    'or APP_ADMIN) does not permit this action; or SCOPE_INSUFFICIENT: the operator token or ' +
    'membership does not hold the `billing:write` scope.',
} as const;

const READ_ACCESS =
  'Requires **read** access to this Application, OWNER/ADMIN, or a MEMBER holding any grant on it. ' +
  'A MEMBER with no grant on this Application gets 404.';
const BILLING_WRITE_ACCESS =
  'Requires **billing-write** access to this Application, OWNER/ADMIN, or a MEMBER with an ' +
  '`APP_ADMIN` or `APP_BILLING` grant on it.';

export async function couponsTenantRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/:id/coupons',
    {
      config: { access: { scope: 'billing:read' }, operatorToken: true },
      schema: {
        tags: ['Tenant · Coupons'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: 'List Coupons (with redemption stats)',
        description:
          `${READ_ACCESS}\n\n` +
          'Each coupon carries `redemptionCount` and `discountIssuedByCurrency`: what it has taken off in ' +
          'each currency it was redeemed in, the reporting currency first. There is no total, because ' +
          'money in two currencies is never added together.',
        params: APP_PARAMS,
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('CouponWithStats'), 'A page of coupons (active and inactive), each with redemption stats.'),
          ...errs({ 400: 'VALIDATION_ERROR: `limit` or `offset` is out of range.', ...READ_ERRORS, 404: `${APP_404}.` }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const [items, total] = await Promise.all([
        couponsService.listWithStats(id, true, { take, skip }),
        couponsService.count(id, true),
      ]);
      return {
        success: true,
        data: paged(
          items.map((coupon) => serializeCouponWithStats(coupon, coupon)),
          total,
          take,
          skip,
        ),
      };
    },
  );

  app.get(
    '/:id/coupons/:code',
    {
      config: { access: { scope: 'billing:read' }, operatorToken: true },
      schema: {
        tags: ['Tenant · Coupons'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: 'Get a Coupon',
        description: READ_ACCESS,
        params: CODE_PARAMS,
        response: {
          200: ok(ref('Coupon'), 'The coupon.'),
          ...errs({
            ...READ_ERRORS,
            404: `${APP_404}; or COUPON_NOT_FOUND: no coupon with that code on this Application.`,
          }),
        },
      },
    },
    async (req) => {
      const { id, code } = CouponCodeParam.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: serializeCoupon(await couponsService.get(id, code)) };
    },
  );

  app.post(
    '/:id/coupons',
    {
      // Generic Idempotency-Key header support (scoped to the workspace).
      config: { access: { scope: 'billing:write' }, operatorToken: true, idempotency: true },
      schema: {
        tags: ['Tenant · Coupons'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: 'Create a Coupon',
        description: `${BILLING_WRITE_ACCESS}\n\n${CREATE_COUPON_DESCRIPTION}`,
        params: APP_PARAMS,
        body: CREATE_COUPON_BODY_JSON_SCHEMA,
        response: {
          201: ok(ref('Coupon'), 'The created coupon.'),
          ...errs({
            400: CREATE_COUPON_400,
            ...BILLING_WRITE_ERRORS,
            404: `${APP_404}.`,
            409: 'COUPON_CODE_TAKEN: another coupon on this Application already uses that code.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppAccess(req, id, 'billing-write');
      const coupon = serializeCoupon(
        await couponsService.create(createCouponInput(id, req.body, { operatorId: req.tenantUser!.id })),
      );
      void recordSecurityEvent({
        type: 'app.coupon_created',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: {
          code: coupon.code,
          discountType: coupon.discountType,
          basisPoints: coupon.basisPoints,
          amounts: coupon.amounts,
          currencies: coupon.currencies,
        },
      });
      return reply.status(201).send({ success: true, data: coupon });
    },
  );

  app.patch(
    '/:id/coupons/:code',
    {
      config: { access: { scope: 'billing:write' }, operatorToken: true },
      schema: {
        tags: ['Tenant · Coupons'],
        security: [{ tenantSession: [] }, { operatorPat: [] }],
        summary: 'Change a Coupon',
        description: `${BILLING_WRITE_ACCESS}\n\n${UPDATE_COUPON_DESCRIPTION}`,
        params: CODE_PARAMS,
        body: UPDATE_COUPON_BODY_JSON_SCHEMA,
        response: {
          200: ok(ref('Coupon'), 'The coupon after the change.'),
          ...errs({
            400: UPDATE_COUPON_400,
            ...BILLING_WRITE_ERRORS,
            404: `${APP_404}; or COUPON_NOT_FOUND: no coupon with that code on this Application.`,
            409: UPDATE_COUPON_409,
          }),
        },
      },
    },
    async (req) => {
      const { id, code } = CouponCodeParam.parse(req.params);
      await ensureAppAccess(req, id, 'billing-write');
      const input = updateCouponInput(id, code, req.body, { operatorId: req.tenantUser!.id });
      const updated = serializeCoupon(await couponsService.update(input));
      const { applicationId: _app, code: _code, actor: _actor, ...changed } = input;
      void recordSecurityEvent({
        type: 'app.coupon_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { code: updated.code, ...changed },
      });
      return { success: true, data: updated };
    },
  );
}
