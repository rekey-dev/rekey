/**
 * Operator MCP tools that change billing settings or move money: the
 * reporting currency and a refund.
 *
 * Each calls the service function its REST route calls, so the billing log
 * gets the same event (`settings.reporting_currency_changed`,
 * `payment.refunded`) naming the operator.
 *
 * `create_refund` is an admin tool, like `cancel_subscription`: it pays money
 * out and cannot be undone.
 */

import { z } from 'zod';
import { refundsService } from '../billing/refunds.service.js';
import { reportingCurrencyDto, setReportingCurrency } from '../billing/reporting-currency.js';
import type { OperatorTool } from './operator-tools.js';
import { loadAppInTenant } from './operator-write-tools.js';
import { ApplicationIdArg, CurrencyArg, MINOR_UNITS, defineTool } from './tool-definition.js';

export const operatorBillingWriteTools: OperatorTool[] = [
  defineTool({
    name: 'set_reporting_currency',
    description:
      'Set the currency an application reports in. It changes which currency the stats lead with and which is ' +
      'offered first for a new price or coupon. It changes no price, no subscription and no payment, and ' +
      'converts nothing. Refused with BILLING_REPORTING_CURRENCY_INVALID for a code a plan cannot be priced in. ' +
      'Sending the current value changes nothing. Returns the reporting currency as stored and `changed`.',
    write: true,
    args: z.object({ applicationId: ApplicationIdArg, reportingCurrency: CurrencyArg }).strict(),
    annotations: { idempotentHint: true },
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId);
      const result = await setReportingCurrency({
        applicationId: app.id,
        currency: input.reportingCurrency,
        operatorId: ctx.tenantUserId,
      });
      return { ...reportingCurrencyDto(result.reportingCurrency), changed: result.changed };
    },
  }),
  defineTool({
    name: 'create_refund',
    description:
      'Refund a recorded payment, in full or in part. Asks the provider that took the payment to pay money ' +
      `back, then records the refund. \`amount\` is an ${MINOR_UNITS}, in the payment's own currency; leave it ` +
      'out to refund everything that has not been refunded. A payment can be refunded more than once, up to ' +
      'its amount. Repeating the same call is one refund: the key sent to the provider is derived from the ' +
      'payment, what was already refunded and the amount, unless `idempotencyKey` is sent. Refunding does not ' +
      'cancel a subscription or take back credits or licences. IRREVERSIBLE: money leaves the provider ' +
      'account. Refused with BILLING_REFUND_AMOUNT_EXCEEDED, BILLING_PAYMENT_NOT_REFUNDABLE, ' +
      'BILLING_PAYMENT_ALREADY_REFUNDED, BILLING_REFUND_UNSUPPORTED or BILLING_REFUND_REJECTED. Returns the ' +
      'refund and the payment with its new `refundedAmount`.',
    write: true,
    admin: true,
    annotations: { destructiveHint: true, openWorldHint: true },
    args: z
      .object({
        applicationId: ApplicationIdArg,
        paymentId: z.string().min(1).max(200).describe('The payment id, from recent_payments.'),
        amount: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`How much to pay back: ${MINOR_UNITS}, in the payment's currency. Leave it out to refund everything that remains.`),
        reason: z.string().min(1).max(500).optional().describe('Kept on the refund. Sent to the provider where it takes one.'),
        idempotencyKey: z.string().min(1).max(200).optional(),
      })
      .strict(),
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId);
      return refundsService.issue({
        application: app,
        paymentId: input.paymentId,
        amount: input.amount,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        actorId: ctx.tenantUserId,
      });
    },
  }),
];
