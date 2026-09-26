/**
 * Per-endpoint and per-Application isolation for outbound webhook delivery.
 *
 * Every delivery attempt in the deployment shares one pool of worker slots
 * (BullMQ concurrency, per replica). Without a limit, one customer endpoint
 * that accepts the connection and never answers holds a slot for the full
 * request timeout on every attempt, and a backlog of its deliveries holds ALL
 * of them: every other tenant's webhooks then wait behind it. Measured before
 * this gate existed: 30 deliveries to one hung endpoint delayed another
 * tenant's deliveries by ~30s.
 *
 * Three mechanisms:
 *
 *   - A concurrency cap per endpoint. At most `ENDPOINT_MAX_IN_FLIGHT` attempts
 *     to one endpoint run at once, across every replica.
 *   - A concurrency cap per Application. At most `WEBHOOK_APP_MAX_IN_FLIGHT`
 *     attempts for one Application run at once, whatever endpoints they go
 *     to. The endpoint cap alone was not enough: endpoints are cheap to
 *     create, and a dozen that each answer 200 just inside the timeout never
 *     trip the breaker below, so together they held every worker slot.
 *     An attempt takes its endpoint slot first, then its Application slot,
 *     and gives the first back if the second is refused.
 *
 *     An attempt that cannot get a slot is not sent and not counted as a
 *     failed attempt; the caller defers it by `retryInMs`, which grows with
 *     how many attempts were turned away recently at that level, so a large
 *     backlog spreads out instead of re-polling the database in a tight loop.
 *   - A circuit breaker per endpoint. After `BREAKER_THRESHOLD` failed sends
 *     in a row, the endpoint is "open" for `BREAKER_OPEN_MS`: attempts that
 *     come due in that window fail without a network call (still counted,
 *     still on the normal retry schedule), so a dead endpoint stops costing
 *     slots and timeouts. When the window ends, the next attempts are sent (at
 *     most the cap at once). One success closes the circuit; one failure
 *     re-opens it, because the failure count is still at or over the threshold.
 *
 * Redis in every real runtime, so the caps hold across replicas. Slots are
 * leases with a deadline (a sorted set scored by expiry), so a replica that
 * dies mid-send gives its slot back when the lease runs out, not never.
 *
 * If Redis errors, the gate falls back to a small in-process one
 * (`FALLBACK_ENDPOINT_MAX_IN_FLIGHT` per endpoint, `FALLBACK_APP_MAX_IN_FLIGHT`
 * per Application, per process, with a local breaker). A Redis blip must not
 * stop every webhook in the deployment, but it must not lift every cap either:
 * the first version of this gate delivered with no limit at all while Redis
 * was down, which is exactly when a slow tenant could take the whole pool.
 *
 * Under `NODE_ENV=test` (`getRedis()` is null) an in-process gate with the
 * full caps is used; the Redis one is tested directly against a real Redis.
 */

import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getRedis } from '../../lib/redis.js';
import { env } from '../../config/env.js';

/** Attempts to one endpoint that may be in flight at once, deployment-wide. */
export const ENDPOINT_MAX_IN_FLIGHT = 4;
/** Attempts for one Application that may be in flight at once, deployment-wide. */
export const APP_MAX_IN_FLIGHT = env.WEBHOOK_APP_MAX_IN_FLIGHT;
/** The in-process caps used while Redis is unreachable, per process. */
export const FALLBACK_ENDPOINT_MAX_IN_FLIGHT = 2;
export const FALLBACK_APP_MAX_IN_FLIGHT = 4;

let timeoutOverride: number | null = null;

/**
 * How long one delivery request may take (`WEBHOOK_TIMEOUT_MS`, default 10s,
 * 1-30s). Lives here rather than in the service because the slot lease below
 * is derived from it.
 */
export function deliveryTimeoutMs(): number {
  return timeoutOverride ?? env.WEBHOOK_TIMEOUT_MS;
}

/** Tests only: shorten the timeout without restarting the process. `null` restores it. */
export function setDeliveryTimeoutMs(ms: number | null): void {
  timeoutOverride = ms;
}

/**
 * How long a slot is held if its holder never gives it back (a crash): the
 * request timeout plus 20s for the SSRF DNS check (which the request timeout
 * does not bound) and the Redis round trips around the send. 30s at the
 * default timeout, 50s at the 30s maximum, so always inside the delivery claim
 * window (60s, webhook.service.ts): a slot never outlives the claim it was
 * taken under, and a live attempt never loses its slot.
 */
export function slotLeaseMs(timeoutMs: number = deliveryTimeoutMs()): number {
  return timeoutMs + 20_000;
}
/** Failed sends in a row that open the circuit. */
export const BREAKER_THRESHOLD = 5;
/** How long an open circuit stays open before the next send is tried. */
export const BREAKER_OPEN_MS = 60_000;
/**
 * The failure count forgets after this long without a new failure, so an
 * endpoint that fails once a day never trips the breaker.
 */
const FAILURE_MEMORY_MS = 60 * 60_000;

// Deferral when every slot is taken: a floor, a step per attempt turned away
// in the recent window, and a ceiling. A burst of 100 events to one fast
// endpoint spreads over ~5s; a backlog of thousands for a slow one re-checks
// about every 30s per delivery instead of every second.
const WAIT_BASE_MS = 500;
const WAIT_STEP_MS = 50;
const WAIT_MAX_MS = 30_000;
const WAIT_WINDOW_MS = 10_000;

export type SlotResult = { release: () => Promise<void> } | { retryInMs: number };

export interface EndpointGate {
  /**
   * Take one of the endpoint's in-flight slots AND one of its Application's,
   * or be told when to come back. One `release` gives back both.
   */
  tryAcquire(endpointId: string, applicationId: string): Promise<SlotResult>;
  /** Milliseconds until the endpoint's open circuit allows a send; 0 when closed. */
  openForMs(endpointId: string): Promise<number>;
  /** Feed a real send's outcome to the breaker. Never call for a send that did not happen. */
  recordResult(endpointId: string, ok: boolean): Promise<void>;
}

function waitDelay(turnedAway: number): number {
  const ms = Math.min(WAIT_MAX_MS, WAIT_BASE_MS + turnedAway * WAIT_STEP_MS);
  // +/-25% so a burst deferred together does not come back together.
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

// ---------------------------------------------------------------- Redis gate

// KEYS: slots zset, waits counter. ARGV: cap, lease ms, token, wait window ms.
// Returns 1 when a slot was taken, otherwise -(attempts turned away in window).
// Redis TIME, not the caller's clock, so replicas with skewed clocks agree on
// which leases have expired.
const ACQUIRE_SCRIPT = `
local t = redis.call("TIME")
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
if redis.call("ZCARD", KEYS[1]) < tonumber(ARGV[1]) then
  redis.call("ZADD", KEYS[1], now + tonumber(ARGV[2]), ARGV[3])
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return 1
end
local n = redis.call("INCR", KEYS[2])
redis.call("PEXPIRE", KEYS[2], ARGV[4])
return -n
`;

// KEYS: failure counter, open flag. ARGV: threshold, memory ms, open ms.
const FAILURE_SCRIPT = `
local n = redis.call("INCR", KEYS[1])
redis.call("PEXPIRE", KEYS[1], ARGV[2])
if n >= tonumber(ARGV[1]) then
  redis.call("SET", KEYS[2], "1", "PX", ARGV[3])
end
return n
`;

export type GateRedis = Pick<Redis, 'eval' | 'zrem' | 'pttl' | 'del'>;

/** Overrides, for tests that cannot wait out the real windows or caps. */
export interface GateOptions {
  leaseMs?: number;
  openMs?: number;
  appMaxInFlight?: number;
  /** Used while Redis errors. Defaults to an in-process gate with the fallback caps. */
  fallback?: EndpointGate;
}

// Hash-tagged on the endpoint (or Application) id so each script's keys land
// on one cluster slot, which the multi-key scripts above require. The endpoint
// and Application slots are therefore taken by two scripts, not one.
const keys = (endpointId: string) => ({
  slots: `whk:ep:{${endpointId}}:inflight`,
  waits: `whk:ep:{${endpointId}}:waits`,
  fails: `whk:ep:{${endpointId}}:fails`,
  open: `whk:ep:{${endpointId}}:open`,
});
const appKeys = (applicationId: string) => ({
  slots: `whk:app:{${applicationId}}:inflight`,
  waits: `whk:app:{${applicationId}}:waits`,
});

let lastRedisWarnAt = 0;
function warnFallback(err: unknown): void {
  // Rate-limited: a Redis outage would otherwise log once per delivery.
  if (Date.now() - lastRedisWarnAt < 60_000) return;
  lastRedisWarnAt = Date.now();
  console.warn(
    '[webhooks] delivery gate could not reach Redis; limiting sends with per-process caps ' +
      `(${FALLBACK_ENDPOINT_MAX_IN_FLIGHT} per endpoint, ${FALLBACK_APP_MAX_IN_FLIGHT} per Application) until it is back`,
    err instanceof Error ? err.message : String(err),
  );
}

export function createRedisEndpointGate(redis: GateRedis, options: GateOptions = {}): EndpointGate {
  const leaseMs = options.leaseMs ?? slotLeaseMs();
  const openMs = options.openMs ?? BREAKER_OPEN_MS;
  const appMax = options.appMaxInFlight ?? APP_MAX_IN_FLIGHT;
  const fallback =
    options.fallback ??
    createMemoryEndpointGate({
      endpointMax: FALLBACK_ENDPOINT_MAX_IN_FLIGHT,
      appMax: FALLBACK_APP_MAX_IN_FLIGHT,
    });

  // 1 when a slot was taken, otherwise -(attempts turned away in the window).
  const take = async (k: { slots: string; waits: string }, cap: number, token: string): Promise<number> =>
    Number(
      await redis.eval(
        ACQUIRE_SCRIPT,
        2,
        k.slots,
        k.waits,
        String(cap),
        String(leaseMs),
        token,
        String(WAIT_WINDOW_MS),
      ),
    );

  return {
    async tryAcquire(endpointId, applicationId) {
      const ep = keys(endpointId);
      const app = appKeys(applicationId);
      const token = randomBytes(8).toString('hex');
      let heldEndpoint = false;
      try {
        const r = await take(ep, ENDPOINT_MAX_IN_FLIGHT, token);
        if (r !== 1) return { retryInMs: waitDelay(-r) };
        heldEndpoint = true;
        const a = await take(app, appMax, token);
        if (a !== 1) {
          await redis.zrem(ep.slots, token);
          return { retryInMs: waitDelay(-a) };
        }
      } catch (err) {
        warnFallback(err);
        // Best effort: a slot taken before the error would otherwise sit until
        // its lease runs out.
        if (heldEndpoint) await redis.zrem(ep.slots, token).catch(() => undefined);
        return fallback.tryAcquire(endpointId, applicationId);
      }
      return {
        release: async () => {
          await Promise.all([
            redis.zrem(ep.slots, token).catch(() => undefined),
            redis.zrem(app.slots, token).catch(() => undefined),
          ]);
        },
      };
    },

    async openForMs(endpointId) {
      try {
        const ms = await redis.pttl(keys(endpointId).open);
        return ms > 0 ? ms : 0;
      } catch (err) {
        warnFallback(err);
        return fallback.openForMs(endpointId);
      }
    },

    async recordResult(endpointId, ok) {
      const k = keys(endpointId);
      try {
        if (ok) {
          await redis.del(k.fails, k.open);
        } else {
          await redis.eval(
            FAILURE_SCRIPT,
            2,
            k.fails,
            k.open,
            String(BREAKER_THRESHOLD),
            String(FAILURE_MEMORY_MS),
            String(openMs),
          );
        }
      } catch (err) {
        warnFallback(err);
        await fallback.recordResult(endpointId, ok);
      }
    },
  };
}

// ------------------------------------------------------------ in-process gate

interface Slots {
  inFlight: number;
  waits: number;
  waitsResetAt: number;
}

interface Breaker {
  fails: number;
  failsResetAt: number;
  openUntil: number;
}

/**
 * Same rules, one process. Used when there is no shared Redis, which outside
 * test means a single-process deployment where a local count IS the global
 * one, and, with smaller caps, as the Redis gate's fallback while Redis is
 * down. There are no leases to expire: a crash takes the counts with it.
 */
export function createMemoryEndpointGate(
  caps: { endpointMax?: number; appMax?: number } = {},
): EndpointGate & { reset(): void } {
  const endpointMax = caps.endpointMax ?? ENDPOINT_MAX_IN_FLIGHT;
  const appMax = caps.appMax ?? APP_MAX_IN_FLIGHT;
  const slots = new Map<string, Slots>();
  const breakers = new Map<string, Breaker>();
  const slotsFor = (key: string): Slots => {
    let s = slots.get(key);
    if (!s) {
      s = { inFlight: 0, waits: 0, waitsResetAt: 0 };
      slots.set(key, s);
    }
    return s;
  };
  const breakerFor = (id: string): Breaker => {
    let b = breakers.get(id);
    if (!b) {
      b = { fails: 0, failsResetAt: 0, openUntil: 0 };
      breakers.set(id, b);
    }
    return b;
  };
  const turnAway = (s: Slots): { retryInMs: number } => {
    const now = Date.now();
    if (now >= s.waitsResetAt) s.waits = 0;
    s.waits += 1;
    s.waitsResetAt = now + WAIT_WINDOW_MS;
    return { retryInMs: waitDelay(s.waits) };
  };
  return {
    async tryAcquire(endpointId, applicationId) {
      const ep = slotsFor(`ep:${endpointId}`);
      if (ep.inFlight >= endpointMax) return turnAway(ep);
      const app = slotsFor(`app:${applicationId}`);
      if (app.inFlight >= appMax) return turnAway(app);
      ep.inFlight += 1;
      app.inFlight += 1;
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          ep.inFlight -= 1;
          app.inFlight -= 1;
        },
      };
    },
    async openForMs(endpointId) {
      return Math.max(0, breakerFor(endpointId).openUntil - Date.now());
    },
    async recordResult(endpointId, ok) {
      const b = breakerFor(endpointId);
      const now = Date.now();
      if (ok) {
        b.fails = 0;
        b.openUntil = 0;
        return;
      }
      if (now >= b.failsResetAt) b.fails = 0;
      b.fails += 1;
      b.failsResetAt = now + FAILURE_MEMORY_MS;
      if (b.fails >= BREAKER_THRESHOLD) b.openUntil = now + BREAKER_OPEN_MS;
    },
    reset() {
      slots.clear();
      breakers.clear();
    },
  };
}

// ------------------------------------------------------------------ selection

let override: EndpointGate | null = null;
let resolved: EndpointGate | null = null;
const memoryGate = createMemoryEndpointGate();

/** The gate delivery uses: an installed override, else Redis, else in-process. */
export function getEndpointGate(): EndpointGate {
  if (override) return override;
  if (!resolved) {
    const redis = getRedis();
    resolved = redis ? createRedisEndpointGate(redis) : memoryGate;
  }
  return resolved;
}

/** Install a gate (tests, benchmarks). `null` restores the default. */
export function setEndpointGate(gate: EndpointGate | null): void {
  override = gate;
}

/** Per-test reset, called from `resetProcessGlobalState`. */
export function __resetForTests(): void {
  override = null;
  timeoutOverride = null;
  resolved = null;
  memoryGate.reset();
}
