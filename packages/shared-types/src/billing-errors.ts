/**
 * The error codes the billing money model raises, as a closed list an
 * integrator can switch on. No imports, so a browser bundle can take the type
 * without pulling in zod.
 *
 * The list covers prices, currencies, coupons, refunds, the billing log and
 * the reporting currency. `docs/errors.md` says what each one means and how to
 * fix it. A newer API can raise a code this list does not hold: match the
 * ones you handle and treat the rest by `statusCode`.
 */

export const BILLING_MONEY_ERROR_CODES = [
  // Removed fields and headers
  'BILLING_FIELD_REMOVED',
  // Price selection at checkout
  'BILLING_CURRENCY_NOT_ALLOWED',
  'BILLING_CURRENCY_CONFLICT',
  'BILLING_NO_PROVIDER_FOR_CURRENCY',
  'BILLING_PLAN_CURRENCY_UNAVAILABLE',
  'BILLING_PLAN_PRICE_NOT_FOUND',
  'BILLING_AMOUNT_NOT_CHARGEABLE',
  'BILLING_UNIT_AMOUNT_INVALID',
  'BILLING_SUBSCRIPTION_PRICE_UNSETTLED',
  // Plan prices
  'PLAN_PRICE_CURRENCY_INVALID',
  'PLAN_PRICE_CURRENCY_UNSUPPORTED',
  'PLAN_PRICE_AMOUNT_INVALID',
  'PLAN_PRICE_COUNTRY_INVALID',
  'PLAN_PRICE_IS_DEFAULT',
  'PLAN_PRICE_NOT_APPLICABLE',
  'PLAN_PRICE_NOT_FOUND',
  'PLAN_PRICE_IMMUTABLE',
  'PLAN_PRICE_IN_USE',
  'PLAN_PRICE_REFERENCED',
  // Provider currencies and the reporting currency
  'BILLING_PROVIDER_CURRENCY_NOT_OFFERED',
  'BILLING_REPORTING_CURRENCY_INVALID',
  // Coupons
  'COUPON_CURRENCY_NOT_COVERED',
  'COUPON_AMOUNTS_REQUIRED',
  'COUPON_AMOUNT_INVALID',
  'COUPON_CURRENCY_INVALID',
  'COUPON_DISCOUNT_SHAPE_INVALID',
  'COUPON_DISCOUNT_EXCEEDS_PRICE',
  'COUPON_FULL_DISCOUNT_UNSUPPORTED',
  'COUPON_LIMIT_BELOW_REDEEMED',
  // Refunds
  'PAYMENT_NOT_FOUND',
  'BILLING_PAYMENT_NOT_REFUNDABLE',
  'BILLING_PAYMENT_ALREADY_REFUNDED',
  'BILLING_REFUND_AMOUNT_EXCEEDED',
  'BILLING_REFUND_EXCEEDS_PAYMENT',
  'BILLING_REFUND_UNSUPPORTED',
  'BILLING_REFUND_REJECTED',
  // The billing log
  'BILLING_LOG_PERIOD_INVALID',
] as const;

/** One of {@link BILLING_MONEY_ERROR_CODES}. */
export type BillingMoneyErrorCode = (typeof BILLING_MONEY_ERROR_CODES)[number];

/**
 * Whether a caught value is an error carrying one of the money model's codes.
 * It reads `code` only, so it works on a `RekeyError` and on a parsed error
 * envelope alike.
 *
 * @example
 * ```ts
 * try {
 *   await rekey.billing.createCheckout(token, { planSlug: 'pro', currency: 'INR', onUnavailableCurrency: 'refuse', successUrl, cancelUrl });
 * } catch (err) {
 *   if (isBillingMoneyError(err) && err.code === 'BILLING_NO_PROVIDER_FOR_CURRENCY') showDefaultPrice();
 *   else throw err;
 * }
 * ```
 */
export function isBillingMoneyError(err: unknown): err is { code: BillingMoneyErrorCode; message: string } {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code: unknown }).code;
  return typeof code === 'string' && (BILLING_MONEY_ERROR_CODES as readonly string[]).includes(code);
}
