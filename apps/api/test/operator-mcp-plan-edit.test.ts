/**
 * Operator MCP plan editing + archive flow.
 *
 * A plan's price is registered with the payment provider and immutable, so
 * update_plan edits ENTITLEMENTS only (name / license / credit) — never price —
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

  it('update_plan edits entitlements but never the price', async () => {
    const token = await mintPat(await makeOperator('edit'));
    const appId = await createApp(token, 'plan-edit-app');
    await rpc(token, 'create_plan', { applicationId: appId, slug: 'pro', name: 'Pro', amount: 1500 });

    const updated = await rpc(token, 'update_plan', {
      applicationId: appId,
      slug: 'pro',
      name: 'Pro Plus',
    });
    expect(updated.isError).toBe(false);
    const d = updated.data as { name: string; amount: number };
    expect(d.name).toBe('Pro Plus');
    // Price is unchanged — update_plan can't touch it.
    expect(d.amount).toBe(1500);

    // Even if an agent tries to smuggle a price change, it's ignored (the tool
    // has no price field; the value never reaches the service).
    const sneaky = await rpc(token, 'update_plan', {
      applicationId: appId,
      slug: 'pro',
      name: 'Pro Plus 2',
      // @ts-expect-error — not part of the schema; asserting it has no effect.
      amount: 99,
    });
    expect((sneaky.data as { amount: number }).amount).toBe(1500);
  });

  it('set_plan_active archives a plan', async () => {
    const token = await mintPat(await makeOperator('archive'));
    const appId = await createApp(token, 'plan-archive-app');
    await rpc(token, 'create_plan', { applicationId: appId, slug: 'legacy', name: 'Legacy', amount: 900 });

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
    await rpc(victimToken, 'create_plan', { applicationId: victimApp, slug: 'pro', name: 'Pro', amount: 1000 });

    const attackerToken = await mintPat(await makeOperator('pe-attacker'));
    const attempt = await rpc(attackerToken, 'update_plan', {
      applicationId: victimApp,
      slug: 'pro',
      name: 'Hijacked',
    });
    expect(attempt.isError).toBe(true);
    expect((attempt.data as { error: string }).error).toMatch(/not found in this workspace/i);
  });
});
