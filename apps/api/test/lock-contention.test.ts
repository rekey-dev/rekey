/**
 * Row locks around the auth write path, exercised with real interleavings.
 *
 * 1. Webhook endpoint deleted while a sign-up is writing its `user.created`
 *    delivery. The delivery rows are inserted in the sign-up's transaction, so
 *    an FK failure on `webhook_deliveries_endpoint_id_fkey` rolled back the
 *    sign-up itself (500). `listForEvent` now reads the endpoints
 *    `FOR KEY SHARE`.
 *
 * 2. An operator toggling email for an Application. `lockEmailCoupling` held
 *    the Application row `FOR UPDATE`, which conflicts with the KEY SHARE lock
 *    every child insert (end user, refresh token) takes through its FK, so
 *    sign-ups for the Application stalled behind the toggle. It is now
 *    `FOR NO KEY UPDATE`, which still serialises the coupling writers.
 *
 * Each interleaving is made deterministic by opening the "other side" in its
 * own transaction, waiting until the side under test is observably blocked on
 * a lock in `pg_stat_activity`, and only then letting the other side commit.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { enqueueEvent, webhookService } from '../src/modules/webhooks/webhook.service.js';
import { lockEmailCoupling } from '../src/modules/email/email.service.js';

/** A promise plus the function that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
}

/** How many backends of this database are currently waiting on a lock. */
async function lockWaiters(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return Number(rows[0]!.n);
}

async function untilSomeoneWaitsOnALock(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await lockWaiters()) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('nothing ever blocked on a lock');
}

/** `p` settled within `ms`? Never rejects. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => { timer = setTimeout(() => r(false), ms); });
  const done = p.then(() => true as const, () => true as const);
  try {
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('lock contention on the auth write path', () => {
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

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    const operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `lc-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const op = { authorization: `Bearer ${operator}` };
    appId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: op, payload: { name: 'LC', slug: `lc-${slug}` } })
      .then((r) => (r.json().data as { id: string }).id);
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: op,
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  });

  function signUp(email: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${secretKey}` },
      payload: { email, password: 'pw-one-two-three' },
    });
  }

  describe('a webhook endpoint deleted during sign-up', () => {
    it('a delete that commits while sign-up is mid-flight costs the event, not the sign-up', async () => {
      const { endpoint } = await webhookService.createEndpoint({
        applicationId: appId,
        url: 'https://example.invalid/race-hook',
        events: ['*'],
      });

      // The operator's delete: row locked, not yet committed.
      const release = gate();
      const deleted = gate();
      const deleting = prisma.$transaction(
        async (tx) => {
          await tx.webhookEndpoint.delete({ where: { id: endpoint.id } });
          deleted.open();
          await release.wait;
        },
        { timeout: 15_000 },
      );
      await deleted.wait;

      const signingUp = signUp('racer@example.com');
      // Sign-up reaches the endpoint row and waits on the delete's lock.
      await untilSomeoneWaitsOnALock();
      release.open();
      await deleting;

      const res = await signingUp;
      expect(res.statusCode, res.body).toBe(201);
      const user = await prisma.endUser.findFirst({ where: { applicationId: appId, email: 'racer@example.com' } });
      expect(user).not.toBeNull();
      // The endpoint was gone by the time sign-up could lock it: no delivery.
      expect(await prisma.webhookDelivery.count({ where: { applicationId: appId } })).toBe(0);
    });

    it('a delete that starts after sign-up read the endpoints waits for it, then cascades the delivery', async () => {
      const { endpoint } = await webhookService.createEndpoint({
        applicationId: appId,
        url: 'https://example.invalid/race-hook',
        events: ['*'],
      });

      // Stand-in for the sign-up transaction, paused after its event rows.
      const release = gate();
      const enqueued = gate();
      let ids: string[] = [];
      const writing = prisma.$transaction(
        async (tx) => {
          ids = await enqueueEvent(tx, { applicationId: appId, type: 'user.created', data: { user: { id: 'x' } } });
          enqueued.open();
          await release.wait;
        },
        { timeout: 15_000 },
      );
      await enqueued.wait;
      expect(ids).toHaveLength(1);

      // `.then` because a Prisma query promise is lazy: it is not sent until awaited.
      const deleting = prisma.webhookEndpoint.delete({ where: { id: endpoint.id } }).then((r) => r);
      await untilSomeoneWaitsOnALock();
      expect(await settlesWithin(deleting, 300)).toBe(false);

      release.open();
      await writing;
      await deleting;
      expect(await prisma.webhookEndpoint.count({ where: { id: endpoint.id } })).toBe(0);
      expect(await prisma.webhookDelivery.count({ where: { applicationId: appId } })).toBe(0);
    });

    it('editing an endpoint does not wait on an in-flight event write', async () => {
      const { endpoint } = await webhookService.createEndpoint({
        applicationId: appId,
        url: 'https://example.invalid/race-hook',
        events: ['*'],
      });
      const release = gate();
      const enqueued = gate();
      const writing = prisma.$transaction(
        async (tx) => {
          await enqueueEvent(tx, { applicationId: appId, type: 'user.created', data: { user: { id: 'x' } } });
          enqueued.open();
          await release.wait;
        },
        { timeout: 15_000 },
      );
      await enqueued.wait;
      const editing = prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { enabled: false } }).then((r) => r);
      expect(await settlesWithin(editing, 2_000)).toBe(true);
      release.open();
      await writing;
    });
  });

  describe('the email coupling lock', () => {
    it('does not hold up a sign-up for the same Application', async () => {
      const release = gate();
      const locked = gate();
      const toggling = prisma.$transaction(
        async (tx) => {
          await lockEmailCoupling(tx, appId);
          locked.open();
          await release.wait;
        },
        { timeout: 15_000 },
      );
      await locked.wait;

      const signingUp = signUp('during-toggle@example.com');
      const finished = await settlesWithin(signingUp, 3_000);
      release.open();
      await toggling;
      expect(finished).toBe(true);
      expect((await signingUp).statusCode).toBe(201);
    });

    it('still serialises the coupling writers against each other', async () => {
      const release = gate();
      const locked = gate();
      const first = prisma.$transaction(
        async (tx) => {
          await lockEmailCoupling(tx, appId);
          locked.open();
          await release.wait;
        },
        { timeout: 15_000 },
      );
      await locked.wait;

      const second = prisma.$transaction(async (tx) => lockEmailCoupling(tx, appId), { timeout: 15_000 });
      await untilSomeoneWaitsOnALock();
      expect(await settlesWithin(second, 300)).toBe(false);

      release.open();
      await first;
      await second;
    });
  });
});
