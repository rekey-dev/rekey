/**
 * A Redis that keeps its sockets open and stops answering must not hang the API.
 *
 * `docker pause` on Redis does exactly that: the connection stays up, so
 * nothing rejects, and every request that touches Redis waited for ever. The
 * auth tier's fail-closed 503 never fired because no command ever failed.
 *
 * The server here is a real TCP relay in front of the real Redis. Stalled, it
 * keeps accepting connections and forwards nothing, which is what a paused
 * Redis looks like from the client.
 */

import { createServer, connect, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

const state = { client: null as Redis | null };

vi.mock('../src/lib/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/redis.js')>();
  return {
    ...actual,
    getRedis: () => state.client,
    closeRedis: async () => {
      state.client?.disconnect();
      state.client = null;
    },
  };
});

const { createSharedRedis } = await import('../src/lib/redis.js');
const { buildApp } = await import('../src/app.js');

/** A database of its own, so sign-in counters from an earlier run cannot lock this one out. */
const SCRATCH_DB = 15;

const upstream = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

class StallableRelay {
  private server: Server;
  private sockets = new Set<Socket>();
  private stalled = false;

  constructor() {
    this.server = createServer((client) => {
      this.sockets.add(client);
      client.on('error', () => undefined);
      client.on('close', () => this.sockets.delete(client));
      if (this.stalled) return;
      const redis = connect(Number(upstream.port || 6379), upstream.hostname);
      this.sockets.add(redis);
      redis.on('error', () => undefined);
      redis.on('close', () => this.sockets.delete(redis));
      client.on('data', (chunk) => {
        if (!this.stalled) redis.write(chunk);
      });
      redis.on('data', (chunk) => {
        if (!this.stalled) client.write(chunk);
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `redis://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stall(): void {
    this.stalled = true;
  }

  /** New connections are relayed again. One accepted while stalled stays silent. */
  resume(): void {
    this.stalled = false;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const SIGN_IN = {
  method: 'POST',
  url: '/api/v1/tenant/auth/sign-in',
  payload: { email: 'nobody@example.com', password: 'not-the-password' },
} as const;

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
}

describe('a stalled Redis', () => {
  let relay: StallableRelay;
  let app: FastifyInstance;

  beforeAll(async () => {
    relay = new StallableRelay();
    state.client = createSharedRedis(`${await relay.listen()}/${SCRATCH_DB}`);
    await new Promise<void>((resolve) => state.client!.once('ready', () => resolve()));
    await state.client.flushdb();
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await relay.close();
  });

  it('answers normally while Redis answers', async () => {
    const signIn = await app.inject(SIGN_IN);
    expect(signIn.statusCode).toBe(401);
    expect(signIn.json().error.code).toBe('INVALID_CREDENTIALS');

    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ db: 'ok', redis: 'ok' });
  });

  it('leaves a subscriber listening past the command deadline', async () => {
    const subscriber = state.client!.duplicate();
    subscriber.on('error', () => undefined);
    await new Promise<void>((resolve) => subscriber.once('ready', () => resolve()));
    await subscriber.subscribe('redis-stalled-test');
    const received = new Promise<string>((resolve) => subscriber.once('message', (_channel, message) => resolve(message)));

    await new Promise((resolve) => setTimeout(resolve, 1500));
    await state.client!.publish('redis-stalled-test', 'still here');

    await expect(received).resolves.toBe('still here');
    subscriber.disconnect();
  });

  it('refuses an auth route with a 503 naming Redis in under two seconds, and keeps doing so', async () => {
    relay.stall();

    const first = await timed(() => app.inject(SIGN_IN));
    expect(first.value.statusCode).toBe(503);
    expect(first.value.json().error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(JSON.stringify(first.value.json())).toMatch(/redis/i);
    expect(first.ms).toBeLessThan(2000);

    const second = await timed(() => app.inject(SIGN_IN));
    expect(second.value.statusCode).toBe(503);
    expect(second.ms).toBeLessThan(2000);
  });

  it('reports Redis as unreachable on the readiness probe in under two seconds, and stays live', async () => {
    const ready = await timed(() => app.inject({ method: 'GET', url: '/health/ready' }));
    expect(ready.value.statusCode).toBe(503);
    expect(ready.value.json()).toMatchObject({ db: 'ok', redis: 'unreachable' });
    expect(ready.ms).toBeLessThan(2000);

    const health = await timed(() => app.inject({ method: 'GET', url: '/health' }));
    expect(health.value.json()).toMatchObject({ redis: 'unreachable' });
    expect(health.ms).toBeLessThan(2000);

    const live = await timed(() => app.inject({ method: 'GET', url: '/health/live' }));
    expect(live.value.statusCode).toBe(200);
    expect(live.ms).toBeLessThan(500);
  });

  it('serves again once Redis answers, without a restart', async () => {
    relay.resume();
    await expect
      .poll(async () => (await app.inject(SIGN_IN)).statusCode, { timeout: 10_000, interval: 250 })
      .toBe(401);
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.json()).toMatchObject({ db: 'ok', redis: 'ok' });
  });
});
