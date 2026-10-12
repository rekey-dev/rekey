/**
 * The currency registry. Dependency-free, so a browser bundle can import
 * `@rekey.dev/shared-types/currency` without pulling in zod.
 */

export { CURRENCY_TABLE } from './data.js';
export {
  MAX_PRICE_AMOUNT,
  chargeableStep,
  currencyRecord,
  currencySellability,
  isSellableCurrency,
  localCurrencyOf,
  minorUnitExponent,
  percentageDiscount,
  sellableCurrencies,
  validatePriceAmount,
} from './registry.js';
export type {
  CurrencyRecord,
  CurrencySellability,
  PriceAmountRule,
  PriceAmountValidation,
  UnsellableReason,
} from './registry.js';
export { formatMoney } from './format.js';
export { priceFallbackMessage } from './fallback-message.js';
export type { PriceFallbackSides } from './fallback-message.js';
