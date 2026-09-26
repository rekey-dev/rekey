/**
 * One slow customer endpoint must not delay every other tenant's webhooks.
 *
 * Delivery attempts share a bounded pool (the BullMQ worker's concurrency, the
 * poller's lanes). Before the endpoint gate, an endpoint that accepted the
 * connection and never answered held a pool slot for the full timeout on every
 * attempt, so a backlog of its deliveries held all of them.
 *
 * The first block runs the real delivery path with the in-process gate (what
 * `NODE_ENV=test` uses). The last block tests the Redis gate directly against
 * a real Redis (REDIS_URL, provided in CI), since `getRedis()` is null under
 * test by design: that is where the cross-replica cap, the lease expiry after
 * a crash and the breaker's timing live.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import {
  MAX_ENDPOINTS_PER_APPLICATION,
  __deliveryDbLanes,
  attemptDelivery,
  processDueWebhookDeliveries,
  setDeliveryScheduler,
  webhookService,
} from '../src/modules/webhooks/webhook.service.js';
import {
  APP_MAX_IN_FLIGHT,
  BREAKER_THRESHOLD,
  ENDPOINT_MAX_IN_FLIGHT,
  FALLBACK_APP_MAX_IN_FLIGHT,
  FALLBACK_ENDPOINT_MAX_IN_FLIGHT,
  createMemoryEndpointGate,
  createRedisEndpointGate,
  deliveryTimeoutMs,
  setDeliveryTimeoutMs,
  setEndpointGate,
  slotLeaseMs,
  type EndpointGate,
} from '../src/modules/webhooks/endpoint-gate.js';

interface Receiver {
  url: string;
  hits: number;
  /** Requests being held open right now. */
  open: number;
  maxOpen: number;
  arrivals: number[];
  setHandler(h: (req: IncomingMessage, res: ServerResponse) => void): void;
  close(): Promise<void>;
}

/** A receiver that never answers unless given a handler. */
async function receiver(): Promise<Receiver> {
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  const sockets = new Set<Socket>();
  const r: Receiver = {
    url: '',
    hits: 0,
    open: 0,
    maxOpen: 0,
    arrivals: [],
    setHandler(h) {
      handler = h;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
  const server: Server = createServer((req, res) => {
    r.hits += 1;
    r.open += 1;
    r.maxOpen = Math.max(r.maxOpen, r.open);
    r.arrivals.push(Date.now());
    res.on('close', () => {
      r.open -= 1;
    });
    req.resume();
    req.on('end', () => handler?.(req, res));
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  r.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return r;
}

const ok = (_req: IncomingMessage, res: ServerResponse): void => {
  res.statusCode = 200;
  res.end('{}');
};

describe('webhook endpoint isolation (delivery path)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    setDeliveryScheduler(null);
    setEndpointGate(null);
    setDeliveryTimeoutMs(null);
    __deliveryDbLanes.set(null);
  });

  async function application(slug: string): Promise<string> {
    const s = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
    const operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `iso-${s}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${s}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    return app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operator}` },
        payload: { name: s, slug: s },
      })
      .then((r) => (r.json().data as { id: string }).id);
  }

  /** PENDING rows already due, as a restart or a backlog leaves them. */
  async function dueRows(applicationId: string, endpointId: string, n: number, ageMs: number): Promise<string[]> {
    const rows = await prisma.webhookDelivery.createManyAndReturn({
      data: Array.from({ length: n }, (_, i) => ({
        endpointId,
        applicationId,
        eventId: `evt-${endpointId}-${i}`,
        eventType: 'user.created',
        payload: { eventId: `evt-${endpointId}-${i}`, type: 'user.created', data: {} },
        status: 'PENDING' as const,
        attempts: 0,
        nextAttemptAt: new Date(Date.now() - ageMs + i),
      })),
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  it('a hung endpoint is capped and another tenant is delivered promptly from the same poll', async () => {
    // Deferred attempts would otherwise be retried by the test timer; the poll
    // is what is under test here.
    setDeliveryScheduler(() => undefined);
    const hung = await receiver();
    const healthy = await receiver();
    healthy.setHandler(ok);
    try {
      const appA = await application('hung');
      const appB = await application('healthy');
      const { endpoint: epA } = await webhookService.createEndpoint({ applicationId: appA, url: hung.url, events: ['*'] });
      const { endpoint: epB } = await webhookService.createEndpoint({ applicationId: appB, url: healthy.url, events: ['*'] });
      // The hung endpoint's rows are OLDER, so they come first in the poll's
      // order, the worst case for the healthy tenant.
      await dueRows(appA, epA.id, 20, 120_000);
      const healthyIds = await dueRows(appB, epB.id, 5, 60_000);

      const started = Date.now();
      const poll = processDueWebhookDeliveries();
      const until = Date.now() + 4_000;
      while (healthy.hits < 5 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      const healthyDoneMs = Date.now() - started;

      // Delivered well inside ONE hung timeout (10s). Without the cap, the ten
      // poll lanes are all waiting on the hung endpoint at this point.
      expect(healthy.hits).toBe(5);
      expect(healthyDoneMs).toBeLessThan(2_000);
      expect(hung.open).toBe(ENDPOINT_MAX_IN_FLIGHT);

      await hung.close();
      await poll;
      expect(hung.maxOpen).toBe(ENDPOINT_MAX_IN_FLIGHT);

      const b = await prisma.webhookDelivery.findMany({ where: { id: { in: healthyIds } } });
      expect(b.every((r) => r.status === 'SUCCEEDED' && r.attempts === 1)).toBe(true);

      // The rest of the hung backlog was put off, not sent, not failed, not
      // counted, and still PENDING with a retry time: nothing is dropped.
      const a = await prisma.webhookDelivery.findMany({ where: { endpointId: epA.id } });
      const waited = a.filter((r) => r.attempts === 0);
      expect(waited).toHaveLength(20 - ENDPOINT_MAX_IN_FLIGHT);
      expect(waited.every((r) => r.status === 'PENDING' && r.error === null && r.nextAttemptAt!.getTime() > started)).toBe(true);
    } finally {
      await hung.close().catch(() => undefined);
      await healthy.close();
    }
  });

  it('a delivery with no free slot is re-queued under a distinct job key and keeps its attempt count', async () => {
    const scheduled: Array<{ id: string; delayMs: number; attempts: number; waitKey?: string }> = [];
    setDeliveryScheduler((id, delayMs, attempts, waitKey) => {
      scheduled.push({ id, delayMs, attempts, ...(waitKey !== undefined && { waitKey }) });
    });
    const full: EndpointGate = {
      tryAcquire: async () => ({ retryInMs: 1_500 }),
      openForMs: async () => 0,
      recordResult: async () => undefined,
    };
    setEndpointGate(full);
    const sink = await receiver();
    sink.setHandler(ok);
    try {
      const appId = await application('wait');
      const { endpoint } = await webhookService.createEndpoint({ applicationId: appId, url: sink.url, events: ['*'] });
      const [id] = await dueRows(appId, endpoint.id, 1, 1_000);
      await prisma.webhookDelivery.update({ where: { id: id! }, data: { attempts: 2 } });

      const before = Date.now();
      await attemptDelivery(id!);
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: id! } });

      expect(sink.hits).toBe(0);
      expect(row.status).toBe('PENDING');
      expect(row.attempts).toBe(2);
      expect(row.error).toBeNull();
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 1_500);
      expect(row.nextAttemptAt!.getTime()).toBeLessThan(before + 3_000);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({ id, delayMs: 1_500, attempts: 2 });
      expect(scheduled[0]!.waitKey).toBe(String(row.nextAttemptAt!.getTime()));
    } finally {
      await sink.close();
    }
  });

  it('the breaker opens after consecutive failures: later attempts are counted but not sent', async () => {
    setDeliveryScheduler(() => undefined);
    const sink = await receiver();
    sink.setHandler((_req, res) => {
      res.statusCode = 503;
      res.end('down');
    });
    try {
      const appId = await application('breaker');
      const { endpoint } = await webhookService.createEndpoint({ applicationId: appId, url: sink.url, events: ['*'] });
      const ids = await dueRows(appId, endpoint.id, BREAKER_THRESHOLD + 2, 1_000);

      for (const id of ids.slice(0, BREAKER_THRESHOLD)) await attemptDelivery(id);
      expect(sink.hits).toBe(BREAKER_THRESHOLD);

      for (const id of ids.slice(BREAKER_THRESHOLD)) await attemptDelivery(id);
      expect(sink.hits).toBe(BREAKER_THRESHOLD);

      const skipped = await prisma.webhookDelivery.findMany({ where: { id: { in: ids.slice(BREAKER_THRESHOLD) } } });
      for (const r of skipped) {
        // On the normal schedule: one attempt used, first backoff (30s).
        expect(r.status).toBe('PENDING');
        expect(r.attempts).toBe(1);
        expect(r.error).toMatch(/^Not sent: the endpoint failed its last 5 sends in a row/);
        expect(r.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(25_000);
      }

      // A different endpoint is untouched by this one's circuit.
      const other = await receiver();
      other.setHandler(ok);
      const { endpoint: ep2 } = await webhookService.createEndpoint({ applicationId: appId, url: other.url, events: ['*'] });
      const [id2] = await dueRows(appId, ep2.id, 1, 1_000);
      await attemptDelivery(id2!);
      expect(other.hits).toBe(1);
      await other.close();
    } finally {
      await sink.close();
    }
  });

  it('a second poll in the same process does not start while one is running', async () => {
    setDeliveryScheduler(() => undefined);
    const hung = await receiver();
    try {
      const appId = await application('overlap');
      const { endpoint } = await webhookService.createEndpoint({ applicationId: appId, url: hung.url, events: ['*'] });
      await dueRows(appId, endpoint.id, 2, 1_000);

      // The first sweep takes one row and hangs on it.
      const first = processDueWebhookDeliveries(1);
      const until = Date.now() + 3_000;
      while (hung.hits < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      expect(hung.hits).toBe(1);

      // Without the guard this would find and send the second due row.
      const second = await processDueWebhookDeliveries();
      expect(second).toBe(0);
      expect(hung.hits).toBe(1);

      await hung.close();
      expect(await first).toBe(1);

      // Once the first sweep is done, the next one runs normally.
      expect(await processDueWebhookDeliveries()).toBe(1);
    } finally {
      await hung.close().catch(() => undefined);
    }
  });

  it('one Application with many hung endpoints is held to its cap, and another Application is delivered promptly', async () => {
    setDeliveryScheduler(() => undefined);
    const hung = await receiver();
    const healthy = await receiver();
    healthy.setHandler(ok);
    try {
      const appA = await application('many-hung');
      const appB = await application('other');
      // Three endpoints: 3 x ENDPOINT_MAX_IN_FLIGHT (12) is more than the
      // Application's cap (8), so only the Application cap can hold them.
      const endpoints = [];
      for (let i = 0; i < 3; i++) {
        const { endpoint } = await webhookService.createEndpoint({ applicationId: appA, url: hung.url, events: ['*'] });
        endpoints.push(endpoint.id);
      }
      for (const [i, ep] of endpoints.entries()) await dueRows(appA, ep, 6, 120_000 - i * 1_000);
      const { endpoint: epB } = await webhookService.createEndpoint({ applicationId: appB, url: healthy.url, events: ['*'] });
      await dueRows(appB, epB.id, 3, 60_000);

      const started = Date.now();
      const poll = processDueWebhookDeliveries();
      const until = Date.now() + 4_000;
      while (healthy.hits < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));

      expect(healthy.hits).toBe(3);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(hung.open).toBe(APP_MAX_IN_FLIGHT);

      await hung.close();
      await poll;
      expect(hung.maxOpen).toBe(APP_MAX_IN_FLIGHT);

      // Turned away by the Application cap: not sent, not counted, still due.
      const a = await prisma.webhookDelivery.findMany({ where: { applicationId: appA } });
      const waited = a.filter((r) => r.attempts === 0);
      expect(waited).toHaveLength(18 - APP_MAX_IN_FLIGHT);
      expect(waited.every((r) => r.status === 'PENDING' && r.error === null && r.nextAttemptAt!.getTime() > started)).toBe(
        true,
      );
    } finally {
      await hung.close().catch(() => undefined);
      await healthy.close();
    }
  });

  it('uses the configured request timeout', async () => {
    setDeliveryScheduler(() => undefined);
    const slow = await receiver();
    // Answers after 600ms.
    slow.setHandler((_req, res) => {
      setTimeout(() => ok(_req, res), 600);
    });
    try {
      const appId = await application('timeout');
      const { endpoint } = await webhookService.createEndpoint({ applicationId: appId, url: slow.url, events: ['*'] });
      const [late, inTime] = await dueRows(appId, endpoint.id, 2, 1_000);

      setDeliveryTimeoutMs(300);
      await attemptDelivery(late!);
      const failed = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: late! } });
      expect(failed.status).toBe('PENDING');
      expect(failed.attempts).toBe(1);
      expect(failed.responseStatus).toBeNull();
      expect(failed.error).toMatch(/abort/i);

      setDeliveryTimeoutMs(2_000);
      await attemptDelivery(inTime!);
      const done = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: inTime! } });
      expect(done.status).toBe('SUCCEEDED');
    } finally {
      await slow.close();
    }
  });

  it('database lanes bound the delivery path without serialising the sends', async () => {
    setDeliveryScheduler(() => undefined);
    const slow = await receiver();
    slow.setHandler((_req, res) => {
      setTimeout(() => ok(_req, res), 300);
    });
    try {
      const appId = await application('lanes');
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const { endpoint } = await webhookService.createEndpoint({ applicationId: appId, url: slow.url, events: ['*'] });
        ids.push(...(await dueRows(appId, endpoint.id, 1, 1_000)));
      }
      __deliveryDbLanes.set(1);
      await Promise.all(ids.map((id) => attemptDelivery(id)));

      // Every send was in flight at once, but never two attempts' database
      // statements.
      expect(slow.maxOpen).toBe(4);
      expect(__deliveryDbLanes.peak()).toBe(1);
      const rows = await prisma.webhookDelivery.findMany({ where: { id: { in: ids } } });
      expect(rows.every((r) => r.status === 'SUCCEEDED')).toBe(true);
    } finally {
      await slow.close();
    }
  });

  it('refuses an endpoint past the per-Application limit', async () => {
    const appId = await application('limit');
    await prisma.webhookEndpoint.createMany({
      data: Array.from({ length: MAX_ENDPOINTS_PER_APPLICATION }, (_, i) => ({
        applicationId: appId,
        url: `https://example.com/hook/${i}`,
        events: ['*'],
        secret: `whsec_${i}`,
        enabled: i % 2 === 0,
      })),
    });
    await expect(
      webhookService.createEndpoint({ applicationId: appId, url: 'https://example.com/one-more', events: ['*'] }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_ENDPOINT_LIMIT_REACHED', statusCode: 400 });
    expect(await prisma.webhookEndpoint.count({ where: { applicationId: appId } })).toBe(MAX_ENDPOINTS_PER_APPLICATION);

    // Another Application is not affected.
    const other = await application('limit-other');
    await expect(
      webhookService.createEndpoint({ applicationId: other, url: 'https://example.com/first', events: ['*'] }),
    ).resolves.toMatchObject({ endpoint: { applicationId: other } });
  });
});

describe('delivery timeout', () => {
  it('defaults to 10s, and the slot lease stays inside the 60s claim window at the maximum', () => {
    expect(deliveryTimeoutMs()).toBe(10_000);
    expect(slotLeaseMs()).toBe(30_000);
    expect(slotLeaseMs(30_000)).toBeLessThan(60_000);
    expect(slotLeaseMs(30_000)).toBeGreaterThanOrEqual(30_000 + 15_000);
  });
});

describe('in-process endpoint gate', () => {
  it('caps in-flight sends per endpoint and gives slots back on release', async () => {
    const gate = createMemoryEndpointGate();
    const held = [];
    for (let i = 0; i < ENDPOINT_MAX_IN_FLIGHT; i++) {
      const s = await gate.tryAcquire('ep-a', 'app-1');
      expect('release' in s).toBe(true);
      held.push(s);
    }
    const denied = await gate.tryAcquire('ep-a', 'app-1');
    expect('retryInMs' in denied && denied.retryInMs > 0).toBe(true);
    expect('release' in (await gate.tryAcquire('ep-b', 'app-1'))).toBe(true);
    const first = held[0]!;
    if ('release' in first) {
      await first.release();
      await first.release(); // idempotent: a double release must not free two
    }
    expect('release' in (await gate.tryAcquire('ep-a', 'app-1'))).toBe(true);
    expect('retryInMs' in (await gate.tryAcquire('ep-a', 'app-1'))).toBe(true);
  });

  it('caps in-flight sends per Application across its endpoints', async () => {
    const gate = createMemoryEndpointGate({ appMax: 3 });
    const held = [];
    for (let i = 0; i < 3; i++) {
      const s = await gate.tryAcquire(`ep-${i}`, 'app-1');
      expect('release' in s).toBe(true);
      held.push(s);
    }
    expect('retryInMs' in (await gate.tryAcquire('ep-new', 'app-1'))).toBe(true);
    // Refused at the Application level, so ep-new's own slot was not kept.
    expect('release' in (await gate.tryAcquire('ep-new', 'app-2'))).toBe(true);
    const first = held[0]!;
    if ('release' in first) await first.release();
    expect('release' in (await gate.tryAcquire('ep-new', 'app-1'))).toBe(true);
  });
});

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

describe('Redis endpoint gate', () => {
  let redis: Redis;
  let ep: string;

  beforeAll(() => {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    await redis.quit();
  });

  const fresh = (): string => `ep-${Math.random().toString(36).slice(2)}`;
  const freshApp = (): string => `app-${Math.random().toString(36).slice(2)}`;

  it('holds the cap across two replicas sharing Redis', async () => {
    ep = fresh();
    const appId = freshApp();
    const replicaA = createRedisEndpointGate(redis);
    const replicaB = createRedisEndpointGate(redis);
    const slots = [];
    for (let i = 0; i < ENDPOINT_MAX_IN_FLIGHT; i++) {
      slots.push(await (i % 2 === 0 ? replicaA : replicaB).tryAcquire(ep, appId));
    }
    expect(slots.every((s) => 'release' in s)).toBe(true);
    const denied = await replicaB.tryAcquire(ep, appId);
    expect('retryInMs' in denied).toBe(true);
    // Another endpoint is not affected.
    expect('release' in (await replicaB.tryAcquire(fresh(), appId))).toBe(true);

    const s0 = slots[0]!;
    if ('release' in s0) await s0.release();
    expect('release' in (await replicaB.tryAcquire(ep, appId))).toBe(true);
  });

  it('turned-away attempts back off further the more of them there are', async () => {
    ep = fresh();
    const appId = freshApp();
    const gate = createRedisEndpointGate(redis);
    for (let i = 0; i < ENDPOINT_MAX_IN_FLIGHT; i++) await gate.tryAcquire(ep, appId);
    const waits: number[] = [];
    for (let i = 0; i < 200; i++) {
      const s = await gate.tryAcquire(ep, appId);
      if ('retryInMs' in s) waits.push(s.retryInMs);
    }
    expect(waits).toHaveLength(200);
    expect(Math.min(...waits.slice(0, 5))).toBeLessThan(1_000);
    expect(Math.min(...waits.slice(-5))).toBeGreaterThan(7_000);
  });

  it('a slot whose holder crashed comes back when its lease runs out', async () => {
    ep = fresh();
    const appId = freshApp();
    const gate = createRedisEndpointGate(redis, { leaseMs: 300 });
    for (let i = 0; i < ENDPOINT_MAX_IN_FLIGHT; i++) {
      expect('release' in (await gate.tryAcquire(ep, appId))).toBe(true); // never released
    }
    expect('retryInMs' in (await gate.tryAcquire(ep, appId))).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect('release' in (await gate.tryAcquire(ep, appId))).toBe(true);
  });

  it('the breaker opens at the threshold, half-opens, re-opens on a failure and closes on a success', async () => {
    ep = fresh();
    const gate = createRedisEndpointGate(redis, { openMs: 300 });
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i++) await gate.recordResult(ep, false);
    expect(await gate.openForMs(ep)).toBe(0);
    await gate.recordResult(ep, false);
    expect(await gate.openForMs(ep)).toBeGreaterThan(0);

    // Half-open: the window ends and sends are allowed again...
    await new Promise((r) => setTimeout(r, 400));
    expect(await gate.openForMs(ep)).toBe(0);
    // ...and one more failure re-opens it at once.
    await gate.recordResult(ep, false);
    expect(await gate.openForMs(ep)).toBeGreaterThan(0);

    // A success closes it and forgets the streak.
    await gate.recordResult(ep, true);
    expect(await gate.openForMs(ep)).toBe(0);
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i++) await gate.recordResult(ep, false);
    expect(await gate.openForMs(ep)).toBe(0);
  });

  it('holds the Application cap across two replicas while another Application proceeds', async () => {
    const appA = freshApp();
    const appB = freshApp();
    const replicaA = createRedisEndpointGate(redis, { appMaxInFlight: 3 });
    const replicaB = createRedisEndpointGate(redis, { appMaxInFlight: 3 });
    const eps = [fresh(), fresh(), fresh()];
    const held = [];
    for (let i = 0; i < 3; i++) {
      const s = await (i % 2 === 0 ? replicaA : replicaB).tryAcquire(eps[i]!, appA);
      expect('release' in s).toBe(true);
      held.push(s);
    }
    // A fourth endpoint of the same Application, on either replica, waits.
    const epNew = fresh();
    const denied = await replicaB.tryAcquire(epNew, appA);
    expect('retryInMs' in denied && denied.retryInMs > 0).toBe(true);
    expect('retryInMs' in (await replicaA.tryAcquire(eps[0]!, appA))).toBe(true);
    // The endpoint slot taken before the Application refused is given back.
    expect(await redis.zcard(`whk:ep:{${epNew}}:inflight`)).toBe(0);

    // Another Application is unaffected.
    const other = await replicaA.tryAcquire(fresh(), appB);
    expect('release' in other).toBe(true);

    // Releasing one frees exactly one Application slot, on the other replica too.
    const h0 = held[0]!;
    if ('release' in h0) await h0.release();
    expect(await redis.zcard(`whk:app:{${appA}}:inflight`)).toBe(2);
    expect(await redis.zcard(`whk:ep:{${eps[0]}}:inflight`)).toBe(0);
    expect('release' in (await replicaB.tryAcquire(epNew, appA))).toBe(true);
    expect('retryInMs' in (await replicaA.tryAcquire(fresh(), appA))).toBe(true);
  });

  it('an Application slot whose holder crashed comes back when its lease runs out', async () => {
    const appId = freshApp();
    const gate = createRedisEndpointGate(redis, { leaseMs: 300, appMaxInFlight: 2 });
    expect('release' in (await gate.tryAcquire(fresh(), appId))).toBe(true); // never released
    expect('release' in (await gate.tryAcquire(fresh(), appId))).toBe(true); // never released
    expect('retryInMs' in (await gate.tryAcquire(fresh(), appId))).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect('release' in (await gate.tryAcquire(fresh(), appId))).toBe(true);
  });

  it('falls back to small in-process caps when Redis errors, not to no cap at all', async () => {
    const down = async (): Promise<never> => {
      throw new Error('connection is closed');
    };
    const broken = { eval: down, zrem: down, pttl: down, del: down } as unknown as Parameters<
      typeof createRedisEndpointGate
    >[0];
    const gate = createRedisEndpointGate(broken);

    // Per endpoint.
    const held = [];
    for (let i = 0; i < FALLBACK_ENDPOINT_MAX_IN_FLIGHT; i++) {
      const s = await gate.tryAcquire('ep-x', 'app-x');
      expect('release' in s).toBe(true);
      held.push(s);
    }
    expect('retryInMs' in (await gate.tryAcquire('ep-x', 'app-x'))).toBe(true);

    // Per Application, across its endpoints.
    for (let i = FALLBACK_ENDPOINT_MAX_IN_FLIGHT; i < FALLBACK_APP_MAX_IN_FLIGHT; i++) {
      const s = await gate.tryAcquire(`ep-y${i}`, 'app-x');
      expect('release' in s).toBe(true);
      held.push(s);
    }
    expect('retryInMs' in (await gate.tryAcquire('ep-z', 'app-x'))).toBe(true);
    expect('release' in (await gate.tryAcquire('ep-z', 'app-other'))).toBe(true);

    // Release gives the slot back.
    const h0 = held[0]!;
    if ('release' in h0) await h0.release();
    expect('release' in (await gate.tryAcquire('ep-x', 'app-x'))).toBe(true);

    // A local breaker keeps working too.
    expect(await gate.openForMs('ep-x')).toBe(0);
    for (let i = 0; i < BREAKER_THRESHOLD; i++) await gate.recordResult('ep-x', false);
    expect(await gate.openForMs('ep-x')).toBeGreaterThan(0);
    await gate.recordResult('ep-x', true);
    expect(await gate.openForMs('ep-x')).toBe(0);
  });

  it('falls back only for the call that failed, and gives back a Redis slot taken before the error', async () => {
    let failApp = true;
    const proxied = {
      eval: async (...args: Parameters<Redis['eval']>) => {
        // The second script of an acquire (the Application slot) errors.
        if (failApp && String(args[2]).startsWith('whk:app:')) throw new Error('connection is closed');
        return redis.eval(...args);
      },
      zrem: (...args: Parameters<Redis['zrem']>) => redis.zrem(...args),
      pttl: (key: string) => redis.pttl(key),
      del: (...keys: string[]) => redis.del(...keys),
    } as unknown as Parameters<typeof createRedisEndpointGate>[0];
    const gate = createRedisEndpointGate(proxied);
    const e = fresh();
    const s = await gate.tryAcquire(e, freshApp());
    expect('release' in s).toBe(true);
    expect(await redis.zcard(`whk:ep:{${e}}:inflight`)).toBe(0);
    failApp = false;
    const t = await gate.tryAcquire(e, freshApp());
    expect('release' in t).toBe(true);
    expect(await redis.zcard(`whk:ep:{${e}}:inflight`)).toBe(1);
  });
});
