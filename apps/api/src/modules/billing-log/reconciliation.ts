/**
 * Reconciliation: the billing log compared with the money rows of one
 * Application over one period.
 *
 * The rows are the truth and the log is their index, so a disagreement means
 * the log is incomplete or names something that is not there. Four checks:
 * a payment with no event, an event naming a payment that does not exist, a
 * payment whose refunds add up differently in `Payment.refundedAmount`, the
 * `Refund` rows and the `payment.refunded` events, and a subscription with no
 * activation event.
 *
 * It reads, and it writes findings to the log as diagnostic events. It never
 * changes a payment, a refund or a subscription.
 *
 * Payments and subscriptions from before the log existed were never logged.
 * They are not findings: each check starts at the first event of its kind the
 * Application's log holds.
 */

import { Prisma } from '@prisma/client';
import {
  RECONCILIATION_MAX_FINDINGS,
  type ReconciliationFinding,
  type ReconciliationFindingKind,
  type ReconciliationReport,
} from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { withReadOnlyBudget } from '../../lib/read-budget.js';
import { recordDiagnosticBillingEvent, type BillingLogLogger } from './writer.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RECONCILIATION_DEFAULT_DAYS = 7;
export const RECONCILIATION_MAX_DAYS = 31;

type Db = Prisma.TransactionClient;

const PAYMENT_EVENT_TYPES = ['payment.recorded', 'payment.failed', 'payment.not_applied', 'payment.unapplied'] as const;
const SUBSCRIPTION_EVENT_TYPES = ['subscription.activated', 'subscription.granted', 'subscription.imported'] as const;
const PAYMENT_EVENTS = Prisma.sql`(${Prisma.join([...PAYMENT_EVENT_TYPES])})`;
const SUBSCRIPTION_EVENTS = Prisma.sql`(${Prisma.join([...SUBSCRIPTION_EVENT_TYPES])})`;

/**
 * When the first event of any of `types` was recorded for one Application.
 * One probe of the (application, type, seq) index per type: asked as a single
 * `type IN (...) ORDER BY seq`, Postgres walks the table-wide `seq` index and
 * reads every Application's events when this one has none of those types.
 */
function firstEventOf(applicationId: string, types: readonly string[]): Prisma.Sql {
  const probes = types.map(
    (type) => Prisma.sql`
      (SELECT "recorded_at" FROM "billing_events"
        WHERE "application_id" = ANY(${[applicationId]}::text[]) AND "type" = ${type}
        ORDER BY "application_id", "seq" LIMIT 1)`,
  );
  return Prisma.sql`SELECT min(first."recorded_at") FROM (${Prisma.join(probes, ' UNION ALL ')}) AS first`;
}
const FETCH = RECONCILIATION_MAX_FINDINGS + 1;

/**
 * The period a report over the log covers (reconciliation, the fallback
 * counts): the last seven days unless told otherwise, and never more than 31
 * days, which is what keeps one report's cost bounded.
 *
 * @example
 * reconciliationPeriod({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z' });
 */
export function reconciliationPeriod(
  query: { from?: string | undefined; to?: string | undefined },
  now: Date = new Date(),
): { from: Date; to: Date } {
  const to = query.to === undefined ? now : new Date(query.to);
  const from = query.from === undefined ? new Date(to.getTime() - RECONCILIATION_DEFAULT_DAYS * DAY_MS) : new Date(query.from);
  if (!(from < to) || to.getTime() - from.getTime() > RECONCILIATION_MAX_DAYS * DAY_MS) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_LOG_PERIOD_INVALID',
      message: `The period must end after it starts and cover at most ${RECONCILIATION_MAX_DAYS} days.`,
      fix: `Send \`from\` earlier than \`to\`, at most ${RECONCILIATION_MAX_DAYS} days apart, both ISO 8601. Omit both for the last ${RECONCILIATION_DEFAULT_DAYS} days. Cover a longer span one month at a time.`,
    });
  }
  return { from, to };
}

function reconciliationTimeout(): RekeyError {
  return new RekeyError({
    statusCode: 503,
    code: 'ANALYTICS_TIMEOUT',
    message: 'Reconciling this period took longer than the query budget allows.',
    fix: 'Retry with a shorter period: send `from` and `to` a day or a week apart.',
    retryAfterSeconds: 60,
  });
}

interface FindingRow {
  payment_id: string | null;
  subscription_id: string | null;
  event_seq: bigint | null;
  currency: string | null;
  amount: number | null;
  refunded_on_payment: number | null;
  refund_rows_total: bigint | null;
  refund_events_total: bigint | null;
  at: Date;
}

function toFinding(kind: ReconciliationFindingKind, row: FindingRow): ReconciliationFinding {
  return {
    kind,
    paymentId: row.payment_id,
    subscriptionId: row.subscription_id,
    eventSeq: row.event_seq === null ? null : row.event_seq.toString(),
    currency: row.currency === null ? null : row.currency.toUpperCase(),
    amount: row.amount,
    refundedOnPayment: row.refunded_on_payment,
    refundRowsTotal: row.refund_rows_total === null ? null : Number(row.refund_rows_total),
    refundEventsTotal: row.refund_events_total === null ? null : Number(row.refund_events_total),
    at: row.at.toISOString(),
  };
}

const NO_REFUND_TOTALS = Prisma.sql`NULL::int AS refunded_on_payment, NULL::bigint AS refund_rows_total, NULL::bigint AS refund_events_total`;

async function compare(db: Db, applicationId: string, from: Date, to: Date): Promise<ReconciliationReport> {
  const [floors] = await db.$queryRaw<Array<{ payments_since: Date | null; subscriptions_since: Date | null }>>(Prisma.sql`
    SELECT (${firstEventOf(applicationId, PAYMENT_EVENT_TYPES)}) AS payments_since,
           (${firstEventOf(applicationId, SUBSCRIPTION_EVENT_TYPES)}) AS subscriptions_since`);
  const paymentsSince = floors?.payments_since ?? null;
  const subscriptionsSince = floors?.subscriptions_since ?? null;
  const later = (floor: Date): Date => (floor > from ? floor : from);

  const [checked] = await db.$queryRaw<Array<{ payments: bigint; refunds: bigint; subscriptions: bigint; events: bigint }>>(Prisma.sql`
    SELECT (SELECT count(*) FROM "payments" WHERE "application_id" = ${applicationId} AND "created_at" >= ${from} AND "created_at" < ${to}) AS payments,
           (SELECT count(*) FROM "refunds" WHERE "application_id" = ${applicationId} AND "created_at" >= ${from} AND "created_at" < ${to}) AS refunds,
           (SELECT count(*) FROM "subscriptions" WHERE "application_id" = ${applicationId} AND "created_at" >= ${from} AND "created_at" < ${to}) AS subscriptions,
           (SELECT count(*) FROM "billing_events" WHERE "application_id" = ${applicationId} AND "occurred_at" >= ${from} AND "occurred_at" < ${to}) AS events`);

  const paymentsWithoutEvent =
    paymentsSince === null
      ? []
      : await db.$queryRaw<FindingRow[]>(Prisma.sql`
          SELECT p."id" AS payment_id, p."subscription_id", NULL::bigint AS event_seq, p."currency", p."amount",
                 ${NO_REFUND_TOTALS}, p."created_at" AS at
            FROM "payments" AS p
           WHERE p."application_id" = ${applicationId}
             AND p."created_at" >= ${later(paymentsSince)} AND p."created_at" < ${to}
             AND p."status" <> 'PENDING'
             AND NOT EXISTS (SELECT 1 FROM "billing_events" AS e
                              WHERE e."application_id" = p."application_id" AND e."payment_id" = p."id"
                                AND e."type" IN ${PAYMENT_EVENTS})
           ORDER BY p."created_at", p."id"
           LIMIT ${FETCH}`);

  const eventsWithoutPayment = await db.$queryRaw<FindingRow[]>(Prisma.sql`
    SELECT e."payment_id", e."subscription_id", e."seq" AS event_seq, e."currency", e."amount",
           ${NO_REFUND_TOTALS}, e."occurred_at" AS at
      FROM "billing_events" AS e
     WHERE e."application_id" = ${applicationId}
       AND e."occurred_at" >= ${from} AND e."occurred_at" < ${to}
       AND e."type" IN ('payment.recorded', 'payment.failed', 'payment.refunded')
       AND (CASE WHEN e."payment_id" IS NULL THEN e."type" = 'payment.recorded'
                 ELSE NOT EXISTS (SELECT 1 FROM "payments" AS p
                                   WHERE p."id" = e."payment_id" AND p."application_id" = e."application_id") END)
     ORDER BY e."occurred_at", e."seq"
     LIMIT ${FETCH}`);

  // A refund counts in a total only in the payment's own currency: a refund
  // row or event in another currency is itself a disagreement, and leaving it
  // out of the sum is what reports it.
  const refundMismatches =
    paymentsSince === null
      ? []
      : await db.$queryRaw<FindingRow[]>(Prisma.sql`
          WITH touched AS (
            SELECT "payment_id" FROM "refunds"
             WHERE "application_id" = ${applicationId} AND "created_at" >= ${from} AND "created_at" < ${to}
            UNION
            SELECT "payment_id" FROM "billing_events"
             WHERE "application_id" = ${applicationId} AND "type" = 'payment.refunded'
               AND "occurred_at" >= ${from} AND "occurred_at" < ${to} AND "payment_id" IS NOT NULL
          )
          SELECT * FROM (
            SELECT p."id" AS payment_id, p."subscription_id", NULL::bigint AS event_seq, p."currency", p."amount",
                   p."refunded_amount" AS refunded_on_payment,
                   coalesce((SELECT sum(r."amount") FROM "refunds" AS r
                              WHERE r."payment_id" = p."id" AND r."application_id" = p."application_id"
                                AND r."status" = 'SUCCEEDED' AND upper(r."currency") = upper(p."currency")), 0)::bigint AS refund_rows_total,
                   coalesce((SELECT sum((e."data" ->> 'refundedAmount')::bigint) FROM "billing_events" AS e
                              WHERE e."application_id" = p."application_id" AND e."payment_id" = p."id"
                                AND e."type" = 'payment.refunded' AND upper(e."currency") = upper(p."currency")), 0)::bigint AS refund_events_total,
                   p."created_at" AS at
              FROM "payments" AS p
              JOIN touched AS t ON t."payment_id" = p."id"
             WHERE p."application_id" = ${applicationId} AND p."created_at" >= ${paymentsSince}
          ) AS totals
           WHERE totals.refunded_on_payment <> totals.refund_rows_total
              OR totals.refund_rows_total <> totals.refund_events_total
           ORDER BY totals.at, totals.payment_id
           LIMIT ${FETCH}`);

  const subscriptionsWithoutEvent =
    subscriptionsSince === null
      ? []
      : await db.$queryRaw<FindingRow[]>(Prisma.sql`
          SELECT NULL::text AS payment_id, s."id" AS subscription_id, NULL::bigint AS event_seq, s."currency",
                 s."unit_amount" AS amount, ${NO_REFUND_TOTALS}, s."created_at" AS at
            FROM "subscriptions" AS s
           WHERE s."application_id" = ${applicationId}
             AND s."created_at" >= ${later(subscriptionsSince)} AND s."created_at" < ${to}
             AND s."status" <> 'PENDING'
             AND NOT EXISTS (SELECT 1 FROM "billing_events" AS e
                              WHERE e."application_id" = s."application_id" AND e."subscription_id" = s."id"
                                AND e."type" IN ${SUBSCRIPTION_EVENTS})
           ORDER BY s."created_at", s."id"
           LIMIT ${FETCH}`);

  const kinds: Array<[ReconciliationFindingKind, FindingRow[]]> = [
    ['payment_without_event', paymentsWithoutEvent],
    ['event_without_payment', eventsWithoutPayment],
    ['refund_mismatch', refundMismatches],
    ['subscription_without_event', subscriptionsWithoutEvent],
  ];
  const listed = (rows: FindingRow[]): FindingRow[] => rows.slice(0, RECONCILIATION_MAX_FINDINGS);
  return {
    applicationId,
    from: from.toISOString(),
    to: to.toISOString(),
    paymentsLoggedSince: paymentsSince?.toISOString() ?? null,
    subscriptionsLoggedSince: subscriptionsSince?.toISOString() ?? null,
    checked: {
      payments: Number(checked?.payments ?? 0),
      refunds: Number(checked?.refunds ?? 0),
      subscriptions: Number(checked?.subscriptions ?? 0),
      events: Number(checked?.events ?? 0),
    },
    counts: {
      payment_without_event: listed(paymentsWithoutEvent).length,
      event_without_payment: listed(eventsWithoutPayment).length,
      refund_mismatch: listed(refundMismatches).length,
      subscription_without_event: listed(subscriptionsWithoutEvent).length,
    },
    findings: kinds.flatMap(([kind, rows]) => listed(rows).map((row) => toFinding(kind, row))),
    truncated: kinds.some(([, rows]) => rows.length > RECONCILIATION_MAX_FINDINGS),
  };
}

/**
 * Compare one Application's log with its money rows for a period: six
 * queries, read-only, under a statement timeout, whatever the period holds.
 *
 * @example
 * const report = await reconcileApplication(applicationId, reconciliationPeriod({}));
 * report.counts.payment_without_event; // 0 when every payment of the week is in the log
 */
export async function reconcileApplication(
  applicationId: string,
  period: { from: Date; to: Date },
): Promise<ReconciliationReport> {
  return withReadOnlyBudget((tx) => compare(tx, applicationId, period.from, period.to), {
    onTimeout: reconciliationTimeout,
    statementTimeoutMs: 8_000,
  });
}

function findingKey(finding: ReconciliationFinding): string {
  if (finding.kind === 'event_without_payment') return `${finding.kind}:${finding.eventSeq}`;
  const subject = finding.paymentId ?? finding.subscriptionId ?? '';
  // A refund disagreement that changes is a new finding: the totals are part of what was found.
  if (finding.kind === 'refund_mismatch') {
    return `${finding.kind}:${subject}:${finding.refundedOnPayment}:${finding.refundRowsTotal}:${finding.refundEventsTotal}`;
  }
  return `${finding.kind}:${subject}`;
}

/**
 * Write a report's findings to the log as `reconciliation.finding` events,
 * each once however often it is found again. Returns how many were new.
 *
 * @example
 * const written = await recordReconciliationFindings(report, app.log);
 */
export async function recordReconciliationFindings(report: ReconciliationReport, log?: BillingLogLogger): Promise<number> {
  if (report.findings.length === 0) return 0;
  const keyed = report.findings.map((finding) => ({ finding, key: findingKey(finding) }));
  // Asked first, so a finding already in the log does not use up the hourly
  // bound on diagnostic events for one that is not.
  const known = new Set(
    (
      await prisma.billingEvent.findMany({
        where: {
          applicationId: report.applicationId,
          type: 'reconciliation.finding',
          dedupeKey: { in: keyed.map(({ key }) => key) },
        },
        select: { dedupeKey: true },
      })
    ).map((row) => row.dedupeKey),
  );
  let written = 0;
  for (const { finding, key } of keyed) {
    if (known.has(key)) continue;
    await recordDiagnosticBillingEvent(
      {
        type: 'reconciliation.finding',
        applicationId: report.applicationId,
        actor: { type: 'system' },
        dedupeKey: key,
        ...(finding.paymentId !== null && { paymentId: finding.paymentId }),
        ...(finding.subscriptionId !== null && { subscriptionId: finding.subscriptionId }),
        ...(finding.currency !== null && /^[A-Z]{3}$/.test(finding.currency) && { currency: finding.currency }),
        ...(finding.amount !== null && { amount: finding.amount }),
        data: {
          kind: finding.kind,
          refundedOnPayment: finding.refundedOnPayment,
          refundRowsTotal: finding.refundRowsTotal,
          refundEventsTotal: finding.refundEventsTotal,
        },
      },
      log,
    );
    written += 1;
  }
  return written;
}

const SWEEP_LOOKBACK_MS = 25 * 60 * 60 * 1000;
/** Events for a change applied after its commit reach the log through the outbox, a little later. */
const SWEEP_GRACE_MS = 10 * 60 * 1000;
const SWEEP_MAX_APPLICATIONS = 500;

/**
 * The scheduled run: reconcile every Application that took a payment or
 * logged a billing event in the last day, and log what is found.
 *
 * @example
 * const { applications, findings } = await reconcileRecentActivity(app.log);
 */
export async function reconcileRecentActivity(
  log?: BillingLogLogger,
  now: Date = new Date(),
): Promise<{ applications: number; findings: number }> {
  const from = new Date(now.getTime() - SWEEP_LOOKBACK_MS);
  const to = new Date(now.getTime() - SWEEP_GRACE_MS);
  // Both sides are read through an index on the time alone. An Application
  // whose only activity was a change that left neither a payment nor an event
  // is not swept; the operator's own report still covers it.
  const active = await prisma.$queryRaw<Array<{ application_id: string }>>(Prisma.sql`
    SELECT "application_id" FROM "payments" WHERE "created_at" >= ${from}
    UNION
    SELECT "application_id" FROM "billing_events" WHERE "tier" = 'PERMANENT' AND "recorded_at" >= ${from}
    LIMIT ${SWEEP_MAX_APPLICATIONS}`);
  let findings = 0;
  for (const { application_id: applicationId } of active) {
    try {
      findings += await recordReconciliationFindings(await reconcileApplication(applicationId, { from, to }), log);
    } catch (err) {
      log?.warn({ err, applicationId }, 'billing log: reconciliation of one Application failed; the next run tries again');
    }
  }
  return { applications: active.length, findings };
}
