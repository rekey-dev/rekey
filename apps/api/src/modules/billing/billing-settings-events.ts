/**
 * The billing log's record of a change to an Application's billing settings
 * that decides what a buyer is charged: whose word about a country selects a
 * local price, and what a checkout does with a named currency nobody can
 * charge.
 */

import type { BillingConfig } from '@rekey.dev/shared-types';
import { recordBillingEvent } from '../billing-log/index.js';

type Tx = Parameters<typeof recordBillingEvent>[0];

/**
 * Write one event per setting whose value changed, in the transaction that
 * changed it. A patch that sends the value a setting already has writes
 * nothing.
 *
 * @example
 * await prisma.$transaction(async (tx) => {
 *   await tx.application.update({ where: { id }, data: { billingConfig: next } });
 *   await recordBillingSettingsChanges(tx, { applicationId: id, before: current, after: next, operatorId });
 * });
 */
export async function recordBillingSettingsChanges(
  tx: Tx,
  args: {
    applicationId: string;
    before: Pick<BillingConfig, 'localPrices' | 'onUnavailableCurrency'>;
    after: Pick<BillingConfig, 'localPrices' | 'onUnavailableCurrency'>;
    /** The operator who made the change. Left out for a change no operator made. */
    operatorId: string | undefined;
  },
): Promise<void> {
  const { applicationId, before, after } = args;
  const actor = args.operatorId === undefined ? ({ type: 'system' } as const) : ({ type: 'operator', id: args.operatorId } as const);
  if (before.localPrices !== after.localPrices) {
    await recordBillingEvent(tx, {
      type: 'settings.local_prices_changed',
      applicationId,
      actor,
      data: { before: before.localPrices, after: after.localPrices },
    });
  }
  if (before.onUnavailableCurrency !== after.onUnavailableCurrency) {
    await recordBillingEvent(tx, {
      type: 'settings.unavailable_currency_changed',
      applicationId,
      actor,
      data: { before: before.onUnavailableCurrency, after: after.onUnavailableCurrency },
    });
  }
}
