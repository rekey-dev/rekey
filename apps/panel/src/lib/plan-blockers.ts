/**
 * Which of a plan's checkout blockers the Register button can repair.
 *
 * Pure, so the plans page and its tests share one rule for when Register is
 * on screen and what the "cannot be bought" notice tells the operator to do.
 */

import type { PlanBlocker } from './api';

/**
 * Blockers that registering the plan again cannot clear. With no provider
 * connected there is nothing to register with, and a provider that cannot
 * charge the plan's currency still cannot after the plan is registered.
 */
const REGISTER_CANNOT_FIX: ReadonlySet<string> = new Set(['NO_BILLING_PROVIDER', 'PLAN_CURRENCY_UNSUPPORTED']);

/**
 * The blockers the operator has to settle somewhere other than Register, each
 * carrying its own `fix` text.
 *
 * @example
 * settledElsewhere([{ provider: null, code: 'PLAN_CURRENCY_UNSUPPORTED', message: 'm', fix: 'f' }]).length; // 1
 */
export function settledElsewhere(blockers: readonly PlanBlocker[]): PlanBlocker[] {
  return blockers.filter((blocker) => REGISTER_CANNOT_FIX.has(blocker.code));
}

/** What an operator does in the panel about one blocker. */
export interface PanelRepair {
  /** The sentence that leads, written for someone looking at the panel. */
  action: string;
  /** The panel page the action sends them to, when it is not the plan's own row. */
  link: { href: string; label: string } | null;
  /** The label of the register control to put beside the sentence, or null when registering does not repair it. */
  register: 'Register' | 'Retry registration' | null;
}

const PROVIDERS_PAGE = 'Billing, Setup, Providers';

/**
 * The panel's own repair for a blocker, by its `code`, or null for a code the
 * panel has no action for: the API's `fix` is shown then. The API's `fix` is
 * written for a caller of the API and names routes, which is not what someone
 * looking at the plans page needs first.
 *
 * @example
 * panelRepair({ provider: 'stripe', code: 'PLAN_REGISTRATION_FAILED', message: 'm', fix: 'f' }, 'app_1')?.register; // 'Retry registration'
 * panelRepair({ provider: 'razorpay', code: 'PLAN_TRIAL_UNSUPPORTED', message: 'm', fix: 'f' }, 'app_1'); // null
 */
export function panelRepair(blocker: Pick<PlanBlocker, 'code'>, applicationId: string): PanelRepair | null {
  const providers = { href: `/applications/${applicationId}/billing/providers`, label: PROVIDERS_PAGE };
  switch (blocker.code) {
    case 'PLAN_REGISTRATION_FAILED':
      return {
        action: `Fix the provider's credentials under ${PROVIDERS_PAGE}, or correct the plan's price if that is what the provider refused, then press Retry registration.`,
        link: providers,
        register: 'Retry registration',
      };
    case 'PLAN_NOT_REGISTERED':
      return {
        action: 'This plan was created before the provider was connected, so it was never registered. Press Register.',
        link: null,
        register: 'Register',
      };
    case 'NO_BILLING_PROVIDER':
      return {
        action: `Connect a payment provider under ${PROVIDERS_PAGE}. Plans created before that need Register afterwards.`,
        link: providers,
        register: null,
      };
    case 'PLAN_CURRENCY_UNSUPPORTED':
      return {
        action: `Tick this plan's currency on a provider under ${PROVIDERS_PAGE}, or price the plan in a currency a provider there charges.`,
        link: providers,
        register: null,
      };
    default:
      return null;
  }
}

/**
 * The repair sentence for a place with no room for controls: the panel's own
 * when it has one, the API's `fix` otherwise.
 *
 * @example
 * repairText({ provider: 'razorpay', code: 'PLAN_TRIAL_UNSUPPORTED', message: 'm', fix: 'Remove the trial.' }, 'app_1'); // 'Remove the trial.'
 */
export function repairText(blocker: Pick<PlanBlocker, 'code' | 'fix'>, applicationId: string): string {
  return panelRepair(blocker, applicationId)?.action ?? blocker.fix;
}

/**
 * Whether to offer Register on a plan that cannot be bought.
 *
 * Never with no provider connected: the call can only come back 400. Otherwise
 * only when some blocker is one registering can clear, so a plan held back by
 * its currency alone does not get a button whose only outcome is an error. A
 * plan reported unbuyable with no blocker listed keeps the button, since
 * nothing says registering would not help.
 *
 * @example
 * registerCanHelp([{ provider: 'stripe', code: 'PLAN_NOT_REGISTERED', message: 'm', fix: 'f' }]); // true
 * registerCanHelp([{ provider: null, code: 'PLAN_CURRENCY_UNSUPPORTED', message: 'm', fix: 'f' }]); // false
 */
export function registerCanHelp(blockers: readonly PlanBlocker[]): boolean {
  if (blockers.some((blocker) => blocker.code === 'NO_BILLING_PROVIDER')) return false;
  return blockers.length === 0 || blockers.some((blocker) => !REGISTER_CANNOT_FIX.has(blocker.code));
}
