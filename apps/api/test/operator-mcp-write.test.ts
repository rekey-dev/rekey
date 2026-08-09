/**
 * Operator MCP write tools (phase 1).
 *
 * Load-bearing security cases:
 *   - a read-only credential never SEES the write tools and is refused if it
 *     calls one anyway (no silent execution);
 *   - a write credential held by an OWNER/ADMIN can create + modify workspace
 *     config, and the change really lands;
 *   - write tools re-scope by tenant — another workspace's applicationId is
 *     indistinguishable from a non-existent one (no cross-tenant write);
 *   - role gating: write scope alone is not enough; the role must clear the
 *     tool's minimum (MEMBER is refused).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';
import { handleOperatorMcpMessage } from '../src/modules/tenant-mcp/tenant-mcp-server.js';

interface OperatorSession {
  accessToken: string;
  tenantId: string;
  userId: string;
}

describe('Operator MCP write tools', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function makeOperator(slug: string): Promise<OperatorSession> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `mcpw-${slug}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: `WS ${slug}`,
      },
    });
    const data = res.json().data as {
      accessToken: string;
      activeTenantId: string;
      user: { id: string };
    };
    return { accessToken: data.accessToken, tenantId: data.activeTenantId, userId: data.user.id };
  }

  async function mintPat(session: OperatorSession, scopes: string[]): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { name: 'mcp-agent', scopes },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { rawToken: string }).rawToken;
  }

  /** POST a single JSON-RPC message to the operator MCP endpoint with a Bearer. */
  async function rpc(token: string, method: string, params?: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    });
    return res;
  }

  /** Parse a tools/call reply into { isError, data }. */
  function readToolResult(body: string): { isError: boolean; data: unknown } {
    const parsed = JSON.parse(body) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    return {
      isError: parsed.result.isError === true,
      data: JSON.parse(parsed.result.content[0]!.text),
    };
  }

  it('a read-only PAT does not see the write tools and is refused if it calls one', async () => {
    const op = await makeOperator('ro');
    const token = await mintPat(op, ['read']);

    const list = await rpc(token, 'tools/list');
    const names = (list.json().result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('list_applications'); // read tool present
    expect(names).not.toContain('create_application'); // write tool hidden

    const call = await rpc(token, 'tools/call', {
      name: 'create_application',
      arguments: { name: 'Nope', slug: 'ro-nope' },
    });
    const { isError, data } = readToolResult(call.body);
    expect(isError).toBe(true);
    expect((data as { error: string }).error).toMatch(/write access/i);

    // Nothing was created.
    const found = await prisma.application.findUnique({ where: { slug: 'ro-nope' } });
    expect(found).toBeNull();
  });

  it('a write PAT held by an OWNER can create + configure an application', async () => {
    const op = await makeOperator('rw');
    const token = await mintPat(op, ['read', 'applications:write']);

    const list = await rpc(token, 'tools/list');
    const names = (list.json().result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('create_application');

    // create_application
    const created = readToolResult(
      (await rpc(token, 'tools/call', {
        name: 'create_application',
        arguments: { name: 'MCP Made', slug: 'rw-made' },
      })).body,
    );
    expect(created.isError).toBe(false);
    const appId = (created.data as { id: string }).id;
    const row = await prisma.application.findUnique({ where: { id: appId } });
    expect(row?.tenantId).toBe(op.tenantId);

    // update_auth_config — flip mcpEnabled on
    const updated = readToolResult(
      (await rpc(token, 'tools/call', {
        name: 'update_auth_config',
        arguments: { applicationId: appId, mcpEnabled: true },
      })).body,
    );
    expect(updated.isError).toBe(false);
    expect((updated.data as { authConfig: { mcpEnabled: boolean } }).authConfig.mcpEnabled).toBe(
      true,
    );

    // create_plan
    const plan = readToolResult(
      (await rpc(token, 'tools/call', {
        name: 'create_plan',
        arguments: { applicationId: appId, slug: 'pro', name: 'Pro', amount: 1500 },
      })).body,
    );
    expect(plan.isError).toBe(false);
    expect((plan.data as { amount: number }).amount).toBe(1500);

    // create_webhook_endpoint — secret shown once
    const hook = readToolResult(
      (await rpc(token, 'tools/call', {
        name: 'create_webhook_endpoint',
        arguments: { applicationId: appId, url: 'https://example.com/hook', events: ['*'] },
      })).body,
    );
    expect(hook.isError).toBe(false);
    expect(typeof (hook.data as { secret: string }).secret).toBe('string');

    // A security event was logged for the create. Fire-and-forget, so wait.
    const events = await waitForSecurityEvents({ tenantId: op.tenantId, type: 'app.created' });
    expect((events[0]!.metadata as { via?: string }).via).toBe('operator_mcp');
  });

  it("cannot write to another workspace's application (cross-tenant guard)", async () => {
    const victim = await makeOperator('victim');
    const victimToken = await mintPat(victim, ['read', 'applications:write']);
    const created = readToolResult(
      (await rpc(victimToken, 'tools/call', {
        name: 'create_application',
        arguments: { name: 'Victim', slug: 'victim-app' },
      })).body,
    );
    const victimAppId = (created.data as { id: string }).id;

    const attacker = await makeOperator('attacker');
    const attackerToken = await mintPat(attacker, ['read', 'applications:write']);

    const attempt = readToolResult(
      (await rpc(attackerToken, 'tools/call', {
        name: 'update_auth_config',
        arguments: { applicationId: victimAppId, mcpEnabled: true },
      })).body,
    );
    expect(attempt.isError).toBe(true);
    expect((attempt.data as { error: string }).error).toMatch(/not found in this workspace/i);

    // Victim app untouched.
    const row = await prisma.application.findUnique({ where: { id: victimAppId } });
    const cfg = row?.authConfig as { mcpEnabled?: boolean };
    expect(cfg.mcpEnabled ?? false).toBe(false);
  });

  it("cannot update another workspace's webhook endpoint by passing your own appId", async () => {
    // Vector: attacker owns appId A (clears loadAppInTenant) but targets a
    // victim endpointId from app B. The endpoint write must be scoped by
    // (id, applicationId), so the mismatch resolves to not-found.
    const victim = await makeOperator('hook-victim');
    const vToken = await mintPat(victim, ['read', 'applications:write']);
    const vApp = (
      readToolResult(
        (await rpc(vToken, 'tools/call', {
          name: 'create_application',
          arguments: { name: 'HV', slug: 'hook-victim-app' },
        })).body,
      ).data as { id: string }
    ).id;
    const vHook = readToolResult(
      (await rpc(vToken, 'tools/call', {
        name: 'create_webhook_endpoint',
        arguments: { applicationId: vApp, url: 'https://victim.example/hook', events: ['*'] },
      })).body,
    ).data as { id: string };

    const attacker = await makeOperator('hook-attacker');
    const aToken = await mintPat(attacker, ['read', 'applications:write']);
    const aApp = (
      readToolResult(
        (await rpc(aToken, 'tools/call', {
          name: 'create_application',
          arguments: { name: 'HA', slug: 'hook-attacker-app' },
        })).body,
      ).data as { id: string }
    ).id;

    const attempt = readToolResult(
      (await rpc(aToken, 'tools/call', {
        name: 'update_webhook_endpoint',
        arguments: { applicationId: aApp, endpointId: vHook.id, enabled: false },
      })).body,
    );
    expect(attempt.isError).toBe(true);

    // Victim endpoint untouched (still enabled).
    const row = await prisma.webhookEndpoint.findUnique({ where: { id: vHook.id } });
    expect(row?.enabled).toBe(true);
  });

  it('role gating: write scope is not enough — MEMBER is refused (direct dispatch)', async () => {
    // Exercise the dispatcher's role gate without provisioning a second-seat
    // MEMBER: a token CAN carry write scope while the operator is only a MEMBER.
    const memberCtx = {
      tenantUserId: 'tu_member',
      tenantId: 't_member',
      role: 'MEMBER' as const,
      canWrite: true,
    };
    const list = (await handleOperatorMcpMessage(memberCtx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).not.toContain('create_application');

    const call = (await handleOperatorMcpMessage(memberCtx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_application', arguments: { name: 'x', slug: 'x' } },
    })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(call.result.isError).toBe(true);
    expect(JSON.parse(call.result.content[0]!.text).error).toMatch(/role/i);
  });
});
