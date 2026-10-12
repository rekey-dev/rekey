/**
 * The bound on diagnostic events.
 *
 * A refused checkout or a refused coupon can be caused by anyone holding a
 * publishable key, so without a bound the log could be filled from outside.
 * Per Application and hour, the log takes the first
 * `DIAGNOSTIC_PER_REASON_PER_HOUR` events of one type and reason, and at most
 * `DIAGNOSTIC_PER_APPLICATION_PER_HOUR` diagnostic events in all. The rest
 * are counted, and `flushDiagnosticAggregates` writes one
 * `diagnostic.aggregated` row per type, reason and hour saying how many were
 * left out.
 *
 * The counters live in Redis, not in Postgres: a counter row would be locked
 * by every checkout transaction that writes an event, which would queue an
 * Application's checkouts behind one another.
 */

import { Prisma } from '@prisma/client';
import {
  BOUNDED_DIAGNOSTIC_TYPES,
  diagnosticReasonOf,
  type BillingEventType,
  type BoundedDiagnosticType,
} from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { getRedis } from '../../lib/redis.js';
import { parseBillingEvent, toBillingEventRow } from './events.js';

export const DIAGNOSTIC_PER_REASON_PER_HOUR = 20;
export const DIAGNOSTIC_PER_APPLICATION_PER_HOUR = 200;

const HOUR_MS = 60 * 60 * 1000;
/** A window's counters outlive it long enough for the flush to write its final count. */
const BUCKET_TTL_SECONDS = 3 * 60 * 60;
const BUCKETS_FLUSHED = 3;
const SEP = '|';

/** Never bounded: it is the bound's own record, written once per window. */
const UNBOUNDED_TYPE: BillingEventType = 'diagnostic.aggregated';

const memory = new Map<string, Map<string, number>>();

/** Under test there is no Redis, and the counters live in this process. */
export function __resetForTests(): void {
  memory.clear();
}

function bucketOf(at: Date): string {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS).toISOString();
}

const redisKey = (bucket: string): string => `rk:billing-log:diagnostic:${bucket}`;

async function increment(bucket: string, field: string): Promise<number> {
  const redis = getRedis();
  if (redis === null) {
    const counters = memory.get(bucket) ?? new Map<string, number>();
    memory.set(bucket, counters);
    const next = (counters.get(field) ?? 0) + 1;
    counters.set(field, next);
    return next;
  }
  const results = await redis.multi().hincrby(redisKey(bucket), field, 1).expire(redisKey(bucket), BUCKET_TTL_SECONDS).exec();
  const count = results?.[0]?.[1];
  if (typeof count !== 'number') throw new Error('billing log: the diagnostic counter did not answer');
  return count;
}

async function counters(bucket: string): Promise<Map<string, number>> {
  const redis = getRedis();
  if (redis === null) return new Map(memory.get(bucket) ?? []);
  const all = await redis.hgetall(redisKey(bucket));
  return new Map(Object.entries(all).map(([field, value]) => [field, Number(value)]));
}

/**
 * Whether the log takes this diagnostic event, counting it either way. An
 * event of another tier is always taken.
 *
 * When the counter cannot be reached the event is not written. The bound is
 * only a bound if it holds during an outage too, and a diagnostic event is
 * best-effort by definition.
 *
 * @example
 * if (await admitDiagnosticEvent(row)) await tx.billingEvent.createMany({ data: [row], skipDuplicates: true });
 */
export async function admitDiagnosticEvent(
  event: { applicationId: string; type: string; tier: string; data?: unknown },
  now: Date = new Date(),
): Promise<boolean> {
  if (event.tier !== 'DIAGNOSTIC' || event.type === UNBOUNDED_TYPE) return true;
  const bucket = bucketOf(now);
  const reason = diagnosticReasonOf({ type: event.type, data: (event.data ?? {}) as object });
  const key = [event.applicationId, event.type, reason].join(SEP);
  try {
    let admitted = (await increment(bucket, `n${SEP}${key}`)) <= DIAGNOSTIC_PER_REASON_PER_HOUR;
    if (admitted) {
      admitted = (await increment(bucket, `a${SEP}${event.applicationId}`)) <= DIAGNOSTIC_PER_APPLICATION_PER_HOUR;
    }
    if (!admitted) await increment(bucket, `s${SEP}${key}`);
    return admitted;
  } catch {
    return false;
  }
}

const AGGREGATED_TYPES = BOUNDED_DIAGNOSTIC_TYPES;
type AggregatedType = BoundedDiagnosticType;

/**
 * Write, or bring up to date, the `diagnostic.aggregated` row of every window
 * that left events out. Run on a schedule; safe to run from several processes
 * at once, because a row's count only ever moves up to the counter's value.
 * Returns how many rows were written or raised.
 *
 * @example
 * await flushDiagnosticAggregates();
 */
export async function flushDiagnosticAggregates(now: Date = new Date()): Promise<number> {
  let changed = 0;
  for (let back = 0; back < BUCKETS_FLUSHED; back += 1) {
    const windowStart = bucketOf(new Date(now.getTime() - back * HOUR_MS));
    for (const [field, suppressed] of await counters(windowStart)) {
      const [kind, applicationId, eventType, reason] = field.split(SEP);
      if (kind !== 's' || applicationId === undefined || reason === undefined || suppressed < 1) continue;
      if (!AGGREGATED_TYPES.includes(eventType as AggregatedType)) continue;
      changed += await writeAggregate({
        applicationId,
        eventType: eventType as AggregatedType,
        reason,
        windowStart,
        suppressed,
      });
    }
  }
  return changed;
}

async function writeAggregate(args: {
  applicationId: string;
  eventType: AggregatedType;
  reason: string;
  windowStart: string;
  suppressed: number;
}): Promise<number> {
  const dedupeKey = `${args.eventType}:${args.reason}:${args.windowStart}`;
  const row = toBillingEventRow(
    parseBillingEvent({
      type: 'diagnostic.aggregated',
      applicationId: args.applicationId,
      actor: { type: 'system' },
      occurredAt: new Date(args.windowStart),
      dedupeKey,
      data: { eventType: args.eventType, reason: args.reason, windowStart: args.windowStart, suppressed: args.suppressed },
    }),
  );
  try {
    const { count } = await prisma.billingEvent.createMany({ data: [row], skipDuplicates: true });
    if (count === 1) return 1;
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('rekey.billing_events_maintenance', 'on', true)`;
      return tx.$executeRaw`
        UPDATE "billing_events"
           SET "data" = jsonb_set("data", '{suppressed}', to_jsonb(${args.suppressed}::int))
         WHERE "application_id" = ${args.applicationId}
           AND "type" = 'diagnostic.aggregated'
           AND "dedupe_key" = ${dedupeKey}
           AND ("data" ->> 'suppressed')::int < ${args.suppressed}`;
    });
  } catch (err) {
    // The Application was deleted while its counters were still live.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') return 0;
    throw err;
  }
}
