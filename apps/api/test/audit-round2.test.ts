/**
 * Four findings from the second external audit — the verification pass over
 * the nine fixes that shipped earlier in 2.0.0-rc.3.
 *
 * Two are new. Two are the same defect class as fixes that had already landed,
 * caught because the auditor probed the *boundary* rather than re-running the
 * original reproduction:
 *
 *   1. The money bound was set to 10^11 on the reasoning that it was "a sane
 *      ceiling for money". The column is `Int` — Postgres `integer`, max
 *      2147483647. So everything from 2147483648 up to the declared maximum
 *      still reached Postgres and came back `22003 value out of range`,
 *      including the exact `maximum` the OpenAPI document advertised. The fix
 *      that closed the 500 for `Number.MAX_SAFE_INTEGER` left a 46×-wide band
 *      of values that still 500.
 *
 *   2. `PATCH` and `DELETE` on billing credentials went straight to a Prisma
 *      `update`/`delete`, which throws `P2025` on a missing row and surfaces
 *      as a 500. `setMode`, one method up in the same file, had guarded this
 *      correctly since it was written.
 *
 *   3. `GET /tenant/applications/{id}` returned the encrypted credential blobs
 *      to any reader, including a read-only APP_VIEWER — an audience that only
 *      became reachable when grant-scoped access became the default.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('second-audit findings', () => {
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
          amount: JUST_OVER_INT4,
          currency: 'usd',
          interval: 'MONTH',
        },
      });

      // 400 from the schema. The point is that it is not 500 — this exact
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
          amount: INT4_MAX,
          currency: 'usd',
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
        payload: { code: 'OVER', discountType: 'AMOUNT', amountOff: JUST_OVER_INT4 },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('billing credentials that were never stored', () => {
    it('DELETE answers 404, not 500', async () => {
      const { token, applicationId } = await fixture('bc-del');
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/tenant/applications/${applicationId}/billing-credentials/stripe`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('BILLING_CREDENTIALS_NOT_CONFIGURED');
    });

    it('PATCH routing answers 404, not 500', async () => {
      const { token, applicationId } = await fixture('bc-patch');
      // Routing lives on the provider path itself — `countries`/`priority` in
      // the body route to `setRouting`, which was the unguarded call.
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${applicationId}/billing-credentials/stripe`,
        headers: { authorization: `Bearer ${token}` },
        payload: { countries: ['US'], priority: 1 },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('BILLING_CREDENTIALS_NOT_CONFIGURED');
    });
  });

  describe('encrypted credential blobs never leave the API', () => {
    const SECRET_COLUMNS = [
      'oauthCredentialsCiphertext',
      'emailCredentialsCiphertext',
      'billingCredentialsCiphertext',
    ];

    it('are absent from the Application detail response', async () => {
      const { token, applicationId } = await fixture('cipher-detail');
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${applicationId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      for (const column of SECRET_COLUMNS) {
        expect(res.json().data, `${column} is being served to the client`).not.toHaveProperty(
          column,
        );
      }
    });

    it('are absent from the Application list response', async () => {
      const { token } = await fixture('cipher-list');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      // `{items, page}` since 2.0.0-rc.3 — every list endpoint returns the
      // envelope, so the rows live under `items`.
      const { items: rows, page } = res.json().data as {
        items: Array<Record<string, unknown>>;
        page: { total: number };
      };
      expect(rows.length).toBeGreaterThan(0);
      // The fixture creates one Application; if `total` ever exceeded the
      // window, this test would be checking a subset of the rows it claims to.
      expect(page.total).toBe(rows.length);
      for (const row of rows) {
        for (const column of SECRET_COLUMNS) {
          expect(row, `${column} is being served in the list`).not.toHaveProperty(column);
        }
      }
    });

    it('the whole response body contains no ciphertext column name', async () => {
      // A blunt backstop: the two assertions above check the top level, and a
      // future nested `application: {...}` would slip past them.
      const { token, applicationId } = await fixture('cipher-raw');
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${applicationId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      for (const column of SECRET_COLUMNS) {
        expect(res.body).not.toContain(column);
      }
    });
  });
});
