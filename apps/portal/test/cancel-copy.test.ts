/**
 * The portal's cancel confirmation must not promise a period end the API is
 * about to refuse.
 *
 * #338 fixed exactly this copy on the marketing site and left the portal — the
 * surface a merchant's own customers use — saying "your plan stays active until
 * the end of the current period" for every subscription, including the ones
 * cancelled on the spot with no refund.
 *
 * The PayPal shape is the one that mattered: no `currentPeriodEnd` for the
 * whole first period, which is where Rekey Cloud's live subscription sits.
 */

import { describe, expect, it } from 'vitest';
import { cancelCopy } from '../src/lib/cancel-copy';

/** Deterministic, so the assertions don't depend on the runner's locale. */
const fmt = (d: Date) => d.toISOString().slice(0, 10);

describe('cancelCopy', () => {
  const inTwentyDays = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);

  it('promises the period end only when the API will actually schedule one', () => {
    const copy = cancelCopy({ status: 'ACTIVE', currentPeriodEnd: inTwentyDays }, fmt);

    expect(copy.schedules).toBe(true);
    expect(copy.label).toBe('Cancel at period end');
    expect(copy.message).toContain(fmt(inTwentyDays));
    expect(copy.message).toContain('stays active until');
  });

  it('warns instead of promising when there is no period to run out (the PayPal first period)', () => {
    // The live Cloud subscription's shape. PayPal's activation carried no
    // period anchor, so `currentPeriodEnd` is null and the API cancels
    // immediately — while this dialog used to promise the opposite.
    const copy = cancelCopy({ status: 'ACTIVE', currentPeriodEnd: null }, fmt);

    expect(copy.schedules).toBe(false);
    expect(copy.message).toContain('straight away');
    expect(copy.message).not.toContain('stays active until');
    expect(copy.confirmLabel).toBe('Yes, cancel now');
  });

  it('warns for PAST_DUE, entitled though it is', () => {
    // The sharp one: PAST_DUE counts as entitled everywhere else, so copy that
    // keys off entitlement alone promises a period end that does not arrive.
    const copy = cancelCopy({ status: 'PAST_DUE', currentPeriodEnd: inTwentyDays }, fmt);

    expect(copy.schedules).toBe(false);
    expect(copy.message).toContain('straight away');
  });

  it('accepts the ISO strings the API actually returns over the wire', () => {
    const copy = cancelCopy({ status: 'ACTIVE', currentPeriodEnd: inTwentyDays.toISOString() }, fmt);

    expect(copy.schedules).toBe(true);
    expect(copy.message).toContain(fmt(inTwentyDays));
  });
});
