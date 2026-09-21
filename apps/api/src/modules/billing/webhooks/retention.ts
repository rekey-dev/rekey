/**
 * Retention for inbound billing-webhook receipts.
 *
 * `webhook_events` holds one row per verified inbound event, full payload
 * included. The row does two jobs: it is the idempotency key that turns a
 * provider's retry into a no-op, and it is the operator's inbound log. Both
 * are short-lived needs. Stripe retries for three days, PayPal for a similar
 * window, and a sender of the external provider's events is told to retry
 * with backoff and give up; nobody re-presents a month-old event id.
 *
 * Nothing else prunes these. With hosted providers the growth is bounded by
 * how much a processor has to say; with an external billing system the sender
 * is arbitrary software posting bodies of up to a mebibyte under fresh ids,
 * and a table that only grows is a disk that only fills.
 *
 * Processed rows and failed rows alike are pruned past the window: a failed
 * dispatch that old is not going to be retried by anyone, and if it is, the
 * retry creates a fresh receipt and is applied on its own merits.
 */

import { prisma } from '../../../lib/prisma.js';

/** Bounded per sweep so a first run on a large backlog cannot hold locks for long. */
const BATCH = 5_000;

export async function pruneWebhookEvents(retentionDays: number): Promise<number> {
  // Zero days would delete every receipt, including the idempotency rows that
  // make a provider's retry a no-op. Unset retention means keep forever.
  if (!(retentionDays > 0)) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const stale = await prisma.webhookEvent.findMany({
    where: { receivedAt: { lt: cutoff } },
    select: { id: true },
    take: BATCH,
  });
  if (stale.length === 0) return 0;
  const { count } = await prisma.webhookEvent.deleteMany({
    where: { id: { in: stale.map((r) => r.id) } },
  });
  return count;
}
