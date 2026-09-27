/**
 * `subscription.trial_started` and `subscription.trial_will_end`.
 *
 * trial_started is written with the write that puts a subscription into
 * TRIALING, on each of the three paths that do: a grant (external billing,
 * imports), a hosted checkout completing with a trial, and a provider's status
 * mirror. trial_will_end comes from a sweep that claims each (subscription,
 * trial end) pair once, so it is asserted by running the sweep directly, the
 * way the suite drives the dunning poller.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';
import { applyBillingEvent } from '../src/modules/billing/webhooks/apply.js';
import {
  announceTrialWillEnd,
  processTrialsEndingSoon,
  TRIAL_WILL_END_LEAD_DAYS,
} from '../src/modules/billing/trial-events.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';

const SECRET = 'external-billing-signing-secret-for-tests-0123456789';
const PASSWORD = 'pw-one-two-three';
const RACERS = 8;
const DAY = 86_400_000;

type Json = Record<string, unknown>;

const daysFromNow = (days: number): Date => new Date(Date.now() + days * DAY);

describe('Trial lifecycle webhooks', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let appSlug: string;
  let seq = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(async () => {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS tl_fail_delivery ON webhook_deliveries');
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS tl_fail_commit ON subscriptions');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS tl_raise()');
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `tl-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appSlug = `tl-${slug}`;
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'TL', slug: appSlug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    await billingCredentialsService.upsertCredentials(appId, 'external', { webhookSecret: SECRET }, { mode: 'test' });
    await webhookService.createEndpoint({
      applicationId: appId,
      url: 'https://example.invalid/trial-hook',
      events: ['*'],
    });
    const plan = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug: 'pro', name: 'Pro', amount: 2900, kind: 'SUBSCRIPTION', interval: 'MONTH' },
    });
    expect(plan.statusCode).toBe(201);
  });

  async function deliveries(type: string): Promise<Json[]> {
    const rows = await prisma.webhookDelivery.findMany({
      where: { applicationId: appId, eventType: type },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => (r.payload as { data: Json }).data);
  }

  async function failDeliveriesOf(type: string): Promise<void> {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION tl_raise() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END;
      $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER tl_fail_delivery BEFORE INSERT ON webhook_deliveries
      FOR EACH ROW WHEN (NEW.event_type = '${type}') EXECUTE FUNCTION tl_raise()`);
  }

  function post(body: unknown) {
    const payload = JSON.stringify(body);
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex');
    return app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/billing/external/${appSlug}`,
      headers: { 'content-type': 'application/json', 'x-rekey-signature': `t=${t},v1=${v1}` },
      payload,
    });
  }

  function activated(subscriptionId: string, email: string, subscription: Json = {}): Json {
    seq += 1;
    return {
      eventId: `evt_${seq}_${randomUUID()}`,
      type: 'subscription.activated',
      occurredAt: new Date().toISOString(),
      data: { subscription: { id: subscriptionId, plan: 'pro', ...subscription }, subscriber: { email } },
    };
  }

  async function subscriptionOf(providerSubId: string) {
    return prisma.subscription.findUniqueOrThrow({
      where: { applicationId_providerSubId: { applicationId: appId, providerSubId } },
    });
  }

  async function trialFor(providerSubId: string, email: string, ends: Date): Promise<string> {
    const res = await post(activated(providerSubId, email, { trialEndsAt: ends.toISOString() }));
    expect(res.json()).toMatchObject({ processed: true });
    const sub = await subscriptionOf(providerSubId);
    expect(sub.status).toBe('TRIALING');
    return sub.id;
  }

  // ---------- trial_started ----------

  describe('subscription.trial_started', () => {
    it('a granted trial announces itself once, with its end date', async () => {
      const ends = daysFromNow(14);
      const id = await trialFor('sub_t', 'trial@example.com', ends);
      const rows = await deliveries('subscription.trial_started');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        subscription: { id, status: 'TRIALING', planSlug: 'pro', trialEndsAt: ends.toISOString() },
      });
      // A re-dated trial is the same trial.
      await post(activated('sub_t', 'trial@example.com', { trialEndsAt: daysFromNow(20).toISOString() }));
      expect(await deliveries('subscription.trial_started')).toHaveLength(1);
    });

    it('a paid activation is not a trial', async () => {
      await post(activated('sub_paid', 'paid@example.com'));
      expect((await subscriptionOf('sub_paid')).status).toBe('ACTIVE');
      expect(await deliveries('subscription.trial_started')).toHaveLength(0);
    });

    it('a grant whose trial_started cannot be written starts no trial', async () => {
      await failDeliveriesOf('subscription.trial_started');
      const res = await post(activated('sub_roll', 'roll@example.com', { trialEndsAt: daysFromNow(14).toISOString() }));
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(await prisma.subscription.count({ where: { applicationId: appId, status: 'TRIALING' } })).toBe(0);
    });

    it('a provider status mirror that moves a subscription into TRIALING announces it', async () => {
      const endUserId = await app
        .inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${appId}/end-users`,
          headers: auth(),
          payload: { email: 'mirror@example.com' },
        })
        .then((r) => (r.json().data as { id: string }).id);
      const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'pro' } });
      const sub = await prisma.subscription.create({
        data: {
          applicationId: appId,
          endUserId,
          planId: plan.id,
          provider: 'external',
          providerSubId: 'sub_mirror',
          status: 'PENDING',
        },
      });
      const ends = daysFromNow(7);
      const ev = {
        type: 'subscription.activated' as const,
        providerEventId: `evt_${randomUUID()}`,
        applicationId: appId,
        providerSubscriptionId: 'sub_mirror',
        status: 'TRIALING' as const,
        trialEndsAt: ends,
        raw: {},
      };
      await applyBillingEvent(ev, { log: app.log, provider: 'external' });
      await applyBillingEvent({ ...ev, providerEventId: `evt_${randomUUID()}` }, { log: app.log, provider: 'external' });
      const rows = await deliveries('subscription.trial_started');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ subscription: { id: sub.id, status: 'TRIALING', trialEndsAt: ends.toISOString() } });
    });
  });

  describe('subscription.trial_started from hosted checkout', () => {
    const stripe = new Stripe('sk_for_signing_only', { apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion });

    it('a checkout that completes on a trial announces it', async () => {
      await configureSandboxStripe(appId);
      await prisma.plan.updateMany({ where: { applicationId: appId }, data: { trialDays: 14 } });
      const liveKey = await app
        .inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${appId}/api-keys`,
          headers: auth(),
          payload: { name: 'k', mode: 'live' },
        })
        .then((r) => (r.json().data as { rawKey: string }).rawKey);
      const userAccess = await app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${liveKey}` },
          payload: { email: 'buyer@example.com', password: PASSWORD },
        })
        .then((r) => (r.json().data as { accessToken: string }).accessToken);
      const checkout = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
        payload: {
          planSlug: 'pro',
          provider: 'stripe',
          successUrl: 'https://app.example/ok',
          cancelUrl: 'https://app.example/cancel',
        },
      });
      expect(checkout.statusCode).toBe(200);
      const sessionId = (checkout.json().data as { subscription: { metadata: { checkoutSessionId: string } } })
        .subscription.metadata.checkoutSessionId;
      const payload = JSON.stringify({
        id: `evt_${randomUUID()}`,
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: { metadata: { applicationId: appId }, id: sessionId, mode: 'subscription', subscription: 'sub_hosted' },
        },
      });
      const hook = await app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/stripe/${appSlug}`,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_ci_only' }),
        },
        payload,
      });
      expect(hook.statusCode).toBe(200);
      const sub = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId } });
      expect(sub.status).toBe('TRIALING');
      const rows = await deliveries('subscription.trial_started');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ subscription: { id: sub.id, trialEndsAt: sub.trialEndsAt!.toISOString() } });
    });
  });

  // ---------- trial_will_end ----------

  describe('subscription.trial_will_end', () => {
    it(`fires once when the trial end comes within ${TRIAL_WILL_END_LEAD_DAYS} days, and not for later trials`, async () => {
      const soon = daysFromNow(TRIAL_WILL_END_LEAD_DAYS - 1);
      const soonId = await trialFor('sub_soon', 'soon@example.com', soon);
      await trialFor('sub_later', 'later@example.com', daysFromNow(TRIAL_WILL_END_LEAD_DAYS + 5));

      await processTrialsEndingSoon();
      await processTrialsEndingSoon();
      const rows = await deliveries('subscription.trial_will_end');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        subscription: { id: soonId, status: 'TRIALING', trialEndsAt: soon.toISOString() },
      });
    });

    it(`fires once however many of ${RACERS} sweeps run at the same time`, async () => {
      await trialFor('sub_race', 'race@example.com', daysFromNow(1));
      await Promise.all(Array.from({ length: RACERS }, () => processTrialsEndingSoon()));
      expect(await deliveries('subscription.trial_will_end')).toHaveLength(1);
    });

    it('a sweep acting on a stale read of an already-claimed trial announces nothing', async () => {
      const ends = daysFromNow(1);
      const id = await trialFor('sub_stale', 'stale@example.com', ends);
      // What two sweeps that both read the row before either claimed it do.
      expect(await announceTrialWillEnd({ id, trialEndsAt: ends })).toBe(true);
      expect(await announceTrialWillEnd({ id, trialEndsAt: ends })).toBe(false);
      expect(await deliveries('subscription.trial_will_end')).toHaveLength(1);
    });

    it('a re-dated trial is announced again for its new end', async () => {
      await trialFor('sub_redate', 'redate@example.com', daysFromNow(2));
      await processTrialsEndingSoon();
      const later = daysFromNow(1);
      await post(activated('sub_redate', 'redate@example.com', { trialEndsAt: later.toISOString() }));
      expect((await subscriptionOf('sub_redate')).trialEndsAt?.toISOString()).toBe(later.toISOString());
      await processTrialsEndingSoon();
      await processTrialsEndingSoon();
      const rows = await deliveries('subscription.trial_will_end');
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ subscription: { trialEndsAt: later.toISOString() } });
    });

    it('a trial that ended or converted is not announced', async () => {
      const id = await trialFor('sub_conv', 'conv@example.com', daysFromNow(1));
      await prisma.subscription.update({ where: { id }, data: { status: 'ACTIVE' } });
      await trialFor('sub_past', 'past@example.com', daysFromNow(1));
      await prisma.subscription.updateMany({
        where: { applicationId: appId, providerSubId: 'sub_past' },
        data: { trialEndsAt: new Date(Date.now() - DAY) },
      });
      await processTrialsEndingSoon();
      expect(await deliveries('subscription.trial_will_end')).toHaveLength(0);
    });

    it('a claim that fails at COMMIT leaves no trial_will_end behind', async () => {
      const id = await trialFor('sub_late', 'late@example.com', daysFromNow(1));
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION tl_raise() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'injected failure'; END;
        $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`
        CREATE CONSTRAINT TRIGGER tl_fail_commit AFTER UPDATE ON subscriptions
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW WHEN (NEW.trial_will_end_notified_for IS NOT NULL) EXECUTE FUNCTION tl_raise()`);
      await processTrialsEndingSoon();
      expect(await deliveries('subscription.trial_will_end')).toHaveLength(0);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id } })).trialWillEndNotifiedFor).toBeNull();
    });

    it('an announcement that cannot be written is retried by the next sweep', async () => {
      const id = await trialFor('sub_retry', 'retry@example.com', daysFromNow(1));
      await failDeliveriesOf('subscription.trial_will_end');
      await processTrialsEndingSoon();
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id } })).trialWillEndNotifiedFor).toBeNull();
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS tl_fail_delivery ON webhook_deliveries');
      await processTrialsEndingSoon();
      expect(await deliveries('subscription.trial_will_end')).toHaveLength(1);
    });
  });
});
