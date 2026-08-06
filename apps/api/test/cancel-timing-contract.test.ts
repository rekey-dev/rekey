/**
 * The cancellation-timing contract: what `cancelEffect` PREDICTS must be
 * what `POST /billing/subscription/cancel` DOES.
 *
 * ## Why a test instead of a comment
 *
 * A cancel confirmation has to tell the buyer which of two things is about to
 * happen — keep the rest of the period you paid for, or lose it now with no
 * refund — and it has to say so *before* the call, so it cannot read the answer
 * off the response. It has to predict.
 *
 * That prediction was written out a second time, in the marketing app, and it
 * was correct for about seven hours. #335 mirrored the API's predicate of the
 * day (ACTIVE + provider-backed + known period end). #336 then removed the
 * provider requirement, because requiring one meant every hand-provisioned
 * subscription — which is every subscription Rekey Cloud has — was terminated
 * on the spot when its owner asked for period-end. The copy was not updated,
 * so the dialog spent the next stretch warning ordinary subscribers that
 * cancelling would cost them the remainder of a period it would in fact have
 * let them keep. Same defect as the original, pointed the other way.
 *
 * The rule now lives once, in `@rekey.dev/shared-types`, and both the service
 * and the marketing site read it from there. This test is what keeps that
 * honest: it drives a real cancellation through the HTTP surface for each
 * shape a subscription can be in, and asserts the shared predicate called it.
 * Change `cancelCurrentSubscription`'s timing without changing the predicate
 * and this goes red — which is exactly what should have happened to #336.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SubscriptionStatus } from '@prisma/client';
import { cancelEffect } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('cancellation timing: the predicate and the server agree', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** An app + end-user + one subscription in whatever shape a case needs. */
  async function fixture(
    slug: string,
    sub: {
      status: SubscriptionStatus;
      currentPeriodEnd: Date | null;
      provider?: string;
      providerSubId?: string;
    },
  ) {
    const tenantToken = await app
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
        payload: {
          name: 'k',
          mode: 'live',
          scopes: ['auth:write', 'billing:read', 'billing:write'],
        },
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

    const plan = await prisma.plan.create({
      data: {
        applicationId,
        slug: `plan-${slug}`,
        name: 'Paid',
        amount: 9900,
        currency: 'usd',
        interval: 'MONTH',
        active: true,
      },
    });

    const subscription = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: session.endUser.id,
        planId: plan.id,
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd,
        ...(sub.provider && { provider: sub.provider }),
        ...(sub.providerSubId && { providerSubId: sub.providerSubId }),
      },
    });

    return { liveKey, accessToken: session.accessToken, subscription };
  }

  /**
   * Ask for period-end (the default, and the only thing the marketing site
   * ever asks for) and report both answers: what the shared predicate said
   * would happen, and what the row shows actually happened.
   */
  async function cancelAndCompare(
    slug: string,
    sub: {
      status: SubscriptionStatus;
      currentPeriodEnd: Date | null;
      provider?: string;
      providerSubId?: string;
    },
  ): Promise<{ predicted: boolean; scheduled: boolean; row: { status: string } }> {
    const { liveKey, accessToken, subscription } = await fixture(slug, sub);

    const predicted = cancelEffect(subscription) === 'period-end';

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': accessToken },
      payload: { atPeriodEnd: true },
    });
    expect(res.statusCode).toBeLessThan(300);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    // "Scheduled" means the buyer kept what they paid for: the row is still
    // live, with an end date recorded and no termination stamped on it.
    const scheduled = row.status === 'ACTIVE' && row.cancelAt !== null && row.canceledAt === null;
    return { predicted, scheduled, row };
  }

  const inTwentyDays = () => new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);

  it('provider-backed, ACTIVE, with a period end → scheduled, and the copy says so', async () => {
    const { predicted, scheduled, row } = await cancelAndCompare('ctc-prov', {
      status: 'ACTIVE',
      currentPeriodEnd: inTwentyDays(),
      provider: 'stripe',
      providerSubId: 'sub_external_1',
    });
    expect(predicted).toBe(true);
    expect(scheduled).toBe(true);
    // Still ACTIVE: the provider's webhook is what ends it on the day.
    expect(row.status).toBe('ACTIVE');
  });

  it('hand-provisioned, ACTIVE, with a period end → ALSO scheduled', async () => {
    // The case the marketing copy got wrong. Every Rekey Cloud subscription
    // has this shape — checkout is closed, so they are all provisioned by hand
    // and none carries a provider record. The old predicate answered "this
    // ends immediately, with no refund"; the API had already stopped doing
    // that, and the warning cost buyers nothing but nerve.
    const { predicted, scheduled } = await cancelAndCompare('ctc-hand', {
      status: 'ACTIVE',
      currentPeriodEnd: inTwentyDays(),
    });
    expect(predicted).toBe(true);
    expect(scheduled).toBe(true);
  });

  it('ACTIVE with no known period end → immediate, and the copy warns', async () => {
    const { predicted, scheduled, row } = await cancelAndCompare('ctc-noend', {
      status: 'ACTIVE',
      currentPeriodEnd: null,
    });
    expect(predicted).toBe(false);
    expect(scheduled).toBe(false);
    expect(row.status).toBe('CANCELED');
  });

  it('PAST_DUE → immediate, entitled though it is', async () => {
    // The sharp one. PAST_DUE counts as entitled everywhere else — the buyer
    // still has their plan while dunning runs — so a confirmation that keys
    // off entitlement alone would promise them a period end they do not get.
    const { predicted, scheduled, row } = await cancelAndCompare('ctc-pastdue', {
      status: 'PAST_DUE',
      currentPeriodEnd: inTwentyDays(),
    });
    expect(predicted).toBe(false);
    expect(scheduled).toBe(false);
    expect(row.status).toBe('CANCELED');
  });

  it('an abandoned PENDING checkout → immediate', async () => {
    const { predicted, scheduled, row } = await cancelAndCompare('ctc-pending', {
      status: 'PENDING',
      currentPeriodEnd: inTwentyDays(),
    });
    expect(predicted).toBe(false);
    expect(scheduled).toBe(false);
    expect(row.status).toBe('CANCELED');
  });
});
