/**
 * The operator client: the billing routes a workspace member calls, with an
 * operator personal access token in place of an Application secret key.
 */

import { RekeyError } from '@rekey.dev/shared-types/error';
import { Rekey, type RekeyConfig } from '../index.js';
import { OperatorBillingLogClient } from './billing-log.js';
import { OperatorCouponsClient, OperatorPlansClient } from './catalog.js';
import { OperatorBillingClient, OperatorPaymentsClient } from './money.js';
import { segment, type OperatorTransport } from './transport.js';

/** Configuration for a {@link RekeyOperator}. */
export interface RekeyOperatorConfig extends Pick<RekeyConfig, 'apiUrl' | 'fetch' | 'timeoutMs' | 'signal'> {
  /**
   * An operator personal access token (`rp_op_...`), created in the panel
   * under Account, API tokens. Reads need the `read` scope and writes
   * `applications:write`. It acts as a workspace member: keep it on a server.
   */
  operatorToken: string;
  /** The Application these calls act on. */
  applicationId: string;
}

/**
 * Operator access to one Application's billing: prices, coupons, payments and
 * their refunds, the billing log, reporting and the routing preview. Issuing
 * a refund, changing provider credentials and changing the billing settings
 * need an operator session, so they are in the panel and not here.
 *
 * {@link Rekey} acts as your Application towards its end users, with a secret
 * key. This client acts as a member of the workspace that owns the
 * Application, with an operator token, and calls the routes the panel calls.
 * Use it for back-office tools, scripts and reports, never on a path a
 * visitor can reach.
 *
 * @example
 * ```ts
 * import { RekeyOperator, formatMoney } from '@rekey.dev/node';
 *
 * const operator = new RekeyOperator({
 *   apiUrl: process.env.REKEY_URL!,
 *   operatorToken: process.env.REKEY_OPERATOR_TOKEN!,
 *   applicationId: process.env.REKEY_APPLICATION_ID!,
 * });
 *
 * const stats = await operator.billing.stats();
 * for (const row of stats.mrr) console.log(formatMoney(row.mrrCents, row.currency));
 * ```
 */
export class RekeyOperator {
  /** Plans as the operator reads them, and each plan's prices. */
  public readonly plans: OperatorPlansClient;
  /** Coupons: a percentage, or an amount per currency. */
  public readonly coupons: OperatorCouponsClient;
  /** Payments and the refunds recorded against them. */
  public readonly payments: OperatorPaymentsClient;
  /** The billing log, its per-record trails, price fallbacks and reconciliation. */
  public readonly billingLog: OperatorBillingLogClient;
  /** The reporting currency, stats per currency, the routing preview and provider currencies. */
  public readonly billing: OperatorBillingClient;

  private readonly config: RekeyOperatorConfig;

  constructor(config: RekeyOperatorConfig) {
    if (!config.operatorToken || !config.operatorToken.startsWith('rp_op_')) {
      throw new RekeyError({
        code: 'CONFIG_INVALID_OPERATOR_TOKEN',
        message: 'RekeyOperator requires an `operatorToken` (starts with `rp_op_`).',
        fix: 'Create one in the panel under Account, API tokens, with the `read` scope (and `applications:write` to change prices, plans, coupons or the reporting currency), then pass it as `operatorToken`. An Application secret key belongs to `new Rekey(...)`.',
      });
    }
    if (!config.applicationId) {
      throw new RekeyError({
        code: 'CONFIG_MISSING_APPLICATION_ID',
        message: 'RekeyOperator requires `applicationId`.',
        fix: 'Pass the id of the Application to act on. The panel shows it on the Application page.',
      });
    }
    this.config = config;
    const client = new Rekey({
      apiUrl: config.apiUrl,
      secretKey: config.operatorToken,
      ...(config.fetch !== undefined && { fetch: config.fetch }),
      ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
      ...(config.signal !== undefined && { signal: config.signal }),
    });
    const transport: OperatorTransport = {
      base: `/api/v1/tenant/applications/${segment(config.applicationId)}`,
      send: (method, path, body, headers) => client.send(method, path, body, headers),
    };
    this.plans = new OperatorPlansClient(transport);
    this.coupons = new OperatorCouponsClient(transport);
    this.payments = new OperatorPaymentsClient(transport);
    this.billingLog = new OperatorBillingLogClient(transport);
    this.billing = new OperatorBillingClient(transport);
  }

  /**
   * The same client for another Application of the workspace.
   *
   * @example
   * ```ts
   * const staging = operator.forApplication('app_staging');
   * ```
   */
  forApplication(applicationId: string): RekeyOperator {
    return new RekeyOperator({ ...this.config, applicationId });
  }
}

export { OperatorBillingLogClient, BillingLogEventsClient } from './billing-log.js';
export type { BillingLogListOptions, BillingLogTrailOptions, BillingLogPeriod } from './billing-log.js';
export { OperatorCouponsClient, OperatorPlansClient, OperatorPlanPricesClient } from './catalog.js';
export { OperatorBillingClient, OperatorPaymentsClient, OperatorRefundsClient } from './money.js';
export type { OperatorPaymentsListOptions, RoutingPreviewInput } from './money.js';
