/**
 * BullMQ connection plumbing.
 *
 * Separate from the shared rate-limit client in `lib/redis.ts` on purpose:
 * BullMQ's blocking commands REQUIRE `maxRetriesPerRequest: null`, and it
 * keeps its own offline queue. The shared client sets `maxRetriesPerRequest: 1`
 * + `enableOfflineQueue: false` (fail-fast, fail-open for rate limiting), which
 * BullMQ refuses to run on. So queue work gets its own connection(s).
 *
 * Redis + BullMQ are REQUIRED in every real runtime: the server refuses to
 * start if Redis is unreachable (see startWebhookWorker), because webhook
 * delivery must go through the shared queue for multi-replica / microservice
 * deployments — there is no process-local scheduling fallback in production.
 * `isQueueEnabled()` is false ONLY under test, where the suite is single-process
 * and runs delivery via an in-process timer (see webhook.service.ts), matching
 * the rate-limiter's test-Redis-free convention.
 */

import { Redis } from 'ioredis';
import { env } from '../config/env.js';

export function isQueueEnabled(): boolean {
  return env.NODE_ENV !== 'test';
}

/**
 * A fresh ioredis connection configured the way BullMQ needs. Each BullMQ
 * primitive (Queue, Worker) should get its own — the Worker holds a blocking
 * connection and must not share it with the Queue.
 */
export function createQueueRedis(): Redis {
  const client = new Redis(env.REDIS_URL, {
    // BullMQ contract: blocking commands break with a finite retry cap.
    maxRetriesPerRequest: null,
    // Let commands queue while (re)connecting rather than throwing — queue
    // work is background, so a brief reconnect should buffer, not fail.
    enableOfflineQueue: true,
  });
  // An ioredis client with no 'error' listener turns every connection error
  // into an unhandled 'error' event, which is a hard process crash rather than
  // a logged warning. The same reasoning as `lib/redis.ts`, which has always
  // had one.
  //
  // Not logged, because reconnects are routine and the failures that matter are
  // reported through the queue and worker 'error' listeners. But the LAST one
  // is kept, because discarding it entirely costs the boot diagnosis: startup
  // fails on a PING timeout, and "Redis PING timed out after 5000ms" does not
  // say whether the host refused the connection, resolved to nothing, or asked
  // for a password. That cause is only ever on this event.
  client.on('error', (err: Error) => {
    lastConnectionError.set(client, err);
  });
  return client;
}

/**
 * The most recent connection error per queue client, for error messages.
 *
 * A WeakMap so a client that goes away takes its entry with it, and so this
 * never becomes a second place that owns connection state.
 */
const lastConnectionError = new WeakMap<Redis, Error>();

/** The last connection error seen on `client`, if any. */
export function lastQueueConnectionError(client: Redis): Error | undefined {
  return lastConnectionError.get(client);
}
