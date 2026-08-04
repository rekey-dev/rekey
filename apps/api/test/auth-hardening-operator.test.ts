/**
 * Regressions for the operator (panel) half of the 2026-08-02 auth review.
 *
 * Each `describe` here pins ONE finding that was reproduced against a running
 * server, and asserts the specific behaviour that was observed is now refused.
 *
 *   1. Operator failed sign-ins and lockouts were recorded nowhere.
 *   2. Operator MFA was removable with nothing but a stolen session — via
 *      /mfa/disable, which asked for no factor, and via /mfa/setup, which
 *      un-enrolled the existing authenticator on the way past.
 *   3. Operator passkey enrolment had no step-up, and the ceremonies asked for
 *      user verification as "preferred" while minting a full session.
 *   6. forgot-password and magic-link reported whether the address had an
 *      operator account; sign-in did the same via argon2 timing and by
 *      rate-limiting only accounts that exist.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { verifyPassword, verifyPasswordOrDecoy } from '../src/lib/passwords.js';

const PASSWORD = 'pw-one-two-three';
const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('operator auth hardening', () => {
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

  /** Enroll TOTP for an operator and return a generator for live codes. */
  async function enrollMfa(accessToken: string): Promise<() => string> {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/mfa/setup',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(setup.statusCode).toBe(201);
    const { otpauthUrl } = setup.json().data as { otpauthUrl: string };
    const totp = OTPAuth.URI.parse(otpauthUrl);
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/mfa/setup-confirm',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { code: totp.generate() },
    });
    expect(confirm.statusCode).toBe(200);
    return () => totp.generate();
  }

  /**
   * `recordSecurityEvent` is fire-and-forget by contract — the sign-in response
   * must not wait on an audit write — so poll rather than assume it has landed.
   */
  async function waitForEvents(actorId: string, type: string, atLeast = 1): Promise<
    Array<{ type: string; tenantId: string | null; metadata: unknown }>
  > {
    for (let i = 0; i < 50; i++) {
      const rows = await prisma.securityEvent.findMany({ where: { actorId, type } });
      if (rows.length >= atLeast) return rows;
      await new Promise((r) => setTimeout(r, 20));
    }
    return prisma.securityEvent.findMany({ where: { actorId, type } });
  }

  // ── Finding 1 ────────────────────────────────────────────────────────────
  describe('failed operator sign-ins and lockouts are recorded', () => {
    it('writes operator.sign_in_failed per attempt and operator.locked_out once, in the operator\'s workspace', async () => {
      const ip = freshIp();
      const email = `lockout-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const op = await signUp(email, ip);

      // LOGIN_POLICY.threshold is 10 — the tenth attempt trips the lock.
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
      // Once per lockout, on the attempt that tripped it — not per refused attempt.
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

    it('the workspace security log actually returns them — the surface an operator looks at', async () => {
      const ip = freshIp();
      const email = `logvis-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const op = await signUp(email, ip);
      await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-in',
        payload: { email, password: 'wrong-password-here' },
      });
      await waitForEvents(op.userId, 'operator.sign_in_failed', 1);

      const log = await app.inject({
        remoteAddress: ip,
        method: 'GET',
        url: '/api/v1/tenant/security-events?type=operator.sign_in_failed',
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
      expect(log.statusCode).toBe(200);
      const { items: events } = log.json().data as {
        items: Array<{ type: string; actorId: string }>;
      };
      expect(events.some((r) => r.actorId === op.userId)).toBe(true);
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

  // ── Finding 2 ────────────────────────────────────────────────────────────
  describe('operator MFA cannot be removed with a stolen session alone', () => {
    it('/mfa/disable refuses with no factor, and refuses the account password', async () => {
      const ip = freshIp();
      const op = await signUp(`opmfa-d-${Math.random().toString(36).slice(2, 8)}@example.com`, ip);
      const code = await enrollMfa(op.accessToken);

      const bare = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/disable',
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
      // Was 200 { disabled: true } — a session was the whole requirement.
      expect(bare.statusCode).toBe(401);
      expect(bare.json().error.code).toBe('STEP_UP_REQUIRED');

      const withPassword = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/disable',
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: { password: PASSWORD },
      });
      // Deliberately not enough: someone holding a stolen session AND the
      // password is exactly who the second factor exists to stop.
      expect(withPassword.statusCode).toBe(401);

      const stillOn = await app.inject({
        remoteAddress: ip,
        method: 'GET',
        url: '/api/v1/tenant/auth/mfa/status',
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
      expect((stillOn.json().data as { enabled: boolean }).enabled).toBe(true);

      const withCode = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/disable',
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: { code: code() },
      });
      expect(withCode.statusCode).toBe(200);
    });

    it('/mfa/setup cannot re-enroll over an enrolled authenticator without a current code', async () => {
      const ip = freshIp();
      const op = await signUp(`opmfa-s-${Math.random().toString(36).slice(2, 8)}@example.com`, ip);
      const code = await enrollMfa(op.accessToken);

      const rebind = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/setup',
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
      // Was 201 with a fresh secret AND `enrolledAt: null` — the disable guard
      // routed around, one endpoint to the left.
      expect(rebind.statusCode).toBe(401);
      expect(rebind.json().error.code).toBe('STEP_UP_REQUIRED');

      // The existing enrollment survived the attempt.
      const status = await app.inject({
        remoteAddress: ip,
        method: 'GET',
        url: '/api/v1/tenant/auth/mfa/status',
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
      expect((status.json().data as { enabled: boolean }).enabled).toBe(true);

      // With a current code it is an ordinary re-enrolment.
      const allowed = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/setup',
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: { code: code() },
      });
      expect(allowed.statusCode).toBe(201);
    });

    it('first-time setup still requires nothing', async () => {
      const ip = freshIp();
      const op = await signUp(`opmfa-f-${Math.random().toString(36).slice(2, 8)}@example.com`, ip);
      const first = await app.inject({
        remoteAddress: ip,
        method: 'POST',
        url: '/api/v1/tenant/auth/mfa/setup',
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
      expect(first.statusCode).toBe(201);
    });
  });

  // ── Finding 3 ────────────────────────────────────────────────────────────
  describe('operator passkeys', () => {
    it('enrolment requires a step-up', async () => {
      const ip = freshIp();
      process.env.PANEL_WEBAUTHN_RP_ID = 'panel.test.invalid';
      process.env.PANEL_WEBAUTHN_RP_ORIGINS = 'https://panel.test.invalid';
      try {
        const op = await signUp(`oppk-${Math.random().toString(36).slice(2, 8)}@example.com`, ip);

        const bare = await app.inject({
          remoteAddress: ip,
          method: 'POST',
          url: '/api/v1/tenant/auth/passkeys/register/start',
          headers: { authorization: `Bearer ${op.accessToken}` },
        });
        // Was 201 with ceremony options — a panel access token was sufficient
        // to enroll a credential that signs its holder in forever after.
        expect(bare.statusCode).toBe(401);
        expect(bare.json().error.code).toBe('STEP_UP_REQUIRED');

        const proven = await app.inject({
          remoteAddress: ip,
          method: 'POST',
          url: '/api/v1/tenant/auth/passkeys/register/start',
          headers: { authorization: `Bearer ${op.accessToken}` },
          payload: { password: PASSWORD },
        });
        expect(proven.statusCode).toBe(200);
      } finally {
        delete process.env.PANEL_WEBAUTHN_RP_ID;
        delete process.env.PANEL_WEBAUTHN_RP_ORIGINS;
      }
    });

    it('the sign-in ceremony demands user verification, so a passkey is not a downgrade', async () => {
      process.env.PANEL_WEBAUTHN_RP_ID = 'panel.test.invalid';
      process.env.PANEL_WEBAUTHN_RP_ORIGINS = 'https://panel.test.invalid';
      try {
        const res = await app.inject({
          remoteAddress: freshIp(),
          method: 'POST',
          url: '/api/v1/tenant/auth/passkeys/authenticate/start',
        });
        expect(res.statusCode).toBe(200);
        const { options } = res.json().data as { options: { userVerification: string } };
        // Was 'preferred'. Completing this ceremony mints an operator session
        // outright, so a UV=0 assertion replaced password AND TOTP with a touch.
        expect(options.userVerification).toBe('required');
      } finally {
        delete process.env.PANEL_WEBAUTHN_RP_ID;
        delete process.env.PANEL_WEBAUTHN_RP_ORIGINS;
      }
    });
  });

  // ── Finding 6 ────────────────────────────────────────────────────────────
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
        // for a known one — one request per address, and you had the operator
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
      // switched to 429 on the 11th try. No timing measurement needed — the
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
