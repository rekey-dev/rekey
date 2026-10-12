/**
 * The routing preview form: what its fields are sent as, and the words for
 * why a price and a provider were chosen.
 *
 * The preview asks the API which price, currency and provider a buyer would
 * get, with the functions checkout runs. It opens no checkout and writes
 * nothing, so the form is a plain GET: a preview can be linked to.
 */

import type { RoutingPreviewItem, RoutingPreviewRequest } from '@rekey.dev/shared-types';

export type CountrySource = 'vouched' | 'hint' | 'declared';

export const COUNTRY_SOURCES: Array<{ value: CountrySource; label: string; help: string }> = [
  {
    value: 'vouched',
    label: 'A browser, country from a trusted proxy',
    help: 'The buyer opens checkout from your site and a proxy you trust says where they are. A local price is offered.',
  },
  {
    value: 'hint',
    label: 'A browser, country stated by the buyer',
    help: 'The buyer opens checkout and their own browser says where they are. A local price is offered only when local prices are open to any country.',
  },
  {
    value: 'declared',
    label: 'Your server, with the secret key',
    help: 'Your server opens checkout and passes the country. It may also name a currency.',
  },
];

/** Why only a server may name a currency, said beside the disabled fields. */
export const SERVER_ONLY_REASON =
  'Only your server can name a currency, as at checkout. Choose "Your server, with the secret key" above to preview one.';

type SearchParams = Record<string, string | string[] | undefined>;

function one(sp: SearchParams, name: string): string {
  const value = sp[name];
  return typeof value === 'string' ? value.trim() : '';
}

export interface PreviewFields {
  country: string;
  plan: string;
  countrySource: CountrySource;
  endUserId: string;
  currency: string;
  onUnavailableCurrency: '' | 'fallback' | 'refuse';
  provider: string;
  couponCode: string;
}

/** The form's fields as the URL carries them, for prefilling it. */
export function readPreviewFields(sp: SearchParams): PreviewFields {
  const source = COUNTRY_SOURCES.find((entry) => entry.value === one(sp, 'countrySource'))?.value ?? 'vouched';
  const unavailable = one(sp, 'onUnavailableCurrency');
  return {
    country: one(sp, 'country').toUpperCase(),
    plan: one(sp, 'plan'),
    countrySource: source,
    endUserId: one(sp, 'endUserId'),
    currency: one(sp, 'currency').toUpperCase(),
    onUnavailableCurrency: unavailable === 'fallback' || unavailable === 'refuse' ? unavailable : '',
    provider: one(sp, 'provider'),
    couponCode: one(sp, 'couponCode'),
  };
}

export type PreviewRequestRead =
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ready'; body: RoutingPreviewRequest };

/**
 * The request the form's fields make. A currency or a refusal rule is sent
 * only for a server-opened checkout, which is the only one that can name
 * them; from a browser they are dropped, as checkout drops them.
 *
 * @example
 * previewRequest(readPreviewFields({ country: 'in', plan: 'pro' }));
 * // { kind: 'ready', body: { country: 'IN', plan: 'pro', countrySource: 'vouched' } }
 */
export function previewRequest(fields: PreviewFields): PreviewRequestRead {
  if (fields.country === '') return { kind: 'empty' };
  if (!/^[A-Z]{2}$/.test(fields.country)) {
    return { kind: 'invalid', reason: 'A country is a two-letter code, such as IN, DE or US.' };
  }
  const server = fields.countrySource === 'declared';
  if (server && fields.currency !== '' && !/^[A-Z]{3}$/.test(fields.currency)) {
    return { kind: 'invalid', reason: 'A currency is a three-letter code, such as INR.' };
  }
  return {
    kind: 'ready',
    body: {
      country: fields.country,
      countrySource: fields.countrySource,
      ...(fields.plan !== '' && { plan: fields.plan }),
      ...(fields.endUserId !== '' && { endUserId: fields.endUserId }),
      ...(server && fields.currency !== '' && { currency: fields.currency }),
      ...(server && fields.currency !== '' && fields.onUnavailableCurrency !== '' && {
        onUnavailableCurrency: fields.onUnavailableCurrency,
      }),
      ...(fields.provider !== '' && { provider: fields.provider }),
      ...(fields.couponCode !== '' && { couponCode: fields.couponCode }),
    },
  };
}

const PRICE_REASON: Record<NonNullable<RoutingPreviewItem['price']>['reason'], string> = {
  bound: 'the buyer already pays in this currency, and a subscriber keeps their currency',
  requested: 'your server named this currency',
  country: 'it is the plan’s price for the buyer’s country',
  default: 'no other price applies, so the default price is charged',
  fallback: 'the price selected for the buyer cannot be charged, so the default price is charged',
};

const PROVIDER_REASON: Record<NonNullable<RoutingPreviewItem['providerReason']>, string> = {
  bound: 'the buyer is already billed through it',
  named: 'the checkout names it',
  country: 'it is preferred in the buyer’s country',
  only_capable: 'it is the only enabled provider that can charge this currency',
  priority: 'it has the best priority among the providers that can charge this currency',
};

/** Why this price, in words. */
export function priceReasonText(reason: NonNullable<RoutingPreviewItem['price']>['reason']): string {
  return PRICE_REASON[reason];
}

/** Why this provider, in words. */
export function providerReasonText(reason: NonNullable<RoutingPreviewItem['providerReason']>): string {
  return PROVIDER_REASON[reason];
}

/**
 * A country's English name for the hint under the country field, or null for
 * a code that is not two letters or that the runtime does not know.
 *
 * @example
 * countryName('in'); // 'India'
 */
export function countryName(code: string): string | null {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(upper);
    return name === undefined || name === upper ? null : name;
  } catch {
    return null;
  }
}
