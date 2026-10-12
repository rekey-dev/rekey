/**
 * `rekey refunds …`, the refunds of one payment.
 *
 *   rekey refunds list <paymentId> --app <id>
 *   rekey refunds create <paymentId> --app <id> [--amount n] [--reason "..."] [--idempotency-key k]
 *
 * `create` asks the provider that took the payment to pay money back. It
 * needs REKEY_OPERATOR_TOKEN with the `billing:write` scope.
 */

import type { Command } from 'commander';
import { formatMoney, type CreateRefundRequest, type Paged, type RefundDto, type RefundResultDto } from '@rekey.dev/node';
import { ok, readGlobalOpts } from '../lib/output.js';
import { listQuery, operatorRequest, readListOpts, withListOptions } from '../lib/api.js';
import { MINOR_UNITS_HELP, appPath, readInteger } from '../lib/input.js';

/** The largest amount a payment can hold: a 32-bit integer of minor units. */
const MAX_AMOUNT = 2_147_483_647;

function refundsPath(app: string, paymentId: string): string {
  return appPath(app, `/payments/${encodeURIComponent(paymentId)}/refunds`);
}

function refundLine(refund: RefundDto): string {
  return [
    refund.id,
    formatMoney(refund.amount, refund.currency),
    refund.status,
    `by ${refund.initiatedBy}`,
    refund.createdAt,
    ...(refund.reason === null ? [] : [refund.reason]),
  ].join('  ');
}

/**
 * Attach `rekey refunds`.
 *
 * @example
 * registerRefundsCommand(program);
 */
export function registerRefundsCommand(program: Command): void {
  const refunds = program.command('refunds').description('Refund a payment, and read its refunds (uses REKEY_OPERATOR_TOKEN)');

  withListOptions(
    refunds
      .command('list')
      .description('List every refund recorded against a payment, oldest first')
      .argument('<paymentId>', 'Payment id')
      .requiredOption('--app <id>', 'Application id'),
  ).action(async function (this: Command, paymentId: string, opts: { app: string; limit?: string; offset?: string }) {
    const ctx = readGlobalOpts(this);
    const data = await operatorRequest<Paged<RefundDto>>({
      ctx,
      method: 'GET',
      path: `${refundsPath(opts.app, paymentId)}${listQuery(readListOpts(ctx, opts))}`,
      scope: 'billing:read',
    });
    ok(ctx, { refunds: data.items, page: data.page }, (d) => {
      if (d.refunds.length === 0) process.stdout.write('(no refunds)\n');
      for (const refund of d.refunds) process.stdout.write(`${refundLine(refund)}\n`);
      if (d.page.hasMore) {
        process.stdout.write(
          `\nShowing ${d.refunds.length} of ${d.page.total}. Pass --offset ${d.page.offset + d.page.limit} for the next page.\n`,
        );
      }
    });
  });

  refunds
    .command('create')
    .description('Refund a payment at its provider, in full or in part. Does not cancel a subscription or take back credits')
    .argument('<paymentId>', 'Payment id')
    .requiredOption('--app <id>', 'Application id')
    .option(
      '--amount <n>',
      `Integer, ${MINOR_UNITS_HELP}. The currency is the payment's. Left out, everything not yet refunded`,
    )
    .option('--reason <text>', 'Kept on the refund, and sent to the provider where it takes one')
    .option(
      '--idempotency-key <key>',
      'What makes two requests one refund at the provider. Left out, the API derives it from the payment, what was refunded and the amount',
    )
    .action(async function (
      this: Command,
      paymentId: string,
      opts: { app: string; amount?: string; reason?: string; idempotencyKey?: string },
    ) {
      const ctx = readGlobalOpts(this);
      const body: CreateRefundRequest = {
        ...(opts.amount !== undefined && {
          amount: readInteger(ctx, opts.amount, { code: 'CLI_REFUNDS_AMOUNT_INVALID', what: '--amount' }, 1, MAX_AMOUNT),
        }),
        ...(opts.reason !== undefined && { reason: opts.reason }),
        ...(opts.idempotencyKey !== undefined && { idempotencyKey: opts.idempotencyKey }),
      };
      const data = await operatorRequest<RefundResultDto>({
        ctx,
        method: 'POST',
        path: refundsPath(opts.app, paymentId),
        body,
        scope: 'billing:write',
      });
      ok(ctx, data, ({ refund, payment }) => {
        process.stdout.write(`✓ ${refundLine(refund)}\n`);
        process.stdout.write(
          `    ${payment.id}: ${formatMoney(payment.refundedAmount, payment.currency)} of ${formatMoney(payment.amount, payment.currency)} refunded, ${payment.status}\n`,
        );
      });
    });
}
