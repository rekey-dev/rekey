/**
 * `rekey refunds list <paymentId> --app <id>`, the refunds of one payment.
 *
 * Issuing a refund needs an operator session, so it is done in the panel.
 */

import type { Command } from 'commander';
import { formatMoney, type Paged, type RefundDto } from '@rekey.dev/node';
import { ok, readGlobalOpts } from '../lib/output.js';
import { listQuery, operatorRequest, readListOpts, withListOptions } from '../lib/api.js';
import { appPath } from '../lib/input.js';

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
  const refunds = program.command('refunds').description("Read a payment's refunds (uses REKEY_OPERATOR_TOKEN)");

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
      scope: 'read',
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
}
