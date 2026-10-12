/**
 * Compile-time checks that the portal's hand-written money types still fit
 * what the API sends.
 *
 * The portal reads a few fields of each answer through small types of its
 * own. Each line here fails `tsc` when a value of the wire type could no
 * longer be read as the portal's type. A portal type may leave fields out; it
 * may not disagree about one it names.
 */

import type { PortalPaymentDto } from '@rekey.dev/react';
import type { CheckoutPageOrder, PriceFallbackDto, PublicPlanDto, SelfSubscriptionDto, ValidateCouponResultDto } from '@rekey.dev/shared-types';
import type { ReviewedPlan } from '@/components/plan-review';
import type { PricePlan, RefundablePayment } from './format';
import type { OfferedPlan } from './plan-offer';
import type { catalogueFallbackSentence, priceFallbackSentence } from './price-notice';

type Fits<Wire, Portal> = [Wire] extends [Portal] ? true : { wire: Wire; doesNotFit: Portal };

export const CONTRACT: {
  pricePlan: Fits<PublicPlanDto, PricePlan>;
  offeredPlan: Fits<PublicPlanDto, OfferedPlan>;
  reviewedPlan: Fits<PublicPlanDto, ReviewedPlan>;
  cataloguePrice: Fits<PublicPlanDto['price'], Parameters<typeof catalogueFallbackSentence>[0]>;
  payment: Fits<PortalPaymentDto, RefundablePayment>;
  subscriptionPrice: Fits<SelfSubscriptionDto['price'], { formatted: string } | null>;
  checkoutFallback: Fits<NonNullable<CheckoutPageOrder['priceFallback']>, Parameters<typeof priceFallbackSentence>[0]>;
  quoteFallback: Fits<ValidateCouponResultDto['priceFallback'], PriceFallbackDto | null>;
} = {
  pricePlan: true,
  offeredPlan: true,
  reviewedPlan: true,
  cataloguePrice: true,
  payment: true,
  subscriptionPrice: true,
  checkoutFallback: true,
  quoteFallback: true,
};
