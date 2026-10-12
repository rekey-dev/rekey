/**
 * Registers an additional plan price with a provider at its first recurring
 * checkout, and stores the provider's id on the `PlanPrice` row.
 *
 * The default price is not handled here: it keeps the registration path it
 * has always had.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import type { BillingProviderName } from './credentials.service.js';
import { hasAnyRegistration, providerRegistration } from './priced-plan.js';
import type { BillingProvider, PricedPlan } from './providers/types.js';

const CLAIM_POLL_MS = 250;
const CLAIM_WAIT_MS = 5_000;
/** A claim older than this belongs to a request that died holding it. */
const CLAIM_STALE_MS = 60_000;
const REGISTRATION_ERROR_MAX = 500;

function registeredId(plan: Pick<PricedPlan, 'registration'>, provider: string): string | undefined {
  const entry = providerRegistration(plan, provider);
  return entry.priceId ?? entry.planId;
}

function notReady(plan: PricedPlan, reason: string): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'BILLING_PLAN_PRICE_NOT_READY',
    message: `The ${plan.currency.toUpperCase()} price of plan "${plan.slug}" ${reason}.`,
    fix: 'Try the checkout again in a few seconds. Nothing was charged and no checkout was opened.',
  });
}

/**
 * A provider id minted with sandbox credentials does not exist on the live
 * account, and the reverse. The plan's own price has the same check in
 * readiness; without it here the provider would refuse the checkout with an
 * error that names nothing the operator can act on.
 */
async function assertRegisteredInCurrentMode(
  plan: PricedPlan,
  providerName: BillingProviderName,
  registration: Prisma.JsonValue,
): Promise<void> {
  const registered = providerRegistration({ registration }, providerName).mode;
  if (registered === undefined) return;
  const credentials = await prisma.billingCredentials.findUnique({
    where: { applicationId_provider: { applicationId: plan.applicationId, provider: providerName } },
    select: { mode: true },
  });
  const current = credentials?.mode === 'live' ? 'live' : 'test';
  if (registered === current) return;
  const currency = plan.currency.toUpperCase();
  throw new RekeyError({
    statusCode: 409,
    code: 'BILLING_PLAN_PRICE_MODE_MISMATCH',
    message: `The ${currency} price of plan "${plan.slug}" was registered with ${registered} credentials, and ${providerName} is now in ${current} mode.`,
    fix: `Remove the ${currency} price and add it again (Panel → Application → Plans → Edit, or DELETE then PUT /api/v1/tenant/applications/:id/plans/${plan.slug}/prices/${currency}) so it is registered with the ${current} credentials.`,
  });
}

/**
 * Return the plan with this price's provider id present, registering the
 * price with the provider first when it has none.
 *
 * Razorpay's `plans.create` has no idempotency, so two first checkouts at once
 * would each mint a plan. The row is claimed with a conditional update before
 * the provider is called: one request registers, the others wait for its id.
 *
 * @example
 * const ready = await ensurePlanPriceRegistered({ provider, providerName: 'razorpay', plan: priced });
 * await provider.createCheckoutSession({ ...input, plan: ready });
 */
export async function ensurePlanPriceRegistered(args: {
  provider: BillingProvider;
  providerName: BillingProviderName;
  plan: PricedPlan;
}): Promise<PricedPlan> {
  const { plan, providerName } = args;
  const planPriceId = plan.planPriceId;
  // The default price registers where it always has: Stripe when the plan is
  // created, PayPal and Razorpay inside their own checkout call.
  if (planPriceId === null || plan.isDefaultPrice) return plan;

  const read = async () => {
    const row = await prisma.planPrice.findUnique({
      where: { id: planPriceId },
      select: { amount: true, metadata: true },
    });
    if (row === null) throw notReady(plan, 'was removed while this checkout was opening');
    if (row.amount !== plan.amount) throw notReady(plan, 'changed while this checkout was opening');
    return row;
  };

  const deadline = Date.now() + CLAIM_WAIT_MS;
  let stored: Prisma.JsonValue;
  for (;;) {
    const seen = await read();
    if (registeredId({ registration: seen.metadata }, providerName) !== undefined) {
      await assertRegisteredInCurrentMode(plan, providerName, seen.metadata);
      return { ...plan, registration: seen.metadata };
    }

    const claimed = await prisma.planPrice.updateMany({
      where: {
        id: planPriceId,
        // The amount is part of the claim: an operator re-pricing this row at
        // the same moment must not end up with a provider plan at the old one.
        amount: plan.amount,
        OR: [
          { registrationStatus: { not: 'PENDING' } },
          { updatedAt: { lt: new Date(Date.now() - CLAIM_STALE_MS) } },
        ],
      },
      data: { registrationStatus: 'PENDING', registrationError: null },
    });
    if (claimed.count === 1) {
      // Read again now that the row is ours: another checkout may have
      // registered and released it between the read above and the claim.
      const held = await read();
      if (registeredId({ registration: held.metadata }, providerName) === undefined) {
        stored = held.metadata;
        break;
      }
      await prisma.planPrice.update({ where: { id: planPriceId }, data: { registrationStatus: 'REGISTERED' } });
      await assertRegisteredInCurrentMode(plan, providerName, held.metadata);
      return { ...plan, registration: held.metadata };
    }
    if (Date.now() >= deadline) throw notReady(plan, 'is still being registered with the payment provider');
    await sleep(CLAIM_POLL_MS);
  }

  let providerPlanId: string;
  try {
    providerPlanId = (await args.provider.ensurePlanRegistered({ ...plan, registration: stored })).providerPlanId;
  } catch (e) {
    const raw = e instanceof Error && e.message ? e.message : String(e);
    await prisma.planPrice
      .update({
        where: { id: planPriceId },
        data: {
          registrationStatus: hasAnyRegistration(stored) ? 'REGISTERED' : 'FAILED',
          registrationError: raw.slice(0, REGISTRATION_ERROR_MAX),
        },
      })
      .catch(() => {
        // The provider's refusal is the error worth reporting. A claim left
        // PENDING goes stale on its own.
      });
    throw e;
  }

  const credentials = await prisma.billingCredentials.findUnique({
    where: { applicationId_provider: { applicationId: plan.applicationId, provider: providerName } },
    select: { mode: true },
  });
  const base = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored : {};
  const metadata: Prisma.JsonObject = {
    ...base,
    [providerName]: {
      [providerName === 'stripe' ? 'priceId' : 'planId']: providerPlanId,
      mode: credentials?.mode === 'live' ? 'live' : 'test',
    },
  };
  await prisma.planPrice.update({
    where: { id: planPriceId },
    data: { metadata, registrationStatus: 'REGISTERED', registrationError: null },
  });
  return { ...plan, registration: metadata };
}
