/**
 * The coupon form's rules: what a typed discount is sent as, which
 * currencies a coupon covers, and which of the plans' currencies it leaves
 * out.
 *
 * A percentage is typed as a percentage (15, 12.5) and sent as basis points
 * (1500, 1250). A fixed coupon carries one amount per currency, each typed
 * the way that currency is written and sent in its smallest unit. Nothing is
 * converted between currencies: a currency with no amount is one the coupon
 * is refused in.
 */

import { formatMoney } from './format';
import { readTypedPrice } from './money-input';
import { notSoldReason } from './price-currencies';

export type DiscountType = 'PERCENT' | 'AMOUNT';

const PLAIN_PERCENT = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

/**
 * A typed percentage as basis points, or null when it is not between 0.01
 * and 100 with at most two decimals. The digits are shifted as text, so 12.5
 * is exactly 1250.
 *
 * @example
 * percentToBasisPoints('15');    // 1500
 * percentToBasisPoints('12.5');  // 1250
 * percentToBasisPoints('0.15');  // 15
 * percentToBasisPoints('1500');  // null: that is basis points, not a percentage
 */
export function percentToBasisPoints(raw: string): number | null {
  const match = PLAIN_PERCENT.exec(raw.trim());
  if (!match) return null;
  const basisPoints = Number((match[1] ?? '') + (match[2] ?? '').padEnd(2, '0'));
  return basisPoints >= 1 && basisPoints <= 10000 ? basisPoints : null;
}

/**
 * Basis points as the percentage an operator would type.
 *
 * @example
 * basisPointsToPercentText(1500); // '15'
 * basisPointsToPercentText(1250); // '12.5'
 */
export function basisPointsToPercentText(basisPoints: number): string {
  const digits = String(basisPoints).padStart(3, '0');
  const fraction = digits.slice(-2).replace(/0+$/, '');
  return fraction === '' ? digits.slice(0, -2) : `${digits.slice(0, -2)}.${fraction}`;
}

/** The parts of a coupon these rules read. Mirrors `CouponRow` in `api.ts`. */
export interface CouponTermsLike {
  discountType: DiscountType;
  basisPoints: number | null;
  amounts: ReadonlyArray<{ currency: string; amountOff: number }>;
  currencies: readonly string[];
  /** Every currency a checkout may use the coupon in. Null means any. */
  coveredCurrencies: readonly string[] | null;
  planSlugs: readonly string[];
}

/**
 * What a coupon takes off, as the coupons table writes it.
 *
 * @example
 * discountText({ discountType: 'PERCENT', basisPoints: 1250, ... }); // '12.5%'
 * discountText({ discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 500 }], ... }); // '$5.00'
 */
export function discountText(coupon: Pick<CouponTermsLike, 'discountType' | 'basisPoints' | 'amounts'>): string {
  if (coupon.discountType === 'PERCENT') return `${basisPointsToPercentText(coupon.basisPoints ?? 0)}%`;
  if (coupon.amounts.length === 0) return 'no amount';
  return coupon.amounts.map((amount) => formatMoney(amount.amountOff, amount.currency)).join(', ');
}

export interface PlanCurrencies {
  slug: string;
  active: boolean;
  /** Every currency the plan has a price in. Empty for a plan with no flat price. */
  currencies: readonly string[];
}

/**
 * The currencies the plans in a coupon's scope sell in: every active plan
 * when the coupon names none, the named plans otherwise. `first` leads (the
 * Application's reporting currency) when it is among them.
 *
 * @example
 * currenciesInScope(plans, ['pro'], 'USD'); // ['USD', 'INR']
 */
export function currenciesInScope(plans: readonly PlanCurrencies[], planSlugs: readonly string[], first?: string): string[] {
  const named = new Set(planSlugs.map((slug) => slug.toLowerCase()));
  const scoped = named.size === 0 ? plans.filter((plan) => plan.active) : plans.filter((plan) => named.has(plan.slug));
  const codes = [...new Set(scoped.flatMap((plan) => plan.currencies.map((code) => code.toUpperCase())))];
  const lead = first?.toUpperCase();
  return codes.sort((a, b) => Number(b === lead) - Number(a === lead) || a.localeCompare(b));
}

/**
 * The currencies in scope that a coupon does not cover: a buyer charged in
 * one of them is refused where they enter the code.
 *
 * @example
 * uncoveredCurrencies(['USD'], ['USD', 'INR']); // ['INR']
 * uncoveredCurrencies(null, ['USD', 'INR']);    // []: a null cover is any currency
 */
export function uncoveredCurrencies(covered: readonly string[] | null, inScope: readonly string[]): string[] {
  if (covered === null) return [];
  const set = new Set(covered.map((code) => code.toUpperCase()));
  return inScope.filter((code) => !set.has(code.toUpperCase()));
}

export interface Coverage {
  /** 'Any currency', or the covered codes. */
  label: string;
  /** Plan currencies the coupon is refused in. */
  refusedIn: string[];
}

/**
 * The Coverage cell of the coupons table.
 *
 * @example
 * coverageOf(coupon, plans, 'USD'); // { label: 'USD', refusedIn: ['INR'] }
 */
export function coverageOf(
  coupon: Pick<CouponTermsLike, 'coveredCurrencies' | 'planSlugs'>,
  plans: readonly PlanCurrencies[],
  first?: string,
): Coverage {
  const covered = coupon.coveredCurrencies;
  return {
    label: covered === null ? 'Any currency' : covered.length === 0 ? 'No currency' : covered.join(', '),
    refusedIn: uncoveredCurrencies(covered, currenciesInScope(plans, coupon.planSlugs, first)),
  };
}

export type CouponTermsBody =
  | { basisPoints: number; currencies: string[] }
  | { amounts: Array<{ currency: string; amountOff: number }> };

export type CouponTermsRead = { ok: true; terms: CouponTermsBody } | { ok: false; code: string };

function formStrings(formData: FormData, name: string): string[] {
  return formData.getAll(name).filter((value): value is string => typeof value === 'string');
}

/**
 * The discount fields of a submitted coupon form, as the API takes them.
 *
 * PERCENT reads `percent` and every ticked `currencies` box. AMOUNT reads one
 * `amount.<CUR>` field per currency offered and any `extraCurrency` /
 * `extraAmount` pair the operator added; an empty amount means the coupon
 * does not cover that currency.
 *
 * @example
 * readCouponTerms('AMOUNT', form({ 'amount.USD': '5', 'amount.JPY': '500' }));
 * // { ok: true, terms: { amounts: [{ currency: 'JPY', amountOff: 500 }, { currency: 'USD', amountOff: 500 }] } }
 */
export function readCouponTerms(discountType: DiscountType, formData: FormData): CouponTermsRead {
  if (discountType === 'PERCENT') {
    const basisPoints = percentToBasisPoints(String(formData.get('percent') ?? ''));
    if (basisPoints === null) return { ok: false, code: 'percent' };
    const currencies = [...new Set(formStrings(formData, 'currencies').map((code) => code.trim().toUpperCase()).filter(Boolean))];
    if (currencies.some((code) => notSoldReason(code) !== null)) return { ok: false, code: 'currency' };
    return { ok: true, terms: { basisPoints, currencies: currencies.sort() } };
  }

  const typed = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== 'string' || !name.startsWith('amount.')) continue;
    if (value.trim() !== '') typed.set(name.slice('amount.'.length).toUpperCase(), value);
  }
  const extraCurrencies = formStrings(formData, 'extraCurrency');
  const extraAmounts = formStrings(formData, 'extraAmount');
  for (const [index, rawCurrency] of extraCurrencies.entries()) {
    const currency = rawCurrency.trim().toUpperCase();
    const amount = (extraAmounts[index] ?? '').trim();
    if (currency === '' && amount === '') continue;
    if (currency === '' || amount === '') return { ok: false, code: 'amount' };
    if (typed.has(currency)) return { ok: false, code: 'duplicate' };
    typed.set(currency, amount);
  }
  if (typed.size === 0) return { ok: false, code: 'COUPON_AMOUNTS_REQUIRED' };

  const amounts: Array<{ currency: string; amountOff: number }> = [];
  for (const [currency, raw] of typed) {
    if (notSoldReason(currency) !== null) return { ok: false, code: 'currency' };
    const amount = readTypedPrice(raw, currency);
    if (!amount.ok) return { ok: false, code: 'amount' };
    amounts.push({ currency, amountOff: amount.minor });
  }
  return { ok: true, terms: { amounts: amounts.sort((a, b) => a.currency.localeCompare(b.currency)) } };
}

/** The plans a submitted coupon form is limited to: every ticked `planSlugs` box. */
export function readCouponPlans(formData: FormData): string[] {
  return [...new Set(formStrings(formData, 'planSlugs').map((slug) => slug.trim().toLowerCase()).filter(Boolean))];
}

/** A coupon's end date and caps, as the API's PATCH takes them: null removes one. */
export interface CouponLimitsBody {
  endsAt: string | null;
  maxRedemptions: number | null;
  maxRedemptionsPerUser: number | null;
}

export type CouponLimitsRead = { ok: true; limits: CouponLimitsBody } | { ok: false; code: 'endsAt' | 'limit' };

const INT4_MAX = 2_147_483_647;

function readCap(raw: string): number | null | undefined {
  if (raw === '') return null;
  if (!/^\d+$/.test(raw)) return undefined;
  const cap = Number(raw);
  return cap >= 1 && cap <= INT4_MAX ? cap : undefined;
}

/**
 * The end date and redemption caps of a submitted coupon form. An empty
 * field is null: no end, no cap. `endsAt` arrives as the instant the browser
 * worked out from what the operator typed in their own time zone.
 *
 * @example
 * readCouponLimits(form({ endsAt: '2026-12-31T23:59:00.000Z', maxRedemptions: '500', maxRedemptionsPerUser: '' }));
 * // { ok: true, limits: { endsAt: '2026-12-31T23:59:00.000Z', maxRedemptions: 500, maxRedemptionsPerUser: null } }
 */
export function readCouponLimits(formData: FormData): CouponLimitsRead {
  const field = (name: string): string => String(formData.get(name) ?? '').trim();
  const rawEnd = field('endsAt');
  const end = rawEnd === '' ? null : new Date(rawEnd);
  if (end !== null && Number.isNaN(end.getTime())) return { ok: false, code: 'endsAt' };
  const maxRedemptions = readCap(field('maxRedemptions'));
  const maxRedemptionsPerUser = readCap(field('maxRedemptionsPerUser'));
  if (maxRedemptions === undefined || maxRedemptionsPerUser === undefined) return { ok: false, code: 'limit' };
  return { ok: true, limits: { endsAt: end === null ? null : end.toISOString(), maxRedemptions, maxRedemptionsPerUser } };
}
