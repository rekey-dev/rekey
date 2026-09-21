/**
 * Scopes on the membership, the gate, the editing, the capabilities.
 *
 * What is pinned here, and why each one matters:
 *
 *   - Nothing changes until an admin restricts somebody. A member with a full
 *     grant and untouched scopes reaches everything they reached before.
 *   - Restriction is refused with a code that names the scope, on an
 *     application the member CAN see. On one they cannot, the answer stays
 *     404, a scope refusal must never become an existence oracle.
 *   - Unknown scopes are refused, never silently dropped.
 *   - Scopes only apply to MEMBER; an OWNER is untouched and an ADMIN cannot
 *     be restricted.
 *   - `/me` and `GET /:id` report the resolved set the panel renders from,
 *     and `GET /:id` projects sign-in config on the auth-config scope.
 *   - The intersection: a member whose GRANT is APP_VIEWER but whose scopes
 *     include billing:write still cannot write billing, neither axis widens
 *     the other.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { flushApiRequestLogs } from '../src/lib/request-log.js';

describe('operator scopes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  let currentIp = '10.97.0.1';
  function inject(opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: currentIp, ...opts } as never);
  }
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  /**
   * The membership `/me` reports for the ACTIVE workspace. The invitee owns a
   * workspace of their own from sign-up, so `memberships` has two entries and
   * `[0]` is the wrong one, it is theirs (OWNER, unrestricted), not the one
   * they were invited into.
   */
  const activeMembership = (
    data: unknown,
  ): { tenantId: string; role: string; scopes: string[] | null } => {
    const d = data as {
      activeTenantId: string;
      memberships: Array<{ tenantId: string; role: string; scopes: string[] | null }>;
    };
    return d.memberships.find((m) => m.tenantId === d.activeTenantId)!;
  };

  interface World {
    ownerToken: string;
    memberToken: string;
    membershipId: string;
    appId: string;
    otherAppId: string;
  }

  /** Owner + two apps + one MEMBER holding APP_ADMIN on the first app only. */
  async function world(grant: 'APP_ADMIN' | 'APP_VIEWER' = 'APP_ADMIN'): Promise<World> {
    currentIp = `10.97.${++n}.1`;
    const tag = `sc-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `owner-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: 'Scopes Co' },
    });
    expect(su.statusCode).toBe(201);
    const ownerToken = (su.json().data as { accessToken: string }).accessToken;

    const mk = async (slug: string) => {
      const r = await inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: auth(ownerToken),
        payload: { name: slug, slug },
      });
      expect(r.statusCode).toBe(201);
      return (r.json().data as { id: string }).id;
    };
    const appId = await mk(`${tag}-a`);
    const otherAppId = await mk(`${tag}-b`);

    // Accepting an invitation is a signed-in act: the invitee has their own
    // operator account (and, on sign-up, their own workspace) first.
    const invitee = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `member-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: 'Member Own Co' },
    });
    expect(invitee.statusCode).toBe(201);
    const inviteeToken = (invitee.json().data as { accessToken: string }).accessToken;

    const inv = await inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: auth(ownerToken),
      payload: { email: `member-${tag}@example.com`, role: 'MEMBER' },
    });
    expect(inv.statusCode).toBe(201);
    const token = (inv.json().data as { token: string }).token;
    const acc = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: auth(inviteeToken),
      payload: { token },
    });
    expect(acc.statusCode).toBe(200);
    // The accept response carries a session already switched to the invited workspace.
    const memberToken = (acc.json().data as { accessToken: string }).accessToken;

    const members = await inject({ method: 'GET', url: '/api/v1/tenant/workspace/members', headers: auth(ownerToken) });
    const membershipId = (
      members.json().data as { items: Array<{ membershipId: string; role: string }> }
    ).items.find((m) => m.role === 'MEMBER')!.membershipId;

    const g = await inject({
      method: 'PUT',
      url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
      headers: auth(ownerToken),
      payload: { applicationId: appId, role: grant },
    });
    expect(g.statusCode).toBe(200);
    return { ownerToken, memberToken, membershipId, appId, otherAppId };
  }

  const setScopes = (w: World, scopes: string[] | null) =>
    inject({
      method: 'PATCH',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
      headers: auth(w.ownerToken),
      payload: { scopes },
    });
  const plans = (w: World, appId = w.appId) =>
    inject({ method: 'GET', url: `/api/v1/tenant/applications/${appId}/plans`, headers: auth(w.memberToken) });
  const endUsers = (w: World) =>
    inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/end-users`, headers: auth(w.memberToken) });

  it('changes nothing until somebody is restricted', async () => {
    const w = await world();
    expect((await plans(w)).statusCode).toBe(200);
    expect((await endUsers(w)).statusCode).toBe(200);
    const me = await inject({ method: 'GET', url: '/api/v1/tenant/auth/me', headers: auth(w.memberToken) });
    expect(activeMembership(me.json().data).scopes).toBeNull();
  });

  it('refuses by scope on a visible application, and stays 404 on an invisible one', async () => {
    const w = await world();
    const set = await setScopes(w, ['end-users:write']);
    expect(set.statusCode).toBe(200);
    expect((set.json().data as { scopes: string[] }).scopes).toEqual(['end-users:write']);

    const refused = await plans(w);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('SCOPE_INSUFFICIENT');
    expect(refused.json().error.message).toContain('billing:read');

    // Still reaches what the scope allows.
    expect((await endUsers(w)).statusCode).toBe(200);

    // An application with no grant is ABSENT, not forbidden, the scope
    // gate runs after the existence check and cannot leak past it.
    const invisible = await plans(w, w.otherAppId);
    expect(invisible.statusCode).toBe(404);
    expect(invisible.json().error.code).toBe('APPLICATION_NOT_FOUND');
  });

  it('write implies read; a read scope does not imply write', async () => {
    const w = await world();
    await setScopes(w, ['end-users:read']);
    expect((await endUsers(w)).statusCode).toBe(200);
    const create = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.appId}/end-users`,
      headers: auth(w.memberToken),
      payload: { email: 'x@example.com', password: 'pw-one-two-three' },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().error.code).toBe('SCOPE_INSUFFICIENT');
    expect(create.json().error.message).toContain('end-users:write');
  });

  it('neither axis widens the other: APP_VIEWER grant ∩ billing:write scope is still read-only', async () => {
    const w = await world('APP_VIEWER');
    await setScopes(w, ['billing:write']);
    expect((await plans(w)).statusCode).toBe(200);
    const create = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.appId}/plans`,
      headers: auth(w.memberToken),
      payload: { slug: 'p', name: 'P', amount: 100, kind: 'SUBSCRIPTION', interval: 'MONTH' },
    });
    // The GRANT refuses first, APP_VIEWER cannot billing-write, and the
    // scope, being an intersection, cannot override that.
    expect(create.statusCode).toBe(403);
    expect(create.json().error.code).toBe('APP_ACCESS_DENIED');
  });

  it('unknown scopes are refused, naming them, and nothing is stored', async () => {
    const w = await world();
    const bad = await setScopes(w, ['billing:read', 'team:write', 'billing:both']);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('SCOPE_INVALID');
    expect(bad.json().error.message).toContain('team:write');
    expect(bad.json().error.message).toContain('billing:both');
    // Nothing changed.
    expect((await plans(w)).statusCode).toBe(200);
  });

  it('null lifts the restriction', async () => {
    const w = await world();
    await setScopes(w, []);
    expect((await plans(w)).statusCode).toBe(403);
    const lifted = await setScopes(w, null);
    expect(lifted.statusCode).toBe(200);
    expect((lifted.json().data as { scopes: unknown }).scopes).toBeNull();
    expect((await plans(w)).statusCode).toBe(200);
  });

  it('scopes apply to MEMBER only; an ADMIN cannot be restricted', async () => {
    const w = await world();
    const promote = await inject({
      method: 'PATCH',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
      headers: auth(w.ownerToken),
      payload: { role: 'ADMIN' },
    });
    expect(promote.statusCode).toBe(200);
    const r = await setScopes(w, ['end-users:read']);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SCOPES_MEMBER_ONLY');
  });

  it('a member cannot reach the route that would let them edit scopes', async () => {
    const w = await world();
    const r = await inject({
      method: 'PATCH',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
      headers: auth(w.memberToken),
      payload: { scopes: null },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
  });

  it('/me and GET /:id report the resolved set, and /:id projects sign-in config on it', async () => {
    const w = await world();
    await setScopes(w, ['end-users:write', 'billing:read']);

    const me = await inject({ method: 'GET', url: '/api/v1/tenant/auth/me', headers: auth(w.memberToken) });
    const mine = activeMembership(me.json().data);
    // Resolved: write implied read, sorted.
    expect(mine.scopes).toEqual(['billing:read', 'end-users:read', 'end-users:write']);

    const detail = await inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}`,
      headers: auth(w.memberToken),
    });
    expect(detail.statusCode).toBe(200);
    const data = detail.json().data as {
      access: { level: string; scopes: string[] };
      authConfig: Record<string, unknown>;
      oauthConfig: Record<string, unknown>;
    };
    expect(data.access.level).toBe('APP_ADMIN');
    expect(data.access.scopes).toEqual(['billing:read', 'end-users:read', 'end-users:write']);
    // No auth-config scope → sign-in config redacted, exactly as APP_BILLING always was.
    expect(data.authConfig).toEqual({});
    expect(data.oauthConfig).toEqual({});

    // The owner is unrestricted and sees everything.
    const asOwner = await inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}`,
      headers: auth(w.ownerToken),
    });
    const od = asOwner.json().data as { access: { level: string; scopes: string[] }; authConfig: Record<string, unknown> };
    expect(od.access.level).toBe('workspace-admin');
    expect(od.access.scopes.length).toBe(14);
    expect(Object.keys(od.authConfig).length).toBeGreaterThan(0);
  });

  // ---------- the two projections and the filter refusal (WS6) ----------

  it('the roster shows a member their teammates, not their permissions', async () => {
    const w = await world();
    await setScopes(w, ['end-users:read']);

    const asMember = await inject({
      method: 'GET',
      url: '/api/v1/tenant/workspace/members',
      headers: auth(w.memberToken),
    });
    expect(asMember.statusCode).toBe(200);
    const rows = (asMember.json().data as { items: Array<Record<string, unknown>> }).items;
    expect(rows.length).toBe(2);
    // This route used to hand every member's grant matrix to any session,
    // a member learned their own permissions by listing their colleagues'.
    for (const r of rows) {
      expect(r).not.toHaveProperty('grants');
      expect(r).not.toHaveProperty('scopes');
      expect(r).toHaveProperty('email');
    }

    const asOwner = await inject({
      method: 'GET',
      url: '/api/v1/tenant/workspace/members',
      headers: auth(w.ownerToken),
    });
    const member = (asOwner.json().data as { items: Array<{ role: string; grants: unknown[]; scopes: unknown }> }).items.find(
      (m) => m.role === 'MEMBER',
    )!;
    expect(member.grants.length).toBe(1);
    expect(member.scopes).toEqual(['end-users:read']);
  });

  it('the subscription-status filter is refused without billing:read, not silently ignored', async () => {
    const w = await world();
    await setScopes(w, ['end-users:read']);
    const filtered = await inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}/end-users?subscriptionStatus=ACTIVE`,
      headers: auth(w.memberToken),
    });
    // 403 naming the scope, the same code every other scope refusal uses.
    // Dropping the filter would return an unfiltered list the caller reads
    // as "everyone who is paying".
    expect(filtered.statusCode).toBe(403);
    expect(filtered.json().error.code).toBe('SCOPE_INSUFFICIENT');
    expect(filtered.json().error.message).toContain('billing:read');

    // The unfiltered list is still theirs.
    expect((await endUsers(w)).statusCode).toBe(200);

    // With the scope, the filter works.
    await setScopes(w, ['end-users:read', 'billing:read']);
    const ok = await inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}/end-users?subscriptionStatus=ACTIVE`,
      headers: auth(w.memberToken),
    });
    expect(ok.statusCode).toBe(200);
  });

  // ---------- the request log records the admitting scope (WS7) ----------

  it('the request log records which scope admitted a write', async () => {
    const w = await world();
    await setScopes(w, ['end-users:write']);
    const me = await inject({ method: 'GET', url: '/api/v1/tenant/auth/me', headers: auth(w.memberToken) });
    const operatorUserId = (me.json().data as { user: { id: string } }).user.id;

    const create = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.appId}/end-users`,
      headers: auth(w.memberToken),
      payload: { email: `logged-${Math.random().toString(36).slice(2, 7)}@example.com`, password: 'pw-one-two-three' },
    });
    expect(create.statusCode).toBe(201);

    // The log is buffered and flushed on a timer; flush it now.
    await flushApiRequestLogs();
    const row = await prisma.apiRequestLog.findFirst({
      where: { operatorUserId, method: 'POST', admittedScope: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    // With three roles, "who" implied "what they were allowed to do". With
    // scopes it does not, the set changes, so the log keeps the authority
    // the write ran under, and it survives the membership being edited later.
    expect(row?.admittedScope).toBe('end-users:write');
    // And it reaches a client: the read schema declares the column, so the
    // serializer keeps it. It was dropped, unnoticed, until the panel tried
    // to render it.
    const mine = await inject({ method: 'GET', url: '/api/v1/tenant/auth/requests?limit=50', headers: auth(w.memberToken) });
    expect(mine.statusCode).toBe(200);
    const items = (mine.json().data as { items: Array<{ id: string; admittedScope?: string | null }> }).items;
    expect(items.find((r) => r.id === row!.id)?.admittedScope).toBe('end-users:write');
    await setScopes(w, null);
    const again = await prisma.apiRequestLog.findUnique({ where: { id: row!.id } });
    expect(again?.admittedScope).toBe('end-users:write');
  });
});
