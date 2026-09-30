/**
 * The daily activity claim: `lastActiveOn` plus the 63-day `activityBits`
 * window, claimed at most once per UTC day from sign-in, session refresh and
 * the MCP token endpoint, never from an ordinary authenticated request. And
 * the DAU/WAU/MAU numbers the stats endpoint derives from the bits.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import {
  activeDays,
  claimDailyActivity,
  utcToday,
} from '../src/modules/end-users/daily-activity.js';

const PASSWORD = 'pw-one-two-three';
const RACERS = 8;
const DAY = 86_400_000;
const MAX_BITS = (1n << 63n) - 1n;

type Json = Record<string, unknown>;

describe('End-user daily activity', () => {
  let app: FastifyInstance;
  let operator: string;
  let appId: string;
  let slug: string;
  let secretKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const op = (): { authorization: string } => ({ authorization: `Bearer ${operator}` });
  const sk = (): { authorization: string } => ({ authorization: `Bearer ${secretKey}` });

  beforeEach(async () => {
    slug = `da-${Math.random().toString(36).slice(2, 8)}`;
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: op(), payload: { name: 'DA', slug } })
      .then((r) => (r.json().data as { id: string }).id);
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: op(),
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  });

  async function signUp(email: string): Promise<Json> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: sk(),
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data as Json;
  }

  async function operatorCreate(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: op(),
      payload: { email },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { id: string }).id;
  }

  async function activity(id: string): Promise<{ lastActiveOn: Date | null; bits: bigint | null; updatedAt: Date }> {
    const [row] = await prisma.$queryRaw<Array<{ last_active_on: Date | null; bits: bigint | null; updated_at: Date }>>`
      SELECT "last_active_on", "activity_bits"::bigint AS bits, "updated_at" FROM "end_users" WHERE "id" = ${id}`;
    return { lastActiveOn: row!.last_active_on, bits: row!.bits, updatedAt: row!.updated_at };
  }

  /** Put the user's last active day `daysAgo` days back with the given bits. */
  async function setActivity(id: string, daysAgo: number, bits: bigint): Promise<void> {
    await prisma.$executeRaw`
      UPDATE "end_users"
         SET "last_active_on" = (now() AT TIME ZONE 'UTC')::date - ${daysAgo}::int,
             "activity_bits" = ${bits.toString()}::bigint::bit(63)
       WHERE "id" = ${id}`;
  }

  const today = (): number => utcToday().getTime();

  describe('the claim', () => {
    it('a sign-up marks today active with bit 0', async () => {
      const { endUser } = (await signUp('first@example.com')) as { endUser: { id: string } };
      const a = await activity(endUser.id);
      expect(a.lastActiveOn!.getTime()).toBe(today());
      expect(a.bits).toBe(1n);
    });

    it('an operator-created user has no activity', async () => {
      const id = await operatorCreate('quiet@example.com');
      expect(await activity(id)).toMatchObject({ lastActiveOn: null, bits: null });
    });

    it.each([
      { gap: 1, before: 1n, after: 0b11n },
      { gap: 1, before: 0b101n, after: 0b1011n },
      { gap: 62, before: 1n, after: (1n << 62n) | 1n },
      { gap: 62, before: 0b10n, after: 1n },
      { gap: 63, before: MAX_BITS, after: 1n },
      { gap: 64, before: MAX_BITS, after: 1n },
      { gap: 400, before: MAX_BITS, after: 1n },
    ])('after a gap of $gap days, bits $before become $after', async ({ gap, before, after }) => {
      const id = await operatorCreate(`gap-${gap}-${before}@example.com`);
      await setActivity(id, gap, before);
      expect(await claimDailyActivity(prisma, id)).toBe(true);
      const a = await activity(id);
      expect(a.lastActiveOn!.getTime()).toBe(today());
      expect(a.bits).toBe(after);
      expect(a.bits! <= MAX_BITS).toBe(true);
    });

    it('a full window shifted by one keeps 63 bits and never goes negative', async () => {
      const id = await operatorCreate('full@example.com');
      await setActivity(id, 1, MAX_BITS);
      await claimDailyActivity(prisma, id);
      expect((await activity(id)).bits).toBe(MAX_BITS);
    });

    it('a second claim the same day changes nothing', async () => {
      const id = await operatorCreate('twice@example.com');
      await setActivity(id, 3, 1n);
      expect(await claimDailyActivity(prisma, id)).toBe(true);
      expect(await claimDailyActivity(prisma, id)).toBe(false);
      expect((await activity(id)).bits).toBe(0b1001n);
    });

    it(`${RACERS} concurrent claims shift once`, async () => {
      const id = await operatorCreate('race@example.com');
      await setActivity(id, 2, 1n);
      const won = await Promise.all(Array.from({ length: RACERS }, () => claimDailyActivity(prisma, id)));
      expect(won.filter(Boolean)).toHaveLength(1);
      expect((await activity(id)).bits).toBe(0b101n);
    });

    it('the claim leaves updatedAt alone', async () => {
      const id = await operatorCreate('stamp@example.com');
      const before = (await activity(id)).updatedAt;
      await claimDailyActivity(prisma, id);
      expect((await activity(id)).updatedAt.getTime()).toBe(before.getTime());
    });

    it('a known lastActiveOn of today skips the statement', async () => {
      const id = await operatorCreate('known@example.com');
      await setActivity(id, 1, 1n);
      expect(await claimDailyActivity(prisma, id, { lastActiveOn: utcToday() })).toBe(false);
      expect((await activity(id)).bits).toBe(1n);
    });
  });

  describe('call sites', () => {
    it('a session refresh on a new day claims it', async () => {
      const created = (await signUp('refresh@example.com')) as { endUser: { id: string }; refreshToken: string };
      await setActivity(created.endUser.id, 1, 1n);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: sk(),
        payload: { refreshToken: created.refreshToken },
      });
      expect(res.statusCode).toBe(200);
      expect(await activity(created.endUser.id)).toMatchObject({ bits: 0b11n });
    });

    it(`${RACERS} concurrent refreshes of different sessions shift once`, async () => {
      const first = (await signUp('multi@example.com')) as { endUser: { id: string } };
      const sessions: string[] = [];
      for (let i = 0; i < RACERS; i++) {
        const s = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/sign-in',
          headers: sk(),
          payload: { email: 'multi@example.com', password: PASSWORD },
        });
        sessions.push((s.json().data as { refreshToken: string }).refreshToken);
      }
      await setActivity(first.endUser.id, 1, 1n);
      const results = await Promise.all(
        sessions.map((refreshToken) =>
          app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: sk(), payload: { refreshToken } }),
        ),
      );
      expect(results.every((r) => r.statusCode === 200)).toBe(true);
      expect((await activity(first.endUser.id)).bits).toBe(0b11n);
    });

    it('an authenticated request does not claim; only sign-in and refresh do', async () => {
      const created = (await signUp('reader@example.com')) as { endUser: { id: string }; accessToken: string };
      await setActivity(created.endUser.id, 1, 1n);
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { ...sk(), 'x-rekey-user-token': created.accessToken },
      });
      expect(me.statusCode).toBe(200);
      const a = await activity(created.endUser.id);
      expect(a.lastActiveOn!.getTime()).toBe(today() - DAY);
      expect(a.bits).toBe(1n);
    });

    it('/users/me reports lastActiveOn and never the raw bits', async () => {
      const created = (await signUp('shape@example.com')) as { accessToken: string };
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me',
        headers: { ...sk(), 'x-rekey-user-token': created.accessToken },
      });
      const data = me.json().data as Json;
      expect(data.lastActiveOn).toBe(new Date(today()).toISOString());
      expect(data).not.toHaveProperty('activityBits');
    });

    it('the MCP token endpoint claims on the code grant and on refresh', async () => {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/auth-config`,
        headers: op(),
        payload: { mcpEnabled: true },
      });
      const { endUser } = (await signUp('mcp@example.com')) as { endUser: { id: string } };
      const REDIRECT = 'http://localhost:9876/cb';
      const clientId = await app
        .inject({
          method: 'POST',
          url: `/api/v1/mcp/${slug}/oauth/register`,
          payload: { redirect_uris: [REDIRECT], client_name: 'Agent' },
        })
        .then((r) => (r.json() as { client_id: string }).client_id);
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const form = (p: Record<string, string>) => ({
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(p).toString(),
      });
      const authorized = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${slug}/oauth/authorize`,
        ...form({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'mcp:account',
          state: 's',
          email: 'mcp@example.com',
          password: PASSWORD,
          consent: 'allow',
        }),
      });
      const code = new URL(authorized.headers.location as string).searchParams.get('code')!;

      await setActivity(endUser.id, 1, 1n);
      const tok = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${slug}/oauth/token`,
        ...form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId }),
      });
      expect(tok.statusCode).toBe(200);
      expect((await activity(endUser.id)).bits).toBe(0b11n);

      await setActivity(endUser.id, 2, 1n);
      const refreshed = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${slug}/oauth/token`,
        ...form({
          grant_type: 'refresh_token',
          refresh_token: (tok.json() as { refresh_token: string }).refresh_token,
          client_id: clientId,
        }),
      });
      expect(refreshed.statusCode).toBe(200);
      expect((await activity(endUser.id)).bits).toBe(0b101n);
    });
  });

  describe('stats', () => {
    it('derives DAU, WAU, MAU and the 30-day series from the bits', async () => {
      const a = await operatorCreate('a@example.com');
      const b = await operatorCreate('b@example.com');
      const c = await operatorCreate('c@example.com');
      await operatorCreate('never@example.com');
      const old = await operatorCreate('old@example.com');
      // a: active today and 2 days ago. b: active 3 days ago and 10 days ago.
      // c: active 20 days ago only. old: last active 40 days ago.
      await setActivity(a, 0, 0b101n);
      await setActivity(b, 3, (1n << 7n) | 1n);
      await setActivity(c, 20, 1n);
      await setActivity(old, 40, 1n);

      const res = await app.inject({ method: 'GET', url: `/api/v1/tenant/applications/${appId}/stats`, headers: op() });
      expect(res.statusCode).toBe(200);
      const data = res.json().data as {
        activeUsers: { d1: number; d7: number; d30: number };
        activitySeries: Array<{ date: string; count: number }>;
      };
      expect(data.activeUsers).toEqual({ d1: 1, d7: 2, d30: 3 });
      expect(data.activitySeries).toHaveLength(30);
      const iso = (daysAgo: number) => new Date(today() - daysAgo * DAY).toISOString().slice(0, 10);
      expect(data.activitySeries[29]!.date).toBe(iso(0));
      expect(data.activitySeries[0]!.date).toBe(iso(29));
      const byDay = new Map(data.activitySeries.map((p) => [p.date, p.count]));
      expect(byDay.get(iso(0))).toBe(1);
      expect(byDay.get(iso(1))).toBe(0);
      expect(byDay.get(iso(2))).toBe(1);
      expect(byDay.get(iso(3))).toBe(1);
      expect(byDay.get(iso(10))).toBe(1);
      expect(byDay.get(iso(20))).toBe(1);
      expect(data.activitySeries.reduce((s, p) => s + p.count, 0)).toBe(5);
    });
  });

  describe('activeDays', () => {
    const t = new Date('2026-09-29T00:00:00Z');
    const bits = (n: bigint) => n.toString(2).padStart(63, '0');

    it('decodes the window oldest first, ending today', () => {
      const days = activeDays(new Date('2026-09-28T00:00:00Z'), bits(0b101n), 5, t);
      expect(days).toEqual([false, true, false, true, false]);
    });

    it('is all false with no activity', () => {
      expect(activeDays(null, null, 3, t)).toEqual([false, false, false]);
    });
  });
});
