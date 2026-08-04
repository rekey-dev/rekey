/**
 * A cancelled subscription has to survive the page reload that follows it.
 *
 * `GET /billing/subscription` filters to ACTIVE / PAST_DUE / PENDING, so the
 * moment a subscription reaches CANCELED the endpoint answers `null` — the
 * same `null` it gives somebody who has never subscribed at all. A portal
 * cannot tell those two apart, so it says the only thing it can: "you are on
 * the free plan". A paying customer cancels, reloads, and their plan, their
 * status and the date their access actually ends are all gone from the page.
 *
 * #335 papered over it by keeping the cancel call's own response in component
 * state. That covers the seconds after the click and nothing else; come back
 * the next day and the history is gone again.
 *
 * `?includeEnded=true` is the fix, and its contract is deliberately narrow:
 * **it can only turn a null into a row.** When a live subscription exists it
 * is still the one returned, so no existing caller's entitlement check can be
 * made wrong by passing it, and the flag is safe to add to a call that already
 * decides access. That bound is what the tests below are mostly about.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SubscriptionStatus } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('GET /billing/subscription?includeEnded', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function fixture(slug: string) {
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
        name: 'Standard',
        amount: 9900,
        currency: 'usd',
        interval: 'MONTH',
        active: true,
      },
    });

    // A plan per extra subscription. `(application_id, end_user_id, plan_id)`
    // is unique, so one user cannot hold two rows on the same plan — the first
    // subscription uses the named plan above and every later one gets its own.
    let extraPlans = 0;
    const makeSubscription = async (
      status: SubscriptionStatus,
      currentPeriodEnd: Date | null,
      createdAt?: Date,
    ) => {
      const planId =
        extraPlans === 0
          ? plan.id
          : (
              await prisma.plan.create({
                data: {
                  applicationId,
                  slug: `plan-${slug}-${extraPlans}`,
                  name: `Standard ${extraPlans}`,
                  amount: 9900,
                  currency: 'usd',
                  interval: 'MONTH',
                  active: true,
                },
              })
            ).id;
      extraPlans += 1;
      return prisma.subscription.create({
        data: {
          applicationId,
          endUserId: session.endUser.id,
          planId,
          status,
          currentPeriodEnd,
          ...(createdAt && { createdAt }),
        },
      });
    };

    const read = (query = '') =>
      app
        .inject({
          method: 'GET',
          url: `/api/v1/billing/subscription${query}`,
          headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': session.accessToken },
        })
        .then((r) => r.json().data as { id: string; status: string; cancelAt: string | null } | null);

    return { liveKey, session, plan, makeSubscription, read };
  }

  it('tells a buyer who cancelled last month what they were on and when it ended', async () => {
    // The whole reported defect, end to end: cancel, come back later, and the
    // account page must still be able to say what happened.
    const periodEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const { liveKey, session, plan, makeSubscription, read } = await fixture('sh-history');
    const created = await makeSubscription('ACTIVE', periodEnd);

    // Cancel immediately — the shape that produces a terminal row on the spot.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription/cancel',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': session.accessToken },
      payload: { atPeriodEnd: false },
    });
    expect(res.statusCode).toBeLessThan(300);

    // This is the reload. Today's semantics: nothing at all.
    expect(await read()).toBeNull();

    // With the flag: the subscription, its status and the date it ended.
    const remembered = await read('?includeEnded=true');
    expect(remembered?.id).toBe(created.id);
    expect(remembered?.status).toBe('CANCELED');
    expect(remembered?.cancelAt).not.toBeNull();

    // And it is the same subscription, so the plan is still resolvable — which
    // is what lets the page say "your Standard subscription ended on <date>"
    // rather than "you are on the free plan".
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.planId).toBe(plan.id);
    expect(row.canceledAt).not.toBeNull();
  });

  it('never replaces a live subscription with an old one', async () => {
    // The bound that makes this safe to add to an existing call. Someone who
    // cancelled and resubscribed must get the subscription they are paying
    // for, not the one they left behind.
    const { makeSubscription, read } = await fixture('sh-resub');
    const old = await makeSubscription(
      'CANCELED',
      new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    );
    const live = await makeSubscription('ACTIVE', new Date(Date.now() + 10 * 24 * 60 * 60 * 1000));

    expect((await read('?includeEnded=true'))?.id).toBe(live.id);
    expect((await read())?.id).toBe(live.id);
    // Not vacuous: the ended row exists and is genuinely older.
    expect(old.createdAt.getTime()).toBeLessThan(live.createdAt.getTime());
  });

  it('leaves a PENDING checkout alone — that is a live answer, not history', async () => {
    // PENDING is already in the default filter, so the flag must not reach
    // past it to something terminal. An abandoned checkout still needs the
    // "finish paying" state, not an obituary.
    const { makeSubscription, read } = await fixture('sh-pending');
    await makeSubscription(
      'CANCELED',
      new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    );
    const pending = await makeSubscription('PENDING', null);

    expect((await read('?includeEnded=true'))?.id).toBe(pending.id);
  });

  it('returns the most recent ended subscription, not the first one', async () => {
    const { makeSubscription, read } = await fixture('sh-newest');
    await makeSubscription(
      'EXPIRED',
      new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      new Date(Date.now() - 420 * 24 * 60 * 60 * 1000),
    );
    const recent = await makeSubscription(
      'CANCELED',
      new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      new Date(Date.now() - 35 * 24 * 60 * 60 * 1000),
    );

    expect((await read('?includeEnded=true'))?.id).toBe(recent.id);
  });

  it('still answers null for someone who never subscribed', async () => {
    // The distinction the whole flag exists to draw. If this ever returns a
    // row, the empty state has become a lie in the other direction.
    const { read } = await fixture('sh-never');
    expect(await read('?includeEnded=true')).toBeNull();
  });

  it('is off by default, so existing SDK and portal callers are untouched', async () => {
    const { makeSubscription, read } = await fixture('sh-default');
    await makeSubscription('CANCELED', new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));

    expect(await read()).toBeNull();
    // And explicitly off stays off — a `false` that switched the flag ON would
    // be the classic truthy-string coercion bug.
    expect(await read('?includeEnded=false')).toBeNull();
  });
});
