/**
 * Guard: an add-on typed into the plan form is never silently dropped.
 *
 * The Add-ons fieldset is a bundle builder. What the operator types lives in
 * local state until "+ Add add-on" pushes it into the list, and only that list
 * is serialised into the hidden `entitlements` field. So an operator who
 * filled the add-on fields and then pressed "Create plan" got a plan with no
 * entitlements at all and no warning. Measured on a production build: the plan
 * is created, and its entitlements read back as "No entitlements yet". A
 * reviewer hit the same thing and concluded the feature did not work.
 *
 * The form now refuses the submit and says which add-on is pending, rather
 * than adding the draft on the operator's behalf: adding it would put an
 * entitlement on a paid plan that nobody confirmed, and the fields are also
 * where an abandoned idea sits.
 *
 * `pendingAddOn` is the whole of the rule, so this is a unit test of it. The
 * `<form onSubmit>` wiring is checked separately below, because a correct rule
 * that nothing calls is the same defect.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pendingAddOn, type PendingAddOn } from '@/components/PlanCreateForm';
import { blankBlockComments } from './action-form.test';

const here = path.dirname(fileURLToPath(import.meta.url));
const form = path.join(here, '..', 'src', 'components', 'PlanCreateForm.tsx');

const empty: PendingAddOn = {
  kind: 'CREDIT',
  key: '',
  value: '',
  quantity: '',
  licenseKind: 'SEATS',
};

describe('an unadded add-on blocks the submit', () => {
  it('says nothing is pending when the fields are empty', () => {
    for (const kind of ['FEATURE', 'CREDIT', 'USAGE', 'LICENSE'] as const) {
      expect(pendingAddOn({ ...empty, kind }), `${kind} with empty fields`).toBeNull();
    }
  });

  it('catches a draft in each kind that has fields to lose', () => {
    expect(pendingAddOn({ ...empty, kind: 'CREDIT', quantity: '500' })).toBe('credit grant');
    expect(pendingAddOn({ ...empty, kind: 'FEATURE', key: 'seats' })).toBe('feature flag');
    expect(pendingAddOn({ ...empty, kind: 'FEATURE', value: 'true' })).toBe('feature flag');
    expect(pendingAddOn({ ...empty, kind: 'USAGE', key: 'api_calls' })).toBe('usage allowance');
    expect(pendingAddOn({ ...empty, kind: 'USAGE', quantity: '10000' })).toBe('usage allowance');
    expect(pendingAddOn({ ...empty, kind: 'LICENSE', quantity: '5' })).toBe('seat license');
  });

  it('ignores fields the chosen kind does not render', () => {
    // `key` and `quantity` are shared inputs and keep their contents when the
    // kind changes. A leftover from a half-built USAGE row must not make a
    // PERPETUAL license, which renders no inputs at all, look half-typed.
    expect(
      pendingAddOn({ ...empty, kind: 'LICENSE', licenseKind: 'PERPETUAL', quantity: '5', key: 'x' }),
    ).toBeNull();
    expect(pendingAddOn({ ...empty, kind: 'CREDIT', key: 'leftover' })).toBeNull();
    expect(pendingAddOn({ ...empty, kind: 'FEATURE', quantity: '5' })).toBeNull();
  });

  it('treats whitespace as empty', () => {
    expect(pendingAddOn({ ...empty, kind: 'USAGE', key: '   ' })).toBeNull();
  });

  it('is wired to the form, and refuses rather than discards', () => {
    const source = blankBlockComments(readFileSync(form, 'utf8'));
    expect(
      /<ActionForm[^>]*onSubmit=\{guardUnaddedAddOn\}/.test(source),
      'PlanCreateForm must run the guard on submit. ActionForm honours a handler that calls preventDefault, which is how the create is refused.',
    ).toBe(true);
    expect(
      /if \(pending\) event\.preventDefault\(\)/.test(source),
      'The guard must cancel the submit when something is pending. Warning and submitting anyway loses the add-on exactly as before.',
    ).toBe(true);
    expect(
      source.includes('has not been added to this plan yet'),
      'The operator has to be told which add-on is pending and that the plan was not created; a cancelled submit with no message is its own silent failure.',
    ).toBe(true);
  });
});
