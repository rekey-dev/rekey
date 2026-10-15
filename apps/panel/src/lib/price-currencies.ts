/**
 * Which currencies a price or a coupon amount can be in, and whether a buyer
 * could be charged in each today.
 *
 * The list is every currency Rekey sells in: the registry's sellable set,
 * which leaves out three-decimal currencies and codes that are not money.
 * Whether one can be charged is the API's own rule (`canCharge` in the
 * credentials service) applied to the providers this Application has
 * connected, so the picker says before a save what checkout would say after.
 */

import {
  chargeableStep,
  currencyRecord,
  currencySellability,
  minorUnitExponent,
  sellableCurrencies,
} from '@rekey.dev/shared-types/currency';

/** The parts of a provider descriptor this needs. Mirrors `BillingProviderDescriptor`. */
export interface ChargingProvider {
  name: string;
  label: string;
  supportedCurrencies: readonly string[] | 'all-sellable';
  capabilities: { checkout: boolean };
  status: { enabled: boolean; currencies: readonly string[]; unsupportedCurrencies: readonly string[] } | null;
}

/** What it would take for a provider that cannot charge a currency today to charge it. */
export type ProviderRepair = 'connect' | 'enable' | 'tick_currency';

export interface CurrencyChoice {
  code: string;
  name: string;
  /** Labels of the enabled providers that can charge it now. Empty means nobody can. */
  chargedBy: string[];
  /** Providers that could charge it after one change, when nobody can now. */
  couldCharge: Array<{ label: string; repair: ProviderRepair }>;
}

function hostsCheckout(provider: ChargingProvider): boolean {
  return provider.capabilities.checkout;
}

function publishes(provider: ChargingProvider, code: string): boolean {
  return provider.supportedCurrencies === 'all-sellable' || provider.supportedCurrencies.includes(code);
}

/**
 * Whether a connected, enabled provider is sent a checkout in `code`. An
 * account with no currency ticked is sent none.
 *
 * @example
 * chargesNow({ ...stripe, status: { enabled: true, currencies: ['USD'], unsupportedCurrencies: [] } }, 'INR'); // false
 */
export function chargesNow(provider: ChargingProvider, code: string): boolean {
  const status = provider.status;
  if (status === null || !status.enabled || !hostsCheckout(provider)) return false;
  if (status.unsupportedCurrencies.includes(code)) return false;
  return status.currencies.includes(code);
}

function repairFor(provider: ChargingProvider, code: string): ProviderRepair | null {
  if (!hostsCheckout(provider) || !publishes(provider, code)) return null;
  if (provider.status === null) return 'connect';
  if (!provider.status.enabled) return 'enable';
  return 'tick_currency';
}

/**
 * One currency with who can charge it.
 *
 * @example
 * currencyChoice('INR', providers).chargedBy; // ['Razorpay']
 */
export function currencyChoice(code: string, providers: readonly ChargingProvider[]): CurrencyChoice {
  const upper = code.toUpperCase();
  const chargedBy = providers.filter((provider) => chargesNow(provider, upper)).map((provider) => provider.label);
  const couldCharge =
    chargedBy.length > 0
      ? []
      : providers.flatMap((provider) => {
          const repair = repairFor(provider, upper);
          return repair === null ? [] : [{ label: provider.label, repair }];
        });
  return { code: upper, name: currencyRecord(upper)?.name ?? upper, chargedBy, couldCharge };
}

/**
 * Every currency a price may be in, `first` leading when given (the
 * Application's reporting currency), the rest by code.
 *
 * @example
 * priceCurrencyChoices(providers, 'USD')[0]?.code; // 'USD'
 */
export function priceCurrencyChoices(providers: readonly ChargingProvider[], first?: string): CurrencyChoice[] {
  const lead = first?.toUpperCase();
  const codes = sellableCurrencies().sort((a, b) => Number(b === lead) - Number(a === lead) || a.localeCompare(b));
  return codes.map((code) => currencyChoice(code, providers));
}

const REPAIR_WORDS: Record<ProviderRepair, (label: string, code: string) => string> = {
  connect: (label) => `connect ${label}`,
  enable: (label) => `enable ${label}`,
  tick_currency: (label, code) => `tick ${code} on ${label}`,
};

/**
 * Why a currency cannot be charged and what would change that, or null when
 * some provider can charge it.
 *
 * @example
 * unchargeableReason(currencyChoice('INR', providers));
 * // 'No enabled provider can charge INR. To sell in it: connect Razorpay.'
 */
export function unchargeableReason(choice: CurrencyChoice): string | null {
  if (choice.chargedBy.length > 0) return null;
  if (choice.couldCharge.length === 0) {
    return `No provider Rekey supports can charge ${choice.code}, so a buyer is charged the plan's default price instead.`;
  }
  const repairs = choice.couldCharge.map((entry) => REPAIR_WORDS[entry.repair](entry.label, choice.code));
  return `No enabled provider can charge ${choice.code}. To sell in it: ${repairs.join(', or ')}.`;
}

/**
 * How an amount in this currency is typed, for the hint under an amount field.
 *
 * @example
 * amountRule('USD'); // 'Up to 2 decimals, such as 19.99.'
 * amountRule('JPY'); // 'JPY has no decimals. Type a whole number, such as 1500.'
 * amountRule('HUF'); // 'HUF is priced in whole units. Type a whole number, such as 5000.'
 */
export function amountRule(code: string): string | null {
  const upper = code.toUpperCase();
  const exponent = minorUnitExponent(upper);
  if (exponent === null) return null;
  if (exponent === 0) return `${upper} has no decimals. Type a whole number, such as 1500.`;
  if (chargeableStep(upper) > 1) return `${upper} is priced in whole units. Type a whole number, such as 5000.`;
  return `Up to ${exponent} decimals, such as 19.99.`;
}

/**
 * A provider list cut down to what the currency picker reads, so a client
 * component is not handed credential field schemas it has no use for.
 *
 * @example
 * <CurrencyCatalog providers={toChargingProviders(await getBillingProviders(id))}>
 */
export function toChargingProviders(providers: readonly ChargingProvider[]): ChargingProvider[] {
  return providers.map((provider) => ({
    name: provider.name,
    label: provider.label,
    supportedCurrencies: provider.supportedCurrencies,
    capabilities: { checkout: provider.capabilities.checkout },
    status:
      provider.status === null
        ? null
        : {
            enabled: provider.status.enabled,
            currencies: provider.status.currencies,
            unsupportedCurrencies: provider.status.unsupportedCurrencies,
          },
  }));
}

const NOT_SOLD: Record<'unknown' | 'not_money' | 'withdrawn' | 'three_decimal', (code: string) => string> = {
  unknown: (code) => `${code} is not a currency Rekey knows. Use a three-letter ISO 4217 code such as USD.`,
  not_money: (code) => `${code} is not money a buyer can be charged in.`,
  withdrawn: (code) => `${code} has been withdrawn and can no longer be charged.`,
  three_decimal: (code) =>
    `${code} has three decimals, and no provider takes such an amount as it is written, so Rekey does not sell in it.`,
};

/**
 * Why a typed code cannot be a price's currency, or null when it can. Null
 * for an empty field too: that is the `required` attribute's job.
 *
 * @example
 * notSoldReason('KWD'); // 'KWD has three decimals, and no provider takes ...'
 * notSoldReason('usd'); // null
 */
export function notSoldReason(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (code === '') return null;
  if (!/^[A-Z]{3}$/.test(code)) return 'A currency is a three-letter code, such as USD.';
  const sellability = currencySellability(code);
  return sellability.sellable ? null : NOT_SOLD[sellability.reason](code);
}
