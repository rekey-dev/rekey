/**
 * `credit.granted`, `credit.consumed` and `credit.adjusted` outbound webhooks.
 *
 * One event per ledger entry, enqueued inside the transaction that writes the
 * entry. So: exactly one delivery per grant and per consume, none for a
 * refused consume or an idempotent replay, and none when the transaction that
 * wrote the entry rolls back.
 *
 * Delivery ROWS are what is asserted. The endpoint URL is unreachable on
 * purpose; whether the HTTP attempt succeeds is webhooks.test.ts's business.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CreditWebhookData, WebhookEventEnvelope } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { creditsService } from '../src/modules/credits/credits.service.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';

describe('Credit webhooks', () => {
  let app: FastifyInstance;
  let operator: string;
  let appId: string;
  let secretKey: string;
  let endUserId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const op = (): { authorization: string } => ({ authorization: `Bearer ${operator}` });
  const sk = (): { authorization: string } => ({ authorization: `Bearer ${secretKey}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `ce-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: op(),
        payload: { name: 'CE', slug: `ce-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: op(),
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    endUserId = (
      await prisma.endUser.create({ data: { applicationId: appId, email: `ce-eu-${slug}@example.com` } })
    ).id;
    await webhookService.createEndpoint({
      applicationId: appId,
      url: 'https://example.invalid/credit-hook',
      events: ['credit.granted', 'credit.consumed', 'credit.adjusted'],
    });
  });

  async function creditDeliveries(): Promise<Array<{ eventType: string; payload: WebhookEventEnvelope<CreditWebhookData> }>> {
    const rows = await prisma.webhookDelivery.findMany({
      where: { applicationId: appId, eventType: { startsWith: 'credit.' } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      eventType: r.eventType,
      payload: r.payload as unknown as WebhookEventEnvelope<CreditWebhookData>,
    }));
  }

  const consume = (amount: number, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/credits/consume',
      headers: sk(),
      payload: { endUserId, amount, ...extra },
    });

  it('an operator grant emits credit.granted once, with the entry and the balance after it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users/${endUserId}/credits/grant`,
      headers: op(),
      payload: { amount: 100, idempotencyKey: 'promo-1', description: 'Welcome pack' },
    });
    expect(res.statusCode).toBe(201);
    const entryId = (res.json().data as { entryId: string }).entryId;

    const rows = await creditDeliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe('credit.granted');
    expect(rows[0]!.payload.type).toBe('credit.granted');
    expect(rows[0]!.payload.applicationId).toBe(appId);
    expect(rows[0]!.payload.data.credit).toEqual({
      entryId,
      endUserId,
      organizationId: null,
      delta: 100,
      amount: 100,
      reason: 'GRANT',
      balance: 100,
      idempotencyKey: 'promo-1',
      description: 'Welcome pack',
      createdAt: expect.any(String) as unknown as string,
    });
  });

  it('a consume emits credit.consumed once; a refused consume and a replay emit nothing', async () => {
    await creditsService.grant({ applicationId: appId, endUserId, amount: 10, reason: 'GRANT' });

    expect((await consume(4, { idempotencyKey: 'lead-1' })).statusCode).toBe(200);
    expect((await consume(4, { idempotencyKey: 'lead-1' })).statusCode).toBe(200); // replay
    const refused = await consume(50);
    expect(refused.statusCode).toBe(402);

    const rows = await creditDeliveries();
    expect(rows.map((r) => r.eventType)).toEqual(['credit.granted', 'credit.consumed']);
    expect(rows[1]!.payload.data.credit).toMatchObject({
      endUserId,
      delta: -4,
      amount: 4,
      reason: 'CONSUME',
      balance: 6,
      idempotencyKey: 'lead-1',
    });
  });

  it('a grant through the Application key emits credit.granted for an organization pool', async () => {
    const org = await prisma.organization.create({
      data: { applicationId: appId, name: 'Team', slug: `team-${Math.random().toString(36).slice(2, 6)}` },
    });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: op(),
        payload: { name: 'granter', mode: 'live', scopes: ['credits:grant'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    const body = { organizationId: org.id, amount: 30, idempotencyKey: 'pool-1' };
    const post = () =>
      app.inject({ method: 'POST', url: '/api/v1/credits/grant', headers: { authorization: `Bearer ${key}` }, payload: body });
    expect((await post()).statusCode).toBe(201);
    expect((await post()).statusCode).toBe(201); // replay, no second entry

    const rows = await creditDeliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.data.credit).toMatchObject({ endUserId: null, organizationId: org.id, delta: 30, balance: 30 });
  });

  it('an operator ADJUST is credit.adjusted in either direction, never credit.consumed', async () => {
    await creditsService.grant({ applicationId: appId, endUserId, amount: 50, reason: 'GRANT' });
    await creditsService.grant({ applicationId: appId, endUserId, amount: -20, reason: 'ADJUST' });
    await creditsService.grant({ applicationId: appId, endUserId, amount: 5, reason: 'ADJUST' });

    const rows = await creditDeliveries();
    expect(rows.map((r) => [r.eventType, r.payload.data.credit.delta, r.payload.data.credit.balance])).toEqual([
      ['credit.granted', 50, 50],
      ['credit.adjusted', -20, 30],
      ['credit.adjusted', 5, 35],
    ]);
  });

  it('usage charged in credits emits credit.consumed in the record transaction', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/usage-meters`,
      headers: op(),
      payload: { slug: 'api_calls', name: 'API calls', unit: 'calls' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: op(),
      payload: { slug: 'metered', name: 'Metered', amount: 0, kind: 'SUBSCRIPTION' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/metered/entitlements`,
      headers: op(),
      payload: { kind: 'USAGE', key: 'api_calls', quantity: 1, creditsPerUnit: 2 },
    });
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: 'metered' } });
    await prisma.subscription.create({
      data: { applicationId: appId, endUserId, planId: plan.id, status: 'ACTIVE', provider: 'stripe' },
    });
    await creditsService.grant({ applicationId: appId, endUserId, amount: 10, reason: 'GRANT' });

    const rec = await app.inject({
      method: 'POST',
      url: '/api/v1/usage/record',
      headers: sk(),
      payload: { meterSlug: 'api_calls', quantity: 4, endUserId },
    });
    expect(rec.statusCode).toBe(201);
    const rows = await creditDeliveries();
    expect(rows.map((r) => r.eventType)).toEqual(['credit.granted', 'credit.consumed']);
    // 1 included, 3 charged at 2 credits.
    expect(rows[1]!.payload.data.credit).toMatchObject({ delta: -6, balance: 4, reason: 'CONSUME' });
  });

  it('commits with the ledger entry: a rolled-back transaction leaves no entry and no delivery', async () => {
    await creditsService.grant({ applicationId: appId, endUserId, amount: 10, reason: 'GRANT' });
    await expect(
      prisma.$transaction(async (tx) => {
        await creditsService.consume({ applicationId: appId, endUserId, amount: 3, idempotencyKey: 'rolled-back', tx });
        // The delivery row exists inside the transaction...
        const inside = await tx.webhookDelivery.count({ where: { applicationId: appId, eventType: 'credit.consumed' } });
        expect(inside).toBe(1);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');

    // ...and neither it nor the entry survived the rollback.
    expect(await prisma.creditLedger.count({ where: { applicationId: appId, idempotencyKey: 'rolled-back' } })).toBe(0);
    expect(await prisma.webhookDelivery.count({ where: { applicationId: appId, eventType: 'credit.consumed' } })).toBe(0);
    expect(await creditsService.getBalance(appId, { endUserId })).toBe(10);
  });

  it('eight concurrent consumes with one key write one entry and one event', async () => {
    await creditsService.grant({ applicationId: appId, endUserId, amount: 100, reason: 'GRANT' });
    const results = await Promise.all(Array.from({ length: 8 }, () => consume(5, { idempotencyKey: 'race' })));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(await creditsService.getBalance(appId, { endUserId })).toBe(95);
    const consumed = (await creditDeliveries()).filter((r) => r.eventType === 'credit.consumed');
    expect(consumed).toHaveLength(1);
  });

  it('erasing the end-user scrubs personal text out of their credit.* payloads', async () => {
    const email = (await prisma.endUser.findUniqueOrThrow({ where: { id: endUserId } })).email!;
    await creditsService.grant({
      applicationId: appId,
      endUserId,
      amount: 10,
      reason: 'GRANT',
      description: `Goodwill for Ada Lovelace <${email}>`,
    });
    const before = JSON.stringify((await creditDeliveries())[0]!.payload);
    expect(before).toContain(email);

    const erased = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${appId}/end-users/${endUserId}?erasure=true`,
      headers: op(),
    });
    expect(erased.statusCode, erased.body).toBe(200);

    const [row] = await creditDeliveries();
    expect(row!.payload.data.credit.description).toBeNull();
    const after = JSON.stringify(row!.payload);
    expect(after).not.toContain(email);
    expect(after).not.toContain('Ada Lovelace');
    // The accounting facts survive.
    expect(row!.payload.data.credit).toMatchObject({ delta: 10, balance: 10, reason: 'GRANT' });
  });

  it('an endpoint not subscribed to credit events gets none', async () => {
    await prisma.webhookEndpoint.deleteMany({ where: { applicationId: appId } });
    await webhookService.createEndpoint({
      applicationId: appId,
      url: 'https://example.invalid/users-only',
      events: ['user.created'],
    });
    await creditsService.grant({ applicationId: appId, endUserId, amount: 10, reason: 'GRANT' });
    expect(await creditDeliveries()).toHaveLength(0);
  });
});
