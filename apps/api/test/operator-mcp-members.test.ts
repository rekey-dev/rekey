/**
 * Operator MCP member-management tools (write).
 *
 * invite_member / list_invitations / revoke_invitation / change_member_role /
 * remove_member reuse tenantWorkspacesService, whose ensureCanManage + last-
 * owner guards do the real authorization. These tests cover the happy path,
 * the tenant scoping, and that the guards fire through the MCP surface.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('Operator MCP member tools', () => {
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
      payload: { email: `mcpm-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
    });
    const data = res.json().data as { accessToken: string; activeTenantId: string };
    return { accessToken: data.accessToken, tenantId: data.activeTenantId };
  }

  async function mintPat(session: string, scopes: string[]): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${session}` },
      payload: { name: 'mcp-member-agent', scopes },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { rawToken: string }).rawToken;
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
  /** Add a MEMBER to a workspace directly (skips the accept-invite ceremony). */
  async function seedMember(tenantId: string, email: string): Promise<string> {
    const user = await prisma.tenantUser.create({ data: { email } });
    await prisma.tenantMembership.create({
      data: { tenantUser: { connect: { id: user.id } }, tenant: { connect: { id: tenantId } }, role: 'MEMBER' },
    });
    return user.id;
  }

  it('invite → list → revoke', async () => {
    const op = await makeOperator('inv');
    const token = await mintPat(op.accessToken, ['read', 'applications:write']);

    const invited = toolResult(
      (await rpc(token, 'tools/call', {
        name: 'invite_member',
        arguments: { email: 'teammate@example.com', role: 'MEMBER' },
      })).body,
    );
    expect(invited.isError).toBe(false);
    const invitationId = (invited.data as { invitationId: string }).invitationId;
    // The raw invite token must NOT be returned in the tool response.
    expect(JSON.stringify(invited.data)).not.toMatch(/token/i);

    const list = toolResult((await rpc(token, 'tools/call', { name: 'list_invitations' })).body);
    const invitations = (list.data as { invitations: Array<{ id: string; status: string }> }).invitations;
    expect(invitations.find((i) => i.id === invitationId)?.status).toBe('pending');

    const revoked = toolResult(
      (await rpc(token, 'tools/call', {
        name: 'revoke_invitation',
        arguments: { invitationId },
      })).body,
    );
    expect(revoked.isError).toBe(false);
    expect((revoked.data as { status: string }).status).toBe('revoked');
  });

  it('change_member_role then remove_member', async () => {
    const op = await makeOperator('mgmt');
    const token = await mintPat(op.accessToken, ['read', 'applications:write']);
    const memberUserId = await seedMember(op.tenantId, 'member-mgmt@example.com');

    const promoted = toolResult(
      (await rpc(token, 'tools/call', {
        name: 'change_member_role',
        arguments: { tenantUserId: memberUserId, newRole: 'ADMIN' },
      })).body,
    );
    expect(promoted.isError).toBe(false);
    expect((promoted.data as { role: string }).role).toBe('ADMIN');

    const removed = toolResult(
      (await rpc(token, 'tools/call', {
        name: 'remove_member',
        arguments: { tenantUserId: memberUserId },
      })).body,
    );
    expect(removed.isError).toBe(false);
    const gone = await prisma.tenantMembership.findUnique({
      where: { tenantUserId_tenantId: { tenantUserId: memberUserId, tenantId: op.tenantId } },
    });
    expect(gone).toBeNull();
  });

  it('cannot manage a member in another workspace', async () => {
    const victim = await makeOperator('victim');
    const victimMember = await seedMember(victim.tenantId, 'victim-member@example.com');

    const attacker = await makeOperator('attacker');
    const attackerToken = await mintPat(attacker.accessToken, ['read', 'applications:write']);

    const attempt = toolResult(
      (await rpc(attackerToken, 'tools/call', {
        name: 'change_member_role',
        arguments: { tenantUserId: victimMember, newRole: 'ADMIN' },
      })).body,
    );
    expect(attempt.isError).toBe(true);
    expect((attempt.data as { error: string }).error).toMatch(/in this workspace/i);
  });

  it('cannot demote the last OWNER (guard fires through MCP)', async () => {
    const op = await makeOperator('lastowner');
    const token = await mintPat(op.accessToken, ['read', 'applications:write']);
    // The operator is the sole OWNER. Find their own tenantUserId via list_members.
    const members = toolResult((await rpc(token, 'tools/call', { name: 'list_members' })).body);
    const self = (members.data as { members: Array<{ tenantUserId: string; role: string }> }).members.find(
      (m) => m.role === 'OWNER',
    )!;

    const attempt = toolResult(
      (await rpc(token, 'tools/call', {
        name: 'change_member_role',
        arguments: { tenantUserId: self.tenantUserId, newRole: 'MEMBER' },
      })).body,
    );
    expect(attempt.isError).toBe(true);
    expect((attempt.data as { error: string }).error).toMatch(/owner/i);
  });
});
