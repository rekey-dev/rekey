/**
 * The currency control on a provider's credential form: which codes it
 * offers, which start ticked, and how the submitted form is read.
 *
 * A provider can only be given currencies it publishes. The API refuses any
 * other code, so the control offers none.
 */

import { currencyRecord, sellableCurrencies } from '@rekey.dev/shared-types/currency';

/** What an empty currency list means, wherever the panel shows one. */
export const NO_CURRENCY_TICKED = 'None ticked: this provider is not used for any checkout';

export interface CurrencyOption {
  code: string;
  name: string;
}

/**
 * The codes a provider's form offers, sorted, with their names.
 *
 * @example
 * offeredCurrencies(['USD', 'EUR']); // [{ code: 'EUR', name: 'Euro' }, { code: 'USD', name: 'US Dollar' }]
 * offeredCurrencies('all-sellable'); // every currency a price may be in
 */
export function offeredCurrencies(supported: readonly string[] | 'all-sellable'): CurrencyOption[] {
  const codes = supported === 'all-sellable' ? sellableCurrencies() : [...supported];
  return codes
    .map((code) => code.toUpperCase())
    .sort()
    .map((code) => ({ code, name: currencyRecord(code)?.name ?? code }));
}

/**
 * The codes ticked when the form opens: what is stored, less anything the
 * provider cannot charge, or the provider's usual set for a new row.
 *
 * @example
 * tickedCurrencies(['INR', 'USD'], ['USD'], offered); // ['USD'] when the provider does not offer INR
 * tickedCurrencies(undefined, ['INR'], offered);      // ['INR']
 */
export function tickedCurrencies(
  stored: readonly string[] | undefined,
  preselected: readonly string[],
  offered: readonly CurrencyOption[],
): string[] {
  const codes = new Set(offered.map((option) => option.code));
  return (stored ?? preselected).map((code) => code.toUpperCase()).filter((code) => codes.has(code));
}

/**
 * The currencies a submitted credential form names: one `currencies` entry
 * per ticked box.
 *
 * @example
 * submittedCurrencies(formData); // ['EUR', 'USD']
 */
export function submittedCurrencies(formData: FormData): string[] {
  const codes = formData
    .getAll('currencies')
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(codes)];
}

/**
 * A provider's stored currencies, for its row in the providers table.
 *
 * An empty list means none: the API sends an account with no currency
 * ticked no checkout at all, so the cell says so.
 *
 * @example
 * currenciesSummary(['USD', 'EUR']); // { text: 'EUR, USD', title: 'EUR, USD', none: false }
 * currenciesSummary([]);             // { text: 'No currency', title: NO_CURRENCY_TICKED, none: true }
 */
export function currenciesSummary(
  currencies: readonly string[],
  shown = 6,
): { text: string; title: string; none: boolean } {
  if (currencies.length === 0) return { text: 'No currency', title: NO_CURRENCY_TICKED, none: true };
  const codes = [...currencies].map((code) => code.toUpperCase()).sort();
  const title = codes.join(', ');
  const text = codes.length <= shown ? title : `${codes.slice(0, shown).join(', ')} and ${codes.length - shown} more`;
  return { text, title, none: false };
}
