/**
 * Plan and coupon amounts are bounded by what the column holds. The column is
 * Postgres `integer`, so the largest amount is 2147483647: one past it is a
 * 400, and the maximum itself is accepted rather than reaching Postgres as
 * `22003 value out of range`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('plan and coupon amount bounds', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Per-test: `test/setup.ts` truncates every domain table in beforeEach. */
  async function fixture(slug: string): Promise<{ token: string; applicationId: string }> {
    const token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    const applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);

    return { token, applicationId };
  }
  describe('money bounds match the column, not a guess', () => {
    // One past int4. The old bound (1e11) accepted this and Postgres did not.
    const JUST_OVER_INT4 = 2_147_483_648;
    const INT4_MAX = 2_147_483_647;

    it('refuses a plan amount one past what the column holds', async () => {
      const { token, applicationId } = await fixture('int4-plan');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/plans`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          slug: 'over',
          name: 'Over',
          price: { currency: 'usd', amount: JUST_OVER_INT4 },
          interval: 'MONTH',
        },
      });

      // 400 from the schema. The point is that it is not 500, this exact
      // value used to reach Postgres and come back 22003.
      expect(res.statusCode).toBe(400);
    });

    it('accepts the declared maximum, which used to 500', async () => {
      // The sharpest version of the bug: the document advertised a `maximum`
      // that was itself guaranteed to fail. Whatever the bound is, sending
      // exactly it has to work.
      const { token, applicationId } = await fixture('int4-max');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/plans`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          slug: 'atmax',
          name: 'At max',
          price: { currency: 'usd', amount: INT4_MAX },
          interval: 'MONTH',
        },
      });

      expect(res.statusCode).toBeLessThan(300);
    });

    it('refuses a coupon amountOff one past the column too', async () => {
      const { token, applicationId } = await fixture('int4-coupon');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/coupons`,
        headers: { authorization: `Bearer ${token}` },
        payload: { code: 'OVER', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: JUST_OVER_INT4 }] },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
