/**
 * The operator MCP list tools: counts only, the REST access rules, and no
 * export or erase tool.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { UNRESTRICTED } from '../src/lib/operator-scopes.js';
import { TOOL_SCOPES, allOperatorTools } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import type { OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { contactsHarness, type ContactsWorld } from './contacts-fixtures.js';

const tool = (name: string) => allOperatorTools.find((t) => t.name === name)!;

describe('operator MCP list tools', () => {
  let app: FastifyInstance;
  const h = contactsHarness(() => app, '86');
  const { inject, auth, world, createList, mintKey, memberWith } = h;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function ownerCtx(w: ContactsWorld): Promise<OperatorToolContext> {
    const m = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: w.tenantId, role: 'OWNER' } });
    return { tenantUserId: m.tenantUserId, tenantId: w.tenantId, role: 'OWNER', tenantMembershipId: m.id, scopes: UNRESTRICTED, canWrite: false, canAdmin: false };
  }

  async function memberCtx(w: ContactsWorld): Promise<OperatorToolContext> {
    const m = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: w.tenantId, role: 'MEMBER' } });
    return { tenantUserId: m.tenantUserId, tenantId: w.tenantId, role: 'MEMBER', tenantMembershipId: m.id, scopes: UNRESTRICTED, canWrite: false, canAdmin: false };
  }

  it('lists lists and one list’s numbers, never an address', async () => {
    const w = await world();
    await createList(w, { lawfulBasis: 'contract', fieldSchema: [{ name: 'msg', label: 'Message', type: 'text' }] });
    const secret = await mintKey(w);
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
      await inject({
        method: 'POST',
        url: '/api/v1/lists/newsletter/subscribe',
        headers: auth(secret),
        payload: { email, fields: { msg: 'hi' } },
      });
    }
    await inject({ method: 'DELETE', url: '/api/v1/lists/newsletter/members/c@example.com', headers: auth(secret) });
    const ctx = await ownerCtx(w);

    const listed = await tool('list_contact_lists').handler(ctx, { applicationId: w.appId });
    expect(listed).toEqual({
      lists: [
        { key: 'newsletter', name: 'Newsletter', kind: 'generic', publicCapture: false, archived: false, subscribed: 2, unsubscribed: 1, submissions: 3 },
      ],
    });
    const stats = await tool('get_contact_list_stats').handler(ctx, { applicationId: w.appId, key: 'newsletter' });
    expect(stats).toMatchObject({
      subscribed: 2,
      unsubscribed: 1,
      joined: { last7Days: 3, last30Days: 3 },
      left: { last7Days: 1, last30Days: 1 },
      source: { browser: 0, server: 3, operator: 0 },
      submissions: 3,
    });
    expect(JSON.stringify([listed, stats])).not.toContain('@example.com');

    await expect(
      tool('get_contact_list_stats').handler(ctx, { applicationId: w.appId, key: 'nope' }),
    ).rejects.toMatchObject({ code: 'LIST_NOT_FOUND' });
  });

  it('refuses a viewer grant, as the REST routes do', async () => {
    const w = await world();
    await memberWith(w, 'APP_VIEWER');
    await expect(tool('list_contact_lists').handler(await memberCtx(w), { applicationId: w.appId })).rejects.toMatchObject({
      code: 'SCOPE_INSUFFICIENT',
    });
  });

  it('is governed by audience:read, and there is no export or erase tool for contacts', () => {
    expect(TOOL_SCOPES.list_contact_lists).toBe('audience:read');
    expect(TOOL_SCOPES.get_contact_list_stats).toBe('audience:read');
    const names = allOperatorTools.map((t) => t.name);
    expect(names.filter((n) => /contact/.test(n)).sort()).toEqual(['get_contact_list_stats', 'list_contact_lists']);
  });
});
