/**
 * Per-Application cache of the organization-role catalog.
 *
 * The catalog is read on nearly every org-scoped request: `requireRole`
 * resolves the caller's stored role name to a tier, `activeRoleFor` does the
 * same for `GET /me`, and `setMemberRole` resolves three names in one call.
 * Every one of those was an uncached round-trip to a table that is
 * operator-authored, a handful of rows, and changes a few times in an
 * Application's life.
 *
 * WHY A CACHE IS SAFE HERE
 *
 * This is authorization input, so staleness has teeth: lower a role's tier, or
 * disable it, and a process holding the old snapshot keeps granting the old
 * authority until it lets go. What bounds it:
 *
 *   1. The process that made the change invalidates its own snapshot before
 *      returning, so it is never wrong about its own write.
 *   2. It also PUBLISHES the change over Redis, and every other process drops
 *      the same key on receipt. That is the normal propagation path, and it is
 *      why running several API replicas does not weaken this.
 *   3. A process serves nothing from this cache until Redis has CONFIRMED its
 *      subscription, and it empties the cache and stops serving from it the
 *      moment the subscriber disconnects. So a replica that cannot hear
 *      invalidations reads the table on every call instead of trusting a
 *      snapshot it would never be told is stale.
 *   4. A load that raced an invalidation is not stored. `generation` is bumped
 *      by every invalidation, local or received, and a load only writes its
 *      result back if the generation it started under is still current.
 *      Without this, an edit that commits while a catalog read is in flight is
 *      undone by that read: it deletes the key, then the reader puts the
 *      pre-edit rows back and every later request in this process serves them
 *      for a full TTL. This mirrors point 4 of `operator-auth-cache.ts`.
 *   5. `ORG_ROLE_CACHE_TTL_MS` is the backstop for a publish that is lost while
 *      every subscriber is still connected. Set it to 0 to disable caching
 *      outright.
 *
 * Redis is a dependency the API already refuses to boot without (the outbound
 * webhook queue), so this adds no new infrastructure. If the subscriber is
 * down, the TTL still bounds staleness; if Redis is down entirely, so is the
 * queue, and the deployment has a larger problem than a 5-second role cache.
 *
 * What is NOT cached: membership rows. Which role a given end-user holds is
 * read live on every request, exactly as before. Only the catalog is cached,
 * so changing a role for a PERSON takes effect immediately; only changing what
 * a role NAME means is subject to any of the above.
 */

import type { OrganizationBaseRole, OrganizationRoleDef } from '@prisma/client';
import { prisma } from './prisma.js';
import { getRedis } from './redis.js';
import { env } from '../config/env.js';

/** Channel the invalidation fan-out publishes application ids on. */
const CHANNEL = 'rekey:org-roles:invalidate';

/**
 * Ceiling on distinct Applications held at once. Past it the oldest-inserted
 * entry is dropped, not the least recently used: true LRU was rejected as too
 * costly on a hot path (see `loadRoles`). So a multi-tenant instance serving
 * thousands of Applications cannot grow this map without bound. Exceeding it costs a query,
 * never correctness.
 */
const MAX_APPLICATIONS = 5_000;

interface Entry {
  roles: OrganizationRoleDef[];
  loadedAt: number;
}

const cache = new Map<string, Entry>();

/** Bumped by every invalidation, local or received. See point 4 above. */
let generation = 0;

/** Drop one Application's snapshot here, and invalidate any load in flight. */
function drop(applicationId: string): void {
  generation++;
  cache.delete(applicationId);
}

/** Drop everything here, and invalidate every load in flight. */
function dropAll(): void {
  generation++;
  cache.clear();
}

/**
 * The subscriber is a SEPARATE connection: a Redis client in subscriber mode
 * cannot run ordinary commands, so it must not be the shared client every other
 * caller publishes and queries with.
 */
let subscriber: ReturnType<typeof getRedis> = null;
let subscribeStarted = false;
/**
 * Whether cached snapshots may be served. True when there is no Redis to miss
 * messages from (NODE_ENV=test, or no REDIS_URL), or once Redis has confirmed
 * the subscription. False from any disconnect until it is confirmed again.
 */
let subscriberReady = false;

/**
 * The Redis client pub/sub runs over. A test can substitute an in-memory bus
 * (`__usePubSubForTests`) to play two processes against each other without a
 * Redis server; `getRedis()` returns null under NODE_ENV=test otherwise.
 */
let testBus: ReturnType<typeof getRedis> | undefined;
function bus(): ReturnType<typeof getRedis> {
  return testBus !== undefined ? testBus : getRedis();
}

function ensureSubscribed(): void {
  if (subscribeStarted) return;
  subscribeStarted = true;
  const base = bus();
  if (!base) {
    // No Redis: a single process, so there is no other writer to miss.
    subscriberReady = true;
    return;
  }
  subscriber = base.duplicate();
  const sub = subscriber;
  const offline = (): void => {
    if (subscriberReady) dropAll();
    subscriberReady = false;
  };
  // Anything published before Redis confirms the subscription never reached
  // us, so start from empty once it does.
  const subscribeNow = (): Promise<void> =>
    sub
      .subscribe(CHANNEL)
      .then(() => {
        dropAll();
        subscriberReady = true;
      })
      .catch(() => undefined);
  // 'error' alone is not a disconnect (ioredis follows a real one with
  // 'close'); treating it as one could park the cache off for good.
  sub.on('error', () => {
    /* Consumers degrade to reading the table; an unhandled 'error' is the risk. */
  });
  sub.on('close', offline);
  sub.on('end', offline);
  // Every (re)connect. The shared client in lib/redis.ts is built with the
  // offline queue off, and `duplicate()` inherits that, so a SUBSCRIBE sent
  // while the connection is still coming up is rejected rather than queued.
  // Subscribing only once, straight after `duplicate()`, meant the process was
  // never subscribed at all.
  sub.on('ready', () => {
    void subscribeNow();
  });
  sub.on('message', (channel: string, message: string) => {
    if (channel !== CHANNEL) return;
    // `*` means "drop everything" (used by the test helper).
    if (message === '*') dropAll();
    else drop(message);
  });
  // Already connected (or a client that queues): subscribe straight away.
  void subscribeNow();
}

/** Stop the subscriber. Called from the API's shutdown path alongside Redis. */
export async function closeOrganizationRoleCache(): Promise<void> {
  if (subscriber) {
    const s = subscriber;
    subscriber = null;
    await s.quit().catch(() => undefined);
  }
  subscribeStarted = false;
  subscriberReady = false;
  dropAll();
}

/**
 * Route pub/sub through `fake` (or back to the real client with `undefined`).
 * Starts the subscription again from scratch, as a process boot would.
 */
export function __usePubSubForTests(fake: unknown): void {
  testBus = fake as ReturnType<typeof getRedis> | undefined;
  subscriber = null;
  subscribeStarted = false;
  subscriberReady = false;
  dropAll();
}

/** Whether this process currently serves from the cache. Test introspection. */
export function __isServingFromCacheForTests(): boolean {
  return subscriberReady;
}

/**
 * Drop the snapshot for one Application, here and everywhere else.
 *
 * Local first, so the caller is correct even if the publish fails. The publish
 * is fire-and-forget for the same reason: an operator's role edit must not fail
 * because Redis blinked, and the TTL already covers that case.
 */
export function invalidateOrganizationRoles(applicationId: string): void {
  drop(applicationId);
  const redis = bus();
  if (!redis) return;
  void redis.publish(CHANNEL, applicationId).catch(() => undefined);
}

/** Drop everything in this process. Test helper; not used in normal operation. */
export function clearOrganizationRoleCache(): void {
  dropAll();
}

/**
 * The Application's catalog rows, from cache when fresh.
 *
 * Concurrent misses may each issue a query. That is deliberate: sharing an
 * in-flight promise would make one slow query block every caller behind it, and
 * the duplicate work is a single indexed read of a handful of rows.
 */
export async function getOrganizationRoles(
  applicationId: string,
): Promise<OrganizationRoleDef[]> {
  const ttl = env.ORG_ROLE_CACHE_TTL_MS;
  let serving = false;
  if (ttl > 0) {
    ensureSubscribed();
    serving = subscriberReady;
  }
  if (serving) {
    const hit = cache.get(applicationId);
    if (hit && Date.now() - hit.loadedAt < ttl) return hit.roles;
  }

  // Taken before the read. An invalidation that lands while the query is in
  // flight makes the store below a no-op, so the rows this read saw cannot be
  // written back over a newer edit.
  const ticket = generation;
  const roles = await prisma.organizationRoleDef.findMany({
    where: { applicationId },
    orderBy: [{ isBuiltIn: 'desc' }, { name: 'asc' }],
  });

  if (serving && subscriberReady && ticket === generation) {
    if (cache.size >= MAX_APPLICATIONS && !cache.has(applicationId)) {
      // Map iteration is insertion-ordered, so the first key is the oldest
      // insertion. Good enough for a bound that exists to stop unbounded
      // growth, and cheaper than true LRU on a hot path.
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(applicationId, { roles, loadedAt: Date.now() });
  }
  return roles;
}

/** Name to tier for one Application, from the cached snapshot. */
export async function organizationRoleTiers(
  applicationId: string,
): Promise<Map<string, OrganizationBaseRole>> {
  const roles = await getOrganizationRoles(applicationId);
  return new Map(roles.map((r) => [r.name, r.baseRole]));
}
