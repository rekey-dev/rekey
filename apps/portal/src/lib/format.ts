/**
 * Money rendering for the hosted portal — ONE formatter, used everywhere the
 * portal shows an amount to a merchant's paying customer.
 *
 * ## Why this file exists at all (the duplication is deliberate)
 *
 * `formatPrice` in `@rekey.dev/react` (`packages/sdk-react/src/pricing-shared.tsx`)
 * renders the same thing for the embeddable `<PricingTable>`. We cannot import
 * it: that module carries `'use client'`, and the portal renders plans from a
 * Server Component. Importing it would drag the whole widget runtime into the
 * server bundle (and, worse, silently turn the page into a client tree).
 *
 * So this is a copy, and the rule is: **the copy is the one that must not
 * drift.** A customer who sees `$9.00 one-time` here and `$9 · 500 credits` in
 * the operator's own embedded pricing table is looking at two prices for one
 * product. Every rule below is therefore stated as "what the SDK does", and the
 * portal's own test suite (`test/format.test.ts`) pins each shape.
 *
 * ## Where this INTENTIONALLY differs from the SDK today
 *
 * Zero-decimal currencies. The SDK divides every amount by 100 unconditionally,
 * so a ¥1000 plan renders as `¥10` — a 100× understatement shown to a paying
 * customer. JPY, KRW, VND and friends have no minor unit: the stored integer IS
 * the amount. This module consults {@link minorUnitDivisor} instead. The SDK
 * needs the identical change; until it lands, treat THIS file as the correct
 * one and the divergence as known rather than as drift.
 *
 * Everything else — the `Free` short-circuit, dropping `.00` on whole amounts,
 * the symbol table, the `/month` and `· N credits` suffixes, and the fact that a
 * non-SUBSCRIPTION plan gets NO cadence suffix — matches `formatPrice` exactly.
 */

/**
 * ISO 4217 currencies whose minor unit is the major unit (exponent 0). The
 * amount integer is already the price; dividing by 100 would understate it 100×.
 */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** ISO 4217 currencies with a thousandth minor unit (exponent 3). */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** Minor units per major unit for `currency` (100 for the overwhelming majority). */
export function minorUnitDivisor(currency: string): number {
  const code = currency?.toUpperCase() ?? '';
  if (ZERO_DECIMAL.has(code)) return 1;
  if (THREE_DECIMAL.has(code)) return 1000;
  return 100;
}

/**
 * Currency symbol. Same table as the SDK's private `currencySymbol`, including
 * the `"USD "`-style fallback for codes it doesn't know — matching the SDK
 * matters more than being clever, because both strings are read side by side.
 */
function currencySymbol(code: string): string {
  switch (code?.toUpperCase()) {
    case 'USD': return '$';
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'INR': return '₹';
    case 'JPY': return '¥';
    default: return `${code} `;
  }
}

/**
 * Render an integer amount in the smallest currency unit.
 *
 * Decimals are dropped when the amount is a whole major unit (`$9`, not
 * `$9.00`) and shown otherwise (`$9.99`) — the SDK's rule. Zero-decimal
 * currencies never show decimals because they have none.
 */
export function formatMoney(amount: number, currency: string): string {
  const divisor = minorUnitDivisor(currency);
  const digits = divisor === 1 ? 0 : divisor === 1000 ? 3 : 2;
  const whole = amount % divisor === 0;
  const major = (amount / divisor).toLocaleString(undefined, {
    minimumFractionDigits: whole ? 0 : digits,
    maximumFractionDigits: digits,
  });
  return `${currencySymbol(currency)}${major}`;
}

/** The subset of a plan this module reads. Mirrors the SDK's `PricingPlan`. */
export interface PricePlan {
  amount: number;
  currency: string;
  /** SUBSCRIPTION / LICENSE / USAGE / CREDIT. */
  kind?: string;
  /** Billing interval — only meaningful for SUBSCRIPTION plans. */
  interval?: string | null;
  /** Credits granted, for CREDIT-kind plans. */
  creditsAmount?: number | null;
}

/**
 * Price plus the one qualifier that applies, if any.
 *
 * `Plan.interval` defaults to MONTH server-side whatever the plan `kind` is, so
 * appending it unconditionally advertised a one-off licence as "$499.00/month",
 * in the plan list AND in the checkout confirmation. A customer was told they
 * were starting a subscription that does not exist. Hence: the cadence is
 * appended only for SUBSCRIPTION.
 *
 * The other three cases are the SDK's, and each was previously wrong here:
 *   - `amount === 0` → `Free`, not `$0.00/month`.
 *   - CREDIT with `creditsAmount` → `$9 · 500 credits`. Saying `$9 one-time` for
 *     a credit pack hides what the customer is actually buying.
 *   - anything else → the bare amount. No ` one-time` suffix: the SDK does not
 *     add one, and a perpetual licence is not a billing cadence.
 */
export function formatPlanPrice(plan: PricePlan): string {
  if (plan.amount === 0) return 'Free';
  const amount = formatMoney(plan.amount, plan.currency);
  if (plan.kind === 'SUBSCRIPTION' && plan.interval) {
    return `${amount} /${plan.interval.toLowerCase()}`;
  }
  if (plan.kind === 'CREDIT' && plan.creditsAmount) {
    return `${amount} · ${plan.creditsAmount} credits`;
  }
  return amount;
}
