/**
 * The hint under the plan form's Amount field.
 */

import { formatMoney } from './format';
import { readTypedPlanAmount } from './money-input';

export type PlanKind = 'SUBSCRIPTION' | 'LICENSE' | 'USAGE' | 'CREDIT';

const EXAMPLE: Readonly<Record<PlanKind, string>> = {
  SUBSCRIPTION: 'As the currency is written, such as 9.99.',
  LICENSE: 'As the currency is written, such as 9.99.',
  USAGE: '0 = pure pay-as-you-go.',
  CREDIT: 'One-time charge for the pack, such as 49.99.',
};

/**
 * A static example while there is nothing to price yet, and after that only
 * the price the typed amount would be saved as, or why it cannot be saved.
 *
 * @example
 * amountHint('SUBSCRIPTION', '', 'USD');      // { example: 'As the currency is written, such as 9.99.', live: null }
 * amountHint('SUBSCRIPTION', '19.99', 'USD'); // { example: null, live: '$19.99' }
 * amountHint('SUBSCRIPTION', '5000', 'HUF');  // { example: null, live: 'HUF 5,000' }
 * amountHint('SUBSCRIPTION', '19.99', 'JPY'); // { example: null, live: 'JPY has no decimals, so type a whole number.' }
 */
export function amountHint(
  kind: PlanKind,
  amount: string,
  currency: string,
): { example: string | null; live: string | null } {
  const example = { example: EXAMPLE[kind], live: null };
  if (amount.trim() === '' || !/^[A-Za-z]{3}$/.test(currency.trim())) return example;
  const typed = readTypedPlanAmount(amount, currency);
  if (!typed.ok) return { example: null, live: typed.message };
  if (typed.minor === 0) return example;
  return { example: null, live: formatMoney(typed.minor, currency) };
}
