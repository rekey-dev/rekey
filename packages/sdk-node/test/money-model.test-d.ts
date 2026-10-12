/**
 * Type-level tests for the money model's public shapes, and for what it
 * removed. Checked by `pnpm typecheck` (tsconfig.type-tests.json), never
 * executed.
 */

import { expectTypeOf } from 'vitest';
import type {
  BillingLogActors,
  BillingLogEndUser,
  BillingLogEntry,
  BillingLogPage,
  BillingMoneyErrorCode,
  BillingProviderInfoDto,
  BillingStatsDto,
  CheckoutResultDto,
  CouponDto,
  CreateCheckoutRequest,
  CreateCouponRequest,
  CreatePlanRequest,
  Paged,
  PaymentWebhookData,
  RefundBlockedReason,
  PlanDto,
  PlanPriceDto,
  PriceFallbackDto,
  ProvidersListDto,
  PublicPlanDto,
  RefundResultDto,
  Rekey,
  RekeyOperator,
  ResolvedPriceDto,
  RoutingPreviewDto,
  SelfSubscriptionDto,
  SubscriptionWebhookData,
  TenantPaymentDto,
  UpdatePlanRequest,
  ValidateCouponResultDto,
} from '../src/index.js';
import * as sdk from '../src/index.js';

declare const rekey: Rekey;
declare const operator: RekeyOperator;

export async function secretKeySurface(): Promise<void> {
  const plans = await rekey.billing.getPlans(undefined, { country: 'IN', accessToken: 'token' });
  expectTypeOf(plans).toEqualTypeOf<Paged<PublicPlanDto>>();
  expectTypeOf<PublicPlanDto['price']>().toEqualTypeOf<ResolvedPriceDto | null>();
  expectTypeOf<PublicPlanDto['prices'][number]>().toHaveProperty('isDefault');
  expectTypeOf<PublicPlanDto['checkout']>().toEqualTypeOf<{ ready: boolean }>();

  const checkout = await rekey.billing.createCheckout('token', {
    planSlug: 'pro',
    currency: 'INR',
    onUnavailableCurrency: 'refuse',
    country: 'IN',
    successUrl: 'https://yourapp.com/ok',
    cancelUrl: 'https://yourapp.com/cancel',
  });
  expectTypeOf(checkout).toEqualTypeOf<CheckoutResultDto>();
  expectTypeOf(checkout.price).toEqualTypeOf<ResolvedPriceDto | null>();
  expectTypeOf(checkout.priceFallback).toEqualTypeOf<PriceFallbackDto | null>();
  // Required now: none of these is optional for an older API any more.
  expectTypeOf(checkout.currency).toEqualTypeOf<string>();
  expectTypeOf(checkout.unitAmount).toEqualTypeOf<number>();
  expectTypeOf(checkout.mode).toEqualTypeOf<'redirect' | 'embedded'>();
  expectTypeOf(checkout.checkoutSessionId).toEqualTypeOf<string>();
  expectTypeOf(checkout.warnings).toBeArray();

  expectTypeOf<CreateCheckoutRequest['onUnavailableCurrency']>().toEqualTypeOf<'fallback' | 'refuse' | undefined>();

  const quote = await rekey.billing.validateCoupon('token', { code: 'LAUNCH', planSlug: 'pro' });
  expectTypeOf(quote).toEqualTypeOf<ValidateCouponResultDto>();
  expectTypeOf(quote.formatted).toEqualTypeOf<{ discount: string; total: string }>();
  expectTypeOf(quote.coupon.basisPoints).toEqualTypeOf<number | null>();

  expectTypeOf(await rekey.billing.getSubscription('token')).toEqualTypeOf<SelfSubscriptionDto | null>();
  expectTypeOf<SelfSubscriptionDto['price']>().toEqualTypeOf<{
    id: string;
    currency: string;
    amount: number;
    formatted: string;
  } | null>();

  const providers = await rekey.billing.getProviders('IN');
  expectTypeOf(providers).toEqualTypeOf<ProvidersListDto>();
  expectTypeOf(providers.routedProvider).toEqualTypeOf<string | null>();
  expectTypeOf<BillingProviderInfoDto['currencies']>().toEqualTypeOf<string[]>();
}

export async function operatorSurface(): Promise<void> {
  expectTypeOf(await operator.plans.list()).toEqualTypeOf<Paged<PlanDto>>();
  expectTypeOf(await operator.plans.prices.list('pro')).toEqualTypeOf<PlanPriceDto[]>();
  expectTypeOf(await operator.plans.prices.set('pro', 'INR', { amount: 149900 })).toEqualTypeOf<PlanPriceDto>();
  // @ts-expect-error the currency is the second argument, not a body field
  await operator.plans.prices.set('pro', 'INR', { amount: 149900, currency: 'INR' });

  expectTypeOf(await operator.coupons.get('LAUNCH')).toEqualTypeOf<CouponDto>();
  await operator.coupons.create({ code: 'A', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 500 }] });
  // @ts-expect-error `amountOff` at the top level was replaced by `amounts`
  await operator.coupons.create({ code: 'A', discountType: 'AMOUNT', amountOff: 500 });
  // @ts-expect-error `currency` at the top level was replaced by `amounts` and `currencies`
  await operator.coupons.create({ code: 'A', discountType: 'PERCENT', basisPoints: 1500, currency: 'USD' });

  await operator.coupons.update('A', { endsAt: null, maxRedemptions: 10, maxRedemptionsPerUser: null });
  // @ts-expect-error a coupon's start cannot be changed
  await operator.coupons.update('A', { startsAt: '2026-11-01T00:00:00.000Z' });
  expectTypeOf(await operator.payments.refunds.create('pay_1', { amount: 500 })).toEqualTypeOf<RefundResultDto>();
  expectTypeOf<TenantPaymentDto['refundedAmount']>().toEqualTypeOf<number>();
  expectTypeOf(await operator.payments.get('pay_1')).toEqualTypeOf<TenantPaymentDto>();
  expectTypeOf<TenantPaymentDto['refundBlockedReason']>().toEqualTypeOf<RefundBlockedReason | null>();
  expectTypeOf<TenantPaymentDto['provider']>().toEqualTypeOf<string | null>();

  const page = await operator.billingLog.events.list({ type: ['checkout.price_fallback'], tier: 'PERMANENT' });
  expectTypeOf(page).toEqualTypeOf<BillingLogPage>();
  // @ts-expect-error not an event type
  await operator.billingLog.events.list({ type: 'checkout.fell_back' });
  for await (const each of operator.billingLog.events.pages()) expectTypeOf(each).toEqualTypeOf<BillingLogPage>();
  const named = await operator.billingLog.events.list({ include: ['actors'] });
  expectTypeOf(named.actors).toEqualTypeOf<BillingLogActors | null>();
  expectTypeOf<BillingLogActors['endUsers']>().toEqualTypeOf<BillingLogEndUser[] | null>();
  expectTypeOf<BillingLogEndUser['state']>().toEqualTypeOf<'known' | 'erased' | 'unknown'>();
  // @ts-expect-error `actors` is the only thing a log read can include
  await operator.billingLog.events.list({ include: ['emails'] });
  for await (const entry of operator.billingLog.events.iterate()) {
    expectTypeOf(entry).toEqualTypeOf<BillingLogEntry>();
    if (entry.type === 'checkout.price_fallback') {
      expectTypeOf(entry.data.requested.currency).toEqualTypeOf<string>();
      // @ts-expect-error another event's field
      void entry.data.refundedAmount;
    }
  }

  expectTypeOf(await operator.billing.previewRouting({ country: 'IN', couponCode: 'LAUNCH' })).toEqualTypeOf<RoutingPreviewDto>();
  // @ts-expect-error a preview needs the buyer's country
  await operator.billing.previewRouting({ plan: 'pro' });

  const stats = await operator.billing.stats();
  expectTypeOf(stats).toEqualTypeOf<BillingStatsDto>();
  expectTypeOf(stats.unverified[0]!).toEqualTypeOf<{ currency: string; amountCents: number; payments: number }>();
}

export function removed(): void {
  // Stats are per currency: the scalar totals are gone.
  expectTypeOf<BillingStatsDto>().not.toHaveProperty('mrrCents');
  expectTypeOf<BillingStatsDto>().not.toHaveProperty('mrrCurrency');
  expectTypeOf<BillingStatsDto>().not.toHaveProperty('mixedCurrencies');
  expectTypeOf<BillingStatsDto>().not.toHaveProperty('revenueLast30dCents');
  expectTypeOf<BillingStatsDto>().not.toHaveProperty('revenueCurrency');

  // A coupon carries basis points or an amount per currency.
  expectTypeOf<CouponDto>().not.toHaveProperty('amountOff');
  expectTypeOf<CouponDto>().not.toHaveProperty('currency');
  expectTypeOf<CouponDto>().not.toHaveProperty('percentOff');
  expectTypeOf<CreateCouponRequest>().not.toHaveProperty('amountOff');
  expectTypeOf<ValidateCouponResultDto>().not.toHaveProperty('amountOff');

  // The operator's plan has no amount, currency or per-unit price of its own, in or out.
  expectTypeOf<PlanDto>().not.toHaveProperty('amount');
  expectTypeOf<PlanDto>().not.toHaveProperty('currency');
  expectTypeOf<PlanDto>().not.toHaveProperty('pricePerUnitCents');
  expectTypeOf<CreatePlanRequest>().not.toHaveProperty('amount');
  expectTypeOf<CreatePlanRequest>().not.toHaveProperty('pricePerUnitCents');
  expectTypeOf<UpdatePlanRequest>().not.toHaveProperty('amount');
  expectTypeOf<UpdatePlanRequest['price']>().toEqualTypeOf<{ currency: string; amount: number } | null | undefined>();
  expectTypeOf<UpdatePlanRequest['localPrices']>().toEqualTypeOf<PlanDto['localPrices'] | undefined>();

  // Who is on a price, and whether its amount can change, is the operator's to know.
  expectTypeOf<PlanPriceDto['amountEditable']>().toEqualTypeOf<boolean>();
  expectTypeOf<PlanPriceDto['liveSubscriptions']>().toEqualTypeOf<number>();
  expectTypeOf<PlanPriceDto['openCheckouts']>().toEqualTypeOf<number>();
  expectTypeOf<PublicPlanDto['prices'][number]>().not.toHaveProperty('amountEditable');
  expectTypeOf<PublicPlanDto['prices'][number]>().not.toHaveProperty('liveSubscriptions');
  expectTypeOf<PublicPlanDto['prices'][number]>().not.toHaveProperty('openCheckouts');

  // The public plan carries no operator configuration.
  expectTypeOf<PublicPlanDto>().not.toHaveProperty('metadata');
  expectTypeOf<PublicPlanDto>().not.toHaveProperty('applicationId');
  expectTypeOf<PublicPlanDto>().not.toHaveProperty('pricePerUnitCents');
  // The plan's own amount and currency left the public plan: `price` is the price.
  expectTypeOf<PublicPlanDto>().not.toHaveProperty('amount');
  expectTypeOf<PublicPlanDto>().not.toHaveProperty('currency');
  expectTypeOf<ResolvedPriceDto['requestedCurrency']>().toEqualTypeOf<string | null>();
  expectTypeOf<PublicPlanDto>().not.toHaveProperty('registrationStatus');

  // Webhook payloads.
  expectTypeOf<PaymentWebhookData['payment']['verification']>().toEqualTypeOf<'verified' | 'unverified'>();
  expectTypeOf<PaymentWebhookData['payment']['refundedAmount']>().toEqualTypeOf<number>();
  expectTypeOf<SubscriptionWebhookData['subscription']['currency']>().toEqualTypeOf<string | null>();

  // A code the money model removed is not one the guard can narrow to.
  expectTypeOf<'COUPON_CURRENCY_MISMATCH'>().not.toMatchTypeOf<BillingMoneyErrorCode>();
  expectTypeOf<'COUPON_CURRENCY_REQUIRED'>().not.toMatchTypeOf<BillingMoneyErrorCode>();
  expectTypeOf<'COUPON_CURRENCY_NOT_COVERED'>().toMatchTypeOf<BillingMoneyErrorCode>();
  expectTypeOf<'COUPON_LIMIT_BELOW_REDEEMED'>().toMatchTypeOf<BillingMoneyErrorCode>();

  // No country header helper besides the hint: `x-country` is gone.
  expectTypeOf(sdk.VISITOR_COUNTRY_HINT_HEADER).toBeString();
  // @ts-expect-error there is no export for the removed header
  void sdk.COUNTRY_HEADER;
}
