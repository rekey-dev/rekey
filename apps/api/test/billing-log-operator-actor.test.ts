/**
 * What an operator does from the panel names that operator in the billing
 * log: a subscription grant, a cancellation and a credit grant, each read
 * back through the log's own route.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';

interface Entry {
  type: string;
  actor: { type: string; id: string | null };
  endUserId: string | null;
  subscriptionId: string | null;
  data: Record<string, unknown>;
}

describe('operator actions carry their operator in the billing log', () => {
  let app: FastifyInstance;
  let w: OperatorWorld;
  let operatorId: string;
  let endUserId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    w = await operatorWorld(app, 'APP_ADMIN');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
    operatorId = (await prisma.tenantUser.findFirstOrThrow({ where: { email: `owner-${application.slug}@example.com` } })).id;
    const plan = await post('/plans', { slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 1900 }, interval: 'MONTH' });
    expect(plan.statusCode, plan.body).toBe(201);
    endUserId = (await prisma.endUser.create({ data: { applicationId: w.appId, email: 'granted@example.com' } })).id;
  });

  const post = (path: string, payload: Record<string, unknown>) =>
    w.inject({ method: 'POST', url: `/api/v1/tenant/applications/${w.appId}${path}`, headers: bearer(w.ownerToken), payload });

  async function logged(type: string): Promise<Entry[]> {
    const res = await w.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}/billing/events?type=${type}`,
      headers: bearer(w.ownerToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data as { items: Entry[] }).items;
  }

  async function grant(): Promise<string> {
    const res = await post(`/end-users/${endUserId}/subscriptions`, { planSlug: 'pro' });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return (await prisma.subscription.findFirstOrThrow({ where: { applicationId: w.appId, endUserId } })).id;
  }

  it('a grant: subscription.granted and the price it took name the operator', async () => {
    const subscriptionId = await grant();
    const [granted] = await logged('subscription.granted');
    expect(granted).toMatchObject({ actor: { type: 'operator', id: operatorId }, endUserId, subscriptionId });
    const [priced] = await logged('subscription.priced');
    expect(priced).toMatchObject({ actor: { type: 'operator', id: operatorId }, subscriptionId });
  });

  it.each([{ atPeriodEnd: true }, { atPeriodEnd: false }])('a cancellation ($atPeriodEnd at period end) names the operator', async (body) => {
    const subscriptionId = await grant();
    const res = await post(`/end-users/${endUserId}/subscriptions/${subscriptionId}/cancel`, body);
    expect(res.statusCode, res.body).toBe(200);
    const canceled = await logged('subscription.canceled');
    expect(canceled).toHaveLength(1);
    expect(canceled[0]).toMatchObject({ actor: { type: 'operator', id: operatorId }, subscriptionId, data: { cause: 'operator' } });
  });

  it('a credit grant writes credits.granted naming the operator, and taking credits away writes none', async () => {
    const added = await post(`/end-users/${endUserId}/credits/grant`, { amount: 50, reason: 'GRANT' });
    expect(added.statusCode, added.body).toBe(201);
    const removed = await post(`/end-users/${endUserId}/credits/grant`, { amount: -20, reason: 'ADJUST' });
    expect(removed.statusCode, removed.body).toBe(201);

    const granted = await logged('credits.granted');
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({
      actor: { type: 'operator', id: operatorId },
      endUserId,
      data: { credits: 50, source: 'operator', balanceAfter: 50 },
    });
  });
});
