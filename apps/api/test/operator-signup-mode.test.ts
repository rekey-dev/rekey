/**
 * OPERATOR_SIGNUP_MODE enforcement.
 *
 * The gate must hold at every NEW-operator creation path while never blocking
 * EXISTING operators from signing in. We cover:
 *   - open    → sign-up unchanged (today's behavior).
 *   - closed  → new sign-up rejected; an existing operator still signs in.
 *   - invite  → key required, single-use (consumed atomically), and a used or
 *               revoked key is refused.
 *
 * The mode is read live from process.env by the policy layer, so each test
 * flips it directly and restores it afterwards (the suite runs single-fork).
 */

import { afterAll, afterEach, beforeAll, expect, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('OPERATOR_SIGNUP_MODE', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    // Restore the default so other test files (which assume 'open') are unaffected.
    delete process.env.OPERATOR_SIGNUP_MODE;
  });

  function signUp(email: string, body: Record<string, unknown> = {}): Promise<import('light-my-request').Response> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName: 'Co', ...body },
    });
  }

  function mintInvite(body: Record<string, unknown> = {}): Promise<import('light-my-request').Response> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/admin/operator-invites',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload: body,
    });
  }

  // ---------- GET /signup-mode ----------

  it('GET /signup-mode advertises the active mode', async () => {
    process.env.OPERATOR_SIGNUP_MODE = 'invite';
    const r = await app.inject({ method: 'GET', url: '/api/v1/tenant/auth/signup-mode' });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.mode).toBe('invite');
  });

  // ---------- open (default) ----------

  it('open: sign-up succeeds with no invite key (unchanged behavior)', async () => {
    process.env.OPERATOR_SIGNUP_MODE = 'open';
    const r = await signUp('open-mode@example.com');
    expect(r.statusCode).toBe(201);
    expect(r.json().data.activeRole).toBe('OWNER');
  });

  it('open: an unset mode behaves as open', async () => {
    delete process.env.OPERATOR_SIGNUP_MODE;
    const r = await signUp('unset-mode@example.com');
    expect(r.statusCode).toBe(201);
  });

  // ---------- closed ----------

  it('closed: new sign-up is rejected with OPERATOR_SIGNUP_CLOSED', async () => {
    process.env.OPERATOR_SIGNUP_MODE = 'closed';
    const r = await signUp('blocked@example.com');
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('OPERATOR_SIGNUP_CLOSED');
    // Nothing was created.
    const u = await prisma.tenantUser.findUnique({ where: { email: 'blocked@example.com' } });
    expect(u).toBeNull();
  });

  it('closed: an existing operator can still sign in', async () => {
    // Create while open, then close and confirm sign-in still works.
    process.env.OPERATOR_SIGNUP_MODE = 'open';
    const created = await signUp('existing@example.com');
    expect(created.statusCode).toBe(201);

    process.env.OPERATOR_SIGNUP_MODE = 'closed';
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-in',
      payload: { email: 'existing@example.com', password: 'pw-one-two-three' },
    });
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json().data.activeRole).toBe('OWNER');
  });

  // ---------- invite ----------

  it('invite: sign-up with no key is refused (OPERATOR_INVITE_REQUIRED)', async () => {
    process.env.OPERATOR_SIGNUP_MODE = 'invite';
    const r = await signUp('needs-key@example.com');
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('OPERATOR_INVITE_REQUIRED');
  });

  it('invite: a bogus key is refused (OPERATOR_INVITE_INVALID)', async () => {
    process.env.OPERATOR_SIGNUP_MODE = 'invite';
    const r = await signUp('bad-key@example.com', { inviteKey: 'rp_opinv_not-a-real-key' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('OPERATOR_INVITE_INVALID');
  });

  it('invite: a valid key creates the operator and is consumed single-use', async () => {
    process.env.OPERATOR_SIGNUP_MODE = 'invite';
    const minted = await mintInvite({ note: 'for tester' });
    expect(minted.statusCode).toBe(201);
    const rawToken = minted.json().data.rawToken as string;
    const inviteId = minted.json().data.invite.id as string;
    expect(rawToken).toMatch(/^rp_opinv_/);

    // First use succeeds.
    const ok = await signUp('invited@example.com', { inviteKey: rawToken });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.user.email).toBe('invited@example.com');

    // The invite is now marked used + bound to the new operator.
    const row = await prisma.operatorInvite.findUnique({ where: { id: inviteId } });
    expect(row?.usedAt).not.toBeNull();
    expect(row?.usedByTenantUserId).not.toBeNull();

    // Second use of the SAME key is refused.
    const replay = await signUp('second@example.com', { inviteKey: rawToken });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('OPERATOR_INVITE_USED');
    const second = await prisma.tenantUser.findUnique({ where: { email: 'second@example.com' } });
    expect(second).toBeNull();
  });

  it('invite: two concurrent sign-ups racing one key → exactly one wins', async () => {
    process.env.OPERATOR_SIGNUP_MODE = 'invite';
    const minted = await mintInvite();
    const key = minted.json().data.rawToken as string;

    // Fire both at once. The atomic consume (updateMany WHERE usedAt IS NULL …,
    // count===1) must let exactly one through.
    const [a, b] = await Promise.all([
      signUp('race-a@example.com', { inviteKey: key }),
      signUp('race-b@example.com', { inviteKey: key }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);

    // Exactly one operator was created from this key.
    const created = await prisma.tenantUser.count({
      where: { email: { in: ['race-a@example.com', 'race-b@example.com'] } },
    });
    expect(created).toBe(1);
  });

  it('invite: a revoked key is refused (OPERATOR_INVITE_INVALID)', async () => {
    process.env.OPERATOR_SIGNUP_MODE = 'invite';
    const minted = await mintInvite();
    const rawToken = minted.json().data.rawToken as string;
    const inviteId = minted.json().data.invite.id as string;

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/operator-invites/${inviteId}`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().data.status).toBe('revoked');

    const r = await signUp('after-revoke@example.com', { inviteKey: rawToken });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('OPERATOR_INVITE_INVALID');
  });

  it('invite: a failed sign-up (duplicate email) does not burn the key', async () => {
    // Pre-create the email while open.
    process.env.OPERATOR_SIGNUP_MODE = 'open';
    await signUp('dupe@example.com');

    process.env.OPERATOR_SIGNUP_MODE = 'invite';
    const minted = await mintInvite();
    const rawToken = minted.json().data.rawToken as string;
    const inviteId = minted.json().data.invite.id as string;

    // Sign-up fails on duplicate email — the key must stay unused.
    const dup = await signUp('dupe@example.com', { inviteKey: rawToken });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('EMAIL_ALREADY_EXISTS');
    const row = await prisma.operatorInvite.findUnique({ where: { id: inviteId } });
    expect(row?.usedAt).toBeNull();

    // The key still works for a fresh email.
    const ok = await signUp('fresh@example.com', { inviteKey: rawToken });
    expect(ok.statusCode).toBe(201);
  });

  // ---------- admin guard ----------

  it('minting requires the SUPER_ADMIN_KEY', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/admin/operator-invites', payload: {} });
    expect(r.statusCode).toBe(401);
  });
});
