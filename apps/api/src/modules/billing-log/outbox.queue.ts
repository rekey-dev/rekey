/**
 * The BullMQ queue that wakes the outbox drain soon after an event is queued.
 *
 * Same shape as `webhooks/webhook.queue.ts`: its own connections, started at
 * boot outside test. Unlike webhook delivery, losing a job loses nothing, so
 * a failure to start is logged and the poller in app.ts carries the load.
 */

import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { createQueueRedis, isQueueEnabled } from '../../lib/queue.js';
import { drainBillingEventOutbox } from './outbox.js';
import { setOutboxDrainScheduler } from './writer.js';

const QUEUE_NAME = 'billing-event-outbox';
/** One job id, so a burst of events queues one drain. BullMQ ids cannot contain a colon. */
const DRAIN_JOB_ID = 'drain';
/** Long enough for the transaction that queued the event to commit. */
const DRAIN_DELAY_MS = 1_000;

// ioredis and BullMQ pin different ioredis versions, so the client is cast at
// the boundary, as the webhook queue does.
const asConnection = (r: Redis): ConnectionOptions => r as unknown as ConnectionOptions;

let queue: Queue | null = null;
let worker: Worker | null = null;
let queueConn: Redis | null = null;
let workerConn: Redis | null = null;

/**
 * Start the drain queue and install its scheduler.
 *
 * @example
 * if (isQueueEnabled()) await startBillingEventOutboxWorker(app.log);
 */
export async function startBillingEventOutboxWorker(log: FastifyBaseLogger): Promise<void> {
  if (!isQueueEnabled() || queue) return;
  queueConn = createQueueRedis();
  workerConn = createQueueRedis();
  queue = new Queue(QUEUE_NAME, { connection: asConnection(queueConn) });
  queue.on('error', (err) => log.error({ err }, 'billing event outbox queue error'));
  const q = queue;
  setOutboxDrainScheduler(() => {
    void q
      .add('drain', {}, { jobId: DRAIN_JOB_ID, delay: DRAIN_DELAY_MS, removeOnComplete: true, removeOnFail: true })
      .catch((err: unknown) => log.warn({ err }, 'billing event outbox: drain not scheduled, the poller will run it'));
  });
  worker = new Worker(
    QUEUE_NAME,
    async () => {
      await drainBillingEventOutbox(undefined, log);
    },
    { connection: asConnection(workerConn), concurrency: 1 },
  );
  worker.on('error', (err) => log.error({ err }, 'billing event outbox worker error'));
  log.info('billing event outbox worker started (BullMQ)');
}

/**
 * Stop the queue and remove its scheduler. Queued events stay in the outbox.
 *
 * @example
 * app.addHook('onClose', stopBillingEventOutboxWorker);
 */
export async function stopBillingEventOutboxWorker(): Promise<void> {
  setOutboxDrainScheduler(null);
  await worker?.close().catch(() => undefined);
  await queue?.close().catch(() => undefined);
  await workerConn?.quit().catch(() => undefined);
  await queueConn?.quit().catch(() => undefined);
  worker = null;
  queue = null;
  workerConn = null;
  queueConn = null;
}
