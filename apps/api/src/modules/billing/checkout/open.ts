/**
 * Opens a checkout and leaves its trail in the billing log: `checkout.opened`
 * with the price shown and the price charged, or `checkout.refused` with the
 * refusal's code.
 *
 * Both are diagnostic events: anybody holding a publishable key can cause
 * them. An opened checkout is bounded by the checkout creation limit. A
 * refusal is written at most once per end user, plan, code and hour, so a
 * client retrying in a loop adds one row an hour and not one a request.
 */

import { RekeyError } from '../../../lib/error.js';
import { recordDiagnosticBillingEvent } from '../../billing-log/index.js';
import { createCheckoutSession } from '../checkout-create.js';

type OpenCheckoutInput = Parameters<typeof createCheckoutSession>[0];
type OpenedCheckout = Awaited<ReturnType<typeof createCheckoutSession>>;

const HOUR_MS = 60 * 60 * 1000;

function buyerCountryOf(input: OpenCheckoutInput): {
  buyerCountry: string | null;
  buyerCountrySource: 'declared' | 'vouched' | 'hint' | null;
} {
  const country = input.country?.toUpperCase();
  if (country === undefined || !/^[A-Z]{2}$/.test(country)) return { buyerCountry: null, buyerCountrySource: null };
  return { buyerCountry: country, buyerCountrySource: input.countrySource ?? null };
}

function currencyOrNull(value: string | undefined): string | null {
  const code = value?.toUpperCase();
  return code !== undefined && /^[A-Z]{3}$/.test(code) ? code : null;
}

async function logOpened(input: OpenCheckoutInput, opened: OpenedCheckout): Promise<void> {
  const price = opened.price;
  // A plan with no flat price charges nothing a price could describe.
  if (price === null) return;
  const charged = { planPriceId: price.planPriceId, currency: price.currency.toUpperCase(), amount: price.amount };
  const shown =
    price.fallback === null
      ? charged
      : {
          planPriceId: price.fallback.requested.planPriceId,
          currency: price.fallback.requested.currency.toUpperCase(),
          amount: price.fallback.requested.amount,
        };
  await recordDiagnosticBillingEvent({
    type: 'checkout.opened',
    applicationId: input.application.id,
    dedupeKey: `checkout.opened:${opened.checkoutSessionId}`,
    actor: { type: 'end_user', id: input.endUser.id },
    endUserId: input.endUser.id,
    subscriptionId: opened.subscription.id,
    checkoutSessionId: opened.checkoutSessionId,
    planId: opened.subscription.planId,
    ...(price.planPriceId !== null && { planPriceId: price.planPriceId }),
    provider: opened.provider,
    currency: charged.currency,
    amount: Math.max(0, price.amount - opened.discountAmount),
    data: {
      planSlug: input.planSlug,
      priceShown: shown,
      priceCharged: charged,
      reason: price.reason,
      discountAmount: opened.discountAmount,
      ...buyerCountryOf(input),
    },
  });
}

async function logRefused(input: OpenCheckoutInput, error: RekeyError): Promise<void> {
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(error.code)) return;
  const hour = Math.floor(Date.now() / HOUR_MS);
  await recordDiagnosticBillingEvent({
    type: 'checkout.refused',
    applicationId: input.application.id,
    dedupeKey: `checkout.refused:${input.endUser.id}:${input.planSlug}:${error.code}:${hour}`.slice(0, 255),
    actor: { type: 'end_user', id: input.endUser.id },
    endUserId: input.endUser.id,
    data: {
      planSlug: input.planSlug.slice(0, 200) || null,
      code: error.code,
      requestedCurrency: currencyOrNull(input.currency),
      ...buyerCountryOf(input),
    },
  });
}

/**
 * @example
 * const { url, price, priceFallback } = await openCheckout({ application, endUser, planSlug: 'pro', successUrl, cancelUrl });
 */
export async function openCheckout(input: OpenCheckoutInput): Promise<OpenedCheckout> {
  let opened: OpenedCheckout;
  try {
    opened = await createCheckoutSession(input);
  } catch (err) {
    if (err instanceof RekeyError) await logRefused(input, err);
    throw err;
  }
  await logOpened(input, opened);
  return opened;
}
