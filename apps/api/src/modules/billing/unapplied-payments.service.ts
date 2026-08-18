/**
 * Unapplied payments — money that reached a processor for something Rekey
 * never applied.
 *
 * The definition is exact: a `Payment` with `status = SUCCEEDED` and
 * `subscriptionId IS NULL`. The applier already records those rows ("money
 * that moved is a fact"), so the money has always been visible in the
 * database; what did not exist was anything that put it in front of an
 * operator, or let them act on it.
 *
 * This module opens the case and tells the operator. It never resolves one.
 * Refunding automatically would be wrong in the common case — most of these
 * buyers received the service they paid for through a path we lost track of,
 * and silently reversing the charge takes away something they are using. The
 * operator knows things Rekey does not, so the decision is theirs.
 */

import { prisma } from '../../lib/prisma.js';
import { emailService } from '../email/email.service.js';
import { RekeyError } from '../../lib/error.js';
import { getProviderForApplication } from './providers/index.js';
import { getModule } from './providers/registry.js';
import { entitlementsService } from './entitlements.service.js';
import type { BillingProviderName } from './credentials.service.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Find the end-user a stray provider subscription id belongs to.
 *
 * The charge matched no local subscription — that is what makes it unapplied —
 * but the checkout that produced it usually left a breadcrumb:
 * `recordUnappliedCompletion` stamps `{providerSubId, checkoutSessionId,
 * provider, at}` onto the Subscription row whose checkout it was. So the row
 * exists, it just is not linked to the payment.
 *
 * A JSONB containment scan, which is the thing #455 rightly did not want on a
 * hot path — but this runs once per unapplied payment, an event that is rare
 * by construction, and the alternative is showing the operator a sum of money
 * with no name attached to it. Attribution is the single most useful fact in
 * the queue: it is the difference between "someone paid you" and "this
 * customer paid you".
 *
 * Returns null rather than guessing. An unattributable payment is a worse case
 * than an attributed one and the operator needs to see that it is worse.
 */
async function attributeByProviderSubId(
  applicationId: string,
  providerSubscriptionId: string | null,
): Promise<string | null> {
  if (!providerSubscriptionId) return null;
  const rows = await prisma.$queryRaw<Array<{ end_user_id: string }>>`
    SELECT end_user_id FROM subscriptions
    WHERE application_id = ${applicationId}
      AND metadata -> 'unappliedCompletions' @> ${JSON.stringify([
        { providerSubId: providerSubscriptionId },
      ])}::jsonb
    LIMIT 2
  `;
  // Exactly one match or nothing. Two subscriptions claiming the same provider
  // id is a state we have no rule for, and picking one would attribute a
  // stranger's money to the wrong customer.
  return rows.length === 1 ? (rows[0]?.end_user_id ?? null) : null;
}

/**
 * Who hears about a new case.
 *
 * Workspace OWNERs, and ADMINs as a fallback when a workspace has no owner —
 * a state invitations can produce. Deliberately not every member: this mail
 * says "someone paid you and we do not know what for", which is an owner's
 * decision to make and not something to broadcast to every contractor holding
 * a scoped grant.
 */
async function operatorRecipients(applicationId: string): Promise<string[]> {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { tenantId: true, name: true },
  });
  if (!app) return [];
  const memberships = await prisma.tenantMembership.findMany({
    where: { tenantId: app.tenantId, role: { in: ['OWNER', 'ADMIN'] } },
    select: { role: true, tenantUser: { select: { email: true } } },
  });
  const owners = memberships.filter((m) => m.role === 'OWNER').map((m) => m.tenantUser.email);
  if (owners.length > 0) return owners;
  return memberships.map((m) => m.tenantUser.email);
}

/** Minor units to a human string, for the email only. */
function formatAmount(minor: number, currency: string): string {
  // Zero-decimal currencies would be shown 100x too small by a blind /100.
  // This list is the email's own and deliberately small: it is display text,
  // not money arithmetic, and the authoritative amount is the integer column.
  const zeroDecimal = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD']);
  const code = currency.toUpperCase();
  const major = zeroDecimal.has(code) ? String(minor) : (minor / 100).toFixed(2);
  return `${major} ${code}`;
}

/**
 * Open a case for a payment that matched no local subscription, and tell the
 * operator.
 *
 * Best-effort by construction, and called AFTER the payment transaction has
 * committed rather than inside it. The payment is the money record and must
 * never be rolled back because a queue row or an email failed — that would
 * turn "we could not send mail" into "the charge was never recorded", which
 * is precisely the orphaned money this feature exists to catch.
 */
export async function openUnappliedPaymentCase(
  input: {
    paymentId: string;
    applicationId: string;
    endUserId: string | null;
    provider: string;
    amount: number;
    currency: string;
    providerPaymentId: string | null;
    providerSubscriptionId: string | null;
  },
  log: FastifyBaseLogger,
): Promise<void> {
  const endUserId =
    input.endUserId ??
    (await attributeByProviderSubId(input.applicationId, input.providerSubscriptionId));
  try {
    await prisma.unappliedPayment.create({
      data: {
        applicationId: input.applicationId,
        paymentId: input.paymentId,
        endUserId,
        provider: input.provider,
        amount: input.amount,
        currency: input.currency,
      },
    });
    // Mirrored onto the Payment too, so the payments list and any per-user
    // view show the charge against the customer it belongs to rather than
    // stranding it. The applier could not do this — it had no match to work
    // from — but the breadcrumb scan above does.
    if (endUserId) {
      await prisma.payment.update({
        where: { id: input.paymentId },
        data: { endUserId },
      });
    }
  } catch (e) {
    // P2002 on the unique payment_id — a replayed webhook that reached here
    // twice. One case per payment is the intent, so this is the guard working.
    if ((e as { code?: string }).code === 'P2002') {
      log.info({ paymentId: input.paymentId }, 'unapplied payment: case already open');
      return;
    }
    log.error({ err: e, paymentId: input.paymentId }, 'unapplied payment: could not open case');
    return;
  }

  log.warn(
    {
      paymentId: input.paymentId,
      applicationId: input.applicationId,
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      providerSubscriptionId: input.providerSubscriptionId,
      amount: input.amount,
      currency: input.currency,
    },
    'unapplied payment: money received against no local subscription',
  );

  const recipients = await operatorRecipients(input.applicationId);
  if (recipients.length === 0) {
    log.error(
      { applicationId: input.applicationId },
      'unapplied payment: no operator to notify — case is open but unannounced',
    );
    return;
  }

  const endUser = endUserId
    ? await prisma.endUser.findUnique({
        where: { id: endUserId },
        select: { email: true },
      })
    : null;

  for (const to of recipients) {
    const outcome = await emailService.dispatchSystem({
      eventKey: 'billing_unapplied_payment',
      to,
      variables: {
        amount: formatAmount(input.amount, input.currency),
        provider: input.provider,
        // The operator has to find this payment in the provider's own
        // dashboard to check it, so the provider's id is the useful one.
        providerPaymentId: input.providerPaymentId ?? 'unknown',
        // "unknown" rather than blank: an unattributable payment is a
        // materially worse case than an attributable one and the operator
        // should see that, not an empty line they read past.
        endUserEmail: endUser?.email ?? 'unknown',
        receivedAtIso: new Date().toISOString(),
      },
    });
    if (outcome.kind !== 'sent') {
      log.error(
        { to, outcome: outcome.kind, paymentId: input.paymentId },
        'unapplied payment: operator notification not delivered',
      );
    }
  }
}

/** A case plus the payment facts an operator needs to decide about it. */
export interface UnappliedPaymentRow {
  id: string;
  paymentId: string;
  provider: string;
  amount: number;
  currency: string;
  refundedAmount: number;
  status: 'OPEN' | 'REFUNDED' | 'ENTITLEMENT_GRANTED' | 'DISMISSED';
  endUserId: string | null;
  endUserEmail: string | null;
  providerPaymentId: string | null;
  providerRefundId: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  openedAt: Date;
  /**
   * Whole days since the money arrived.
   *
   * Surfaced because an unresolved case does not stay neutral. Both scenarios
   * that produce one map to named card-network reason codes with 120-day
   * issuer filing windows (Visa 12.6.1 Duplicate Processing, 12.6.2 Paid by
   * Other Means), and refund windows close too — PayPal at 180 days, Razorpay
   * at six months. Age is the one column that tells an operator which case to
   * open first.
   */
  ageDays: number;
  /**
   * Whether this provider can refund at all, from its module's declaration.
   * The UI reads this to decide whether to offer the button, rather than
   * offering one that fails after the operator has promised a refund.
   */
  refundable: boolean;
}

function toRow(
  c: {
    id: string;
    paymentId: string;
    provider: string;
    amount: number;
    currency: string;
    status: string;
    endUserId: string | null;
    providerRefundId: string | null;
    resolutionNote: string | null;
    resolvedBy: string | null;
    resolvedAt: Date | null;
    openedAt: Date;
    payment: { providerPaymentId: string | null; refundedAmount: number };
  },
  endUserEmail: string | null,
): UnappliedPaymentRow {
  return {
    id: c.id,
    paymentId: c.paymentId,
    provider: c.provider,
    amount: c.amount,
    currency: c.currency,
    refundedAmount: c.payment.refundedAmount,
    status: c.status as UnappliedPaymentRow['status'],
    endUserId: c.endUserId,
    endUserEmail,
    providerPaymentId: c.payment.providerPaymentId,
    providerRefundId: c.providerRefundId,
    resolutionNote: c.resolutionNote,
    resolvedBy: c.resolvedBy,
    resolvedAt: c.resolvedAt,
    openedAt: c.openedAt,
    ageDays: Math.floor((Date.now() - c.openedAt.getTime()) / 86_400_000),
    refundable: Boolean(getModule(c.provider)?.capabilities.refunds),
  };
}

/**
 * Load a case and refuse anything an operator should not act on twice.
 *
 * Every mutating action goes through this. A case is resolved ONCE: paying
 * money back to a buyer who was already refunded, or granting a second helping
 * of entitlements, are both real damage and both are one double-click away
 * without this.
 */
async function loadOpenCase(applicationId: string, caseId: string) {
  const found = await prisma.unappliedPayment.findFirst({
    where: { id: caseId, applicationId },
    include: { payment: true },
  });
  if (!found) {
    throw new RekeyError({
      statusCode: 404,
      code: 'UNAPPLIED_PAYMENT_NOT_FOUND',
      message: 'No unapplied payment with that id in this application.',
      fix: 'Reload the list — the id may belong to another application, or the case may have been removed with its payment.',
    });
  }
  if (found.status !== 'OPEN') {
    throw new RekeyError({
      statusCode: 409,
      code: 'UNAPPLIED_PAYMENT_ALREADY_RESOLVED',
      message: `This payment was already resolved as ${found.status.toLowerCase().replace(/_/g, ' ')}.`,
      fix: 'Reload the list to see the current state. Resolving it again would refund or grant twice.',
    });
  }
  return found;
}

export const unappliedPaymentsService = {
  /** The queue: one application's cases, oldest first within a status. */
  async list(
    applicationId: string,
    opts: { status?: UnappliedPaymentRow['status']; limit: number; offset: number },
  ): Promise<{ items: UnappliedPaymentRow[]; total: number; limit: number; offset: number }> {
    const where = { applicationId, ...(opts.status && { status: opts.status }) };
    const [rows, total] = await Promise.all([
      prisma.unappliedPayment.findMany({
        where,
        include: { payment: true },
        // Oldest first, deliberately, and the opposite of every other list in
        // the panel. This is a worklist, not a feed: the case closest to
        // becoming a chargeback is the one to open, and it is the oldest.
        orderBy: { openedAt: 'asc' },
        take: opts.limit,
        skip: opts.offset,
      }),
      prisma.unappliedPayment.count({ where }),
    ]);
    const userIds = [...new Set(rows.map((r) => r.endUserId).filter((v): v is string => v !== null))];
    const users = userIds.length
      ? await prisma.endUser.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true },
        })
      : [];
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    return {
      items: rows.map((r) => toRow(r, r.endUserId ? emailById.get(r.endUserId) ?? null : null)),
      total,
      limit: opts.limit,
      offset: opts.offset,
    };
  },

  /**
   * Pay the money back, then record how it went.
   *
   * The refund is issued BEFORE the case is marked resolved, and the case is
   * only marked resolved if the provider accepted it. The other order would
   * produce the worst state this feature can reach: a case that says the buyer
   * was refunded when they were not, which nothing will ever revisit because
   * it has left the queue.
   */
  async refund(args: {
    applicationId: string;
    caseId: string;
    /** Minor units. Omit for a full refund of what remains. */
    amount?: number;
    note?: string;
    actorId: string;
  }): Promise<UnappliedPaymentRow> {
    const kase = await loadOpenCase(args.applicationId, args.caseId);
    const application = await prisma.application.findUniqueOrThrow({
      where: { id: args.applicationId },
    });

    if (!kase.payment.providerPaymentId) {
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_PAYMENT_NOT_REFUNDABLE',
        message: 'This payment has no provider charge id, so Rekey cannot ask anyone to refund it.',
        fix: 'Refund it in the provider dashboard directly, then dismiss this case with a note saying so.',
      });
    }
    const remaining = kase.payment.amount - kase.payment.refundedAmount;
    if (args.amount !== undefined && args.amount > remaining) {
      throw new RekeyError({
        statusCode: 400,
        code: 'BILLING_REFUND_AMOUNT_EXCEEDED',
        message: `Only ${remaining} ${kase.currency} (minor units) of this payment has not been refunded.`,
        fix: 'Lower the amount, or leave it blank to refund everything that remains.',
      });
    }

    const provider = await getProviderForApplication(
      application,
      kase.provider as BillingProviderName,
    );
    if (!provider.refundPayment) {
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_REFUND_UNSUPPORTED',
        message: `Rekey cannot issue refunds through ${kase.provider}.`,
        fix: 'Refund it in the provider dashboard directly, then dismiss this case with a note saying so.',
      });
    }

    const refundHref = (kase.payment.metadata as { refundHref?: string } | null)?.refundHref;
    const result = await provider.refundPayment({
      providerPaymentId: kase.payment.providerPaymentId,
      ...(args.amount !== undefined && { amount: args.amount }),
      currency: kase.currency,
      ...(args.note && { reason: args.note }),
      // Keyed on the CASE, not on the request. Two clicks on one case are the
      // same refund and must stay one at the provider; a genuinely separate
      // partial refund of the same payment would be a separate case.
      idempotencyKey: `rekey-unapplied-${kase.id}`,
      ...(refundHref && { refundHref }),
    });

    const refundedTotal = kase.payment.refundedAmount + result.amount;
    const [, updated] = await prisma.$transaction([
      prisma.payment.update({
        where: { id: kase.paymentId },
        data: {
          refundedAmount: refundedTotal,
          // A partial refund leaves the buyer holding part of the charge, and
          // saying REFUNDED there would be false to them and to the books.
          status: refundedTotal >= kase.payment.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        },
      }),
      prisma.unappliedPayment.update({
        where: { id: kase.id },
        data: {
          status: 'REFUNDED',
          providerRefundId: result.refundId,
          resolutionNote: args.note ?? null,
          resolvedBy: args.actorId,
          resolvedAt: new Date(),
          // The provider's own view of whether the money has actually moved.
          // Razorpay creates every refund pending and PayPal returns PENDING
          // for eCheck; the terminal answer arrives on a later webhook, so the
          // create-time answer is recorded rather than asserted as final.
          metadata: { refundStatusAtCreate: result.status },
        },
        include: { payment: true },
      }),
    ]);
    const endUser = updated.endUserId
      ? await prisma.endUser.findUnique({
          where: { id: updated.endUserId },
          select: { email: true },
        })
      : null;
    return toRow(updated, endUser?.email ?? null);
  },

  /**
   * Keep the money and give the customer time instead.
   *
   * The alternative to a refund, and the one with no precedent among billing
   * vendors — Stripe, Chargebee, Recurly and Zuora all credit MONEY. Crediting
   * service rather than money is also the cleaner outcome in the books: we
   * deliver what was paid for, so revenue recognises normally instead of
   * parking a liability.
   *
   * Extends the end-user's current period by `days` and re-provisions, so it
   * reuses the entitlement machinery rather than inventing a second way to
   * grant things.
   */
  async grantEntitlement(args: {
    applicationId: string;
    caseId: string;
    days: number;
    note?: string;
    actorId: string;
    log?: FastifyBaseLogger;
  }): Promise<UnappliedPaymentRow> {
    const kase = await loadOpenCase(args.applicationId, args.caseId);
    if (!kase.endUserId) {
      throw new RekeyError({
        statusCode: 409,
        code: 'UNAPPLIED_PAYMENT_UNATTRIBUTED',
        message: 'Rekey could not work out which customer this payment came from, so it cannot extend anyone.',
        fix: 'Find the payer in the provider dashboard using the charge id, then either refund them there and dismiss this case, or extend their subscription from their end-user page.',
      });
    }
    // The most recent subscription is the one the buyer is actually using;
    // an older cancelled row would extend something they walked away from.
    const sub = await prisma.subscription.findFirst({
      where: { applicationId: args.applicationId, endUserId: kase.endUserId },
      orderBy: { createdAt: 'desc' },
    });
    if (!sub) {
      throw new RekeyError({
        statusCode: 409,
        code: 'UNAPPLIED_PAYMENT_NO_SUBSCRIPTION',
        message: 'That customer has no subscription to extend.',
        fix: 'Refund the payment instead, or create a subscription for them first and then extend it.',
      });
    }

    // Extended from whichever is later: a period that already lapsed would
    // otherwise give the buyer days that are already in the past.
    const base =
      sub.currentPeriodEnd && sub.currentPeriodEnd > new Date() ? sub.currentPeriodEnd : new Date();
    const extendedTo = new Date(base.getTime() + args.days * 86_400_000);
    const updatedSub = await prisma.subscription.update({
      where: { id: sub.id },
      data: { currentPeriodEnd: extendedTo },
    });
    await entitlementsService.provision({
      subscription: updatedSub,
      ...(args.log && { log: args.log }),
    });

    const updated = await prisma.unappliedPayment.update({
      where: { id: kase.id },
      data: {
        status: 'ENTITLEMENT_GRANTED',
        resolutionNote: args.note ?? null,
        resolvedBy: args.actorId,
        resolvedAt: new Date(),
        metadata: {
          grantedDays: args.days,
          subscriptionId: sub.id,
          extendedTo: extendedTo.toISOString(),
        },
      },
      include: { payment: true },
    });
    const endUser = await prisma.endUser.findUnique({
      where: { id: kase.endUserId },
      select: { email: true },
    });
    return toRow(updated, endUser?.email ?? null);
  },

  /**
   * Close a case without moving money or granting anything.
   *
   * For the cases Rekey cannot see the resolution of: the operator refunded it
   * in the provider dashboard, or settled with the buyer some other way. The
   * note is REQUIRED here, unlike the other two actions, because dismissal is
   * the only disposition that leaves no other evidence of what happened to the
   * money.
   */
  async dismiss(args: {
    applicationId: string;
    caseId: string;
    note: string;
    actorId: string;
  }): Promise<UnappliedPaymentRow> {
    const kase = await loadOpenCase(args.applicationId, args.caseId);
    const updated = await prisma.unappliedPayment.update({
      where: { id: kase.id },
      data: {
        status: 'DISMISSED',
        resolutionNote: args.note,
        resolvedBy: args.actorId,
        resolvedAt: new Date(),
      },
      include: { payment: true },
    });
    const endUser = updated.endUserId
      ? await prisma.endUser.findUnique({
          where: { id: updated.endUserId },
          select: { email: true },
        })
      : null;
    return toRow(updated, endUser?.email ?? null);
  },
};
