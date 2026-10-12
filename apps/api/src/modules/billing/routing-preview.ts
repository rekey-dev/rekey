/**
 * The routing preview: for a buyer in one country, which price and currency
 * each plan would be charged at, which provider would charge it, and why.
 *
 * It answers with the functions checkout runs: `previewCheckoutPrice`, which
 * goes through `decideCheckoutPrice`, and `previewCheckoutProvider`, which
 * goes through `pickProvider`, both handed the same rows. Nothing here selects a price or a provider. The one thing it adds is
 * a description of the provider that was picked, read off that provider's own
 * settings after the pick.
 *
 * A coupon is judged by the two functions checkout judges it with, in its
 * order: `couponsService.quote` (the decision inside `validate`) against the
 * price charged, then `decideCheckoutDiscount` against the provider picked.
 *
 * It reads only: no checkout session, no subscription row, no provider call,
 * no billing event.
 */

import type { Application } from '@prisma/client';
import {
  BillingConfigSchema,
  formatMoney,
  type RoutingPreviewCoupon,
  type RoutingPreviewDto,
  type RoutingPreviewItem,
  type RoutingPreviewRequest,
} from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import type { PlanWithDefaultPrice } from '../plans/default-price.js';
import { toPriceFallbackDto, toResolvedPriceDto } from '../plans/plan-dto.js';
import { plansService } from '../plans/plans.service.js';
import type { BuyerCountry } from './buyer-country.js';
import { additionalPricesWhere, unavailableCurrencyRule } from './checkout-price-resolution.js';
import {
  loadCheckoutPreviewRows,
  previewCheckoutPrice,
  previewCheckoutProvider,
  type CheckoutPreviewRows,
  type CheckoutPricePreview,
} from './checkout-preview.js';
import {
  billingCredentialsService,
  canCharge,
  type BillingProviderName,
  type EnabledProvider,
} from './credentials.service.js';
import { costsNothing } from './free-plan.js';
import { isOneTimePlan } from './plan-kind.js';
import { decideCheckoutDiscount } from './checkout-discount.js';
import { couponsService } from '../coupons/coupons.service.js';

const MAX_PLANS = 100;

type ProviderReason = NonNullable<RoutingPreviewItem['providerReason']>;

/**
 * Describes a pick `pickProvider` already made. It never chooses: it reads
 * the picked provider's own row.
 */
function describePick(args: {
  picked: BillingProviderName;
  preview: CheckoutPricePreview;
  providers: readonly EnabledProvider[];
  country: string;
  currency: string | undefined;
}): ProviderReason {
  if (args.preview.boundProvider === args.picked) return 'bound';
  if (args.preview.namedProvider === args.picked) return 'named';
  const row = args.providers.find((provider) => provider.provider === args.picked);
  if (row?.countries.includes(args.country)) return 'country';
  const currency = args.currency;
  const capable = currency === undefined ? args.providers : args.providers.filter((provider) => canCharge(provider, currency));
  return capable.length === 1 ? 'only_capable' : 'priority';
}

const PROVIDER_BECAUSE: Record<ProviderReason, (provider: string, country: string) => string> = {
  bound: (provider) => `this buyer already pays through ${provider}`,
  named: (provider) => `the checkout names ${provider}`,
  country: (provider, country) => `${provider} is set for buyers in ${country}`,
  only_capable: (provider) => `${provider} is the only enabled provider that can charge that currency`,
  priority: (provider) => `${provider} has the best priority among the providers that can charge that currency`,
};

const PRICE_BECAUSE = {
  bound: (currency: string) => `they already pay in ${currency}`,
  requested: (currency: string) => `the server asked for ${currency}`,
  country: (currency: string, plan: string) => `${plan} is priced in ${currency} for that country`,
  default: (currency: string, plan: string) => `${currency} is the default price of ${plan}`,
  fallback: () => 'no enabled provider can charge the price selected first',
} as const;

function summarise(args: {
  plan: PlanWithDefaultPrice;
  country: string;
  item: Pick<RoutingPreviewItem, 'price' | 'priceFallback' | 'provider' | 'providerReason'>;
}): string {
  const { plan, country, item } = args;
  const who = `A buyer in ${country} buying ${plan.name}`;
  const through =
    item.provider !== null && item.providerReason !== null
      ? ` through ${item.provider}, because ${PROVIDER_BECAUSE[item.providerReason](item.provider, country)}`
      : '';
  if (item.price === null) return `${who} is not charged a flat price; the checkout goes${through || ' to no provider'}.`;
  const why = PRICE_BECAUSE[item.price.reason](item.price.currency, plan.name);
  const fellBack =
    item.priceFallback === null
      ? ''
      : ` ${item.priceFallback.requested.formatted} was selected first and cannot be charged, so the default price is charged instead.`;
  return `${who} pays ${item.price.formatted}, because ${why}${through === '' ? '' : `, and pays${through}`}.${fellBack}`;
}

async function previewCoupon(args: {
  application: Application;
  plan: PlanWithDefaultPrice;
  code: string;
  endUserId: string | undefined;
  preview: CheckoutPricePreview;
  picked: BillingProviderName;
}): Promise<RoutingPreviewCoupon> {
  const { priced, price } = args.preview;
  try {
    const quoted = await couponsService.quote({
      applicationId: args.application.id,
      endUserId: args.endUserId,
      code: args.code,
      planSlug: args.plan.slug,
      amount: priced.amount,
      currency: priced.currency,
      fallbackFrom: price?.fallback?.requested.currency,
    });
    decideCheckoutDiscount({
      plan: priced,
      provider: args.picked,
      isOneTime: isOneTimePlan(args.plan),
      coupon: { couponId: quoted.coupon.id, code: quoted.coupon.code, discountAmount: quoted.discountAmount },
    });
    const currency = priced.currency.toUpperCase();
    return {
      code: quoted.coupon.code,
      discount: {
        currency,
        discountAmount: quoted.discountAmount,
        amountAfterDiscount: quoted.amountAfterDiscount,
        formatted: {
          discount: formatMoney(quoted.discountAmount, currency),
          total: formatMoney(quoted.amountAfterDiscount, currency),
        },
      },
      refusal: null,
    };
  } catch (err) {
    if (!(err instanceof RekeyError)) throw err;
    return { code: args.code, discount: null, refusal: { code: err.code, message: err.message, fix: err.fix ?? null } };
  }
}

function couponSentence(coupon: RoutingPreviewCoupon | null): string {
  if (coupon === null) return '';
  if (coupon.discount !== null) {
    return ` With coupon ${coupon.code}, ${coupon.discount.formatted.discount} comes off and they pay ${coupon.discount.formatted.total}.`;
  }
  return ` With coupon ${coupon.code} the checkout is refused: ${coupon.refusal?.message ?? ''}`;
}

async function previewPlan(args: {
  application: Application;
  plan: PlanWithDefaultPrice;
  buyer: BuyerCountry;
  request: RoutingPreviewRequest;
  rows: CheckoutPreviewRows;
}): Promise<RoutingPreviewItem> {
  const { application, plan, buyer, request, rows } = args;
  const planOut = { id: plan.id, slug: plan.slug, name: plan.name, kind: plan.kind };
  try {
    const input = {
      application,
      plan,
      endUserId: request.endUserId ?? '',
      buyer,
      callerIsSecretKey: buyer.source === 'declared',
      requestedCurrency: request.currency,
      onUnavailableCurrency: request.onUnavailableCurrency,
      provider: request.provider as BillingProviderName | undefined,
      rows,
    };
    const preview = await previewCheckoutPrice(input);
    const picked = await previewCheckoutProvider(input);
    const currency = costsNothing(plan) ? undefined : preview.priced.currency;
    const item = {
      price: toResolvedPriceDto(preview.price),
      priceFallback: toPriceFallbackDto(preview.price),
      provider: picked,
      providerReason: describePick({ picked, preview, providers: rows.providers, country: buyer.country, currency }),
    };
    const coupon =
      request.couponCode === undefined
        ? null
        : await previewCoupon({ application, plan, code: request.couponCode, endUserId: request.endUserId, preview, picked });
    return {
      plan: planOut,
      ...item,
      refusal: null,
      coupon,
      summary: summarise({ plan, country: buyer.country, item }) + couponSentence(coupon),
    };
  } catch (err) {
    if (!(err instanceof RekeyError)) throw err;
    return {
      plan: planOut,
      price: null,
      priceFallback: null,
      provider: null,
      providerReason: null,
      refusal: { code: err.code, message: err.message, fix: err.fix ?? null },
      coupon: null,
      summary: `A buyer in ${buyer.country} buying ${plan.name} is refused: ${err.message}`,
    };
  }
}

/**
 * What checkout would do for a buyer in `request.country`, for one plan or
 * for every active plan: a fixed number of queries whatever the plan count.
 *
 * @example
 * const { items } = await previewRouting(application, { country: 'IN', plan: 'pro', countrySource: 'vouched' });
 * items[0]?.summary; // 'A buyer in IN buying Pro pays ₹1,499.00, because Pro is priced in INR for that country, and pays through razorpay, because razorpay is set for buyers in IN.'
 */
export async function previewRouting(application: Application, request: RoutingPreviewRequest): Promise<RoutingPreviewDto> {
  const buyer: BuyerCountry = { country: request.country.toUpperCase(), source: request.countrySource };
  const billingConfig = BillingConfigSchema.parse(application.billingConfig);
  const plans =
    request.plan === undefined
      ? await plansService.listForApplication(application.id, false, { take: MAX_PLANS })
      : [await planByIdOrSlug(application.id, request.plan)];

  let rows: CheckoutPreviewRows;
  if (request.endUserId !== undefined) {
    rows = await loadCheckoutPreviewRows(
      { application, endUserId: request.endUserId, buyer, callerIsSecretKey: buyer.source === 'declared' },
      plans,
    );
  } else {
    const [providers, prices] = await Promise.all([
      billingCredentialsService.listCheckoutEnabled(application.id, buyer.country),
      prisma.planPrice.findMany({ where: additionalPricesWhere(plans) }),
    ]);
    const pricesByPlan: CheckoutPreviewRows['pricesByPlan'] = new Map();
    for (const price of prices) pricesByPlan.set(price.planId, [...(pricesByPlan.get(price.planId) ?? []), price]);
    rows = { candidates: [], providers, pricesByPlan };
  }

  const items: RoutingPreviewItem[] = [];
  for (const plan of plans) items.push(await previewPlan({ application, plan, buyer, request, rows }));
  return {
    country: buyer.country,
    countrySource: buyer.source,
    localPrices: billingConfig.localPrices,
    onUnavailableCurrency: unavailableCurrencyRule(request.onUnavailableCurrency, billingConfig),
    items,
  };
}

async function planByIdOrSlug(applicationId: string, idOrSlug: string): Promise<PlanWithDefaultPrice> {
  const byId = await prisma.plan.findFirst({ where: { applicationId, id: idOrSlug }, select: { slug: true } });
  return plansService.getBySlug(applicationId, byId?.slug ?? idOrSlug);
}
