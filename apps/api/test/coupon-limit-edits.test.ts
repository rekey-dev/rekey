/**
 * Editing a coupon's end date and redemption caps: what the PATCH accepts,
 * that a cap is never set below the redemptions already held, and that every
 * change is in the billing log with before and after. Asserted on HTTP
 * responses.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { BillingLogPageSchema, CouponDtoSchema, type BillingLogEntry } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { couponsService } from '../src/modules/coupons/coupons.service.js';
import { twoCurrencyWorld, type Buyer, type TwoCurrencyWorld } from './two-currency-world.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const END = '2027-01-31T23:59:59.000Z';

interface Refusal {
  code: string;
  message: string;
  fix: string;
  details: { field: string; requested: number; redeemed: number; settled: number; reserved: number };
}

describe('editing a coupon end date and redemption caps', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;
  let serial = 0;

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

  const create = async (body: Record<string, unknown> = {}): Promise<{ id: string; code: string }> => {
    serial += 1;
    const res = await w.operator('POST', '/coupons', { code: `CAP${serial}`, discountType: 'PERCENT', basisPoints: 1000, ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data as { id: string; code: string };
  };
  const patch = (code: string, body: Record<string, unknown>) => w.operator('PATCH', `/coupons/${code}`, body);
  const read = async (code: string) => CouponDtoSchema.parse((await w.operator('GET', `/coupons/${code}`)).json().data);
  const changes = async (): Promise<Array<Extract<BillingLogEntry, { type: 'coupon.changed' }>>> => {
    const res = await w.operator('GET', '/billing/events?type=coupon.changed');
    expect(res.statusCode, res.body).toBe(200);
    // Strict: a key the event schema does not declare fails here. Oldest first.
    return BillingLogPageSchema.parse(res.json().data)
      .items.flatMap((entry) => (entry.type === 'coupon.changed' ? [entry] : []))
      .reverse();
  };
  const refusalOf = (res: LightMyRequestResponse): Refusal => {
    expect(res.statusCode, res.body).toBe(409);
    const error = res.json().error as Refusal;
    expect(error.code).toBe('COUPON_LIMIT_BELOW_REDEEMED');
    return error;
  };

  /** A checkout holding the coupon: one RESERVED slot for that buyer. */
  async function reserve(code: string, buyer?: Buyer): Promise<Buyer> {
    const who = buyer ?? (await w.newBuyer());
    const res = await w.checkout({ couponCode: code }, { buyer: who });
    expect(res.statusCode, res.body).toBe(200);
    return who;
  }

  /** A settled redemption, as a payment confirms one. */
  async function settle(couponId: string, buyer: Buyer): Promise<void> {
    serial += 1;
    const outcome = await couponsService.redeemForCheckout({
      couponId,
      applicationId: w.applicationId,
      endUserId: buyer.id,
      checkoutSessionId: `cs_settled_${serial}`,
      discountAmount: 200,
      currency: 'USD',
    });
    expect(outcome).toEqual({ recorded: true });
  }

  describe('what the PATCH accepts', () => {
    it('sets and removes the end date, and each change is in the billing log with before and after', async () => {
      const { code } = await create();
      const set = await patch(code, { endsAt: END });
      expect(set.statusCode, set.body).toBe(200);
      expect(CouponDtoSchema.parse(set.json().data).endsAt).toBe(END);
      expect((await read(code)).endsAt).toBe(END);

      const removed = await patch(code, { endsAt: null });
      expect(removed.statusCode, removed.body).toBe(200);
      expect((await read(code)).endsAt).toBeNull();

      const logged = await changes();
      expect(logged.map((entry) => [entry.data.before.endsAt, entry.data.after.endsAt])).toEqual([
        [null, END],
        [END, null],
      ]);
      expect(logged[0]).toMatchObject({ actor: { type: 'operator' }, couponId: expect.any(String) as string });
      expect(logged[0]!.actor.id).toEqual(expect.any(String));
    });

    it('sets, changes and removes each cap, logged before and after, and a call that changes nothing logs nothing', async () => {
      const { code } = await create({ maxRedemptions: 50 });
      const set = await patch(code, { maxRedemptions: 20, maxRedemptionsPerUser: 2 });
      expect(set.statusCode, set.body).toBe(200);
      expect(await read(code)).toMatchObject({ maxRedemptions: 20, maxRedemptionsPerUser: 2 });

      expect((await patch(code, { maxRedemptions: 20 })).statusCode).toBe(200);
      expect((await patch(code, { maxRedemptions: null, maxRedemptionsPerUser: null })).statusCode).toBe(200);
      expect(await read(code)).toMatchObject({ maxRedemptions: null, maxRedemptionsPerUser: null });

      const logged = await changes();
      expect(logged.map((entry) => [entry.data.before, entry.data.after].map((t) => [t.maxRedemptions, t.maxRedemptionsPerUser]))).toEqual([
        [[50, null], [20, 2]],
        [[20, 2], [null, null]],
      ]);
    });

    it('leaves what it was not sent as it was', async () => {
      const { code } = await create({ endsAt: END, maxRedemptions: 9, maxRedemptionsPerUser: 3 });
      expect((await patch(code, { active: false })).statusCode).toBe(200);
      expect(await read(code)).toMatchObject({ active: false, endsAt: END, maxRedemptions: 9, maxRedemptionsPerUser: 3 });
    });

    it.each([
      [{ maxRedemptions: 0 }],
      [{ maxRedemptions: -1 }],
      [{ maxRedemptions: 1.5 }],
      [{ maxRedemptionsPerUser: 0 }],
      [{ maxRedemptionsPerUser: 'three' }],
      [{ maxRedemptions: 2_147_483_648 }],
      [{ endsAt: 'next year' }],
      [{ endsAt: '2027-01-31' }],
    ])('refuses %o with a 400 and changes nothing', async (body) => {
      const { code } = await create({ maxRedemptions: 9 });
      const res = await patch(code, body);
      expect(res.statusCode, res.body).toBe(400);
      expect(await read(code)).toMatchObject({ maxRedemptions: 9, maxRedemptionsPerUser: null, endsAt: null });
      expect(await changes()).toEqual([]);
    });

    it('takes the same fields with the super-admin key, logged as the system', async () => {
      const { code } = await create();
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/applications/${w.applicationId}/coupons/${code}`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { endsAt: END, maxRedemptions: 7 },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await read(code)).toMatchObject({ endsAt: END, maxRedemptions: 7 });
      expect((await changes())[0]).toMatchObject({ actor: { type: 'system', id: null }, data: { after: { maxRedemptions: 7, endsAt: END } } });
    });

    it('an end date in the past stops the coupon at the next checkout', async () => {
      const { code } = await create();
      await reserve(code);
      expect((await patch(code, { endsAt: '2020-01-01T00:00:00.000Z' })).statusCode).toBe(200);
      const late = await w.checkout({ couponCode: code }, { buyer: await w.newBuyer() });
      expect(late.json().error.code).toBe('COUPON_EXPIRED');
    });
  });

  describe('a cap below what is already redeemed', () => {
    it('is refused for the overall cap, counting settled redemptions and open checkouts, and the fix it names works', async () => {
      const { id, code } = await create({ maxRedemptions: 10 });
      await settle(id, await w.newBuyer());
      await reserve(code);
      await reserve(code);

      const refused = refusalOf(await patch(code, { maxRedemptions: 2, active: false }));
      expect(refused.details).toEqual({ field: 'maxRedemptions', requested: 2, redeemed: 3, settled: 1, reserved: 2 });
      expect(refused.message).toContain('3 redemptions (1 settled, 2 held by checkouts still open)');
      expect(refused.fix).toContain('`maxRedemptions` of 3 or more, or null for no cap');
      // Nothing of a refused edit is applied or logged.
      expect(await read(code)).toMatchObject({ maxRedemptions: 10, active: true });
      expect(await changes()).toEqual([]);

      // The fix, followed literally: the count it names is accepted.
      expect((await patch(code, { maxRedemptions: refused.details.redeemed })).statusCode).toBe(200);
      const full = await w.checkout({ couponCode: code }, { buyer: await w.newBuyer() });
      expect(full.json().error.code).toBe('COUPON_REDEMPTION_LIMIT_REACHED');

      // And so is null, after which another buyer gets in.
      expect((await patch(code, { maxRedemptions: null })).statusCode).toBe(200);
      await reserve(code);
    });

    it('does not count a checkout that has expired, as a reservation does not', async () => {
      const { id, code } = await create();
      await reserve(code);
      await reserve(code);
      expect(refusalOf(await patch(code, { maxRedemptions: 1 })).details.redeemed).toBe(2);

      await prisma.couponRedemption.updateMany({ where: { couponId: id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await patch(code, { maxRedemptions: 1 })).statusCode).toBe(200);
      await reserve(code);
    });

    it('is refused for the per-user cap when one buyer already holds more, naming their count', async () => {
      const { id, code } = await create({ maxRedemptionsPerUser: 5 });
      const heavy = await w.newBuyer();
      await settle(id, heavy);
      await settle(id, heavy);
      await reserve(code, heavy);
      await settle(id, await w.newBuyer());

      const refused = refusalOf(await patch(code, { maxRedemptionsPerUser: 2 }));
      expect(refused.details).toEqual({ field: 'maxRedemptionsPerUser', requested: 2, redeemed: 3, settled: 2, reserved: 1 });
      expect(refused.message).toContain('One buyer already holds 3 redemptions');
      expect(refused.fix).toContain('`maxRedemptionsPerUser` of 3 or more, or null for no cap');
      expect((await read(code)).maxRedemptionsPerUser).toBe(5);

      // Four are held in all, so an overall cap of four is fine while a per-user cap of two is not.
      expect((await patch(code, { maxRedemptions: 4 })).statusCode).toBe(200);
      expect((await patch(code, { maxRedemptionsPerUser: refused.details.redeemed })).statusCode).toBe(200);
      expect(await read(code)).toMatchObject({ maxRedemptions: 4, maxRedemptionsPerUser: 3 });
    });

    it('never lets a redemption slip under a cap being lowered: eight checkouts race three edits', async () => {
      for (let round = 0; round < 4; round += 1) {
        const { id, code } = await create({ maxRedemptions: 100 });
        const cap = 3 + round;
        const buyers = await Promise.all(Array.from({ length: 8 }, () => w.newBuyer()));
        const reserving = (buyer: Buyer) =>
          couponsService
            .reserveForCheckout({
              couponId: id,
              applicationId: w.applicationId,
              endUserId: buyer.id,
              code,
              discountAmount: 200,
              currency: 'USD',
              planPriceId: null,
            })
            .then(
              () => 'reserved' as const,
              (err: { code?: string }) => err.code ?? 'threw',
            );
        const lowering = () => patch(code, { maxRedemptions: cap });

        const [r0, r1, e0, r2, r3, e1, r4, r5, e2, r6, r7] = await Promise.all([
          reserving(buyers[0]!),
          reserving(buyers[1]!),
          lowering(),
          reserving(buyers[2]!),
          reserving(buyers[3]!),
          lowering(),
          reserving(buyers[4]!),
          reserving(buyers[5]!),
          lowering(),
          reserving(buyers[6]!),
          reserving(buyers[7]!),
        ]);
        const reserved = [r0, r1, r2, r3, r4, r5, r6, r7];
        const edits = [e0, e1, e2];

        const held = await prisma.couponRedemption.count({ where: { couponId: id } });
        const after = await read(code);
        expect(held, `round ${round}`).toBe(reserved.filter((outcome) => outcome === 'reserved').length);
        expect(held, `round ${round}: ${held} held under a cap of ${after.maxRedemptions}`).toBeLessThanOrEqual(after.maxRedemptions!);
        for (const edit of edits) {
          expect([200, 409], edit.body).toContain(edit.statusCode);
          if (edit.statusCode === 409) expect(refusalOf(edit).details.redeemed, `round ${round}`).toBeGreaterThan(cap);
        }
        if (edits.some((edit) => edit.statusCode === 200)) {
          expect(after.maxRedemptions, `round ${round}`).toBe(cap);
          expect(reserved.every((outcome) => outcome === 'reserved' || outcome === 'COUPON_REDEMPTION_LIMIT_REACHED')).toBe(true);
        } else {
          expect(after.maxRedemptions, `round ${round}`).toBe(100);
          expect(held, `round ${round}`).toBe(8);
        }
      }
    });
  });

  describe('entries written before the end date and caps were logged', () => {
    it('are still read by the log route, without the new keys', async () => {
      const { id, code } = await create();
      const terms = { active: true, basisPoints: 1000, amounts: [], currencies: [], planSlugs: [] };
      await prisma.billingEvent.create({
        data: {
          applicationId: w.applicationId,
          type: 'coupon.changed',
          tier: 'PERMANENT',
          occurredAt: new Date(),
          dedupeKey: `old-coupon-change-${id}`,
          actorType: 'SYSTEM',
          couponId: id,
          data: { code: code.toLowerCase(), discountType: 'PERCENT', before: terms, after: { ...terms, active: false } },
        },
      });
      const [old] = await changes();
      expect(old!.data.after).toEqual({ ...terms, active: false });
      expect(old!.data.after).not.toHaveProperty('maxRedemptions');
    });
  });
});
