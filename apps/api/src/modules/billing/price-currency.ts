/**
 * What Rekey knows about currencies and where they are local, for plan prices.
 *
 * Static on purpose. An operator adds a price in a currency and it applies
 * where that currency is the local one; nobody maintains a mapping.
 */

const ISO_4217 = new Set(Intl.supportedValuesOf('currency'));

/**
 * Three-decimal currencies. Stripe and Razorpay only take amounts ending in 0
 * for them and PayPal takes none, so an integer price in one cannot be charged
 * as written.
 */
const THREE_DECIMAL = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND']);

/**
 * @example
 * isIsoCurrency('INR'); // true
 * isIsoCurrency('XYZ'); // false
 */
export function isIsoCurrency(code: string): boolean {
  return /^[A-Z]{3}$/.test(code) && ISO_4217.has(code);
}

/**
 * @example
 * isThreeDecimalCurrency('KWD'); // true
 */
export function isThreeDecimalCurrency(code: string): boolean {
  return THREE_DECIMAL.has(code);
}

const EUROZONE = [
  'AT', 'BE', 'BG', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR',
  'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK',
] as const;

const LOCAL_CURRENCY: Readonly<Record<string, string>> = {
  ...Object.fromEntries(EUROZONE.map((country) => [country, 'EUR'])),
  AE: 'AED', AR: 'ARS', AU: 'AUD', BD: 'BDT', BR: 'BRL', CA: 'CAD', CH: 'CHF',
  CL: 'CLP', CN: 'CNY', CO: 'COP', CZ: 'CZK', DK: 'DKK', EG: 'EGP', GB: 'GBP',
  HK: 'HKD', HU: 'HUF', ID: 'IDR', IL: 'ILS', IN: 'INR', JP: 'JPY', KE: 'KES',
  KR: 'KRW', LK: 'LKR', MX: 'MXN', MY: 'MYR', NG: 'NGN', NO: 'NOK', NP: 'NPR',
  NZ: 'NZD', PE: 'PEN', PH: 'PHP', PK: 'PKR', PL: 'PLN', RO: 'RON', SA: 'SAR',
  SE: 'SEK', SG: 'SGD', TH: 'THB', TR: 'TRY', TW: 'TWD', US: 'USD', VN: 'VND',
  ZA: 'ZAR',
};

/**
 * The currency a country's buyers ordinarily pay in, or null for a country
 * this table does not cover. An uncovered country gets the plan's default
 * price unless a price names it in `countries`.
 *
 * @example
 * localCurrencyOf('IN'); // 'INR'
 * localCurrencyOf('de'); // 'EUR'
 */
export function localCurrencyOf(country: string): string | null {
  return LOCAL_CURRENCY[country.toUpperCase()] ?? null;
}
