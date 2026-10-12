/**
 * The refusals a buyer's existing rows put on a new checkout: the provider
 * they are bound to is no longer usable, the checkout names a different one,
 * or it would move a live subscription to another billing subject. See
 * checkout-binding.ts for what binds and why.
 */

import type { Subscription } from '@prisma/client';
import { isEntitlingStatus } from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';
import type { BindingSubscription } from './checkout-binding.js';
import { checkoutBindsUntil } from './checkout-sessions.js';
import { billingCredentialsService, type BillingProviderName } from './credentials.service.js';

/**
 * Throws when the row that binds this buyer rules the checkout out. Returns
 * for a buyer nothing binds, and for one whose bound provider is enabled and
 * is the one asked for, or none was asked for.
 *
 * @example
 * await assertBindingAllowsCheckout({ applicationId, bound, requestedProvider: input.provider });
 */
export async function assertBindingAllowsCheckout(args: {
  applicationId: string;
  bound: BindingSubscription | null;
  /** `provider` as the caller sent it. */
  requestedProvider: BillingProviderName | undefined;
}): Promise<void> {
  const { bound } = args;
  const boundProvider = bound?.provider ?? null;
  const unpaidBinderReleasesAt =
    bound !== null && bound.status === 'PENDING' && bound.providerSubId === null
      ? checkoutBindsUntil(bound).toISOString()
      : null;

  // Whether the bound provider is still REACHABLE is settled before the
  // caller's request is judged, because it is the more fundamental fact and
  // it does not depend on what they asked for.
  //
  // Ordering used to be the other way round, and the switch refusal below
  // ran before the router had ever looked at availability. So a subscriber
  // bound to a provider the operator had disabled, who named a different
  // one, was told to "check out through <bound>", an instruction that cannot
  // be followed, and sent to look for a mistake they did not make. The
  // unavailable case was only ever reached by callers who named nothing,
  // which is the narrower half of the same situation.
  if (bound !== null && boundProvider !== null) {
    const enabled = await billingCredentialsService.listEnabled(args.applicationId);
    if (!enabled.some((p) => p.provider === boundProvider)) {
      // Disabled and deleted are one state to the router and two states to
      // the operator, and only one of them has "cancel it" as a way out.
      // `getProviderForApplication` decrypts whatever row exists and does
      // not consult `enabled`, so cancellation still dials a DISABLED
      // provider fine. With the credentials REMOVED it throws, and the
      // remedy this error used to offer was one the buyer could not take:
      // they could neither buy nor cancel, and nothing said why.
      const stillConfigured = await billingCredentialsService.isConfigured(
        args.applicationId,
        boundProvider as BillingProviderName,
      );
      // The PENDING split belongs on BOTH refusals, not only on the switch
      // one below.
      //
      // Availability is decided before the caller's request, so a PENDING
      // binder reaches THIS error rather than the sibling. Wording only one
      // of the two leaves the other telling a buyer who has never paid that
      // they "already pay" and should "cancel the existing subscription".
      // Change them together.
      //
      // For a PENDING binder the deleted-credentials text is not merely
      // clumsy, it is false. `providerBacked` is
      // `Boolean(sub.provider && sub.providerSubId)` and an unfinished
      // checkout has no `providerSubId`, so cancellation never dials the
      // processor and works whatever the credentials say.
      //
      // "No completed payment has been recorded", not "nothing has been
      // charged". PENDING means no completion has been APPLIED, which is not
      // the same as unpaid: a buyer who paid at the processor while the
      // webhook was lost or exhausted its retries sits in exactly this state
      // (see docs/specs/billing-reconciliation.md, F-A and F-D). Telling
      // that operator nothing was charged is false at the moment it matters
      // most, and nothing local can tell the two apart, so the sentence says
      // only what Rekey actually knows.
      // Three binder states here, matching the sibling refusal below. Adding
      // the trial wording to only one of the two is the mistake this change
      // has now made twice, once with PENDING and once with TRIALING, and
      // the reorder makes THIS the more reachable refusal of the pair: it
      // fires whether or not the caller named a provider.
      const unpaidBinder = bound.status === 'PENDING' && bound.providerSubId === null;
      const held = unpaidBinder
        ? `has an unfinished checkout at "${boundProvider}"`
        : bound.status === 'TRIALING'
          ? `is on a trial that will charge through "${boundProvider}"`
          : `pays through "${boundProvider}"`;
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_BOUND_PROVIDER_UNAVAILABLE',
        message: `This subscriber ${held}, which is ${stillConfigured ? 'disabled' : 'no longer configured'} for this Application. A subscription cannot be moved between payment providers, so no checkout can be issued for them until that is resolved.`,
        fix: unpaidBinder
          ? stillConfigured
            ? `Re-enable "${boundProvider}" in Panel → Application → Billing → Setup → Providers so this buyer can open checkouts there again. The one they already started is unaffected either way: completions do not consult whether a provider is enabled, so a payment made at "${boundProvider}" is still recorded while it is disabled. Otherwise leave it until ${unpaidBinderReleasesAt}, when it stops reserving "${boundProvider}" and a checkout elsewhere is allowed, unless a checkout for "${bound.plan.slug}" is opened there again first. No completed payment has been recorded here, so there is nothing for Rekey to cancel.`
            : `Re-add the "${boundProvider}" credentials in Panel → Application → Billing → Setup → Providers so a payment completed there can still be recorded: without them the completion is refused and the checkout they started stays open. Otherwise leave it until ${unpaidBinderReleasesAt}, when it stops reserving "${boundProvider}" and a checkout elsewhere is allowed, unless a checkout for "${bound.plan.slug}" is opened there again first. No completed payment has been recorded here, so there is nothing for Rekey to cancel.`
          : stillConfigured
            ? `Re-enable "${boundProvider}" in Panel → Application → Billing → Setup → Providers so existing subscribers can keep buying, or cancel their "${boundProvider}" subscription, let it terminate, and have them buy again through a provider that is still enabled.`
            : `Re-add the "${boundProvider}" credentials in Panel → Application → Billing → Setup → Providers; that restores both cancellation and checkout, because a re-added credential is enabled unless you say otherwise. While they are deleted this subscriber can neither buy nor cancel here, and cancelling in "${boundProvider}"'s own dashboard leaves this subscription live in Rekey. (An unfinished checkout is different: it has no provider-side subscription, so there is nothing to dial and it can still be cancelled.)`,
      });
    }

    // An explicit request we cannot honour is refused; an absent one is
    // pinned.
    //
    // The split matters. Asking for PayPal when you are already on Stripe is
    // a request with no correct outcome, and answering it by quietly
    // charging you on Stripe would be worse than saying no. But when nobody
    // asked, the geo router is free to pick a different provider than last
    // time (a trip abroad, a routing change), and that silent drift is the
    // version of this bug nobody would ever report. Pinning removes it.
    if (args.requestedProvider !== undefined && args.requestedProvider !== boundProvider) {
      // A PENDING binder is an unfinished checkout, not a subscription. The
      // refusal is the same and its reason is not: two payable sessions at
      // two processors bill twice just as two subscriptions do, but there is
      // nothing Rekey can cancel, so saying "already pays" and "cancel the
      // existing subscription" describes a person who does not exist. The
      // portal repeats this text verbatim.
      //
      // It says "no completed payment has been recorded" rather than
      // "nothing has been charged", for the reason given on the sibling
      // refusal above: PENDING is not proof of unpaid.
      //
      // The release time is quoted as an instant, not as "24 hours": the
      // window runs from when the newest session was issued, which may be
      // most of a day ago. Re-opening that same checkout issues a new
      // session and legitimately moves it, hence the "unless" clause.
      // TRIALING is grouped with PENDING for the "has not paid" half only.
      // A trial is a live billing relationship that converts into a charge,
      // so it IS cancellable and the remedy stays; what is untrue of it is
      // "already pays". PAST_DUE has paid before, so it keeps the paid
      // wording.
      const unpaid = bound.status === 'PENDING' && bound.providerSubId === null;
      const trialing = bound.status === 'TRIALING';
      throw new RekeyError({
        statusCode: 409,
        code: 'BILLING_PROVIDER_SWITCH_BLOCKED',
        message: unpaid
          ? `This subscriber has an unfinished checkout for "${bound.plan.slug}" at "${boundProvider}" that can still be paid, and a subscription cannot be moved between payment providers. Checking out through "${args.requestedProvider}" would leave two payable checkouts at two processors and bill them twice.`
          : trialing
            ? `This subscriber is on a trial of "${bound.plan.slug}" that will charge through "${boundProvider}", and a subscription cannot be moved between payment providers. Checking out through "${args.requestedProvider}" would create a second subscription and bill them twice.`
            : `This subscriber already pays for "${bound.plan.slug}" through "${boundProvider}", and a subscription cannot be moved between payment providers. Checking out through "${args.requestedProvider}" would create a second subscription and bill them twice.`,
        fix: unpaid
          ? `Finish the checkout at "${boundProvider}", or abandon it: it stops reserving "${boundProvider}" at ${unpaidBinderReleasesAt}, after which a checkout elsewhere is allowed, unless a checkout for "${bound.plan.slug}" is opened there again first. No completed payment has been recorded here, so there is nothing for Rekey to cancel.`
          : `Check out through "${boundProvider}", or cancel the existing subscription and let it terminate before starting a new one elsewhere. Read \`provider\` off the active subscription to know which one to offer.`,
      });
    }
  }
}

/**
 * A LIVE subscription is not moved from one billing subject to another by
 * somebody opening a checkout.
 *
 * `beneficiaryOrgId` is not in the uniqueness constraint (#431), so a
 * personal subscription to `pro` and an org-billed one to `pro` for the
 * same buyer are the SAME row, and the upsert below writes
 * `beneficiaryOrgId` unconditionally. Alice owns Acme and Beta; Acme holds
 * `pro`; Alice opens a checkout for `pro` on behalf of Beta. That rewrote
 * Acme's row: still ACTIVE, still carrying Acme's `providerSubId`, but
 * billed to Beta. Acme's entitlement read null, Beta had it for free, the
 * processor kept charging Acme, and no payment was involved. Opening
 * checkout did it.
 *
 * This was covered by ACCIDENT until the provider binding above existed.
 * The guard that used to sit right here compared `existing.provider !==
 * providerName`, which also refused the rewrite, but only when the router
 * happened to disagree, and pinning now makes the two agree by
 * construction for every bound buyer. Fixing the reported axis removed the
 * cover on this one, so the refusal has to be stated rather than fall out.
 *
 * Only an ENTITLING row is protected. A PENDING one is a checkout nobody
 * completed: refusing over it would offer a remedy ("cancel it") that does
 * not exist, which is precisely the shape of refusal this change had to
 * remove once already for one-off purchases. The narrower hole it leaves,
 * the earlier subject pays, the later subject is entitled, is the same
 * one two open sessions on a single row already carry, and it closes for
 * good with #431.
 *
 * @example
 * assertSubjectUnchanged(existing, { planSlug: plan.slug, beneficiaryOrgId: input.beneficiaryOrgId });
 */
export function assertSubjectUnchanged(
  existing: Pick<Subscription, 'status' | 'beneficiaryOrgId'> | null,
  args: { planSlug: string; beneficiaryOrgId: string | undefined },
): void {
  if (
    existing !== null &&
    isEntitlingStatus(existing.status) &&
    existing.beneficiaryOrgId !== (args.beneficiaryOrgId ?? null)
  ) {
    // The held subject is described, not named: the caller was authorised for
    // the org they are BUYING for, and may not be a member of the one that
    // holds the row.
    const held =
      existing.beneficiaryOrgId === null ? 'their personal account' : 'a different organization';
    const wanted =
      args.beneficiaryOrgId === undefined ? 'their personal account' : 'this organization';
    throw new RekeyError({
      statusCode: 409,
      code: 'BILLING_SUBSCRIPTION_SUBJECT_CONFLICT',
      message: `This buyer already holds a live subscription to "${args.planSlug}" billed to ${held}, and a subscription to one plan is stored once per buyer. Checking out "${args.planSlug}" for ${wanted} would move that subscription instead of starting a second one: the current holder would lose the entitlement while the payment provider kept charging for it.`,
      fix: `Cancel the existing "${args.planSlug}" subscription and let it terminate before starting one for a different billing subject, or bill the two subjects on separate plans. Read the live subscription with GET /billing/subscription (pass \`organizationId\` for an org's) to see which subject holds it.`,
    });
  }
}
