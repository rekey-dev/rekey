/**
 * PayPal Orders v2, the one-time purchase flow: create an order, read it
 * back, capture it. Each call takes the credential set's REST base and a
 * fresh access token, so a sandbox order never reaches the live API.
 */

import { randomUUID } from 'node:crypto';
import type { CheckoutSessionInput, ProviderOrderSnapshot } from './types.js';
import { paypalFetch, paypalError } from './paypal-http.js';
import { paypalMajorString, paypalMinorFromMajor } from './paypal-money.js';

/** A REST base and a bearer token for it. */
export interface PaypalApi {
  base: string;
  token: string;
}

export interface CreatedPaypalOrder {
  id: string;
  approveUrl: string;
  /** Upper-case ISO 4217: the code the order was created in, and the one the page's script must load. */
  currency: string;
}

/**
 * One-time purchase via Orders v2 (intent CAPTURE). Returns the approve
 * link; the buyer approves, then the order is captured (see `captureOneTime`,
 * driven by the `CHECKOUT.ORDER.APPROVED` webhook). `custom_id` carries
 * `${appId}:${euId}`; the local row is matched by order id.
 *
 * A coupon becomes a real discount line rather than a quietly smaller
 * number: Orders v2 takes `amount.breakdown.discount`, and PayPal renders it
 * on the approval page and the buyer's receipt. The breakdown must add up,
 * `item_total - discount === amount.value`, or PayPal rejects the order.
 */
export async function createPaypalOrder(
  api: PaypalApi,
  input: CheckoutSessionInput,
  returnUrl: string,
  cancelUrl: string,
): Promise<CreatedPaypalOrder> {
  const requestId = `REKEY-ORDER-${randomUUID()}`;
  const currency = input.plan.currency.toUpperCase();
  const discountMinor = input.discount?.amount ?? 0;
  // Scaled by what PayPal accepts for THIS currency. These three used to
  // hardcode `/ 100` and `.toFixed(2)`, so a plan in a currency PayPal takes
  // no decimals on was both priced at a hundredth of its value and rejected
  // outright for carrying a decimal point.
  const grossMajor = paypalMajorString(input.plan.amount, input.plan.currency);
  const discountMajor = paypalMajorString(discountMinor, input.plan.currency);
  const valueMajor = paypalMajorString(input.plan.amount - discountMinor, input.plan.currency);
  // PayPal has no free-form metadata on a purchase unit, so the code goes
  // where the buyer and the operator will both see it.
  const description = (
    input.discount ? `${input.plan.name} (coupon ${input.discount.code})` : input.plan.name
  ).slice(0, 127);
  const res = await paypalFetch(`${api.base}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${api.token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          custom_id: `${input.application.id}:${input.endUser.id}`,
          description,
          amount: {
            currency_code: currency,
            value: valueMajor,
            ...(input.discount && {
              breakdown: {
                item_total: { currency_code: currency, value: grossMajor },
                discount: { currency_code: currency, value: discountMajor },
              },
            }),
          },
          ...(input.discount && {
            items: [
              {
                name: input.plan.name.slice(0, 127),
                quantity: '1',
                unit_amount: { currency_code: currency, value: grossMajor },
              },
            ],
          }),
        },
      ],
      application_context: {
        return_url: returnUrl,
        cancel_url: cancelUrl,
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('paypal order failed', res.status, body);
    throw paypalError('order', res.status, body);
  }
  const order = (await res.json()) as { id: string; links: Array<{ rel: string; href: string }> };
  const approve = order.links.find((l) => l.rel === 'approve' || l.rel === 'payer-action');
  if (!approve) throw new Error('PayPal order response missing approve link');
  return { id: order.id, approveUrl: approve.href, currency };
}

/**
 * PayPal's own record of one Orders v2 order, from this credential set's
 * REST base. Rekey creates every order with exactly one purchase unit, so a
 * record with any other shape reads as having no custom id and no amount.
 */
export async function readPaypalOrder(api: PaypalApi, providerOrderId: string): Promise<ProviderOrderSnapshot | null> {
  const res = await paypalFetch(`${api.base}/v2/checkout/orders/${encodeURIComponent(providerOrderId)}`, {
    headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    console.error('paypal order read failed', res.status, body);
    throw paypalError('order read', res.status, body);
  }
  const order = (await res.json()) as {
    id?: unknown;
    status?: unknown;
    purchase_units?: Array<{ custom_id?: unknown; amount?: { value?: unknown; currency_code?: unknown } }>;
  };
  const unit = order.purchase_units?.length === 1 ? order.purchase_units[0] : undefined;
  const currency = typeof unit?.amount?.currency_code === 'string' ? unit.amount.currency_code.toUpperCase() : null;
  const value = unit?.amount?.value;
  const amount = currency !== null && typeof value === 'string' ? paypalMinorFromMajor(value, currency) : null;
  return {
    id: typeof order.id === 'string' ? order.id : '',
    status: typeof order.status === 'string' ? order.status : '',
    customId: typeof unit?.custom_id === 'string' ? unit.custom_id : null,
    amount,
    currency: amount === null ? null : currency,
  };
}

/**
 * The idempotency key for capturing one order. PayPal replays the first
 * result for a repeated `PayPal-Request-Id`, so concurrent or retried webhook
 * deliveries of the same approval capture the order once.
 *
 * @example
 * captureRequestId('5O190127TN364715T'); // 'REKEY-CAPTURE-5O190127TN364715T'
 */
export function captureRequestId(orderId: string): string {
  return `REKEY-CAPTURE-${orderId}`;
}

/**
 * Capture an approved one-time order. Idempotent twice over: every attempt
 * carries the same `PayPal-Request-Id`, and an already-captured order (HTTP
 * 422 ORDER_ALREADY_CAPTURED) counts as success, so a retried delivery after
 * a failure further down still reaches fulfilment.
 */
export async function capturePaypalOrder(api: PaypalApi, orderId: string): Promise<{ captured: boolean }> {
  const res = await paypalFetch(`${api.base}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${api.token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': captureRequestId(orderId),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 422 && text.includes('ORDER_ALREADY_CAPTURED')) return { captured: true };
    console.error('paypal capture failed', res.status, text);
    throw paypalError('capture', res.status, text);
  }
  const data = (await res.json()) as { status?: string };
  return { captured: data.status === 'COMPLETED' };
}
