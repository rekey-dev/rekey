/**
 * Outbound webhook delivery + endpoint management.
 *
 * Flow:
 *   1. Auth flows call `webhookService.emit(applicationId, type, data)`.
 *   2. We fan out to every enabled WebhookEndpoint whose subscription
 *      list matches the event type (or carries `"*"`).
 *   3. Each match becomes a WebhookDelivery row in PENDING.
 *   4. We POST the payload with a `t=<ts>,v1=<hmac>` `X-Rekey-Signature`
 *      header. 2xx → SUCCEEDED; everything else (incl. network error) →
 *      schedule a retry with exponential backoff up to MAX_ATTEMPTS. Each
 *      send first passes the gate (endpoint-gate.ts): a cap on in-flight
 *      sends per endpoint and per Application, and a circuit breaker per
 *      endpoint, so one slow receiver, or one tenant with many of them,
 *      cannot hold the delivery pool every tenant shares.
 *
 * **Delivery is fire-and-forget** from the caller's perspective. A slow
 * webhook receiver must NEVER block the user-facing API request. The
 * service kicks the HTTP call off with `void` and lets the delivery
 * worker (this same module) retry on failure.
 *
 * ## Enqueue vs. kick, the outbox seam
 *
 * `emit()` does two separable things: WRITE the delivery rows (step 3), and
 * KICK the first attempt (step 4). Only the write has to be durable, and
 * callers that are already changing state in a `$transaction` need it to
 * commit with that change or not at all. So the two halves are exported
 * separately:
 *
 *   - `enqueueEvent(client, args)`, writes the rows through whatever client
 *     it is handed (the global one, or a `$transaction` tx) and returns their
 *     ids. Never touches the network.
 *   - `kickDeliveries(ids)`, hands those ids to the active scheduler. Call it
 *     AFTER the transaction commits; a kick from inside one races a delivery
 *     against rows no other connection can see yet, and fires at all for a
 *     transaction that goes on to roll back.
 *
 * Every event that announces a state change is written this way, including
 * the auth and user lifecycle events. A caller with no state change to join
 * (today only `device.limit_reached`, whose news is a refusal that wrote
 * nothing) uses `emitDetached`, which is `enqueueEvent(prisma, …)` +
 * `kickDeliveries(…)` with the failure logged.
 *
 * A row that is written but never kicked is not lost: it is PENDING with
 * `nextAttemptAt = now`, and the poller re-attempts it. That is the whole
 * point of writing it in the transaction.
 *
 * Scheduling goes through a pluggable seam (`scheduleAttempt`). In every real
 * runtime the BullMQ worker (webhook.queue.ts) installs a Redis-backed enqueue
 * at boot, required, no process-local fallback, so delayed retries live in
 * Redis (survive a crash) and distribute across replicas for microservice
 * deployments. The default scheduler is an in-process `setTimeout` that runs
 * ONLY under `NODE_ENV=test` (single-process suite, no external Redis); in any
 * other runtime it throws, so a delivery can never be silently pinned to one
 * process. A periodic poller (`processDueWebhookDeliveries`, registered in
 * app.ts) re-attempts PENDING rows whose `nextAttemptAt` has passed, the crash
 * backstop for a row orphaned by a Redis flush or a job that never landed.
 * Every path funnels through an atomic claim (a guarded `updateMany` that
 * pushes `nextAttemptAt` forward) so a queue worker, the poller, and other
 * replicas can never double-send the same delivery.
 */

import type {
  Prisma,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { env } from '../../config/env.js';
import { signWebhook, generateWebhookSecret } from '../../lib/webhook-signing.js';
import { pinnedFetchInit, assertSafeUrlResolved } from '../../lib/ssrf-guard.js';
import {
  endpointMatches,
  isKnownWebhookEvent,
  type WebhookEventEnvelope,
  type WebhookEventType,
} from './events.js';
import { randomBytes } from 'node:crypto';
import { BREAKER_THRESHOLD, deliveryTimeoutMs, getEndpointGate } from './endpoint-gate.js';

// Total attempts, the first one included, so 4 retries, not 5.
const MAX_ATTEMPTS = 5;
// Exponential backoff in seconds, indexed by `attempts - 1`. Only the first
// FOUR entries are reachable: `attempts >= MAX_ATTEMPTS` marks the delivery
// FAILED before index 4 is ever read, so the real budget is
// 30s + 2m + 10m + 1h ≈ 72 minutes and the trailing 4h is dead.
//
// That is a bug, not a design: the intent was ~5h of forgiveness for transient
// downtime while still not holding rows PENDING forever. Fixing it means either
// MAX_ATTEMPTS = 6 or dropping the 14400, a behaviour change, so it is not being
// done in a comments-only pass. Don't "clean up" the unreachable entry without
// deciding which of the two the intent was.
const RETRY_DELAYS_SECONDS = [30, 120, 600, 3600, 14400];
// The request timeout is `deliveryTimeoutMs()` (endpoint-gate.ts,
// WEBHOOK_TIMEOUT_MS, default 10s). 2.3.0-rc cut it to a hard-coded 5s, and
// receivers that answer a serverless cold start in 6-9s then failed every
// attempt, tripped the breaker and went FAILED after ~72 minutes. What bounds
// a slow receiver's cost is the per-endpoint and per-Application slot caps,
// not a short timeout.

// Max stored response-body bytes. We stop READING at this point too (not
// just truncating after the fact) so a receiver streaming an endless body
// can't balloon memory, see readBodyCapped.
const MAX_RESPONSE_BODY_BYTES = 4096;
// How long an atomic claim on a delivery row lasts. Longer than the largest
// allowed request timeout (30s) plus the DNS check, so a slow-but-alive
// attempt is never double-sent; short enough that a crash mid-attempt is
// retried by the poller within a minute.
const CLAIM_WINDOW_MS = 60_000;

function cuid(): string {
  // Inline a small cuid-ish id without adding a dep, base64url of 16
  // random bytes is sufficient for our idempotency-key semantics.
  return randomBytes(16).toString('base64url');
}

// Hard ceiling on enabled endpoints fanned out per event. An application with
// this many live webhooks is already pathological; the cap bounds memory + the
// per-event fan-out so a runaway integration can't load an unbounded set into
// memory on every emitted event. Deterministic order (oldest first) so which
// endpoints win under the cap is stable rather than DB-order-dependent.
const MAX_ENDPOINTS_PER_EVENT = 100;
// Endpoints one Application may register. The same number as the fan-out cap
// above: an endpoint past it would be accepted and then never receive
// anything, which is worse than a clear refusal at creation. Counts disabled
// endpoints too, so the table cannot grow without bound either. Check-then-
// create without a lock: concurrent creates at the boundary can overshoot by
// the number in flight, which the fan-out cap still bounds.
export const MAX_ENDPOINTS_PER_APPLICATION = MAX_ENDPOINTS_PER_EVENT;

/**
 * Any Prisma client: the global singleton or an interactive-transaction
 * client. `PrismaClient` is a structural superset of `TransactionClient`, so
 * both satisfy this.
 */
export type WebhookDbClient = Prisma.TransactionClient;

/**
 * The enabled endpoints subscribed to `type`, each row held `FOR KEY SHARE`.
 *
 * The lock is what makes it safe to insert delivery rows for these endpoints
 * later in the same transaction. Without it, an operator deleting an endpoint
 * between this read and the insert made the insert fail on
 * `webhook_deliveries_endpoint_id_fkey`, and because the insert runs in the
 * caller's transaction that rolled back the sign-up (or session revoke, or
 * password change) the event was announcing: a 500 for the end user over a
 * webhook they never see. KEY SHARE is the lock the FK insert would take
 * anyway, taken earlier: a concurrent delete now waits for this transaction to
 * commit (and then cascades the fresh deliveries away), and a delete that
 * committed first is simply not returned. It does not conflict with an UPDATE
 * of a non-key column, so toggling `enabled` or editing an endpoint never
 * waits on sign-ups.
 *
 * Raw SQL because Prisma has no lock clause. Outside a transaction the lock
 * lasts only for the statement, which is the old behaviour.
 */
async function listForEvent(
  client: WebhookDbClient,
  applicationId: string,
  type: WebhookEventType,
): Promise<Array<Pick<WebhookEndpoint, 'id' | 'events'>>> {
  const rows = await client.$queryRaw<Array<Pick<WebhookEndpoint, 'id' | 'events'>>>`
    SELECT id, events FROM webhook_endpoints
    WHERE application_id = ${applicationId} AND enabled = true
    ORDER BY created_at ASC
    LIMIT ${MAX_ENDPOINTS_PER_EVENT}
    FOR KEY SHARE`;
  return rows.filter((r) => endpointMatches(r.events, type));
}

/**
 * Write the delivery rows for one event through `client` and return their ids.
 * The write half of `emit`, see the module docblock. Does no network I/O and
 * schedules nothing, so it is safe to call inside a `$transaction`: the rows
 * commit with the state change that caused them, or not at all.
 *
 * Returns `[]` when the application has no endpoint subscribed to this type,
 * which is the common case and costs one indexed SELECT.
 */
export async function enqueueEvent(
  client: WebhookDbClient,
  args: {
    applicationId: string;
    type: WebhookEventType;
    data: Record<string, unknown>;
  },
): Promise<string[]> {
  if (!isKnownWebhookEvent(args.type)) return [];
  const endpoints = await listForEvent(client, args.applicationId, args.type);
  if (endpoints.length === 0) return [];

  // A disabled Application dispatches nothing outbound. Deliberately placed
  // AFTER the endpoint lookup, not before: the docblock notes that "no
  // endpoint subscribed" is the common case and costs one indexed SELECT, so
  // checking first would add a second SELECT to every event on every
  // Application in the deployment to serve the rare frozen one. Here it costs
  // nothing except on Applications that actually have subscribers.
  //
  // Dropped, not parked. There is no row to resume from and creating PENDING
  // rows for a frozen Application would hand its subscribers a burst of stale
  // events on the thaw, events describing a window in which, from the
  // outside world's point of view, the Application was not running. The
  // state change itself is still committed and still visible through the API;
  // only the outbound notification is suppressed.
  const application = await client.application.findUnique({
    where: { id: args.applicationId },
    select: { disabledAt: true },
  });
  if (application?.disabledAt != null) return [];

  const eventId = cuid();
  const envelope: WebhookEventEnvelope = {
    eventId,
    occurredAt: new Date().toISOString(),
    type: args.type,
    applicationId: args.applicationId,
    data: args.data,
  };

  // One statement rather than N creates: inside a transaction every extra
  // round trip is time the row locks are held.
  const rows = await client.webhookDelivery.createManyAndReturn({
    data: endpoints.map((ep) => ({
      endpointId: ep.id,
      applicationId: args.applicationId,
      eventId,
      eventType: args.type,
      payload: envelope as never,
      status: 'PENDING' as const,
      attempts: 0,
      nextAttemptAt: new Date(),
    })),
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Hand delivery ids to the active scheduler for an immediate first attempt.
 * The read half of `emit`'s second step, see the module docblock. Call this
 * only AFTER the rows are committed. Skipping it entirely is safe but slow:
 * the rows are PENDING with `nextAttemptAt = now`, so the poller picks them up.
 */
export function kickDeliveries(deliveryIds: readonly string[]): void {
  for (const id of deliveryIds) {
    scheduleAttempt(id, 0, 0);
  }
}

/**
 * Fire-and-forget `emit` for an event that announces no state change of its
 * own, so there is no transaction for it to join. Today that is only
 * `device.limit_reached`: the refusal is the news, and nothing was written.
 *
 * Do NOT use it for an event that announces a write. The rows it enqueues are
 * written after, and apart from, the state change: a crash between the two
 * loses the event, and nothing can recover it. Write those with
 * `enqueueEvent(tx, …)` inside the caller's transaction and `kickDeliveries`
 * after the commit, as every auth, user, device, license, credit and billing
 * event now does.
 *
 * It logs instead of swallowing because the original sites were written
 * `void emit(…).catch(() => undefined)`, which discarded the only signal that
 * an event was dropped.
 *
 * `console` rather than the Fastify logger, matching lib/brute-force.ts: these
 * callers are services with no request context, and the message deliberately
 * carries only the event type + application, never the payload.
 */
export function emitDetached(args: {
  applicationId: string;
  type: WebhookEventType;
  data: Record<string, unknown>;
}): void {
  void webhookService.emit(args).catch((err: unknown) => {
    console.error(
      `[webhooks] failed to enqueue "${args.type}" for application ${args.applicationId}; ` +
        'the event is LOST (no row was written, so the poller cannot recover it)',
      err instanceof Error ? err.message : String(err),
    );
  });
}

/**
 * Read at most `maxBytes` of the response body, then cancel the stream. The
 * fetch's AbortController signal stays armed during the read, so a receiver
 * that returns headers promptly but trickles the body still hits the
 * delivery timeout.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.byteLength;
  }
  void reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString('utf8').slice(0, maxBytes);
}

interface PostResult {
  ok: boolean;
  status: number | null;
  responseBody: string | null;
  error: string | null;
}

async function postOnce(args: {
  url: string;
  body: string;
  signatureHeader: string;
  eventId: string;
  eventType: string;
}): Promise<PostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deliveryTimeoutMs());
  try {
    // SSRF guard at delivery time: resolve the host and reject private targets.
    // This catches DNS-rebind / public-host-with-private-A-record that the
    // registration-time URL check can't (it doesn't resolve DNS). A block here
    // surfaces as a normal delivery failure (retried, then FAILED).
    //
    // The addresses are then PINNED to the connection. Validating a hostname
    // and handing the raw URL to `fetch` let the runtime resolve again
    // independently, so a record with a short TTL alternating public and
    // private won the race, and the attacker got many attempts, since each
    // event allows up to 5 deliveries and a tenant can emit unlimited events
    // against their own application. The dispatcher's `lookup` below answers
    // from the validated set instead of asking DNS a second time.
    const allowed = await assertSafeUrlResolved(args.url);
    const pinned = pinnedFetchInit(allowed);
    const res = await fetch(args.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rekey-Signature': args.signatureHeader,
        'X-Rekey-Event-Id': args.eventId,
        'X-Rekey-Event-Type': args.eventType,
        'User-Agent': 'rekey-webhooks/1.0',
      },
      body: args.body,
      signal: controller.signal,
      ...pinned,
      // Never follow redirects, a validated public URL could otherwise 3xx us
      // onto an internal host, bypassing the guard above.
      redirect: 'manual',
    });
    // Read at most the first 4 KB of the body so a misbehaving consumer
    // can't fill our `WebhookDelivery.responseBody` column (or our memory,
    // the read stops at the cap rather than buffering the full body). The
    // abort timer above stays armed until `finally`, covering this read.
    const bodyText = await readBodyCapped(res, MAX_RESPONSE_BODY_BYTES);
    return {
      ok: res.ok,
      status: res.status,
      responseBody: bodyText,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      status: null,
      responseBody: null,
      error: (e as Error).message ?? 'fetch failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Update the delivery row, but swallow `P2025` (row not found). The row
 * can disappear out from under us if the endpoint is deleted mid-flight
 * (cascade) or if a test cleanup ran first, neither is a real error.
 */
async function safeUpdate(
  deliveryId: string,
  data: Parameters<typeof prisma.webhookDelivery.update>[0]['data'],
): Promise<void> {
  try {
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2025') return;
    throw e;
  }
}

/**
 * How the next delivery attempt is scheduled. `delayMs` is the backoff
 * (0 = as soon as possible); `attempts` is the delivery's attempt count, used
 * by the BullMQ scheduler to derive an idempotent per-attempt jobId so a
 * self-reschedule racing the poller collapses to one job. Defaults to an
 * in-process timer; webhook.queue.ts swaps in a Redis-backed enqueue at boot.
 *
 * `waitKey` is set only when an attempt is put off without being made (every
 * in-flight slot for its endpoint was taken). The attempt count has not moved,
 * so the per-attempt jobId would be the id of the job that is running right
 * now, and BullMQ would silently drop the re-add. The key makes it distinct.
 */
export type DeliveryScheduler = (
  deliveryId: string,
  delayMs: number,
  attempts: number,
  waitKey?: string,
) => void;

// Default scheduler. Under test it's an in-process timer (single-process suite,
// no external Redis, mirrors the rate-limiter's test convention). In any real
// runtime the BullMQ worker MUST install a Redis-backed scheduler at boot
// (startWebhookWorker), so reaching this default outside test means the queue
// failed to start, throw loudly rather than silently pin retries to one
// process and break multi-replica delivery. Errors in the test timer are
// swallowed: a fire-and-forget attempt must not surface as an unhandled rejection.
//
// The test timers and the attempts they start are tracked so they can be
// stopped (`stopScheduledDeliveries`). They are process-global and the suite
// runs every file in ONE fork, so an untracked timer outlived the app and the
// test that created it: a 30s retry scheduled against an unreachable endpoint
// in one file fired inside a later file's query-count window, and that file's
// exact count came up one statement high (the claim UPDATE below).
const pendingTimers = new Set<NodeJS.Timeout>();
const runningAttempts = new Set<Promise<void>>();

const defaultScheduler: DeliveryScheduler = (deliveryId, delayMs) => {
  if (env.NODE_ENV !== 'test') {
    throw new Error(
      '[webhooks] no delivery scheduler installed — the BullMQ worker is required ' +
        'but not running (Redis unreachable at boot?). Refusing to schedule via an ' +
        'in-process timer, which would not survive a crash or distribute across replicas.',
    );
  }
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    const attempt = attemptDelivery(deliveryId).catch(() => undefined);
    runningAttempts.add(attempt);
    void attempt.finally(() => runningAttempts.delete(attempt));
  }, delayMs);
  timer.unref();
  pendingTimers.add(timer);
};

/**
 * Cancel every attempt the in-process test scheduler still has queued, and
 * wait for the ones already running to finish. An attempt that fails while
 * being waited on schedules its retry, so this loops until both sets are
 * empty. A no-op when nothing is queued, and always a no-op outside test,
 * where the default scheduler never queues anything.
 */
export async function stopScheduledDeliveries(): Promise<void> {
  while (pendingTimers.size > 0 || runningAttempts.size > 0) {
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    await Promise.all(runningAttempts);
  }
}

let scheduleAttempt: DeliveryScheduler = defaultScheduler;

/**
 * Install the delivery scheduler. The BullMQ worker calls this at boot with a
 * Redis-backed enqueue. Passing `null` restores the default (test-only timer;
 * throws in any other runtime).
 */
export function setDeliveryScheduler(fn: DeliveryScheduler | null): void {
  scheduleAttempt = fn ?? defaultScheduler;
}

/**
 * Database lanes for delivery attempts, per process.
 *
 * An attempt holds no connection while it waits on the receiver: every
 * statement it runs is a plain query outside any transaction, so Prisma takes
 * a connection for the statement and hands it straight back. The send in the
 * middle costs a socket, not a connection. What an attempt does need is a
 * connection for its few statements before the send (claim, read, freeze
 * check) and one after (the outcome).
 *
 * The worker runs 50 attempts at once and the poller 10 more, against a pool
 * of 20 that the HTTP handlers share. Draining a backlog to fast receivers,
 * most of those attempts are in their database statements at any moment, so
 * without a limit they queue up to 60 statements in front of every user
 * request. This caps the delivery path's share of the pool at half of it (at
 * most 10), which is what the pool was sized around when the worker ran 10
 * attempts at once; sends above that number keep going, only their database
 * statements wait for a lane.
 */
function deliveryDbLaneLimit(): number {
  let pool = env.DATABASE_POOL_SIZE;
  try {
    // A `connection_limit` in the URL wins over DATABASE_POOL_SIZE (lib/prisma.ts).
    const fromUrl = Number(new URL(env.DATABASE_URL).searchParams.get('connection_limit'));
    if (Number.isInteger(fromUrl) && fromUrl > 0) pool = fromUrl;
  } catch {
    // Unparseable URL: the env validator has already refused to boot.
  }
  return Math.max(1, Math.min(10, Math.floor(pool / 2)));
}

let dbLaneLimit = deliveryDbLaneLimit();
let dbLanesBusy = 0;
let dbLanesPeak = 0;
const dbLaneWaiters: Array<() => void> = [];

async function inDbLane<T>(fn: () => Promise<T>): Promise<T> {
  if (dbLanesBusy < dbLaneLimit) {
    dbLanesBusy += 1;
  } else {
    // Handed a lane directly by the releaser, so `busy` does not change.
    await new Promise<void>((resolve) => dbLaneWaiters.push(resolve));
  }
  dbLanesPeak = Math.max(dbLanesPeak, dbLanesBusy);
  try {
    return await fn();
  } finally {
    const next = dbLaneWaiters.shift();
    if (next) next();
    else dbLanesBusy -= 1;
  }
}

/** Tests only: set the lane count (`null` restores it) and read the busiest it has been. */
export const __deliveryDbLanes = {
  set(limit: number | null): void {
    dbLaneLimit = limit ?? deliveryDbLaneLimit();
    dbLanesPeak = 0;
  },
  peak(): number {
    return dbLanesPeak;
  },
};

/**
 * How long a delivery waits before re-checking whether its Application has
 * been re-enabled. Long enough that a freeze of any length is cheap (one row
 * read per delivery per interval), short enough that a thaw resumes promptly
 * without anyone doing anything.
 */
const DISABLED_APP_PARK_MS = 5 * 60_000;

/**
 * Run exactly one delivery attempt: atomically claim the row, POST, then
 * persist the outcome and, on a retryable failure, hand the next attempt to
 * the active scheduler. This is the unit of work both the in-process timer and
 * the BullMQ worker invoke. Exported for the worker processor.
 */
export async function attemptDelivery(deliveryId: string): Promise<void> {
  const delivery = await inDbLane(() => claimForAttempt(deliveryId));
  if (!delivery) return;

  // Per-endpoint isolation (endpoint-gate.ts). The breaker comes first: an
  // endpoint that has failed several sends in a row is not sent to while its
  // circuit is open, and the attempt is recorded as failed on the normal
  // retry schedule, exactly as the send would most likely have been, without
  // holding a slot for a timeout. Checked after the park in claimForAttempt,
  // so a frozen Application's deliveries still keep their attempts.
  const gate = getEndpointGate();
  const openMs = await gate.openForMs(delivery.endpointId);
  if (openMs > 0) {
    await inDbLane(() =>
      recordOutcome(delivery, {
        ok: false,
        status: null,
        responseBody: null,
        error:
          `Not sent: the endpoint failed its last ${BREAKER_THRESHOLD} sends in a row, ` +
          `so sends to it are paused for ${Math.ceil(openMs / 1000)}s more.`,
      }),
    );
    return;
  }

  // Then the in-flight caps, the endpoint's and its Application's. No slot
  // means one of them already has as many sends running as it may: put this
  // one off without sending it and without counting it. Releasing the claim
  // early (nextAttemptAt = the retry time) lets the rescheduled job, or the
  // poller if that job is lost, claim it.
  const slot = await gate.tryAcquire(delivery.endpointId, delivery.applicationId);
  if ('retryInMs' in slot) {
    const retryAt = Date.now() + slot.retryInMs;
    await inDbLane(() => safeUpdate(deliveryId, { nextAttemptAt: new Date(retryAt) }));
    scheduleAttempt(deliveryId, slot.retryInMs, delivery.attempts, String(retryAt));
    return;
  }

  let result: PostResult;
  try {
    const body = JSON.stringify(delivery.payload);
    const sig = signWebhook({ body, secret: delivery.endpoint.secret });
    result = await postOnce({
      url: delivery.endpoint.url,
      body,
      signatureHeader: sig.signatureHeader,
      eventId: delivery.eventId,
      eventType: delivery.eventType,
    });
  } finally {
    // Before the row is written: the slot guards the receiver, not our DB.
    await slot.release();
  }
  await gate.recordResult(delivery.endpointId, result.ok);
  await inDbLane(() => recordOutcome(delivery, result));
}

/**
 * Claim the row and load it with its endpoint. `null` when there is nothing to
 * send now: someone else holds the claim, the row is gone or finished, or its
 * Application is frozen (the row is parked, see below).
 */
async function claimForAttempt(
  deliveryId: string,
): Promise<(WebhookDelivery & { endpoint: WebhookEndpoint }) | null> {
  // Atomic claim: only one caller (in-process timer OR the periodic poller)
  // may attempt a due delivery. The guarded update pushes `nextAttemptAt`
  // into the future, so a concurrent claimer's WHERE no longer matches and
  // its updateMany count is 0. The 1s tolerance absorbs timer-fire skew.
  // If the process dies mid-attempt the row stays PENDING with
  // nextAttemptAt = now + CLAIM_WINDOW_MS, so the poller re-attempts it.
  const claimed = await prisma.webhookDelivery.updateMany({
    where: {
      id: deliveryId,
      status: 'PENDING',
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date(Date.now() + 1000) } }],
    },
    data: { nextAttemptAt: new Date(Date.now() + CLAIM_WINDOW_MS) },
  });
  if (claimed.count !== 1) return null;

  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });
  if (!delivery || delivery.status !== 'PENDING') return null;

  // Deliveries already queued when the Application was frozen. `enqueueEvent`
  // stops new ones; these are the ones already in flight.
  //
  // Parked, not failed and not dropped. Failing them would burn the retry
  // budget on a condition that has nothing to do with the subscriber's
  // endpoint, and would mark as permanently FAILED a delivery that would have
  // succeeded, the operator would thaw the Application and find a wall of
  // failures caused by their own maintenance. So: leave the row PENDING with
  // its attempt count untouched and push `nextAttemptAt` out. The poller
  // re-checks on that cadence and the delivery resumes, unharmed, on the thaw.
  // Separate read rather than an `include`: WebhookDelivery carries a bare
  // `applicationId` with no Prisma relation (there is no FK constraint on the
  // column), so there is nothing to include. This is the background retry
  // sweep, not a request path, and it runs only for rows that were already
  // claimed, so one more indexed read is not a cost worth a schema change.
  const deliveryApp = await prisma.application.findUnique({
    where: { id: delivery.applicationId },
    select: { disabledAt: true },
  });
  if (deliveryApp?.disabledAt != null) {
    await safeUpdate(deliveryId, {
      nextAttemptAt: new Date(Date.now() + DISABLED_APP_PARK_MS),
    });
    return null;
  }
  return delivery;
}

/**
 * Persist one attempt's outcome: SUCCEEDED, FAILED once the attempt budget is
 * spent, otherwise the backoff and the next scheduled attempt.
 */
async function recordOutcome(
  delivery: Pick<WebhookDelivery, 'id' | 'attempts'>,
  result: PostResult,
): Promise<void> {
  const deliveryId = delivery.id;
  const attempts = delivery.attempts + 1;
  if (result.ok) {
    await safeUpdate(deliveryId, {
      status: 'SUCCEEDED',
      attempts,
      responseStatus: result.status,
      responseBody: result.responseBody,
      nextAttemptAt: null,
      error: null,
    });
    return;
  }

  if (attempts >= MAX_ATTEMPTS) {
    await safeUpdate(deliveryId, {
      status: 'FAILED',
      attempts,
      responseStatus: result.status,
      responseBody: result.responseBody,
      nextAttemptAt: null,
      error: result.error,
    });
    return;
  }

  const delaySeconds = RETRY_DELAYS_SECONDS[attempts - 1] ?? RETRY_DELAYS_SECONDS.at(-1)!;
  const nextAt = new Date(Date.now() + delaySeconds * 1000);
  await safeUpdate(deliveryId, {
    attempts,
    responseStatus: result.status,
    responseBody: result.responseBody,
    nextAttemptAt: nextAt,
    error: result.error,
  });
  // Schedule the next attempt through the active scheduler, a Redis-backed
  // delayed job in every real runtime (survives a crash, distributes across
  // replicas). The poller picks the row up off `nextAttemptAt` if the queued
  // job is ever lost, the claim above stops any two from double-sending.
  scheduleAttempt(deliveryId, delaySeconds * 1000, attempts);
}

/**
 * Deliveries the poller attempts at once. Each attempt claims its own row and
 * takes its own slots, so they are independent; the gate keeps any one
 * endpoint and any one Application to its cap however many of its rows are
 * due. Worst case for a full batch of 50 is 5 rounds of the request timeout,
 * 50s at the 10s default, inside the poller's 60s interval; a longer
 * WEBHOOK_TIMEOUT_MS can outlast the interval, and `pollInFlight` below makes
 * the next tick skip rather than overlap.
 */
const POLL_PARALLELISM = 10;

// Set while a sweep runs in this process. Every replica runs the poller on a
// timer; a sweep that outlives the interval (a batch of slow receivers) must
// not overlap the next tick, which would re-read the same rows and double the
// load exactly when delivery is already slow. Other replicas are kept off the
// same rows by the per-row claim, not by this flag.
let pollInFlight = false;

/**
 * Re-attempt every PENDING delivery whose `nextAttemptAt` has passed.
 * Crash-survivability for the queued retries: registered as a periodic
 * interval in app.ts (like the request-log flush/prune jobs). Up to
 * POLL_PARALLELISM attempts run at once; per-row claims in attemptDelivery
 * keep it safe to run concurrently with the queue worker and other replicas.
 *
 * Returns how many due rows were found, or 0 without reading anything when a
 * sweep is already running in this process. A failing attempt does not stop
 * the rest of the batch; the first error is rethrown once the batch is done.
 */
export async function processDueWebhookDeliveries(limit = 50): Promise<number> {
  if (pollInFlight) return 0;
  pollInFlight = true;
  try {
    const due = await prisma.webhookDelivery.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      select: { id: true },
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
    });
    const errors: unknown[] = [];
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < due.length) {
        const id = due[next++]!.id;
        await attemptDelivery(id).catch((err: unknown) => {
          errors.push(err);
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(POLL_PARALLELISM, due.length) }, lane));
    if (errors.length > 0) throw errors[0];
    return due.length;
  } finally {
    pollInFlight = false;
  }
}

export const webhookService = {
  /**
   * Emit an event to every matching endpoint. Returns the delivery row
   * ids that were enqueued. Fire-and-forget, callers MUST NOT await this;
   * use `emitDetached` so the failure is at least logged.
   *
   * For a caller that is ALREADY inside a `$transaction` changing the state
   * this event announces, use `enqueueEvent(tx, …)` + `kickDeliveries(…)`
   * instead. This helper cannot join a transaction, so the rows it writes can
   * be lost by a crash between the state change and this call.
   */
  async emit(args: {
    applicationId: string;
    type: WebhookEventType;
    data: Record<string, unknown>;
  }): Promise<string[]> {
    const ids = await enqueueEvent(prisma, args);
    // Kick off the first attempt immediately, in the background, via the active
    // scheduler (in-process timer or BullMQ enqueue). The rows are already
    // PENDING with nextAttemptAt=now, so the poller re-attempts off
    // `nextAttemptAt` if the kickoff is lost (e.g. crash before the job lands).
    kickDeliveries(ids);
    return ids;
  },

  // ---------- Endpoint CRUD ----------

  async listEndpoints(
    applicationId: string,
    opts: { take?: number; skip?: number } = {},
  ): Promise<WebhookEndpoint[]> {
    return prisma.webhookEndpoint.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.take ?? 100, 100),
      ...(opts.skip !== undefined && { skip: opts.skip }),
    });
  },

  /** Total webhook endpoints on this Application, ignoring take/skip. */
  async countEndpoints(applicationId: string): Promise<number> {
    return prisma.webhookEndpoint.count({ where: { applicationId } });
  },

  async createEndpoint(args: {
    applicationId: string;
    url: string;
    events: string[];
  }): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    const existing = await prisma.webhookEndpoint.count({ where: { applicationId: args.applicationId } });
    if (existing >= MAX_ENDPOINTS_PER_APPLICATION) {
      throw new RekeyError({
        statusCode: 400,
        code: 'WEBHOOK_ENDPOINT_LIMIT_REACHED',
        message: `This Application already has ${existing} webhook endpoints, the most one may have (${MAX_ENDPOINTS_PER_APPLICATION}).`,
        fix: 'Delete endpoints you no longer use, or subscribe one endpoint to more event types.',
      });
    }
    const secret = generateWebhookSecret();
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        applicationId: args.applicationId,
        url: args.url,
        events: args.events,
        secret,
      },
    });
    return { endpoint, secret };
  },

  async updateEndpoint(args: {
    applicationId: string;
    endpointId: string;
    url?: string;
    events?: string[];
    enabled?: boolean;
  }): Promise<WebhookEndpoint> {
    // Scope the write by (id, applicationId), like deleteEndpoint/rotateSecret
    //, so an endpointId from another application can never be mutated by
    // passing a different applicationId. `update` keyed on id alone would let
    // a caller who only owns `applicationId` edit any endpoint by id.
    const { count } = await prisma.webhookEndpoint.updateMany({
      where: { id: args.endpointId, applicationId: args.applicationId },
      data: {
        ...(args.url !== undefined && { url: args.url }),
        ...(args.events !== undefined && { events: args.events }),
        ...(args.enabled !== undefined && { enabled: args.enabled }),
      },
    });
    const endpoint =
      count === 1
        ? await prisma.webhookEndpoint.findFirst({
            where: { id: args.endpointId, applicationId: args.applicationId },
          })
        : null;
    if (!endpoint) {
      throw new RekeyError({
        statusCode: 404,
        code: 'WEBHOOK_ENDPOINT_NOT_FOUND',
        message: `Webhook endpoint "${args.endpointId}" not found for this application.`,
        fix: 'List endpoints for the application and use an id it actually owns.',
      });
    }
    return endpoint;
  },

  async deleteEndpoint(applicationId: string, endpointId: string): Promise<void> {
    await prisma.webhookEndpoint.deleteMany({
      where: { id: endpointId, applicationId },
    });
  },

  /** Rotate the signing secret. Returns the new raw value. */
  async rotateSecret(applicationId: string, endpointId: string): Promise<string> {
    const secret = generateWebhookSecret();
    await prisma.webhookEndpoint.updateMany({
      where: { id: endpointId, applicationId },
      data: { secret },
    });
    return secret;
  },

  /**
   * Recent deliveries for one endpoint, newest-first. Capped at 100 per page.
   *
   * `status` is the filter that matters: an endpoint with a long history and a
   * handful of failures is exactly the case an operator opens this for, and
   * without it they page through successes looking for the red ones.
   */
  async listDeliveries(
    applicationId: string,
    endpointId: string,
    opts: {
      status?: WebhookDeliveryStatus;
      eventType?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<WebhookDelivery[]> {
    return prisma.webhookDelivery.findMany({
      where: {
        applicationId,
        endpointId,
        ...(opts.status !== undefined && { status: opts.status }),
        ...(opts.eventType !== undefined && { eventType: opts.eventType }),
      },
      // Secondary key on id so paging is stable when several deliveries of one
      // event share a createdAt.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(opts.limit ?? 50, 100),
      ...(opts.offset !== undefined && { skip: opts.offset }),
    });
  },

  /** Total deliveries matching `listDeliveries`' filters, ignoring limit/offset. */
  async countDeliveries(
    applicationId: string,
    endpointId: string,
    opts: { status?: WebhookDeliveryStatus; eventType?: string } = {},
  ): Promise<number> {
    return prisma.webhookDelivery.count({
      where: {
        applicationId,
        endpointId,
        ...(opts.status !== undefined && { status: opts.status }),
        ...(opts.eventType !== undefined && { eventType: opts.eventType }),
      },
    });
  },

  /**
   * Re-attempt a failed/pending delivery on demand. Useful from the panel.
   * Scoped to (application, endpoint) so an operator can't poke a delivery
   * row through the wrong endpoint's URL. Returns `false` when nothing
   * matched (unknown id, wrong endpoint, or already SUCCEEDED) so the route
   * can 404 instead of pretending a retry was queued.
   */
  async retryDelivery(
    applicationId: string,
    endpointId: string,
    deliveryId: string,
  ): Promise<boolean> {
    const updated = await prisma.webhookDelivery.updateMany({
      where: { id: deliveryId, applicationId, endpointId, NOT: { status: 'SUCCEEDED' } },
      data: { status: 'PENDING', nextAttemptAt: new Date() },
    });
    if (updated.count !== 1) return false;
    // Read the (unchanged) attempt count so the scheduler builds the same
    // per-attempt jobId the row would use anyway, keeps the manual kick from
    // duplicating a delayed job already queued for this attempt.
    const row = await prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      select: { attempts: true },
    });
    scheduleAttempt(deliveryId, 0, row?.attempts ?? 0);
    return true;
  },
};
