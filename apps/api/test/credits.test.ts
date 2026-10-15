/**
 * Credits, prepaid balance, operator grant, public consume (idempotent +
 * overspend-safe), CREDIT-kind plan validation, and purchase-grant idempotency.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { creditsService } from '../src/modules/credits/credits.service.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('credits', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;
  let tenantAccess: string;
  let endUserId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<void> {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => r.json().data as { accessToken: string });
    tenantAccess = tenant.accessToken;
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    applicationId = application.id;
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string })
      .then((d) => d.rawKey);
    endUserId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { endUser: { id: string } })
      .then((d) => d.endUser.id);
  }

  const grant = (amount: number, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/end-users/${endUserId}/credits/grant`,
      headers: { authorization: `Bearer ${tenantAccess}` },
      payload: { amount, ...extra },
    });

  const consume = (amount: number, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/credits/consume',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { endUserId, amount, ...extra },
    });

  const balance = () =>
    app
      .inject({
        method: 'GET',
        url: `/api/v1/credits/balance?endUserId=${endUserId}`,
        headers: { authorization: `Bearer ${liveKey}` },
      })
      .then((r) => (r.json().data as { balance: number }).balance);

  beforeEach(async () => {
    await bootstrap(`credits-${Math.random().toString(36).slice(2, 8)}`);
  });

  it('operator grant raises balance; public balance reflects it', async () => {
    const res = await grant(100);
    expect(res.statusCode).toBe(201);
    expect(await balance()).toBe(100);
  });

  it('consume is idempotent on idempotencyKey (no double charge on retry)', async () => {
    await grant(100);
    const first = await consume(40, { idempotencyKey: 'lead-1' });
    const second = await consume(40, { idempotencyKey: 'lead-1' });
    expect((first.json().data as { balance: number; applied: boolean }).balance).toBe(60);
    expect((first.json().data as { applied: boolean }).applied).toBe(true);
    expect((second.json().data as { balance: number; applied: boolean }).balance).toBe(60);
    expect((second.json().data as { applied: boolean }).applied).toBe(false);
    expect(await balance()).toBe(60);
  });

  it('consume beyond balance returns 402 CREDITS_INSUFFICIENT and does not debit', async () => {
    await grant(10);
    const res = await consume(11);
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('CREDITS_INSUFFICIENT');
    expect(await balance()).toBe(10);
  });

  // ---------- CREDIT-kind plan ----------

  it('CREDIT plan requires creditsAmount; accepts it when provided', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${tenantAccess}` },
      payload: { slug: 'pack_bad', name: 'Bad Pack', price: { currency: 'USD', amount: 999 }, kind: 'CREDIT' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('PLAN_CREDITS_AMOUNT_REQUIRED');

    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${tenantAccess}` },
      payload: { slug: 'pack_100', name: '100 Leads', price: { currency: 'USD', amount: 4999 }, kind: 'CREDIT', creditsAmount: 100 },
    });
    expect(ok.statusCode).toBe(201);
    const plan = ok.json().data as Record<string, unknown>;
    expect(plan.kind).toBe('CREDIT');
    expect(plan.creditsAmount).toBe(100);
  });

  // ---------- purchase grant idempotency (the webhook path) ----------

  it('grantFromPurchase is idempotent on the payment ref', async () => {
    const first = await creditsService.grantFromPurchase({ applicationId, endUserId, amount: 100, paymentRef: 'pay_1' });
    const second = await creditsService.grantFromPurchase({ applicationId, endUserId, amount: 100, paymentRef: 'pay_1' });
    expect(first.applied).toBe(true);
    expect(first.balance).toBe(100);
    expect(second.applied).toBe(false);
    expect(second.balance).toBe(100);
    expect(await balance()).toBe(100);
  });
  it('two end users may use the same idempotency key without stealing each other\'s credits', async () => {
    // The documented usage IS the collision. The schema's own example of a
    // client-supplied key is "the lead id", and a lead identifies a LEAD, not
    // a buyer. Two users enriching the same lead sent the same key, so the
    // second found the first's ledger row, was told `applied: false`, consumed
    // for FREE, and was handed the first user's `balanceAfter` (#492).
    await bootstrap(`shared-key-${Math.random().toString(36).slice(2, 8)}`);

    const alice = endUserId;
    const bob = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/end-users`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { email: `bob-${Math.random().toString(36).slice(2, 7)}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => (r.json().data as { id: string }).id);

    await creditsService.grantFromPurchase({ applicationId, endUserId: alice, amount: 100, paymentRef: 'p_a' });
    await creditsService.grantFromPurchase({ applicationId, endUserId: bob, amount: 100, paymentRef: 'p_b' });

    const SHARED = 'lead_42';
    const a = await creditsService.consume({ applicationId, endUserId: alice, amount: 10, idempotencyKey: SHARED });
    const b = await creditsService.consume({ applicationId, endUserId: bob, amount: 10, idempotencyKey: SHARED });

    // Both really consumed. `b` used to come back applied:false with Alice's
    // balance, which is both a free drawdown and a cross-subject read.
    expect(a.applied).toBe(true);
    expect(b.applied).toBe(true);
    expect(a.balance).toBe(90);
    expect(b.balance).toBe(90);
    expect(await creditsService.getBalance(applicationId, { endUserId: alice })).toBe(90);
    expect(await creditsService.getBalance(applicationId, { endUserId: bob })).toBe(90);

    // And the key is still idempotent WITHIN one subject, which is what it is
    // for: a retried drawdown must not double-charge.
    const retry = await creditsService.consume({
      applicationId,
      endUserId: bob,
      amount: 10,
      idempotencyKey: SHARED,
    });
    expect(retry.applied).toBe(false);
    expect(await creditsService.getBalance(applicationId, { endUserId: bob })).toBe(90);
  });
});
