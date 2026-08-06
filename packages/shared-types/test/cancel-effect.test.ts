/**
 * The two cancellation questions, kept apart.
 *
 * `cancelsAtPeriodEnd` was a prediction about an action not yet taken — "if I
 * cancel now, do they keep the rest of the period?" — with a name everyone
 * read as a state: "is this already ending?". It returns true for every
 * healthy ACTIVE subscriber, so the misreading hides the cancel control from
 * exactly the people who could use it, and labels a PAST_DUE subscriber's
 * button "cancel at period end" when their access stops on click.
 *
 * Three starter kits, two guides and two READMEs shipped with that misreading,
 * which is a strong argument that the name was the defect.
 */
import { describe, it, expect } from 'vitest';
import { cancelEffect, isCancelScheduled } from '../src/index.js';

const ACTIVE = { status: 'ACTIVE', currentPeriodEnd: '2026-09-03T00:00:00.000Z' };

describe('cancelEffect — what cancelling now would do', () => {
  it('is period-end for a healthy subscriber', () => {
    expect(cancelEffect(ACTIVE)).toBe('period-end');
  });

  it('is immediate when the subscription is not ACTIVE', () => {
    // PAST_DUE is the sharp one: entitled everywhere else, but a cancel ends
    // it on the spot with no refund for the remainder.
    expect(cancelEffect({ ...ACTIVE, status: 'PAST_DUE' })).toBe('immediate');
    expect(cancelEffect({ ...ACTIVE, status: 'PENDING' })).toBe('immediate');
  });

  it('is immediate with no known period end, since there is nothing to run out', () => {
    expect(cancelEffect({ ...ACTIVE, currentPeriodEnd: null })).toBe('immediate');
  });

  it('returns a value that cannot be mistaken for a state', () => {
    // The point of the rename: `if (cancelEffect(sub))` is always truthy, so
    // the old misuse does not silently compile into the wrong branch.
    const v: string = cancelEffect(ACTIVE);
    expect(['period-end', 'immediate']).toContain(v);
  });
});

describe('isCancelScheduled — whether it is already ending', () => {
  it('is false for a healthy subscriber nobody has cancelled', () => {
    expect(isCancelScheduled({ cancelAt: null })).toBe(false);
  });

  it('is true once a cancellation has been accepted', () => {
    expect(isCancelScheduled({ cancelAt: '2026-09-03T00:00:00.000Z' })).toBe(true);
  });

  it('answers differently from cancelEffect for the same subscriber', () => {
    // The whole bug in one assertion: a healthy ACTIVE subscription would
    // schedule a graceful cancel, and is not itself scheduled to end.
    const sub = { ...ACTIVE, cancelAt: null };
    expect(cancelEffect(sub)).toBe('period-end');
    expect(isCancelScheduled(sub)).toBe(false);
  });
});
