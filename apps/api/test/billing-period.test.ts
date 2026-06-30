/**
 * Calendar-aware billing-period advancement unit tests (no DB).
 *
 * The old fixed 365/30-day arithmetic drifted against provider anniversary
 * billing; advanceBillingPeriod adds true calendar months/years with
 * day-of-month clamping.
 */

import { describe, expect, it } from 'vitest';
import { advanceBillingPeriod } from '../src/modules/billing/webhooks/period.js';

const utc = (s: string): Date => new Date(s);

describe('advanceBillingPeriod', () => {
  it('adds one calendar month preserving day-of-month and time', () => {
    expect(advanceBillingPeriod(utc('2026-06-10T12:34:56.789Z'), 'MONTH')).toEqual(
      utc('2026-07-10T12:34:56.789Z'),
    );
  });

  it('clamps Jan 31 + 1 month to Feb 28 in a non-leap year', () => {
    expect(advanceBillingPeriod(utc('2026-01-31T00:00:00Z'), 'MONTH')).toEqual(
      utc('2026-02-28T00:00:00Z'),
    );
  });

  it('clamps Jan 31 + 1 month to Feb 29 in a leap year', () => {
    expect(advanceBillingPeriod(utc('2028-01-31T00:00:00Z'), 'MONTH')).toEqual(
      utc('2028-02-29T00:00:00Z'),
    );
  });

  it('clamps the 31st into 30-day months', () => {
    expect(advanceBillingPeriod(utc('2026-10-31T08:00:00Z'), 'MONTH')).toEqual(
      utc('2026-11-30T08:00:00Z'),
    );
  });

  it('rolls December into January of the next year', () => {
    expect(advanceBillingPeriod(utc('2026-12-15T23:59:59Z'), 'MONTH')).toEqual(
      utc('2027-01-15T23:59:59Z'),
    );
  });

  it('adds one calendar year for YEAR plans', () => {
    expect(advanceBillingPeriod(utc('2026-06-10T00:00:00Z'), 'YEAR')).toEqual(
      utc('2027-06-10T00:00:00Z'),
    );
  });

  it('clamps Feb 29 + 1 year to Feb 28', () => {
    expect(advanceBillingPeriod(utc('2028-02-29T00:00:00Z'), 'YEAR')).toEqual(
      utc('2029-02-28T00:00:00Z'),
    );
  });

  it('treats a missing/unknown interval as monthly (the plan row may be absent)', () => {
    expect(advanceBillingPeriod(utc('2026-06-10T00:00:00Z'), null)).toEqual(
      utc('2026-07-10T00:00:00Z'),
    );
    expect(advanceBillingPeriod(utc('2026-06-10T00:00:00Z'), undefined)).toEqual(
      utc('2026-07-10T00:00:00Z'),
    );
  });
});
