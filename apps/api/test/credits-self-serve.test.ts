/**
 * Credits an integrator no longer has to mirror or ask an operator for.
 *
 *   POST /api/v1/credits/grant     secret key with the ELEVATED `credits:grant` scope
 *   GET  /api/v1/credits/me/ledger the signed-in end-user's own ledger
 *
 * The one assertion the grant route stands on: a key holding exactly `["*"]`,
 * the default on every key ever minted, is refused. Without it the elevated
 * scope is one array edit away from arming every deployed key with a mint.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { creditsService } from '../src/modules/credits/credits.service.js';

describe('Credits self-serve', () => {
  let app: FastifyInstance;
  let operator: string;
  let appId: string;
  let fullKey: string; // ["*"]
  let publicKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const op = (): { authorization: string } => ({ authorization: `Bearer ${operator}` });

  async function mint(scopes?: string[]): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/api-keys`,
      headers: op(),
      payload: { name: `k-${scopes?.join('+') ?? 'default'}`, mode: 'live', ...(scopes && { scopes }) },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { rawKey: string }).rawKey;
  }

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `cs-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: op(),
        payload: { name: 'CS', slug: `cs-${slug}`, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    appId = application.id;
    publicKey = application.publicKey;
    fullKey = await mint();
  });

  interface Session {
    accessToken: string;
    endUser: { id: string };
  }

  async function signUp(): Promise<Session> {
    return app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${fullKey}` },
        payload: { email: `eu-${Math.random().toString(36).slice(2, 8)}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as Session);
  }

  const grant = (key: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/credits/grant',
      headers: { authorization: `Bearer ${key}`, ...headers },
      payload,
    });

  const balanceOf = (subject: { endUserId: string } | { organizationId: string }) =>
    creditsService.getBalance(appId, subject);

  describe('POST /credits/grant', () => {
    it('a key holding exactly ["*"] is refused, and names the elevated scope', async () => {
      const user = await signUp();
      const keyRow = await prisma.apiKey.findFirstOrThrow({ where: { applicationId: appId, name: 'k-default' } });
      expect(keyRow.scopes).toEqual(['*']);

      const res = await grant(fullKey, { endUserId: user.endUser.id, amount: 10, idempotencyKey: 'star' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
      expect(res.json().error.fix).toContain('elevated');
      expect(await balanceOf({ endUserId: user.endUser.id })).toBe(0);
    });

    it('a key without the scope is refused, even with billing:write', async () => {
      const user = await signUp();
      const res = await grant(await mint(['billing:write']), { endUserId: user.endUser.id, amount: 10, idempotencyKey: 'bw' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
    });

    it('the publishable key is refused', async () => {
      const user = await signUp();
      const res = await grant(publicKey, { endUserId: user.endUser.id, amount: 10, idempotencyKey: 'pub' });
      expect(res.statusCode).toBe(401);
    });

    it('a key minted with credits:grant grants through the ledger and audits the key', async () => {
      const user = await signUp();
      const key = await mint(['credits:grant']);
      const res = await grant(key, {
        endUserId: user.endUser.id,
        amount: 250,
        idempotencyKey: 'referral-42',
        description: 'Referral payout',
      });
      expect(res.statusCode).toBe(201);
      const data = res.json().data as { balance: number; entryId: string; applied: boolean };
      expect(data).toMatchObject({ balance: 250, applied: true });
      expect(await balanceOf({ endUserId: user.endUser.id })).toBe(250);

      const entry = await prisma.creditLedger.findUniqueOrThrow({ where: { id: data.entryId } });
      expect(entry).toMatchObject({ delta: 250, reason: 'GRANT', idempotencyKey: 'api-grant:referral-42', description: 'Referral payout' });

      const keyRow = await prisma.apiKey.findFirstOrThrow({ where: { applicationId: appId, name: 'k-credits:grant' } });
      const events = await prisma.securityEvent.findMany({
        where: { applicationId: appId, type: 'app.credits_granted_by_api_key' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorType: 'system', actorId: keyRow.id, subjectEndUserId: user.endUser.id });
      expect(events[0]!.metadata).toMatchObject({
        apiKeyId: keyRow.id,
        apiKeyName: 'k-credits:grant',
        amount: 250,
        idempotencyKey: 'referral-42',
        ledgerEntryId: data.entryId,
      });
    });

    it('works alongside "*" when both are named on one key', async () => {
      const user = await signUp();
      const res = await grant(await mint(['*', 'credits:grant']), { endUserId: user.endUser.id, amount: 5, idempotencyKey: 'both' });
      expect(res.statusCode).toBe(201);
    });

    it('an idempotent replay grants once, and audits once', async () => {
      const user = await signUp();
      const key = await mint(['credits:grant']);
      const body = { endUserId: user.endUser.id, amount: 100, idempotencyKey: 'payout-1' };
      const first = await grant(key, body);
      const second = await grant(key, body);
      expect((first.json().data as { applied: boolean }).applied).toBe(true);
      expect(second.json().data).toMatchObject({ applied: false, balance: 100, entryId: first.json().data.entryId });
      expect(await balanceOf({ endUserId: user.endUser.id })).toBe(100);
      expect(await prisma.creditLedger.count({ where: { applicationId: appId } })).toBe(1);
      expect(
        await prisma.securityEvent.count({ where: { applicationId: appId, type: 'app.credits_granted_by_api_key' } }),
      ).toBe(1);
    });

    it('a grant key never matches a consume made under the same string', async () => {
      const user = await signUp();
      await creditsService.grant({ applicationId: appId, endUserId: user.endUser.id, amount: 10, reason: 'GRANT' });
      await creditsService.consume({ applicationId: appId, endUserId: user.endUser.id, amount: 4, idempotencyKey: 'lead-1' });

      const refund = await grant(await mint(['credits:grant']), {
        endUserId: user.endUser.id,
        amount: 4,
        reason: 'REFUND',
        idempotencyKey: 'lead-1',
      });
      expect(refund.statusCode).toBe(201);
      expect(refund.json().data).toMatchObject({ applied: true, balance: 10 });
      expect(await balanceOf({ endUserId: user.endUser.id })).toBe(10);
    });

    it('the same key with a different amount or reason is 409, not a silent no-op', async () => {
      const user = await signUp();
      const key = await mint(['credits:grant']);
      expect((await grant(key, { endUserId: user.endUser.id, amount: 5, idempotencyKey: 'bonus' })).statusCode).toBe(201);

      for (const body of [
        { amount: 500, idempotencyKey: 'bonus' },
        { amount: 5, reason: 'REFUND', idempotencyKey: 'bonus' },
      ]) {
        const res = await grant(key, { endUserId: user.endUser.id, ...body });
        expect(res.statusCode, JSON.stringify(body)).toBe(409);
        expect(res.json().error.code).toBe('CREDITS_IDEMPOTENCY_KEY_REUSED');
      }
      // An exact repeat is still a quiet replay.
      const same = await grant(key, { endUserId: user.endUser.id, amount: 5, idempotencyKey: 'bonus' });
      expect(same.json().data).toMatchObject({ applied: false, balance: 5 });
      expect(await balanceOf({ endUserId: user.endUser.id })).toBe(5);
    });

    it('the audit row is part of the grant: if it cannot be written, nothing is granted', async () => {
      const user = await signUp();
      const key = await mint(['credits:grant']);
      // Make the audit insert fail inside Postgres, for this event type only.
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION test_refuse_grant_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW.type = 'app.credits_granted_by_api_key' THEN RAISE EXCEPTION 'audit refused'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER test_refuse_grant_audit BEFORE INSERT ON security_events FOR EACH ROW EXECUTE FUNCTION test_refuse_grant_audit()',
      );
      try {
        const res = await grant(key, { endUserId: user.endUser.id, amount: 50, idempotencyKey: 'unaudited' });
        expect(res.statusCode).toBe(500);
        expect(await balanceOf({ endUserId: user.endUser.id })).toBe(0);
        expect(await prisma.creditLedger.count({ where: { applicationId: appId } })).toBe(0);
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_refuse_grant_audit ON security_events');
        await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_refuse_grant_audit()');
      }
    });

    it('an Idempotency-Key header replays the response without a second grant', async () => {
      const user = await signUp();
      const key = await mint(['credits:grant']);
      const body = { endUserId: user.endUser.id, amount: 7, idempotencyKey: 'hdr-body' };
      const a = await grant(key, body, { 'idempotency-key': 'hdr-1' });
      const b = await grant(key, body, { 'idempotency-key': 'hdr-1' });
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(201);
      expect(await balanceOf({ endUserId: user.endUser.id })).toBe(7);
    });

    it('refuses zero, negative, fractional, oversized and int-overflowing amounts', async () => {
      const user = await signUp();
      const key = await mint(['credits:grant']);
      for (const amount of [0, -5, 1.5, 1_000_001, 2_147_483_648]) {
        const res = await grant(key, { endUserId: user.endUser.id, amount, idempotencyKey: `bad-${amount}` });
        expect(res.statusCode, `amount ${amount}`).toBe(400);
      }
      const atCeiling = await grant(key, { endUserId: user.endUser.id, amount: 1_000_000, idempotencyKey: 'ceiling' });
      expect(atCeiling.statusCode).toBe(201);
      expect(await balanceOf({ endUserId: user.endUser.id })).toBe(1_000_000);
    });

    it('requires an idempotency key, exactly one subject, and refuses ADJUST', async () => {
      const user = await signUp();
      const key = await mint(['credits:grant']);
      expect((await grant(key, { endUserId: user.endUser.id, amount: 1 })).statusCode).toBe(400);
      expect((await grant(key, { amount: 1, idempotencyKey: 'x' })).statusCode).toBe(400);
      expect(
        (await grant(key, { endUserId: user.endUser.id, organizationId: 'o', amount: 1, idempotencyKey: 'y' })).statusCode,
      ).toBe(400);
      expect(
        (await grant(key, { endUserId: user.endUser.id, amount: 1, idempotencyKey: 'z', reason: 'ADJUST' })).statusCode,
      ).toBe(400);
      expect(await balanceOf({ endUserId: user.endUser.id })).toBe(0);
    });

    it('grants to an organization pool, and refuses a subject from another application', async () => {
      const user = await signUp();
      const orgId = await app
        .inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${appId}/organizations`,
          headers: op(),
          payload: { name: 'Team', slug: `team-${Math.random().toString(36).slice(2, 6)}`, ownerEndUserId: user.endUser.id },
        })
        .then((r) => (r.json().data as { id: string }).id);
      const key = await mint(['credits:grant']);
      const res = await grant(key, { organizationId: orgId, amount: 40, idempotencyKey: 'team-1' });
      expect(res.statusCode).toBe(201);
      expect(await balanceOf({ organizationId: orgId })).toBe(40);

      const unknown = await grant(key, { endUserId: 'not-in-this-app', amount: 1, idempotencyKey: 'u' });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('END_USER_NOT_FOUND');
    });
  });

  describe('GET /credits/me/ledger', () => {
    const myLedger = (accessToken: string, query = '', key = publicKey) =>
      app.inject({
        method: 'GET',
        url: `/api/v1/credits/me/ledger${query}`,
        headers: { authorization: `Bearer ${key}`, 'x-rekey-user-token': accessToken },
      });

    it("pages through the caller's own ledger, newest first, without metadata", async () => {
      const user = await signUp();
      const other = await signUp();
      await creditsService.grant({
        applicationId: appId,
        endUserId: user.endUser.id,
        amount: 100,
        reason: 'GRANT',
        metadata: { note: 'operator only' },
      });
      await creditsService.consume({ applicationId: appId, endUserId: user.endUser.id, amount: 30, description: 'one lead', idempotencyKey: 'lead-1' });
      await creditsService.grant({ applicationId: appId, endUserId: other.endUser.id, amount: 5, reason: 'GRANT' });

      const res = await myLedger(user.accessToken);
      expect(res.statusCode).toBe(200);
      const { items, page } = res.json().data as {
        items: Array<Record<string, unknown>>;
        page: { total: number; limit: number; offset: number; hasMore: boolean };
      };
      expect(page).toMatchObject({ total: 2, limit: 50, offset: 0, hasMore: false });
      expect(items.map((e) => e.delta)).toEqual([-30, 100]);
      expect(items[0]).toMatchObject({ reason: 'CONSUME', balanceAfter: 70, description: 'one lead' });
      for (const e of items) {
        expect(Object.keys(e).sort()).toEqual(['balanceAfter', 'createdAt', 'delta', 'description', 'id', 'reason']);
      }

      const second = await myLedger(user.accessToken, '?limit=1&offset=1');
      const p2 = second.json().data as { items: Array<{ delta: number }>; page: { total: number } };
      expect(p2.items.map((e) => e.delta)).toEqual([100]);
      expect(p2.page.total).toBe(2);
    });

    it('entries written in the same instant page in a stable order (id breaks the tie)', async () => {
      const user = await signUp();
      const at = new Date('2026-09-01T00:00:00.000Z');
      // Inserted out of id order, all with one timestamp.
      for (const id of ['tie-1', 'tie-3', 'tie-2']) {
        await prisma.creditLedger.create({
          data: {
            id,
            applicationId: appId,
            endUserId: user.endUser.id,
            subjectKey: `u:${user.endUser.id}`,
            delta: 1,
            reason: 'GRANT',
            balanceAfter: 1,
            createdAt: at,
          },
        });
      }
      const page = async (offset: number, url: 'me' | 'key') => {
        const res =
          url === 'me'
            ? await myLedger(user.accessToken, `?limit=1&offset=${offset}`)
            : await app.inject({
                method: 'GET',
                url: `/api/v1/credits/ledger?endUserId=${user.endUser.id}&limit=1&offset=${offset}`,
                headers: { authorization: `Bearer ${fullKey}` },
              });
        return (res.json().data as { items: Array<{ id: string }> }).items[0]!.id;
      };
      for (const url of ['me', 'key'] as const) {
        expect([await page(0, url), await page(1, url), await page(2, url)]).toEqual(['tie-3', 'tie-2', 'tie-1']);
      }
    });

    it('needs a user token, and never takes an end-user id from the query', async () => {
      const user = await signUp();
      const other = await signUp();
      await creditsService.grant({ applicationId: appId, endUserId: other.endUser.id, amount: 9, reason: 'GRANT' });
      const noToken = await app.inject({
        method: 'GET',
        url: '/api/v1/credits/me/ledger',
        headers: { authorization: `Bearer ${publicKey}` },
      });
      expect(noToken.statusCode).toBe(401);
      const res = await myLedger(user.accessToken, `?endUserId=${other.endUser.id}`);
      expect(res.statusCode).toBe(200);
      expect((res.json().data as { page: { total: number } }).page.total).toBe(0);
    });

    it('a user-billed application stays on the personal ledger after switching into a team', async () => {
      const owner = await signUp();
      const orgId = await app
        .inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${appId}/organizations`,
          headers: op(),
          payload: { name: 'Team', slug: `team-${Math.random().toString(36).slice(2, 6)}`, ownerEndUserId: owner.endUser.id },
        })
        .then((r) => (r.json().data as { id: string }).id);
      await creditsService.grant({ applicationId: appId, organizationId: orgId, amount: 500, reason: 'GRANT' });
      await creditsService.grant({ applicationId: appId, endUserId: owner.endUser.id, amount: 7, reason: 'GRANT' });
      const switched = await app
        .inject({
          method: 'POST',
          url: `/api/v1/users/me/organizations/${orgId}/switch`,
          headers: { authorization: `Bearer ${fullKey}`, 'x-rekey-user-token': owner.accessToken },
        })
        .then((r) => r.json().data as Session);
      const res = await myLedger(switched.accessToken);
      expect((res.json().data as { items: Array<{ delta: number }> }).items.map((e) => e.delta)).toEqual([7]);
      // An explicit ask for the organization still works, member-only.
      const explicit = await myLedger(switched.accessToken, `?organizationId=${orgId}`);
      expect((explicit.json().data as { items: Array<{ delta: number }> }).items.map((e) => e.delta)).toEqual([500]);
    });

    it("reads the active organization's pool in an org-billed application, member-only", async () => {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/billing-config`,
        headers: op(),
        payload: { billingSubject: 'org' },
      });
      const owner = await signUp();
      const orgId = await app
        .inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${appId}/organizations`,
          headers: op(),
          payload: { name: 'Pool', slug: `pool-${Math.random().toString(36).slice(2, 6)}`, ownerEndUserId: owner.endUser.id },
        })
        .then((r) => (r.json().data as { id: string }).id);
      await creditsService.grant({ applicationId: appId, organizationId: orgId, amount: 500, reason: 'GRANT' });
      await creditsService.grant({ applicationId: appId, endUserId: owner.endUser.id, amount: 3, reason: 'GRANT' });

      const switched = await app
        .inject({
          method: 'POST',
          url: `/api/v1/users/me/organizations/${orgId}/switch`,
          headers: { authorization: `Bearer ${fullKey}`, 'x-rekey-user-token': owner.accessToken },
        })
        .then((r) => r.json().data as Session);
      const orgView = await myLedger(switched.accessToken);
      expect((orgView.json().data as { items: Array<{ delta: number }> }).items.map((e) => e.delta)).toEqual([500]);

      const personal = await myLedger(owner.accessToken);
      expect((personal.json().data as { items: Array<{ delta: number }> }).items.map((e) => e.delta)).toEqual([3]);

      const stranger = await signUp();
      const refused = await myLedger(stranger.accessToken, `?organizationId=${orgId}`);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('ORGANIZATION_NOT_MEMBER');
    });
  });
});
