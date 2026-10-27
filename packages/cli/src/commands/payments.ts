/**
 * `rekey payments …`, one payment as its operator reads it.
 *
 *   rekey payments show <paymentId> --app <id>
 *
 * It says whether the payment can be refunded through Rekey, and why not when
 * it cannot.
 */

import type { Command } from 'commander';
import { formatMoney, refundBlockedMessage, type TenantPaymentDto } from '@rekey.dev/node';
import { ok, readGlobalOpts } from '../lib/output.js';
import { operatorRequest } from '../lib/api.js';
import { appPath } from '../lib/input.js';

/**
 * One payment as lines: what was charged, what was refunded, who took it and
 * whether it can be refunded.
 *
 * @example
 * paymentLines(payment)[0]; // 'pay_1  $19.00  PARTIALLY_REFUNDED  verified  2026-10-02T10:00:00.000Z'
 */
export function paymentLines(payment: TenantPaymentDto): string[] {
  const charge = payment.providerPaymentId === null ? '' : ` (${payment.providerPaymentId})`;
  const payer = payment.endUserId === null ? 'none' : `${payment.endUserEmail ?? payment.endUserId} (${payment.endUserId})`;
  return [
    [payment.id, formatMoney(payment.amount, payment.currency), payment.status, payment.verification, payment.createdAt].join('  '),
    `    refunded: ${formatMoney(payment.refundedAmount, payment.currency)} of ${formatMoney(payment.amount, payment.currency)}`,
    `    provider: ${payment.provider ?? 'not recorded'}${charge}`,
    `    end user: ${payer}`,
    `    subscription: ${payment.subscriptionId ?? 'none'}`,
    payment.refundBlockedReason === null
      ? '    refundable: yes'
      : `    refundable: no (${payment.refundBlockedReason}). ${refundBlockedMessage(payment.refundBlockedReason)}`,
  ];
}

/**
 * Attach `rekey payments`.
 *
 * @example
 * registerPaymentsCommand(program);
 */
export function registerPaymentsCommand(program: Command): void {
  const payments = program.command('payments').description('Read one payment (uses REKEY_OPERATOR_TOKEN)');

  payments
    .command('show')
    .description('Show one payment, and whether it can be refunded through Rekey')
    .argument('<paymentId>', 'Payment id')
    .requiredOption('--app <id>', 'Application id')
    .action(async function (this: Command, paymentId: string, opts: { app: string }) {
      const ctx = readGlobalOpts(this);
      const data = await operatorRequest<TenantPaymentDto>({
        ctx,
        method: 'GET',
        path: appPath(opts.app, `/payments/${encodeURIComponent(paymentId)}`),
        scope: 'read',
      });
      ok(ctx, data, (payment) => {
        process.stdout.write(`${paymentLines(payment).join('\n')}\n`);
      });
    });
}
