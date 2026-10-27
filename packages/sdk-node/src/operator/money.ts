import type {
  BillingConfig,
  BillingCredentialDto,
  BillingProviderModulesDto,
  BillingStatsDto,
  ListPage,
  Paged,
  RefundDto,
  ReportingCurrencyDto,
  RoutingPreviewDto,
  TenantPaymentDto,
  TenantPaymentsListQuery,
} from '@rekey.dev/shared-types';
import { pageQuery, queryString, segment, type OperatorTransport } from './transport.js';

/** Filters for {@link OperatorPaymentsClient.list}. `from` and `to` bound `createdAt`, inclusive. */
export interface OperatorPaymentsListOptions extends Omit<TenantPaymentsListQuery, 'from' | 'to'> {
  from?: Date | string;
  to?: Date | string;
}

/** Refunds of one payment. */
export class OperatorRefundsClient {
  constructor(private readonly transport: OperatorTransport) {}

  private path(paymentId: string): string {
    return `${this.transport.base}/payments/${segment(paymentId)}/refunds`;
  }

  /**
   * Every refund recorded against a payment, oldest first: those a provider
   * reported and those issued through Rekey. The payment's `refundedAmount`
   * is the sum of the ones that have not failed.
   *
   * @example
   * ```ts
   * const { items } = await operator.payments.refunds.list('pay_123');
   * const failed = items.filter((refund) => refund.status === 'failed');
   * ```
   *
   * @throws {RekeyError} `PAYMENT_NOT_FOUND` (404).
   */
  list(paymentId: string, page?: ListPage): Promise<Paged<RefundDto>> {
    return this.transport.send('GET', `${this.path(paymentId)}${queryString(pageQuery(page))}`);
  }
}

/** Every payment of the Application, as its operator reads them. */
export class OperatorPaymentsClient {
  /** The refunds of one payment. */
  public readonly refunds: OperatorRefundsClient;

  constructor(private readonly transport: OperatorTransport) {
    this.refunds = new OperatorRefundsClient(transport);
  }

  /**
   * Payments, newest first unless `sort` and `order` say otherwise. Each row
   * carries `refundedAmount`, the running total of its refunds, in the minor
   * unit of its own `currency`, and whether it is `refundable` through Rekey.
   *
   * @example
   * ```ts
   * const { items } = await operator.payments.list({ status: 'PARTIALLY_REFUNDED', limit: 100 });
   * for (const payment of items) {
   *   console.log(payment.id, formatMoney(payment.amount - payment.refundedAmount, payment.currency));
   * }
   * ```
   */
  list(options: OperatorPaymentsListOptions = {}): Promise<Paged<TenantPaymentDto>> {
    const { status, from, to, sort, order, limit, offset } = options;
    return this.transport.send(
      'GET',
      `${this.transport.base}/payments${queryString({ status, from, to, sort, order, limit, offset })}`,
    );
  }

  /**
   * One payment by id, as {@link list} returns it. `refundable` says whether
   * a refund issued from the panel would reach the provider that took it, and
   * `refundBlockedReason` why not: the judgement the refund makes before it
   * asks a provider. The provider can still refuse a refund. Issuing one needs
   * an operator session, so this client cannot.
   *
   * @example
   * ```ts
   * const payment = await operator.payments.get('pay_123');
   * if (payment.refundable) {
   *   console.log(`Refund ${payment.id} from the panel, under Payments.`);
   * } else if (payment.refundBlockedReason !== null) {
   *   console.log(refundBlockedMessage(payment.refundBlockedReason));
   * }
   * ```
   *
   * @throws {RekeyError} `PAYMENT_NOT_FOUND` (404).
   */
  get(paymentId: string): Promise<TenantPaymentDto> {
    return this.transport.send('GET', `${this.transport.base}/payments/${segment(paymentId)}`);
  }
}

/** What to preview: the body of the routing preview. */
export interface RoutingPreviewInput {
  /** The buyer's country, ISO 3166-1 alpha-2. */
  country: string;
  /** A plan's id or slug. Left out, every active plan is previewed (at most 100). */
  plan?: string;
  /**
   * How the checkout would learn the country. `vouched` (the default): a
   * browser, placed by a trusted proxy. `hint`: a browser stating its own
   * country. `declared`: your server with the secret key.
   */
  countrySource?: 'declared' | 'vouched' | 'hint';
  /** Preview for this end user, given what they already pay for. */
  endUserId?: string;
  /** A currency the server would name. Only a `declared` preview may name one. */
  currency?: string;
  onUnavailableCurrency?: 'fallback' | 'refuse';
  /** A provider the checkout would name. */
  provider?: string;
  /** A coupon code the checkout would carry. */
  couponCode?: string;
}

/** Billing settings, reporting, the reporting currency, the routing preview and the providers' currencies. */
export class OperatorBillingClient {
  constructor(private readonly transport: OperatorTransport) {}

  /**
   * The Application's billing settings, complete: a setting nobody has
   * changed reads as its default.
   *
   * @example
   * ```ts
   * const { onUnavailableCurrency } = await operator.billing.getConfig(); // 'fallback'
   * ```
   *
   * @throws {RekeyError} `APPLICATION_NOT_FOUND` (404).
   */
  async getConfig(): Promise<BillingConfig> {
    const application = await this.transport.send<{ billingConfig: BillingConfig }>('GET', this.transport.base);
    return application.billingConfig;
  }

  /**
   * The currency the Application reports in: the first entry of every list in
   * {@link stats}. Nothing is converted into it. `USD` until set.
   *
   * @example
   * ```ts
   * const { reportingCurrency, name } = await operator.billing.getReportingCurrency();
   * ```
   */
  getReportingCurrency(): Promise<ReportingCurrencyDto> {
    return this.transport.send('GET', `${this.transport.base}/billing/reporting-currency`);
  }

  /**
   * Set the currency the Application reports in (ISO 4217, any case). It
   * changes which currency the stats lead with and nothing else: no price, no
   * subscription and no payment changes, and nothing is converted. Written to
   * the billing log as `settings.reporting_currency_changed`.
   *
   * @example
   * ```ts
   * await operator.billing.setReportingCurrency('EUR');
   * ```
   *
   * @throws {RekeyError} `BILLING_REPORTING_CURRENCY_INVALID` (400) for a code no price can be in.
   */
  setReportingCurrency(currency: string): Promise<ReportingCurrencyDto> {
    return this.transport.send('PUT', `${this.transport.base}/billing/reporting-currency`, {
      reportingCurrency: currency,
    });
  }

  /**
   * Subscription counts, MRR, revenue and payment counts. Money is reported
   * per currency and never added across currencies: `mrr`, `revenueLast30d`
   * and `monthlyRevenue` hold one entry per currency, the reporting currency
   * first. Revenue counts verified payments only, net of refunds.
   * `unverified` is money a provider charged that Rekey recorded and did not
   * apply; it is in no revenue figure.
   *
   * @example
   * ```ts
   * const stats = await operator.billing.stats();
   * for (const row of stats.mrr) console.log(row.currency, formatMoney(row.mrrCents, row.currency));
   * if (stats.unverified.length > 0) console.warn('Charges waiting to be resolved', stats.unverified);
   * ```
   */
  stats(): Promise<BillingStatsDto> {
    return this.transport.send('GET', `${this.transport.base}/billing/stats`);
  }

  /**
   * Which price and provider a buyer in a country would get, decided by the
   * functions checkout itself runs. It opens no checkout, writes nothing and
   * calls no provider.
   *
   * Each item has the `price` charged, a `priceFallback` when the price
   * selected first cannot be charged, the `provider` and why, the `refusal`
   * checkout would answer with, and a one-sentence `summary`. With
   * `couponCode`, each item also says what the coupon takes off, or why a
   * checkout carrying it would be refused.
   *
   * A preview that names a `currency` and no `onUnavailableCurrency` gets the
   * Application's default, as a checkout does. The result's
   * `onUnavailableCurrency` is the rule that was applied.
   *
   * @example
   * ```ts
   * const preview = await operator.billing.previewRouting({ country: 'IN', plan: 'pro', couponCode: 'LAUNCH' });
   * for (const item of preview.items) {
   *   console.log(item.summary);
   *   if (item.coupon?.refusal) console.log(item.coupon.refusal.code);
   * }
   * ```
   */
  previewRouting(input: RoutingPreviewInput): Promise<RoutingPreviewDto> {
    return this.transport.send('POST', `${this.transport.base}/billing/checkout/preview`, input);
  }

  /**
   * Every provider module this deployment has, with the currencies each can
   * charge (`supportedCurrencies`, or `all-sellable`) and how it stands on
   * this Application (`status`, null until configured).
   *
   * @example
   * ```ts
   * const { providers } = await operator.billing.providers();
   * const paypal = providers.find((provider) => provider.name === 'paypal');
   * const canChargeInr = paypal?.supportedCurrencies === 'all-sellable' || paypal?.supportedCurrencies.includes('INR');
   * ```
   */
  providers(): Promise<BillingProviderModulesDto> {
    return this.transport.send('GET', `${this.transport.base}/billing/providers`);
  }

  /**
   * The providers configured for this Application, with the currencies each
   * account charges. `unsupportedCurrencies` lists stored codes the provider
   * does not offer: routing skips them. Never returns a credential.
   *
   * @example
   * ```ts
   * const rows = await operator.billing.providerCurrencies();
   * const chargeable = new Set(rows.filter((row) => row.enabled).flatMap((row) => row.currencies));
   * ```
   */
  providerCurrencies(): Promise<BillingCredentialDto[]> {
    return this.transport.send('GET', `${this.transport.base}/billing-credentials`);
  }
}
