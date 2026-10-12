/**
 * API answers as the portal receives them, each parsed through the schema the
 * API serialises with. A field the API renames or drops fails here, where
 * the portal's own types (casts of the same answers) would not.
 */

import {
  CheckoutPageViewSchema,
  CheckoutResultDtoSchema,
  PublicPlanDtoSchema,
  SelfSubscriptionDtoSchema,
  ValidateCouponResultDtoSchema,
  type CheckoutPageOrder,
  type CheckoutPageView,
  type CheckoutResultDto,
  type PublicPlanDto,
  type SelfSubscriptionDto,
  type ValidateCouponResultDto,
} from '@rekey.dev/shared-types';

const NOW = '2026-10-12T09:00:00.000Z';

const USD_PRICE = { id: 'pp_usd', currency: 'USD', amount: 1900, countries: [], isDefault: true, archived: false };
const INR_PRICE = { id: 'pp_inr', currency: 'INR', amount: 149900, countries: ['IN'], isDefault: false, archived: false };

function planBase(id: string, slug: string, name: string) {
  return {
    id,
    slug,
    name,
    kind: 'SUBSCRIPTION',
    interval: 'MONTH',
    isFree: false,
    trialDays: null,
    licenseKind: null,
    licenseSeatsAllowed: null,
    licenseDurationDays: null,
    meterSlug: null,
    creditsAmount: null,
    prices: [USD_PRICE, INR_PRICE],
    checkout: { ready: true },
  };
}

/** `GET /billing/plans` rows. Each `price` is what that buyer's checkout would charge. */
export const PLANS = {
  /** A buyer nothing else applies to: the default price. */
  proDefault: PublicPlanDtoSchema.parse({
    ...planBase('plan_pro', 'pro', 'Pro'),
    price: { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00', isDefault: true, reason: 'default', requestedCurrency: null },
  }),
  /** A buyer in India, where the plan has a local price a provider can charge. */
  proInIndia: PublicPlanDtoSchema.parse({
    ...planBase('plan_pro', 'pro', 'Pro'),
    price: { id: 'pp_inr', currency: 'INR', amount: 149900, formatted: '₹1,499.00', isDefault: false, reason: 'country', requestedCurrency: null },
  }),
  /** A buyer in India while no provider can charge rupees: the default price, as a fallback. */
  proFallback: PublicPlanDtoSchema.parse({
    ...planBase('plan_pro', 'pro', 'Pro'),
    price: { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00', isDefault: true, reason: 'fallback', requestedCurrency: 'INR' },
  }),
  /** A subscriber who pays in rupees, after the provider stopped charging them. */
  proBoundUnchargeable: PublicPlanDtoSchema.parse({
    ...planBase('plan_pro', 'pro', 'Pro'),
    price: { id: 'pp_inr', currency: 'INR', amount: 149900, formatted: '₹1,499.00', isDefault: false, reason: 'bound', requestedCurrency: null },
    checkout: { ready: false },
  }),
  free: PublicPlanDtoSchema.parse({
    ...planBase('plan_free', 'free', 'Free'),
    isFree: true,
    prices: [],
    price: null,
    checkout: { ready: false },
  }),
  metered: PublicPlanDtoSchema.parse({
    ...planBase('plan_api', 'api', 'API'),
    kind: 'USAGE',
    meterSlug: 'requests',
    prices: [],
    price: null,
  }),
  team: PublicPlanDtoSchema.parse({
    ...planBase('plan_team', 'team', 'Team'),
    prices: [{ ...USD_PRICE, id: 'pp_team', amount: 4900 }],
    price: { id: 'pp_team', currency: 'USD', amount: 4900, formatted: '$49.00', isDefault: true, reason: 'default', requestedCurrency: null },
  }),
} satisfies Record<string, PublicPlanDto>;

/** A subscription as its holder reads it, on the rupee price their checkout fixed. */
export function subscription(over: Partial<SelfSubscriptionDto> = {}): SelfSubscriptionDto {
  return SelfSubscriptionDtoSchema.parse({
    id: 'sub_1',
    applicationId: 'app_1',
    endUserId: 'eu_1',
    planId: 'plan_pro',
    status: 'ACTIVE',
    currentPeriodEnd: '2026-11-12T09:00:00.000Z',
    cancelAt: null,
    canceledAt: null,
    provider: 'razorpay',
    providerCapabilities: null,
    providerSubId: 'sub_RZP1',
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    beneficiaryOrgId: null,
    trialEndsAt: null,
    price: { id: 'pp_inr', currency: 'INR', amount: 149900, formatted: '₹1,499.00' },
    ...over,
  }) as SelfSubscriptionDto;
}

/** `POST /billing/checkout` for a buyer in India while rupees cannot be charged. */
export const CHECKOUT_WITH_FALLBACK: CheckoutResultDto = CheckoutResultDtoSchema.parse({
  url: 'https://portal.example/acme/checkout/chk_test_abc',
  subscription: { ...subscription({ status: 'PENDING', provider: 'stripe', providerSubId: null }), price: null },
  discountAmount: 0,
  currency: 'USD',
  unitAmount: 1900,
  price: { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00', isDefault: true, reason: 'fallback', requestedCurrency: 'INR' },
  priceFallback: {
    requested: { id: 'pp_inr', currency: 'INR', amount: 149900, formatted: '₹1,499.00' },
    charged: { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00' },
    reason: 'no_provider_for_currency',
  },
  provider: 'stripe',
  warnings: [],
  mode: 'embedded',
  checkoutSessionId: 'cs_1',
});

/** `POST /billing/coupons/validate`: 15% off the dollar price, rounded toward the buyer. */
export const COUPON_QUOTE: ValidateCouponResultDto = ValidateCouponResultDtoSchema.parse({
  coupon: { code: 'spring15', discountType: 'PERCENT', basisPoints: 1500 },
  plan: { slug: 'pro', name: 'Pro' },
  price: { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00', isDefault: true, reason: 'default', requestedCurrency: null },
  priceFallback: null,
  currency: 'USD',
  amount: 1900,
  discountAmount: 285,
  amountAfterDiscount: 1615,
  formatted: { discount: '$2.85', total: '$16.15' },
});

/** The same quote for a buyer whose rupee price cannot be charged. */
export const COUPON_QUOTE_WITH_FALLBACK: ValidateCouponResultDto = ValidateCouponResultDtoSchema.parse({
  ...COUPON_QUOTE,
  price: { ...COUPON_QUOTE.price, reason: 'fallback', requestedCurrency: 'INR' },
  priceFallback: CHECKOUT_WITH_FALLBACK.priceFallback,
});

const MERCHANT: CheckoutPageOrder['merchant'] = {
  displayName: 'Acme',
  logoUrl: null,
  primaryColor: null,
  backgroundColor: null,
  surfaceColor: null,
  supportEmail: 'help@acme.example',
  supportUrl: null,
  termsUrl: null,
  privacyUrl: null,
  refundUrl: null,
};

/**
 * `GET /checkout-sessions/:token` for an open session: the price the session
 * was opened at, its discount and what it charges today, all the server's.
 */
export function checkoutView(money: {
  currency: string;
  amount: number;
  discountAmount: number;
  totalDueToday: number;
}): CheckoutPageView & { order: CheckoutPageOrder } {
  const view = CheckoutPageViewSchema.parse({
    status: 'open',
    slug: 'acme',
    paymentMode: 'live',
    provider: 'stripe',
    returnUrl: 'https://app.acme.example/billing',
    order: {
      merchant: MERCHANT,
      plan: { name: 'Pro', amount: money.amount, currency: money.currency, interval: 'MONTH', kind: 'recurring' },
      discountAmount: money.discountAmount,
      totalDueToday: money.totalDueToday,
      buyerEmail: 'buyer@example.com',
      successUrl: 'https://app.acme.example/billing?paid=1',
      cancelUrl: 'https://app.acme.example/billing',
      manageUrl: null,
      expiresAt: '2026-10-13T09:00:00.000Z',
      priceFallback: null,
      client: { provider: 'stripe', publishableKey: 'pk_live_x', clientSecret: 'cs_live_secret', sdk: 'elements' },
    },
  });
  return view as CheckoutPageView & { order: CheckoutPageOrder };
}
