/**
 * Operator MCP plan editing + archive flow.
 *
 * A plan's price is registered with the payment provider and immutable, so
 * update_plan edits ENTITLEMENTS only (name / license / credit), never price,
 * and set_plan_active(false) is the archive path. These tests confirm an
 * entitlement edit lands, the price is untouched, and archiving works, all
 * tenant-scoped.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('Operator MCP plan edit + archive', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function makeOperator(slug: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `mcppe-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
    });
    return (res.json().data as { accessToken: string }).accessToken;
  }
  async function mintPat(session: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${session}` },
      payload: { name: 'plan-agent', scopes: ['read', 'applications:write'] },
    });
    return (res.json().data as { rawToken: string }).rawToken;
  }
  async function rpc(token: string, name: string, args: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    const p = JSON.parse(res.body) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return { isError: p.result.isError === true, data: JSON.parse(p.result.content[0]!.text) };
  }
  async function createApp(token: string, slug: string): Promise<string> {
    const r = await rpc(token, 'create_application', { name: slug, slug });
    return (r.data as { id: string }).id;
  }

  it('create_plan holds the default price to the rules every price follows', async () => {
    const token = await mintPat(await makeOperator('rules'));
    const appId = await createApp(token, 'plan-rules-app');
    for (const [currency, amount, code] of [
      ['KWD', 1005, 'PLAN_PRICE_CURRENCY_UNSUPPORTED'],
      ['ZZZ', 1000, 'PLAN_PRICE_CURRENCY_INVALID'],
      ['HUF', 150, 'PLAN_PRICE_AMOUNT_INVALID'],
    ] as const) {
      const refused = await rpc(token, 'create_plan', { applicationId: appId, slug: 'bad', name: 'Bad', price: { currency, amount } });
      expect(refused.isError, currency).toBe(true);
      expect(JSON.stringify(refused.data), currency).toContain(code);
    }
    const created = await rpc(token, 'create_plan', { applicationId: appId, slug: 'ok', name: 'Ok', price: { currency: 'usd', amount: 900 } });
    expect(created.isError).toBe(false);
    expect(created.data).toMatchObject({ price: { currency: 'USD', amount: 900 } });
  });

  it('update_plan edits entitlements but never the price', async () => {
    const token = await mintPat(await makeOperator('edit'));
    const appId = await createApp(token, 'plan-edit-app');
    await rpc(token, 'create_plan', { applicationId: appId, slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 1500 } });

    const updated = await rpc(token, 'update_plan', {
      applicationId: appId,
      slug: 'pro',
      name: 'Pro Plus',
    });
    expect(updated.isError).toBe(false);
    const d = updated.data as { name: string; price: { currency: string; amount: number } };
    expect(d.name).toBe('Pro Plus');
    // Price is unchanged, update_plan can't touch it.
    expect(d.price).toMatchObject({ currency: 'USD', amount: 1500 });
    expect(d).not.toHaveProperty('amount');

    // An agent that tries to smuggle a price change is refused, and nothing
    // of the call is applied: the tool has no price field.
    for (const smuggled of [{ amount: 99 }, { price: { currency: 'USD', amount: 99 } }]) {
      const sneaky = await rpc(token, 'update_plan', { applicationId: appId, slug: 'pro', name: 'Pro Plus 2', ...smuggled });
      expect(sneaky.isError).toBe(true);
      expect(JSON.stringify(sneaky.data)).toContain('VALIDATION_ERROR');
    }
    const listed = await rpc(token, 'list_plans', { applicationId: appId });
    const [plan] = (listed.data as { plans: Array<{ name: string; price: { amount: number } }> }).plans;
    expect(plan).toMatchObject({ name: 'Pro Plus', price: { amount: 1500 } });
  });

  it('update_plan sets the local prices rule and the change reaches the billing log, once', async () => {
    const token = await mintPat(await makeOperator('local'));
    const appId = await createApp(token, 'plan-local-app');
    await rpc(token, 'create_plan', { applicationId: appId, slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 1500 } });

    const updated = await rpc(token, 'update_plan', { applicationId: appId, slug: 'pro', localPrices: 'OFF' });
    expect(updated.isError, JSON.stringify(updated.data)).toBe(false);
    expect((updated.data as { localPrices: string }).localPrices).toBe('OFF');
    // The same value again is not a change.
    await rpc(token, 'update_plan', { applicationId: appId, slug: 'pro', localPrices: 'OFF' });

    const events = await rpc(token, 'recent_billing_events', { applicationId: appId, type: 'plan.local_prices_changed' });
    expect(events.isError, JSON.stringify(events.data)).toBe(false);
    const logged = (events.data as { events: Array<{ type: string; actor: { type: string }; data: Record<string, string> }> }).events;
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      type: 'plan.local_prices_changed',
      actor: { type: 'operator' },
      data: { planSlug: 'pro', before: 'inherit', after: 'off' },
    });

    const refused = await rpc(token, 'update_plan', { applicationId: appId, slug: 'pro', localPrices: 'any' });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.data)).toContain('VALIDATION_ERROR');
  });

  it('set_plan_active archives a plan', async () => {
    const token = await mintPat(await makeOperator('archive'));
    const appId = await createApp(token, 'plan-archive-app');
    await rpc(token, 'create_plan', { applicationId: appId, slug: 'legacy', name: 'Legacy', price: { currency: 'USD', amount: 900 } });

    const archived = await rpc(token, 'set_plan_active', {
      applicationId: appId,
      slug: 'legacy',
      active: false,
    });
    expect(archived.isError).toBe(false);
    expect((archived.data as { active: boolean }).active).toBe(false);
  });

  it('cannot edit a plan in another workspace', async () => {
    const victimToken = await mintPat(await makeOperator('pe-victim'));
    const victimApp = await createApp(victimToken, 'pe-victim-app');
    await rpc(victimToken, 'create_plan', { applicationId: victimApp, slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 1000 } });

    const attackerToken = await mintPat(await makeOperator('pe-attacker'));
    const attempt = await rpc(attackerToken, 'update_plan', {
      applicationId: victimApp,
      slug: 'pro',
      name: 'Hijacked',
    });
    expect(attempt.isError).toBe(true);
    expect((attempt.data as { error: string }).error).toMatch(/not found in this workspace/i);
  });

  it('set_plan_price and remove_plan_price manage a price in another currency, inside the caller\'s own workspace', async () => {
    const token = await mintPat(await makeOperator('prices'));
    const appId = await createApp(token, 'plan-price-app');
    await rpc(token, 'create_plan', { applicationId: appId, slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 1500 } });

    const set = await rpc(token, 'set_plan_price', { applicationId: appId, planSlug: 'pro', currency: 'inr', amount: 119900, countries: ['in'] });
    expect(set.isError, JSON.stringify(set.data)).toBe(false);
    const listed = await rpc(token, 'list_plans', { applicationId: appId });
    const [listedPlan] = (listed.data as { plans: Array<{ prices: unknown[] }> }).plans;
    expect(listedPlan!.prices).toEqual([
      expect.objectContaining({ currency: 'USD', amount: 1500, isDefault: true }),
      expect.objectContaining({ currency: 'INR', amount: 119900, countries: ['IN'], isDefault: false }),
    ]);

    // The plan's own currency is its default price, not an additional one.
    const own = await rpc(token, 'set_plan_price', { applicationId: appId, planSlug: 'pro', currency: 'USD', amount: 100 });
    expect(own.isError).toBe(true);
    expect(JSON.stringify(own.data)).toContain('PLAN_PRICE_IS_DEFAULT');

    // Another workspace cannot reach this Application's plan.
    const outsider = await mintPat(await makeOperator('prices-other'));
    const foreign = await rpc(outsider, 'set_plan_price', { applicationId: appId, planSlug: 'pro', currency: 'EUR', amount: 1400 });
    expect(foreign.isError).toBe(true);
    const foreignRemove = await rpc(outsider, 'remove_plan_price', { applicationId: appId, planSlug: 'pro', currency: 'INR' });
    expect(foreignRemove.isError).toBe(true);

    const removed = await rpc(token, 'remove_plan_price', { applicationId: appId, planSlug: 'pro', currency: 'INR' });
    expect(removed.isError, JSON.stringify(removed.data)).toBe(false);
    const after = await rpc(token, 'list_plans', { applicationId: appId });
    const [remaining] = (after.data as { plans: Array<{ prices: unknown[] }> }).plans;
    expect(remaining!.prices).toEqual([expect.objectContaining({ currency: 'USD', isDefault: true })]);
  });
});
