/**
 * The currency an Application reports in. It is also the currency of a plan
 * with no flat price wherever one is needed: a free plan registered with a
 * provider, or shown to its operator.
 */

import {
  BillingConfigSchema,
  currencyRecord,
  currencySellability,
  type ReportingCurrencyDto,
} from '@rekey.dev/shared-types';
import { forgetDashboard } from '../../lib/dashboard-cache.js';
import { RekeyError } from '../../lib/error.js';
import { prisma } from '../../lib/prisma.js';
import { recordBillingEvent } from '../billing-log/index.js';
import { billingStatsCacheKey } from './stats-cache-key.js';

/**
 * @example
 * reportingCurrency(application); // 'USD'
 */
export function reportingCurrency(application: { billingConfig: unknown }): string {
  const parsed = BillingConfigSchema.safeParse(application.billingConfig);
  return (parsed.success ? parsed.data.reportingCurrency : 'USD').toUpperCase();
}

/**
 * @example
 * const currency = await reportingCurrencyOf(plan.applicationId);
 */
export async function reportingCurrencyOf(applicationId: string): Promise<string> {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { billingConfig: true },
  });
  return reportingCurrency({ billingConfig: application?.billingConfig ?? {} });
}

/** The currency with its English name, as the reporting-currency routes return it. */
export function reportingCurrencyDto(currency: string): ReportingCurrencyDto {
  return { reportingCurrency: currency, name: currencyRecord(currency)?.name ?? currency };
}

const UNSELLABLE_BECAUSE = {
  unknown: 'is not an ISO 4217 currency code',
  not_money: 'is not a currency a price can be in',
  withdrawn: 'has been withdrawn',
  three_decimal: 'has three decimal places, which no provider charges as written',
} as const;

/**
 * Set the currency an Application reports in, and write
 * `settings.reporting_currency_changed` with the value before and after in
 * the same transaction. Setting the value it already has changes nothing and
 * writes no event.
 *
 * The Application row is locked for the read and the write, so two operators
 * changing it at once leave a chain of events in which each `before` is the
 * previous `after`. Only the one key is written: the rest of `billingConfig`
 * is not read back and rewritten.
 *
 * Nothing is converted. Totals in other currencies stay listed beside this
 * one.
 *
 * @example
 * await setReportingCurrency({ applicationId, currency: 'eur', operatorId });
 * // { reportingCurrency: 'EUR', changed: true }
 */
export async function setReportingCurrency(args: {
  applicationId: string;
  currency: string;
  operatorId: string;
}): Promise<{ reportingCurrency: string; changed: boolean }> {
  const code = args.currency.trim().toUpperCase();
  const sellability = currencySellability(code);
  if (!sellability.sellable) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_REPORTING_CURRENCY_INVALID',
      message: `"${code}" cannot be the reporting currency: it ${UNSELLABLE_BECAUSE[sellability.reason]}.`,
      fix: 'Send `reportingCurrency` as the three-letter ISO 4217 code of a currency a plan can be priced in, such as USD, EUR or INR.',
    });
  }
  const changed = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ billing_config: unknown }>>`
      SELECT "billing_config" FROM "applications" WHERE "id" = ${args.applicationId} FOR NO KEY UPDATE`;
    if (row === undefined) {
      throw new RekeyError({
        statusCode: 404,
        code: 'APPLICATION_NOT_FOUND',
        message: `Application "${args.applicationId}" not found.`,
        fix: 'List the Applications of this workspace with GET /api/v1/tenant/applications.',
      });
    }
    const before = reportingCurrency({ billingConfig: row.billing_config });
    if (before === code) return false;
    await tx.$executeRaw`
      UPDATE "applications"
         SET "billing_config" = "billing_config" || jsonb_build_object('reportingCurrency', ${code}::text),
             "updated_at" = now()
       WHERE "id" = ${args.applicationId}`;
    await recordBillingEvent(tx, {
      type: 'settings.reporting_currency_changed',
      applicationId: args.applicationId,
      actor: { type: 'operator', id: args.operatorId },
      data: { before: /^[A-Z]{3}$/.test(before) ? before : null, after: code },
    });
    return true;
  });
  if (changed) forgetDashboard(billingStatsCacheKey(args.applicationId));
  return { reportingCurrency: code, changed };
}
