/**
 * In-process cache for the operator auth read path.
 *
 * Every signed-in operator request used to pay three round trips before its
 * handler ran: the operator row and the session head (in parallel), then the
 * membership. A per-application route added the application row, and a MEMBER
 * two more for grants. The panel's application overview issues seven such
 * requests per page view, so about half of its queries re-read the same rows.
 *
 * Three caches live here, with one invalidation path:
 *
 *   auth     (operator, workspace, session) → operator row, session live,
 *            membership (id, role, scopes). Read by `requireTenantSession`.
 *   grants   membership id → per-application grants + the legacy flag. Read
 *            by `resolveGrantSet` in `access-context.ts`.
 *   app      application id → workspace id. Immutable: nothing moves an
 *            application between workspaces, so it has no TTL, only a bound.
 *
 * WHY THIS IS SAFE
 *
 * This is the pattern `organization-role-cache.ts` established, applied to
 * authentication state, where staleness would mean a revoked session keeps
 * working. What bounds it:
 *
 *   1. ONLY SUCCESS IS CACHED. A missing operator, an ended session, a stamp
 *      newer than the token, or a missing membership is never stored, so a
 *      refusal is always re-checked against the database.
 *   2. Every write that can narrow access calls `invalidateOperatorAuth` or
 *      `invalidateMembershipAuth` after its commit. The writing process drops
 *      its own entries synchronously, so the very next request it serves is
 *      re-read from the database.
 *   3. The same call PUBLISHES on `rekey:operator-auth:invalidate`, and every
 *      other process drops the matching entries on receipt.
 *   4. A load that raced an invalidation is not stored: `generation` is bumped
 *      by every invalidation, local or received, and a load only stores its
 *      result if the generation it started under is still current. Without
 *      this a request that read the old row just before the revoke committed
 *      could store it just after the invalidation ran.
 *   5. The auth and grants caches serve nothing until Redis has CONFIRMED the
 *      subscription, at boot and after every reconnect. Messages published
 *      while disconnected are lost, so both are dropped on disconnect and
 *      bypassed until the subscription is confirmed again. The app map is
 *      exempt: it holds only which workspace an application belongs to, which
 *      nothing ever changes, so a missed message cannot make it wrong. It is
 *      served whenever caching is on at all, and only `OPERATOR_AUTH_CACHE_TTL_MS=0`
 *      or process close empties it.
 *   6. `OPERATOR_AUTH_CACHE_TTL_MS` (default 5s) is the backstop for the one
 *      case left: a publish that fails while this process's subscriber still
 *      believes it is connected. Set it to 0 to disable the cache outright.
 *
 * The write sites, enumerated by grep over every `tenantUser`,
 * `tenantMembership`, `applicationGrant` and `tenantRefreshToken` write in
 * apps/api/src (see decisions.md 2026-09-19):
 *
 *   lib/tenant-refresh-tokens.ts
 *     revokeAllTenantRefreshTokensForUser  sign out everywhere, password change,
 *                                          password reset, refresh-token reuse
 *                                          and rotation-race detection
 *     revokeSessionForTenantUser           DELETE /tenant/auth/sessions/:id
 *     revokeTenantRefreshToken             sign-out of this session
 *   modules/tenant-workspaces/tenant-workspaces.service.ts
 *     removeMember, changeMemberRole, setMemberScopes,
 *     setMemberGrant, removeMemberGrant
 *   modules/tenant-auth/tenant-auth.service.ts
 *     findOrCreateOAuthOperator (emailVerified upgrade)
 *
 * Writes that do NOT invalidate, and why: membership and operator CREATES
 * (nothing is cached for a membership that does not exist yet), refresh
 * rotation (the session stays live under the same `sid`), and the token prune
 * (it deletes only rows that are already revoked or expired). Nothing deletes a
 * workspace or an operator today; whoever adds that must invalidate here.
 */

import type { TenantRole, ApplicationGrantRole, TenantUser } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getRedis } from './redis.js';
import { env } from '../config/env.js';

/** Channel invalidations are published on. */
const CHANNEL = 'rekey:operator-auth:invalidate';

/** Identifies this process's own messages on the channel. */
const PROCESS_TAG = `p:${randomUUID()}`;

/** Bound on each map. Exceeding it costs a query, never correctness. */
const MAX_ENTRIES = 10_000;

/** The operator row minus the password hash. The stamp stays: it is checked per token. */
export type CachedOperator = Omit<TenantUser, 'passwordHash'>;

export interface CachedMembership {
  id: string;
  role: TenantRole;
  scopesRestricted: boolean;
  scopes: string[];
}

export interface AuthEntry {
  user: CachedOperator;
  /** Only admitted sessions are stored, so a stored entry always had a live head. */
  membership: CachedMembership;
}

export interface GrantEntry {
  grants: Array<{ applicationId: string; role: ApplicationGrantRole }>;
  legacyWorkspaceRead: boolean;
}

interface Timed<T> {
  value: T;
  operatorId: string | null;
  membershipId: string | null;
  loadedAt: number;
}

const auth = new Map<string, Timed<AuthEntry>>();
const grants = new Map<string, Timed<GrantEntry>>();
const appTenant = new Map<string, string>();

/** Bumped by every invalidation, local or received. See point 4 above. */
let generation = 0;

let subscriber: ReturnType<typeof getRedis> = null;
let subscribeStarted = false;
/**
 * Whether cached entries may be served. True when there is no Redis to miss
 * messages from (NODE_ENV=test), or once the subscriber has subscribed. False
 * from any disconnect until the subscription is live again.
 */
let subscriberReady = false;

function dropAll(): void {
  generation++;
  auth.clear();
  grants.clear();
}

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
    // No Redis: a single process (tests, or a dev box without REDIS_URL, which
    // the webhook queue already refuses in production). Nothing to miss.
    subscriberReady = true;
    return;
  }
  subscriber = base.duplicate();
  const sub = subscriber;
  const offline = (): void => {
    if (subscriberReady) dropAll();
    subscriberReady = false;
  };
  // Serve from cache only once Redis has CONFIRMED the subscription. Anything
  // published before that is lost to us, so start from empty.
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
  sub.on('error', () => undefined);
  sub.on('close', offline);
  sub.on('end', offline);
  // Every (re)connect. The shared client is built with the offline queue off,
  // and so is this duplicate, so a SUBSCRIBE sent before the connection is up
  // is rejected rather than queued: the first real subscribe happens here.
  sub.on('ready', () => {
    void subscribeNow();
  });
  sub.on('message', (channel: string, message: string) => {
    if (channel !== CHANNEL) return;
    // Our own publish comes back to us. The local drop already happened
    // synchronously; applying the echo again would only discard whatever the
    // next request re-read in the meantime.
    const space = message.indexOf(' ');
    if (space > 0 && message.slice(0, space) === PROCESS_TAG) return;
    applyInvalidation(space > 0 ? message.slice(space + 1) : message);
  });
  // Already connected (or a client that queues): subscribe straight away.
  void subscribeNow();
}

/**
 * Apply one invalidation payload: space-separated `o:<operatorId>` and
 * `m:<membershipId>` tokens, or `*` for everything. On the wire the payload is
 * preceded by the sender's `p:<uuid>` tag.
 */
export function applyInvalidation(message: string): void {
  generation++;
  if (message === '*') {
    dropAll();
    return;
  }
  const operators = new Set<string>();
  const memberships = new Set<string>();
  for (const token of message.split(' ')) {
    if (token.startsWith('o:')) operators.add(token.slice(2));
    else if (token.startsWith('m:')) memberships.add(token.slice(2));
  }
  // A linear sweep. Invalidations are rare (a revoke, a role edit) and the
  // map is bounded, so a secondary index would cost more than it saves.
  for (const [key, entry] of auth) {
    if (
      (entry.operatorId !== null && operators.has(entry.operatorId)) ||
      (entry.membershipId !== null && memberships.has(entry.membershipId))
    ) {
      auth.delete(key);
    }
  }
  for (const id of memberships) grants.delete(id);
}

function publish(message: string): void {
  // Local first, so this process is correct even if the publish fails.
  applyInvalidation(message);
  const redis = bus();
  if (!redis) return;
  // Prefixed with this process's tag so the echo is recognised on the way
  // back in. Never awaited: a revoke must not fail because Redis blinked.
  sendInvalidation(`${PROCESS_TAG} ${message}`, 0);
}

/** Delay before the one retry of a failed publish. */
export const PUBLISH_RETRY_MS = 250;

/**
 * Publish, and retry once if Redis refuses. The shared client has its offline
 * queue off, so a publish during a reconnect is rejected outright while the
 * other processes' subscribers may still be connected and serving; without a
 * retry they would admit a revoked session until the TTL. Point 6 in the
 * header covers a publish that fails twice. The log names the channel and
 * the error only: the payload carries operator and membership ids.
 */
function sendInvalidation(payload: string, attempt: number): void {
  const redis = bus();
  if (!redis) return;
  redis.publish(CHANNEL, payload).catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    if (attempt === 0) {
      console.warn(
        `[operator-auth-cache] publish to ${CHANNEL} failed (${reason}); retrying in ${PUBLISH_RETRY_MS}ms`,
      );
      setTimeout(() => sendInvalidation(payload, 1), PUBLISH_RETRY_MS).unref();
    } else {
      console.warn(
        `[operator-auth-cache] publish to ${CHANNEL} failed again (${reason}); other API processes rely on the ${env.OPERATOR_AUTH_CACHE_TTL_MS}ms TTL`,
      );
    }
  });
}

/** Drop every cached entry for this operator, here and in every process. */
export function invalidateOperatorAuth(operatorId: string): void {
  publish(`o:${operatorId}`);
}

/**
 * Drop cached auth for one membership (and its operator), here and in every
 * process. For role, scope, grant and removal writes.
 */
export function invalidateMembershipAuth(args: { operatorId: string; membershipId: string }): void {
  publish(`o:${args.operatorId} m:${args.membershipId}`);
}

function ttl(): number {
  return env.OPERATOR_AUTH_CACHE_TTL_MS;
}

function usable(): boolean {
  if (ttl() <= 0) return false;
  ensureSubscribed();
  return subscriberReady;
}

function fresh<T>(entry: Timed<T> | undefined): entry is Timed<T> {
  return entry !== undefined && Date.now() - entry.loadedAt < ttl();
}

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_ENTRIES && !map.has(key)) {
    // Insertion order; the oldest load goes first. See organization-role-cache.
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

function authKey(operatorId: string, tenantId: string, sessionId: string | undefined): string {
  return `${operatorId}|${tenantId}|${sessionId ?? ''}`;
}

/** A token for the current generation. Pass it back to the matching store call. */
export function loadTicket(): number {
  return generation;
}

export function getCachedAuth(
  operatorId: string,
  tenantId: string,
  sessionId: string | undefined,
): AuthEntry | null {
  if (!usable()) return null;
  const hit = auth.get(authKey(operatorId, tenantId, sessionId));
  return fresh(hit) ? hit.value : null;
}

export function storeAuth(
  ticket: number,
  operatorId: string,
  tenantId: string,
  sessionId: string | undefined,
  value: AuthEntry,
): void {
  if (!usable() || ticket !== generation) return;
  boundedSet(auth, authKey(operatorId, tenantId, sessionId), {
    value,
    operatorId,
    membershipId: value.membership.id,
    loadedAt: Date.now(),
  });
}

export function getCachedGrants(membershipId: string): GrantEntry | null {
  if (!usable()) return null;
  const hit = grants.get(membershipId);
  return fresh(hit) ? hit.value : null;
}

export function storeGrants(ticket: number, membershipId: string, value: GrantEntry): void {
  if (!usable() || ticket !== generation) return;
  boundedSet(grants, membershipId, {
    value,
    operatorId: null,
    membershipId,
    loadedAt: Date.now(),
  });
}

/**
 * The workspace an application belongs to. Immutable once created, so it is
 * cached without a TTL and never invalidated; only found applications are
 * stored. Honours `OPERATOR_AUTH_CACHE_TTL_MS=0` like the rest of the file.
 */
export function getCachedAppTenant(applicationId: string): string | null {
  if (ttl() <= 0) return null;
  return appTenant.get(applicationId) ?? null;
}

export function storeAppTenant(applicationId: string, tenantId: string): void {
  if (ttl() <= 0) return;
  boundedSet(appTenant, applicationId, tenantId);
}

/** Stop the subscriber. Registered as an `onClose` hook in app.ts. */
export async function closeOperatorAuthCache(): Promise<void> {
  if (subscriber) {
    const s = subscriber;
    subscriber = null;
    await s.quit().catch(() => undefined);
  }
  subscribeStarted = false;
  subscriberReady = false;
  dropAll();
  appTenant.clear();
}

/** Test hook, called from `test/domain-tables.ts` between tests. */
export function __resetForTests(): void {
  dropAll();
  appTenant.clear();
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
  appTenant.clear();
}

/** Whether this process currently serves from the cache. Test introspection. */
export function __isServingFromCacheForTests(): boolean {
  return subscriberReady;
}
