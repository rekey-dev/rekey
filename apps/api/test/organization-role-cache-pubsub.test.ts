/**
 * The organization-role catalog cache must hear invalidations from other
 * replicas, and must not serve a snapshot while it cannot.
 *
 * The bug this pins: `ensureSubscribed()` sent SUBSCRIBE once, straight after
 * `getRedis().duplicate()`. The shared client is built with the offline queue
 * off and the duplicate inherits that, so the SUBSCRIBE went out while the
 * connection was still coming up, was rejected, and the rejection was
 * swallowed. Nothing retried, so no process was ever subscribed and another
 * replica's role edit reached this one only through the 5 second TTL.
 *
 * "Process B" is a second copy of the module graph (`vi.resetModules`), with
 * its own cache, joined to process A only by an in-memory bus standing in for
 * Redis.
 *
 * Both copies share ONE Prisma client: lib/prisma.ts keeps it on globalThis,
 * which survives `vi.resetModules()` and outlives this file in the single-fork
 * worker. The catalog query is therefore replaced once per test, and each
 * assertion counts the reads made between two points in that test.
 *
 * It is replaced by assignment, not `vi.spyOn`. A Prisma model delegate is a
 * Proxy: `findMany` is produced on each read and its property descriptor
 * reports `undefined`, so `spyOn` records `undefined` as the original and its
 * restore writes `undefined` back, and deleting the override does not bring
 * the method back either. The real method, read once before anything is
 * replaced, is written back after every test.
 */

import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as cacheA from '../src/lib/organization-role-cache.js';
import { prisma as prismaA } from '../src/lib/prisma.js';

type CacheModule = typeof import('../src/lib/organization-role-cache.js');

const CHANNEL = 'rekey:org-roles:invalidate';

/** The shared delegate, typed so a test can assign over its query. */
const delegate = prismaA.organizationRoleDef as unknown as { findMany: unknown };
/** The real catalog query, read before this file replaces anything. */
const originalFindMany = prismaA.organizationRoleDef.findMany;

/** Like an ioredis duplicate with the offline queue off. */
class FakeSubscriber extends EventEmitter {
  channels = new Set<string>();
  constructor(
    private readonly bus: FakeBus,
    public connected: boolean,
  ) {
    super();
  }
  /** Refused until connected, exactly as ioredis rejects with the queue off. */
  subscribe(channel: string): Promise<number> {
    if (!this.connected) return Promise.reject(new Error("Stream isn't writeable"));
    this.channels.add(channel);
    return Promise.resolve(1);
  }
  connect(): void {
    this.connected = true;
    this.emit('ready');
  }
  /** A dropped connection: Redis forgets the subscription, ioredis emits 'close'. */
  disconnect(): void {
    this.connected = false;
    this.channels.clear();
    this.emit('close');
  }
  quit(): Promise<string> {
    this.bus.subscribers.delete(this);
    this.emit('end');
    return Promise.resolve('OK');
  }
}

class FakeBus {
  constructor(private readonly startConnected: boolean) {}
  subscribers = new Set<FakeSubscriber>();
  publish(channel: string, message: string): Promise<number> {
    let n = 0;
    for (const s of this.subscribers) {
      if (s.channels.has(channel)) {
        n++;
        setImmediate(() => s.emit('message', channel, message));
      }
    }
    return Promise.resolve(n);
  }
  duplicate(): FakeSubscriber {
    const s = new FakeSubscriber(this, this.startConnected);
    this.subscribers.add(s);
    return s;
  }
  /** What `PUBSUB NUMSUB <channel>` would report. */
  numsub(channel: string): number {
    return [...this.subscribers].filter((s) => s.channels.has(channel)).length;
  }
}

/** Let rejected subscribes settle and queued deliveries run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

const APP = 'app_orgrole_pubsub';
const roles = (label: string) => [{ id: label, applicationId: APP, name: label } as never];

describe('organization-role cache: cross-replica invalidation', () => {
  let cacheB: CacheModule;
  let reads: MockInstance;

  beforeEach(async () => {
    vi.resetModules();
    cacheB = (await import('../src/lib/organization-role-cache.js')) as CacheModule;
    reads = vi.fn().mockResolvedValue(roles('v1'));
    delegate.findMany = reads;
  });

  afterEach(() => {
    delegate.findMany = originalFindMany;
    // Every test file shares this worker; hand the real client back.
    cacheA.__usePubSubForTests(undefined);
    cacheB.__usePubSubForTests(undefined);
  });

  afterAll(async () => {
    // The next file in this worker must get the real query back.
    expect(prismaA.organizationRoleDef.findMany).toBe(originalFindMany);
    expect(vi.isMockFunction(prismaA.organizationRoleDef.findMany)).toBe(false);
    await expect(
      prismaA.organizationRoleDef.findMany({ where: { applicationId: 'no-such-application' } }),
    ).resolves.toEqual([]);
  });

  it('subscribes once the connection is ready, even though the first SUBSCRIBE is refused', async () => {
    // A fresh ioredis duplicate is still connecting when it is created.
    const bus = new FakeBus(false);
    cacheA.__usePubSubForTests(bus);
    cacheB.__usePubSubForTests(bus);

    await cacheA.getOrganizationRoles(APP);
    await cacheB.getOrganizationRoles(APP);
    await settle();
    expect(bus.numsub(CHANNEL)).toBe(0);

    for (const s of [...bus.subscribers]) s.connect();
    await settle();
    expect(bus.numsub(CHANNEL)).toBe(2);
  });

  it('serves nothing from cache until the subscription is confirmed', async () => {
    const bus = new FakeBus(false);
    cacheB.__usePubSubForTests(bus);

    for (let i = 0; i < 3; i++) await cacheB.getOrganizationRoles(APP);
    expect(reads).toHaveBeenCalledTimes(3);
    expect(cacheB.__isServingFromCacheForTests()).toBe(false);

    for (const s of [...bus.subscribers]) s.connect();
    await settle();
    expect(cacheB.__isServingFromCacheForTests()).toBe(true);
    await cacheB.getOrganizationRoles(APP);
    await cacheB.getOrganizationRoles(APP);
    expect(reads).toHaveBeenCalledTimes(4);
  });

  it("drops another replica's snapshot when one replica edits the catalog", async () => {
    const bus = new FakeBus(false);
    cacheA.__usePubSubForTests(bus);
    cacheB.__usePubSubForTests(bus);
    await cacheA.getOrganizationRoles(APP);
    await cacheB.getOrganizationRoles(APP);
    for (const s of [...bus.subscribers]) s.connect();
    await settle();

    // B warms up and is now answering from memory.
    expect(await cacheB.getOrganizationRoles(APP)).toEqual(roles('v1'));
    const warm = reads.mock.calls.length;
    await cacheB.getOrganizationRoles(APP);
    expect(reads).toHaveBeenCalledTimes(warm);

    // A changes what a role means and invalidates.
    reads.mockResolvedValue(roles('v2'));
    cacheA.invalidateOrganizationRoles(APP);
    await settle();

    // B's very next read goes to the table, well inside the 5 s TTL.
    expect(await cacheB.getOrganizationRoles(APP)).toEqual(roles('v2'));
    expect(reads).toHaveBeenCalledTimes(warm + 1);
  });

  it('stops serving and empties the cache on disconnect, and resumes on reconnect', async () => {
    const bus = new FakeBus(true);
    cacheB.__usePubSubForTests(bus);
    await cacheB.getOrganizationRoles(APP);
    await settle();
    await cacheB.getOrganizationRoles(APP);
    await cacheB.getOrganizationRoles(APP);
    const warm = reads.mock.calls.length;

    const [sub] = [...bus.subscribers];
    sub!.disconnect();
    expect(cacheB.__isServingFromCacheForTests()).toBe(false);
    await cacheB.getOrganizationRoles(APP);
    await cacheB.getOrganizationRoles(APP);
    expect(reads).toHaveBeenCalledTimes(warm + 2);

    sub!.connect();
    await settle();
    expect(bus.numsub(CHANNEL)).toBe(1);
    expect(cacheB.__isServingFromCacheForTests()).toBe(true);
  });

  it('a catalog read in flight when the edit lands is not written back', async () => {
    const bus = new FakeBus(true);
    cacheB.__usePubSubForTests(bus);
    await cacheB.getOrganizationRoles(APP);
    await settle();

    // A read that has reached the table but not yet returned. The edit below
    // commits inside that window, exactly as a role edit does against a
    // request already in the handler.
    let releaseRead!: () => void;
    const held = new Promise<void>((r) => (releaseRead = r));
    reads.mockImplementationOnce(async () => {
      await held;
      return roles('v1');
    });
    const inFlight = cacheB.getOrganizationRoles(APP);
    await settle();

    // Another replica lowers what the role means, and B hears it.
    await bus.publish(CHANNEL, APP);
    await settle();
    reads.mockResolvedValue(roles('v2'));

    releaseRead();
    // The in-flight read is answered on the rows it saw, as it would be with
    // no cache at all...
    expect(await inFlight).toEqual(roles('v1'));
    const afterRace = reads.mock.calls.length;
    // ...but it must not have put them back: the next read sees the edit.
    expect(await cacheB.getOrganizationRoles(APP)).toEqual(roles('v2'));
    expect(reads).toHaveBeenCalledTimes(afterRace + 1);
  });

  it('a `*` message drops every Application', async () => {
    const bus = new FakeBus(true);
    cacheB.__usePubSubForTests(bus);
    await cacheB.getOrganizationRoles(APP);
    await settle();
    await cacheB.getOrganizationRoles(APP);
    const warm = reads.mock.calls.length;

    await bus.publish(CHANNEL, '*');
    await settle();
    await cacheB.getOrganizationRoles(APP);
    expect(reads).toHaveBeenCalledTimes(warm + 1);
  });
});
