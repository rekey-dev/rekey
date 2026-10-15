/**
 * Compile-time checks that the panel's hand-written API types still fit what
 * the API sends.
 *
 * `api.ts` types its responses by hand, so a field the API renamed or made
 * nullable compiled fine and failed in front of an operator. Each line here
 * fails `tsc` when a value of the wire type (inferred from the schema in
 * `@rekey.dev/shared-types`) could no longer be read as the panel's type.
 * A panel type may leave fields out; it may not disagree about one it names.
 */

import type {
  ApplicationDto,
  BillingConfig,
  BillingCredentialDto,
  BillingProviderModuleDto,
  BillingStatsDto,
  CouponWithStatsDto,
  PlanCheckoutBlockerDto,
  PlanDto,
  PlanPriceDto,
  RefundDto,
  RefundResultDto,
  ResolvedPriceDto,
  TenantPaymentDto,
} from '@rekey.dev/shared-types';
import type {
  ApplicationRow,
  BillingCredentialRow,
  BillingProviderDescriptor,
  BillingStatsRow,
  CouponRow,
  PaymentRow,
  PlanBlocker,
  PlanPrice,
  PlanRow,
  RefundResult,
  RefundRow,
  ResolvedPrice,
} from './api';

type MoneySetting = 'localPrices' | 'reportingCurrency' | 'onUnavailableCurrency';
/** Fields of an Application the API sends on every route, which the panel reads without a guard. */
type ApplicationAlways = 'environment' | 'promotedAt' | 'disabledAt' | 'disabledReason' | 'reportingTimezone';

type Fits<Wire, Panel> = [Wire] extends [Panel] ? true : { wire: Wire; doesNotFit: Panel };

/** The plan's `kind` is an open string on the wire, so the panel narrows it itself. */
type WirePlan = Omit<PlanDto, 'kind'> & { kind: PlanRow['kind'] };
/** A payment's `status` is an open string on the wire for the same reason. */
type WirePayment = Omit<TenantPaymentDto, 'status'> & { status: PaymentRow['status'] };

export const CONTRACT: {
  plan: Fits<WirePlan, PlanRow>;
  planPrice: Fits<PlanPriceDto, PlanPrice>;
  planBlocker: Fits<PlanCheckoutBlockerDto, PlanBlocker>;
  resolvedPrice: Fits<ResolvedPriceDto, ResolvedPrice>;
  coupon: Fits<CouponWithStatsDto, CouponRow>;
  billingStats: Fits<BillingStatsDto, BillingStatsRow>;
  payment: Fits<WirePayment, PaymentRow>;
  refund: Fits<RefundDto, RefundRow>;
  refundResult: Fits<RefundResultDto, RefundResult>;
  credential: Fits<BillingCredentialDto, BillingCredentialRow>;
  billingConfig: Fits<BillingConfig, ApplicationRow['billingConfig']>;
  /**
   * The other way round for the money settings: the API always sends them,
   * so the panel type may not call one optional and default it itself.
   */
  billingSettings: Fits<Pick<ApplicationRow['billingConfig'], MoneySetting>, Pick<BillingConfig, MoneySetting>>;
  application: Fits<Pick<ApplicationDto, ApplicationAlways>, Pick<ApplicationRow, ApplicationAlways>>;
  /** And the other way round: the panel may not call one of them optional. */
  applicationAlways: Fits<Pick<ApplicationRow, ApplicationAlways>, Pick<ApplicationDto, ApplicationAlways>>;
  /** `capabilities` is an open record on the wire; the panel names the flags it reads. */
  providerModule: Fits<Omit<BillingProviderModuleDto, 'capabilities'>, Omit<BillingProviderDescriptor, 'capabilities'>>;
} = {
  plan: true,
  planPrice: true,
  planBlocker: true,
  resolvedPrice: true,
  coupon: true,
  billingStats: true,
  payment: true,
  refund: true,
  refundResult: true,
  credential: true,
  billingConfig: true,
  billingSettings: true,
  providerModule: true,
  application: true,
  applicationAlways: true,
};
