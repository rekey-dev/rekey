/**
 * Unapplied payments — a succeeded charge that matches no local subscription
 * must be recorded AND surfaced as a case, for every provider.
 *
 * The Razorpay half is a deliberate behaviour change, not a new feature on top
 * of existing behaviour. `requireLocalSubscription` made the applier drop an
 * unmatched Razorpay payment entirely: no Payment row, no case, no log of the
 * money anywhere. The flag preserved the posture of the old bespoke handler
 * rather than protecting anything, and the cost of keeping it is that a
 * Razorpay buyer's money can arrive and leave no trace at all — which an
 * operator cannot refund, because they cannot see it.
 *
 * These call the applier directly. The webhook routes are covered elsewhere;
 * what needs pinning here is the applier's own decision about an unmatched
 * payment, which is one branch and is easy to make unreachable by accident.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { applyPaymentSucceeded } from '../src/modules/billing/webhooks/apply.js';
import type { PaymentSucceededEvent } from '../src/modules/billing/providers/module-types.js';

/** Enough of a pino logger for the applier, with nothing recorded. */
const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as FastifyBaseLogger;

let app: FastifyInstance;
let applicationId: string;
let operatorEmail: string;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

/**
 * Built directly rather than through sign-up + create-application, and in
 * `beforeEach` rather than `beforeAll`.
 *
 * `test/setup.ts` truncates every domain table before each test, so a fixture
 * built once in `beforeAll` is gone by the time the first test runs — it
 * surfaces as a foreign-key violation inside the applier, several layers from
 * the cause. Creating the rows outright (rather than through sign-up +
 * create-application) also makes the OWNER membership explicit, which is what
 * the operator notification reads.
 */
beforeEach(async () => {
  const suffix = randomUUID().slice(0, 8);
  operatorEmail = `op-${suffix}@example.com`;
  const tenant = await prisma.tenant.create({
    data: { name: `WS ${suffix}`, ownerEmail: operatorEmail },
  });
  const tenantUser = await prisma.tenantUser.create({
    data: { email: operatorEmail, passwordHash: 'x' },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, tenantUserId: tenantUser.id, role: 'OWNER' },
  });
  const application = await prisma.application.create({
    data: {
      tenantId: tenant.id,
      name: `App ${suffix}`,
      slug: `unapplied-${suffix}`,
      publicKey: `rp_pub_unapplied-${suffix}_${randomUUID().slice(0, 12)}`,
      // No default in the schema; the create route supplies it.
      authConfig: { mfa: 'optional', methods: ['password'], tokenAlg: 'HS256' },
      billingConfig: {},
    },
  });
  applicationId = application.id;
});

afterAll(async () => {
  await app.close();
});

function event(overrides: Partial<PaymentSucceededEvent> = {}): PaymentSucceededEvent {
  return {
    type: 'payment.succeeded',
    providerEventId: `evt_${randomUUID()}`,
    applicationId,
    providerPaymentId: `pay_${randomUUID().slice(0, 12)}`,
    providerSubscriptionId: `sub_${randomUUID().slice(0, 12)}`,
    amount: 4900,
    currency: 'usd',
    description: null,
    raw: {},
    ...overrides,
  } as PaymentSucceededEvent;
}

describe('a succeeded payment with no local subscription', () => {
  it('is recorded and queued for Razorpay, which used to drop it entirely', async () => {
    const ev = event({ requireLocalSubscription: true });
    await applyPaymentSucceeded(ev, { log: silentLog, provider: 'razorpay' });

    const payment = await prisma.payment.findFirst({
      where: { applicationId, providerPaymentId: ev.providerPaymentId },
    });
    // Before this change `requireLocalSubscription` returned early and NOTHING
    // was written. Restoring that early return fails here first.
    expect(payment).not.toBeNull();
    expect(payment!.subscriptionId).toBeNull();
    expect(payment!.status).toBe('SUCCEEDED');
    // Stored so the case can be attributed to an end-user later; it is the
    // only identifying thing an unmatched charge carries.
    expect(payment!.providerSubscriptionId).toBe(ev.providerSubscriptionId);

    const kase = await prisma.unappliedPayment.findUnique({
      where: { paymentId: payment!.id },
    });
    expect(kase).not.toBeNull();
    expect(kase!.status).toBe('OPEN');
    expect(kase!.provider).toBe('razorpay');
    expect(kase!.amount).toBe(4900);
    expect(kase!.currency).toBe('USD');
    // Never resolved by Rekey. The whole decision belongs to the operator.
    expect(kase!.resolvedAt).toBeNull();
    expect(kase!.resolvedBy).toBeNull();
  });

  it('opens a case for Stripe too, which already recorded the payment', async () => {
    const ev = event();
    await applyPaymentSucceeded(ev, { log: silentLog, provider: 'stripe' });

    const payment = await prisma.payment.findFirst({
      where: { applicationId, providerPaymentId: ev.providerPaymentId },
    });
    const kase = await prisma.unappliedPayment.findUnique({ where: { paymentId: payment!.id } });
    expect(kase?.provider).toBe('stripe');
  });

  it('records the provider as unknown rather than guessing when none was passed', async () => {
    // A queue row naming the wrong processor sends an operator to refund money
    // in a dashboard where it does not exist.
    const ev = event();
    await applyPaymentSucceeded(ev, { log: silentLog });

    const payment = await prisma.payment.findFirst({
      where: { applicationId, providerPaymentId: ev.providerPaymentId },
    });
    const kase = await prisma.unappliedPayment.findUnique({ where: { paymentId: payment!.id } });
    expect(kase?.provider).toBe('unknown');
  });

  it('opens exactly one case when the provider replays the webhook', async () => {
    const ev = event({ requireLocalSubscription: true });
    await applyPaymentSucceeded(ev, { log: silentLog, provider: 'razorpay' });
    await applyPaymentSucceeded(ev, { log: silentLog, provider: 'razorpay' });

    const payments = await prisma.payment.findMany({
      where: { applicationId, providerPaymentId: ev.providerPaymentId },
    });
    expect(payments).toHaveLength(1);
    const cases = await prisma.unappliedPayment.findMany({
      where: { paymentId: payments[0].id },
    });
    // Two cases for one payment would show the operator the same money twice
    // and let them refund it twice.
    expect(cases).toHaveLength(1);
  });
});

describe('a succeeded payment that DOES match a local subscription', () => {
  it('opens no case', async () => {
    // The queue is for money we could not apply. A normal renewal appearing in
    // it would bury the real cases under noise, which is the failure mode that
    // makes an alerting queue useless.
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
    const providerSubId = `sub_matched_${randomUUID().slice(0, 8)}`;
    const sub = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId: plan.id,
        status: 'ACTIVE',
        providerSubId,
      },
    });

    const ev = event({ providerSubscriptionId: providerSubId });
    await applyPaymentSucceeded(ev, { log: silentLog, provider: 'stripe' });

    const payment = await prisma.payment.findFirst({
      where: { applicationId, providerPaymentId: ev.providerPaymentId },
    });
    expect(payment!.subscriptionId).toBe(sub.id);
    const kase = await prisma.unappliedPayment.findUnique({ where: { paymentId: payment!.id } });
    expect(kase).toBeNull();
  });
});
