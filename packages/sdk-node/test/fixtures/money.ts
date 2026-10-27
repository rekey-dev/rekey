/**
 * Wire fixtures for the money model, each parsed by the schema the API
 * serializes with. A fixture that drifts from the schema fails here, at
 * import, before any test reads it.
 */

import {
  BillingConfigSchema,
  BillingCredentialDtoSchema,
  BillingLogPageSchema,
  BillingProviderModulesDtoSchema,
  BillingStatsDtoSchema,
  CheckoutResultDtoSchema,
  CouponDtoSchema,
  CouponWithStatsDtoSchema,
  PagedSchema,
  PlanDtoSchema,
  PlanPriceDtoSchema,
  PriceFallbackSummarySchema,
  PublicPlanDtoSchema,
  ReconciliationReportSchema,
  RefundDtoSchema,
  ReportingCurrencyDtoSchema,
  RoutingPreviewDtoSchema,
  TenantPaymentDtoSchema,
  ValidateCouponResultDtoSchema,
} from '@rekey.dev/shared-types';

const AT = '2026-10-12T09:00:00.000Z';
const PAGE = { total: 1, limit: 50, offset: 0, hasMore: false };

const USD_PRICE = { id: 'pp_usd', currency: 'USD', amount: 1900, countries: [], isDefault: true, archived: false as const };
const INR_PRICE = { id: 'pp_inr', currency: 'INR', amount: 149900, countries: ['IN'], isDefault: false, archived: false as const };
const RESOLVED_INR = { id: 'pp_inr', currency: 'INR', amount: 149900, formatted: '₹1,499.00', isDefault: false, reason: 'country' as const, requestedCurrency: null };
const RESOLVED_USD = { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00', isDefault: true, reason: 'fallback' as const, requestedCurrency: 'INR' };

const planCommon = {
  id: 'plan_1',
  slug: 'pro',
  name: 'Pro',
  kind: 'SUBSCRIPTION',
  interval: 'MONTH',
  isFree: false,
  trialDays: null,
  licenseKind: null,
  licenseSeatsAllowed: null,
  licenseDurationDays: null,
  meterSlug: null,
  creditsAmount: null,
};

export const PRICE_FALLBACK = {
  requested: { id: 'pp_inr', currency: 'INR', amount: 149900, formatted: '₹1,499.00' },
  charged: { id: 'pp_usd', currency: 'USD', amount: 1900, formatted: '$19.00' },
  reason: 'no_provider_for_currency' as const,
};

export const PUBLIC_PLANS = PagedSchema(PublicPlanDtoSchema).parse({
  items: [{ ...planCommon, price: RESOLVED_INR, prices: [USD_PRICE, INR_PRICE], checkout: { ready: true } }],
  page: PAGE,
});

const REGISTERED = { status: 'REGISTERED', error: null };
/** A price being registered: its amount is fixed, and nobody is on it yet. */
const UNUSED = { amountEditable: false, liveSubscriptions: 0, openCheckouts: 0 };

export const OPERATOR_PLANS = PagedSchema(PlanDtoSchema).parse({
  items: [
    {
      ...planCommon,
      price: { ...RESOLVED_USD, reason: 'default', requestedCurrency: null },
      applicationId: 'app_1',
      prices: [
        { ...USD_PRICE, registration: REGISTERED, amountEditable: false, liveSubscriptions: 3, openCheckouts: 0 },
        { ...INR_PRICE, registration: { status: 'PENDING', error: null }, ...UNUSED },
      ],
      defaultPriceId: 'pp_usd',
      localPrices: 'INHERIT',
      active: true,
      registrationStatus: 'REGISTERED',
      registrationError: null,
      metadata: {},
      createdAt: AT,
      updatedAt: AT,
      checkout: { ready: true, blockers: [] },
    },
  ],
  page: PAGE,
});

export const PLAN_PRICE = PlanPriceDtoSchema.parse({ ...INR_PRICE, registration: { status: 'PENDING', error: null }, ...UNUSED });

const subscription = {
  id: 'sub_1',
  applicationId: 'app_1',
  endUserId: 'eu_1',
  planId: 'plan_1',
  status: 'PENDING',
  currentPeriodEnd: null,
  cancelAt: null,
  canceledAt: null,
  provider: 'stripe',
  providerSubId: null,
  metadata: {},
  createdAt: AT,
  updatedAt: AT,
  beneficiaryOrgId: null,
  trialEndsAt: null,
  price: null,
};

export const CHECKOUT_WITH_FALLBACK = CheckoutResultDtoSchema.parse({
  url: 'https://checkout.stripe.example/c/cs_1',
  subscription,
  discountAmount: 0,
  currency: 'USD',
  unitAmount: 1900,
  price: RESOLVED_USD,
  priceFallback: PRICE_FALLBACK,
  provider: 'stripe',
  warnings: [],
  mode: 'redirect',
  checkoutSessionId: 'chs_1',
});

export const COUPON_QUOTE = ValidateCouponResultDtoSchema.parse({
  coupon: { code: 'LAUNCH50', discountType: 'PERCENT', basisPoints: 5000 },
  plan: { slug: 'pro', name: 'Pro' },
  price: RESOLVED_INR,
  priceFallback: null,
  currency: 'INR',
  amount: 149900,
  discountAmount: 75000,
  amountAfterDiscount: 74900,
  formatted: { discount: '₹750.00', total: '₹749.00' },
});

const couponBase = {
  id: 'cpn_1',
  applicationId: 'app_1',
  planSlugs: [],
  active: true,
  startsAt: null,
  endsAt: null,
  maxRedemptions: null,
  maxRedemptionsPerUser: null,
  metadata: {},
  createdAt: AT,
  updatedAt: AT,
};

export const AMOUNT_COUPON = CouponDtoSchema.parse({
  ...couponBase,
  code: 'FIVEOFF',
  discountType: 'AMOUNT',
  basisPoints: null,
  amounts: [
    { currency: 'INR', amountOff: 40000 },
    { currency: 'USD', amountOff: 500 },
  ],
  currencies: [],
  coveredCurrencies: ['INR', 'USD'],
});

export const PERCENT_COUPON = CouponDtoSchema.parse({
  ...couponBase,
  id: 'cpn_2',
  code: 'LAUNCH',
  discountType: 'PERCENT',
  basisPoints: 1500,
  amounts: [],
  currencies: [],
  coveredCurrencies: null,
});

export const COUPONS_WITH_STATS = PagedSchema(CouponWithStatsDtoSchema).parse({
  items: [
    {
      ...AMOUNT_COUPON,
      redemptionCount: 3,
      discountIssuedByCurrency: [
        { currency: 'USD', amount: 1000, redemptions: 2 },
        { currency: 'INR', amount: 40000, redemptions: 1 },
      ],
    },
  ],
  page: PAGE,
});

export const PAYMENTS = PagedSchema(TenantPaymentDtoSchema).parse({
  items: [
    {
      id: 'pay_1',
      endUserId: 'eu_1',
      subscriptionId: 'sub_1',
      amount: 1900,
      currency: 'USD',
      status: 'PARTIALLY_REFUNDED',
      refundedAmount: 500,
      verification: 'verified',
      provider: 'stripe',
      refundable: true,
      refundBlockedReason: null,
      providerPaymentId: 'in_1',
      description: null,
      createdAt: AT,
      endUserEmail: 'buyer@example.com',
    },
  ],
  page: PAGE,
});

const refund = {
  id: 'rf_1',
  paymentId: 'pay_1',
  providerRefundId: 're_1',
  amount: 500,
  currency: 'USD',
  status: 'succeeded',
  reason: 'Duplicate charge',
  initiatedBy: 'operator',
  createdAt: AT,
};

export const REFUNDS = PagedSchema(RefundDtoSchema).parse({ items: [refund], page: PAGE });

const entry = {
  id: 'be_1',
  applicationId: 'app_1',
  tier: 'PERMANENT',
  occurredAt: AT,
  recordedAt: AT,
  actor: { type: 'system', id: null },
  endUserId: 'eu_1',
  subscriptionId: null,
  checkoutSessionId: 'chs_1',
  paymentId: null,
  refundId: null,
  planId: 'plan_1',
  planPriceId: 'pp_usd',
  couponId: null,
  provider: 'stripe',
  providerEventId: null,
  currency: 'USD',
  amount: 1900,
};

const fallbackEntry = {
  ...entry,
  type: 'checkout.price_fallback',
  data: {
    planSlug: 'pro',
    requested: { planPriceId: 'pp_inr', currency: 'INR', amount: 149900 },
    charged: { planPriceId: 'pp_usd', currency: 'USD', amount: 1900 },
    reason: 'no_provider_for_currency',
    buyerCountry: 'IN',
    buyerCountrySource: 'vouched',
  },
};

export const LOG_PAGE_ONE = BillingLogPageSchema.parse({
  items: [{ ...fallbackEntry, seq: '42' }],
  nextCursor: '42',
  actors: null,
});

export const LOG_PAGE_TWO = BillingLogPageSchema.parse({
  items: [
    {
      ...entry,
      id: 'be_0',
      seq: '41',
      type: 'payment.refunded',
      paymentId: 'pay_1',
      refundId: 'rf_1',
      checkoutSessionId: null,
      amount: 500,
      data: { refundedAmount: 500, totalRefunded: 500, providerRefundId: 're_1', initiatedBy: 'operator', reasonCode: null },
    },
  ],
  nextCursor: null,
  actors: null,
});

export const PRICE_FALLBACKS = PriceFallbackSummarySchema.parse({
  from: '2026-10-05T09:00:00.000Z',
  to: AT,
  total: 12,
  groups: [
    { planSlug: 'pro', requestedCurrency: 'INR', chargedCurrency: 'USD', country: 'IN', count: 12, lastOccurredAt: AT },
  ],
});

export const RECONCILIATION = ReconciliationReportSchema.parse({
  applicationId: 'app_1',
  from: '2026-10-05T09:00:00.000Z',
  to: AT,
  paymentsLoggedSince: '2026-10-01T00:00:00.000Z',
  subscriptionsLoggedSince: '2026-10-01T00:00:00.000Z',
  checked: { payments: 10, refunds: 1, subscriptions: 4, events: 30 },
  counts: { payment_without_event: 1, event_without_payment: 0, refund_mismatch: 0, subscription_without_event: 0 },
  findings: [
    {
      kind: 'payment_without_event',
      paymentId: 'pay_9',
      subscriptionId: null,
      eventSeq: null,
      currency: 'USD',
      amount: 1900,
      refundedOnPayment: null,
      refundRowsTotal: null,
      refundEventsTotal: null,
      at: AT,
    },
  ],
  truncated: false,
});

/** As the API answers it: every setting present, the unset ones at their defaults. */
export const BILLING_CONFIG = BillingConfigSchema.parse({ enabled: true, provider: 'stripe' });

export const REPORTING_CURRENCY = ReportingCurrencyDtoSchema.parse({ reportingCurrency: 'EUR', name: 'Euro' });

export const STATS = BillingStatsDtoSchema.parse({
  activeSubscriptions: 4,
  pastDueSubscriptions: 0,
  canceledLast30d: 1,
  newSubscriptionsLast30d: 2,
  unpricedLiveSubscriptions: 0,
  reportingCurrency: 'EUR',
  mrr: [
    { currency: 'EUR', mrrCents: 0, activeSubscriptions: 0 },
    { currency: 'INR', mrrCents: 149900, activeSubscriptions: 1 },
    { currency: 'USD', mrrCents: 5700, activeSubscriptions: 3 },
  ],
  revenueLast30d: [{ currency: 'EUR', grossCents: 0, refundedCents: 0, netCents: 0, payments: 0 }],
  unverified: [{ currency: 'USD', amountCents: 190000, payments: 1 }],
  paymentsLast30d: { succeeded: 9, failed: 1 },
  monthlyRevenue: [{ currency: 'EUR', months: [{ month: '2026-10', amountCents: 0 }] }],
});

export const ROUTING_PREVIEW = RoutingPreviewDtoSchema.parse({
  country: 'IN',
  countrySource: 'vouched',
  localPrices: 'trusted',
  onUnavailableCurrency: 'fallback',
  items: [
    {
      plan: { id: 'plan_1', slug: 'pro', name: 'Pro', kind: 'SUBSCRIPTION' },
      price: RESOLVED_INR,
      priceFallback: null,
      provider: 'razorpay',
      providerReason: 'country',
      refusal: null,
      coupon: {
        code: 'FIVEOFF',
        discount: {
          currency: 'INR',
          discountAmount: 40000,
          amountAfterDiscount: 109900,
          formatted: { discount: '₹400.00', total: '₹1,099.00' },
        },
        refusal: null,
      },
      summary: 'A buyer in India buying Pro pays ₹1,499.00 through Razorpay.',
    },
  ],
});

const status = {
  enabled: true,
  mode: 'live',
  countries: ['IN'],
  currencies: ['INR'],
  unsupportedCurrencies: [],
  priority: 0,
  webhookConfigured: true,
};

export const PROVIDER_MODULES = BillingProviderModulesDtoSchema.parse({
  providers: [
    {
      name: 'razorpay',
      label: 'Razorpay',
      docsUrl: 'https://razorpay.com/docs',
      defaultCountries: ['IN'],
      supportedCurrencies: ['INR', 'USD'],
      preselectedCurrencies: ['INR'],
      priority: 20,
      capabilities: { checkout: true, oneTime: true, discounts: { oneTime: true, recurring: false } },
      credentialFields: [{ key: 'keyId', label: 'Key id', secret: false, optional: false }],
      configured: true,
      status,
    },
  ],
});

export const PROVIDER_CURRENCIES = BillingCredentialDtoSchema.array().parse([
  { ...status, provider: 'razorpay', configured: true },
]);

export const LOG_PAGE_WITH_ACTORS = BillingLogPageSchema.parse({
  items: [{ ...fallbackEntry, seq: '42' }],
  nextCursor: null,
  actors: {
    endUsers: [{ id: 'eu_1', state: 'known', email: 'buyer@example.com' }],
    operators: [{ id: 'op_1', state: 'known', name: 'Olga Owner', email: 'olga@example.com' }],
  },
});
