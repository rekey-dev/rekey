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
      subscription: { id: string; status: string; provider: string | null; currentPeriodEnd: string };
    };
    expect(body.activated).toBe(true);
    expect(body.subscription.status).toBe('ACTIVE');
    // Provider-less is the defining property — it is what makes the local
    // cancel + expiry paths, rather than a webhook nobody will send, the thing
    // that ends this subscription.
    expect(body.subscription.provider).toBeNull();

    // Default period: one plan interval (MONTH) from now, not 30 days.
    const end = new Date(body.subscription.currentPeriodEnd).getTime();
    expect(end).toBeGreaterThan(before + 27 * 86_400_000);
    expect(end).toBeLessThan(before + 32 * 86_400_000);

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
    expect(s.currentPeriodEnd).not.toBeNull();
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

  it('an operator cancelling a granted subscription by id ends it immediately, not at period end', async () => {
    await makePlan('pro');
    const euId = await makeEndUser('buyer@example.com');
    await grant({
      planSlug: 'pro',
      endUserId: euId,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const sub = await prisma.subscription.findFirstOrThrow({ where: { applicationId: appId, endUserId: euId } });

    // Pinning documented behaviour, not asking for it to change.
    // `cancelSubscriptionById` (the operator MCP path) still requires a
    // provider to SCHEDULE a cancellation, because only `getCurrentSubscription`
    // runs the local expiry and an operator has no guarantee the buyer's portal
    // will ever be loaded to trigger it. So a provider-less row cancels on the
    // spot instead of sitting ACTIVE and entitling forever. Failing closed is
    // the right side to err on, and the difference is worth being explicit
    // about now that every hand-granted subscription is in this class.
    const { billingService } = await import('../src/modules/billing/billing.service.js');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const canceled = await billingService.cancelSubscriptionById(application, sub.id, { atPeriodEnd: true });
    expect(canceled.status).toBe('CANCELED');
    expect(canceled.canceledAt).not.toBeNull();
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
