/**
 * Rolling up one Application outside the hourly run, after its reporting
 * timezone changes, so the rollup read path has today in the new zone
 * straight away.
 *
 * Requests coalesce. Per Application at most one rollup runs and at most one
 * more is pending, and the pending one reads the latest zone when it starts,
 * so flipping the zone many times a minute costs two runs, not one per
 * change. A per-Application lease keeps it to one run across replicas: a
 * replica that finds the lease held leaves a pending flag in Redis, which the
 * holder checks before and after releasing. On one replica, triggered runs go
 * one at a time, so zone changes across many Applications hold one pool
 * connection, not one each.
 */

import type { Redis } from 'ioredis';
import { dashboardRedis } from '../../../lib/dashboard-cache.js';
import { withLease } from '../../../lib/sweep-lease.js';
import { rollupApplication } from './job.js';

const LEASE_TTL_MS = 60_000;
const PENDING_TTL_SECONDS = 600;

type TriggerRedis = Pick<Redis, 'set' | 'eval' | 'del' | 'exists'>;

export interface RollupLog {
  warn(obj: object, msg: string): void;
}

const pendingKey = (applicationId: string): string => `rk:an:rollup-pending:${applicationId}`;
const leaseKey = (applicationId: string): string => `lease:analytics-rollup:app:${applicationId}`;

let runner: (applicationId: string) => Promise<unknown> = (id) => rollupApplication(id);

/** Replace what a triggered rollup runs, to observe it. Pass nothing to restore. */
export function __setTriggeredRollupForTests(run?: (applicationId: string) => Promise<unknown>): void {
  runner = run ?? ((id) => rollupApplication(id));
}

/** Applications with a drain in flight on this replica, and whether another run was asked for. */
const inFlight = new Map<string, { again: boolean; done: Promise<void> }>();
let serial: Promise<void> = Promise.resolve();

function oneAtATime(work: () => Promise<void>): Promise<void> {
  const next = serial.then(work, work);
  serial = next.catch(() => undefined);
  return next;
}

async function runLeased(applicationId: string, redis: TriggerRedis | null, log: RollupLog): Promise<boolean> {
  const outcome = await withLease(redis, { key: leaseKey(applicationId), ttlMs: LEASE_TTL_MS }, async () => {
    if (!redis) return oneAtATime(() => runner(applicationId).then(() => undefined));
    while ((await redis.del(pendingKey(applicationId))) > 0) {
      await oneAtATime(() => runner(applicationId).then(() => undefined));
    }
  });
  if (outcome.status === 'redis-unavailable') log.warn({ err: outcome.error, applicationId }, 'analytics rollup trigger could not reach Redis');
  if (outcome.status !== 'ran' || !redis) return false;
  return (await redis.exists(pendingKey(applicationId))) > 0;
}

async function drain(applicationId: string, redis: TriggerRedis | null, log: RollupLog): Promise<void> {
  const state = inFlight.get(applicationId)!;
  try {
    while (state.again) {
      state.again = false;
      try {
        if (await runLeased(applicationId, redis, log)) state.again = true;
      } catch (err) {
        log.warn({ err, applicationId }, 'analytics rollup after a timezone change failed');
      }
    }
  } finally {
    inFlight.delete(applicationId);
  }
}

/**
 * Ask for a rollup of one Application. Resolves when the run that will see
 * this request has finished; never rejects.
 *
 * @example
 *   void requestRollup(applicationId, req.log);
 */
export async function requestRollup(applicationId: string, log: RollupLog): Promise<void> {
  const redis = dashboardRedis() as TriggerRedis | null;
  if (redis) await redis.set(pendingKey(applicationId), '1', 'EX', PENDING_TTL_SECONDS).catch(() => undefined);
  const running = inFlight.get(applicationId);
  if (running) {
    running.again = true;
    return running.done;
  }
  const state = { again: true, done: Promise.resolve() };
  inFlight.set(applicationId, state);
  state.done = drain(applicationId, redis, log);
  return state.done;
}
