/**
 * Concurrent magic-link consumes that would create the same new end-user.
 *
 * A person who asks for a link twice and opens both, or a mail client that
 * prefetches one while the person clicks the other, sends several verifies for
 * DIFFERENT tokens that all carry `endUserId: null` for the same address. Each
 * one tries to create the user. The losers used to catch the unique violation
 * and look the winner up in the same transaction, which Postgres had already
 * aborted (25P02), so every loser answered 500 instead of signing in.
 *
 * Eight racers, not two: two requests under `Promise.all` often do not overlap
 * in Postgres at all, and a test that never overlaps proves nothing.
 *
 * The second case pins the single-use rule from the other side: one token
 * opened in eight tabs signs in exactly once.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';
import { emailService } from '../src/modules/email/email.service.js';
import { webhookService } from '../src/modules/webhooks/webhook.service.js';
import { POOL_SQUEEZE_TEST_TIMEOUT_MS, withPoolOf } from './pool-squeeze.js';

const RACERS = 8;

describe('Concurrent magic-link consumes for one new address', () => {
  let app: FastifyInstance;
  let appId: string;
  let secretKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function welcomeSends(spy: { mock: { calls: unknown[][] } }): number {
    return spy.mock.calls.filter((c) => (c[0] as { eventKey: string }).eventKey === 'welcome').length;
  }

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    const operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `mlr-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const op = { authorization: `Bearer ${operator}` };
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: op,
        payload: { name: 'MLR', slug: `mlr-${slug}` },
      })
      .then((r) => (r.json().data as { id: string }).id);
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: op,
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await applicationsService.updateAuthConfig({
      applicationId: appId,
      patch: { methods: ['password', 'magic_link'] },
    });
    await webhookService.createEndpoint({
      applicationId: appId,
      url: 'https://example.invalid/magic-link-race',
      events: ['*'],
    });
  });

  async function requestLink(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      headers: { authorization: `Bearer ${secretKey}` },
      payload: { email },
    });
    expect(res.statusCode).toBe(200);
    const token = (res.json().data as { magicLinkToken: string | null }).magicLinkToken;
    expect(token).toBeTruthy();
    return token!;
  }

  type Result = { status: number; code?: string; userId?: string; accessToken?: string };

  async function verify(token: string): Promise<Result> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      headers: { authorization: `Bearer ${secretKey}` },
      payload: { token },
    });
    const body = res.json() as {
      data?: { accessToken?: string; endUser?: { id: string } };
      error?: { code: string };
    };
    return {
      status: res.statusCode,
      ...(body.error && { code: body.error.code }),
      ...(body.data?.endUser && { userId: body.data.endUser.id }),
      ...(body.data?.accessToken && { accessToken: body.data.accessToken }),
    };
  }

  it(`${RACERS} different links for one new address all sign in to one user, announced once`, async () => {
    const email = 'racer@example.com';
    // Every link is issued before the user exists, so each carries
    // `endUserId: null` and each consume takes the create branch.
    const tokens: string[] = [];
    for (let i = 0; i < RACERS; i++) tokens.push(await requestLink(email));
    const dispatch = vi.spyOn(emailService, 'dispatch');

    const results = await Promise.all(tokens.map((t) => verify(t)));

    expect(results.filter((r) => r.status >= 500)).toEqual([]);
    expect(results.map((r) => r.status)).toEqual(Array(RACERS).fill(200));

    const users = await prisma.endUser.findMany({ where: { applicationId: appId, email } });
    expect(users).toHaveLength(1);
    expect(users[0]!.emailVerified).toBe(true);
    for (const r of results) {
      expect(r.userId).toBe(users[0]!.id);
      expect(r.accessToken).toBeTruthy();
    }

    const created = await prisma.webhookDelivery.findMany({
      where: { applicationId: appId, eventType: 'user.created' },
    });
    expect(created).toHaveLength(1);
    // Welcomed once, by the consume that created the user, not by every link
    // that was issued before the user existed.
    expect(welcomeSends(dispatch)).toBe(1);

    // Each link is its own single-use proof of the mailbox: all consumed, and
    // none can be replayed.
    const rows = await prisma.magicLinkToken.findMany({ where: { applicationId: appId, email } });
    expect(rows).toHaveLength(RACERS);
    expect(rows.every((t) => t.consumedAt !== null)).toBe(true);
    const replay = await verify(tokens[0]!);
    expect(replay).toMatchObject({ status: 401, code: 'MAGIC_LINK_USED' });
  });

  // The verify transaction used to read the default role through the GLOBAL
  // client, a second connection while the transaction held the first. With N
  // verifies on a pool of N every one of them held a connection and waited
  // for another, until the transaction timeout failed them all.
  for (const n of [1, 4]) {
    it(`${n} concurrent new-user verifies on a pool with ${n} free connection(s) all complete promptly`, async () => {
      const tokens: string[] = [];
      for (let i = 0; i < n; i++) tokens.push(await requestLink(`pool-${n}-${i}@example.com`));

      const { results, elapsed } = await withPoolOf(n, async () => {
        const started = Date.now();
        const results = await Promise.all(tokens.map((t) => verify(t)));
        return { results, elapsed: Date.now() - started };
      });

      expect(results.map((r) => r.status)).toEqual(Array(n).fill(200));
      // Well inside the 5 second transaction timeout the old code ran into.
      expect(elapsed).toBeLessThan(4_000);
    }, POOL_SQUEEZE_TEST_TIMEOUT_MS);
  }

  it(`one link opened in ${RACERS} tabs signs in exactly once`, async () => {
    const email = 'tabs@example.com';
    const token = await requestLink(email);

    const results = await Promise.all(Array.from({ length: RACERS }, () => verify(token)));

    expect(results.filter((r) => r.status >= 500)).toEqual([]);
    const winners = results.filter((r) => r.status === 200);
    const losers = results.filter((r) => r.status !== 200);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(RACERS - 1);
    for (const l of losers) expect(l).toMatchObject({ status: 401, code: 'MAGIC_LINK_USED' });

    expect(await prisma.endUser.count({ where: { applicationId: appId, email } })).toBe(1);
    expect(
      await prisma.webhookDelivery.count({ where: { applicationId: appId, eventType: 'user.created' } }),
    ).toBe(1);
  });
});
