/**
 * Readers for the Stripe payload fields whose shape depends on the API
 * version the delivering webhook endpoint is pinned to.
 *
 * Rekey's client speaks `STRIPE_API_VERSION`, but an event is rendered in its
 * ENDPOINT's version. Endpoints an older Rekey registered are pinned to
 * `2024-11-20.acacia` and keep delivering that shape until the operator
 * re-registers them, so every reader here takes the basil-or-later field
 * first and falls back to the acacia one.
 */

import type Stripe from 'stripe';

type Ref = string | { id?: unknown } | null | undefined;

/** Fields `2025-03-31.basil` removed that acacia endpoints still deliver. */
interface AcaciaSubscription {
  current_period_end?: number | null;
}
interface AcaciaInvoice {
  subscription?: Ref;
  subscription_details?: { metadata?: unknown } | null;
}
interface AcaciaCharge {
  invoice?: Ref;
}

/** Fields that are present from basil on, read defensively for acacia bodies. */
interface BasilInvoice {
  parent?: { subscription_details?: { subscription?: Ref; metadata?: unknown } | null } | null;
}

function refId(ref: Ref): string | null {
  if (typeof ref === 'string') return ref.length > 0 ? ref : null;
  const id = ref?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Our `applicationId` from a metadata object, or null. Payload values are
 * runtime-checked: the interface types are casts over JSON, and a non-string
 * from a crafted body must resolve to "no id", never flow onward as an AppRef.
 */
export function applicationIdIn(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const id = (metadata as { applicationId?: unknown }).applicationId;
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : null;
}

/**
 * The `applicationId` an event object is scoped to.
 *
 * Checkout Sessions, Subscriptions and one-time Charges carry it on their own
 * `metadata`. A subscription's invoice need not: Stripe snapshots the
 * subscription's metadata onto `parent.subscription_details.metadata` (basil)
 * or `subscription_details.metadata` (acacia), so those are read after the
 * object's own.
 */
export function scopedApplicationId(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { metadata?: unknown } & AcaciaInvoice & BasilInvoice;
  return (
    applicationIdIn(o.metadata) ??
    applicationIdIn(o.parent?.subscription_details?.metadata) ??
    applicationIdIn(o.subscription_details?.metadata)
  );
}

/**
 * The subscription's current period end. Basil moved `current_period_end`
 * off the subscription onto each item; items share one period on the
 * subscriptions Rekey creates, so the first item's is the subscription's.
 */
export function periodEndOf(sub: Stripe.Subscription): Date | null {
  const onItem: unknown = sub.items?.data?.[0]?.current_period_end;
  const seconds = typeof onItem === 'number' ? onItem : (sub as AcaciaSubscription).current_period_end;
  return typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000) : null;
}

/**
 * The invoice's subscription id: `parent.subscription_details.subscription`
 * from basil on, `invoice.subscription` before it.
 */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const basil = invoice as BasilInvoice;
  const acacia = invoice as AcaciaInvoice;
  return refId(basil.parent?.subscription_details?.subscription) ?? refId(acacia.subscription);
}

/**
 * Which id a refunded charge's Payment row was recorded under, as far as the
 * charge alone can say.
 *
 * - acacia: the charge names its `invoice` (null for a one-time payment), so
 *   the answer is the invoice, else the payment intent, else the charge.
 * - basil on: the `invoice` field is gone. A charge with a payment intent may
 *   belong to an invoice only Stripe's Invoice Payments can name, so it is
 *   returned for lookup; without one there is nothing to look up by.
 */
export function chargePaymentRef(charge: Stripe.Charge): { recorded: string } | { lookupByIntent: string } {
  const intent = refId(charge.payment_intent);
  if ('invoice' in charge) {
    const invoice = refId((charge as AcaciaCharge).invoice);
    return { recorded: invoice ?? intent ?? charge.id };
  }
  if (intent) return { lookupByIntent: intent };
  return { recorded: charge.id };
}
