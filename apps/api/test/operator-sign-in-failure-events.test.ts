/**
 * Failed operator sign-ins and lockouts are written to the security log, show
 * in the workspace's own log, and operators appear in the super-admin
 * locked-accounts report.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SecurityEvent } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const PASSWORD = 'pw-one-two-three';
const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('operator sign-in failures in the security log', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  // The global limiter is per-IP (100/min) and the instance lives for the whole
  // file; a few of these tests fire ten sign-ins in a row, so give each its own
  // source address.
  let ipCounter = 0;
  function freshIp(): string {
    return `10.44.${++ipCounter}.1`;
  }

  async function signUp(
    email: string,
    ip: string,
  ): Promise<{ accessToken: string; userId: string; tenantId: string }> {
    const r = await app.inject({
      remoteAddress: ip,
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: PASSWORD, workspaceName: 'WS' },
    });
    expect(r.statusCode).toBe(201);
    const d = r.json().data as {
      accessToken: string;
      user: { id: string };
      activeTenantId: string;
    };
    return { accessToken: d.accessToken, userId: d.user.id, tenantId: d.activeTenantId };
  }

  /**
   * `recordSecurityEvent` is fire-and-forget by contract, the sign-in response
   * must not wait on an audit write, so poll rather than assume it has landed.
   *
   * Delegates to the shared helper: this file's own loop gave up after 1s and
   * then returned whatever it had, so a slow runner failed on a bare length
   * mismatch instead of saying the write had not landed in time.
   */
  function waitForEvents(actorId: string, type: string, atLeast = 1): Promise<SecurityEvent[]> {
    return waitForSecurityEvents({ actorId, type }, { atLeast });
  }

  describe('failed operator sign-ins and lockouts are recorded', () => {
    it('writes operator.sign_in_failed per attempt and operator.locked_out once, in the operator\'s workspace', async () => {
      const ip = freshIp();
      const email = `lockout-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const op = await signUp(email, ip);

      // LOGIN_POLICY.threshold is 10, the tenth attempt trips the lock.
      for (let i = 0; i < 10; i++) {
        const r = await app.inject({
          remoteAddress: ip,
          method: 'POST',
          url: '/api/v1/tenant/auth/sign-in',
          payload: { email, password: 'definitely-not-the-password' },
        });
        expect(r.statusCode).toBe(401);
      }

      const failures = await waitForEvents(op.userId, 'operator.sign_in_failed', 10);
      // THE assertion: ten failed sign-ins produced zero rows before this fix.
      expect(failures.length).toBe(10);
      // …and `tenantId: null` would have been invisible to every reader, since
      // all of them are workspace-scoped. It must name the operator's workspace.
      expect(new Set(failures.map((f) => f.tenantId))).toEqual(new Set([op.tenantId]));

      const lockouts = await waitForEvents(op.userId, 'operator.locked_out', 1);
      // Once per lockout, on the attempt that tripped it, not per refused attempt.
      expect(lockouts.length).toBe(1);
      expect(lockouts[0]!.tenantId).toBe(op.tenantId);
      expect((lockouts[0]!.metadata as { lockedForSec: number }).lockedForSec).toBeGreaterThan(0);

      // The lock itself is real: the 11th attempt is refused before argon2.
      const locked = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-in',
        payload: { email, password: PASSWORD },
      });
      expect(locked.statusCode).toBe(429);
    });

    it('GET /admin/metrics/locked-accounts reports operators, not only end-users', async () => {
      const res = await app.inject({
        remoteAddress: freshIp(),
        method: 'GET',
        url: '/api/v1/admin/metrics/locked-accounts',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      const data = res.json().data as Record<string, unknown>;
      // The end-user half is unchanged…
      expect(data).toHaveProperty('accounts');
      // …and the operator half now exists. A locked-out workspace OWNER cannot
      // reach their own security log, so this is the only surface that shows
      // them; it reported end-users exclusively.
      expect(data).toHaveProperty('operators');
      expect(data).toHaveProperty('operatorsTotal');
      expect(Array.isArray(data.operators)).toBe(true);
      // NOTE: the rows themselves come from a Redis SCAN, and `getRedis()`
      // returns null under NODE_ENV=test by design, so the list is empty here.
      // What this pins is the contract; the scan itself is exercised in
      // lib/brute-force.ts alongside its end-user twin.
    });
  });

});
