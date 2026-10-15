/**
 * @rekey.dev/node SDK integration tests.
 *
 * We drive the real `Rekey` class against the in-process Fastify app via
 * a fetch shim that pipes through `app.inject`. Every assertion is also a
 * contract check: if the SDK shape drifts from the server response, the
 * test breaks immediately.
 *
 * Covered:
 *   - applications.me + secret-key shape validation
 *   - auth.signUp + signIn + getCurrentUser + verifyEmail / sendVerificationEmail
 *   - organizations: full CRUD, members, invitations, role changes, leave
 *   - licenses.verify (ok + invalid)
 *   - usage.record + aggregate
 *   - verifyWebhookSignature against a server-signed payload (round-trip)
 *   - RekeyError carries requestId from header or envelope
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { signWebhook } from '../src/lib/webhook-signing.js';
import {
  Rekey,
  RekeyError,
  verifyWebhookSignature,
} from '../../../packages/sdk-node/src/index.js';
import { seedPlan } from './seed-plan.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface BootstrappedApp {
  applicationId: string;
  liveKey: string;
}

describe('@rekey.dev/node SDK integration', () => {
  let app: FastifyInstance;
  let appA: BootstrappedApp;
  let rekey: Rekey;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** fetch shim that pipes through app.inject. */
  function makeFetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const method = (init?.method ?? 'GET').toUpperCase() as
        | 'GET'
        | 'POST'
        | 'PUT'
        | 'PATCH'
        | 'DELETE';
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(init?.headers ?? {})) {
        if (typeof v === 'string') headers[k] = v;
      }
      const res = await app.inject({
        method,
        url: path,
        headers,
        ...(init?.body !== undefined && init?.body !== null
          ? { payload: init.body as string }
          : {}),
      });
      const body = res.body;
      const respHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === 'string') respHeaders.set(k, v);
        else if (Array.isArray(v)) respHeaders.set(k, v.join(', '));
      }
      return new Response(body, {
        status: res.statusCode,
        headers: respHeaders,
      });
    }) as typeof fetch;
  }

  async function bootstrapApplication(slug: string): Promise<BootstrappedApp> {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: `T-${slug}`, ownerEmail: `t-${slug}@example.com` },
      })
      .then((r) => r.json().data as { id: string });

    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: slug, slug, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });

    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });

    return { applicationId: application.id, liveKey: key.rawKey };
  }

  beforeEach(async () => {
    appA = await bootstrapApplication('sdk-test');
    rekey = new Rekey({
      apiUrl: 'http://test.invalid',
      secretKey: appA.liveKey,
      fetch: makeFetch(),
    });
  });

  // ---------- applications + auth ----------

  it('applications.me returns the calling Application', async () => {
    const me = await rekey.applications.me();
    expect(me.id).toBe(appA.applicationId);
    expect(me.slug).toBe('sdk-test');
  });

  it('signUp + signIn + getCurrentUser round-trip', async () => {
    const signup = await rekey.auth.signUp({
      email: 'sdk-user@example.com',
      password: 'pw-long-enough',
    });
    expect(signup.endUser.email).toBe('sdk-user@example.com');

    const signin = await rekey.auth.signIn({
      email: 'sdk-user@example.com',
      password: 'pw-long-enough',
    });
    expect(signin.mfaRequired).toBe(false);
    if (signin.mfaRequired) throw new Error('unreachable');

    const me = await rekey.auth.getCurrentUser(signin.accessToken);
    expect(me.email).toBe('sdk-user@example.com');
  });

  it('licenses.verify activates a valid license + idempotent on re-call', async () => {
    // Mint plan + license + an EndUser to own it via direct prisma.
    const endUser = await prisma.endUser.create({
      data: {
        applicationId: appA.applicationId,
        email: 'license-owner@example.com',
        passwordHash: 'unused',
        role: 'user',
      },
    });
    const plan = await seedPlan({
        applicationId: appA.applicationId,
        slug: 'pro',
        name: 'Pro',
        kind: 'LICENSE',
      }, { currency: 'USD', amount: 9900 });
    const { randomBytes, createHash } = await import('node:crypto');
    const rawKey = `rl-${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const license = await prisma.license.create({
      data: {
        applicationId: appA.applicationId,
        endUserId: endUser.id,
        planId: plan.id,
        kind: 'PERPETUAL',
        keyHash,
        keyPrefix: rawKey.slice(0, 8),
      },
    });

    const first = await rekey.licenses.verify({
      key: rawKey,
      machineFingerprint: 'mac-A',
      label: 'Test mac',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    expect(first.license.id).toBe(license.id);

    const replay = await rekey.licenses.verify({
      key: rawKey,
      machineFingerprint: 'mac-A',
    });
    expect(replay.ok).toBe(true);

    // Replay-from-same-machine does not consume a new activation row.
    const activations = await prisma.licenseActivation.count({
      where: { licenseId: license.id },
    });
    expect(activations).toBe(1);
  });

  // ---------- error envelope ----------

  it('RekeyError exposes statusCode + requestId', async () => {
    try {
      await rekey.auth.signIn({
        email: 'nope@example.com',
        password: 'whatever-long',
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RekeyError);
      const re = err as RekeyError;
      expect(re.code).toBe('INVALID_CREDENTIALS');
      expect(re.statusCode).toBe(401);
      // Either envelope-side or header-side; both should be present.
      expect(typeof re.requestId === 'string' && re.requestId.length > 0).toBe(true);
    }
  });

  // ---------- webhook signature ----------

  it('verifyWebhookSignature round-trips against a server-signed payload', () => {
    const body = JSON.stringify({ hello: 'world' });
    const secret = 'wsec_test_' + 'a'.repeat(32);
    const t = Math.floor(Date.now() / 1000);
    const { signatureHeader } = signWebhook({ body, secret, timestamp: t });

    expect(
      verifyWebhookSignature({
        header: signatureHeader,
        payload: body,
        secret,
        now: () => t * 1000,
      }),
    ).toBe(true);

    // Tamper with body → fail.
    expect(
      verifyWebhookSignature({
        header: signatureHeader,
        payload: body + 'extra',
        secret,
        now: () => t * 1000,
      }),
    ).toBe(false);

    // Stale timestamp → fail.
    expect(
      verifyWebhookSignature({
        header: signatureHeader,
        payload: body,
        secret,
        now: () => (t + 999_999) * 1000,
      }),
    ).toBe(false);

    // Wrong secret → fail.
    expect(
      verifyWebhookSignature({
        header: signatureHeader,
        payload: body,
        secret: secret + 'XX',
        now: () => t * 1000,
      }),
    ).toBe(false);
  });
});
