/**
 * MCP tool tests — exercise each tool against a stub HTTP server, plus the
 * Zod → JSON Schema shim used to publish input descriptors.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import { AdminClient, AdminApiError } from '../src/client.js';
import { tools } from '../src/tools.js';
import { zodToJsonSchema } from '../src/lib/zod-to-json-schema.js';

interface Stub {
  url: string;
  reset: () => void;
  set: (key: string, status: number, body: unknown) => void;
  close: () => Promise<void>;
}

function startStub(): Promise<Stub> {
  return new Promise((resolve) => {
    const responses = new Map<string, { status: number; body: unknown }>();
    const server: Server = createServer((req, res) => {
      const r = responses.get(`${req.method} ${req.url}`) ?? {
        status: 404,
        body: { success: false, error: { code: 'STUB_MISS', message: 'no stub set' } },
      };
      res.statusCode = r.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(r.body));
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        reset: () => responses.clear(),
        set: (key, status, body) => responses.set(key, { status, body }),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('@rekey.dev/mcp tool registry', () => {
  let stub: Stub;
  let client: AdminClient;

  beforeAll(async () => {
    stub = await startStub();
    client = new AdminClient({ apiUrl: stub.url, adminKey: 'x'.repeat(40) });
  });

  afterAll(async () => {
    await stub.close();
  });

  it('exposes the expected tool names', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_application',
      'get_payment_stats_by_app',
      'list_api_keys',
      'list_applications',
      'list_coupons',
      'list_payments',
      'list_plans',
      'list_tenants',
      'mint_api_key',
    ]);
  });

  it('list_payments builds the admin-metrics query string from its filters', async () => {
    stub.reset();
    // /admin/metrics/payments is paginated → Page<T> envelope; the tool unwraps `.items`.
    stub.set('GET /api/v1/admin/metrics/payments', 200, {
      success: true,
      data: { items: ['all'], total: 1, limit: 50, offset: 0 },
    });
    stub.set(
      'GET /api/v1/admin/metrics/payments?applicationId=app_1&status=SUCCEEDED&sort=amount&order=asc&limit=10',
      200,
      { success: true, data: { items: ['filtered'], total: 1, limit: 10, offset: 0 } },
    );
    const tool = tools.find((t) => t.name === 'list_payments')!;
    expect(await tool.execute(client, {})).toEqual(['all']);
    expect(
      await tool.execute(client, {
        applicationId: 'app_1',
        status: 'SUCCEEDED',
        sort: 'amount',
        order: 'asc',
        limit: 10,
      }),
    ).toEqual(['filtered']);
  });

  it('get_payment_stats_by_app GETs the payments-by-app rollup', async () => {
    stub.reset();
    stub.set('GET /api/v1/admin/metrics/payments-by-app', 200, {
      success: true,
      data: [{ applicationId: 'app_1', succeeded: 3, failed: 1, volumeCents: 2997 }],
    });
    const tool = tools.find((t) => t.name === 'get_payment_stats_by_app')!;
    expect(await tool.execute(client, {})).toEqual([
      { applicationId: 'app_1', succeeded: 3, failed: 1, volumeCents: 2997 },
    ]);
  });

  it('list_applications passes ?tenantId when provided, omits when not', async () => {
    stub.reset();
    stub.set('GET /api/v1/admin/applications', 200, { success: true, data: ['no-filter'] });
    stub.set('GET /api/v1/admin/applications?tenantId=tn_1', 200, {
      success: true,
      data: ['filtered'],
    });
    const tool = tools.find((t) => t.name === 'list_applications')!;
    expect(await tool.execute(client, {})).toEqual(['no-filter']);
    expect(await tool.execute(client, { tenantId: 'tn_1' })).toEqual(['filtered']);
  });

  it('list_plans builds the right path with includeInactive flag', async () => {
    stub.reset();
    stub.set('GET /api/v1/admin/applications/app_1/plans', 200, {
      success: true,
      data: ['active-only'],
    });
    stub.set('GET /api/v1/admin/applications/app_1/plans?includeInactive=true', 200, {
      success: true,
      data: ['all'],
    });
    const tool = tools.find((t) => t.name === 'list_plans')!;
    expect(await tool.execute(client, { applicationId: 'app_1' })).toEqual(['active-only']);
    expect(
      await tool.execute(client, { applicationId: 'app_1', includeInactive: true }),
    ).toEqual(['all']);
  });

  it('mint_api_key POSTs to the operator PAT endpoint and returns the raw key once', async () => {
    stub.reset();
    stub.set('POST /api/v1/tenant/operator/applications/app_1/api-keys', 201, {
      success: true,
      data: { apiKey: { id: 'key_1' }, rawKey: 'rp_live_secret', warning: 'shown once' },
    });
    // A client configured WITH an operator PAT uses it for the write path.
    const opClient = new AdminClient({
      apiUrl: stub.url,
      adminKey: 'x'.repeat(40),
      operatorToken: 'rp_op_test-token',
    });
    const tool = tools.find((t) => t.name === 'mint_api_key')!;
    const out = await tool.execute(opClient, { applicationId: 'app_1', name: 'agent-worker' });
    expect(out).toMatchObject({ apiKey: { id: 'key_1' }, rawKey: 'rp_live_secret' });
  });

  it('mint_api_key fails closed when no operator PAT is configured', async () => {
    stub.reset();
    // `client` (the describe-level one) has no operatorToken.
    const tool = tools.find((t) => t.name === 'mint_api_key')!;
    await expect(
      tool.execute(client, { applicationId: 'app_1', name: 'nope' }),
    ).rejects.toMatchObject({
      name: 'AdminApiError',
      code: 'OPERATOR_TOKEN_MISSING',
    });
  });

  it('mint_api_key surfaces a server scope rejection (keys:mint missing) as AdminApiError', async () => {
    stub.reset();
    stub.set('POST /api/v1/tenant/operator/applications/app_1/api-keys', 403, {
      success: false,
      error: {
        code: 'OPERATOR_SCOPE_INSUFFICIENT',
        message: "requires the 'keys:mint' scope",
        fix: 'Mint a PAT with keys:mint.',
      },
    });
    const opClient = new AdminClient({
      apiUrl: stub.url,
      adminKey: 'x'.repeat(40),
      operatorToken: 'rp_op_readonly',
    });
    const tool = tools.find((t) => t.name === 'mint_api_key')!;
    await expect(
      tool.execute(opClient, { applicationId: 'app_1', name: 'agent-worker' }),
    ).rejects.toMatchObject({
      name: 'AdminApiError',
      code: 'OPERATOR_SCOPE_INSUFFICIENT',
      statusCode: 403,
    });
  });

  it('read tools fail closed with READ_REQUIRES_ADMIN_KEY when no admin key is configured', async () => {
    stub.reset();
    // Operator-token-only: an agent that should ONLY mint keys runs without the
    // master key. Read tools must refuse rather than send an empty bearer.
    const opOnly = new AdminClient({ apiUrl: stub.url, operatorToken: 'rp_op_test-token' });
    const tool = tools.find((t) => t.name === 'list_applications')!;
    await expect(tool.execute(opOnly, {})).rejects.toMatchObject({
      name: 'AdminApiError',
      code: 'READ_REQUIRES_ADMIN_KEY',
    });
  });

  it('the keys:mint write tool works with an operator token alone (no admin key)', async () => {
    stub.reset();
    stub.set('POST /api/v1/tenant/operator/applications/app_1/api-keys', 201, {
      success: true,
      data: { apiKey: { id: 'key_2' }, rawKey: 'rp_live_secret2', warning: 'shown once' },
    });
    const opOnly = new AdminClient({ apiUrl: stub.url, operatorToken: 'rp_op_test-token' });
    const tool = tools.find((t) => t.name === 'mint_api_key')!;
    const out = await tool.execute(opOnly, { applicationId: 'app_1', name: 'agent-worker' });
    expect(out).toMatchObject({ apiKey: { id: 'key_2' }, rawKey: 'rp_live_secret2' });
  });

  it('translates RekeyError envelopes into AdminApiError with code + fix', async () => {
    stub.reset();
    stub.set('GET /api/v1/admin/applications/app_missing', 404, {
      success: false,
      error: {
        code: 'APPLICATION_NOT_FOUND',
        message: 'gone',
        fix: 'list applications first',
      },
    });
    const tool = tools.find((t) => t.name === 'get_application')!;
    await expect(tool.execute(client, { applicationId: 'app_missing' })).rejects.toMatchObject({
      name: 'AdminApiError',
      code: 'APPLICATION_NOT_FOUND',
      fix: 'list applications first',
      statusCode: 404,
    });
  });
});

describe('zodToJsonSchema shim', () => {
  it('emits required + optional + description correctly', () => {
    const schema = z.object({
      a: z.string().describe('the a'),
      b: z.boolean().optional().describe('the optional b'),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string', description: 'the a' },
        b: { type: 'boolean', description: 'the optional b' },
      },
      required: ['a'],
    });
  });

  it('omits `required` when every field is optional', () => {
    const schema = z.object({ x: z.string().optional() });
    const out = zodToJsonSchema(schema);
    expect(out.required).toBeUndefined();
    expect(out.properties?.x).toEqual({ type: 'string' });
  });

  it('renders z.enum as a string with enum values (tool arg pickers)', () => {
    const schema = z.object({
      status: z.enum(['PENDING', 'SUCCEEDED']).optional().describe('payment status'),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['PENDING', 'SUCCEEDED'], description: 'payment status' },
      },
    });
  });
});
