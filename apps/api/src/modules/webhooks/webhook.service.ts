/**
 * Outbound webhook delivery + endpoint management.
 *
 * Flow:
 *   1. Auth flows call `webhookService.emit(applicationId, type, data)`.
 *   2. We fan out to every enabled WebhookEndpoint whose subscription
 *      list matches the event type (or carries `"*"`).
 *   3. Each match becomes a WebhookDelivery row in PENDING.
 *   4. We POST the payload with a `t=<ts>,v1=<hmac>` `X-Relipay-Signature`
 *      header. 2xx → SUCCEEDED; everything else (incl. network error) →
 *      schedule a retry with exponential backoff up to MAX_ATTEMPTS.
 *
 * **Delivery is fire-and-forget** from the caller's perspective. A slow
 * webhook receiver must NEVER block the user-facing API request. The
 * service kicks the HTTP call off with `void` and lets the delivery
 * worker (this same module) retry on failure.
 *
 * Scheduling goes through a pluggable seam (`scheduleAttempt`). In every real
 * runtime the BullMQ worker (webhook.queue.ts) installs a Redis-backed enqueue
 * at boot — required, no process-local fallback — so delayed retries live in
 * Redis (survive a crash) and distribute across replicas for microservice
 * deployments. The default scheduler is an in-process `setTimeout` that runs
 * ONLY under `NODE_ENV=test` (single-process suite, no external Redis); in any
 * other runtime it throws, so a delivery can never be silently pinned to one
 * process. A periodic poller (`processDueWebhookDeliveries`, registered in
 * app.ts) re-attempts PENDING rows whose `nextAttemptAt` has passed — the crash
 * backstop for a row orphaned by a Redis flush or a job that never landed.
 * Every path funnels through an atomic claim (a guarded `updateMany` that
 * pushes `nextAttemptAt` forward) so a queue worker, the poller, and other
 * replicas can never double-send the same delivery.
 */

import type { WebhookEndpoint, WebhookDelivery } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RelipayError } from '../../lib/error.js';
import { env } from '../../config/env.js';
import { signWebhook, generateWebhookSecret } from '../../lib/webhook-signing.js';
import { assertSafeUrl } from '../../lib/ssrf-guard.js';
import {
  endpointMatches,
  isKnownWebhookEvent,
  type WebhookEventEnvelope,
  type WebhookEventType,
} from './events.js';
import { randomBytes } from 'node:crypto';

const MAX_ATTEMPTS = 5;
// Exponential backoff in seconds: 30s, 2m, 10m, 1h, 4h. Total ~5h before
// we give up — long enough that transient downtime is forgiven, short
// enough that a permanently-broken endpoint doesn't hold rows in PENDING
// forever.
const RETRY_DELAYS_SECONDS = [30, 120, 600, 3600, 14400];
const REQUEST_TIMEOUT_MS = 10_000;
// Max stored response-body bytes. We stop READING at this point too (not
// just truncating after the fact) so a receiver streaming an endless body
// can't balloon memory — see readBodyCapped.
const MAX_RESPONSE_BODY_BYTES = 4096;
// How long an atomic claim on a delivery row lasts. Generous vs the request
// timeout so a slow-but-alive attempt is never double-sent; short enough
// that a crash mid-attempt is retried by the poller within a minute.
const CLAIM_WINDOW_MS = 60_000;

function cuid(): string {
  // Inline a small cuid-ish id without adding a dep — base64url of 16
  // random bytes is sufficient for our idempotency-key semantics.
  return randomBytes(16).toString('base64url');
}

// Hard ceiling on enabled endpoints fanned out per event. An application with
// this many live webhooks is already pathological; the cap bounds memory + the
// per-event fan-out so a runaway integration can't load an unbounded set into
// memory on every emitted event. Deterministic order (oldest first) so which
// endpoints win under the cap is stable rather than DB-order-dependent.
const MAX_ENDPOINTS_PER_EVENT = 100;

function listForEvent(
  applicationId: string,
  type: WebhookEventType,
): Promise<WebhookEndpoint[]> {
  return prisma.webhookEndpoint.findMany({
    where: { applicationId, enabled: true },
    orderBy: { createdAt: 'asc' },
    take: MAX_ENDPOINTS_PER_EVENT,
  }).then((rows) => rows.filter((r) => endpointMatches(r.events, type)));
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

async function postOnce(args: {
  url: string;
  body: string;
  signatureHeader: string;
  eventId: string;
  eventType: string;
}): Promise<{ ok: boolean; status: number | null; responseBody: string | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // SSRF guard at delivery time: resolve the host and reject private targets.
    // This catches DNS-rebind / public-host-with-private-A-record that the
    // registration-time URL check can't (it doesn't resolve DNS). A block here
    // surfaces as a normal delivery failure (retried, then FAILED).
    await assertSafeUrl(args.url);
    const res = await fetch(args.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relipay-Signature': args.signatureHeader,
        'X-Relipay-Event-Id': args.eventId,
        'X-Relipay-Event-Type': args.eventType,
        'User-Agent': 'relipay-webhooks/1.0',
      },
      body: args.body,
      signal: controller.signal,
      // Never follow redirects — a validated public URL could otherwise 3xx us
      // onto an internal host, bypassing the guard above.
      redirect: 'manual',
    });
    // Read at most the first 4 KB of the body so a misbehaving consumer
    // can't fill our `WebhookDelivery.responseBody` column (or our memory —
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
 * (cascade) or if a test cleanup ran first — neither is a real error.
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
 */
export type DeliveryScheduler = (deliveryId: string, delayMs: number, attempts: number) => void;

// Default scheduler. Under test it's an in-process timer (single-process suite,
// no external Redis — mirrors the rate-limiter's test convention). In any real
// runtime the BullMQ worker MUST install a Redis-backed scheduler at boot
// (startWebhookWorker), so reaching this default outside test means the queue
// failed to start — throw loudly rather than silently pin retries to one
// process and break multi-replica delivery. Errors in the test timer are
// swallowed: a fire-and-forget attempt must not surface as an unhandled rejection.
const defaultScheduler: DeliveryScheduler = (deliveryId, delayMs) => {
  if (env.NODE_ENV !== 'test') {
    throw new Error(
      '[webhooks] no delivery scheduler installed — the BullMQ worker is required ' +
        'but not running (Redis unreachable at boot?). Refusing to schedule via an ' +
        'in-process timer, which would not survive a crash or distribute across replicas.',
    );
  }
  setTimeout(() => {
    void attemptDelivery(deliveryId).catch(() => undefined);
  }, delayMs).unref();
};

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
 * Run exactly one delivery attempt: atomically claim the row, POST, then
 * persist the outcome and — on a retryable failure — hand the next attempt to
 * the active scheduler. This is the unit of work both the in-process timer and
 * the BullMQ worker invoke. Exported for the worker processor.
 */
export async function attemptDelivery(deliveryId: string): Promise<void> {
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
  if (claimed.count !== 1) return;

  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { endpoint: true },
  });
  if (!delivery || delivery.status !== 'PENDING') return;

  const body = JSON.stringify(delivery.payload);
  const sig = signWebhook({ body, secret: delivery.endpoint.secret });

  const result = await postOnce({
    url: delivery.endpoint.url,
    body,
    signatureHeader: sig.signatureHeader,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
  });

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
  // Schedule the next attempt through the active scheduler — a Redis-backed
  // delayed job in every real runtime (survives a crash, distributes across
  // replicas). The poller picks the row up off `nextAttemptAt` if the queued
  // job is ever lost — the claim above stops any two from double-sending.
  scheduleAttempt(deliveryId, delaySeconds * 1000, attempts);
}

/**
 * Re-attempt every PENDING delivery whose `nextAttemptAt` has passed.
 * Crash-survivability for the in-process retry timers: registered as a
 * periodic interval in app.ts (like the request-log flush/prune jobs).
 * Deliveries are processed sequentially — this is a background sweep, not
 * a throughput path; per-row claims in attemptDelivery keep it safe to run
 * concurrently with timers and other instances. Returns how many due rows
 * were found.
 */
export async function processDueWebhookDeliveries(limit = 50): Promise<number> {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
    select: { id: true },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
  });
  for (const d of due) {
    await attemptDelivery(d.id);
  }
  return due.length;
}

export const webhookService = {
  /**
   * Emit an event to every matching endpoint. Returns the delivery row
   * ids that were enqueued. Fire-and-forget — auth flows MUST NOT await
   * this; do `void webhookService.emit(...).catch(...)`.
   */
  async emit(args: {
    applicationId: string;
    type: WebhookEventType;
    data: Record<string, unknown>;
  }): Promise<string[]> {
    if (!isKnownWebhookEvent(args.type)) return [];
    const endpoints = await listForEvent(args.applicationId, args.type);
    if (endpoints.length === 0) return [];

    const eventId = cuid();
    const envelope: WebhookEventEnvelope = {
      eventId,
      occurredAt: new Date().toISOString(),
      type: args.type,
      applicationId: args.applicationId,
      data: args.data,
    };

    const deliveries = await Promise.all(
      endpoints.map((ep) =>
        prisma.webhookDelivery.create({
          data: {
            endpointId: ep.id,
            applicationId: args.applicationId,
            eventId,
            eventType: args.type,
            payload: envelope as never,
            status: 'PENDING',
            attempts: 0,
            nextAttemptAt: new Date(),
          },
        }),
      ),
    );
    // Kick off the first attempt immediately, in the background, via the active
    // scheduler (in-process timer or BullMQ enqueue). The rows are already
    // PENDING with nextAttemptAt=now, so the poller re-attempts off
    // `nextAttemptAt` if the kickoff is lost (e.g. crash before the job lands).
    for (const d of deliveries) {
      scheduleAttempt(d.id, 0, 0);
    }
    return deliveries.map((d) => d.id);
  },

  // ---------- Endpoint CRUD ----------

  async listEndpoints(applicationId: string): Promise<WebhookEndpoint[]> {
    return prisma.webhookEndpoint.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  },

  async createEndpoint(args: {
    applicationId: string;
    url: string;
    events: string[];
  }): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
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
    // Scope the write by (id, applicationId) — like deleteEndpoint/rotateSecret
    // — so an endpointId from another application can never be mutated by
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
      throw new RelipayError({
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

  /** Recent deliveries for one endpoint, newest-first. Capped at 100. */
  async listDeliveries(
    applicationId: string,
    endpointId: string,
    limit = 50,
  ): Promise<WebhookDelivery[]> {
    return prisma.webhookDelivery.findMany({
      where: { applicationId, endpointId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
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
    // per-attempt jobId the row would use anyway — keeps the manual kick from
    // duplicating a delayed job already queued for this attempt.
    const row = await prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      select: { attempts: true },
    });
    scheduleAttempt(deliveryId, 0, row?.attempts ?? 0);
    return true;
  },
};
