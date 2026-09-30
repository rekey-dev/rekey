/**
 * The operator MCP `get_user_analytics` tool: the REST route's data and
 * access rules, through the tool dispatcher.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { UNRESTRICTED, type Scope } from '../src/lib/operator-scopes.js';
import { TOOL_SCOPES, allOperatorTools, handleOperatorMcpMessage } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import type { OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { seedUsers } from './analytics-seed.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';

const tool = allOperatorTools.find((t) => t.name === 'get_user_analytics')!;

describe('operator MCP get_user_analytics', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function ctxFor(w: OperatorWorld, role: 'OWNER' | 'MEMBER', scopes: ReadonlySet<Scope> = UNRESTRICTED): Promise<OperatorToolContext> {
    const app0 = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
    const m = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: app0.tenantId, role } });
    return { tenantUserId: m.tenantUserId, tenantId: app0.tenantId, role, tenantMembershipId: m.id, scopes, canWrite: false, canAdmin: false };
  }

  it('returns what the REST route returns, with the same filters', async () => {
    const w = await operatorWorld(app);
    await seedUsers(w.appId, 40, 8, 20);
    const out = (await tool.handler(await ctxFor(w, 'OWNER'), {
      applicationId: w.appId,
      range: '7d',
      sections: 'kpis,mix',
      platform: 'ios',
    })) as { sections: Record<string, { status: string; data: unknown }> };
    const rest = await w.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}/analytics/users?range=7d&sections=kpis,mix&platform=ios`,
      headers: bearer(w.ownerToken),
    });
    expect(out.sections.kpis!.data).toEqual(rest.json().data.sections.kpis.data);
    expect(out.sections.mix!.data).toEqual(rest.json().data.sections.mix.data);
    expect(JSON.stringify(out)).not.toContain('@example.com');
  });

  it('is governed by overview:read and hides billing without billing:read', async () => {
    expect(TOOL_SCOPES.get_user_analytics).toBe('overview:read');
    const w = await operatorWorld(app, 'APP_VIEWER');
    await w.setScopes(['overview:read']);
    const restricted = await ctxFor(w, 'MEMBER', new Set<Scope>(['overview:read']));
    const out = (await tool.handler(restricted, { applicationId: w.appId, sections: 'kpis' })) as {
      sections: Record<string, { status: string }>;
    };
    expect(out.sections.kpis!.status).toBe('ok');
    await expect(tool.handler(restricted, { applicationId: w.appId, sections: 'billing' })).rejects.toMatchObject({
      code: 'SCOPE_INSUFFICIENT',
    });

    const noOverview = await ctxFor(w, 'MEMBER', new Set<Scope>(['end-users:read']));
    const listed = (await handleOperatorMcpMessage(noOverview, { jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listed.result.tools.map((t) => t.name)).not.toContain('get_user_analytics');
  });

  it('refuses another workspace\'s Application and bad arguments with a code and fix', async () => {
    const w = await operatorWorld(app);
    const other = await operatorWorld(app);
    await expect(tool.handler(await ctxFor(w, 'OWNER'), { applicationId: other.appId })).rejects.toMatchObject({
      statusCode: 404,
    });
    const bad = await handleOperatorMcpMessage(await ctxFor(w, 'OWNER'), {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_user_analytics', arguments: { applicationId: w.appId, range: 'forever' } },
    });
    const text = JSON.parse((bad as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as {
      code: string;
      fix: string;
    };
    expect(text.code).toBe('VALIDATION_ERROR');
    expect(text.fix).toContain('inputSchema');
  });
});
