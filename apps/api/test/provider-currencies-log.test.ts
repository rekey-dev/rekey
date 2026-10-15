/**
 * A change to a provider's currency list is written to the billing log as
 * `provider.currencies_changed`, with the list before and after and the
 * operator who saved it, whichever door the save came through. A save that
 * leaves the list as it was writes nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const PAYPAL = { clientId: 'paypal_client_ci', clientSecret: 'paypal_secret_ci', webhookId: 'WH-CI' };
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

interface Entry {
  type: string;
  actor: { type: string; id: string | null };
  provider: string | null;
  data: { before: string[]; after: string[] };
}

describe('provider.currencies_changed', () => {
  let app: FastifyInstance;
  let w: OperatorWorld;
  let operatorId: string;
  let tenantId: string;

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
    tenantId = application.tenantId;
    operatorId = (await prisma.tenantUser.findFirstOrThrow({ where: { email: `owner-${application.slug}@example.com` } })).id;
  });

  const save = async (method: 'PUT' | 'PATCH', provider: string, payload: Record<string, unknown>): Promise<void> => {
    const res = await w.inject({
      method,
      url: `/api/v1/tenant/applications/${w.appId}/billing-credentials/${provider}`,
      headers: bearer(w.ownerToken),
      payload,
    });
    expect(res.statusCode, res.body).toBe(200);
  };

  /** Oldest first, read through the log's own route. */
  async function logged(): Promise<Entry[]> {
    const res = await w.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}/billing/events?type=provider.currencies_changed`,
      headers: bearer(w.ownerToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data as { items: Entry[] }).items.reverse();
  }

  async function mcpAdminToken(): Promise<string> {
    const clientId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/mcp/oauth/register', payload: { redirect_uris: [REDIRECT] } })
      .then((r) => (r.json() as { client_id: string }).client_id);
    const verifier = randomBytes(32).toString('base64url');
    const grant = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/grant',
      headers: bearer(w.ownerToken),
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        scope: 'mcp:operator:read mcp:operator:write mcp:operator:admin',
        tenant_id: tenantId,
        approve: true,
      },
    });
    const code = new URL((grant.json() as { data: { redirect: string } }).data.redirect).searchParams.get('code');
    const token = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/token',
      payload: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId },
    });
    return (token.json() as { access_token: string }).access_token;
  }

  async function configureOverMcp(token: string, args: Record<string, unknown>): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: bearer(token),
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'configure_billing_provider', arguments: { applicationId: w.appId, ...args } },
      },
    });
    const result = (res.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    expect(result.isError === true, result.content[0]!.text).toBe(false);
  }

  it('a first save with a list logs it against an empty list, naming the operator', async () => {
    await save('PUT', 'paypal', { data: PAYPAL, mode: 'test', currencies: ['usd', 'EUR'] });
    expect(await logged()).toEqual([
      expect.objectContaining({
        type: 'provider.currencies_changed',
        provider: 'paypal',
        actor: expect.objectContaining({ type: 'operator', id: operatorId }),
        data: { before: [], after: ['USD', 'EUR'] },
      }),
    ]);
  });

  it('a PATCH and a later PUT with a list each log the list before and after', async () => {
    await save('PUT', 'paypal', { data: PAYPAL, mode: 'test', currencies: ['USD', 'EUR'] });
    await save('PATCH', 'paypal', { currencies: ['USD'] });
    await save('PUT', 'paypal', { data: PAYPAL, mode: 'test', currencies: ['USD', 'GBP'] });
    const entries = await logged();
    expect(entries.map((entry) => entry.data)).toEqual([
      { before: [], after: ['USD', 'EUR'] },
      { before: ['USD', 'EUR'], after: ['USD'] },
      { before: ['USD'], after: ['USD', 'GBP'] },
    ]);
    for (const entry of entries) {
      expect(entry.provider).toBe('paypal');
      expect(entry.actor).toMatchObject({ type: 'operator', id: operatorId });
    }
  });

  it('a save that leaves the list as it was logs nothing', async () => {
    await save('PUT', 'paypal', { data: PAYPAL, mode: 'test', currencies: ['USD', 'EUR'] });
    await save('PATCH', 'paypal', { currencies: ['EUR', 'usd'] });
    await save('PATCH', 'paypal', { enabled: false });
    await save('PUT', 'paypal', { data: PAYPAL, mode: 'test' });
    await save('PUT', 'paypal', { data: PAYPAL, mode: 'test', currencies: ['USD', 'EUR'] });
    expect(await logged()).toHaveLength(1);
  });

  it('a refused list logs nothing and leaves the stored list alone', async () => {
    await save('PUT', 'paypal', { data: PAYPAL, mode: 'test', currencies: ['USD'] });
    const res = await w.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${w.appId}/billing-credentials/paypal`,
      headers: bearer(w.ownerToken),
      payload: { currencies: ['USD', 'INR'] },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('BILLING_PROVIDER_CURRENCY_NOT_OFFERED');
    expect(await logged()).toHaveLength(1);
  });

  it('configure_billing_provider over MCP logs a new row and a changed list, naming the operator', async () => {
    const token = await mcpAdminToken();
    await configureOverMcp(token, { provider: 'paypal', ...PAYPAL, mode: 'test', currencies: ['USD'] });
    await configureOverMcp(token, { provider: 'paypal', currencies: ['USD', 'EUR'] });
    await configureOverMcp(token, { provider: 'paypal', currencies: ['USD', 'EUR'] });
    const entries = await logged();
    expect(entries.map((entry) => entry.data)).toEqual([
      { before: [], after: ['USD'] },
      { before: ['USD'], after: ['USD', 'EUR'] },
    ]);
    for (const entry of entries) expect(entry.actor).toMatchObject({ type: 'operator', id: operatorId });
  });
});
