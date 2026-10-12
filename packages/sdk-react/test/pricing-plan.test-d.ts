/**
 * The public shapes of the billing components, and what the money model
 * removed from them. Checked by `pnpm typecheck`, never executed.
 */

import { expectTypeOf } from 'vitest';
import type { Paged, PublicPlanDto, CheckoutResultDto, ValidateCouponResultDto } from '@rekey.dev/shared-types';
import type { PricingGridProps, PricingPlan } from '../src/pricing-shared.js';
import type { PricingTableProps, PortalPaymentDto, RekeyBrowserClient } from '../src/index.js';
import type { PriceFallbackNoticeProps, CouponQuoteProps } from '../src/index.js';
import * as shared from '../src/pricing-shared.js';
import * as sdk from '../src/index.js';

const built: PricingPlan = {
  id: 'p1',
  slug: 'pro',
  name: 'Pro',
  isFree: false,
  checkout: { ready: true },
  price: { currency: 'USD', amount: 1900, formatted: '$19.00' },
  prices: [{ currency: 'USD', amount: 1900 }],
};
void built;

// What `getPlans()` returns goes straight in.
declare const fromApi: Paged<PublicPlanDto>;
const plans: PricingPlan[] = fromApi.items;
void plans;

// @ts-expect-error a plan without `prices` is not a PricingPlan
const withoutPrices: PricingPlan = { id: 'p1', slug: 'pro', name: 'Pro', isFree: false, checkout: { ready: true }, price: null };
void withoutPrices;

// @ts-expect-error a plan without its resolved `price` is not a PricingPlan
const withoutPrice: PricingPlan = { id: 'p1', slug: 'pro', name: 'Pro', isFree: false, checkout: { ready: true }, prices: [] };
void withoutPrice;

// @ts-expect-error a plan must say whether a checkout for it is ready
const withoutCheckout: PricingPlan = { id: 'p1', slug: 'pro', name: 'Pro', isFree: false, price: null, prices: [] };
void withoutCheckout;

// The plan's own amount and currency are not read: the resolved price is.
expectTypeOf<PricingPlan>().not.toHaveProperty('amount');
expectTypeOf<PricingPlan>().not.toHaveProperty('currency');

// The table no longer picks a price by currency.
expectTypeOf<PricingTableProps>().not.toHaveProperty('currency');
expectTypeOf<PricingGridProps>().not.toHaveProperty('currency');
expectTypeOf<PricingTableProps>().toHaveProperty('priceFallbackNote');
expectTypeOf<PricingTableProps>().toHaveProperty('unavailableLabel');
// @ts-expect-error removed: a price picked in the page is not the price charged
void shared.planInCurrency;
// @ts-expect-error removed: renamed to priceLabel, which formats nothing itself
void shared.formatPrice;

expectTypeOf<CheckoutResultDto['priceFallback']>().toMatchTypeOf<PriceFallbackNoticeProps['fallback']>();
expectTypeOf<ValidateCouponResultDto>().toMatchTypeOf<CouponQuoteProps['quote']>();

expectTypeOf<PortalPaymentDto['refundedAmount']>().toEqualTypeOf<number>();

export async function browserClient(client: RekeyBrowserClient): Promise<void> {
  expectTypeOf(await client.getPlans(undefined, { accessToken: 'token' })).toEqualTypeOf<Paged<PublicPlanDto>>();
  expectTypeOf(await client.validateCoupon('token', { code: 'LAUNCH', planSlug: 'pro' })).toEqualTypeOf<ValidateCouponResultDto>();
  expectTypeOf(sdk.formatMoney).returns.toBeString();
}
