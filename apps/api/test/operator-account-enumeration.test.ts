/**
 * Operator sign-in does not reveal whether an account exists: an unknown
 * address is rate-limited like a known one, and a missing password hash still
 * costs a full argon2 verification.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { verifyPassword, verifyPasswordOrDecoy } from '../src/lib/passwords.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const PASSWORD = 'pw-one-two-three';

describe('operator sign-in account enumeration', () => {
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

  describe('the operator surface is not an account-existence oracle', () => {
    for (const [label, url, tokenField] of [
      ['forgot-password', '/api/v1/tenant/auth/forgot-password', 'resetToken'],
      ['magic-link', '/api/v1/tenant/auth/magic-link/request', 'token'],
    ] as const) {
      it(`${label}: a known and an unknown address are indistinguishable`, async () => {
        const ip = freshIp();
        const email = `oracle-${label}-${Math.random().toString(36).slice(2, 8)}@example.com`;
        await signUp(email, ip);

        const post = (address: string) =>
          app.inject({ remoteAddress: ip, method: 'POST', url, payload: { email: address } });

        const known = await post(email);
        const unknown = await post(`nobody-${Math.random().toString(36).slice(2, 8)}@example.com`);

        expect(known.statusCode).toBe(unknown.statusCode);
        // THE assertion: `delivered` was false for an unknown address and true
        // for a known one, one request per address, and you had the operator
        // roster for the deployment.
        const k = known.json().data as Record<string, unknown>;
        const u = unknown.json().data as Record<string, unknown>;
        expect(k.delivered).toBe(u.delivered);
        expect(k.delivered).toBe(true);
        // The token echo is the one field that still varies, and only under the
        // dev flag `config/env.ts` refuses to boot with in production. The test
        // runner counts as dev, so assert the shape rather than equality.
        expect(Object.keys(k).sort()).toEqual(Object.keys(u).sort());
        expect(u[tokenField]).toBeNull();
      });
    }

    it('sign-in rate-limits an unknown address exactly like a known one', async () => {
      const ip = freshIp();
      const unknown = `ghost-${Math.random().toString(36).slice(2, 8)}@example.com`;
      for (let i = 0; i < 10; i++) {
        const r = await app.inject({
          remoteAddress: ip,
          method: 'POST',
          url: '/api/v1/tenant/auth/sign-in',
          payload: { email: unknown, password: 'nope-nope-nope' },
        });
        expect(r.statusCode).toBe(401);
      }
      const after = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-in',
        payload: { email: unknown, password: 'nope-nope-nope' },
      });
      // Was 401 forever for an address with no account, while a real one
      // switched to 429 on the 11th try. No timing measurement needed, the
      // status code answered "does this operator exist?" outright.
      expect(after.statusCode).toBe(429);
    });

    it('a missing password hash still costs a full argon2 verification', async () => {
      // The response-body oracle above is the loud one; this is the quiet one.
      // `verifyPassword(null, …)` returns in microseconds, which measured 3.3 ms
      // vs 9.0 ms end-to-end with no overlap between the distributions.
      //
      // Compared against `verifyPassword` on the same input rather than against
      // a wall-clock threshold: the gap being asserted is "no hashing at all"
      // versus "one hash", which is two orders of magnitude and survives a
      // loaded machine. Both run several times so a single scheduler hiccup
      // cannot decide the result.
      const t = async (fn: () => Promise<unknown>): Promise<number> => {
        const start = process.hrtime.bigint();
        for (let i = 0; i < 5; i++) await fn();
        return Number(process.hrtime.bigint() - start) / 1e6;
      };
      // Warm the lazily-built decoy so its one-off hash is not in the sample.
      await verifyPasswordOrDecoy(null, 'warm');

      const shortCircuit = await t(() => verifyPassword(null, 'guess-the-password'));
      const constant = await t(() => verifyPasswordOrDecoy(null, 'guess-the-password'));

      expect(await verifyPasswordOrDecoy(null, 'guess-the-password')).toBe(false);
      expect(constant).toBeGreaterThan(shortCircuit * 10);
    });
  });
});
