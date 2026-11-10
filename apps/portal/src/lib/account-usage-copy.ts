/**
 * Words for what the customer's plans give them: feature labels and values,
 * usage lines, credit entries, license rows, trials and the free plan.
 *
 * Pure and runtime-neutral: pages, cards, actions and tests import it.
 */

import { DEVICE_LIMIT_FEATURE_KEY } from '@rekey.dev/shared-types';

/**
 * A feature code read as a label.
 *
 * @example
 * featureLabel('max_devices'); // 'Devices'
 * featureLabel('api-access'); // 'Api access'
 */
export function featureLabel(key: string): string {
  if (key === DEVICE_LIMIT_FEATURE_KEY) return 'Devices';
  const words = key.replace(/[_\-.:]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/**
 * @example
 * featureValue(true, 'en-US'); // 'Included'
 * featureValue(5000, 'en-US'); // '5,000'
 */
export function featureValue(value: boolean | number | string, locale: string): string {
  if (value === true) return 'Included';
  if (value === false) return 'Not included';
  if (typeof value === 'number') return value.toLocaleString(locale);
  return value;
}

/**
 * One meter's standing this period, in words. The meter's unit is left out: it
 * is whatever word the operator typed, singular or plural, so "500 export used"
 * is as likely as "500 exports used". The meter's name beside the line says
 * what is counted.
 *
 * @example
 * usageLine({ used: 1200, included: 5000 }, 'en-US'); // '1,200 of 5,000 used'
 */
export function usageLine(meter: { used: number; included: number | null }, locale: string): string {
  const used = meter.used.toLocaleString(locale);
  if (meter.included === null) return `${used} used`;
  return `${used} of ${meter.included.toLocaleString(locale)} used`;
}

const CREDIT_REASONS: Readonly<Record<string, string>> = {
  PURCHASE: 'Bought',
  GRANT: 'Added',
  CONSUME: 'Used',
  REFUND: 'Refunded',
  ADJUST: 'Corrected',
};

export function creditReasonWord(reason: string): string {
  return CREDIT_REASONS[reason] ?? 'Changed';
}

/**
 * @example
 * signedCredits(-20, 'en-US'); // '−20'
 */
export function signedCredits(delta: number, locale: string): string {
  const n = Math.abs(delta).toLocaleString(locale);
  return delta < 0 ? `−${n}` : `+${n}`;
}

const LICENSE_STATUS: Readonly<Record<string, string>> = { ACTIVE: 'Active', EXPIRED: 'Expired', REVOKED: 'Revoked' };
const LICENSE_KIND: Readonly<Record<string, string>> = {
  PERPETUAL: 'Does not expire',
  TIMED: 'For a fixed time',
  SEATS: 'Shared seats',
};

export function licenseStatusWord(status: string): string {
  return LICENSE_STATUS[status] ?? 'Unknown';
}

export function licenseKindWord(kind: string): string {
  return LICENSE_KIND[kind] ?? '';
}

export const LICENSE_KEY_SHOWN_ONCE =
  'The full key was shown once, when it was issued, and cannot be shown again: only its first characters are kept here. ' +
  'If you lost it, contact support.';

/**
 * The API's own answer, never a guess from the plan.
 *
 * @example
 * trialNote({ eligible: true, trialDays: 14, reason: null }); // 'Includes a 14-day free trial.'
 */
export function trialNote(item: { eligible: boolean; trialDays: number | null; reason: string | null } | undefined): string | null {
  if (!item) return null;
  if (item.eligible && item.trialDays) return `Includes a ${item.trialDays}-day free trial.`;
  if (item.reason === 'TRIAL_IN_PROGRESS') return 'Your free trial of this plan is running.';
  if (item.reason === 'ALREADY_REDEEMED') return 'You have already used your free trial.';
  return null;
}

export const FREE_PLAN_STARTED = 'started';

const FREE_PLAN_ERRORS: Readonly<Record<string, string>> = {
  BILLING_NO_FREE_PLAN: 'There is no free plan to start here right now.',
  BILLING_FREE_PLAN_NOT_FREE: 'That plan is no longer free, so it has to be bought.',
  BILLING_FREE_TIER_ALREADY_CLAIMED: 'You already claimed the free plan for another account or team.',
  BILLING_SUBSCRIPTION_SUBJECT_CONFLICT: 'You already have the free plan on another account or team.',
  BILLING_ORGANIZATION_REQUIRED: 'This plan is for a team, so a team owner or admin has to start it.',
};

export function freePlanErrorCopy(code: string): string {
  return FREE_PLAN_ERRORS[code] ?? 'The free plan could not be started. Try again, and if it keeps happening, contact support.';
}
