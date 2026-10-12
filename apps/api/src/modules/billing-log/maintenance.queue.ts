/**
 * The billing log's scheduled work: writing the counts of diagnostic events
 * that were left out, deleting diagnostic events past their retention, and
 * reconciling the log with the money rows.
 *
 * Same shape as `outbox.queue.ts`: its own connections, started at boot
 * outside test. BullMQ job schedulers are stored in Redis, so one job runs
 * per interval however many API processes are up.
 */

import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { createQueueRedis, isQueueEnabled } from '../../lib/queue.js';
import { flushDiagnosticAggregates } from './diagnostic-bound.js';
import { reconcileRecentActivity } from './reconciliation.js';
import { pruneDiagnosticEvents } from './retention.js';

const QUEUE_NAME = 'billing-log-maintenance';
const MINUTE_MS = 60 * 1000;

/** Scheduler ids double as job names. BullMQ ids cannot contain a colon. */
const SCHEDULES = [
  { id: 'flush-diagnostic-counts', everyMs: 5 * MINUTE_MS },
  { id: 'reconcile', everyMs: 60 * MINUTE_MS },
  { id: 'prune-diagnostic-events', everyMs: 6 * 60 * MINUTE_MS },
] as const;

type MaintenanceJob = (typeof SCHEDULES)[number]['id'];

// ioredis and BullMQ pin different ioredis versions, so the client is cast at
// the boundary, as the webhook queue does.
const asConnection = (r: Redis): ConnectionOptions => r as unknown as ConnectionOptions;

let queue: Queue | null = null;
let worker: Worker | null = null;
let queueConn: Redis | null = null;
let workerConn: Redis | null = null;

/**
 * Run one maintenance job now. What the worker calls, and what a test calls.
 *
 * @example
 * await runBillingLogMaintenance('reconcile', app.log);
 */
export async function runBillingLogMaintenance(job: MaintenanceJob, log: FastifyBaseLogger): Promise<void> {
  if (job === 'flush-diagnostic-counts') {
    await flushDiagnosticAggregates();
    return;
  }
  if (job === 'prune-diagnostic-events') {
    const removed = await pruneDiagnosticEvents();
    if (removed > 0) log.info({ removed }, 'billing log: diagnostic events past retention deleted');
    return;
  }
  const { applications, findings } = await reconcileRecentActivity(log);
  if (findings > 0) log.warn({ applications, findings }, 'billing log: reconciliation found disagreements; see reconciliation.finding events');
}

/**
 * Start the maintenance queue and its three schedules.
 *
 * @example
 * if (isQueueEnabled()) await startBillingLogMaintenance(app.log);
 */
export async function startBillingLogMaintenance(log: FastifyBaseLogger): Promise<void> {
  if (!isQueueEnabled() || queue) return;
  queueConn = createQueueRedis();
  workerConn = createQueueRedis();
  queue = new Queue(QUEUE_NAME, { connection: asConnection(queueConn) });
  queue.on('error', (err) => log.error({ err }, 'billing log maintenance queue error'));
  try {
    for (const { id, everyMs } of SCHEDULES) {
      await queue.upsertJobScheduler(id, { every: everyMs }, { name: id, opts: { removeOnComplete: true, removeOnFail: 50 } });
    }
  } catch (err) {
    // Housekeeping must not stop the API from serving. Without the schedules
    // the bound still holds and nothing is lost: counts are written and old
    // diagnostic events deleted once a later boot registers them.
    log.error({ err }, 'billing log maintenance: schedules not registered');
  }
  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const known = SCHEDULES.find((schedule) => schedule.id === job.name);
      if (known !== undefined) await runBillingLogMaintenance(known.id, log);
    },
    { connection: asConnection(workerConn), concurrency: 1 },
  );
  worker.on('error', (err) => log.error({ err }, 'billing log maintenance worker error'));
  worker.on('failed', (job, err) => log.warn({ err, job: job?.name }, 'billing log maintenance job failed; it runs again on its schedule'));
  log.info('billing log maintenance started (BullMQ)');
}

/**
 * Stop the queue. The schedules stay in Redis for the next process.
 *
 * @example
 * app.addHook('onClose', stopBillingLogMaintenance);
 */
export async function stopBillingLogMaintenance(): Promise<void> {
  await worker?.close().catch(() => undefined);
  await queue?.close().catch(() => undefined);
  await workerConn?.quit().catch(() => undefined);
  await queueConn?.quit().catch(() => undefined);
  worker = null;
  queue = null;
  workerConn = null;
  queueConn = null;
}
