import type Stripe from 'stripe';

/** What Stripe's Refunds API accepts as the thing to refund. */
export type StripeRefundTarget = { payment_intent: string } | { charge: string };

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (typeof ref === 'string') return ref;
  return ref?.id ?? null;
}

/** What settled an invoice, split by whether Stripe can pay it back. */
export interface PaidInvoicePayments {
  /** Payments that moved through Stripe, as refund targets. */
  targets: StripeRefundTarget[];
  /** Paid payments recorded outside Stripe (out of band), which Stripe cannot refund. */
  outsideStripe: number;
}

/**
 * The paid payments behind an invoice.
 *
 * From `2025-03-31.basil` an Invoice no longer names its `payment_intent` or
 * `charge`; Invoice Payments link the two instead, and one invoice can have
 * several (partial payments, or payments recorded out of band).
 *
 * @example
 * const { targets, outsideStripe } = await paidInvoicePayments(stripe, 'in_123');
 * // targets: [{ payment_intent: 'pi_456' }], outsideStripe: 0
 */
export async function paidInvoicePayments(stripe: Stripe, invoiceId: string): Promise<PaidInvoicePayments> {
  const payments = await stripe.invoicePayments.list({ invoice: invoiceId, status: 'paid', limit: 10 });
  const targets: StripeRefundTarget[] = [];
  let outsideStripe = 0;
  for (const { payment } of payments.data) {
    const intent = payment.type === 'payment_intent' ? idOf(payment.payment_intent) : null;
    const charge = payment.type === 'charge' ? idOf(payment.charge) : null;
    if (intent) targets.push({ payment_intent: intent });
    else if (charge) targets.push({ charge });
    else outsideStripe += 1;
  }
  return { targets, outsideStripe };
}

/**
 * The one invoice a payment intent paid, or null when it paid none (a
 * one-time checkout) or more than one, where no single invoice is the answer.
 *
 * Charges lost their `invoice` field in `2025-03-31.basil`, so this is the
 * only way back from a refunded renewal charge to the invoice its payment was
 * recorded under.
 *
 * @example
 * await invoiceIdForPaymentIntent(stripe, 'pi_456'); // 'in_123'
 */
export async function invoiceIdForPaymentIntent(
  stripe: Stripe,
  paymentIntentId: string,
): Promise<string | null> {
  const payments = await stripe.invoicePayments.list({
    payment: { type: 'payment_intent', payment_intent: paymentIntentId },
    limit: 10,
  });
  const invoices = new Set(payments.data.map((p) => idOf(p.invoice)).filter((id) => id !== null));
  if (invoices.size !== 1) return null;
  return [...invoices][0] ?? null;
}
