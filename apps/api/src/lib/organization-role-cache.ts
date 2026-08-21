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
 * authority until it lets go. Three things bound that:
 *
 *   1. The process that made the change invalidates its own snapshot before
 *      returning, so it is never wrong about its own write.
 *   2. It also PUBLISHES the change over Redis, and every other process drops
 *      the same key on receipt. That is the normal propagation path, and it is
 *      why running several API replicas does not weaken this.
 *   3. `ORG_ROLE_CACHE_TTL_MS` is the backstop for when Redis is unreachable
 *      at the moment of a change. Set it to 0 to disable caching outright.
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
 * Ceiling on distinct Applications held at once. Past it the least-recently
 * loaded entry is dropped, so a multi-tenant instance serving thousands of
 * Applications cannot grow this map without bound. Exceeding it costs a query,
 * never correctness.
 */
const MAX_APPLICATIONS = 5_000;

interface Entry {
  roles: OrganizationRoleDef[];
  loadedAt: number;
}

const cache = new Map<string, Entry>();

/**
 * The subscriber is a SEPARATE connection: a Redis client in subscriber mode
 * cannot run ordinary commands, so it must not be the shared client every other
 * caller publishes and queries with.
 */
let subscriber: ReturnType<typeof getRedis> = null;
let subscribeStarted = false;

function ensureSubscribed(): void {
  if (subscribeStarted) return;
  subscribeStarted = true;
  const base = getRedis();
  if (!base) return; // NODE_ENV=test, or no Redis configured.
  subscriber = base.duplicate();
  subscriber.on('error', () => {
    /* Consumers degrade to the TTL; an unhandled 'error' event is the risk. */
  });
  void subscriber.subscribe(CHANNEL).catch(() => undefined);
  subscriber.on('message', (channel: string, message: string) => {
    if (channel !== CHANNEL) return;
    // An empty payload means "drop everything" (used by the test helper).
    if (message === '*') cache.clear();
    else cache.delete(message);
  });
}

/** Stop the subscriber. Called from the API's shutdown path alongside Redis. */
export async function closeOrganizationRoleCache(): Promise<void> {
  if (subscriber) {
    await subscriber.quit().catch(() => undefined);
    subscriber = null;
  }
  subscribeStarted = false;
  cache.clear();
}

/**
 * Drop the snapshot for one Application, here and everywhere else.
 *
 * Local first, so the caller is correct even if the publish fails. The publish
 * is fire-and-forget for the same reason: an operator's role edit must not fail
 * because Redis blinked, and the TTL already covers that case.
 */
export function invalidateOrganizationRoles(applicationId: string): void {
  cache.delete(applicationId);
  const redis = getRedis();
  if (!redis) return;
  void redis.publish(CHANNEL, applicationId).catch(() => undefined);
}

/** Drop everything in this process. Test helper; not used in normal operation. */
export function clearOrganizationRoleCache(): void {
  cache.clear();
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
  if (ttl > 0) {
    ensureSubscribed();
    const hit = cache.get(applicationId);
    if (hit && Date.now() - hit.loadedAt < ttl) return hit.roles;
  }

  const roles = await prisma.organizationRoleDef.findMany({
    where: { applicationId },
    orderBy: [{ isBuiltIn: 'desc' }, { name: 'asc' }],
  });

  if (ttl > 0) {
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
