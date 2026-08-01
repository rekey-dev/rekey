/**
 * Operator MCP admin tools (mcp:operator:admin) + get_end_user.
 *
 * Admin scope gates the destructive / financial / secret-handling tools
 * (configure_billing_provider, cancel_subscription). It must be granted
 * explicitly via the OAuth flow — a write token alone can't see or call them.
 *
 * Load-bearing cases:
 *   - a write-but-not-admin token can't see or call admin tools;
 *   - an admin token can configure provider credentials (stored encrypted, raw
 *     secret never persisted) and cancel a subscription;
 *   - get_end_user resolves a user by email and is workspace-scoped;
 *   - cross-tenant cancel by subscription id is refused.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

describe('Operator MCP admin tools + get_end_user', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function makeOperator(slug: string): Promise<{ accessToken: string; tenantId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `mcpa-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
    });
    const data = res.json().data as { accessToken: string; activeTenantId: string };
    return { accessToken: data.accessToken, tenantId: data.activeTenantId };
  }

  /** Run the OAuth grant→token flow and return an MCP access token for `scope`. */
  async function mcpToken(sessionToken: string, tenantId: string, scope: string): Promise<string> {
    const clientId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/mcp/oauth/register', payload: { redirect_uris: [REDIRECT] } })
      .then((r) => (r.json() as { client_id: string }).client_id);
    const { verifier, challenge } = pkce();
    const grant = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/grant',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope,
        tenant_id: tenantId,
        approve: true,
      },
    });
    const redirect = (grant.json() as { data: { redirect: string } }).data.redirect;
    const code = new URL(redirect).searchParams.get('code');
    const token = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/token',
      payload: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId },
    });
    return (token.json() as { access_token: string }).access_token;
  }

  async function rpc(token: string, method: string, params?: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    });
  }
  function toolResult(body: string): { isError: boolean; data: unknown } {
    const p = JSON.parse(body) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return { isError: p.result.isError === true, data: JSON.parse(p.result.content[0]!.text) };
  }
  async function listToolNames(token: string): Promise<string[]> {
    const r = await rpc(token, 'tools/list');
    return (r.json().result.tools as Array<{ name: string }>).map((t) => t.name);
  }
  async function createApp(token: string, slug: string): Promise<string> {
    const r = toolResult(
      (await rpc(token, 'tools/call', { name: 'create_application', arguments: { name: slug, slug } })).body,
    );
    return (r.data as { id: string }).id;
  }

  it('a write-but-not-admin token cannot see or call admin tools', async () => {
    const op = await makeOperator('write-only');
    const token = await mcpToken(op.accessToken, op.tenantId, 'mcp:operator:read mcp:operator:write');
    const names = await listToolNames(token);
    expect(names).toContain('create_application'); // write visible
    expect(names).not.toContain('configure_billing_provider'); // admin hidden
    expect(names).not.toContain('cancel_subscription');

    const call = toolResult(
      (await rpc(token, 'tools/call', {
        name: 'configure_billing_provider',
        arguments: { applicationId: 'x', provider: 'stripe', apiKey: 'sk_test_x' },
      })).body,
    );
    expect(call.isError).toBe(true);
    expect((call.data as { error: string }).error).toMatch(/admin access/i);
  });

  it('an admin token can configure provider credentials (stored encrypted)', async () => {
    const op = await makeOperator('admin-creds');
    const token = await mcpToken(op.accessToken, op.tenantId, 'mcp:operator:read mcp:operator:write mcp:operator:admin');
    expect(await listToolNames(token)).toContain('configure_billing_provider');
    const appId = await createApp(token, 'admin-creds-app');

    const secret = 'sk_test_supersecretvalue123';
    const res = toolResult(
      (await rpc(token, 'tools/call', {
        name: 'configure_billing_provider',
        arguments: { applicationId: appId, provider: 'stripe', apiKey: secret, mode: 'test' },
      })).body,
    );
    expect(res.isError).toBe(false);
    expect((res.data as { configured: boolean }).configured).toBe(true);

    const row = await prisma.billingCredentials.findUnique({
      where: { applicationId_provider: { applicationId: appId, provider: 'stripe' } },
    });
    expect(row).not.toBeNull();
    // Secret is encrypted at rest — the raw key must not appear in ciphertext.
    expect(row!.ciphertext).not.toContain(secret);

    // The security audit logged the configuration WITHOUT the secret.
    const events = await prisma.securityEvent.findMany({
      where: { tenantId: op.tenantId, type: 'app.billing_credentials_configured' },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(events[0]!.metadata)).not.toContain(secret);
  });

  it('get_end_user resolves by email and is workspace-scoped', async () => {
    const op = await makeOperator('lookup');
    // Write scope to create the app; get_end_user itself is a read tool.
    const token = await mcpToken(op.accessToken, op.tenantId, 'mcp:operator:read mcp:operator:write');
    const appId = await createApp(token, 'lookup-app');
    await prisma.endUser.create({
      data: { application: { connect: { id: appId } }, email: 'jane@example.com', role: 'user' },
    });

    const hit = toolResult(
      (await rpc(token, 'tools/call', {
        name: 'get_end_user',
        arguments: { applicationId: appId, email: 'jane@example.com' },
      })).body,
    );
    expect((hit.data as { found: boolean }).found).toBe(true);
    expect((hit.data as { endUser: { email: string } }).endUser.email).toBe('jane@example.com');

    // Another operator cannot read into this app.
    const other = await makeOperator('lookup-other');
    const otherToken = await mcpToken(other.accessToken, other.tenantId, 'mcp:operator:read');
    const miss = toolResult(
      (await rpc(otherToken, 'tools/call', {
        name: 'get_end_user',
        arguments: { applicationId: appId, email: 'jane@example.com' },
      })).body,
    );
    expect((miss.data as { found: boolean }).found).toBe(false);
  });

  it('cancel_subscription cancels a workspace sub and refuses cross-tenant ids', async () => {
    const op = await makeOperator('cancel');
    const token = await mcpToken(op.accessToken, op.tenantId, 'mcp:operator:read mcp:operator:write mcp:operator:admin');
    const appId = await createApp(token, 'cancel-app');
    // Plan via the tool, end-user + subscription directly (no provider → immediate cancel).
    const planId = (
      toolResult(
        (await rpc(token, 'tools/call', {
          name: 'create_plan',
          arguments: { applicationId: appId, slug: 'pro', name: 'Pro', amount: 1000 },
        })).body,
      ).data as { id: string }
    ).id;
    const endUser = await prisma.endUser.create({
      data: { application: { connect: { id: appId } }, email: 'sub@example.com', role: 'user' },
    });
    const sub = await prisma.subscription.create({
      data: {
        application: { connect: { id: appId } },
        endUser: { connect: { id: endUser.id } },
        plan: { connect: { id: planId } },
        status: 'ACTIVE',
      },
    });

    const res = toolResult(
      (await rpc(token, 'tools/call', {
        name: 'cancel_subscription',
        arguments: { subscriptionId: sub.id, atPeriodEnd: false },
      })).body,
    );
    expect(res.isError).toBe(false);
    expect((res.data as { status: string }).status).toBe('CANCELED');

    // A different workspace's admin token can't cancel this subscription.
    const attacker = await makeOperator('cancel-attacker');
    const attackerToken = await mcpToken(
      attacker.accessToken,
      attacker.tenantId,
      'mcp:operator:read mcp:operator:write mcp:operator:admin',
    );
    const blocked = toolResult(
      (await rpc(attackerToken, 'tools/call', {
        name: 'cancel_subscription',
        arguments: { subscriptionId: sub.id },
      })).body,
    );
    expect(blocked.isError).toBe(true);
    expect((blocked.data as { error: string }).error).toMatch(/not found in this workspace/i);
  });
});
