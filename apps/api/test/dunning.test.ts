/**
 * Dunning — failed-payment recovery cases (roadmap §5 v1).
 *
 * Covers the whole case lifecycle:
 *   - PAST_DUE opens a case (Stripe `invoice.payment_failed` + PayPal
 *     SUSPENDED / SALE.DENIED paths) and emits `dunning.case_opened`,
 *   - a later successful payment closes it RECOVERED (+ event),
 *   - the scheduler advances day-3/day-7 reminders (asserted by manipulating
 *     `nextActionAt` — no fake timers needed),
 *   - day-14 exhaustion cancels the subscription and emits both
 *     `subscription.canceled` and `dunning.case_exhausted`,
 *   - the per-case atomic claim stops concurrent pollers double-processing,
 *   - the tenant list endpoint (filtering + workspace scoping).
 *
 * Outbound events are asserted as WebhookDelivery rows (wildcard endpoint,
 * unreachable URL) — same approach as billing-outbound-events.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';
import { processDueDunningCases } from '../src/modules/billing/dunning.service.js';
import type { WebhookDelivery } from '@prisma/client';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const WEBHOOK_SECRET = 'whsec_test_secret_for_ci_only';
const DAY_MS = 24 * 60 * 60 * 1000;

const stripe = new Stripe('sk_for_signing_only', {
  apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
});

function stripeSigned(body: object): { payload: string; headers: Record<string, string> } {
  const payload = JSON.stringify(body);
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, headers: { 'stripe-signature': sig, 'content-type': 'application/json' } };
}

/** Poll for delivery rows of one event type — emission is fire-and-forget. */
async function waitForDeliveries(
  endpointId: string,
  eventType: string,
  count: number,
  timeoutMs = 4000,
): Promise<WebhookDelivery[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: WebhookDelivery[] = [];
  for (;;) {
    rows = await prisma.webhookDelivery.findMany({ where: { endpointId, eventType } });
    if (rows.length >= count || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Poll for email-log rows of one event key — day-0 send is fire-and-forget. */
async function waitForEmailLogs(
  applicationId: string,
  eventKey: string,
  count: number,
  timeoutMs = 4000,
): Promise<Array<{ status: string; toAddress: string }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.emailLog.findMany({ where: { applicationId, eventKey } });
    if (rows.length >= count || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Settle window for negative assertions. */
async function settle(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('Dunning', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  interface Bootstrapped {
    applicationId: string;
    endpointId: string;
    planId: string;
    endUserId: string;
    endUserEmail: string;
  }

  /**
   * Tenant + app (billing on) + plan + end-user + wildcard webhook endpoint.
   * Dunning is opt-in (off by default) — `dunningEnabled` (default true) turns
   * it on so the lifecycle suite below opens cases; the opt-in test passes false.
   */
  async function bootstrap(
    slug: string,
    provider: 'stripe' | 'paypal',
    dunningEnabled = true,
  ): Promise<Bootstrapped> {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: `DUN ${slug}`, ownerEmail: `dun-${slug}@example.com` },
      })
      .then((r) => r.json().data as { id: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: `DUN ${slug}`, slug, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });

    if (provider === 'stripe') {
      await billingCredentialsService.upsertCredentials(
        application.id,
        'stripe',
        { apiKey: 'sk_test_for_ci_only', webhookSecret: WEBHOOK_SECRET },
        { enabled: true, mode: 'test' },
      );
    } else {
      await billingCredentialsService.upsertCredentials(
        application.id,
        'paypal',
        { clientId: 'cid', clientSecret: 'csecret', webhookId: 'WH-TEST' },
        { enabled: true, mode: 'test' },
      );
    }

    // Opt in to failed-payment recovery (off by default per app).
    if (dunningEnabled) {
      await applicationsService.updateBillingConfig({
        applicationId: application.id,
        patch: { dunningEnabled: true },
      });
    }

    const plan = await prisma.plan.create({
      data: {
        applicationId: application.id,
        slug: 'pro_monthly',
        name: 'Pro',
        amount: 999,
        currency: 'USD',
        kind: 'SUBSCRIPTION',
        interval: 'MONTH',
      },
    });
    const endUserEmail = `dun-eu-${slug}@example.com`;
    const endUser = await prisma.endUser.create({
      data: { applicationId: application.id, email: endUserEmail },
    });
    const { endpoint } = await webhookService.createEndpoint({
      applicationId: application.id,
      url: 'https://example.invalid/dunning-hook',
      events: ['*'],
    });
    return {
      applicationId: application.id,
      endpointId: endpoint.id,
      planId: plan.id,
      endUserId: endUser.id,
      endUserEmail,
    };
  }

  async function fireStripe(slug: string, evt: object): Promise<void> {
    const { payload, headers } = stripeSigned(evt);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${slug}`,
      headers,
      payload,
    });
    expect(res.statusCode).toBe(200);
  }

  function invoiceFailedEvt(args: {
    applicationId: string;
    providerSubId: string;
    eventId: string;
    invoiceId: string;
  }): object {
    return {
      id: args.eventId,
      object: 'event',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: args.invoiceId,
          subscription: args.providerSubId,
          amount_due: 999,
          currency: 'usd',
          metadata: { applicationId: args.applicationId },
        },
      },
    };
  }

  function firePaypal(slug: string, eventType: string, resource: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/paypal/${slug}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: `WH-${randomUUID()}`, event_type: eventType, resource }),
    });
  }

  // -------------------------------------------------------------- opt-in gate

  it('opt-in gate: dunningEnabled=false opens NO case on payment failure; =true opens one', async () => {
    // dunningEnabled OFF — a payment failure must NOT open a case.
    const offSlug = 'dun-optin-off';
    const off = await bootstrap(offSlug, 'stripe', false);
    const offSub = await prisma.subscription.create({
      data: {
        applicationId: off.applicationId,
        endUserId: off.endUserId,
        planId: off.planId,
        status: 'ACTIVE',
        provider: 'stripe',
        providerSubId: 'sub_optin_off',
      },
    });
    await fireStripe(
      offSlug,
      invoiceFailedEvt({
        applicationId: off.applicationId,
        providerSubId: 'sub_optin_off',
        eventId: 'evt_optin_off',
        invoiceId: 'in_optin_off',
      }),
    );
    await settle();
    expect(await prisma.dunningCase.count({ where: { subscriptionId: offSub.id } })).toBe(0);
    // No day-0 reminder, no dunning.case_opened either.
    expect(
      await prisma.emailLog.count({
        where: { applicationId: off.applicationId, eventKey: 'billing_payment_failed_reminder' },
      }),
    ).toBe(0);

    // dunningEnabled ON — the same failure opens exactly one case.
    const onSlug = 'dun-optin-on';
    const on = await bootstrap(onSlug, 'stripe', true);
    const onSub = await prisma.subscription.create({
      data: {
        applicationId: on.applicationId,
        endUserId: on.endUserId,
        planId: on.planId,
        status: 'ACTIVE',
        provider: 'stripe',
        providerSubId: 'sub_optin_on',
      },
    });
    await fireStripe(
      onSlug,
      invoiceFailedEvt({
        applicationId: on.applicationId,
        providerSubId: 'sub_optin_on',
        eventId: 'evt_optin_on',
        invoiceId: 'in_optin_on',
      }),
    );
    const opened = await prisma.dunningCase.findFirstOrThrow({
      where: { subscriptionId: onSub.id },
    });
    expect(opened.status).toBe('OPEN');
    expect(await prisma.dunningCase.count({ where: { subscriptionId: onSub.id } })).toBe(1);
  });

  // ------------------------------------------------------------ case opening

  it('stripe: invoice.payment_failed opens a case (reminder #1, +3d next action) and emits dunning.case_opened', async () => {
    const slug = 'dun-s-open';
    const b = await bootstrap(slug, 'stripe');
    const sub = await prisma.subscription.create({
      data: {
        applicationId: b.applicationId,
        endUserId: b.endUserId,
        planId: b.planId,
        status: 'ACTIVE',
        provider: 'stripe',
        providerSubId: 'sub_dun_open',
      },
    });

    await fireStripe(
      slug,
      invoiceFailedEvt({
        applicationId: b.applicationId,
        providerSubId: 'sub_dun_open',
        eventId: 'evt_dun_open_1',
        invoiceId: 'in_dun_open_1',
      }),
    );

    const dunningCase = await prisma.dunningCase.findFirstOrThrow({
      where: { subscriptionId: sub.id },
    });
    expect(dunningCase.status).toBe('OPEN');
    expect(dunningCase.failedAttempts).toBe(1);
    expect(dunningCase.remindersSent).toBe(1); // day-0 reminder
    expect(dunningCase.endUserId).toBe(b.endUserId);
    expect(dunningCase.lastFailureAt).not.toBeNull();
    expect(dunningCase.closedAt).toBeNull();
    // Next action ≈ openedAt + 3 days (day-3 reminder).
    const delta = dunningCase.nextActionAt!.getTime() - dunningCase.openedAt.getTime();
    expect(delta).toBe(3 * DAY_MS);

    const opened = await waitForDeliveries(b.endpointId, 'dunning.case_opened', 1);
    expect(opened).toHaveLength(1);
    const envelope = opened[0]!.payload as {
      applicationId: string;
      data: { dunningCase: { id: string; subscriptionId: string; status: string; planSlug: string } };
    };
    expect(envelope.applicationId).toBe(b.applicationId);
    expect(envelope.data.dunningCase.id).toBe(dunningCase.id);
    expect(envelope.data.dunningCase.subscriptionId).toBe(sub.id);
    expect(envelope.data.dunningCase.status).toBe('OPEN');
    expect(envelope.data.dunningCase.planSlug).toBe('pro_monthly');

    // Day-0 reminder went through the per-app email system (no transport in
    // tests → logged as no_transport; the schedule advances regardless).
    const emails = await waitForEmailLogs(b.applicationId, 'billing_payment_failed_reminder', 1);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.toAddress).toBe(b.endUserEmail);
    expect(emails[0]!.status).toBe('no_transport');
  });

  it('stripe: a repeat failure bumps failedAttempts on the SAME case — no second case, no re-emit', async () => {
    const slug = 'dun-s-bump';
    const b = await bootstrap(slug, 'stripe');
    const sub = await prisma.subscription.create({
      data: {
        applicationId: b.applicationId,
        endUserId: b.endUserId,
        planId: b.planId,
        status: 'ACTIVE',
        provider: 'stripe',
        providerSubId: 'sub_dun_bump',
      },
    });

    for (const n of [1, 2]) {
      await fireStripe(
        slug,
        invoiceFailedEvt({
          applicationId: b.applicationId,
          providerSubId: 'sub_dun_bump',
          eventId: `evt_dun_bump_${n}`,
          invoiceId: `in_dun_bump_${n}`,
        }),
      );
    }

    const cases = await prisma.dunningCase.findMany({ where: { subscriptionId: sub.id } });
    expect(cases).toHaveLength(1);
    expect(cases[0]!.failedAttempts).toBe(2);
    expect(cases[0]!.remindersSent).toBe(1); // reminders are schedule-driven, not failure-driven

    await waitForDeliveries(b.endpointId, 'dunning.case_opened', 1);
    await settle();
    expect(
      await prisma.webhookDelivery.count({
        where: { endpointId: b.endpointId, eventType: 'dunning.case_opened' },
      }),
    ).toBe(1);
  });

  it('paypal: SUSPENDED opens a case (status mirror — no failure counted); SALE.DENIED bumps it', async () => {
    const slug = 'dun-pp-open';
    const b = await bootstrap(slug, 'paypal');
    const sub = await prisma.subscription.create({
      data: {
        applicationId: b.applicationId,
        endUserId: b.endUserId,
        planId: b.planId,
        status: 'ACTIVE',
        provider: 'paypal',
        providerSubId: 'I-DUN-OPEN',
      },
    });

    const res = await firePaypal(slug, 'BILLING.SUBSCRIPTION.SUSPENDED', { id: 'I-DUN-OPEN' });
    expect(res.statusCode).toBe(200);

    let dunningCase = await prisma.dunningCase.findFirstOrThrow({
      where: { subscriptionId: sub.id },
    });
    expect(dunningCase.status).toBe('OPEN');
    expect(dunningCase.failedAttempts).toBe(0); // SUSPENDED is a status signal
    expect(dunningCase.remindersSent).toBe(1);

    await firePaypal(slug, 'PAYMENT.SALE.DENIED', {
      id: `SALE-${randomUUID()}`,
      billing_agreement_id: 'I-DUN-OPEN',
      amount: { total: '9.99', currency: 'USD' },
    });

    dunningCase = await prisma.dunningCase.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(dunningCase.failedAttempts).toBe(1);
    expect(await prisma.dunningCase.count({ where: { subscriptionId: sub.id } })).toBe(1);

    const opened = await waitForDeliveries(b.endpointId, 'dunning.case_opened', 1);
    expect(opened).toHaveLength(1);
  });

  // ---------------------------------------------------------------- recovery

  it('stripe: a later invoice.paid recovers the case (RECOVERED + dunning.case_recovered)', async () => {
    const slug = 'dun-s-rec';
    const b = await bootstrap(slug, 'stripe');
    const sub = await prisma.subscription.create({
      data: {
        applicationId: b.applicationId,
        endUserId: b.endUserId,
        planId: b.planId,
        status: 'ACTIVE',
        provider: 'stripe',
        providerSubId: 'sub_dun_rec',
      },
    });
    await fireStripe(
      slug,
      invoiceFailedEvt({
        applicationId: b.applicationId,
        providerSubId: 'sub_dun_rec',
        eventId: 'evt_dun_rec_fail',
        invoiceId: 'in_dun_rec_fail',
      }),
    );
    expect(
      (await prisma.dunningCase.findFirstOrThrow({ where: { subscriptionId: sub.id } })).status,
    ).toBe('OPEN');

    // Stripe's retry succeeds → invoice.paid arrives.
    await fireStripe(slug, {
      id: 'evt_dun_rec_paid',
      object: 'event',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_dun_rec_paid',
          subscription: 'sub_dun_rec',
          amount_paid: 999,
          currency: 'usd',
          metadata: { applicationId: b.applicationId },
        },
      },
    });

    const dunningCase = await prisma.dunningCase.findFirstOrThrow({
      where: { subscriptionId: sub.id },
    });
    expect(dunningCase.status).toBe('RECOVERED');
    expect(dunningCase.closedAt).not.toBeNull();
    expect(dunningCase.nextActionAt).toBeNull();
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status,
    ).toBe('ACTIVE');

    const recovered = await waitForDeliveries(b.endpointId, 'dunning.case_recovered', 1);
    expect(recovered).toHaveLength(1);
    const envelope = recovered[0]!.payload as { data: { dunningCase: { status: string } } };
    expect(envelope.data.dunningCase.status).toBe('RECOVERED');
  });

  it('paypal: PAYMENT.SALE.COMPLETED recovers the case', async () => {
    const slug = 'dun-pp-rec';
    const b = await bootstrap(slug, 'paypal');
    const sub = await prisma.subscription.create({
      data: {
        applicationId: b.applicationId,
        endUserId: b.endUserId,
        planId: b.planId,
        status: 'ACTIVE',
        provider: 'paypal',
        providerSubId: 'I-DUN-REC',
      },
    });
    await firePaypal(slug, 'BILLING.SUBSCRIPTION.SUSPENDED', { id: 'I-DUN-REC' });
    await firePaypal(slug, 'PAYMENT.SALE.COMPLETED', {
      id: `SALE-${randomUUID()}`,
      billing_agreement_id: 'I-DUN-REC',
      amount: { total: '9.99', currency: 'USD' },
    });

    const dunningCase = await prisma.dunningCase.findFirstOrThrow({
      where: { subscriptionId: sub.id },
    });
    expect(dunningCase.status).toBe('RECOVERED');
    expect(
      (await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status,
    ).toBe('ACTIVE');
    expect(await waitForDeliveries(b.endpointId, 'dunning.case_recovered', 1)).toHaveLength(1);
  });

  it('subscription canceled while in dunning closes the case as CANCELED — silently', async () => {
    const slug = 'dun-s-cxl';
    const b = await bootstrap(slug, 'stripe');
    const sub = await prisma.subscription.create({
      data: {
        applicationId: b.applicationId,
        endUserId: b.endUserId,
        planId: b.planId,
        status: 'ACTIVE',
        provider: 'stripe',
        providerSubId: 'sub_dun_cxl',
      },
    });
    await fireStripe(
      slug,
      invoiceFailedEvt({
        applicationId: b.applicationId,
        providerSubId: 'sub_dun_cxl',
        eventId: 'evt_dun_cxl_fail',
        invoiceId: 'in_dun_cxl_fail',
      }),
    );

    await fireStripe(slug, {
      id: 'evt_dun_cxl_del',
      object: 'event',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_dun_cxl',
          status: 'canceled',
          canceled_at: Math.floor(Date.now() / 1000),
          metadata: { applicationId: b.applicationId },
        },
      },
    });

    const dunningCase = await prisma.dunningCase.findFirstOrThrow({
      where: { subscriptionId: sub.id },
    });
    expect(dunningCase.status).toBe('CANCELED');
    expect(dunningCase.closedAt).not.toBeNull();
    await settle();
    // No recovery/exhaustion announcement for a plain cancel.
    expect(
      await prisma.webhookDelivery.count({
        where: {
          endpointId: b.endpointId,
          eventType: { in: ['dunning.case_recovered', 'dunning.case_exhausted'] },
        },
      }),
    ).toBe(0);
  });

  // --------------------------------------------------------------- scheduler

  /** Open a case via the stripe failure path; returns sub + case ids. */
  async function openCase(slug: string, b: Bootstrapped): Promise<{ subId: string; caseId: string }> {
    const providerSubId = `sub_${slug.replace(/-/g, '_')}`;
    const sub = await prisma.subscription.create({
      data: {
        applicationId: b.applicationId,
        endUserId: b.endUserId,
        planId: b.planId,
        status: 'ACTIVE',
        provider: 'stripe',
        providerSubId,
      },
    });
    await fireStripe(
      slug,
      invoiceFailedEvt({
        applicationId: b.applicationId,
        providerSubId,
        eventId: `evt_${providerSubId}`,
        invoiceId: `in_${providerSubId}`,
      }),
    );
    const dunningCase = await prisma.dunningCase.findFirstOrThrow({
      where: { subscriptionId: sub.id },
    });
    return { subId: sub.id, caseId: dunningCase.id };
  }

  it('scheduler advances reminders: day-3 then day-7, each scheduling the next action', async () => {
    const slug = 'dun-s-sched';
    const b = await bootstrap(slug, 'stripe');
    const { caseId } = await openCase(slug, b);

    // Pretend day 3 arrived.
    await prisma.dunningCase.update({
      where: { id: caseId },
      data: { nextActionAt: new Date(Date.now() - 1000) },
    });
    expect(await processDueDunningCases()).toBe(1);

    let dunningCase = await prisma.dunningCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(dunningCase.status).toBe('OPEN');
    expect(dunningCase.remindersSent).toBe(2);
    // Next action = openedAt + 7d (day-7 reminder).
    expect(dunningCase.nextActionAt!.getTime() - dunningCase.openedAt.getTime()).toBe(7 * DAY_MS);

    // Day 7.
    await prisma.dunningCase.update({
      where: { id: caseId },
      data: { nextActionAt: new Date(Date.now() - 1000) },
    });
    expect(await processDueDunningCases()).toBe(1);

    dunningCase = await prisma.dunningCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(dunningCase.remindersSent).toBe(3);
    // Next action = openedAt + 14d (exhaustion deadline).
    expect(dunningCase.nextActionAt!.getTime() - dunningCase.openedAt.getTime()).toBe(14 * DAY_MS);

    // All three reminders went through the email system (day-0 was async —
    // poll; the scheduler sends synchronously).
    const emails = await waitForEmailLogs(b.applicationId, 'billing_payment_failed_reminder', 3);
    expect(emails.length).toBe(3);

    // Nothing due anymore → a poll claims nothing.
    expect(await processDueDunningCases()).toBe(0);
  });

  it('day-14 exhaustion cancels the subscription and emits subscription.canceled + dunning.case_exhausted', async () => {
    const slug = 'dun-s-exh';
    const b = await bootstrap(slug, 'stripe');
    const { subId, caseId } = await openCase(slug, b);

    // Fast-forward: all three reminders sent, day-14 deadline passed.
    await prisma.dunningCase.update({
      where: { id: caseId },
      data: { remindersSent: 3, nextActionAt: new Date(Date.now() - 1000) },
    });
    expect(await processDueDunningCases()).toBe(1);

    const dunningCase = await prisma.dunningCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(dunningCase.status).toBe('EXHAUSTED');
    expect(dunningCase.closedAt).not.toBeNull();
    expect(dunningCase.nextActionAt).toBeNull();

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(sub.status).toBe('CANCELED');
    expect(sub.canceledAt).not.toBeNull();

    expect(await waitForDeliveries(b.endpointId, 'dunning.case_exhausted', 1)).toHaveLength(1);
    expect(await waitForDeliveries(b.endpointId, 'subscription.canceled', 1)).toHaveLength(1);

    // Exhaustion is terminal — replaying the poll does nothing.
    expect(await processDueDunningCases()).toBe(0);
  });

  it('atomic claim: two concurrent pollers process a due case exactly once', async () => {
    const slug = 'dun-s-claim';
    const b = await bootstrap(slug, 'stripe');
    const { caseId } = await openCase(slug, b);

    await prisma.dunningCase.update({
      where: { id: caseId },
      data: { nextActionAt: new Date(Date.now() - 1000) },
    });

    const [a, c] = await Promise.all([processDueDunningCases(), processDueDunningCases()]);
    expect(a + c).toBe(1); // exactly one poller won the claim

    const dunningCase = await prisma.dunningCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(dunningCase.remindersSent).toBe(2); // advanced once, not twice
  });

  // ---------------------------------------------------------- tenant surface

  it('tenant endpoint lists cases (status filter, end-user email join) and scopes by workspace (404)', async () => {
    // Operator workspace + app created through the tenant surface.
    const tenantAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: 'op-dunning@example.com',
          password: 'pw-one-two-three',
          workspaceName: 'WS dunning',
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: 'DunList', slug: 'dun-list-app', enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);

    const plan = await prisma.plan.create({
      data: { applicationId, slug: 'pro', name: 'Pro', amount: 999, currency: 'USD' },
    });
    const endUser = await prisma.endUser.create({
      data: { applicationId, email: 'dun-list-eu@example.com' },
    });
    // The (applicationId, endUserId, planId) unique allows one sub per plan —
    // a second plan backs the second case.
    const sub1 = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId: plan.id,
        status: 'PAST_DUE',
        provider: 'stripe',
        providerSubId: 'sub_dl_1',
      },
    });
    const plan2 = await prisma.plan.create({
      data: { applicationId, slug: 'pro2', name: 'Pro 2', amount: 1999, currency: 'USD' },
    });
    const sub2 = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: endUser.id,
        planId: plan2.id,
        status: 'ACTIVE',
        provider: 'stripe',
        providerSubId: 'sub_dl_2',
      },
    });

    await prisma.dunningCase.create({
      data: {
        applicationId,
        subscriptionId: sub1.id,
        endUserId: endUser.id,
        status: 'OPEN',
        failedAttempts: 2,
        remindersSent: 1,
        openedAt: new Date(Date.now() - 2 * DAY_MS),
        nextActionAt: new Date(Date.now() + DAY_MS),
      },
    });
    await prisma.dunningCase.create({
      data: {
        applicationId,
        subscriptionId: sub2.id,
        endUserId: endUser.id,
        status: 'RECOVERED',
        failedAttempts: 1,
        remindersSent: 2,
        openedAt: new Date(Date.now() - 10 * DAY_MS),
        closedAt: new Date(Date.now() - 5 * DAY_MS),
      },
    });

    // Unfiltered: both cases, newest-opened first.
    const all = await app
      .inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${applicationId}/dunning`,
        headers: { authorization: `Bearer ${tenantAccess}` },
      })
      .then(
        (r) =>
          r.json().data as {
            items: Array<Record<string, unknown>>;
            page: { total: number; hasMore: boolean };
          },
      );
    expect(all.items).toHaveLength(2);
    expect(all.page).toMatchObject({ total: 2, hasMore: false });
    expect(all.items[0]!.status).toBe('OPEN'); // opened 2d ago > 10d ago
    expect(all.items[0]!.endUserEmail).toBe('dun-list-eu@example.com');
    expect(all.items[0]!.planSlug).toBe('pro');
    expect(all.items[0]!.failedAttempts).toBe(2);

    // Status filter.
    const open = await app
      .inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${applicationId}/dunning?status=OPEN`,
        headers: { authorization: `Bearer ${tenantAccess}` },
      })
      .then(
        (r) =>
          r.json().data as {
            items: Array<Record<string, unknown>>;
            page: { total: number };
          },
      );
    expect(open.items).toHaveLength(1);
    // The count follows the filter, so a filtered pager sees 1, not 2.
    expect(open.page.total).toBe(1);
    expect(open.items[0]!.subscriptionId).toBe(sub1.id);

    // Pagination caps + offset behave like the payments endpoint.
    const pagedCases = await app
      .inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${applicationId}/dunning?limit=1&offset=1`,
        headers: { authorization: `Bearer ${tenantAccess}` },
      })
      .then(
        (r) =>
          r.json().data as {
            items: Array<Record<string, unknown>>;
            page: { total: number; limit: number; offset: number; hasMore: boolean };
          },
      );
    expect(pagedCases.items).toHaveLength(1);
    expect(pagedCases.page).toEqual({ total: 2, limit: 1, offset: 1, hasMore: false });
    expect(pagedCases.items[0]!.status).toBe('RECOVERED');

    // Workspace scoping: another tenant gets 404 (no existence oracle).
    const otherAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: 'op-dunning-other@example.com',
          password: 'pw-one-two-three',
          workspaceName: 'WS dunning other',
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/dunning`,
      headers: { authorization: `Bearer ${otherAccess}` },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.code).toBe('APPLICATION_NOT_FOUND');
  });
});
