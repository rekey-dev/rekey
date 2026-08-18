/**
 * The operator's queue and its three dispositions.
 *
 * What matters here is not that the endpoints return 200. It is that a case
 * can be resolved exactly ONCE, that the queue is ordered oldest-first, and
 * that each refusal an operator can hit says something they can act on. Money
 * leaves the building through these routes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

let app: FastifyInstance;
let token: string;
let applicationId: string;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  const slug = `unap-${randomUUID().slice(0, 6)}`;
  token = await app
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

  applicationId = await app
    .inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: `App ${slug}`, slug },
    })
    .then((r) => (r.json().data as { id: string }).id);
});

/** A SUCCEEDED payment with no subscription, plus its case. */
async function seedCase(opts: { openedAt?: Date; amount?: number; endUserId?: string } = {}) {
  const payment = await prisma.payment.create({
    data: {
      applicationId,
      amount: opts.amount ?? 4900,
      currency: 'USD',
      status: 'SUCCEEDED',
      providerPaymentId: `pi_${randomUUID().slice(0, 12)}`,
      ...(opts.endUserId && { endUserId: opts.endUserId }),
    },
  });
  return prisma.unappliedPayment.create({
    data: {
      applicationId,
      paymentId: payment.id,
      provider: 'stripe',
      amount: payment.amount,
      currency: payment.currency,
      ...(opts.openedAt && { openedAt: opts.openedAt }),
      ...(opts.endUserId && { endUserId: opts.endUserId }),
    },
  });
}

const auth = () => ({ authorization: `Bearer ${token}` });

describe('the queue', () => {
  it('lists oldest first, because that is the case closest to a chargeback', async () => {
    const newer = await seedCase({ openedAt: new Date('2026-08-10T00:00:00Z') });
    const older = await seedCase({ openedAt: new Date('2026-06-01T00:00:00Z') });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const items = (res.json().data as { items: Array<{ id: string; ageDays: number }> }).items;
    // Every other list in the panel is newest-first. This one is not, and
    // flipping it would put the most urgent case on the last page.
    expect(items.map((i) => i.id)).toEqual([older.id, newer.id]);
    expect(items[0]!.ageDays).toBeGreaterThan(items[1]!.ageDays);
  });

  it('reports whether the provider can refund at all', async () => {
    await seedCase();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments`,
      headers: auth(),
    });
    // Stripe declares refunds; the panel uses this to decide whether to render
    // a button rather than offering one that fails after a promise was made.
    expect((res.json().data as { items: Array<{ refundable: boolean }> }).items[0]!.refundable).toBe(
      true,
    );
  });

  it('filters by status', async () => {
    await seedCase();
    const resolved = await seedCase();
    await prisma.unappliedPayment.update({
      where: { id: resolved.id },
      data: { status: 'DISMISSED' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments?status=OPEN`,
      headers: auth(),
    });
    const items = (res.json().data as { items: Array<{ id: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).not.toBe(resolved.id);
  });
});

describe('dismiss', () => {
  it('closes the case and records who and why', async () => {
    const kase = await seedCase();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments/${kase.id}/dismiss`,
      headers: auth(),
      payload: { note: 'Refunded by hand in the Stripe dashboard.' },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().data as { status: string; resolutionNote: string; resolvedBy: string };
    expect(row.status).toBe('DISMISSED');
    expect(row.resolutionNote).toBe('Refunded by hand in the Stripe dashboard.');
    expect(row.resolvedBy).toBeTruthy();
  });

  it('refuses without a note', async () => {
    const kase = await seedCase();
    // Dismissal is the only disposition that leaves no other trace of what
    // happened to the money, so the note is the record.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments/${kase.id}/dismiss`,
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to resolve a case twice', async () => {
    const kase = await seedCase();
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments/${kase.id}/dismiss`,
      headers: auth(),
      payload: { note: 'handled' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments/${kase.id}/dismiss`,
      headers: auth(),
      payload: { note: 'again' },
    });
    // The guard that stops a double-click paying a buyer back twice. It is
    // shared by all three actions, so this pins it for refund and extend too.
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('UNAPPLIED_PAYMENT_ALREADY_RESOLVED');
  });
});

describe('extend', () => {
  async function seedUserWithSubscription(currentPeriodEnd: Date | null) {
    const plan = await prisma.plan.create({
      data: {
        applicationId,
        slug: `plan-${randomUUID().slice(0, 8)}`,
        name: 'Pro',
        amount: 4900,
        currency: 'USD',
        interval: 'MONTH',
      },
    });
    const endUser = await prisma.endUser.create({
      data: {
        applicationId,
        email: `eu-${randomUUID().slice(0, 8)}@example.com`,
        passwordHash: 'x',
      },
    });
    const sub = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId: plan.id,
        status: 'ACTIVE',
        ...(currentPeriodEnd && { currentPeriodEnd }),
      },
    });
    return { endUser, sub };
  }

  it('adds the days to a live period', async () => {
    const end = new Date(Date.now() + 10 * 86_400_000);
    const { endUser, sub } = await seedUserWithSubscription(end);
    const kase = await seedCase({ endUserId: endUser.id });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments/${kase.id}/extend`,
      headers: auth(),
      payload: { days: 30, note: 'Kept the money, gave them a month.' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { status: string }).status).toBe('ENTITLEMENT_GRANTED');

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.currentPeriodEnd!.getTime()).toBe(end.getTime() + 30 * 86_400_000);
  });

  it('extends from now when the period already lapsed', async () => {
    const lapsed = new Date(Date.now() - 30 * 86_400_000);
    const { endUser, sub } = await seedUserWithSubscription(lapsed);
    const kase = await seedCase({ endUserId: endUser.id });

    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments/${kase.id}/extend`,
      headers: auth(),
      payload: { days: 7 },
    });

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    // Extending from the stale end would hand the buyer seven days that
    // expired three weeks ago — a grant they never actually receive.
    expect(after.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses when Rekey does not know who paid', async () => {
    const kase = await seedCase();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments/${kase.id}/extend`,
      headers: auth(),
      payload: { days: 30 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('UNAPPLIED_PAYMENT_UNATTRIBUTED');
    // Still open: a refusal must not consume the case, or the operator loses
    // the ability to refund it instead.
    const after = await prisma.unappliedPayment.findUniqueOrThrow({ where: { id: kase.id } });
    expect(after.status).toBe('OPEN');
  });

  it('refuses when the customer has no subscription to extend', async () => {
    const endUser = await prisma.endUser.create({
      data: {
        applicationId,
        email: `eu-${randomUUID().slice(0, 8)}@example.com`,
        passwordHash: 'x',
      },
    });
    const kase = await seedCase({ endUserId: endUser.id });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments/${kase.id}/extend`,
      headers: auth(),
      payload: { days: 30 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('UNAPPLIED_PAYMENT_NO_SUBSCRIPTION');
  });
});

describe('refund', () => {
  it('refuses a partial amount above what remains unrefunded', async () => {
    const kase = await seedCase({ amount: 4900 });
    await prisma.payment.update({
      where: { id: kase.paymentId },
      data: { refundedAmount: 4000, status: 'PARTIALLY_REFUNDED' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments/${kase.id}/refund`,
      headers: auth(),
      payload: { amount: 2000 },
    });
    // Checked before the provider is called: only 900 remains, and letting the
    // request through would have the provider refuse it after the operator
    // was already told the refund was on its way.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BILLING_REFUND_AMOUNT_EXCEEDED');
  });

  it('refuses a payment with no provider charge id', async () => {
    const payment = await prisma.payment.create({
      data: { applicationId, amount: 4900, currency: 'USD', status: 'SUCCEEDED' },
    });
    const kase = await prisma.unappliedPayment.create({
      data: {
        applicationId,
        paymentId: payment.id,
        provider: 'stripe',
        amount: 4900,
        currency: 'USD',
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments/${kase.id}/refund`,
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BILLING_PAYMENT_NOT_REFUNDABLE');
  });

  it('says so when the provider cannot refund, rather than failing obscurely', async () => {
    // `test/setup.ts` substitutes a fake provider for the whole suite, and the
    // fake implements no `refundPayment`. That is exactly the shape of a
    // provider module that declares no refund capability, so this covers the
    // fail-closed path the optional method exists for.
    const kase = await seedCase();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/unapplied-payments/${kase.id}/refund`,
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BILLING_REFUND_UNSUPPORTED');
    const after = await prisma.unappliedPayment.findUniqueOrThrow({ where: { id: kase.id } });
    // Never marked refunded when no refund happened. The reverse order would
    // leave a case claiming the buyer was paid back when they were not, and
    // nothing revisits a case that has left the queue.
    expect(after.status).toBe('OPEN');
  });
});
