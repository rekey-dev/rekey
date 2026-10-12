/**
 * Reading an amount an operator typed. The panel takes amounts the way people
 * write them (19.99) and sends the API the whole number of minor units it
 * stores (1999). How many digits to shift comes from the currency registry.
 */

import { isSellableCurrency, minorUnitExponent, validatePriceAmount } from '@rekey.dev/shared-types/currency';

export type TypedAmount = { ok: true; minor: number } | { ok: false; message: string };

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * A typed amount as minor units, or null when it is not a plain decimal, the
 * currency is unknown, or it has more decimals than the currency does.
 *
 * The digits are shifted as text: 19.99 times 100 in floating point is
 * 1998.9999999999998.
 *
 * @example
 * majorToMinor('19.99', 'USD'); // 1999
 * majorToMinor('5000', 'HUF');  // 500000
 * majorToMinor('1500', 'JPY');  // 1500
 * majorToMinor('19.99', 'JPY'); // null
 */
export function majorToMinor(raw: string, currency: string): number | null {
  const match = PLAIN_DECIMAL.exec(raw.trim());
  const exponent = minorUnitExponent(currency);
  if (!match || exponent === null) return null;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) return null;
  const minor = Number(whole + fraction.padEnd(exponent, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * Minor units as the text an operator would type for them, to prefill an
 * amount field: no decimals where they are all zero. Null for a currency
 * Rekey does not know.
 *
 * @example
 * minorToMajorText(1999, 'USD');   // '19.99'
 * minorToMajorText(2500, 'USD');   // '25'
 * minorToMajorText(1500, 'JPY');   // '1500'
 * minorToMajorText(500000, 'HUF'); // '5000'
 */
export function minorToMajorText(minor: number, currency: string): string | null {
  const exponent = minorUnitExponent(currency);
  if (exponent === null || !Number.isSafeInteger(minor) || minor < 0) return null;
  if (exponent === 0) return String(minor);
  const digits = String(minor).padStart(exponent + 1, '0');
  const whole = digits.slice(0, -exponent);
  const fraction = digits.slice(-exponent);
  return /^0+$/.test(fraction) ? whole : `${whole}.${fraction}`;
}

function unreadable(raw: string, currency: string): string {
  const code = currency.trim().toUpperCase();
  const exponent = minorUnitExponent(code);
  if (exponent === null) return `${code} is not a currency Rekey knows.`;
  if (!PLAIN_DECIMAL.test(raw.trim())) return 'Type the amount as a plain number, such as 19.99.';
  if (exponent === 0) return `${code} has no decimals, so type a whole number.`;
  return `${code} has ${exponent} decimals at most.`;
}

/**
 * A typed price: the minor units to send, or why it cannot be saved.
 *
 * @example
 * readTypedPrice('19.99', 'USD');   // { ok: true, minor: 1999 }
 * readTypedPrice('5000', 'HUF');    // { ok: true, minor: 500000 }
 * readTypedPrice('5000.50', 'HUF'); // { ok: false, message: 'HUF is priced in whole units, so type a whole number.' }
 * readTypedPrice('19.99', 'JPY');   // { ok: false, message: 'JPY has no decimals, so type a whole number.' }
 */
export function readTypedPrice(raw: string, currency: string): TypedAmount {
  const minor = majorToMinor(raw, currency);
  if (minor === null) return { ok: false, message: unreadable(raw, currency) };
  const checked = validatePriceAmount(currency, minor);
  if (checked.ok) return { ok: true, minor };
  if (checked.rule === 'not_whole_unit') {
    return { ok: false, message: `${currency.trim().toUpperCase()} is priced in whole units, so type a whole number.` };
  }
  return { ok: false, message: checked.message };
}

/**
 * A plan's own amount, which unlike an added price may be zero: a free plan,
 * or a usage plan with no base fee.
 *
 * @example
 * readTypedPlanAmount('0', 'USD');    // { ok: true, minor: 0 }
 * readTypedPlanAmount('9.99', 'USD'); // { ok: true, minor: 999 }
 */
export function readTypedPlanAmount(raw: string, currency: string): TypedAmount {
  if (majorToMinor(raw, currency) === 0 && isSellableCurrency(currency)) return { ok: true, minor: 0 };
  return readTypedPrice(raw, currency);
}
