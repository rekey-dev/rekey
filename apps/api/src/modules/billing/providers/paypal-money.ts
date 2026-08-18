/**
 * PayPal's wire scale for a currency.
 *
 * PayPal reports `amount.value` as a decimal string in the currency's own
 * units, and the module multiplied every one of them by 100. For a currency
 * with no minor unit that is a clean 100× — a ¥5000 sale arrives as "5000",
 * where 5000 already IS the smallest unit, and was recorded as ¥500,000
 * straight into the operator's revenue figures.
 *
 * The list is PayPal's, deliberately, and not ISO 4217. The two disagree, and
 * so do the providers with each other: ISO calls ISK zero-decimal while PayPal
 * accepts decimals for it, and Stripe treats HUF and TWD as two-decimal for
 * charges where PayPal refuses decimals on them outright. A single shared
 * table would therefore be wrong for somebody, which is why this one is scoped
 * to the module that talks to PayPal — the same shape as `capabilities`: a
 * provider that differs declares it, rather than core pretending it does not.
 *
 * Source: PayPal's currency-codes reference, "currencies that do not support
 * decimals".
 */
export const PAYPAL_NO_DECIMALS = new Set(['HUF', 'JPY', 'TWD']);

export function paypalScale(currency: string | undefined): number {
  return PAYPAL_NO_DECIMALS.has((currency ?? '').trim().toUpperCase()) ? 1 : 100;
}


/**
 * Format an integer minor-unit amount as the decimal string PayPal expects.
 *
 * The outbound half of the same problem. Plan registration and one-off orders
 * hardcoded `(amount / 100).toFixed(2)`, so a ¥5000 plan — where 5000 already
 * IS the amount, the yen having no minor unit — was registered at "50.00", a
 * hundredth of its price. And PayPal rejects decimals outright on exactly
 * these currencies, so those checkouts failed rather than merely undercharging.
 */
export function paypalMajorString(minor: number, currency: string | undefined): string {
  const scale = paypalScale(currency);
  return scale === 1 ? String(Math.round(minor)) : (minor / scale).toFixed(2);
}

/**
 * The exact inverse of `paypalMajorString`, for reading an amount back off a
 * PayPal API RESPONSE — today, the refund we just issued.
 *
 * Deliberately separate from the webhook path's `paypalAmountToMinor`, which
 * looks like it does the same arithmetic and does not do the same job. That
 * one gates an untrusted inbound payload: it takes a logger, refuses negative
 * and non-finite values, enforces `MAX_PAYMENT_AMOUNT`, and returns `null` so
 * the applier can drop the whole event. None of that fits here, where the
 * amount is PayPal echoing back a refund we asked for and the caller has a
 * sensible fallback of its own. Collapsing the two would mean either dragging
 * a logger and an event-dropping return type into the provider, or quietly
 * weakening the gate on the path that actually faces the internet.
 *
 * Returns `null` on anything unparseable rather than a wrong number.
 */
export function paypalMinorFromMajor(value: string, currency: string | undefined): number | null {
  const major = Number(value);
  if (!Number.isFinite(major) || major < 0) return null;
  return Math.round(major * paypalScale(currency));
}
