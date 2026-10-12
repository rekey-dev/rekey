/**
 * Super-admin coupon management, `/api/v1/admin/applications/:id/coupons`,
 * gated by `SUPER_ADMIN_KEY`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applicationsService } from '../applications/applications.service.js';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';
import { ok, okPage, errs, ref } from '../../lib/openapi.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';
import { serializeCoupon } from './coupon-dto.js';
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

/** The 401/403 pair every `/api/v1/admin/*` route shares. */
const SUPER_ADMIN_ERRORS = {
  401:
    'ADMIN_AUTH_MISSING: no `Authorization: Bearer` header; or ADMIN_AUTH_INVALID: the ' +
    'value does not match `SUPER_ADMIN_KEY`.',
  403: 'ADMIN_IP_NOT_ALLOWED: the caller IP is outside `ADMIN_IP_ALLOWLIST`; or ADMIN_IP_UNVERIFIABLE: an allowlist is set but the caller arrived through a proxy the API cannot identify, so it has no client address to check.',
  429: 'RATE_LIMITED: too many requests. Honour the Retry-After header.',
} as const;

const Params = z.object({ id: z.string().min(1) });
const CodeParams = z.object({ id: z.string().min(1), code: z.string().min(1) });
const ListQuery = z.object({ includeInactive: z.coerce.boolean().optional() }).merge(PaginationQuery);

const APP_PARAMS = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } as const;
const CODE_PARAMS = {
  type: 'object',
  properties: { id: { type: 'string' }, code: { type: 'string' } },
  required: ['id', 'code'],
} as const;

export async function couponsAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireSuperAdmin);

  app.get(
    '/:id/coupons',
    {
      schema: {
        tags: ['Admin · Coupons'],
        security: [{ superAdminKey: [] }],
        summary: 'List coupons for an application',
        params: APP_PARAMS,
        querystring: {
          type: 'object',
          properties: { includeInactive: { type: 'boolean' }, ...paginationJsonSchema },
        },
        response: {
          200: okPage(ref('Coupon'), 'A page of coupons for this application.'),
          ...errs({
            400: 'VALIDATION_ERROR: `includeInactive` is not a boolean.',
            ...SUPER_ADMIN_ERRORS,
            404: 'APPLICATION_NOT_FOUND: no application with that id.',
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
      return { success: true, data: paged(items.map(serializeCoupon), total, take, skip) };
    },
  );

  app.post(
    '/:id/coupons',
    {
      schema: {
        tags: ['Admin · Coupons'],
        security: [{ superAdminKey: [] }],
        summary: 'Create a coupon',
        description: CREATE_COUPON_DESCRIPTION,
        params: APP_PARAMS,
        body: CREATE_COUPON_BODY_JSON_SCHEMA,
        response: {
          201: ok(ref('Coupon'), 'The created coupon.'),
          ...errs({
            400: CREATE_COUPON_400,
            ...SUPER_ADMIN_ERRORS,
            404: 'APPLICATION_NOT_FOUND: no application with that id.',
            409: 'COUPON_CODE_TAKEN: another coupon on this application already uses that code.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = Params.parse(req.params);
      const input = createCouponInput(id, req.body, undefined);
      await applicationsService.get(id);
      const coupon = await couponsService.create(input);
      return reply.status(201).send({ success: true, data: serializeCoupon(coupon) });
    },
  );

  app.patch(
    '/:id/coupons/:code',
    {
      schema: {
        tags: ['Admin · Coupons'],
        security: [{ superAdminKey: [] }],
        summary: 'Change a coupon',
        description: UPDATE_COUPON_DESCRIPTION,
        params: CODE_PARAMS,
        body: UPDATE_COUPON_BODY_JSON_SCHEMA,
        response: {
          200: ok(ref('Coupon'), 'The updated coupon.'),
          ...errs({
            400: UPDATE_COUPON_400,
            ...SUPER_ADMIN_ERRORS,
            404: 'COUPON_NOT_FOUND: no coupon with that code on this application.',
            409: UPDATE_COUPON_409,
          }),
        },
      },
    },
    async (req) => {
      const { id, code } = CodeParams.parse(req.params);
      const coupon = await couponsService.update(updateCouponInput(id, code, req.body, undefined));
      return { success: true, data: serializeCoupon(coupon) };
    },
  );
}
