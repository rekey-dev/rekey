/**
 * Generic `Idempotency-Key` header middleware (middleware/idempotency.ts).
 *
 * Vehicles: the operator credits-grant route (tenant-session scope) and the
 * public credits-consume route (API-key scope) — both opted in via
 * `config: { idempotency: true }` and both with an observable side effect
 * (the credit ledger), so "replayed, not re-executed" is directly assertable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { creditsService } from '../src/modules/credits/credits.service.js';
import { pruneExpiredIdempotencyKeys } from '../src/lib/token-prune.js';
import { decryptJson } from '../src/lib/secrets.js';

describe('idempotency-key middleware', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;
  let tenantAccess: string;
  let endUserId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function createApp(slug: string): Promise<{ applicationId: string; liveKey: string; endUserId: string }> {
    const created = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${created.id}/api-keys`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string })
      .then((d) => d.rawKey);
    const euid = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${key}` },
        payload: { email: `eu-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { endUser: { id: string } })
      .then((d) => d.endUser.id);
    return { applicationId: created.id, liveKey: key, endUserId: euid };
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    const slug = `idem-${Math.random().toString(36).slice(2, 8)}`;
    tenantAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => r.json().data as { accessToken: string })
      .then((d) => d.accessToken);
    ({ applicationId, liveKey, endUserId } = await createApp(slug));
  });

  const grant = (amount: number, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/end-users/${endUserId}/credits/grant`,
      headers: { authorization: `Bearer ${tenantAccess}`, ...headers },
      payload: { amount },
    });

  /**
   * The same call as `grant`, from a second operator who is a MEMBER of the
   * SAME workspace rather than its OWNER.
   *
   * Signing that operator up would give them their own workspace and a
   * different scope either way — which is exactly how a first version of this
   * test passed against the vulnerable code. They have to be re-pointed at the
   * owner's workspace with the MEMBER role for the collision to be possible at
   * all.
   */
  const grantAsMember = async (amount: number, headers: Record<string, string> = {}) => {
    const slug = `mem-${Math.random().toString(36).slice(2, 8)}`;
    const memberAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `mem-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string })
      .then((d) => d.accessToken);

    const ownerMembership = await prisma.tenantMembership.findFirstOrThrow({
      where: { role: 'OWNER' },
      orderBy: { createdAt: 'asc' },
    });
    const memberUser = await prisma.tenantUser.findFirstOrThrow({
      where: { email: `mem-${slug}@example.com` },
    });
    await prisma.tenantMembership.updateMany({
      where: { tenantUserId: memberUser.id },
      data: { tenantId: ownerMembership.tenantId, role: 'MEMBER' },
    });

    return app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
      headers: { authorization: `Bearer ${memberAccess}`, ...headers },
      payload: { name: `k-${amount}` },
    });
  };

  /** The OWNER's version of the same ADMIN-gated mint. */
  const mintAsOwner = (name: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
      headers: { authorization: `Bearer ${tenantAccess}`, ...headers },
      payload: { name },
    });

  const ledgerCount = (appId = applicationId) =>
    prisma.creditLedger.count({ where: { applicationId: appId } });

  it('first call executes normally and persists the stored response', async () => {
    const res = await grant(100, { 'idempotency-key': 'op-1' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotency-replayed']).toBeUndefined();
    expect(await ledgerCount()).toBe(1);

    // The scope is the effective ACTOR, not just the workspace — an
    // Application- or tenant-wide scope let a lower-privileged member replay a
    // higher-privileged member's response, because a replay short-circuits
    // before the route's role guard ever runs.
    const membership = await prisma.tenantMembership.findFirstOrThrow();
    const row = await prisma.idempotencyKey.findUnique({
      where: {
        scopeKey_key: {
          scopeKey: `tenant:${membership.tenantId}:member:${membership.id}`,
          key: 'op-1',
        },
      },
    });
    expect(row).not.toBeNull();
    expect(row!.responseStatus).toBe(201);
    expect(row!.applicationId).toBeNull(); // operator-session scope, not API-key
    expect(row!.method).toBe('POST');
    // Bodies are encrypted at rest — the stored value is a ciphertext string
    // that decrypts back to the original response.
    expect(typeof row!.responseBody).toBe('string');
    expect(decryptJson(row!.responseBody as string)).toEqual(res.json());
    // ~24 h TTL.
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  it('replay returns the identical stored response with Idempotency-Replayed and no second side effect', async () => {
    const first = await grant(100, { 'idempotency-key': 'op-replay' });
    const second = await grant(100, { 'idempotency-key': 'op-replay' });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());

    // One ledger entry, balance granted exactly once.
    expect(await ledgerCount()).toBe(1);
    expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(100);
  });

  it('secret-bearing responses (api-key mint rawKey) are never stored plaintext at rest', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
      headers: { authorization: `Bearer ${tenantAccess}`, 'idempotency-key': 'mint-1' },
      payload: { name: 'cached-mint' },
    });
    expect(res.statusCode).toBe(201);
    const rawKey = (res.json().data as { rawKey: string }).rawKey;
    expect(rawKey).toMatch(/^rp_test_/);

    const row = await prisma.idempotencyKey.findFirstOrThrow({ where: { key: 'mint-1' } });
    // The cached body must be ciphertext: the plaintext key appears nowhere
    // in the serialized row, but a replay still returns it faithfully.
    expect(JSON.stringify(row)).not.toContain(rawKey);
    expect(decryptJson(row.responseBody as string)).toEqual(res.json());

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
      headers: { authorization: `Bearer ${tenantAccess}`, 'idempotency-key': 'mint-1' },
      payload: { name: 'cached-mint' },
    });
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((replay.json().data as { rawKey: string }).rawKey).toBe(rawKey);
  });

  it('same key with a different body is refused with 409 IDEMPOTENCY_KEY_REUSED', async () => {
    await grant(100, { 'idempotency-key': 'op-reuse' });
    const res = await grant(250, { 'idempotency-key': 'op-reuse' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // The conflicting request did not execute.
    expect(await ledgerCount()).toBe(1);
  });

  it('keys are scoped per principal — the same key in two Applications both execute', async () => {
    const other = await createApp(`idem-b-${Math.random().toString(36).slice(2, 8)}`);
    // Fund both subjects (no header — setup).
    await grant(100);
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${other.applicationId}/end-users/${other.endUserId}/credits/grant`,
      headers: { authorization: `Bearer ${tenantAccess}` },
      payload: { amount: 100 },
    });

    const consume = (key: string, appKey: string, euid: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/credits/consume',
        headers: { authorization: `Bearer ${appKey}`, 'idempotency-key': key },
        payload: { endUserId: euid, amount: 30 },
      });

    const a = await consume('shared-key', liveKey, endUserId);
    const b = await consume('shared-key', other.liveKey, other.endUserId);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    // Neither was a replay of the other — both debited their own balance.
    expect(b.headers['idempotency-replayed']).toBeUndefined();
    expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(70);
    expect(await creditsService.getBalance(other.applicationId, { endUserId: other.endUserId })).toBe(70);
  });

  it('an expired key re-executes instead of replaying (and the prune sweep deletes expired rows)', async () => {
    await grant(100, { 'idempotency-key': 'op-exp' });
    // Age the row past its TTL.
    await prisma.idempotencyKey.updateMany({
      where: { key: 'op-exp' },
      data: {
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    const res = await grant(100, { 'idempotency-key': 'op-exp' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotency-replayed']).toBeUndefined();
    // Re-executed: two ledger entries, double grant.
    expect(await ledgerCount()).toBe(2);
    expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(200);

    // The prune job removes whatever is past expiry.
    await prisma.idempotencyKey.updateMany({
      where: { key: 'op-exp' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await pruneExpiredIdempotencyKeys();
    expect(await prisma.idempotencyKey.count({ where: { key: 'op-exp' } })).toBe(0);
  });

  it('a 5xx response is never cached — the retry re-executes', async () => {
    vi.spyOn(creditsService, 'grant').mockRejectedValueOnce(new Error('boom'));

    const failed = await grant(100, { 'idempotency-key': 'op-5xx' });
    expect(failed.statusCode).toBe(500);
    // Reservation discarded, nothing replayable left behind.
    expect(await prisma.idempotencyKey.count({ where: { key: 'op-5xx' } })).toBe(0);

    const retry = await grant(100, { 'idempotency-key': 'op-5xx' });
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotency-replayed']).toBeUndefined();
    expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(100);
  });

  it('a concurrent duplicate of an in-flight request gets 409 IDEMPOTENCY_KEY_IN_FLIGHT with Retry-After', async () => {
    // Simulate an in-flight first request: a reservation row with no response yet.
    await prisma.idempotencyKey.create({
      data: {
        scopeKey: `app:${applicationId}`,
        key: 'k-inflight',
        applicationId,
        method: 'POST',
        path: '/api/v1/credits/consume',
        requestHash: 'pending',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/credits/consume',
      headers: { authorization: `Bearer ${liveKey}`, 'idempotency-key': 'k-inflight' },
      payload: { endUserId, amount: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_IN_FLIGHT');
    expect(res.headers['retry-after']).toBe('1');
  });

  it('rejects an oversized key with 400 IDEMPOTENCY_KEY_INVALID before executing', async () => {
    const res = await grant(100, { 'idempotency-key': 'x'.repeat(201) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(await ledgerCount()).toBe(0);
  });

  it('routes that did not opt in ignore the header (selective application)', async () => {
    // auth sign-up is deliberately excluded — duplicate sign-ups 409 naturally.
    const signUp = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}`, 'idempotency-key': 'su-1' },
        payload: { email: 'dupe@example.com', password: 'pw-one-two-three' },
      });
    const first = await signUp();
    const second = await signUp();
    expect(first.statusCode).toBe(201);
    // Not replayed — the second call really executed and hit the natural 409.
    expect(second.statusCode).toBe(409);
    expect(second.headers['idempotency-replayed']).toBeUndefined();
    expect(await prisma.idempotencyKey.count({ where: { key: 'su-1' } })).toBe(0);
  });

  it('the body-level credits idempotencyKey keeps working underneath the header mechanism', async () => {
    await grant(100);
    const consume = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/credits/consume',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { endUserId, amount: 40, idempotencyKey: 'ledger-1' },
      });
    const first = await consume();
    const second = await consume();
    expect((first.json().data as { applied: boolean }).applied).toBe(true);
    expect((second.json().data as { applied: boolean }).applied).toBe(false);
    expect(await creditsService.getBalance(applicationId, { endUserId })).toBe(60);
  });
  /**
   * The property the escalation fix establishes: two different actors in ONE
   * workspace never share a cache slot.
   *
   * Honest scoping note — this asserts the invariant, not the end-to-end
   * exploit. The exploit was proven separately against
   * `POST /:id/api-keys`: a workspace MEMBER whose own mint returned
   * 403 replayed an OWNER's key and received the plaintext key with
   * `scopes: ['*']`, because the replay lives in an instance-level
   * `preHandler` that runs BEFORE route-level guards and before the handler
   * body. Reproducing that end to end needs a member who holds app access but
   * not the role, which this file's fixture does not build — so rather than
   * ship a test that passes against the vulnerable code (an earlier draft of
   * this one did, twice), it pins the scope directly.
   */
  it('two members of one workspace never share a cache slot', async () => {
    await mintAsOwner('owner-key', { 'idempotency-key': 'shared-key' });

    const rows = await prisma.idempotencyKey.findMany({ where: { key: 'shared-key' } });
    expect(rows).toHaveLength(1);

    const membership = await prisma.tenantMembership.findFirstOrThrow({ where: { role: 'OWNER' } });
    // The workspace id alone must NOT be the scope — that is the bug.
    expect(rows[0]!.scopeKey).not.toBe(`tenant:${membership.tenantId}`);
    expect(rows[0]!.scopeKey).toBe(`tenant:${membership.tenantId}:member:${membership.id}`);
  });

  it('an authorization refusal is never cached', async () => {
    // A cached 403 let a low-privileged caller pre-seed a key so the legitimate
    // higher-privileged request replayed the refusal instead of executing.
    const refused = await grantAsMember(1, { 'idempotency-key': 'poison' });
    expect([401, 403, 404]).toContain(refused.statusCode);

    const row = await prisma.idempotencyKey.findFirst({ where: { key: 'poison' } });
    expect(row?.responseStatus ?? null).toBeNull();
  });
});
