/**
 * Calendar-aware billing-period advancement.
 *
 * Replaces the old fixed 365/30-day arithmetic, which drifted against the
 * provider's own anniversary billing: a monthly sub anchored on the 31st
 * slid earlier every short month, and yearly subs lost a day across leap
 * years. Providers (Stripe, PayPal) bill on calendar anniversaries, so we
 * advance the local period the same way: +1 month / +1 year preserving the
 * day-of-month, clamped to the last day of the target month
 * (Jan 31 + 1 month → Feb 28/29; Feb 29 + 1 year → Feb 28).
 */

/**
 * Advance `base` by one billing interval. `interval` follows `Plan.interval`
 * — 'YEAR' adds 12 months, anything else (incl. null/'MONTH') adds 1 month.
 * Time-of-day is preserved; the day-of-month is clamped to the target
 * month's length. All arithmetic is UTC.
 */
export function advanceBillingPeriod(base: Date, interval: string | null | undefined): Date {
  const monthsToAdd = interval === 'YEAR' ? 12 : 1;
  const year = base.getUTCFullYear();
  const targetMonth = base.getUTCMonth() + monthsToAdd;
  // Day 0 of month N+1 == last day of month N → length of the target month.
  const daysInTargetMonth = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      targetMonth,
      Math.min(base.getUTCDate(), daysInTargetMonth),
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds(),
    ),
  );
}
