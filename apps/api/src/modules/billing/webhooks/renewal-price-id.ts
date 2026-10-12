/**
 * Puts the provider's price id on a renewal payment whose payload does not
 * carry one, by asking the provider which plan the subscription bills.
 *
 * Only for a module that declares `renewalPriceFromSubscription`. A read that
 * fails leaves the event without an id: the payment is still recorded, and
 * the applier compares nothing. It never fails the delivery, because a
 * provider that is briefly unreachable must not stop money being recorded.
 */

import type { Application } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { BillingProviderName } from '../credentials.service.js';
import type { DomainBillingEvent } from '../providers/module-types.js';

/**
 * @example
 * const events = await withRenewalPriceIds(translated, application, 'paypal', req.log);
 */
export async function withRenewalPriceIds(
  events: DomainBillingEvent[],
  application: Application,
  providerName: string,
  log: FastifyBaseLogger,
): Promise<DomainBillingEvent[]> {
  const needsRead = (event: DomainBillingEvent): boolean =>
    event.type === 'payment.succeeded' && event.providerSubscriptionId !== null && event.providerPriceId === undefined;
  if (!events.some(needsRead)) return events;

  // Dynamic import breaks the webhooks ↔ providers/index cycle.
  const { getProviderForApplication } = await import('../providers/index.js');
  const out: DomainBillingEvent[] = [];
  for (const event of events) {
    if (event.type !== 'payment.succeeded' || event.providerSubscriptionId === null || event.providerPriceId !== undefined) {
      out.push(event);
      continue;
    }
    try {
      const provider = await getProviderForApplication(application, providerName as BillingProviderName);
      const planId = (await provider.getSubscription?.(event.providerSubscriptionId))?.planId ?? null;
      out.push(planId === null ? event : { ...event, providerPriceId: planId });
    } catch (err) {
      log.warn(
        { err, provider: providerName, providerSubscriptionId: event.providerSubscriptionId },
        'could not read the plan a renewal bills from the provider; the payment is recorded without a price id',
      );
      out.push(event);
    }
  }
  return out;
}
