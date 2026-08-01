/**
 * Regressions for the second batch of #298 findings — the error contract, the
 * audit trail, and the two surfaces that were withholding what an operator
 * needs.
 *
 *  1. A bad query param answered `500 INTERNAL_ERROR`. The `/admin/metrics/*`
 *     routes declare no Fastify `querystring` schema, so the handler's Zod
 *     parse is the only validator — and `rekeyErrorHandler` had no ZodError
 *     branch, so a raw ZodError fell through to the generic 500 with "share
 *     this request id with support". Two independent reviewers hit the same
 *     class on different routes.
 *  2. `PATCH .../billing-config` answered 200 for a misspelled key and did
 *     nothing — every key is optional, so a non-strict object had nothing left
 *     to fail on.
 *  3. Failed sign-ins were never recorded anywhere, so "why can't this user
 *     sign in?" was not answerable from the panel.
 *  4. `GET .../deliveries` selected `payload` and `responseBody` and then
 *     omitted them, contradicting its own docblock.
 *  5. Operator sign-up accepted `password`, while the product ships HIBP
 *     breach checking for its customers' end-users.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { setDeliveryScheduler } from '../src/modules/webhooks/webhook.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('Error contract, audit trail, and withheld operator data', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------- 1 ------

  describe('a schema-invalid request is 400, never 500', () => {
    const cases: Array<[string, string]> = [
      ['limit above the cap', 'tenants?limit=500'],
      ['unknown sort column', 'tenants?sort=bogus'],
      ['unknown sort direction', 'tenants?order=sideways'],
      ['negative offset', 'tenants?offset=-1'],
      ['unknown payment status', 'payments?status=NOPE'],
    ];

    it.each(cases)('%s → 400 VALIDATION_ERROR', async (_name, path) => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/metrics/${path}`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as {
        success: boolean;
        error: { code: string; message: string; fix: string; issues: unknown[] };
      };
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      // The point of the fix: the caller is told which field, not to contact
      // support about a server error.
      expect(body.error.message).not.toMatch(/unexpected error/i);
      expect(body.error.fix).not.toMatch(/support/i);
      expect(Array.isArray(body.error.issues)).toBe(true);
      expect(body.error.issues.length).toBeGreaterThan(0);
    });

    it('names the offending field in `issues`', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/metrics/tenants?limit=500',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      const issues = (res.json() as { error: { issues: Array<{ path: string; message: string }> } })
        .error.issues;
      expect(issues.some((i) => i.path === 'limit')).toBe(true);
    });

    it('a genuine server bug is still 500 INTERNAL_ERROR', async () => {
      // The new branch keys off `instanceof ZodError` specifically, so a plain
      // Error must be untouched by it. Driven through the real handler on a
      // throwaway instance, because nothing in the product deliberately
      // throws. (`error-envelope.test.ts` pins the same invariant against a
      // fuller harness; this one guards THIS change.)
      const { default: Fastify } = await import('fastify');
      const { rekeyErrorHandler } = await import('../src/lib/error.js');
      const instance = Fastify({ logger: false });
      instance.setErrorHandler(rekeyErrorHandler);
      instance.get('/boom', async () => {
        throw new Error('a genuine bug');
      });
      const res = await instance.inject({ method: 'GET', url: '/boom' });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
      await instance.close();
    });
  });

  // ------------------------------------------------------- 2, 3, 4, 5 ------

  describe('with a workspace and application', () => {
    let tenantId: string;
    let applicationId: string;
    let liveKey: string;
    let operatorToken: string;

    beforeEach(async () => {
      const email = `${unique('op')}@example.com`;
      const signUp = await app
        .inject({
          method: 'POST',
          url: '/api/v1/tenant/auth/sign-up',
          payload: { email, password: 'correct-horse-battery-staple-42', workspaceName: 'W' },
        })
        .then((r) => r.json().data as { accessToken: string; activeTenantId: string });
      operatorToken = signUp.accessToken;
      tenantId = signUp.activeTenantId;

      const application = await app
        .inject({
          method: 'POST',
          url: '/api/v1/admin/applications',
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { tenantId, name: 'A', slug: unique('app'), enableBilling: true },
        })
        .then((r) => r.json().data as { id: string });
      applicationId = application.id;

      liveKey = await app
        .inject({
          method: 'POST',
          url: `/api/v1/admin/applications/${applicationId}/api-keys`,
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { name: 'k', mode: 'live' },
        })
        .then((r) => (r.json().data as { rawKey: string }).rawKey);
    });

    // ---------------------------------------------------------- 2 ------

    it('billing-config refuses a misspelled key instead of answering 200', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${applicationId}/billing-config`,
        headers: { authorization: `Bearer ${operatorToken}` },
        // The exact shape that used to answer 200 and change nothing: an
        // operator turning dunning on, being told it worked, and getting
        // nothing.
        payload: { dunningEnabld: true },
      });
      expect(res.statusCode).toBe(400);
      const err = (res.json() as { error: { code: string; issues: Array<{ message: string }> } })
        .error;
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(err.issues)).toContain('dunningEnabld');

      const appRow = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect((appRow.billingConfig as { dunningEnabled?: boolean }).dunningEnabled ?? false).toBe(
        false,
      );
    });

    it('billing-config still accepts the real keys', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${applicationId}/billing-config`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { dunningEnabled: true },
      });
      expect(res.statusCode).toBe(200);
      const appRow = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      expect((appRow.billingConfig as { dunningEnabled?: boolean }).dunningEnabled).toBe(true);
    });

    // ---------------------------------------------------------- 3 ------

    describe('failed sign-ins reach the audit log', () => {
      const password = 'pw-one-two-three';

      async function signUpEndUser(email: string): Promise<string> {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${liveKey}` },
          payload: { email, password },
        });
        expect(res.statusCode).toBe(201);
        return (await prisma.endUser.findFirstOrThrow({ where: { applicationId, email } })).id;
      }

      async function signInWrong(email: string): Promise<number> {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/sign-in',
          headers: { authorization: `Bearer ${liveKey}` },
          payload: { email, password: 'definitely-not-the-password' },
        });
        return res.statusCode;
      }

      /** The write is fire-and-forget, so poll rather than assume it landed. */
      async function waitForEvents(type: string, count: number): Promise<number> {
        const deadline = Date.now() + 3000;
        for (;;) {
          const n = await prisma.securityEvent.count({ where: { applicationId, type } });
          if (n >= count || Date.now() > deadline) return n;
          await new Promise((r) => setTimeout(r, 25));
        }
      }

      it('records user.sign_in_failed for an existing end-user', async () => {
        const email = `${unique('eu')}@example.com`;
        const endUserId = await signUpEndUser(email);

        expect(await signInWrong(email)).toBe(401);
        expect(await waitForEvents('user.sign_in_failed', 1)).toBe(1);

        const row = await prisma.securityEvent.findFirstOrThrow({
          where: { applicationId, type: 'user.sign_in_failed' },
        });
        expect(row.actorType).toBe('end_user');
        expect(row.actorId).toBe(endUserId);
        expect(row.tenantId).toBe(tenantId);
        expect((row.metadata as { via?: string }).via).toBe('password');
      });

      it('records user.locked_out once, when the threshold trips', async () => {
        const email = `${unique('eu')}@example.com`;
        await signUpEndUser(email);

        // LOGIN_POLICY is 10 failures. The 10th trips the lock; the 11th is
        // refused by `assertNotLocked` before the credential is even checked,
        // so it must NOT add a second lockout row.
        const statuses: number[] = [];
        for (let i = 0; i < 12; i++) statuses.push(await signInWrong(email));
        expect(statuses).toContain(429);

        expect(await waitForEvents('user.locked_out', 1)).toBe(1);
        // Still exactly one after the attempts that were refused outright.
        expect(await prisma.securityEvent.count({ where: { applicationId, type: 'user.locked_out' } })).toBe(1);

        const row = await prisma.securityEvent.findFirstOrThrow({
          where: { applicationId, type: 'user.locked_out' },
        });
        expect((row.metadata as { lockedForSec?: number }).lockedForSec).toBeGreaterThan(0);
      });

      it('writes nothing for an address that was never registered', async () => {
        // The enumeration posture, matching the failure counter's: an
        // attacker must not be able to write arbitrary strings into an
        // operator's audit log, and a row that exists only for real accounts
        // would itself be an oracle.
        expect(await signInWrong(`${unique('ghost')}@example.com`)).toBe(401);
        await new Promise((r) => setTimeout(r, 300));
        expect(
          await prisma.securityEvent.count({
            where: { applicationId, type: { in: ['user.sign_in_failed', 'user.locked_out'] } },
          }),
        ).toBe(0);
      });

      it('the response is byte-identical whether or not an event was written', async () => {
        const known = `${unique('eu')}@example.com`;
        await signUpEndUser(known);
        const unknown = `${unique('ghost')}@example.com`;

        const bodyFor = async (email: string): Promise<string> => {
          const res = await app.inject({
            method: 'POST',
            url: '/api/v1/auth/sign-in',
            headers: { authorization: `Bearer ${liveKey}` },
            payload: { email, password: 'definitely-not-the-password' },
          });
          const parsed = res.json() as { error: Record<string, unknown> };
          // requestId differs per request by design.
          delete parsed.error['requestId'];
          return `${res.statusCode} ${JSON.stringify(parsed)}`;
        };
        expect(await bodyFor(known)).toBe(await bodyFor(unknown));
      });
    });

    // ---------------------------------------------------------- 4 ------

    describe('delivery inspection', () => {
      beforeEach(() => {
        // No delivery attempts — the rows are what this asserts on.
        setDeliveryScheduler(() => undefined);
      });
      afterEach(() => {
        setDeliveryScheduler(null);
      });

      async function seedEndpointWithDeliveries(): Promise<string> {
        const endpoint = await prisma.webhookEndpoint.create({
          data: {
            applicationId,
            url: 'https://127.0.0.1:1/never',
            events: ['*'],
            secret: 'whsec_inspect',
            enabled: true,
          },
        });
        await prisma.webhookDelivery.createMany({
          data: [
            {
              endpointId: endpoint.id,
              applicationId,
              eventId: 'evt_ok',
              eventType: 'user.created',
              payload: { eventId: 'evt_ok', data: { user: { id: 'eu_1' } } },
              status: 'SUCCEEDED',
              attempts: 1,
              responseStatus: 200,
              responseBody: 'ok',
            },
            {
              endpointId: endpoint.id,
              applicationId,
              eventId: 'evt_bad',
              eventType: 'user.deleted',
              payload: { eventId: 'evt_bad', data: { user: { id: 'eu_2' } } },
              status: 'FAILED',
              attempts: 5,
              responseStatus: 500,
              responseBody: 'upstream exploded',
              error: 'HTTP 500',
            },
          ],
        });
        return endpoint.id;
      }

      interface DeliveryRow {
        eventType: string;
        status: string;
        payload: unknown;
        responseBody: string | null;
      }

      it('serves the payload and the response body it always selected', async () => {
        const endpointId = await seedEndpointWithDeliveries();
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/tenant/applications/${applicationId}/webhooks/${endpointId}/deliveries`,
          headers: { authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(200);
        const rows = (res.json() as { data: DeliveryRow[] }).data;
        expect(rows).toHaveLength(2);
        const failed = rows.find((r) => r.status === 'FAILED')!;
        // The two fields the route read out of the database and dropped.
        expect(failed.responseBody).toBe('upstream exploded');
        expect((failed.payload as { eventId: string }).eventId).toBe('evt_bad');
      });

      it('filters by status', async () => {
        const endpointId = await seedEndpointWithDeliveries();
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/tenant/applications/${applicationId}/webhooks/${endpointId}/deliveries?status=FAILED`,
          headers: { authorization: `Bearer ${operatorToken}` },
        });
        const rows = (res.json() as { data: DeliveryRow[] }).data;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe('FAILED');
      });

      it('refuses an unknown status rather than ignoring it', async () => {
        const endpointId = await seedEndpointWithDeliveries();
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/tenant/applications/${applicationId}/webhooks/${endpointId}/deliveries?status=NOPE`,
          headers: { authorization: `Bearer ${operatorToken}` },
        });
        expect(res.statusCode).toBe(400);
      });
    });
  });

  // ---------------------------------------------------------------- 5 ------

  describe('operator passwords are breach-checked', () => {
    /** Minimal HIBP range response containing `password`'s own suffix. */
    function hibpBodyFor(password: string, count: number): string {
      const hash = createHash('sha1').update(password).digest('hex').toUpperCase();
      return `${hash.slice(5)}:${count}\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1`;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('refuses a password HIBP has seen', async () => {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(new Response(hibpBodyFor('password', 24_230_577), { status: 200 })),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `${unique('breached')}@example.com`,
          password: 'password',
          workspaceName: 'W',
        },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('PASSWORD_BREACHED');
      // Nothing was created.
      expect(await prisma.tenantUser.count()).toBe(0);
    });

    it('accepts a password HIBP has not seen', async () => {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(new Response('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1', { status: 200 })),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `${unique('clean')}@example.com`,
          password: 'correct-horse-battery-staple-42',
          workspaceName: 'W',
        },
      });
      expect(res.statusCode).toBe(201);
    });

    it('fails OPEN when HIBP is unreachable — sign-up is not held hostage', async () => {
      vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `${unique('offline')}@example.com`,
          password: 'correct-horse-battery-staple-42',
          workspaceName: 'W',
        },
      });
      expect(res.statusCode).toBe(201);
    });

    it('applies to a password change, not just sign-up', async () => {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(new Response('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1', { status: 200 })),
      );
      const email = `${unique('changer')}@example.com`;
      const current = 'correct-horse-battery-staple-42';
      const token = await app
        .inject({
          method: 'POST',
          url: '/api/v1/tenant/auth/sign-up',
          payload: { email, password: current, workspaceName: 'W' },
        })
        .then((r) => (r.json().data as { accessToken: string }).accessToken);

      vi.stubGlobal('fetch', () =>
        Promise.resolve(new Response(hibpBodyFor('password', 100), { status: 200 })),
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/change-password',
        headers: { authorization: `Bearer ${token}` },
        payload: { currentPassword: current, newPassword: 'password' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe('PASSWORD_BREACHED');
    });
  });
});
