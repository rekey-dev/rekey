/**
 * Test/live data isolation (roadmap §7 v1).
 *
 * The calling secret key's prefix (`rp_test_` / `rp_live_`) decides which
 * "universe" a request lives in:
 *   - sign-ups stamp the new EndUser with the key's mode,
 *   - wrong-mode users are invisible to auth (401 INVALID_CREDENTIALS on
 *     sign-in, 403 DATA_MODE_MISMATCH when a valid JWT crosses modes),
 *   - test-key checkouts demand mode=test billing credentials
 *     (BILLING_MODE_MISMATCH otherwise) and stamp the Subscription TEST,
 *   - operator/tenant lists expose `mode` + a `?mode=` filter,
 *   - billing stats count LIVE rows only,
 *   - TEST dunning cases log reminders instead of emailing.
 *
 * Legacy guarantee: everything live-keyed behaves exactly as before — the
 * migration defaults every pre-existing row to LIVE.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { dunningService } from '../src/modules/billing/dunning.service.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const DAY_MS = 24 * 60 * 60 * 1000;

interface AuthData {
  accessToken: string;
  endUser: { id: string; email: string; mode?: string };
}

describe('test/live data isolation (roadmap §7)', () => {
  let app: FastifyInstance;
  let tenantAccess: string;
  let applicationId: string;
  let liveKey: string;
  let testKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // The shared setup truncates all domain tables before each test, so the
  // workspace + application + keys are bootstrapped per test.
  beforeEach(async () => {
    tenantAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: 'op-test-mode@example.com',
          password: 'pw-one-two-three',
          workspaceName: 'WS test-mode',
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: 'TestMode', slug: 'test-mode-app', enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);

    const mint = async (mode: 'live' | 'test'): Promise<string> =>
      app
        .inject({
          method: 'POST',
          url: `/api/v1/admin/applications/${applicationId}/api-keys`,
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
          payload: { name: `k-${mode}`, mode },
        })
        .then((r) => (r.json().data as { rawKey: string }).rawKey);
    liveKey = await mint('live');
    testKey = await mint('test');
    expect(liveKey).toMatch(/^rp_live_/);
    expect(testKey).toMatch(/^rp_test_/);
  });

  // ---------- helpers ----------

  async function signUp(key: string, email: string): Promise<AuthData> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${key}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data as AuthData;
  }

  async function createPlan(slug: string, amount = 999): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: { slug, name: slug, amount },
    });
    expect(res.statusCode).toBe(201);
  }

  function checkout(key: string, userToken: string, planSlug: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${key}`, 'x-relipay-user-token': userToken },
      payload: {
        planSlug,
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
      },
    });
  }

  // ---------- sign-up stamping ----------

  it('sign-up via a test key stamps the EndUser TEST; via a live key stays LIVE', async () => {
    const test = await signUp(testKey, 'tm-test@example.com');
    expect(test.endUser.mode).toBe('TEST');
    const live = await signUp(liveKey, 'tm-live@example.com');
    expect(live.endUser.mode).toBe('LIVE');

    const rows = await prisma.endUser.findMany({
      where: { applicationId },
      select: { email: true, mode: true },
    });
    expect(new Map(rows.map((r) => [r.email, r.mode]))).toEqual(
      new Map([
        ['tm-test@example.com', 'TEST'],
        ['tm-live@example.com', 'LIVE'],
      ]),
    );
  });

  // ---------- cross-mode auth invisibility ----------

  it('a live key cannot sign in a test user (and vice versa) — INVALID_CREDENTIALS, no enumeration', async () => {
    await signUp(testKey, 'cross@example.com');

    const crossed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: 'cross@example.com', password: 'pw-one-two-three' },
    });
    expect(crossed.statusCode).toBe(401);
    expect(crossed.json().error.code).toBe('INVALID_CREDENTIALS');

    // Same mode still signs in fine.
    const same = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${testKey}` },
      payload: { email: 'cross@example.com', password: 'pw-one-two-three' },
    });
    expect(same.statusCode).toBe(200);

    // And the mirror image: a live user is invisible to the test key.
    await signUp(liveKey, 'cross-live@example.com');
    const crossed2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${testKey}` },
      payload: { email: 'cross-live@example.com', password: 'pw-one-two-three' },
    });
    expect(crossed2.statusCode).toBe(401);
    expect(crossed2.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('a valid user JWT presented through a key of the other mode is refused — 403 DATA_MODE_MISMATCH', async () => {
    const test = await signUp(testKey, 'jwt-test@example.com');
    const live = await signUp(liveKey, 'jwt-live@example.com');

    const me = (key: string, token: string) =>
      app.inject({
        method: 'GET',
        url: '/api/v1/users/me/',
        headers: { authorization: `Bearer ${key}`, 'x-relipay-user-token': token },
      });

    const crossedTest = await me(liveKey, test.accessToken);
    expect(crossedTest.statusCode).toBe(403);
    expect(crossedTest.json().error.code).toBe('DATA_MODE_MISMATCH');

    const crossedLive = await me(testKey, live.accessToken);
    expect(crossedLive.statusCode).toBe(403);
    expect(crossedLive.json().error.code).toBe('DATA_MODE_MISMATCH');

    // Matching modes keep working — the live path is byte-for-byte legacy.
    expect((await me(testKey, test.accessToken)).statusCode).toBe(200);
    expect((await me(liveKey, live.accessToken)).statusCode).toBe(200);
  });

  // ---------- checkout: BILLING_MODE_MISMATCH + mode stamping ----------

  it('checkout via a test key with only LIVE billing credentials → 400 BILLING_MODE_MISMATCH', async () => {
    await createPlan('pro_monthly');
    await billingCredentialsService.upsertStripe(
      applicationId,
      { apiKey: 'sk_live_for_ci_only', webhookSecret: 'whsec_x' },
      { enabled: true, mode: 'live' },
    );
    const test = await signUp(testKey, 'mm@example.com');

    const res = await checkout(testKey, test.accessToken, 'pro_monthly');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BILLING_MODE_MISMATCH');

    // No subscription row should have been created.
    expect(await prisma.subscription.count({ where: { applicationId } })).toBe(0);
  });

  it('checkout via a test key with mode=test credentials succeeds and stamps the Subscription TEST', async () => {
    await createPlan('pro_monthly');
    await billingCredentialsService.upsertStripe(
      applicationId,
      { apiKey: 'sk_test_for_ci_only', webhookSecret: 'whsec_x' },
      { enabled: true, mode: 'test' },
    );
    const test = await signUp(testKey, 'ok-test@example.com');

    const res = await checkout(testKey, test.accessToken, 'pro_monthly');
    expect(res.statusCode).toBe(200);

    const sub = await prisma.subscription.findFirst({
      where: { applicationId, endUserId: test.endUser.id },
    });
    expect(sub?.mode).toBe('TEST');
    expect(sub?.status).toBe('PENDING');
  });

  it('legacy live checkout is unchanged — Subscription stamped LIVE', async () => {
    await createPlan('pro_monthly');
    const live = await signUp(liveKey, 'ok-live@example.com');

    // No credentials at all (legacy stub fallback) — historical behavior.
    const res = await checkout(liveKey, live.accessToken, 'pro_monthly');
    expect(res.statusCode).toBe(200);

    const sub = await prisma.subscription.findFirst({
      where: { applicationId, endUserId: live.endUser.id },
    });
    expect(sub?.mode).toBe('LIVE');
  });

  it('GET /billing/providers via a test key lists only mode=test providers', async () => {
    await billingCredentialsService.upsertStripe(
      applicationId,
      { apiKey: 'sk_live_for_ci_only', webhookSecret: 'whsec_x' },
      { enabled: true, mode: 'live' },
    );
    await billingCredentialsService.upsertPaypal(
      applicationId,
      { clientId: 'cid', clientSecret: 'csec', webhookId: 'wh-1' },
      { enabled: true, mode: 'test' },
    );

    const list = async (key: string): Promise<string[]> => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/billing/providers',
        headers: { authorization: `Bearer ${key}` },
      });
      expect(res.statusCode).toBe(200);
      return (res.json().data.providers as Array<{ provider: string }>).map((p) => p.provider);
    };

    expect(await list(testKey)).toEqual(['paypal']);
    expect((await list(liveKey)).sort()).toEqual(['paypal', 'stripe']);
  });

  // ---------- operator/tenant lists: mode field + ?mode= filter ----------

  it('tenant end-users list exposes `mode` and filters with ?mode=', async () => {
    await signUp(testKey, 'list-test@example.com');
    await signUp(liveKey, 'list-live@example.com');

    const list = async (qs = ''): Promise<Array<{ email: string; mode: string }>> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${applicationId}/end-users${qs}`,
        headers: { authorization: `Bearer ${tenantAccess}` },
      });
      expect(res.statusCode).toBe(200);
      return res.json().data as Array<{ email: string; mode: string }>;
    };

    // Operator surface sees BOTH modes, each row carrying its mode.
    const all = await list();
    expect(new Map(all.map((u) => [u.email, u.mode]))).toEqual(
      new Map([
        ['list-test@example.com', 'TEST'],
        ['list-live@example.com', 'LIVE'],
      ]),
    );

    expect((await list('?mode=TEST')).map((u) => u.email)).toEqual(['list-test@example.com']);
    expect((await list('?mode=LIVE')).map((u) => u.email)).toEqual(['list-live@example.com']);
  });

  it('tenant payments list exposes `mode` and filters with ?mode=', async () => {
    await prisma.payment.create({
      data: { applicationId, amount: 1000, currency: 'USD', status: 'SUCCEEDED', mode: 'LIVE', providerPaymentId: 'pp-live-1' },
    });
    await prisma.payment.create({
      data: { applicationId, amount: 2000, currency: 'USD', status: 'SUCCEEDED', mode: 'TEST', providerPaymentId: 'pp-test-1' },
    });

    const list = async (qs = ''): Promise<Array<{ providerPaymentId: string; mode: string }>> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${applicationId}/payments${qs}`,
        headers: { authorization: `Bearer ${tenantAccess}` },
      });
      expect(res.statusCode).toBe(200);
      return res.json().data as Array<{ providerPaymentId: string; mode: string }>;
    };

    const all = await list();
    expect(new Map(all.map((p) => [p.providerPaymentId, p.mode]))).toEqual(
      new Map([
        ['pp-live-1', 'LIVE'],
        ['pp-test-1', 'TEST'],
      ]),
    );

    expect((await list('?mode=TEST')).map((p) => p.providerPaymentId)).toEqual(['pp-test-1']);
    expect((await list('?mode=LIVE')).map((p) => p.providerPaymentId)).toEqual(['pp-live-1']);
  });

  // ---------- billing stats: LIVE only ----------

  it('billing stats exclude TEST subscriptions and payments entirely', async () => {
    const plan = await prisma.plan.create({
      data: { applicationId, slug: 'pro_m', name: 'Pro M', amount: 1000, interval: 'MONTH', kind: 'SUBSCRIPTION' },
    });
    const eu = async (n: number, mode: 'TEST' | 'LIVE'): Promise<string> =>
      (await prisma.endUser.create({ data: { applicationId, email: `st-${n}@example.com`, mode } })).id;

    // 1 LIVE active sub vs 1 TEST active sub.
    await prisma.subscription.create({
      data: { applicationId, endUserId: await eu(1, 'LIVE'), planId: plan.id, status: 'ACTIVE', mode: 'LIVE' },
    });
    await prisma.subscription.create({
      data: { applicationId, endUserId: await eu(2, 'TEST'), planId: plan.id, status: 'ACTIVE', mode: 'TEST' },
    });
    // LIVE: 1000 succeeded. TEST: 5000 succeeded + 1 failed — none may count.
    const recent = new Date(Date.now() - 2 * DAY_MS);
    await prisma.payment.create({
      data: { applicationId, amount: 1000, currency: 'USD', status: 'SUCCEEDED', mode: 'LIVE', createdAt: recent },
    });
    await prisma.payment.create({
      data: { applicationId, amount: 5000, currency: 'USD', status: 'SUCCEEDED', mode: 'TEST', createdAt: recent },
    });
    await prisma.payment.create({
      data: { applicationId, amount: 700, currency: 'USD', status: 'FAILED', mode: 'TEST', createdAt: recent },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/billing/stats`,
      headers: { authorization: `Bearer ${tenantAccess}` },
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json().data as {
      activeSubscriptions: number;
      newSubscriptionsLast30d: number;
      mrrCents: number;
      revenueLast30dCents: number;
      paymentsLast30d: { succeeded: number; failed: number };
      monthlyRevenue: Array<{ month: string; amountCents: number }>;
    };

    expect(stats.activeSubscriptions).toBe(1); // TEST sub excluded
    expect(stats.newSubscriptionsLast30d).toBe(1);
    expect(stats.mrrCents).toBe(1000); // one LIVE monthly sub
    expect(stats.revenueLast30dCents).toBe(1000); // TEST 5000 excluded
    expect(stats.paymentsLast30d).toEqual({ succeeded: 1, failed: 0 });
    // The monthly series only carries the LIVE 1000.
    const total = stats.monthlyRevenue.reduce((s, m) => s + m.amountCents, 0);
    expect(total).toBe(1000);
  });

  // ---------- dunning: TEST cases log instead of emailing ----------

  it('a TEST dunning case records skipped_test_mode and sends no email; LIVE still dispatches', async () => {
    const plan = await prisma.plan.create({
      data: { applicationId, slug: 'pro_m', name: 'Pro M', amount: 1000, interval: 'MONTH', kind: 'SUBSCRIPTION' },
    });
    const mkSub = async (mode: 'TEST' | 'LIVE'): Promise<string> => {
      const user = await prisma.endUser.create({
        data: { applicationId, email: `dun-${mode.toLowerCase()}@example.com`, mode },
      });
      const sub = await prisma.subscription.create({
        data: { applicationId, endUserId: user.id, planId: plan.id, status: 'PAST_DUE', mode },
      });
      return sub.id;
    };

    // Dunning is opt-in since #146 (dunningEnabled default false) — turn it on so
    // a payment failure actually opens a case for this assertion.
    await applicationsService.updateBillingConfig({
      applicationId,
      patch: { dunningEnabled: true },
    });

    const testSubId = await mkSub('TEST');
    const liveSubId = await mkSub('LIVE');
    await dunningService.recordPaymentFailure({ subscriptionId: testSubId });
    await dunningService.recordPaymentFailure({ subscriptionId: liveSubId });

    // The day-0 reminder is fire-and-forget — poll for the recorded outcomes.
    const outcomeFor = async (subscriptionId: string): Promise<string | undefined> => {
      const deadline = Date.now() + 4000;
      for (;;) {
        const dunningCase = await prisma.dunningCase.findFirst({ where: { subscriptionId } });
        const meta = (dunningCase?.metadata ?? {}) as {
          reminders?: Array<{ outcome: string }>;
        };
        const outcome = meta.reminders?.[0]?.outcome;
        if (outcome !== undefined || Date.now() > deadline) return outcome;
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    // TEST: same state machine, no email — outcome logged instead.
    expect(await outcomeFor(testSubId)).toBe('skipped_test_mode');
    // LIVE: went through the email system (no transport configured in tests).
    expect(await outcomeFor(liveSubId)).toBe('no_transport');

    // No email-log row exists for the TEST user.
    const logs = await prisma.emailLog.findMany({
      where: { applicationId, eventKey: 'billing_payment_failed_reminder' },
      select: { toAddress: true },
    });
    expect(logs.map((l) => l.toAddress)).toEqual(['dun-live@example.com']);
  });
});
