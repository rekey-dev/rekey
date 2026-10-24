/**
 * A subscriber's reason for cancelling: kept on the subscription, carried on
 * `subscription.canceled`, and the free text erased with the person.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { setDeliveryScheduler } from '../src/modules/webhooks/webhook.service.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { seedPlan } from './seed-plan.js';

operatorsConfirmTheirEmail();

describe('cancellation reason', () => {
  let app: FastifyInstance;
  let n = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => setDeliveryScheduler(() => undefined));
  afterEach(() => setDeliveryScheduler(null));

  async function fixture() {
    const slug = `cr-${++n}-${Math.random().toString(36).slice(2, 7)}`;
    const tenantToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantToken}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${tenantToken}` },
        payload: { name: 'k', mode: 'live', scopes: ['auth:write', 'billing:read', 'billing:write'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    const session = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { endUser: { id: string }; accessToken: string });
    const plan = await seedPlan(
      { applicationId, slug: `plan-${slug}`, name: 'Paid', interval: 'MONTH', active: true },
      { currency: 'usd', amount: 9900 },
    );
    const subscription = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: session.endUser.id,
        planId: plan.id,
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
      },
    });
    await prisma.webhookEndpoint.create({
      data: { applicationId, url: 'https://127.0.0.1:1/never', secret: 'whsec_cr', events: ['*'], enabled: true },
    });
    return { tenantToken, applicationId, liveKey, session, subscription };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const cancel = (f: Fixture, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': f.session.accessToken },
      payload,
    });

  const canceledEvents = async (applicationId: string) =>
    (await prisma.webhookDelivery.findMany({ where: { applicationId, eventType: 'subscription.canceled' } })).map(
      (d) => (d.payload as { data: { subscription: Record<string, unknown> } }).data.subscription,
    );

  it('keeps the reason and feedback and carries them on subscription.canceled', async () => {
    const f = await fixture();
    const res = await cancel(f, { atPeriodEnd: false, reason: 'too_expensive', feedback: 'Half the price and I stay.' });
    expect(res.statusCode, res.body).toBe(200);
    const [event] = await canceledEvents(f.applicationId);
    expect(event!.cancellation).toEqual({ reason: 'too_expensive', feedback: 'Half the price and I stay.' });
  });

  it('refuses an unknown reason, and a cancel without one carries no cancellation', async () => {
    const f = await fixture();
    expect((await cancel(f, { atPeriodEnd: false, reason: 'because' })).statusCode).toBe(400);
    expect((await cancel(f, { atPeriodEnd: false, feedback: 'no reason given' })).statusCode).toBe(400);
    expect((await cancel(f, { atPeriodEnd: false })).statusCode).toBe(200);
    const [event] = await canceledEvents(f.applicationId);
    expect(event).not.toHaveProperty('cancellation');
  });

  it('a subscription that comes back from a scheduled cancel drops the old reason', async () => {
    const f = await fixture();
    await cancel(f, { reason: 'too_expensive', feedback: 'Too much.' });
    const { clearedOnReactivation } = await import('../src/modules/billing/webhooks/apply-shared.js');
    const resumed = await prisma.subscription.update({ where: { id: f.subscription.id }, data: clearedOnReactivation });
    expect(resumed).toMatchObject({ cancelAt: null, cancelReason: null, cancelFeedback: null });
  });

  it('erasing the subscriber deletes their feedback from the row and the stored event, and keeps the reason', async () => {
    const f = await fixture();
    await cancel(f, { atPeriodEnd: false, reason: 'missing_features', feedback: 'Call me on 555-0100.' });
    const erased = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${f.applicationId}/end-users/${f.session.endUser.id}?erasure=true`,
      headers: { authorization: `Bearer ${f.tenantToken}` },
    });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: f.subscription.id } })).toMatchObject({
      cancelReason: 'missing_features',
      cancelFeedback: null,
    });
    const [event] = await canceledEvents(f.applicationId);
    expect(event!.cancellation).toEqual({ reason: 'missing_features', feedback: null });
  });
});
