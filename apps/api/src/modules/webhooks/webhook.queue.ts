/**
 * BullMQ-backed outbound-webhook delivery worker.
 *
 * Swaps the in-process `setTimeout` scheduler (webhook.service.ts) for a
 * Redis-backed one: every attempt — first and retries — is a BullMQ job.
 * Delayed retry jobs live in Redis, so a process crash no longer drops pending
 * retries (the original setTimeout limitation), and attempts distribute across
 * API replicas instead of pinning to the process that emitted the event.
 *
 * The worker processor runs one `attemptDelivery`, which atomically claims the
 * row, POSTs, and — on a retryable failure — self-reschedules the next attempt
 * through the active scheduler (i.e. enqueues the next delayed BullMQ job).
 * Backoff stays owned by the DB (`nextAttemptAt`), identical to the in-process
 * path — BullMQ just holds the timer.
 *
 * Required, not optional: `startWebhookWorker` verifies Redis is reachable and
 * THROWS if not, so the server refuses to boot without a working queue. There
 * is no process-local scheduling fallback in production — webhook delivery must
 * go through the shared queue so retries survive a crash and distribute across
 * replicas (microservice-compatible). The only exception is `NODE_ENV=test`
 * (`isQueueEnabled()` false), where the worker isn't started and the suite runs
 * delivery via the in-process timer in webhook.service.ts.
 *
 * Crash-survivability has two layers:
 *   1. Delayed jobs in Redis — the normal retry path, durable across restarts
 *      (the prod Redis runs with AOF on).
 *   2. The DB retry poller (`processDueWebhookDeliveries`, registered in
 *      app.ts) — re-attempts any PENDING row whose `nextAttemptAt` passed,
 *      recovering rows orphaned by a Redis flush or a job that never landed.
 *      The atomic claim in `attemptDelivery` makes the poller and the worker
 *      safe to overlap.
 */

import { Queue, Worker, type JobsOptions, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { createQueueRedis, isQueueEnabled } from '../../lib/queue.js';
import { attemptDelivery, setDeliveryScheduler } from './webhook.service.js';

const QUEUE_NAME = 'webhook-delivery';
const WORKER_CONCURRENCY = 10;
// Boot-time Redis reachability check. Bounded so an unreachable Redis fails the
// startup fast instead of hanging on ioredis's buffered-command retry.
const REDIS_PING_TIMEOUT_MS = 5_000;

interface JobData {
  deliveryId: string;
}

// Keep a bounded history so the queue keys don't grow without limit.
const KEEP: Pick<JobsOptions, 'removeOnComplete' | 'removeOnFail'> = {
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 1000 },
};

// BullMQ bundles its own ioredis (pinned 5.10.1) while the app resolves 5.11.0.
// The two `Redis` types are structurally identical but nominally distinct under
// `exactOptionalPropertyTypes`; the instance is a real ioredis client at
// runtime, so a cast through the BullMQ connection type is safe and contained.
const asConnection = (r: Redis): ConnectionOptions => r as unknown as ConnectionOptions;

let queue: Queue | null = null;
let worker: Worker | null = null;
let queueConn: Redis | null = null;
let workerConn: Redis | null = null;

/**
 * Stable, idempotent job id for a logical attempt. Two enqueues of the same
 * delivery at the same attempt count (e.g. a self-reschedule racing the DB
 * poller) collapse to one job. `removeOnComplete` frees the id once the attempt
 * runs, so the next attempt (a higher count → different id) is never blocked.
 *
 * Underscore separator, NOT colon: BullMQ reserves `:` for its internal Redis
 * key structure and rejects custom job ids that contain one.
 */
function jobId(deliveryId: string, attempts: number): string {
  return `${deliveryId}_${attempts}`;
}

/**
 * Verify Redis answers a PING within the bounded window. ioredis buffers
 * commands while (re)connecting, so a bare `ping()` against a down Redis would
 * hang until the connection eventually succeeds — race it against a timer so
 * boot fails fast instead.
 */
async function assertRedisReachable(conn: Redis): Promise<void> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Redis PING timed out after ${REDIS_PING_TIMEOUT_MS}ms`)),
      REDIS_PING_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([conn.ping(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Start the worker + scheduler. Idempotent. No-op under test (queue disabled).
 * In any real runtime Redis is REQUIRED: throws if it can't be reached, so the
 * server refuses to boot without a working queue.
 */
export async function startWebhookWorker(log: FastifyBaseLogger): Promise<void> {
  if (!isQueueEnabled() || queue) return;

  queueConn = createQueueRedis();
  workerConn = createQueueRedis();

  // Fail closed: a missing/unreachable Redis (or any setup error) must stop
  // startup, not silently degrade to process-local scheduling, which would
  // break multi-replica delivery. The try/catch spans the ping AND the
  // Queue/Worker construction + scheduler install, so a throw at any step tears
  // down the connections and restores the default scheduler — no leaked
  // connection, no scheduler left pointing at a queue with no worker.
  try {
    await assertRedisReachable(queueConn);

    queue = new Queue(QUEUE_NAME, { connection: asConnection(queueConn) });
    const q = queue;

    // Route all scheduling through Redis. `void`: emit() is fire-and-forget and
    // must not await Redis; a failed enqueue is logged and the DB poller
    // recovers the row off `nextAttemptAt`.
    setDeliveryScheduler((deliveryId, delayMs, attempts) => {
      const data: JobData = { deliveryId };
      void q
        .add('deliver', data, {
          delay: Math.max(0, delayMs),
          jobId: jobId(deliveryId, attempts),
          ...KEEP,
        })
        .catch((err) => log.error({ err, deliveryId }, 'failed to enqueue webhook delivery'));
    });

    worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        await attemptDelivery((job.data as JobData).deliveryId);
      },
      { connection: asConnection(workerConn), concurrency: WORKER_CONCURRENCY },
    );
    worker.on('error', (err) => log.error({ err }, 'webhook delivery worker error'));
  } catch (err) {
    setDeliveryScheduler(null);
    await worker?.close().catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await queueConn.quit().catch(() => undefined);
    await workerConn.quit().catch(() => undefined);
    worker = null;
    queue = null;
    queueConn = null;
    workerConn = null;
    throw new Error(
      `[webhooks] Redis is required for the webhook delivery queue but the queue ` +
        `failed to start: ${(err as Error).message}. Set REDIS_URL to a reachable ` +
        `instance (the server will not start without it).`,
    );
  }

  log.info('webhook delivery worker started (BullMQ)');
}

/** Tear down the worker + connections and restore the in-process scheduler. */
export async function stopWebhookWorker(): Promise<void> {
  // Close the worker FIRST — it drains in-flight jobs. A job finishing mid-drain
  // may self-reschedule, and it must enqueue the next attempt through the
  // Redis-backed scheduler (still active here), not a process-bound timer that
  // would die on shutdown. Only then restore the in-process scheduler.
  await worker?.close().catch(() => undefined);
  setDeliveryScheduler(null);
  await queue?.close().catch(() => undefined);
  await workerConn?.quit().catch(() => undefined);
  await queueConn?.quit().catch(() => undefined);
  worker = null;
  queue = null;
  workerConn = null;
  queueConn = null;
}
