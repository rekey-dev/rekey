/**
 * The coupon write and read surface: a percentage in basis points, or a fixed
 * amount per currency, and nothing left of the single `amountOff`/`currency`
 * pair. Every assertion is on an HTTP response except the billing log, which
 * has no reader route yet and is read from its table.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

const FIXED = {
  code: 'FIVEOFF',
  discountType: 'AMOUNT',
  amounts: [
    { currency: 'usd', amountOff: 500 },
    { currency: 'INR', amountOff: 40000 },
  ],
};

describe('coupon amounts on the wire', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await twoCurrencyWorld(app);
  });

  const create = (body: Record<string, unknown>) => w.operator('POST', '/coupons', body);
  const patch = (code: string, body: Record<string, unknown>) => w.operator('PATCH', `/coupons/${code}`, body);
  const asAdmin = (method: 'POST' | 'PATCH' | 'GET', url: string, payload?: Record<string, unknown>) =>
    app.inject({
      method,
      url: `/api/v1/admin/applications/${w.applicationId}${url}`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      ...(payload !== undefined && { payload }),
    });
  const listed = async (): Promise<Array<Record<string, unknown>>> =>
    ((await w.operator('GET', '/coupons')).json().data as { items: Array<Record<string, unknown>> }).items;
  const events = (type: string) =>
    prisma.billingEvent.findMany({ where: { applicationId: w.applicationId, type }, orderBy: { seq: 'asc' } });
  const expectRefused = (res: LightMyRequestResponse, code: string): { message: string; fix: string } => {
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe(code);
    return res.json().error as { message: string; fix: string };
  };

  describe('create and read', () => {
    it('stores a fixed coupon as one amount per currency and returns exactly that', async () => {
      const res = await create(FIXED);
      expect(res.statusCode, res.body).toBe(201);
      const coupon = res.json().data as Record<string, unknown>;
      expect(coupon).toMatchObject({
        code: 'fiveoff',
        discountType: 'AMOUNT',
        basisPoints: null,
        amounts: [
          { currency: 'INR', amountOff: 40000 },
          { currency: 'USD', amountOff: 500 },
        ],
        currencies: [],
        coveredCurrencies: ['INR', 'USD'],
        planSlugs: [],
        active: true,
      });
      expect(coupon.amounts).toEqual([
        { currency: 'INR', amountOff: 40000 },
        { currency: 'USD', amountOff: 500 },
      ]);
      expect(coupon).not.toHaveProperty('amountOff');
      expect(coupon).not.toHaveProperty('currency');

      const one = await w.operator('GET', '/coupons/FIVEOFF');
      expect(one.statusCode, one.body).toBe(200);
      expect(one.json().data).toEqual(coupon);
      expect((await listed())[0]).toEqual({ ...coupon, redemptionCount: 0, discountIssuedByCurrency: [] });
      const viaAdmin = (await asAdmin('GET', '/coupons')).json().data as { items: unknown[] };
      expect(viaAdmin.items).toEqual([coupon]);
    });

    it('stores a percentage in basis points, for any currency or the ones it is limited to', async () => {
      const anywhere = (await create({ code: 'ANY15', discountType: 'PERCENT', basisPoints: 1500 })).json().data;
      expect(anywhere).toMatchObject({ basisPoints: 1500, amounts: [], currencies: [], coveredCurrencies: null });
      expect(anywhere).not.toHaveProperty('amountOff');

      const limited = await create({ code: 'USD15', discountType: 'PERCENT', basisPoints: 1500, currencies: ['usd', 'USD', 'eur'] });
      expect(limited.json().data).toMatchObject({ currencies: ['EUR', 'USD'], coveredCurrencies: ['EUR', 'USD'] });
    });

    it('answers 404 COUPON_NOT_FOUND for a code the Application does not have', async () => {
      const res = await w.operator('GET', '/coupons/nope');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('COUPON_NOT_FOUND');
    });

    it.each([
      ['a top-level amountOff', { code: 'OLD', discountType: 'PERCENT', amountOff: 1500 }, 'BILLING_FIELD_REMOVED', '`basisPoints`'],
      ['a top-level currency', { code: 'OLD', discountType: 'AMOUNT', currency: 'USD', amounts: [{ currency: 'USD', amountOff: 5 }] }, 'BILLING_FIELD_REMOVED', '`amounts`'],
      ['a fixed coupon with no amounts', { code: 'X', discountType: 'AMOUNT' }, 'COUPON_AMOUNTS_REQUIRED', '`amounts`'],
      ['a fixed coupon with an empty list', { code: 'X', discountType: 'AMOUNT', amounts: [] }, 'COUPON_AMOUNTS_REQUIRED', '`amounts`'],
      ['a three-decimal currency', { code: 'X', discountType: 'AMOUNT', amounts: [{ currency: 'KWD', amountOff: 1000 }] }, 'COUPON_CURRENCY_INVALID', 'ISO 4217'],
      ['a code that is not money', { code: 'X', discountType: 'AMOUNT', amounts: [{ currency: 'XAU', amountOff: 1 }] }, 'COUPON_CURRENCY_INVALID', 'ISO 4217'],
      ['a code nobody issues', { code: 'X', discountType: 'AMOUNT', amounts: [{ currency: 'ABC', amountOff: 1 }] }, 'COUPON_CURRENCY_INVALID', 'ISO 4217'],
      ['a forint amount that is not whole forints', { code: 'X', discountType: 'AMOUNT', amounts: [{ currency: 'HUF', amountOff: 50050 }] }, 'COUPON_AMOUNT_INVALID', '50000 is HUF 500'],
      ['an amount of zero', { code: 'X', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 0 }] }, 'COUPON_AMOUNT_INVALID', 'above zero'],
      ['a negative amount', { code: 'X', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: -5 }] }, 'COUPON_AMOUNT_INVALID', 'above zero'],
      ['an amount past the column', { code: 'X', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 2_147_483_648 }] }, 'COUPON_AMOUNT_INVALID', 'above zero'],
      ['one currency twice', { code: 'X', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 5 }, { currency: 'usd', amountOff: 6 }] }, 'COUPON_AMOUNT_INVALID', 'one entry per currency'],
      ['amounts on a percentage', { code: 'X', discountType: 'PERCENT', basisPoints: 1000, amounts: [{ currency: 'USD', amountOff: 5 }] }, 'COUPON_DISCOUNT_SHAPE_INVALID', 'Remove `amounts`'],
      ['basis points on a fixed coupon', { code: 'X', discountType: 'AMOUNT', basisPoints: 1000, amounts: [{ currency: 'USD', amountOff: 5 }] }, 'COUPON_DISCOUNT_SHAPE_INVALID', 'Remove `basisPoints`'],
      ['a currency limit on a fixed coupon', { code: 'X', discountType: 'AMOUNT', currencies: ['USD'], amounts: [{ currency: 'USD', amountOff: 5 }] }, 'COUPON_DISCOUNT_SHAPE_INVALID', 'Remove `currencies`'],
      ['a percentage with no rate', { code: 'X', discountType: 'PERCENT' }, 'COUPON_AMOUNT_INVALID', '1500 is 15%'],
      ['a percentage of zero', { code: 'X', discountType: 'PERCENT', basisPoints: 0 }, 'COUPON_AMOUNT_INVALID', '1500 is 15%'],
      ['a percentage over 100', { code: 'X', discountType: 'PERCENT', basisPoints: 10001 }, 'COUPON_AMOUNT_INVALID', '1500 is 15%'],
      ['a percentage limited to a currency no price can be in', { code: 'X', discountType: 'PERCENT', basisPoints: 1000, currencies: ['BHD'] }, 'COUPON_CURRENCY_INVALID', 'ISO 4217'],
    ])('refuses %s, on both operator surfaces, and creates nothing', async (_what, body, code, fixNames) => {
      expect(expectRefused(await create(body), code).fix).toContain(fixNames);
      expectRefused(await asAdmin('POST', '/coupons', body), code);
      expect(await listed()).toEqual([]);
      expect(await events('coupon.created')).toEqual([]);
    });

    it('accepts the bodies its refusals tell the caller to send', async () => {
      // BILLING_FIELD_REMOVED names `basisPoints` and `amounts`; these are those bodies.
      expect((await create({ code: 'P', discountType: 'PERCENT', basisPoints: 1500 })).statusCode).toBe(201);
      expect((await create({ code: 'A', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 500 }] })).statusCode).toBe(201);
      // COUPON_AMOUNT_INVALID for HUF says 50000 is HUF 500, and 10000 basis points is 100%.
      expect((await create({ code: 'H', discountType: 'AMOUNT', amounts: [{ currency: 'HUF', amountOff: 50000 }] })).statusCode).toBe(201);
      expect((await create({ code: 'FULL', discountType: 'PERCENT', basisPoints: 10000 })).statusCode).toBe(201);
      expect((await create({ code: 'ONE', discountType: 'PERCENT', basisPoints: 1 })).statusCode).toBe(201);
      expect((await create({ code: 'Y', discountType: 'AMOUNT', amounts: [{ currency: 'JPY', amountOff: 500 }] })).statusCode).toBe(201);
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      expect((await create(FIXED)).statusCode).toBe(201);
      expect((await create({ code: 'PCT', discountType: 'PERCENT', basisPoints: 1500 })).statusCode).toBe(201);
    });

    it('replaces the whole set of amounts', async () => {
      const res = await patch('FIVEOFF', { amounts: [{ currency: 'USD', amountOff: 700 }, { currency: 'EUR', amountOff: 650 }] });
      expect(res.statusCode, res.body).toBe(200);
      const expected = [
        { currency: 'EUR', amountOff: 650 },
        { currency: 'USD', amountOff: 700 },
      ];
      expect(res.json().data).toMatchObject({ amounts: expected, coveredCurrencies: ['EUR', 'USD'] });
      expect((await w.operator('GET', '/coupons/fiveoff')).json().data.amounts).toEqual(expected);
    });

    it('changes a percentage, the currencies it is limited to, its plans and whether it is on', async () => {
      const res = await patch('PCT', { basisPoints: 2500, currencies: ['inr'], planSlugs: ['PRO'], active: false });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({
        basisPoints: 2500,
        currencies: ['INR'],
        coveredCurrencies: ['INR'],
        planSlugs: ['pro'],
        active: false,
      });
      // A field left out keeps its value.
      expect((await patch('PCT', { active: true })).json().data).toMatchObject({ basisPoints: 2500, currencies: ['INR'], active: true });
      // An empty list lifts the limit.
      expect((await patch('PCT', { currencies: [] })).json().data).toMatchObject({ currencies: [], coveredCurrencies: null });
    });

    it.each([
      ['FIVEOFF', { amountOff: 700 }, 'BILLING_FIELD_REMOVED'],
      ['FIVEOFF', { currency: 'EUR' }, 'BILLING_FIELD_REMOVED'],
      ['FIVEOFF', { amounts: [] }, 'COUPON_AMOUNTS_REQUIRED'],
      ['FIVEOFF', { basisPoints: 1000 }, 'COUPON_DISCOUNT_SHAPE_INVALID'],
      ['FIVEOFF', { currencies: ['USD'] }, 'COUPON_DISCOUNT_SHAPE_INVALID'],
      ['FIVEOFF', { amounts: [{ currency: 'OMR', amountOff: 1000 }] }, 'COUPON_CURRENCY_INVALID'],
      ['FIVEOFF', { amounts: [{ currency: 'TWD', amountOff: 150 }] }, 'COUPON_AMOUNT_INVALID'],
      ['PCT', { amounts: [{ currency: 'USD', amountOff: 5 }] }, 'COUPON_DISCOUNT_SHAPE_INVALID'],
      ['PCT', { basisPoints: 0 }, 'COUPON_AMOUNT_INVALID'],
      ['PCT', {}, 'VALIDATION_ERROR'],
    ])('refuses PATCH %s %j with %s and changes nothing', async (code, body, expected) => {
      const before = (await w.operator('GET', `/coupons/${code}`)).json().data;
      expectRefused(await patch(code, body), expected);
      expectRefused(await asAdmin('PATCH', `/coupons/${code}`, body), expected);
      expect((await w.operator('GET', `/coupons/${code}`)).json().data).toEqual(before);
      expect(await events('coupon.changed')).toEqual([]);
    });

    it('answers 404 for a code the Application does not have, and never touches another Application', async () => {
      const res = await patch('nope', { active: false });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('COUPON_NOT_FOUND');

      const other = await twoCurrencyWorld(app);
      expect((await other.operator('PATCH', '/coupons/FIVEOFF', { active: false })).statusCode).toBe(404);
      expect((await other.operator('GET', '/coupons/FIVEOFF')).statusCode).toBe(404);
      expect((await w.operator('GET', '/coupons/FIVEOFF')).json().data.active).toBe(true);
    });
  });

  describe('the billing log', () => {
    it('records a coupon being created, with its terms, by the operator who did it', async () => {
      const coupon = (await create({ ...FIXED, planSlugs: ['pro'] })).json().data as { id: string };
      const logged = await events('coupon.created');
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        tier: 'PERMANENT',
        actorType: 'OPERATOR',
        couponId: coupon.id,
        data: {
          code: 'fiveoff',
          discountType: 'AMOUNT',
          terms: {
            active: true,
            basisPoints: null,
            amounts: [
              { currency: 'INR', amountOff: 40000 },
              { currency: 'USD', amountOff: 500 },
            ],
            currencies: [],
            planSlugs: ['pro'],
          },
        },
      });
      expect(logged[0]!.actorId).toEqual(expect.any(String));

      await asAdmin('POST', '/coupons', { code: 'SYS', discountType: 'PERCENT', basisPoints: 1000 });
      expect((await events('coupon.created'))[1]).toMatchObject({ actorType: 'SYSTEM', actorId: null });
    });

    it('records a change with the terms before and after, and nothing for a call that changed nothing', async () => {
      await create(FIXED);
      await patch('FIVEOFF', { amounts: [{ currency: 'USD', amountOff: 700 }] });
      const logged = await events('coupon.changed');
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        actorType: 'OPERATOR',
        data: {
          code: 'fiveoff',
          before: { active: true, amounts: [{ currency: 'INR', amountOff: 40000 }, { currency: 'USD', amountOff: 500 }] },
          after: { active: true, amounts: [{ currency: 'USD', amountOff: 700 }] },
        },
      });

      await patch('FIVEOFF', { amounts: [{ currency: 'usd', amountOff: 700 }], active: true });
      expect(await events('coupon.changed')).toHaveLength(1);

      await patch('FIVEOFF', { active: false });
      expect((await events('coupon.changed'))[1]).toMatchObject({ data: { before: { active: true }, after: { active: false } } });
    });

    it('writes no creation event for a coupon that was not created', async () => {
      await create(FIXED);
      const dup = await create(FIXED);
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('COUPON_CODE_TAKEN');
      expect(await events('coupon.created')).toHaveLength(1);
    });
  });
});
