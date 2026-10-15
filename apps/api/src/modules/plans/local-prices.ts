/**
 * A plan's own rule for local prices: whether a buyer's country may select
 * one of its prices in another currency.
 */

import type { Plan, PlanLocalPrices } from '@prisma/client';
import { z } from 'zod';
import { recordBillingEvent } from '../billing-log/index.js';

export const PLAN_LOCAL_PRICES = ['INHERIT', 'TRUSTED', 'OFF'] as const satisfies readonly PlanLocalPrices[];

/** `localPrices` as a plan update states it. */
export const PlanLocalPricesBody = z.enum(PLAN_LOCAL_PRICES);

/** What each value does, for a route or a tool that takes one. */
export const PLAN_LOCAL_PRICES_DESCRIPTION =
  "Whether a buyer's country may select one of this plan's prices in another currency. " +
  "`INHERIT`: the plan follows the Application's `billingConfig.localPrices`. " +
  '`TRUSTED`: only a country your server declared or a trusted proxy vouched for selects a local price, ' +
  'whatever the Application allows. `OFF`: a country never selects one, so every buyer is charged the default ' +
  'price unless your server names a `currency` at checkout. A subscriber already paying in a currency keeps it.';

const WORD = { INHERIT: 'inherit', TRUSTED: 'trusted', OFF: 'off' } as const;

/**
 * Log that a plan's rule changed, in the transaction that changed it. Nothing
 * is written when the value is the one the plan already had.
 *
 * @example
 * await updatePlanAndDefaultPrice(plan.id, { localPrices: 'OFF' }, { onChange: (tx, updated, _change, previous) =>
 *   recordLocalPricesChange(tx, updated, previous, { operatorId }),
 * );
 */
export async function recordLocalPricesChange(
  tx: Parameters<typeof recordBillingEvent>[0],
  plan: Pick<Plan, 'id' | 'applicationId' | 'slug' | 'localPrices'>,
  previous: Pick<Plan, 'localPrices'>,
  actor: { operatorId: string } | undefined,
): Promise<void> {
  if (previous.localPrices === plan.localPrices) return;
  await recordBillingEvent(tx, {
    type: 'plan.local_prices_changed',
    applicationId: plan.applicationId,
    actor: actor === undefined ? { type: 'system' } : { type: 'operator', id: actor.operatorId },
    planId: plan.id,
    data: { planSlug: plan.slug, before: WORD[previous.localPrices], after: WORD[plan.localPrices] },
  });
}
