/**
 * Is this plan bought once, or rented?
 *
 * A credit pack and a perpetual licence buy a THING; they have no renewal date
 * and no period to anchor anything to. A subscription, a usage plan and a timed
 * licence all hold a term.
 *
 * Lives here because three call sites need the same answer and two of them had
 * already written it out by hand, `createCheckoutSession`, to choose between
 * the recurring and one-time provider flows, and `grant.service`, whose
 * docblock says the two "cannot drift on what recurring means" while nothing
 * stopped them. `provision` is the third, and the drift it would have caused is
 * a buyer charged twice and credited once.
 */
export function isOneTimePlan(plan: { kind: string; licenseKind: string | null }): boolean {
  return plan.kind === 'CREDIT' || (plan.kind === 'LICENSE' && plan.licenseKind !== 'TIMED');
}
