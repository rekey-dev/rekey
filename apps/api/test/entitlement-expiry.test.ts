/**
 * A scheduled cancellation has to stop granting entitlements on the day, even
 * if nobody opens the portal.
 *
 * #336 made "cancel at period end" work for subscriptions with no payment
 * provider — the row stays ACTIVE with `cancelAt` set, and `expireIfDue`
 * terminates it lazily when someone reads it through
 * `billingService.getCurrentSubscription`.
 *
 * The gap: **entitlement resolution
 * never goes through that read.** `entitlements.service.ts` queries the
 * subscription table directly, so it saw a row that was still nominally
 * ACTIVE and kept granting features, credits and usage allowance past the
 * date the buyer had cancelled — until some unrelated portal load happened to
 * flip it. Rekey Cloud's subscriptions are all provider-less, so this was all
 * of them.
 *
 * Fixed with a filter (`stillEntitling`) rather than another write: a read
 * path that must mutate before it can answer is both a race and a hot-path
 * write, and a filter covers every future caller that does not know the lazy
 * expiry exists.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('a lapsed scheduled cancellation stops entitling', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Application + end-user + an ACTIVE subscription whose plan grants a feature. */
  async function fixture(slug: string, opts: { providerBacked: boolean }) {
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
        payload: { name: 'k', mode: 'live', scopes: ['auth:write', 'billing:read'] },
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
        entitlements: {
          // The enum is BOOL, not BOOLEAN, and there is no `valueBool` column:
          // the value is stored as text with `valueType` naming how to read it.
          create: [
            { kind: 'FEATURE', key: 'pro_reports', valueType: 'BOOL', value: 'true' },
          ],
        },
      },
    });

    const subscription = await prisma.subscription.create({
      data: {
        applicationId,
        endUserId: session.endUser.id,
        planId: plan.id,
        status: 'ACTIVE',
        currentPeriodEnd: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        ...(opts.providerBacked
          ? { provider: 'stripe', providerSubId: `sub_${slug}` }
          : {}),
      },
    });

    return { liveKey, session, subscription };
  }

  const features = (liveKey: string, accessToken: string) =>
    app
      .inject({
        method: 'GET',
        url: '/api/v1/billing/entitlements',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': accessToken },
      })
      .then((r) => (r.json().data as { features: Record<string, unknown> }).features);

  it('grants the feature while the scheduled date is still in the future', async () => {
    const { liveKey, session, subscription } = await fixture('ent-future', {
      providerBacked: false,
    });
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000) },
    });

    // Cancelled, but not yet lapsed — they paid for this time.
    expect(await features(liveKey, session.accessToken)).toHaveProperty('pro_reports', true);
  });

  it('stops granting it once the date has passed, without anyone opening the portal', async () => {
    const { liveKey, session, subscription } = await fixture('ent-lapsed', {
      providerBacked: false,
    });
    // Scheduled and lapsed. Crucially, nothing reads the subscription through
    // `getCurrentSubscription` in between, so the lazy expiry has not run and
    // the row is still ACTIVE in the table.
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAt: new Date(Date.now() - 60_000) },
    });
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(row.status).toBe('ACTIVE'); // the precondition this test exists for

    expect(await features(liveKey, session.accessToken)).not.toHaveProperty('pro_reports');
  });

  it('stops granting for a provider-backed row too, once its date has passed', async () => {
    // This asserted the opposite until the PayPal cancellation work. The
    // asymmetry was deliberate — a provider-backed subscription is terminated
    // by the provider's webhook, and cutting access off here would pre-empt the
    // authority on whether the money actually stopped.
    //
    // It assumed a provider that can schedule a cancellation and will announce
    // it on the day. PayPal does neither: its only cancel is immediate, so a
    // period-end request cancels the agreement now and the paid period is held
    // open locally (`applySubscriptionStatusMirror` refuses to let PayPal's own
    // CANCELLED event shorten it). No later event exists to terminate the row,
    // so the carve-out kept granting a cancelled subscription's entitlements
    // indefinitely — this file's own defect, one provider over.
    //
    // Safe because `cancelAt` on a provider-backed row is only written after
    // the provider confirmed the cancellation, or mirrored from the provider's
    // own schedule. In the past means it has already stopped.
    const { liveKey, session, subscription } = await fixture('ent-prov', {
      providerBacked: true,
    });
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAt: new Date(Date.now() - 60_000) },
    });

    expect(await features(liveKey, session.accessToken)).not.toHaveProperty('pro_reports');
  });

  it('keeps granting a provider-backed row while its date is still ahead', async () => {
    // The other half, and the one that makes period-end cancellation worth
    // having: the buyer asked to cancel and keeps everything until the day.
    const { liveKey, session, subscription } = await fixture('ent-prov-future', {
      providerBacked: true,
    });
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000) },
    });

    expect(await features(liveKey, session.accessToken)).toHaveProperty('pro_reports', true);
  });
});
