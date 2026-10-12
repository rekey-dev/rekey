/**
 * A subscription sold by a system Rekey never called: the activate-or-create
 * applier for `subscription.granted`.
 */

import { isEntitlingStatus, ENTITLING_SUBSCRIPTION_STATUSES, BillingConfigSchema } from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { RekeyError } from '../../../lib/error.js';
import { entitlementsService } from '../entitlements.service.js';
import { dunningService } from '../dunning.service.js';
import { kickDeliveries } from '../../webhooks/webhook.service.js';
import { subscriptionGrantsService } from '../grant.service.js';
import { subscriberService } from '../subscriber.service.js';
import { plansService } from '../../plans/plans.service.js';
import { enqueueSubscriptionEvent } from './billing-events.js';
import type { SubscriptionGrantedEvent } from '../providers/module-types.js';
import { planPriceIn, priceIfUnpriced, replacePrice } from '../unpriced-subscription.js';
import { priceIsSettled } from './charge-check.js';
import { logSubscriptionActivated } from '../money-events.js';
import { clearedOnReactivation, type ApplyContext } from './apply-shared.js';
import {
  MIN_RENEWAL_ADVANCE_MS,
  holdsAnotherSubject,
  ignoredSubjectChange,
  organizationKeptBy,
  predatesCancellation,
  recordRefusedGrant,
  retireReplacedSubscription,
  withSenderClockChecked,
} from './granted-rules.js';

/**
 * A subscription sold by a system Rekey never called (SubscriptionGrantedEvent).
 *
 * Four outcomes, decided by what the row already says:
 *
 *   - no row, or a row in a non-entitling state (PENDING, CANCELED, EXPIRED):
 *     the GRANT path. `grantSubscription` creates or reopens it, provisions
 *     the plan's entitlements and announces `subscription.activated`, with the
 *     sender's provider and subscription id bound onto the row so the status
 *     mirror finds it later.
 *   - an entitled row and a `currentPeriodEnd` at least a day later: a
 *     renewal. The period moves forward and entitlements are provisioned for
 *     it (idempotent per period anchor: credits refill once, a timed licence
 *     rolls once). A smaller move is the same period restated and is ignored.
 *   - a PAST_DUE row: recovery. Status returns to ACTIVE, the dunning case
 *     closes as recovered, and `subscription.activated` is announced, exactly
 *     as the status mirror does for a hosted provider.
 *   - a TRIALING row and a `trialEndsAt` that is null or past: conversion.
 *     Status becomes ACTIVE and `subscription.activated` is announced, as the
 *     hosted status mirror does for a provider's trialing → active.
 *   - an entitled row and nothing new: a replay. The binding is refreshed and
 *     nothing else is written or announced.
 *
 * Two refusals come first, each recorded on the receipt and changing
 * nothing: a live row for this subscriber and plan billed to a DIFFERENT
 * subject (another organization, or their personal account), and an
 * activation whose `occurredAt` is at or before the cancellation already
 * applied to the same subscription id.
 *
 * A future `trialEndsAt` on the grant path is judged by the trial ledger
 * (`GrantSubscriptionInput.trialEndsAt`), so a sender cannot hand one buyer a
 * trial per event; refused, the grant proceeds ACTIVE without it.
 *
 * Before any of that, the sender's subscription id is checked against every
 * row in the Application. Found on a row for a DIFFERENT plan or a different
 * end-user, that row is retired (cancelled if it was live, the id released)
 * because the sender has told us the subscription now means something else:
 * a plan change, or an account the subscription moved to.
 *
 * An event for the subscription id a row already holds, for the same plan and
 * subscriber, may omit the organization: it keeps the row's. Only a new sale
 * must name one on an org-billed Application.
 *
 * A period end already in the past is stale news and is ignored, loudly. A
 * grant for it would be refused with SUBSCRIPTION_PERIOD_END_IN_PAST, the
 * pipeline would answer 5xx, and the sender would retry an event that can
 * never succeed.
 */
export async function applySubscriptionGranted(
  ev: SubscriptionGrantedEvent,
  ctx: ApplyContext,
): Promise<void> {
  const now = new Date();
  if (ev.currentPeriodEnd instanceof Date && ev.currentPeriodEnd <= now) {
    ctx.log.warn(
      {
        applicationId: ev.applicationId,
        providerSubscriptionId: ev.providerSubscriptionId,
        currentPeriodEnd: ev.currentPeriodEnd,
        providerEventId: ev.providerEventId,
      },
      'subscription.granted names a period that has already ended, ignored',
    );
    return;
  }

  ev = withSenderClockChecked(ev, now, ctx);

  const application = await prisma.application.findUniqueOrThrow({
    where: { id: ev.applicationId },
  });
  const plan = await plansService.getBySlug(application.id, ev.planSlug);
  const named = ev.currency === undefined ? null : await planPriceIn(plan, ev.currency);
  if (named !== null && named.price === null) {
    // Unlike an operator grant, not refused: the sale already happened in the
    // sender's system, and the subscriber must not lose access over a price
    // nobody entered here. The row follows the plan's default price.
    ctx.log.warn(
      { planSlug: plan.slug, currency: ev.currency, sold: named.sold, providerEventId: ev.providerEventId },
      'subscription.granted names a currency the plan has no price in; activated at the default price',
    );
    ctx.note?.(
      `Plan "${plan.slug}" has no price in ${ev.currency!.toUpperCase()} (it is priced in ${named.sold.join(', ')}), so this ` +
        `subscription was activated at the plan's default price. Add the price in ` +
        'Panel → Application → Plans → Edit and post the activation again to correct it.',
    );
  }
  const namedPrice = named?.price ?? null;
  const holder = await prisma.subscription.findUnique({
    where: {
      applicationId_providerSubId: {
        applicationId: application.id,
        providerSubId: ev.providerSubscriptionId,
      },
    },
  });
  if (ev.organizationId === undefined) {
    const kept = await organizationKeptBy(holder, plan.id, ev);
    if (kept !== null) ev = { ...ev, organizationId: kept };
  }
  // The organization preconditions `grantSubscription` enforces, checked here
  // BEFORE anything is written: an event that would fail them must not first
  // create the subscriber or retire the row its subscription id was bound to.
  const billingConfig = BillingConfigSchema.parse(application.billingConfig);
  if (billingConfig.billingSubject === 'org' && ev.organizationId === undefined) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_ORGANIZATION_REQUIRED',
      message: 'This Application bills per organization, but the event names no organization.',
      fix: 'Send `subscriber.organizationId` on subscription.activated for this Application.',
    });
  }
  if (ev.organizationId !== undefined) {
    const org = await prisma.organization.findFirst({
      where: { id: ev.organizationId, applicationId: application.id },
      select: { id: true },
    });
    if (!org) {
      throw new RekeyError({
        statusCode: 404,
        code: 'ORGANIZATION_NOT_FOUND',
        message: `Organization "${ev.organizationId}" not found in this application.`,
        fix: 'Send an organization id that belongs to this Application.',
      });
    }
  }
  const subscriber = await subscriberService.resolveOrCreate({
    application,
    subscriber: ev.subscriber,
    provider: ev.provider,
    providerEventId: ev.providerEventId,
    log: ctx.log,
  });

  // The sender's id already names a subscription ANOTHER provider created.
  // Stripe ids are printed on invoices; a sender that reuses one, by accident
  // or otherwise, must not be able to retire the hosted row. Recorded and
  // ignored, like the same-plan case below.
  if (holder && holder.provider !== null && holder.provider !== ev.provider) {
    ctx.log.error(
      {
        subscriptionId: holder.id,
        currentProvider: holder.provider,
        provider: ev.provider,
        providerSubscriptionId: ev.providerSubscriptionId,
        providerEventId: ev.providerEventId,
      },
      'subscription.granted names a subscription id that belongs to another provider, ignored',
    );
    await recordRefusedGrant(holder, ev, now);
    return;
  }
  const key = { applicationId: application.id, endUserId: subscriber.id, planId: plan.id };
  const existing = await prisma.subscription.findUnique({
    where: { applicationId_endUserId_planId: key },
  });

  // Both refusals run before the retire below, so an event that is going to
  // be refused cannot first cancel the row its subscription id was bound to.
  if (existing && holdsAnotherSubject(existing, ev)) {
    ctx.log.error(
      {
        subscriptionId: existing.id,
        beneficiaryOrgId: existing.beneficiaryOrgId,
        organizationId: ev.organizationId ?? null,
        providerSubscriptionId: ev.providerSubscriptionId,
        providerEventId: ev.providerEventId,
      },
      'subscription.granted names a subscriber whose live subscription to this plan is billed to another subject; refused',
    );
    await recordRefusedGrant(existing, ev, now);
    ctx.note?.(
      `BILLING_SUBSCRIPTION_SUBJECT_CONFLICT: this subscriber already holds a live "${plan.slug}" ` +
        `subscription billed to ${existing.beneficiaryOrgId === null ? 'their personal account' : 'a different organization'}, ` +
        'and a subscription to one plan is stored once per subscriber. Nothing was applied. Post ' +
        'subscription.canceled for the subscription that holds it first, or sell the other subject a separate plan.',
    );
    return;
  }
  if (existing && predatesCancellation(existing, ev)) {
    ctx.log.warn(
      {
        subscriptionId: existing.id,
        canceledAt: existing.canceledAt,
        occurredAt: ev.occurredAt,
        providerEventId: ev.providerEventId,
      },
      'subscription.granted occurred before the cancellation already applied to it; ignored',
    );
    ctx.note?.(
      `Stale activation: it occurred at ${ev.occurredAt!.toISOString()}, at or before this subscription was ` +
        `cancelled (${existing.canceledAt!.toISOString()}), so it does not reopen it.`,
    );
    return;
  }

  if (holder && (holder.planId !== plan.id || holder.endUserId !== subscriber.id)) {
    await retireReplacedSubscription(holder, ev, ctx);
  }

  if (!existing || !isEntitlingStatus(existing.status)) {
    const result = await subscriptionGrantsService.grantSubscription({
      application,
      planSlug: plan.slug,
      endUserId: subscriber.id,
      ...(ev.organizationId !== undefined && { organizationId: ev.organizationId }),
      ...(ev.currentPeriodEnd instanceof Date && { currentPeriodEnd: ev.currentPeriodEnd }),
      // A future trialEndsAt is judged by the trial ledger inside the grant,
      // keyed on this event, so a re-delivery takes no second slot. See
      // `GrantSubscriptionInput.trialEndsAt`.
      ...(ev.trialEndsAt !== undefined && { trialEndsAt: ev.trialEndsAt }),
      trialAttemptId: ev.providerEventId,
      // A sender that names no currency gets the plan's default price. Its
      // first payment corrects that when it arrives in another currency the
      // plan sells in, and is recorded unverified when the plan does not.
      ...(namedPrice !== null && { currency: namedPrice.currency }),
      origin: { via: 'provider', actor: { type: 'provider', id: ev.provider }, providerEventId: ev.providerEventId },
      note: `Activated by ${ev.provider} event ${ev.providerEventId}`,
      providerBinding: { provider: ev.provider, providerSubId: ev.providerSubscriptionId },
    });
    if (result.trialRefused) {
      ctx.log.warn(
        {
          subscriptionId: result.subscription.id,
          trialEndsAt: ev.trialEndsAt,
          reason: result.trialRefused.reason,
          providerEventId: ev.providerEventId,
        },
        'subscription.granted named a trial the buyer is not eligible for; granted without it',
      );
    }
    ctx.log.info(
      {
        subscriptionId: result.subscription.id,
        activated: result.activated,
        status: result.subscription.status,
        subscriberCreated: subscriber.created,
        providerEventId: ev.providerEventId,
      },
      'subscription.granted, activated',
    );
    return;
  }

  // Already entitled: renewal, recovery, rebind, or replay.
  //
  // Unless the live subscription belongs to a HOSTED provider. A row with a
  // Stripe id and a Stripe provider is still being charged by Stripe; taking
  // its id away would orphan every later Stripe event and hand the buyer a
  // subscription they can no longer cancel from Rekey while Stripe keeps
  // billing. The event is recorded on the row and otherwise ignored; the
  // operator resolves which system owns this customer.
  if (existing.provider !== null && existing.provider !== ev.provider && existing.providerSubId !== null) {
    ctx.log.error(
      {
        subscriptionId: existing.id,
        currentProvider: existing.provider,
        currentProviderSubId: existing.providerSubId,
        provider: ev.provider,
        providerSubscriptionId: ev.providerSubscriptionId,
        providerEventId: ev.providerEventId,
      },
      'subscription.granted names a subscriber whose live subscription belongs to another provider, not rebound',
    );
    await recordRefusedGrant(existing, ev, now);
    return;
  }
  const periodAdvanced =
    ev.currentPeriodEnd instanceof Date &&
    (existing.currentPeriodEnd === null ||
      ev.currentPeriodEnd.getTime() - existing.currentPeriodEnd.getTime() >= MIN_RENEWAL_ADVANCE_MS);
  if (ignoredSubjectChange(existing, ev)) {
    ctx.note?.(
      `subject change ignored: the event names organization "${ev.organizationId}", but subscription ` +
        `"${ev.providerSubscriptionId}" is billed to ${existing.beneficiaryOrgId === null ? 'the personal account' : `organization "${existing.beneficiaryOrgId}"`}. ` +
        'The event was applied to it unchanged. To move it, cancel it and activate a new subscription id for the new subject.',
    );
  }
  const recovering = existing.status === 'PAST_DUE';
  // The trial the sender was running has ended: the row converts to ACTIVE,
  // which is when its revenue starts counting, the transition the hosted
  // status mirror makes from a provider's `trialing` → `active`. A future
  // date on a row already TRIALING is the sender re-dating its own clock and
  // is mirrored; on an ACTIVE or PAST_DUE row it is dropped, a paid
  // subscription is not put back on a trial by an event, and the ledger has
  // already judged this buyer once.
  const trialEnded =
    ev.trialEndsAt === null || (ev.trialEndsAt instanceof Date && ev.trialEndsAt <= now);
  const converting = existing.status === 'TRIALING' && trialEnded;
  const mirrorsTrialDate =
    ev.trialEndsAt !== undefined && (trialEnded || existing.status === 'TRIALING');
  // A term that runs past a scheduled cancellation says the subscription
  // continues. Anything shorter leaves the schedule alone, so a re-delivered
  // activation cannot quietly undo a cancellation the sender has since posted.
  const clearsCancellation =
    ev.currentPeriodEnd instanceof Date &&
    existing.cancelAt !== null &&
    ev.currentPeriodEnd > existing.cancelAt;

  const deliveryIds = await prisma.$transaction(async (tx) => {
    // Conditional on the row STILL being entitled: a cancellation applied
    // between the read above and this write must win.
    const { count } = await tx.subscription.updateMany({
      where: { id: existing.id, status: { in: [...ENTITLING_SUBSCRIPTION_STATUSES] } },
      data: {
        ...((recovering || converting) && { status: 'ACTIVE' as const }),
        provider: ev.provider,
        providerSubId: ev.providerSubscriptionId,
        // Only ever forward. An older-but-future period end is a delayed
        // delivery, not a shortening, and an explicit null on a live termed
        // row is not a request to make it open-ended.
        ...(periodAdvanced && { currentPeriodEnd: ev.currentPeriodEnd }),
        ...(mirrorsTrialDate && { trialEndsAt: ev.trialEndsAt }),
        ...(clearsCancellation && clearedOnReactivation),
      },
    });
    if (count === 0) return [];
    // The sender names what this subscriber pays. A row with no price takes
    // it; so does one whose price nobody has paid at and no checkout fixed. A
    // price somebody is paying at is never moved.
    if (namedPrice !== null && existing.planPriceId !== namedPrice.planPriceId && !(await priceIsSettled(existing))) {
      const logged = {
        cause: 'provider' as const,
        actor: { type: 'provider' as const, id: ev.provider },
        provider: ev.provider,
        providerEventId: ev.providerEventId,
        log: ctx.log,
      };
      if (existing.currency === null) await priceIfUnpriced(existing.id, namedPrice, tx, logged);
      else await replacePrice(existing.id, namedPrice, tx, logged);
    }
    // Keep the ledger's copy of the clock in step with the row's.
    if (mirrorsTrialDate && !trialEnded) {
      await tx.trialRedemption.updateMany({
        where: { applicationId: application.id, subscriptionId: existing.id, status: 'CONSUMED' },
        data: { endsAt: ev.trialEndsAt as Date },
      });
    }
    if (!recovering && !converting) return [];
    await logSubscriptionActivated(
      tx,
      existing.id,
      { via: 'provider', trial: false },
      { actor: { type: 'provider', id: ev.provider }, provider: ev.provider, providerEventId: ev.providerEventId, log: ctx.log },
    );
    return enqueueSubscriptionEvent(tx, 'subscription.activated', existing.id);
  });
  // Provision on every pass, not only when the period moved. Provisioning is
  // idempotent per period anchor, so a replay costs a few reads; what it buys
  // is retry safety. The grant path commits the row and then provisions, and
  // if provisioning throws, the pipeline answers 5xx and the sender retries
  // the same event, which now lands here with nothing "new" to do. Without
  // this the period's entitlements would never be materialised.
  const row = await prisma.subscription.findUniqueOrThrow({ where: { id: existing.id } });
  await entitlementsService.provision({ subscription: row, log: ctx.log });
  // Announce after the entitlements exist, the ordering every other
  // activation path promises its consumers.
  kickDeliveries(deliveryIds);
  if (recovering) await dunningService.recoverForSubscription(existing.id);
  ctx.log.info(
    {
      subscriptionId: existing.id,
      periodAdvanced,
      recovering,
      converting,
      rebound: existing.providerSubId !== ev.providerSubscriptionId,
      providerEventId: ev.providerEventId,
    },
    'subscription.granted, already entitled',
  );
}
