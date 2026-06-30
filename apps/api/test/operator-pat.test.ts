/**
 * Operator personal-access-tokens (PATs).
 *
 * A long-lived, revocable, SCOPED `rp_op_…` credential that lets an operator
 * (or an AI agent acting as them) call tenant-scoped routes without a session
 * JWT — replacing reliance on the global SUPER_ADMIN_KEY.
 *
 * The load-bearing cases are the security ones:
 *   - mint → use: a PAT-authed call to a real tenant endpoint succeeds.
 *   - scope enforcement: a read-only PAT cannot mint API keys (403).
 *   - revoke: a revoked PAT is refused (401), effective immediately.
 *   - expiry: an expired PAT is refused (401).
 *   - redaction: listing tokens never leaks the hash, and the raw token is
 *     shown exactly once (at mint).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashKey } from '../src/lib/keys.js';

interface OperatorSession {
  accessToken: string;
  tenantId: string;
  userId: string;
}

describe('Operator personal-access-tokens (PATs)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  /** Sign up an operator (creates a tenant + OWNER membership) and return a session. */
  async function makeOperator(slug: string): Promise<OperatorSession> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `pat-${slug}@example.com`,
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

  /** Create an Application in the operator's workspace via their session. */
  async function makeApp(session: OperatorSession, slug: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { name: `App ${slug}`, slug },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { id: string }).id;
  }

  /** Mint a PAT for the operator with the given scopes. Returns the raw token + id. */
  async function mintPat(
    session: OperatorSession,
    scopes: string[],
    opts: { name?: string } = {},
  ): Promise<{ rawToken: string; id: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { name: opts.name ?? 'agent', scopes },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { apiToken: { id: string }; rawToken: string };
    return { rawToken: data.rawToken, id: data.apiToken.id };
  }

  // ---------------------------------------------------------------------------

  it('mint → use: a PAT with keys:mint can mint an Application API key', async () => {
    const op = await makeOperator('mint-use');
    const appId = await makeApp(op, 'mint-use-app');
    const { rawToken } = await mintPat(op, ['keys:mint']);

    // The raw token is the rp_op_ format and is only ever returned here.
    expect(rawToken.startsWith('rp_op_')).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/operator/applications/${appId}/api-keys`,
      headers: { authorization: `Bearer ${rawToken}` },
      payload: { name: 'minted-by-pat', mode: 'test' },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { apiKey: { id: string }; rawKey: string };
    expect(data.rawKey.startsWith('rp_test_')).toBe(true);

    // The key really landed under the operator's application.
    const row = await prisma.apiKey.findUnique({ where: { id: data.apiKey.id } });
    expect(row?.applicationId).toBe(appId);
  });

  it('mint → use: a PAT can call a read endpoint with the read scope', async () => {
    const op = await makeOperator('read');
    await makeApp(op, 'read-app');
    const { rawToken } = await mintPat(op, ['read']);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/operator/applications',
      headers: { authorization: `Bearer ${rawToken}` },
    });
    expect(res.statusCode).toBe(200);
    const apps = res.json().data as Array<{ slug: string }>;
    expect(apps.map((a) => a.slug)).toContain('read-app');
  });

  it('scope enforcement: a read-only PAT cannot mint API keys → 403', async () => {
    const op = await makeOperator('scope');
    const appId = await makeApp(op, 'scope-app');
    // Default-deny: read scope only.
    const { rawToken } = await mintPat(op, ['read']);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/operator/applications/${appId}/api-keys`,
      headers: { authorization: `Bearer ${rawToken}` },
      payload: { name: 'should-fail', mode: 'test' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('OPERATOR_SCOPE_INSUFFICIENT');
    // No key was created.
    expect(await prisma.apiKey.count({ where: { applicationId: appId } })).toBe(0);
  });

  it('default-deny: omitting scopes at mint yields read-only (cannot mint keys)', async () => {
    const op = await makeOperator('default-deny');
    const appId = await makeApp(op, 'default-deny-app');

    // Mint with an empty scopes array → service defaults to ['read'].
    const mintRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${op.accessToken}` },
      payload: { name: 'no-scopes', scopes: [] },
    });
    expect(mintRes.statusCode).toBe(201);
    const minted = mintRes.json().data as { apiToken: { scopes: string[] }; rawToken: string };
    expect(minted.apiToken.scopes).toEqual(['read']);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/operator/applications/${appId}/api-keys`,
      headers: { authorization: `Bearer ${minted.rawToken}` },
      payload: { name: 'nope', mode: 'test' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('OPERATOR_SCOPE_INSUFFICIENT');
  });

  it('mint with a past expiresAt is rejected (400) — no dead-on-arrival PAT', async () => {
    const op = await makeOperator('past-exp-pat');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${op.accessToken}` },
      payload: { name: 'past', scopes: ['read'], expiresAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('OPERATOR_TOKEN_EXPIRY_IN_PAST');
    // Nothing was persisted for this operator.
    expect(await prisma.tenantApiToken.count({ where: { tenantUserId: op.userId } })).toBe(0);
  });

  it('minting an Application API key with a past expiresAt is rejected (400)', async () => {
    const op = await makeOperator('past-exp-key');
    const appId = await makeApp(op, 'past-exp-key-app');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/api-keys`,
      headers: { authorization: `Bearer ${op.accessToken}` },
      payload: { name: 'dead', mode: 'live', expiresAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('API_KEY_EXPIRY_IN_PAST');
    // No key landed under the application.
    expect(await prisma.apiKey.count({ where: { applicationId: appId } })).toBe(0);
  });

  it('revoke: a revoked PAT is refused (401), effective immediately', async () => {
    const op = await makeOperator('revoke');
    const appId = await makeApp(op, 'revoke-app');
    const { rawToken, id } = await mintPat(op, ['keys:mint']);

    // Works before revocation.
    const before = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/operator/applications/${appId}/api-keys`,
      headers: { authorization: `Bearer ${rawToken}` },
      payload: { name: 'pre-revoke', mode: 'test' },
    });
    expect(before.statusCode).toBe(201);

    // Revoke via the operator session.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/auth/api-tokens/${id}`,
      headers: { authorization: `Bearer ${op.accessToken}` },
    });
    expect(del.statusCode).toBe(200);

    // Now the same PAT is rejected.
    const after = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/operator/applications/${appId}/api-keys`,
      headers: { authorization: `Bearer ${rawToken}` },
      payload: { name: 'post-revoke', mode: 'test' },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('OPERATOR_TOKEN_INVALID');
  });

  it('revoke is idempotent: deleting an already-revoked PAT still 200s', async () => {
    const op = await makeOperator('revoke-idem');
    const { id } = await mintPat(op, ['read']);
    const first = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/auth/api-tokens/${id}`,
      headers: { authorization: `Bearer ${op.accessToken}` },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/auth/api-tokens/${id}`,
      headers: { authorization: `Bearer ${op.accessToken}` },
    });
    expect(second.statusCode).toBe(200);
  });

  it('expiry: an expired PAT is refused (401)', async () => {
    const op = await makeOperator('expiry');
    const appId = await makeApp(op, 'expiry-app');
    const { rawToken, id } = await mintPat(op, ['keys:mint']);

    // Force expiry in the past.
    await prisma.tenantApiToken.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/operator/applications/${appId}/api-keys`,
      headers: { authorization: `Bearer ${rawToken}` },
      payload: { name: 'expired', mode: 'test' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('OPERATOR_TOKEN_INVALID');
  });

  it('unknown token: a made-up rp_op_ token is refused (401)', async () => {
    const op = await makeOperator('unknown');
    const appId = await makeApp(op, 'unknown-app');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/operator/applications/${appId}/api-keys`,
      headers: { authorization: 'Bearer rp_op_totally-made-up' },
      payload: { name: 'nope', mode: 'test' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('OPERATOR_TOKEN_INVALID');
  });

  it('list is redacted: never returns the tokenHash, and the raw is stored only as a hash', async () => {
    const op = await makeOperator('redact');
    const { rawToken, id } = await mintPat(op, ['read'], { name: 'visible-name' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${op.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const tokens = res.json().data as Array<Record<string, unknown>>;
    expect(tokens).toHaveLength(1);
    const t = tokens[0]!;

    // Redaction: no hash, no raw token anywhere in the response.
    expect(t).not.toHaveProperty('tokenHash');
    const serialized = JSON.stringify(tokens);
    expect(serialized).not.toContain(rawToken);
    // Prefix is shown for identification; it is NOT the full raw token.
    expect(typeof t.tokenPrefix).toBe('string');
    expect(rawToken.startsWith(t.tokenPrefix as string)).toBe(true);
    expect((t.tokenPrefix as string).length).toBeLessThan(rawToken.length);

    // At rest it's stored ONLY as the SHA-256 hash of the raw token.
    const row = await prisma.tenantApiToken.findUnique({ where: { id } });
    expect(row?.tokenHash).toBe(hashKey(rawToken));
  });

  it('cross-tenant isolation: a PAT bound to workspace A cannot mint for B\'s app', async () => {
    const opA = await makeOperator('iso-a');
    const opB = await makeOperator('iso-b');
    const appB = await makeApp(opB, 'iso-b-app');
    const { rawToken } = await mintPat(opA, ['keys:mint']);

    // A's PAT, B's application → looks like "not found" (no cross-tenant oracle).
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/operator/applications/${appB}/api-keys`,
      headers: { authorization: `Bearer ${rawToken}` },
      payload: { name: 'cross', mode: 'test' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('APPLICATION_NOT_FOUND');
    expect(await prisma.apiKey.count({ where: { applicationId: appB } })).toBe(0);
  });

  it('operator isolation: an operator cannot revoke another operator\'s PAT', async () => {
    const opA = await makeOperator('owner-a');
    const opB = await makeOperator('owner-b');
    const { id: tokenOfA } = await mintPat(opA, ['read']);

    // B tries to revoke A's token → 404 (not found in B's set), and A's token survives.
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/auth/api-tokens/${tokenOfA}`,
      headers: { authorization: `Bearer ${opB.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('OPERATOR_TOKEN_NOT_FOUND');

    const stillThere = await prisma.tenantApiToken.findUnique({ where: { id: tokenOfA } });
    expect(stillThere?.revokedAt).toBeNull();
  });

  it('membership revoked: a PAT stops working once the operator leaves its workspace', async () => {
    const op = await makeOperator('left');
    const appId = await makeApp(op, 'left-app');
    const { rawToken } = await mintPat(op, ['keys:mint']);

    // Simulate the operator being removed from the workspace the PAT is bound to.
    await prisma.tenantMembership.deleteMany({
      where: { tenantUserId: op.userId, tenantId: op.tenantId },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/operator/applications/${appId}/api-keys`,
      headers: { authorization: `Bearer ${rawToken}` },
      payload: { name: 'after-leave', mode: 'test' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_MEMBERSHIP_REVOKED');
  });

  it('mint requires an operator session (no anonymous minting)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      payload: { name: 'anon', scopes: ['read'] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects unknown scopes at mint (fail closed)', async () => {
    const op = await makeOperator('badscope');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${op.accessToken}` },
      payload: { name: 'bad', scopes: ['billing:refund'] },
    });
    // Rejected at the route schema (enum) — a 400-class error, never minted.
    expect(res.statusCode).toBe(400);
    expect(await prisma.tenantApiToken.count()).toBe(0);
  });
});
