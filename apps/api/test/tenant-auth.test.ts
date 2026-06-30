/**
 * Operator (TenantUser) auth + workspace memberships + invitations +
 * tenant-scoped admin.
 *
 * The cross-tenant guard is the load-bearing assertion: an operator must
 * never see/touch resources owned by a Tenant they don't belong to.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

interface SignupResult {
  user: { id: string; email: string };
  memberships: Array<{ tenantId: string; tenantName: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' }>;
  activeTenantId: string;
  activeRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  accessToken: string;
  refreshToken: string;
}

describe('tenant-auth + workspaces', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signUp(email: string, workspaceName: string): Promise<SignupResult> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName },
    });
    expect(r.statusCode).toBe(201);
    return r.json().data as SignupResult;
  }

  async function signIn(email: string, password = 'pw-one-two-three'): Promise<SignupResult> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-in',
      payload: { email, password },
    });
    expect(r.statusCode).toBe(200);
    return r.json().data as SignupResult;
  }

  beforeEach(async () => {
    // truncated by setup.ts
  });

  // ---------- sign-up + sign-in ----------

  it('sign-up creates user + tenant + OWNER membership atomically', async () => {
    const res = await signUp('alice@example.com', 'Alice Co');
    expect(res.user.email).toBe('alice@example.com');
    expect(res.memberships).toHaveLength(1);
    expect(res.memberships[0]!.role).toBe('OWNER');
    expect(res.memberships[0]!.tenantName).toBe('Alice Co');
    expect(res.activeTenantId).toBe(res.memberships[0]!.tenantId);
    expect(res.activeRole).toBe('OWNER');
  });

  it('sign-up rejects duplicate email', async () => {
    await signUp('dup@example.com', 'A');
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: 'dup@example.com', password: 'pw-one-two-three', workspaceName: 'B' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  it('sign-in returns memberships + an active session', async () => {
    await signUp('bob@example.com', 'Bob Co');
    const res = await signIn('bob@example.com');
    expect(res.user.email).toBe('bob@example.com');
    expect(res.activeRole).toBe('OWNER');
  });

  it('sign-in with wrong password → INVALID_CREDENTIALS', async () => {
    await signUp('carol@example.com', 'Carol Co');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-in',
      payload: { email: 'carol@example.com', password: 'WRONG' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  // ---------- /me ----------

  it('GET /tenant/auth/me returns current user + memberships + active workspace', async () => {
    const session = await signUp('dan@example.com', 'Dan Co');
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(r.statusCode).toBe(200);
    const data = r.json().data as {
      user: { email: string };
      activeTenantId: string;
      activeRole: string;
    };
    expect(data.user.email).toBe('dan@example.com');
    expect(data.activeTenantId).toBe(session.activeTenantId);
    expect(data.activeRole).toBe('OWNER');
  });

  it('GET /me without bearer → TENANT_SESSION_MISSING', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/tenant/auth/me' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('TENANT_SESSION_MISSING');
  });

  it('operator account locks after repeated failed sign-ins (TOO_MANY_FAILED_ATTEMPTS)', async () => {
    await signUp('lockout-op@example.com', 'Lock Co');
    // 10 wrong-password attempts: each 401 INVALID_CREDENTIALS; the 10th arms the lock.
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-in',
        payload: { email: 'lockout-op@example.com', password: 'wrong-password' },
      });
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('INVALID_CREDENTIALS');
    }
    // Now locked — even the CORRECT password is refused with 429 + Retry-After.
    const locked = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-in',
      payload: { email: 'lockout-op@example.com', password: 'pw-one-two-three' },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('TOO_MANY_FAILED_ATTEMPTS');
    expect(locked.headers['retry-after']).toBeDefined();
  });

  // ---------- invitations + multi-tenant ----------

  async function createInvite(
    inviterAccessToken: string,
    email: string,
    role: 'ADMIN' | 'MEMBER' | 'OWNER' = 'MEMBER',
  ): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: { authorization: `Bearer ${inviterAccessToken}` },
      payload: { email, role },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { token: string }).token;
  }

  it('OWNER invites + invitee accepts → membership exists in their list', async () => {
    const owner = await signUp('owner@example.com', 'Owner Co');
    const invitee = await signUp('invitee@example.com', 'Invitee Co');
    const token = await createInvite(owner.accessToken, 'invitee@example.com', 'ADMIN');

    // Preview is unauthenticated.
    const preview = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/invitations/preview?token=${encodeURIComponent(token)}`,
    });
    expect(preview.statusCode).toBe(200);
    const previewData = preview.json().data as { tenantName: string; role: string };
    expect(previewData.tenantName).toBe('Owner Co');
    expect(previewData.role).toBe('ADMIN');

    // Accept while signed in as the invitee.
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${invitee.accessToken}` },
      payload: { token },
    });
    expect(accept.statusCode).toBe(200);
    const acceptData = accept.json().data as { accessToken: string };

    // The new session is scoped to the joined workspace.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/me',
      headers: { authorization: `Bearer ${acceptData.accessToken}` },
    });
    const meData = me.json().data as {
      memberships: Array<{ tenantName: string; role: string }>;
      activeTenantId: string;
    };
    expect(meData.memberships.map((m) => m.tenantName).sort()).toEqual(['Invitee Co', 'Owner Co']);
    expect(meData.activeTenantId).toBe(owner.activeTenantId);
  });

  it('replaying an accepted invitation → INVITATION_NOT_USABLE', async () => {
    const owner = await signUp('o2@example.com', 'O2');
    const invitee = await signUp('i2@example.com', 'I2');
    const token = await createInvite(owner.accessToken, 'i2@example.com');

    await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${invitee.accessToken}` },
      payload: { token },
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${invitee.accessToken}` },
      payload: { token },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe('INVITATION_NOT_USABLE');
  });

  it('a different operator cannot accept an invite issued to someone else (INVITATION_EMAIL_MISMATCH)', async () => {
    const owner = await signUp('o-bind@example.com', 'Bind Co');
    // Invite is issued to alice, but mallory (a different account) holds the link.
    const alice = await signUp('alice-bind@example.com', 'Alice Co');
    const mallory = await signUp('mallory-bind@example.com', 'Mallory Co');
    const token = await createInvite(owner.accessToken, 'alice-bind@example.com', 'OWNER');

    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${mallory.accessToken}` },
      payload: { token },
    });
    expect(accept.statusCode).toBe(403);
    expect(accept.json().error.code).toBe('INVITATION_EMAIL_MISMATCH');

    // The invite is still usable by the correct invitee (not burned by the
    // failed attempt).
    const good = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { token },
    });
    expect(good.statusCode).toBe(200);
  });

  it('MEMBER cannot create invitations (TENANT_ROLE_INSUFFICIENT)', async () => {
    const owner = await signUp('o3@example.com', 'O3');
    const member = await signUp('m3@example.com', 'M3');
    const token = await createInvite(owner.accessToken, 'm3@example.com', 'MEMBER');
    // Accept to become a MEMBER of O3.
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${member.accessToken}` },
      payload: { token },
    });
    const memberSessionInOwnerWorkspace = (accept.json().data as { accessToken: string }).accessToken;

    // Try to invite from the MEMBER session.
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: { authorization: `Bearer ${memberSessionInOwnerWorkspace}` },
      payload: { email: 'someone@example.com', role: 'MEMBER' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
  });

  // ---------- switch-workspace ----------

  it('switch-workspace mints tokens scoped to the target tenant', async () => {
    const a = await signUp('multi@example.com', 'A Co');
    const b = await signUp('inv@example.com', 'B Co');
    const token = await createInvite(b.accessToken, 'multi@example.com', 'ADMIN');

    // Accept B Co's invite.
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { token },
    });
    const sessionInB = (accept.json().data as { accessToken: string }).accessToken;

    // Switch back to A Co.
    const switched = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/switch-workspace',
      headers: { authorization: `Bearer ${sessionInB}` },
      payload: { tenantId: a.activeTenantId },
    });
    expect(switched.statusCode).toBe(200);
    const data = switched.json().data as { activeTenantId: string; activeRole: string };
    expect(data.activeTenantId).toBe(a.activeTenantId);
    expect(data.activeRole).toBe('OWNER');

    // Switch to a tenant the user isn't a member of → NOT_A_MEMBER.
    const stranger = await signUp('stranger@example.com', 'Stranger Co');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/switch-workspace',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { tenantId: stranger.activeTenantId },
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe('NOT_A_MEMBER');
  });

  // ---------- tenant-scoped applications ----------

  it('CROSS-TENANT GUARD: cannot read another workspace\'s Application', async () => {
    const a = await signUp('a-app@example.com', 'A Co');
    const b = await signUp('b-app@example.com', 'B Co');

    // A creates an app.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { name: 'A app', slug: `a-app-${Date.now()}` },
    });
    expect(created.statusCode).toBe(201);
    const aAppId = (created.json().data as { id: string }).id;

    // A can read it.
    const aRead = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${aAppId}`,
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(aRead.statusCode).toBe(200);

    // B cannot.
    const bRead = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${aAppId}`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(bRead.statusCode).toBe(404);
    expect(bRead.json().error.code).toBe('APPLICATION_NOT_FOUND');
  });

  it('CROSS-TENANT GUARD: list returns only the active workspace\'s apps', async () => {
    const a = await signUp('list-a@example.com', 'List A');
    const b = await signUp('list-b@example.com', 'List B');
    await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${a.accessToken}` },
      payload: { name: 'A1', slug: `list-a-${Date.now()}` },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${b.accessToken}` },
      payload: { name: 'B1', slug: `list-b-${Date.now()}` },
    });

    const aList = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    const bList = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    const aSlugs = (aList.json().data as Array<{ slug: string }>).map((x) => x.slug);
    const bSlugs = (bList.json().data as Array<{ slug: string }>).map((x) => x.slug);
    expect(aSlugs.some((s) => s.startsWith('list-a-'))).toBe(true);
    expect(aSlugs.some((s) => s.startsWith('list-b-'))).toBe(false);
    expect(bSlugs.some((s) => s.startsWith('list-b-'))).toBe(true);
    expect(bSlugs.some((s) => s.startsWith('list-a-'))).toBe(false);
  });

  // ---------- last owner protection ----------

  it('cannot remove the last OWNER of a workspace', async () => {
    const owner = await signUp('only-owner@example.com', 'OnlyOwner Co');
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/workspace/members',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const membershipId = (me.json().data as Array<{ membershipId: string }>)[0]!.membershipId;

    const r = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/workspace/members/${membershipId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('CANNOT_REMOVE_LAST_OWNER');
  });
});
