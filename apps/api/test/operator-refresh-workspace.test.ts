/**
 * An operator refresh keeps the workspace the session is in.
 *
 * It used to re-issue every refreshed session into the operator's OLDEST
 * membership: `tenant_refresh_tokens` had no workspace column, so an operator
 * who switched workspaces was moved back every time the access token expired.
 * The row now carries `activeTenantId`, set at sign-in, on a switch and on an
 * invitation accept, carried across rotations and re-checked against the
 * memberships on every refresh.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import jwt from 'jsonwebtoken';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashTenantRefreshToken } from '../src/lib/tenant-refresh-tokens.js';

const PASSWORD = 'pw-one-two-three';

interface Session {
  user: { id: string };
  activeTenantId: string;
  activeRole: string;
  accessToken: string;
  refreshToken: string;
}

describe('operator refresh keeps the active workspace', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const email = (tag: string): string => `${tag}-${Math.random().toString(36).slice(2, 10)}@example.com`;

  async function signUp(address: string, workspaceName: string): Promise<Session> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: address, password: PASSWORD, workspaceName },
    });
    expect(r.statusCode).toBe(201);
    return r.json().data as Session;
  }

  function refresh(refreshToken: string): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'POST', url: '/api/v1/tenant/auth/refresh', payload: { refreshToken } });
  }

  async function refreshOk(refreshToken: string): Promise<Session> {
    const r = await refresh(refreshToken);
    expect(r.statusCode).toBe(200);
    return r.json().data as Session;
  }

  const tid = (accessToken: string): unknown => (jwt.decode(accessToken) as { tid?: unknown }).tid;

  const rowTenant = async (raw: string): Promise<string | null> =>
    (await prisma.tenantRefreshToken.findUniqueOrThrow({ where: { tokenHash: hashTenantRefreshToken(raw) } }))
      .activeTenantId;

  /**
   * An operator whose OLDEST workspace is A, who was then invited into B as an
   * ADMIN. Returns the session the accept issued (in B) and the ids.
   */
  async function operatorInTwoWorkspaces(): Promise<{
    home: Session;
    joined: Session;
    workspaceA: string;
    workspaceB: string;
    ownerOfB: Session;
  }> {
    const address = email('multi');
    const home = await signUp(address, 'A Co');
    const ownerOfB = await signUp(email('owner-b'), 'B Co');
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: { authorization: `Bearer ${ownerOfB.accessToken}` },
      payload: { email: address, role: 'ADMIN' },
    });
    expect(invite.statusCode).toBe(201);
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${home.accessToken}` },
      payload: { token: (invite.json().data as { token: string }).token },
    });
    expect(accept.statusCode).toBeLessThan(300);
    const joined = accept.json().data as Session;
    return { home, joined, workspaceA: home.activeTenantId, workspaceB: ownerOfB.activeTenantId, ownerOfB };
  }

  async function switchTo(accessToken: string, tenantId: string): Promise<Session> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/switch-workspace',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { tenantId },
    });
    expect(r.statusCode).toBe(200);
    return r.json().data as Session;
  }

  it('a switched session stays in the workspace it switched to, across rotations', async () => {
    const { home, workspaceB } = await operatorInTwoWorkspaces();
    const switched = await switchTo(home.accessToken, workspaceB);
    expect(await rowTenant(switched.refreshToken)).toBe(workspaceB);

    let current = switched;
    for (let i = 0; i < 3; i++) {
      current = await refreshOk(current.refreshToken);
      expect(current.activeTenantId).toBe(workspaceB);
      expect(current.activeRole).toBe('ADMIN');
      expect(tid(current.accessToken)).toBe(workspaceB);
      expect(await rowTenant(current.refreshToken)).toBe(workspaceB);
    }
  });

  it('the session an invitation accept issues refreshes into the joined workspace', async () => {
    const { joined, workspaceB } = await operatorInTwoWorkspaces();
    expect(await rowTenant(joined.refreshToken)).toBe(workspaceB);
    const next = await refreshOk(joined.refreshToken);
    expect(next.activeTenantId).toBe(workspaceB);
    expect(tid(next.accessToken)).toBe(workspaceB);
  });

  it('a plain sign-in session still refreshes into the oldest workspace', async () => {
    const { home, workspaceA } = await operatorInTwoWorkspaces();
    expect(await rowTenant(home.refreshToken)).toBe(workspaceA);
    const next = await refreshOk(home.refreshToken);
    expect(next.activeTenantId).toBe(workspaceA);
    expect(next.activeRole).toBe('OWNER');
  });

  it('removed from the active workspace: refresh falls back to the oldest one and moves the row', async () => {
    const { home, workspaceA, workspaceB, ownerOfB } = await operatorInTwoWorkspaces();
    const switched = await switchTo(home.accessToken, workspaceB);

    const membership = await prisma.tenantMembership.findFirstOrThrow({
      where: { tenantUserId: home.user.id, tenantId: workspaceB },
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/workspace/members/${membership.id}`,
      headers: { authorization: `Bearer ${ownerOfB.accessToken}` },
    });
    expect(removed.statusCode).toBeLessThan(300);

    const next = await refreshOk(switched.refreshToken);
    expect(next.activeTenantId).toBe(workspaceA);
    expect(tid(next.accessToken)).toBe(workspaceA);
    expect(await rowTenant(next.refreshToken)).toBe(workspaceA);
  });

  it('a row from before the column existed refreshes into the oldest workspace and is backfilled', async () => {
    const { home, workspaceA, workspaceB } = await operatorInTwoWorkspaces();
    const switched = await switchTo(home.accessToken, workspaceB);
    await prisma.tenantRefreshToken.update({
      where: { tokenHash: hashTenantRefreshToken(switched.refreshToken) },
      data: { activeTenantId: null },
    });

    const next = await refreshOk(switched.refreshToken);
    expect(next.activeTenantId).toBe(workspaceA);
    expect(await rowTenant(next.refreshToken)).toBe(workspaceA);
  });

  // A replay's security event carries the replaying request's IP and user
  // agent, and every owner of the workspace it names can read it. It used to
  // name the operator's OLDEST workspace, whose owner had nothing to do with
  // a session running in another one.
  describe('a replayed token is reported in the workspace the session was in', () => {
    const replayEvents = (type: string, actorId: string) =>
      prisma.securityEvent.findMany({ where: { type, actorId }, orderBy: { createdAt: 'asc' } });

    it('raced and reused events land in the active workspace, not the oldest', async () => {
      const { home, workspaceB } = await operatorInTwoWorkspaces();
      const switched = await switchTo(home.accessToken, workspaceB);
      const next = await refreshOk(switched.refreshToken);

      // Inside the reuse window, successor unused: RACED.
      const raced = await refresh(switched.refreshToken);
      expect(raced.json().error.code).toBe('REFRESH_TOKEN_RACED');
      const [racedEvent] = await replayEvents('operator.refresh_token_raced', home.user.id);
      expect(racedEvent?.tenantId).toBe(workspaceB);

      // The chain moves on, then the old token comes back: REUSED.
      await refreshOk(next.refreshToken);
      const reused = await refresh(switched.refreshToken);
      expect(reused.json().error.code).toBe('REFRESH_TOKEN_REUSED');
      const [reusedEvent] = await replayEvents('operator.refresh_token_reused', home.user.id);
      expect(reusedEvent?.tenantId).toBe(workspaceB);
    });

    it('removed from that workspace since: the event falls back to the oldest one', async () => {
      const { home, workspaceA, workspaceB, ownerOfB } = await operatorInTwoWorkspaces();
      const switched = await switchTo(home.accessToken, workspaceB);
      await refreshOk(switched.refreshToken);
      const membership = await prisma.tenantMembership.findFirstOrThrow({
        where: { tenantUserId: home.user.id, tenantId: workspaceB },
      });
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/v1/tenant/workspace/members/${membership.id}`,
        headers: { authorization: `Bearer ${ownerOfB.accessToken}` },
      });
      expect(removed.statusCode).toBeLessThan(300);

      await refresh(switched.refreshToken);
      const [event] = await prisma.securityEvent.findMany({
        where: {
          actorId: home.user.id,
          type: { in: ['operator.refresh_token_raced', 'operator.refresh_token_reused'] },
        },
      });
      expect(event?.tenantId).toBe(workspaceA);
    });
  });

  it('deleting the active workspace nulls the column rather than blocking the delete', async () => {
    const { home, workspaceB } = await operatorInTwoWorkspaces();
    const switched = await switchTo(home.accessToken, workspaceB);
    await prisma.tenant.delete({ where: { id: workspaceB } });
    expect(await rowTenant(switched.refreshToken)).toBeNull();
  });
});
