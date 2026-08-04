/**
 * Two ways to make this API answer 500 with a well-formed request.
 *
 * Both were found by an external black-box audit that exercised all 276
 * operations, and both are the same mistake: a value the caller controls
 * reaches Postgres, Postgres refuses it, and the refusal surfaces as "the
 * server broke" rather than "that input is not allowed".
 *
 *   1. A NUL byte (`\u0000`) inside any JSON string. Postgres cannot store one
 *      in a text column — `22021 invalid byte sequence for encoding "UTF8"` —
 *      and 19 routes turned that into a 500, including operator sign-up, which
 *      needs no credential at all. A guard for exactly this already existed for
 *      the query string; the body simply never got one.
 *
 *   2. An integer above `int4` range. Every money and metering field was
 *      written with a floor and no ceiling, so `9007199254740991` passed
 *      validation and Postgres answered `22003 value out of range`.
 *
 * Neither is a privilege escalation — the audit confirmed the authorization
 * model held throughout. They matter because an unauthenticated caller can
 * drive the error rate at will, and because a 400 that names the field is the
 * difference between a caller fixing their own request and a caller filing a
 * bug.
 *
 * These assert the refusal is a 400 with a machine-readable code, not merely
 * "not a 500" — a route that started 404ing would otherwise pass.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const NUL = '\u0000';

describe('input hygiene', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Fixtures are built per-test, not in `beforeAll`: `test/setup.ts` truncates
   * every domain table in `beforeEach`, so anything created once up front is
   * gone before the first assertion runs.
   */
  async function fixture(slug: string): Promise<{ tenantAccess: string; applicationId: string; liveKey: string }> {
    const tenantAccess = await app
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
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: `App ${slug}`, slug },
      })
      .then((r) => (r.json().data as { id: string }).id);

    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    return { tenantAccess, applicationId, liveKey };
  }

  describe('a NUL byte in the request body', () => {
    // The audit's headline reproduction: no credential, no prior state, one
    // character. This is the route an unauthenticated attacker reaches.
    it('is refused on unauthenticated operator sign-up', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `nul-${Date.now()}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `Workspace${NUL}`,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_BODY');
    });

    it('is refused wherever it hides — nested, in an array, and as an object key', async () => {
      const { tenantAccess } = await fixture('nul-hides');
      // The guard walks the whole parsed body rather than checking a list of
      // known string fields, because the next route to accept free-form JSON
      // should be covered without anyone remembering this bug.
      const shapes = [
        { name: `App${NUL}`, slug: 'nul-flat' },
        { name: 'App', slug: 'nul-nested', metadata: { note: `x${NUL}` } },
        { name: 'App', slug: 'nul-array', tags: ['fine', `bad${NUL}`] },
        { name: 'App', slug: 'nul-key', metadata: { [`k${NUL}`]: 'v' } },
      ];

      for (const payload of shapes) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/tenant/applications/',
          headers: { authorization: `Bearer ${tenantAccess}` },
          payload,
        });
        expect(res.statusCode, `payload ${payload.slug} was not refused`).toBe(400);
        expect(res.json().error.code).toBe('INVALID_BODY');
      }
    });

    it('answers 400 even on an unknown route, without breaking routing', async () => {
      const { tenantAccess } = await fixture('nul-order');
      // The hook runs ahead of routing's 404, so a NUL body on a path that
      // does not exist gets 400 rather than 404. That is the intended
      // ordering: the body is malformed whether or not a handler exists, and
      // answering 400 first means the guard never has to know which routes
      // parse a body. It leaks nothing — the response is identical for real
      // and imaginary paths.
      const bad = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/definitely-not-a-route',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { x: `y${NUL}` },
      });
      expect(bad.statusCode).toBe(400);

      // …and routing itself is untouched: the same unknown path with a clean
      // body still 404s, so the hook is not swallowing dispatch.
      const clean = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/definitely-not-a-route',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { x: 'y' },
      });
      expect(clean.statusCode).toBe(404);
    });

    it('leaves an ordinary body alone', async () => {
      const { tenantAccess } = await fixture('nul-clean');
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: 'Perfectly Normal', slug: 'no-nul-here' },
      });
      expect(res.statusCode).toBeLessThan(300);
    });
  });

  describe('an integer past what the column holds', () => {
    // MAX_SAFE_INTEGER is what the audit sent. It is above int4 range, so
    // before the bound it reached Postgres and came back 22003 → 500.
    const HUGE = Number.MAX_SAFE_INTEGER;

    it('is refused as a credit grant, ahead of the end-user lookup', async () => {
      const { tenantAccess, applicationId } = await fixture('int-credit');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/end-users/eu_nonexistent/credits/grant`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { amount: HUGE, reason: 'GRANT' },
      });

      // 400 from the schema, not the 404 this route would otherwise give for
      // an end-user that does not exist — proof the bound is enforced at the
      // edge rather than after a database round trip.
      expect(res.statusCode).toBe(400);
    });

    it('is refused as a plan amount', async () => {
      const { tenantAccess, applicationId } = await fixture('int-plan');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/plans`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: {
          slug: 'huge',
          name: 'Huge',
          amount: HUGE,
          currency: 'usd',
          interval: 'MONTH',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('still accepts a realistic amount', async () => {
      const { tenantAccess, applicationId } = await fixture('int-ok');
      // The ceiling is far above any real price; this pins that the bound did
      // not quietly become a functional limit.
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/plans`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: {
          slug: 'realistic',
          name: 'Realistic',
          amount: 4_900_000, // $49,000.00
          currency: 'usd',
          interval: 'MONTH',
        },
      });

      expect(res.statusCode).toBeLessThan(300);
    });
  });
});
