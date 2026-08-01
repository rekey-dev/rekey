/**
 * Dunning — failed-payment recovery cases (roadmap §5 v1).
 *
 * What Rekey does vs what the PROVIDER does:
 *   - The provider owns the actual re-charging. Stripe Smart Retries keeps
 *     retrying the card on its own schedule (each retry lands here as another
 *     `invoice.payment_failed` / `invoice.paid`); PayPal retries a SUSPENDED
 *     subscription similarly. Rekey never re-charges a card itself.
 *   - Rekey owns the STATE MACHINE + NOTIFICATIONS: one `DunningCase` per
 *     PAST_DUE trip, reminder emails to the end-user (day 0/3/7, via the
 *     per-app email transport when one is configured), `dunning.*` outbound
 *     webhook events, and the day-14 exhaustion (cancel locally + best-effort
 *     provider-side cancel).
 *
 * Case lifecycle:
 *
 *   PAST_DUE transition ──> OPEN  (day-0 reminder; nextActionAt = +3d)
 *      OPEN ── scheduler day 3 ──> reminder #2 (nextActionAt = +7d)
 *      OPEN ── scheduler day 7 ──> reminder #3 (nextActionAt = +14d)
 *      OPEN ── scheduler day 14 ─> EXHAUSTED (subscription CANCELED locally +
 *                                  provider cancel attempted; emits
 *                                  subscription.canceled + dunning.case_exhausted)
 *      OPEN ── payment.succeeded / reactivation ──> RECOVERED
 *      OPEN ── subscription canceled (user/provider) ──> CANCELED (no event)
 *
 * Invariant: at most one OPEN case per subscription, enforced here via
 * find-then-create (inbound provider events are already deduped upstream by
 * the WebhookEvent table, so the residual race window is negligible for v1).
 *
 * Multi-replica safety: `processDueDunningCases` claims each due case with a
 * guarded `updateMany` that pushes `nextActionAt` forward (same pattern as
 * webhook.service's delivery claim) — two pollers can never double-process.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { DunningCase, Subscription } from '@prisma/client';
import { BillingConfigSchema } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { emailService } from '../email/email.service.js';
import { emitDunningEvent, emitSubscriptionEvent } from './webhooks/billing-events.js';

/** Reminder schedule, in days after `openedAt`. Reminder #1 is sent at open. */
export const DUNNING_REMINDER_OFFSETS_DAYS = [0, 3, 7] as const;
/** Days after `openedAt` with no recovery before the case exhausts. */
export const DUNNING_EXHAUST_AFTER_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
// How long a scheduler claim on a case lasts. A crash mid-processing leaves
// nextActionAt = claim time, so the next poll (10 min cadence) re-attempts.
const CLAIM_WINDOW_MS = 5 * 60 * 1000;

/** "999 USD-minor" → "9.99 USD" for the reminder template. Display-only. */
function formatAmount(amountMinor: number, currency: string): string {
  return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

/** nextActionAt for a case that has sent `remindersSent` reminders so far. */
function nextActionAfter(openedAt: Date, remindersSent: number): Date {
  const nextOffsetDays =
    remindersSent < DUNNING_REMINDER_OFFSETS_DAYS.length
      ? DUNNING_REMINDER_OFFSETS_DAYS[remindersSent]!
      : DUNNING_EXHAUST_AFTER_DAYS;
  return new Date(openedAt.getTime() + nextOffsetDays * DAY_MS);
}

/**
 * Send reminder #n for a case via the per-app email system. Best-effort and
 * fire-and-forget from the caller's perspective: no transport configured →
 * logged as `no_transport` (the schedule still advances — the case is the
 * source of truth, not the inbox). The outcome is appended to
 * `metadata.reminders` for operator forensics.
 */
async function sendReminder(dunningCaseId: string, attempt: number): Promise<void> {
  const dunningCase = await prisma.dunningCase.findUnique({
    where: { id: dunningCaseId },
    include: {
      application: true,
      subscription: { include: { plan: { select: { name: true, amount: true, currency: true } } } },
    },
  });
  if (!dunningCase) return;

  const endUser = dunningCase.endUserId
    ? await prisma.endUser.findUnique({
        where: { id: dunningCase.endUserId },
        select: { email: true },
      })
    : null;

  let outcomeKind = 'skipped_no_recipient';
  if (endUser?.email) {
    const outcome = await emailService.dispatch({
      application: dunningCase.application,
      eventKey: 'billing_payment_failed_reminder',
      to: endUser.email,
      variables: {
        userEmail: endUser.email,
        planName: dunningCase.subscription.plan.name,
        amountDue: formatAmount(
          dunningCase.subscription.plan.amount,
          dunningCase.subscription.plan.currency,
        ),
        attempt: String(attempt),
        graceEndsAtIso: new Date(
          dunningCase.openedAt.getTime() + DUNNING_EXHAUST_AFTER_DAYS * DAY_MS,
        ).toISOString(),
      },
    });
    outcomeKind = outcome.kind;
  }

  const meta = (dunningCase.metadata ?? {}) as Record<string, unknown>;
  const reminders = Array.isArray(meta.reminders) ? meta.reminders : [];
  reminders.push({ attempt, at: new Date().toISOString(), outcome: outcomeKind });
  await prisma.dunningCase
    .update({
      where: { id: dunningCaseId },
      data: { metadata: { ...meta, reminders } as never },
    })
    .catch(() => undefined);
}

/**
 * Open a case for a subscription that just went PAST_DUE — or, when one is
 * already OPEN (provider retry failed again while in dunning), bump its
 * failure counters instead. Idempotent per OPEN case.
 *
 * `countFailure: true` for an actual failed-payment event (Stripe
 * `invoice.payment_failed`, PayPal `PAYMENT.SALE.DENIED/REVERSED`); false for
 * pure status mirrors (`customer.subscription.updated` → past_due, PayPal
 * SUSPENDED) so a status echo of a failure we already counted doesn't
 * double-count.
 */
async function openForPastDue(args: {
  subscriptionId: string;
  countFailure: boolean;
  log?: FastifyBaseLogger;
}): Promise<DunningCase | null> {
  const now = new Date();
  const existing = await prisma.dunningCase.findFirst({
    where: { subscriptionId: args.subscriptionId, status: 'OPEN' },
  });
  if (existing) {
    if (args.countFailure) {
      await prisma.dunningCase.update({
        where: { id: existing.id },
        data: { failedAttempts: { increment: 1 }, lastFailureAt: now },
      });
    }
    return null;
  }

  const sub = await prisma.subscription.findUnique({ where: { id: args.subscriptionId } });
  if (!sub) return null;

  // Opt-in gate (case creation only). Dunning is OFF by default; the operator
  // turns it on per app via billingConfig.dunningEnabled. We gate here rather
  // than at the callers so EXISTING OPEN cases (the `existing` branch above and
  // processDueDunningCases) keep running — an in-flight recovery finishes even
  // if dunning is disabled afterward.
  const app = await prisma.application.findUnique({
    where: { id: sub.applicationId },
    select: { billingConfig: true },
  });
  const billingConfig = BillingConfigSchema.safeParse(app?.billingConfig);
  if (!billingConfig.success || !billingConfig.data.dunningEnabled) {
    args.log?.info(
      { subscriptionId: sub.id, applicationId: sub.applicationId },
      'dunning disabled for application — no case opened (subscription PAST_DUE)',
    );
    return null;
  }

  const created = await prisma.dunningCase.create({
    data: {
      applicationId: sub.applicationId,
      subscriptionId: sub.id,
      endUserId: sub.endUserId,
      organizationId: sub.beneficiaryOrgId,
      status: 'OPEN',
      failedAttempts: args.countFailure ? 1 : 0,
      lastFailureAt: args.countFailure ? now : null,
      openedAt: now,
      // Reminder #1 goes out right now; the scheduler owns day 3 onward.
      remindersSent: 1,
      nextActionAt: nextActionAfter(now, 1),
    },
  });

  emitDunningEvent('dunning.case_opened', created.id);
  // Day-0 reminder — off the inbound-webhook critical path.
  void sendReminder(created.id, 1).catch((err) =>
    args.log?.warn({ err, dunningCaseId: created.id }, 'dunning day-0 reminder failed'),
  );
  args.log?.info(
    { dunningCaseId: created.id, subscriptionId: sub.id },
    'dunning case opened (subscription PAST_DUE)',
  );
  return created;
}

/**
 * Close the subscription's OPEN case, if any. RECOVERED announces
 * `dunning.case_recovered`; CANCELED (subscription died while in dunning —
 * user cancel, provider cancel) closes silently.
 */
async function closeCase(
  subscriptionId: string,
  outcome: 'RECOVERED' | 'CANCELED',
): Promise<void> {
  const open = await prisma.dunningCase.findFirst({
    where: { subscriptionId, status: 'OPEN' },
    select: { id: true },
  });
  if (!open) return;
  // Guarded update — a concurrent closer/scheduler loses the race cleanly.
  const updated = await prisma.dunningCase.updateMany({
    where: { id: open.id, status: 'OPEN' },
    data: { status: outcome, closedAt: new Date(), nextActionAt: null },
  });
  if (updated.count === 1 && outcome === 'RECOVERED') {
    emitDunningEvent('dunning.case_recovered', open.id);
  }
}

/**
 * Day-14 exhaustion: cancel the subscription locally, attempt the
 * provider-side cancel where a provider subscription exists (same
 * `BillingProvider.cancelSubscription` path the portal cancel uses), close
 * the case EXHAUSTED, and announce both transitions.
 */
async function exhaustCase(dunningCaseId: string, log?: FastifyBaseLogger): Promise<void> {
  const dunningCase = await prisma.dunningCase.findUnique({
    where: { id: dunningCaseId },
    include: { subscription: true, application: true },
  });
  if (!dunningCase || dunningCase.status !== 'OPEN') return;
  const sub: Subscription = dunningCase.subscription;

  // Best-effort provider-side cancel. A provider error must not stop the
  // local exhaustion — the provider has already failed to collect for 14 days.
  if (sub.provider && sub.providerSubId) {
    try {
      const { getProviderForApplication } = await import('./providers/index.js');
      const provider = await getProviderForApplication(
        dunningCase.application,
        sub.provider as import('./credentials.service.js').BillingProviderName,
      );
      await provider.cancelSubscription({ subscription: sub, atPeriodEnd: false });
    } catch (err) {
      log?.warn(
        { err, subscriptionId: sub.id, provider: sub.provider },
        'dunning exhaustion: provider-side cancel failed (continuing with local cancel)',
      );
    }
  }

  const now = new Date();
  if (sub.status !== 'CANCELED') {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'CANCELED', canceledAt: now, cancelAt: now },
    });
    emitSubscriptionEvent('subscription.canceled', sub.id);
  }

  const updated = await prisma.dunningCase.updateMany({
    where: { id: dunningCaseId, status: 'OPEN' },
    data: { status: 'EXHAUSTED', closedAt: now, nextActionAt: null },
  });
  if (updated.count === 1) {
    emitDunningEvent('dunning.case_exhausted', dunningCaseId);
    log?.info(
      { dunningCaseId, subscriptionId: sub.id },
      'dunning case exhausted — subscription canceled',
    );
  }
}

/** Advance one claimed case: next reminder, or exhaustion past reminder #3. */
async function processCase(dunningCase: DunningCase, log?: FastifyBaseLogger): Promise<void> {
  if (dunningCase.remindersSent >= DUNNING_REMINDER_OFFSETS_DAYS.length) {
    await exhaustCase(dunningCase.id, log);
    return;
  }
  const attempt = dunningCase.remindersSent + 1;
  await prisma.dunningCase.update({
    where: { id: dunningCase.id },
    data: {
      remindersSent: attempt,
      nextActionAt: nextActionAfter(dunningCase.openedAt, attempt),
    },
  });
  await sendReminder(dunningCase.id, attempt);
}

/**
 * Process every OPEN case whose `nextActionAt` has passed. Registered as a
 * 10-minute interval in app.ts (webhook-poller pattern). Per-case atomic
 * claims (guarded updateMany pushing nextActionAt forward) make concurrent
 * pollers / replicas safe. Returns how many due cases were claimed.
 */
export async function processDueDunningCases(
  limit = 100,
  log?: FastifyBaseLogger,
): Promise<number> {
  const due = await prisma.dunningCase.findMany({
    where: { status: 'OPEN', nextActionAt: { lte: new Date() } },
    orderBy: { nextActionAt: 'asc' },
    take: limit,
  });
  let claimedCount = 0;
  for (const dunningCase of due) {
    // Atomic claim — mirrors webhook.service.attemptDelivery. The 1s tolerance
    // absorbs timer skew; a concurrent claimer's WHERE no longer matches.
    const claimed = await prisma.dunningCase.updateMany({
      where: {
        id: dunningCase.id,
        status: 'OPEN',
        nextActionAt: { lte: new Date(Date.now() + 1000) },
      },
      data: { nextActionAt: new Date(Date.now() + CLAIM_WINDOW_MS) },
    });
    if (claimed.count !== 1) continue;
    claimedCount += 1;
    try {
      await processCase(dunningCase, log);
    } catch (err) {
      log?.warn({ err, dunningCaseId: dunningCase.id }, 'dunning case processing failed');
    }
  }
  return claimedCount;
}

export const dunningService = {
  /**
   * Hook for an actual failed-payment provider event (Stripe
   * `invoice.payment_failed`, PayPal `PAYMENT.SALE.DENIED/REVERSED`): opens a
   * case, or bumps `failedAttempts` on the already-OPEN one.
   *
   * @example
   * await dunningService.recordPaymentFailure({ subscriptionId: sub.id, log });
   */
  async recordPaymentFailure(args: {
    subscriptionId: string;
    log?: FastifyBaseLogger;
  }): Promise<void> {
    await openForPastDue({
      subscriptionId: args.subscriptionId,
      countFailure: true,
      ...(args.log !== undefined && { log: args.log }),
    });
  },

  /**
   * Hook for a pure PAST_DUE status mirror (Stripe `customer.subscription.updated`,
   * PayPal `BILLING.SUBSCRIPTION.SUSPENDED`): ensures a case is open without
   * inflating the failure counter.
   *
   * @example
   * await dunningService.ensureCaseOpen({ subscriptionId: sub.id, log });
   */
  async ensureCaseOpen(args: { subscriptionId: string; log?: FastifyBaseLogger }): Promise<void> {
    await openForPastDue({
      subscriptionId: args.subscriptionId,
      countFailure: false,
      ...(args.log !== undefined && { log: args.log }),
    });
  },

  /**
   * A successful payment / reactivation arrived for the subscription — close
   * its OPEN case as RECOVERED (no-op when none is open).
   *
   * @example
   * await dunningService.recoverForSubscription(sub.id);
   */
  async recoverForSubscription(subscriptionId: string): Promise<void> {
    await closeCase(subscriptionId, 'RECOVERED');
  },

  /**
   * The subscription was canceled (user, operator, or provider) while in
   * dunning — close its OPEN case as CANCELED (no event; the accompanying
   * `subscription.canceled` already announced the cancellation).
   *
   * @example
   * await dunningService.closeForCanceledSubscription(sub.id);
   */
  async closeForCanceledSubscription(subscriptionId: string): Promise<void> {
    await closeCase(subscriptionId, 'CANCELED');
  },

  processDueDunningCases,
};
