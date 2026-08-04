/**
 * How the harness names the things it creates, across every provider.
 *
 * A sandbox account is shared — with the operator's own manual experiments,
 * with other contributors, with every previous run of this suite. So nothing
 * is created without the harness prefix on it, and nothing without that prefix
 * is ever deleted. That rule is the whole basis on which cleanup is allowed to
 * remove anything at all, which is why the prefix lives in one provider-neutral
 * module rather than inside whichever provider's helper file came first.
 */

import { randomBytes } from 'node:crypto';

/** Prefix on every name / slug / email / coupon code the harness creates. */
export const HARNESS_PREFIX = 'rekey-harness';

/** Metadata marker, for providers that take arbitrary metadata. */
export const HARNESS_METADATA = { rekeyHarness: '1' } as const;

/**
 * A short id unique to this run, embedded in every name.
 *
 * Time-ordered, so an entry sweep can tell a leftover from a run happening
 * concurrently on someone else's machine against the same sandbox.
 */
export function newRunId(): string {
  return `${HARNESS_PREFIX}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}
