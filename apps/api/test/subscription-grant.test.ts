/**
 * Granting a subscription with no payment provider behind it —
 * `POST /api/v1/admin/applications/:id/subscriptions`.
 *
 * The thing under test is not the row. It is whether a grant produces the same
 * CONSEQUENCES a provider activation produces, because everything downstream —
 * entitlement resolution, the outbound `subscription.activated` event, and the
 * Cloud provisioning that listens for it — is built on those and not on the
 * status column. So each case here asserts an effect, not a write:
 *
 *   - the entitlements are materialised onto the subscriber;
 *   - `subscription.activated` reaches a webhook endpoint, once, carrying
 *     every field a consumer needs to act on the sale;
 *   - a second identical grant does none of it again;
 *   - the period exists, so "cancel at period end" has something to schedule
 *     against and the local expiry has something to reap;
 *   - and nobody without the deployment credential can do any of it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { WebhookDelivery } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { creditsService } from '../src/modules/credits/credits.service.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

/** Poll for delivery rows of one event type — emission is fire-and-forget. */
async function waitForDeliveries(
  endpointId: string,
  eventType: string,
  count: number,
  timeoutMs = 4000,
): Promise<WebhookDelivery[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.webhookDelivery.findMany({ where: { endpointId, eventType } });
    if (rows.length >= count || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Settle window for the negative assertions ("no SECOND delivery appeared"). */
async function settle(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('Granting a subscription without a payment provider', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let endpointId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    const su = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `grant-${slug}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: `WS ${slug}`,
      },
    });
    if (su.statusCode !== 201) throw new Error(`signup ${su.statusCode}: ${su.body}`);
    token = (su.json().data as { accessToken: string }).accessToken;
    const ac = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'GrantApp', slug: `grant-${slug}` },
    });
    if (ac.statusCode !== 201) throw new Error(`appcreate ${ac.statusCode}: ${ac.body}`);
    appId = (ac.json().data as { id: string }).id;
    const { endpoint } = await webhookService.createEndpoint({
      applicationId: appId,
      // Unreachable on purpose: delivery ROWS are the assertion, not HTTP success.
      url: 'https://example.invalid/grant-hook',
      events: ['*'],
    });
    endpointId = endpoint.id;
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });
  const admin = (): { authorization: string } => ({ authorization: `Bearer ${ADMIN_KEY}` });

  async function makePlan(slug: string, body: Record<string, unknown> = {}): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug, name: slug, amount: 2900, kind: 'SUBSCRIPTION', interval: 'MONTH', ...body },
    });
    if (r.statusCode !== 201) throw new Error(`makePlan ${r.statusCode}: ${r.body}`);
    return (r.json().data as { id: string }).id;
  }

  async function putEntitlement(slug: string, body: Record<string, unknown>): Promise<void> {
    const r = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
      headers: auth(),
      payload: body,
    });
    if (r.statusCode !== 200) throw new Error(`putEntitlement ${r.statusCode}: ${r.body}`);
  }

  async function makeEndUser(email: string): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: auth(),
      payload: { email, password: 'pw-one-two-three' },
    });
    if (r.statusCode !== 201) throw new Error(`makeEndUser ${r.statusCode}: ${r.body}`);
    return (r.json().data as { id: string }).id;
  }

  function grant(payload: Record<string, unknown>, headers = admin()) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${appId}/subscriptions`,
      headers,
      payload,
    });
  }

  // ------------------------------------------------------------ the grant

  it('activates the subscription and materialises the plan entitlements', async () => {
    await makePlan('pro');
    await putEntitlement('pro', { kind: 'CREDIT', quantity: 500 });
    await putEntitlement('pro', {
      kind: 'FEATURE',
      key: 'advanced_reporting',
      valueType: 'BOOL',
      value: 'true',
    });
    const euId = await makeEndUser('buyer@example.com');

    const before = Date.now();
    const res = await grant({ planSlug: 'pro', endUserId: euId, note: 'wire transfer #4471' });
    expect(res.statusCode).toBe(201);
    const body = res.json().data as {
      activated: boolean;
      subscription: {
        id: string;
        status: string;
        provider: string | null;
        currentPeriodEnd: string | null;
      };
    };
    expect(body.activated).toBe(true);
    expect(body.subscription.status).toBe('ACTIVE');
    // Provider-less is the defining property — it is what makes the local
    // cancel + expiry paths, rather than a webhook nobody will send, the thing
    // that ends this subscription.
    expect(body.subscription.provider).toBeNull();

    // Open-ended by default. It used to default to one plan interval, which
    // was invisible while nothing read the column for a provider-less row and
    // became a landmine once an elapsed term started expiring the row: every
    // comp silently became a one-month comp, and nothing renews a grant.
    // "Comp this account" now means what it says; a term is opt-in.
    expect(body.subscription.currentPeriodEnd).toBeNull();

    // The consequence that matters: what the buyer now holds.
    expect(await creditsService.getBalance(appId, { endUserId: euId })).toBe(500);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: body.subscription.id } });
    expect(row.providerSubId).toBeNull();
    expect((row.metadata as { grant?: { note?: string } }).grant?.note).toBe('wire transfer #4471');
  });

  it('emits subscription.activated through the same outbox a real activation uses', async () => {
    await makePlan('pro');
    await putEntitlement('pro', { kind: 'CREDIT', quantity: 500 });
    const euId = await makeEndUser('buyer@example.com');

    const res = await grant({ planSlug: 'pro', endUserId: euId });
    expect(res.statusCode).toBe(201);

    const deliveries = await waitForDeliveries(endpointId, 'subscription.activated', 1);
    expect(deliveries).toHaveLength(1);
    const envelope = deliveries[0]!.payload as {
      eventId: string;
      type: string;
      applicationId: string;
      data: {
        subscription: {
          id: string;
          endUserId: string;
          status: string;
          provider: string | null;
          planSlug: string;
          currentPeriodEnd: string | null;
          entitlements: Array<{ kind: string; quantity: number | null }>;
        };
      };
    };
    expect(envelope.type).toBe('subscription.activated');
    expect(envelope.eventId).toBeTruthy(); // consumer-side idempotency key
    expect(envelope.applicationId).toBe(appId);

    // Every field the Rekey Cloud provisioner reads off this event. It gates on
    // the status and resolves the workspace from `endUserId`; `provider: null`
    // is what tells a consumer no processor is involved; `entitlements` is what
    // it turns into the workspace ceiling without a follow-up API call it holds
    // no token for.
    const s = envelope.data.subscription;
    expect(s.endUserId).toBe(euId);
    expect(s.status).toBe('ACTIVE');
    expect(s.provider).toBeNull();
    expect(s.planSlug).toBe('pro');
    expect(s.currentPeriodEnd).toBeNull();
    expect(s.entitlements).toEqual([expect.objectContaining({ kind: 'CREDIT', quantity: 500 })]);
  });

  // ---------------------------------------------------------- idempotency

  it('is idempotent: a second grant neither re-entitles nor re-announces', async () => {
    await makePlan('pro');
    await putEntitlement('pro', { kind: 'CREDIT', quantity: 500 });
    const euId = await makeEndUser('buyer@example.com');

    const first = await grant({ planSlug: 'pro', endUserId: euId });
    expect(first.statusCode).toBe(201);
    await waitForDeliveries(endpointId, 'subscription.activated', 1);

    const second = await grant({ planSlug: 'pro', endUserId: euId });
    // 200, not 201: the subscription exists and this call did not create it.
    expect(second.statusCode).toBe(200);
    expect((second.json().data as { activated: boolean }).activated).toBe(false);

    await settle();
    expect(await prisma.webhookDelivery.count({ where: { endpointId, eventType: 'subscription.activated' } })).toBe(1);
    expect(await creditsService.getBalance(appId, { endUserId: euId })).toBe(500);
    expect(await prisma.subscription.count({ where: { applicationId: appId, endUserId: euId } })).toBe(1);
  });

  it('two concurrent grants activate once and announce once', async () => {
    await makePlan('pro');
    await putEntitlement('pro', { kind: 'CREDIT', quantity: 500 });
    const euId = await makeEndUser('buyer@example.com');

    // Both requests read the same pre-transaction state. What separates them is
    // the unique key on (application, end-user, plan) for the create path and a
    // count-checked conditional update for the re-grant path — without either,
    // a double-clicked "mark as paid" button is a double announcement of one
    // sale, and every consumer acts on it twice.
    const [a, b] = await Promise.all([
      grant({ planSlug: 'pro', endUserId: euId }),
      grant({ planSlug: 'pro', endUserId: euId }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    const activations = [a, b].filter((r) => (r.json().data as { activated: boolean }).activated);
    expect(activations).toHaveLength(1);

    await waitForDeliveries(endpointId, 'subscription.activated', 1);
    await settle();
    expect(await prisma.subscription.count({ where: { applicationId: appId, endUserId: euId } })).toBe(1);
    expect(await prisma.webhookDelivery.count({ where: { endpointId, eventType: 'subscription.activated' } })).toBe(1);
    expect(await creditsService.getBalance(appId, { endUserId: euId })).toBe(500);
  });

  it('does not extend a live period — a retried grant cannot buy a second month', async () => {
    await makePlan('pro');
    const euId = await makeEndUser('buyer@example.com');
    const far = new Date(Date.now() + 365 * 86_400_000).toISOString();

    const first = await grant({ planSlug: 'pro', endUserId: euId, currentPeriodEnd: far });
    expect(first.statusCode).toBe(201);
    const second = await grant({
      planSlug: 'pro',
      endUserId: euId,
      currentPeriodEnd: new Date(Date.now() + 730 * 86_400_000).toISOString(),
    });
    expect(second.statusCode).toBe(200);
    const row = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId, endUserId: euId } });
    expect(row.currentPeriodEnd?.toISOString()).toBe(far);
  });

  // ------------------------------------------------------- authorization

  it('refuses everyone without the deployment credential', async () => {
    await makePlan('pro');
    const euId = await makeEndUser('buyer@example.com');
    const payload = { planSlug: 'pro', endUserId: euId };

    const anonymous = await grant(payload, {} as { authorization: string });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe('ADMIN_AUTH_MISSING');

    const wrongKey = await grant(payload, { authorization: 'Bearer not-the-super-admin-key-at-all' });
    expect(wrongKey.statusCode).toBe(401);
    expect(wrongKey.json().error.code).toBe('ADMIN_AUTH_INVALID');

    // The operator who OWNS this workspace still cannot grant. Their session
    // token is the credential the panel holds, and it opens every other write
    // on this Application — plans, coupons, credentials, cancelling a
    // subscription. Not this one.
    const owner = await grant(payload, auth());
    expect(owner.statusCode).toBe(401);

    // Nothing was written by any of the three.
    expect(await prisma.subscription.count({ where: { applicationId: appId } })).toBe(0);
    await settle();
    expect(await prisma.webhookDelivery.count({ where: { endpointId } })).toBe(0);
  });

  it('writes the grant to the security-event trail, visible to the workspace', async () => {
    await makePlan('pro');
    const euId = await makeEndUser('buyer@example.com');
    await grant({ planSlug: 'pro', endUserId: euId, note: 'invoice INV-2026-0031' });

    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    // Best-effort writer (`void recordSecurityEvent`) — poll rather than assume.
    let events: Array<{ metadata: unknown; tenantId: string | null }> = [];
    for (let i = 0; i < 40 && events.length === 0; i += 1) {
      events = await prisma.securityEvent.findMany({
        where: { applicationId: appId, type: 'app.subscription_granted' },
      });
      if (events.length === 0) await new Promise((r) => setTimeout(r, 25));
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.tenantId).toBe(application.tenantId);
    expect(events[0]!.metadata).toMatchObject({ planSlug: 'pro', endUserId: euId, note: 'invoice INV-2026-0031' });

    // A no-op grant adds nothing — a trail that logs non-events gets skimmed.
    await grant({ planSlug: 'pro', endUserId: euId });
    await settle();
    expect(
      await prisma.securityEvent.count({ where: { applicationId: appId, type: 'app.subscription_granted' } }),
    ).toBe(1);
  });

  // -------------------------------------------------------------- period

  it('honours an explicit period end and refuses one in the past', async () => {
    await makePlan('annual', { interval: 'YEAR' });
    const euId = await makeEndUser('buyer@example.com');

    const past = await grant({
      planSlug: 'annual',
      endUserId: euId,
      currentPeriodEnd: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.statusCode).toBe(400);
    expect(past.json().error.code).toBe('SUBSCRIPTION_PERIOD_END_IN_PAST');

    const agreed = new Date(Date.now() + 400 * 86_400_000).toISOString();
    const ok = await grant({ planSlug: 'annual', endUserId: euId, currentPeriodEnd: agreed });
    expect(ok.statusCode).toBe(201);
    expect((ok.json().data as { subscription: { currentPeriodEnd: string } }).subscription.currentPeriodEnd).toBe(
      agreed,
    );
  });

  it('gives a one-off purchase no period at all', async () => {
    await makePlan('credits-1k', { kind: 'CREDIT', creditsAmount: 1000, interval: undefined });
    const euId = await makeEndUser('buyer@example.com');

    const res = await grant({ planSlug: 'credits-1k', endUserId: euId });
    expect(res.statusCode).toBe(201);
    expect(
      (res.json().data as { subscription: { currentPeriodEnd: string | null } }).subscription.currentPeriodEnd,
    ).toBeNull();
    expect(await creditsService.getBalance(appId, { endUserId: euId })).toBe(1000);
  });

  // ---------------------------------------------------------- revocation

  it('the existing cancel path ends a granted subscription at period end', async () => {
    await makePlan('pro');
    await putEntitlement('pro', { kind: 'CREDIT', quantity: 500 });
    const euId = await makeEndUser('buyer@example.com');
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    await grant({ planSlug: 'pro', endUserId: euId, currentPeriodEnd: soon });

    const sub = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId, endUserId: euId } });
    const { billingService } = await import('../src/modules/billing/billing.service.js');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: euId } });

    // No provider means no provider call — and, since #336, still a scheduled
    // cancellation rather than an immediate one that keeps the money.
    const canceled = await billingService.cancelCurrentSubscription(application, endUser);
    expect(canceled.status).toBe('ACTIVE');
    expect(canceled.cancelAt?.toISOString()).toBe(soon);

    // …and when the date passes, the local expiry reaps it (no webhook is coming).
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAt: new Date(Date.now() - 1000), currentPeriodEnd: new Date(Date.now() - 1000) },
    });
    const reaped = await billingService.getCurrentSubscription(application, endUser);
    expect(reaped?.status).toBe('CANCELED');
    expect(reaped?.canceledAt).not.toBeNull();
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('CANCELED');
    // …and the buyer stops being entitled by it.
    const { entitlementsService } = await import('../src/modules/billing/entitlements.service.js');
    const held = await entitlementsService.resolveForEndUser(appId, euId);
    expect(held.entitlements).toEqual([]);
  });

  // ------------------------------------------- the term actually ending

  it('an explicit term is honoured, and is the only way to get one', async () => {
    await makePlan('pro');
    const euId = await makeEndUser('timeboxed@example.com');
    const ends = new Date(Date.now() + 14 * 86_400_000).toISOString();

    const withTerm = await grant({ planSlug: 'pro', endUserId: euId, currentPeriodEnd: ends });
    expect(
      (withTerm.json().data as { subscription: { currentPeriodEnd: string } }).subscription
        .currentPeriodEnd,
    ).toBe(ends);

    const other = await makeEndUser('openended@example.com');
    const without = await grant({ planSlug: 'pro', endUserId: other });
    expect(
      (without.json().data as { subscription: { currentPeriodEnd: string | null } }).subscription
        .currentPeriodEnd,
    ).toBeNull();
  });

  it('a granted term that has elapsed stops entitling — a 14-day grant is not forever', async () => {
    // The defect this covers: resolution read `status` alone, and nothing ever
    // moved an elapsed grant off ACTIVE. "Grant them fourteen days" therefore
    // bought permanent access, with a `currentPeriodEnd` in the past as the
    // only trace and nothing reading it.
    await makePlan('pro');
    await putEntitlement('pro', { kind: 'FEATURE', key: 'reports', valueType: 'BOOL', value: 'true' });
    const euId = await makeEndUser('trialist@example.com');

    const res = await grant({ planSlug: 'pro', endUserId: euId });
    const subId = (res.json().data as { subscription: { id: string } }).subscription.id;

    const { entitlementsService } = await import('../src/modules/billing/entitlements.service.js');
    expect((await entitlementsService.resolveForEndUser(appId, euId)).entitlements).toHaveLength(1);

    // Fourteen days pass.
    await prisma.subscription.update({
      where: { id: subId },
      data: { currentPeriodEnd: new Date(Date.now() - 1000) },
    });

    expect((await entitlementsService.resolveForEndUser(appId, euId)).entitlements).toEqual([]);
  });

  it('an open-ended grant keeps entitling — no period means comped indefinitely', async () => {
    await makePlan('pro');
    await putEntitlement('pro', { kind: 'FEATURE', key: 'reports', valueType: 'BOOL', value: 'true' });
    const euId = await makeEndUser('comped@example.com');
    const res = await grant({ planSlug: 'pro', endUserId: euId });
    const subId = (res.json().data as { subscription: { id: string } }).subscription.id;

    await prisma.subscription.update({ where: { id: subId }, data: { currentPeriodEnd: null } });

    const { entitlementsService } = await import('../src/modules/billing/entitlements.service.js');
    expect((await entitlementsService.resolveForEndUser(appId, euId)).entitlements).toHaveLength(1);
  });

  it('a provider-backed subscription past its period still entitles — a late renewal webhook must not lock out a payer', async () => {
    // `currentPeriodEnd` means two different things depending on who owns the
    // row. On a grant it is the end. On a provider subscription it is the
    // RENEWAL date, moved forward by a webhook that can arrive late, so
    // expiring on it would cut off someone who has just paid.
    await makePlan('pro');
    await putEntitlement('pro', { kind: 'FEATURE', key: 'reports', valueType: 'BOOL', value: 'true' });
    const euId = await makeEndUser('payer@example.com');
    const res = await grant({ planSlug: 'pro', endUserId: euId });
    const subId = (res.json().data as { subscription: { id: string } }).subscription.id;

    await prisma.subscription.update({
      where: { id: subId },
      data: {
        provider: 'stripe',
        providerSubId: 'sub_live_renewal_pending',
        currentPeriodEnd: new Date(Date.now() - 1000),
      },
    });

    const { entitlementsService } = await import('../src/modules/billing/entitlements.service.js');
    expect((await entitlementsService.resolveForEndUser(appId, euId)).entitlements).toHaveLength(1);
  });

  it('a cancelled grant reads as CANCELED, not EXPIRED — cancellation is the more specific fact', async () => {
    // Both dates are in the past on a cancelled grant, so whichever check runs
    // first wins. Somebody cancelled this one; reporting it as a term that
    // quietly lapsed loses that.
    await makePlan('pro');
    const euId = await makeEndUser('quitter@example.com');
    const res = await grant({ planSlug: 'pro', endUserId: euId });
    const subId = (res.json().data as { subscription: { id: string } }).subscription.id;
    await prisma.subscription.update({
      where: { id: subId },
      data: { cancelAt: new Date(Date.now() - 2000), currentPeriodEnd: new Date(Date.now() - 1000) },
    });

    const { billingService } = await import('../src/modules/billing/billing.service.js');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: euId } });

    expect((await billingService.getCurrentSubscription(application, endUser))?.status).toBe(
      'CANCELED',
    );
  });

  it('an elapsed grant reads as EXPIRED, so the panel does not report access nobody has', async () => {
    await makePlan('pro');
    const euId = await makeEndUser('trialist@example.com');
    const res = await grant({ planSlug: 'pro', endUserId: euId });
    const subId = (res.json().data as { subscription: { id: string } }).subscription.id;

    await prisma.subscription.update({
      where: { id: subId },
      data: { currentPeriodEnd: new Date(Date.now() - 1000) },
    });

    const { billingService } = await import('../src/modules/billing/billing.service.js');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: euId } });
    const seen = await billingService.getCurrentSubscription(application, endUser);

    expect(seen?.status).toBe('EXPIRED');
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subId } })).status).toBe(
      'EXPIRED',
    );
  });

  it('an operator cancelling a granted subscription by id ends it at PERIOD END', async () => {
    // This asserted the opposite, and the comment restated a justification that
    // has since stopped being true: the gate required `providerBacked` because
    // a scheduled provider-less row could sit ACTIVE and entitling if nobody
    // loaded the portal. `stillEntitling` filters `cancelAt` in the entitlement
    // query now, so that cannot happen — and on a deployment where every
    // subscription is granted, the old rule ended every operator cancel
    // immediately, mid-period, with no refund.
    await makePlan('pro');
    const euId = await makeEndUser('buyer@example.com');
    await grant({
      planSlug: 'pro',
      endUserId: euId,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const sub = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId, endUserId: euId } });

    const { billingService } = await import('../src/modules/billing/billing.service.js');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const canceled = await billingService.cancelSubscriptionById(application, sub.id, {
      atPeriodEnd: true,
    });

    // Scheduled, not ended: the buyer keeps the period they paid for, and
    // `stillEntitling` stops honouring the row on the date without anyone
    // having to load a portal.
    expect(canceled.status).toBe('ACTIVE');
    expect(canceled.cancelAt).not.toBeNull();

    // The explicit opt-out still ends it on the spot — that is what an operator
    // cancelling for abuse needs, and it now takes saying so.
    const other = await makeEndUser('abuser@example.com');
    await grant({
      planSlug: 'pro',
      endUserId: other,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const sub2 = await prisma.subscription.findFirstOrThrow({
      where: { applicationId: appId, endUserId: other },
    });
    const killed = await billingService.cancelSubscriptionById(application, sub2.id, {
      atPeriodEnd: false,
    });
    expect(killed.status).toBe('CANCELED');
    expect(killed.canceledAt).not.toBeNull();
  });

  it('an abandoned checkout session cannot later claim the granted subscription', async () => {
    const planId = await makePlan('pro');
    const euId = await makeEndUser('buyer@example.com');
    // The buyer opened checkout, did not pay, and was granted the plan by hand.
    // The provider's session stays completable for about a day.
    await prisma.subscription.create({
      data: {
        applicationId: appId,
        endUserId: euId,
        planId,
        status: 'PENDING',
        provider: 'stripe',
        metadata: { checkoutSessionId: 'cs_abandoned', checkoutSessionIds: ['cs_abandoned'] },
      },
    });
    expect((await grant({ planSlug: 'pro', endUserId: euId })).statusCode).toBe(201);

    // The session pointers are what a provider webhook matches the local row
    // on. Left in place, going back to the old tab and paying would stamp a
    // `providerSubId` onto a subscription no provider owns — and a row that
    // claims a provider is never reaped by the local expiry.
    const { checkoutSessionWhere } = await import('../src/modules/billing/checkout-sessions.js');
    expect(await prisma.subscription.count({ where: checkoutSessionWhere(appId, 'cs_abandoned') })).toBe(0);
    const row = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId, endUserId: euId } });
    expect(row.provider).toBeNull();
    // Retired, not erased — "why did that session match nothing" stays answerable.
    expect((row.metadata as { grant: { retiredCheckoutSessions: string[] } }).grant.retiredCheckoutSessions).toEqual([
      'cs_abandoned',
    ]);
  });

  it('re-grants after a cancellation, with a fresh period and a fresh announcement', async () => {
    await makePlan('pro');
    await putEntitlement('pro', { kind: 'CREDIT', quantity: 500 });
    const euId = await makeEndUser('buyer@example.com');

    await grant({ planSlug: 'pro', endUserId: euId, currentPeriodEnd: new Date(Date.now() + 86_400_000).toISOString() });
    await waitForDeliveries(endpointId, 'subscription.activated', 1);
    const sub = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId, endUserId: euId } });
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'CANCELED', canceledAt: new Date(), cancelAt: new Date() },
    });

    // A customer who cancelled and has now paid again must be servable. This is
    // the one place a grant diverges from `webhooks/apply.ts`, which refuses to
    // reopen a terminal row — that refusal is against STALE PROVIDER NEWS, and
    // an operator calling this endpoint is not stale news.
    const next = new Date(Date.now() + 40 * 86_400_000).toISOString();
    const again = await grant({ planSlug: 'pro', endUserId: euId, currentPeriodEnd: next });
    expect(again.statusCode).toBe(201);
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.status).toBe('ACTIVE');
    expect(row.currentPeriodEnd?.toISOString()).toBe(next);
    // Cleared, or `expireIfDue` would reap the new grant on the next read.
    expect(row.cancelAt).toBeNull();
    expect(row.canceledAt).toBeNull();

    const deliveries = await waitForDeliveries(endpointId, 'subscription.activated', 2);
    expect(deliveries).toHaveLength(2);
    // A new period is a new grant anchor, so the credits refill exactly once.
    expect(await creditsService.getBalance(appId, { endUserId: euId })).toBe(1000);
  });

  // ------------------------------------------------------------- refusals

  it('requires exactly one of endUserId and email', async () => {
    await makePlan('pro');
    const euId = await makeEndUser('buyer@example.com');

    const neither = await grant({ planSlug: 'pro' });
    expect(neither.statusCode).toBe(400);
    const both = await grant({ planSlug: 'pro', endUserId: euId, email: 'buyer@example.com' });
    expect(both.statusCode).toBe(400);

    const byEmail = await grant({ planSlug: 'pro', email: 'BUYER@Example.com' });
    expect(byEmail.statusCode).toBe(201);
    expect((byEmail.json().data as { subscription: { endUserId: string } }).subscription.endUserId).toBe(euId);
  });

  it('404s on an unknown plan or an unknown subscriber, writing nothing', async () => {
    await makePlan('pro');
    await makeEndUser('buyer@example.com');

    const noPlan = await grant({ planSlug: 'nope', email: 'buyer@example.com' });
    expect(noPlan.statusCode).toBe(404);
    expect(noPlan.json().error.code).toBe('PLAN_NOT_FOUND');

    const noUser = await grant({ planSlug: 'pro', email: 'stranger@example.com' });
    expect(noUser.statusCode).toBe(404);
    expect(noUser.json().error.code).toBe('END_USER_NOT_FOUND');

    expect(await prisma.subscription.count({ where: { applicationId: appId } })).toBe(0);
  });

  it('grants on a plan withdrawn from the public catalogue', async () => {
    await makePlan('legacy-pro');
    const euId = await makeEndUser('buyer@example.com');
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/plans/legacy-pro`,
      headers: auth(),
      payload: { active: false },
    });

    // Checkout refuses an inactive plan because it is the public self-serve
    // surface. Grandfathering someone onto a plan you no longer sell is a
    // deliberate operator act, and refusing it would mean re-opening the plan
    // to everybody to do it.
    const res = await grant({ planSlug: 'legacy-pro', endUserId: euId });
    expect(res.statusCode).toBe(201);
  });
});
