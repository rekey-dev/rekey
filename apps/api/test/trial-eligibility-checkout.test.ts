/**
 * The trial limit as reached through POST /billing/checkout (#477).
 *
 * `trial-eligibility.test.ts` pins the rules against the service. This pins
 * that they are actually WIRED IN: the refusal, the acknowledgement that gets
 * past it, and the reservation being taken before the provider call rather
 * than after the money moves.
 *
 * `trialDays` is written straight onto the plan row rather than through the
 * create route, so the fixture covers rows written before the write path
 * existed as well as rows written through it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';

const PASSWORD = 'pw-one-two-three';
/** Matches what `configureSandboxStripe` stores. */
const WEBHOOK_SECRET = 'whsec_ci_only';

const stripe = new Stripe('sk_for_signing_only', {
  apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
});

describe('trial eligibility through checkout', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;
  let userAccess: string;
  let operatorAccess: string;
  let appSlug: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const slug = `trialco-${Math.random().toString(36).slice(2, 8)}`;
    appSlug = slug;
    operatorAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await configureSandboxStripe(applicationId);

    for (const plan of [
      { slug: 'basic', name: 'Basic', amount: 900 },
      { slug: 'pro', name: 'Pro', amount: 9900 },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/plans`,
        headers: { authorization: `Bearer ${operatorAccess}` },
        payload: plan,
      });
      expect(res.statusCode).toBe(201);
    }
    // See the module docblock: the write path refuses this, so it goes on the
    // row directly, which is how the exposed population got theirs.
    await prisma.plan.updateMany({ where: { applicationId }, data: { trialDays: 14 } });

    userAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${slug}@example.com`, password: PASSWORD },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
  });

  function checkout(payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
      payload: {
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
        provider: 'stripe',
        ...payload,
      },
    });
  }

  const setPolicy = (trialPolicy: string) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/billing-config`,
      headers: { authorization: `Bearer ${operatorAccess}` },
      payload: { trialPolicy },
    });

  it('the first checkout reserves a slot; a second on another plan is refused', async () => {
    const first = await checkout({ planSlug: 'basic' });
    expect(first.statusCode).toBe(200);

    // Reserved BEFORE the provider call and bound to the session it minted, so
    // the slot is held for as long as that session stays payable.
    const reserved = await prisma.trialRedemption.findMany({ where: { applicationId } });
    expect(reserved).toHaveLength(1);
    expect(reserved[0]!.status).toBe('RESERVED');
    expect(reserved[0]!.checkoutSessionId).not.toBeNull();
    expect(reserved[0]!.trialDays).toBe(14);

    const second = await checkout({ planSlug: 'pro' });
    expect(second.statusCode).toBe(409);
    const body = second.json() as { error: { code: string; message: string; fix: string } };
    expect(body.error.code).toBe('BILLING_TRIAL_ALREADY_USED');
    // The refusal has to name what the buyer WILL be charged, and the plan they
    // already trialled, or the operator has to go and work both out.
    expect(body.error.message).toContain('$99.00');
    expect(body.error.message).toContain('basic');
    // And the way through, including the Idempotency-Key clause without which
    // the caller retries into IDEMPOTENCY_KEY_REUSED and cannot escape.
    expect(body.error.fix).toContain('allowWithoutTrial');
    expect(body.error.fix).toContain('Idempotency-Key');
  });

  it('allowWithoutTrial buys at full price and takes no slot', async () => {
    expect((await checkout({ planSlug: 'basic' })).statusCode).toBe(200);
    const before = await prisma.trialRedemption.count({ where: { applicationId } });

    const acknowledged = await checkout({ planSlug: 'pro', allowWithoutTrial: true });
    expect(acknowledged.statusCode).toBe(200);

    // No second row: this buyer already spent their slot, and buying at full
    // price does not spend another.
    expect(await prisma.trialRedemption.count({ where: { applicationId } })).toBe(before);
  });

  it('once_per_plan lets a different plan through', async () => {
    expect((await setPolicy('once_per_plan')).statusCode).toBe(200);
    expect((await checkout({ planSlug: 'basic' })).statusCode).toBe(200);
    expect((await checkout({ planSlug: 'pro' })).statusCode).toBe(200);
  });

  it('unlimited never refuses, and still records what was taken', async () => {
    expect((await setPolicy('unlimited')).statusCode).toBe(200);
    expect((await checkout({ planSlug: 'basic' })).statusCode).toBe(200);
    expect((await checkout({ planSlug: 'pro' })).statusCode).toBe(200);

    // Recorded, not skipped. The ledger is what the operator's trial reporting
    // reads, and it is what makes a later flip to `once_per_application`
    // meaningful, a policy that starts from no history hands every existing
    // buyer a fresh trial on the day it is switched on.
    const rows = await prisma.trialRedemption.findMany({ where: { applicationId } });
    expect(rows).toHaveLength(2);
    // Only the newest holds a slot; the takeover released the other. So the
    // flip is to a correct state rather than to two live holders.
    expect(rows.filter((r) => r.status === 'RESERVED')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'RELEASED')).toHaveLength(1);
  });

  it('a plan with no trial is untouched by any of this', async () => {
    await prisma.plan.updateMany({ where: { applicationId }, data: { trialDays: null } });
    expect((await checkout({ planSlug: 'basic' })).statusCode).toBe(200);
    expect((await checkout({ planSlug: 'pro' })).statusCode).toBe(200);
    expect(await prisma.trialRedemption.count({ where: { applicationId } })).toBe(0);
  });
  it('a day-0 trialist is stored TRIALING with a trial end, not ACTIVE', async () => {
    // `applyCheckoutCompleted` hard-wrote ACTIVE and never wrote `trialEndsAt`.
    // Stripe's `customer.subscription.created` is not in the translate switch
    // and, for a plain trial, no `customer.subscription.updated` arrives until
    // conversion, so the row read ACTIVE for the whole trial and
    // `computeMrrCents`, which sums `plan.amount` over `status: 'ACTIVE'`,
    // booked a 30-day trial on a $99 plan as $99 of MRR on day 0 against zero
    // cash (#478).
    const res = await checkout({ planSlug: 'pro' });
    expect(res.statusCode).toBe(200);
    const sessionId = (res.json().data as { subscription: { metadata: { checkoutSessionId: string } } })
      .subscription.metadata.checkoutSessionId;

    const payload = JSON.stringify({
      id: `evt_${randomUUID()}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { applicationId },
          id: sessionId,
          mode: 'subscription',
          subscription: 'sub_trialist_1',
        },
      },
    });
    const hook = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/webhook/stripe/${appSlug}`,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
      },
      payload,
    });
    expect(hook.statusCode).toBe(200);

    const sub = await prisma.subscription.findFirstOrThrow({ where: { applicationId } });
    expect(sub.status).toBe('TRIALING');
    // The clock the buyer was actually sold, from the days sent to the provider.
    expect(sub.trialEndsAt).not.toBeNull();
    const days = Math.round((sub.trialEndsAt!.getTime() - Date.now()) / 86_400_000);
    expect(days).toBe(14);

    // THE consequence: MRR sums plan.amount over ACTIVE, and this is not ACTIVE.
    expect(await prisma.subscription.count({ where: { applicationId, status: 'ACTIVE' } })).toBe(0);

    // Still entitling, so what the buyer can DO is unchanged, only the
    // revenue reporting is.
    const ent = await entitlementsService.resolveForEndUser(applicationId, sub.endUserId);
    expect(ent).toBeDefined();
  });

  it('a checkout with NO trial is still stored ACTIVE', async () => {
    await prisma.plan.updateMany({ where: { applicationId }, data: { trialDays: null } });
    const res = await checkout({ planSlug: 'pro' });
    const sessionId = (res.json().data as { subscription: { metadata: { checkoutSessionId: string } } })
      .subscription.metadata.checkoutSessionId;

    const payload = JSON.stringify({
      id: `evt_${randomUUID()}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: { metadata: { applicationId }, id: sessionId, mode: 'subscription', subscription: 'sub_paid_1' },
      },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/billing/webhook/stripe/${appSlug}`,
          headers: {
            'content-type': 'application/json',
            'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
          },
          payload,
        })
      ).statusCode,
    ).toBe(200);

    const sub = await prisma.subscription.findFirstOrThrow({ where: { applicationId } });
    expect(sub.status).toBe('ACTIVE');
    expect(sub.trialEndsAt).toBeNull();
  });
  it('bailing at the provider and coming back does NOT refuse the buyer', async () => {
    // The inversion this feature was built to prevent, walked end to end rather
    // than asserted on one side of the seam.
    //
    // `checkTrialEligibility` counted the buyer's OWN live RESERVED row as a
    // blocker, and the take-over in `reserveTrial` only runs down the eligible
    // branch, so it never ran. A buyer who opened a trial checkout and bailed
    // at Stripe was refused with BILLING_TRIAL_ALREADY_USED, naming a trial
    // they never received, for the 24 hours until the reservation expired.
    const first = await checkout({ planSlug: 'pro' });
    expect(first.statusCode).toBe(200);
    const reserved = await prisma.trialRedemption.findMany({ where: { applicationId } });
    expect(reserved).toHaveLength(1);
    expect(reserved[0]!.status).toBe('RESERVED');

    // They never pay. They come back to the same plan.
    const again = await checkout({ planSlug: 'pro' });
    expect(again.statusCode).toBe(200);

    // The advisory read has to agree with what checkout just did, or a pricing
    // page shows "Subscribe" for a buyer checkout would have given a trial.
    const elig = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/trial-eligibility?planSlug=pro',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userAccess },
    });
    expect(elig.statusCode).toBe(200);
    const item = (elig.json().data as { items: Array<{ eligible: boolean; reason: string | null }> }).items[0]!;
    expect(item.eligible).toBe(true);
    expect(item.reason).toBeNull();

    // Still exactly one slot held: the older row was taken over, not duplicated.
    const after = await prisma.trialRedemption.findMany({ where: { applicationId } });
    expect(after.filter((r) => r.status === 'RESERVED')).toHaveLength(1);
    expect(after.filter((r) => r.status === 'RELEASED')).toHaveLength(1);
  });

  it('a live reservation still blocks a DIFFERENT plan under once_per_application', async () => {
    // The other half. Dropping the reservation from the blocking set entirely
    // would let a buyer open a checkout on every plan, pay them all, and
    // collect a trial on each, `consumeTrial` matches RELEASED rows too.
    expect((await checkout({ planSlug: 'basic' })).statusCode).toBe(200);
    const second = await checkout({ planSlug: 'pro' });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe('BILLING_TRIAL_ALREADY_USED');
  });
});
