/**
 * The routing preview form: what its fields are sent as, held to the API's
 * request schema, and a response read through the API's response schema.
 */

import { describe, expect, it } from 'vitest';
import { PRICE_REASONS, ROUTING_PROVIDER_REASONS, RoutingPreviewDtoSchema, RoutingPreviewRequestSchema } from '@rekey.dev/shared-types';
import { countryName, previewRequest, priceReasonText, providerReasonText, readPreviewFields } from '@/lib/routing-preview';

function request(sp: Record<string, string>) {
  return previewRequest(readPreviewFields(sp));
}

describe('previewRequest', () => {
  it('asks nothing until a country is given', () => {
    expect(request({})).toEqual({ kind: 'empty' });
    expect(request({ plan: 'pro' })).toEqual({ kind: 'empty' });
  });

  it('sends the country upper-cased with only the fields that were filled', () => {
    const read = request({ country: 'in', plan: 'pro', couponCode: 'LAUNCH' });
    expect(read).toEqual({
      kind: 'ready',
      body: { country: 'IN', countrySource: 'vouched', plan: 'pro', couponCode: 'LAUNCH' },
    });
    if (read.kind === 'ready') expect(() => RoutingPreviewRequestSchema.parse(read.body)).not.toThrow();
  });

  it('names a currency only for a checkout the server opens', () => {
    const fromBrowser = request({ country: 'IN', currency: 'INR', onUnavailableCurrency: 'refuse', countrySource: 'hint' });
    expect(fromBrowser).toEqual({ kind: 'ready', body: { country: 'IN', countrySource: 'hint' } });

    const fromServer = request({ country: 'IN', currency: 'inr', onUnavailableCurrency: 'refuse', countrySource: 'declared' });
    expect(fromServer).toEqual({
      kind: 'ready',
      body: { country: 'IN', countrySource: 'declared', currency: 'INR', onUnavailableCurrency: 'refuse' },
    });
    if (fromServer.kind === 'ready') expect(() => RoutingPreviewRequestSchema.parse(fromServer.body)).not.toThrow();
  });

  it('refuses a country or a currency that is not a code, before the API would', () => {
    expect(request({ country: 'IND' })).toMatchObject({ kind: 'invalid' });
    expect(request({ country: 'IN', countrySource: 'declared', currency: 'RUPEE' })).toMatchObject({ kind: 'invalid' });
  });

  it('every request the form can make passes the strict request schema', () => {
    const read = request({
      country: 'DE',
      plan: 'team',
      countrySource: 'declared',
      endUserId: 'eu_1',
      currency: 'EUR',
      onUnavailableCurrency: 'fallback',
      provider: 'stripe',
      couponCode: 'TEN',
    });
    if (read.kind !== 'ready') throw new Error('not ready');
    expect(RoutingPreviewRequestSchema.parse(read.body)).toEqual(read.body);
  });
});

describe('the words for a preview', () => {
  it('cover every price reason and every provider reason the API can send', () => {
    for (const reason of PRICE_REASONS) expect(priceReasonText(reason).length).toBeGreaterThan(10);
    for (const reason of ROUTING_PROVIDER_REASONS) expect(providerReasonText(reason).length).toBeGreaterThan(10);
  });

  it('names a country', () => {
    expect(countryName('in')).toBe('India');
    expect(countryName('IND')).toBeNull();
  });
});

describe('a preview response', () => {
  it('parses through RoutingPreviewDtoSchema: a fallback, a refusal and a refused coupon', () => {
    const usd = { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00' };
    const inr = { id: 'pp_inr', currency: 'INR', amount: 149900, formatted: '₹1,499.00' };
    const dto = RoutingPreviewDtoSchema.parse({
      country: 'IN',
      countrySource: 'vouched',
      localPrices: 'trusted',
      onUnavailableCurrency: 'fallback',
      items: [
        {
          plan: { id: 'plan_1', slug: 'pro', name: 'Pro', kind: 'SUBSCRIPTION' },
          price: { ...usd, isDefault: true, reason: 'fallback', requestedCurrency: 'INR' },
          priceFallback: { requested: inr, charged: usd, reason: 'no_provider_for_currency' },
          provider: 'stripe',
          providerReason: 'only_capable',
          refusal: null,
          coupon: {
            code: 'five',
            discount: null,
            refusal: { code: 'COUPON_CURRENCY_NOT_COVERED', message: 'This code does not work for prices in USD.', fix: null },
          },
          summary: 'A buyer in India buying Pro pays $19.00 through Stripe.',
        },
        {
          plan: { id: 'plan_2', slug: 'team', name: 'Team', kind: 'SUBSCRIPTION' },
          price: null,
          priceFallback: null,
          provider: null,
          providerReason: null,
          refusal: { code: 'BILLING_NO_PROVIDER_FOR_CURRENCY', message: 'No provider can charge EUR.', fix: 'Add EUR to a provider.' },
          coupon: null,
          summary: 'A buyer in India cannot buy Team.',
        },
      ],
    });
    expect(dto.items[0]?.priceFallback?.requested.currency).toBe('INR');
    expect(priceReasonText(dto.items[0]!.price!.reason)).toContain('default price is charged');
    expect(dto.items[1]?.refusal?.fix).toBe('Add EUR to a provider.');
  });
});
