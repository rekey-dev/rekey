import { isEntitlingStatus, type CancelReason } from '@rekey.dev/shared-types';
import * as React from 'react';
import { redirect } from 'next/navigation';
import { cancelCopy } from '@/lib/cancel-copy';
import { managedBillingOrg, planReviewPath } from '@/lib/billing-subject';
import { managedElsewhere } from '@/lib/provider-capabilities';
import { getPortalConfig, supportLink } from '@/lib/config';
import { formatMoney, formatPlanPrice, refundLine, subscriptionPriceLabel } from '@/lib/format';
import { planOffer } from '@/lib/plan-offer';
import { getPortalUser, portalClientFor } from '@/lib/session';
import { cancelSubscriptionAction } from '@/lib/actions';
import { Banner } from '@/components/banner';
import { Card } from '@/components/card';
import { StatusBadge } from '@/components/status-badge';
import { ConfirmSubmit } from '@/components/confirm-submit';

/**
 * Checkout / cancel failures, translated for the merchant's customer.
 *
 * Audience rule from not-found.tsx applies: no error codes, and none of the
 * API's operator `fix` text, "configure a provider in Panel → Billing" is an
 * instruction the person reading this cannot act on. Each string says what it
 * means for them instead.
 *
 * BILLING_CREDENTIALS_NOT_CONFIGURED matters most: with the stub providers
 * gone, an app whose operator hasn't connected a provider now fails EVERY
 * subscribe click. Left generic, that reads as "try again" and the customer
 * loops forever on an error no retry can clear.
 */
const CHECKOUT_ERR: Record<string, string> = {
  BILLING_CREDENTIALS_NOT_CONFIGURED:
    'Payments aren’t set up here yet, so checkout isn’t available.',
  // The payment option picked is not on offer (any more). Refused rather than
  // quietly swapped for another processor the buyer did not choose.
  BILLING_PROVIDER_NOT_AVAILABLE:
    'That payment option isn’t available here any more. Reload the page and choose another.',
  BILLING_PROVIDER_INBOUND_ONLY:
    'That payment option isn’t available here any more. Reload the page and choose another.',
  // Portal-side code: the router found no provider that can take a buyer, and
  // the buyer picked none, so there is nothing else to choose.
  CHECKOUT_UNAVAILABLE: 'Checkout isn’t available here, so plans can’t be bought on this page.',
  PLAN_NOT_FOUND: 'That plan isn’t available any more.',
  PLAN_INACTIVE: 'That plan isn’t available any more.',
  // Portal-side code: the catalogue says a checkout for this plan would be refused.
  PLAN_UNAVAILABLE: 'That plan can’t be bought here right now.',
  // A subscriber is never moved to another currency, and theirs can no longer
  // be charged. Only the business can repair it.
  BILLING_CURRENCY_CONFLICT:
    'Your subscription is billed in a currency that can’t be charged here right now, so a new checkout can’t be started. Nothing was charged.',
  BILLING_NO_PROVIDER_FOR_CURRENCY:
    'That plan can’t be paid for in your currency here right now. Nothing was charged.',
  BILLING_ORGANIZATION_REQUIRED:
    'This plan is billed to your team, so a team owner or admin has to start it.',
  // One string, two binder states: a paid subscription and an unfinished
  // checkout both raise this, and the old text ("It needs to be canceled")
  // told a buyer who had never paid to cancel something that does not exist.
  BILLING_PROVIDER_SWITCH_BLOCKED:
    'You already have a subscription or an unfinished checkout with a different payment provider. That one has to finish first. If you meant to keep it, choose that same provider here; otherwise cancel it before starting this one.',
  // Same two binder states as the code above, and this one is now the more
  // likely of the two to be reached: checkout answers "the bound provider is
  // gone" before it judges the provider you picked.
  BILLING_BOUND_PROVIDER_UNAVAILABLE:
    'The payment provider holding your subscription or unfinished checkout isn’t available here any more, so a new one can’t be started. Contact support.',
  BILLING_SUBSCRIPTION_SUBJECT_CONFLICT:
    'You already have this plan on another account of yours. It has to be canceled and finish before you can start it here.',
  SUBSCRIPTION_NOT_FOUND: 'We couldn’t find that subscription. It may already be canceled.',
  SUBSCRIPTION_NOT_CANCELABLE: 'That was a one-time purchase, so there is nothing to cancel. It will not bill again.',
  SUBSCRIPTION_MANAGED_EXTERNALLY:
    'This subscription is managed through your billing account, not here. Cancel it there and this page updates shortly after.',
};

const CANCEL_REASON_OPTIONS: ReadonlyArray<readonly [CancelReason, string]> = [
  ['too_expensive', 'It costs too much'],
  ['missing_features', 'It is missing something I need'],
  ['switched_service', 'I switched to something else'],
  ['unused', 'I am not using it'],
  ['too_complex', 'It is too hard to use'],
  ['low_quality', 'It did not work well enough'],
  ['customer_service', 'Support did not help'],
  ['other', 'Something else'],
];

/** A credit pack or a perpetual licence bills once, so there is nothing to cancel. Mirrors the API's isOneTimePlan. */
function boughtOnce(plan: { kind: string; licenseKind: string | null } | undefined): boolean {
  return plan?.kind === 'CREDIT' || (plan?.kind === 'LICENSE' && plan.licenseKind !== 'TIMED');
}

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  const session = await getPortalUser(slug);
  if (!session) redirect(`/${slug}/login`);

  const config = await getPortalConfig(slug);
  const client = await portalClientFor(slug);
  // client/config are non-null here (layout already resolved the slug).
  const isOrgBilled = config!.billingSubject === 'org';

  // On org-billed apps, the subscription belongs to a team. If the signed-in
  // user OWNS or ADMINS a team, they can manage that team's billing here.
  // Otherwise the plans are read-only (a member can look but only an
  // owner/admin can change the plan).
  const billingOrg = isOrgBilled ? await managedBillingOrg(client!, session.accessToken) : null;
  const orgId = billingOrg?.id ?? null;

  const subjectOpts = orgId ? { organizationId: orgId } : undefined;
  const [current, live, plans, payments] = await Promise.all([
    client!.getSubscription(session.accessToken, subjectOpts),
    // Every live subscription: a buyer can hold several, and the singular read
    // shows one. Without this the page offered checkout for a plan they already
    // pay for.
    client!
      .listSubscriptions(session.accessToken, subjectOpts)
      .then((r) => r.items)
      .catch(() => null),
    // With the buyer's token, so each plan's price is the one THEIR checkout
    // would charge: the currency they already pay in, not a stranger's default.
    config!.billingEnabled
      ? client!.getPlans({ limit: 100 }, { accessToken: session.accessToken }).then((r) => r.items)
      : Promise.resolve([]),
    // Billing history. Non-critical, never let it break the dashboard.
    config!.billingEnabled
      ? client!
          .listPayments(session.accessToken, 12)
          .then((r) => r.items)
          .catch(() => [])
      : Promise.resolve([]),
  ]);
  // The live list when there is one; otherwise the singular read, which also
  // reports an unfinished (PENDING) checkout.
  const subscriptions = live && live.length > 0 ? live : current ? [current] : [];
  const heldPlanIds = new Set(subscriptions.map((s) => s.planId));
  // The row the cancel banner describes: the one the action names, and only
  // when it is one of the caller's. An immediate cancellation leaves the live
  // list, so it falls back to the generic sentence.
  const canceledId = typeof sp.sub === 'string' ? sp.sub : undefined;
  const canceled = canceledId ? subscriptions.find((s) => s.id === canceledId) : undefined;
  const canceledPlanName = canceled ? plans.find((p) => p.id === canceled.planId)?.name : undefined;
  /**
   * When access actually stops. `cancelAt` first, because the two diverge on
   * exactly the path this page used to get wrong: on an immediate cancellation
   * `currentPeriodEnd` is the date the customer had been paid up to, while
   * `cancelAt` is the day they really lose access.
   */
  const endsOn = canceled?.cancelAt ?? canceled?.currentPeriodEnd ?? null;
  // Individual apps: always self-checkout. Org apps: only when we resolved a
  // team the user can manage. Members of org-billed apps get a read-only view.
  const canCheckout = !isOrgBilled || billingOrg !== null;

  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const notice = typeof sp.e === 'string' ? sp.e : undefined;
  const checkout = typeof sp.checkout === 'string' ? sp.checkout : undefined;
  const supportHref = supportLink(config!.branding);

  return (
    <div className="space-y-6">
      {checkout === 'success' && <Banner tone="success">Checkout complete. Your subscription will activate shortly.</Banner>}
      {checkout === 'canceled' && <Banner tone="info">Checkout canceled.</Banner>}
      {/* Reports what happened, rather than assuming the request was granted:
          the same redirect lands here after an immediate cancellation, where
          "will end at the close of the current period" was simply untrue. */}
      {notice === 'canceled' && (
        <Banner tone="info">
          {canceled?.cancelAt && endsOn
            ? `Your ${canceledPlanName ? `${canceledPlanName} ` : ''}subscription will end on ${new Date(endsOn).toLocaleDateString()}.`
            : 'Your subscription has been cancelled.'}
        </Banner>
      )}
      {error && (
        <Banner tone="error">
          {CHECKOUT_ERR[error] ?? 'Something went wrong. Please try again.'}
          {supportHref ? (
            <>
              {' '}
              <a href={supportHref} className="underline" target="_blank" rel="noopener noreferrer">
                Contact support
              </a>{' '}
              if you need help.
            </>
          ) : (
            ' Contact support if you need help.'
          )}
        </Banner>
      )}

      <Card>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">Subscription</h2>
          {billingOrg && (
            <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-xs text-[var(--color-muted-fg)]">
              Team: {billingOrg.name}
            </span>
          )}
        </div>
        {subscriptions.length > 0 ? (
          <ul className="space-y-4 text-sm">
            {subscriptions.map((sub) => {
              const plan = plans.find((p) => p.id === sub.planId);
              const subCanceling = Boolean(sub.cancelAt);
              // Sold and billed by the operator's own system (an inbound-only
              // provider): Rekey cannot stop the money there, so the cancel
              // button would only 409. Asked of the provider's capabilities.
              const subManagedExternally = managedElsewhere(sub);
              /** Which of the two cancellations this customer is actually about to get. */
              const cancelText = cancelCopy(sub);
              const subEndsOn = sub.cancelAt ?? sub.currentPeriodEnd ?? null;
              // The subscription's own price, which can differ from the
              // plan's price today and from its default.
              const priceLabel = subscriptionPriceLabel(sub.price, plan);
              return (
                <li key={sub.id} className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-[var(--color-fg)]">{plan?.name ?? sub.planId}</span>
                    <StatusBadge status={sub.status} />
                  </div>
                  {priceLabel && <p className="text-[var(--color-fg)]">{priceLabel}</p>}
                  {subEndsOn && (
                    <p className="text-[var(--color-muted-fg)]">
                      {subCanceling ? 'Ends' : 'Renews'} on {new Date(subEndsOn).toLocaleDateString()}
                    </p>
                  )}
                  {subManagedExternally && isEntitlingStatus(sub.status) && (
                    <p className="text-xs text-[var(--color-muted-fg)]">
                      Managed through your billing account. Changes and cancellations are made there.
                    </p>
                  )}
                  {isEntitlingStatus(sub.status) && !subCanceling && canCheckout && !subManagedExternally && !boughtOnce(plan) && (
                    <form action={cancelSubscriptionAction.bind(null, slug, orgId, sub.id)} className="pt-2">
                      <ConfirmSubmit
                        variant="neutral"
                        label={cancelText.label}
                        title={`Cancel ${plan?.name ?? 'this subscription'}?`}
                        message={cancelText.message}
                        confirmLabel={cancelText.confirmLabel}
                        pendingLabel="Cancelling…"
                      >
                        <label className="block space-y-1 text-sm">
                          <span className="text-[var(--color-muted-fg)]">Why are you cancelling? (optional)</span>
                          <select name="reason" defaultValue="" className="w-full rounded border border-[var(--color-border)] bg-transparent px-2 py-1">
                            <option value="">Prefer not to say</option>
                            {CANCEL_REASON_OPTIONS.map(([value, text]) => (
                              <option key={value} value={value}>
                                {text}
                              </option>
                            ))}
                          </select>
                        </label>
                      </ConfirmSubmit>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-[var(--color-muted-fg)]">
            {billingOrg ? 'This team has no active subscription.' : "You don't have an active subscription."}
          </p>
        )}
      </Card>

      {config!.billingEnabled && plans.length === 0 && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Plans</h2>
          <p className="text-sm text-[var(--color-muted-fg)]">No plans are available right now. Please check back soon.</p>
        </Card>
      )}

      {config!.billingEnabled && plans.length > 0 && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Plans</h2>
          {!canCheckout && (
            <p className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-muted-fg)]">
              Billing for this app is managed at the organization level, and only an owner or
              admin can change the plan. Ask your team owner.
            </p>
          )}
          <ul className="space-y-2">
            {plans.map((plan) => {
              const offer = planOffer(plan, { held: heldPlanIds.has(plan.id), canCheckout });
              return (
                <li key={plan.id} className="rounded-md border border-[var(--color-border)] px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm">
                      <span className="font-medium text-[var(--color-fg)]">{plan.name}</span>{' '}
                      <span className="text-[var(--color-muted-fg)]">{formatPlanPrice(plan)}</span>
                    </div>
                    {offer.kind === 'current' && (
                      <span className="text-xs text-[var(--color-muted-fg)]">Current</span>
                    )}
                    {offer.kind === 'unavailable' && (
                      <span className="text-xs text-[var(--color-muted-fg)]">{offer.reason}</span>
                    )}
                    {/* The price, its currency and the checkout button are on
                        the plan's own page, so nothing is bought from a list. */}
                    {offer.kind === 'buy' && (
                      <a
                        href={planReviewPath(slug, plan.slug)}
                        className="rounded-md bg-[var(--color-primary)] px-2.5 py-1 text-xs font-medium text-[var(--color-primary-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_40%,transparent)]"
                      >
                        {subscriptions.length > 0 ? 'Switch' : 'Subscribe'}
                        <span className="sr-only"> to {plan.name}</span>
                      </a>
                    )}
                  </div>
                  {offer.kind === 'current' && offer.note && (
                    <p className="mt-1 text-xs text-[var(--color-muted-fg)]">{offer.note}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {config!.billingEnabled && payments.length > 0 && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Billing history</h2>
          <ul className="divide-y divide-[var(--color-border)] text-sm">
            {payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <span className="text-[var(--color-fg)]">
                    {new Date(p.createdAt).toLocaleDateString()}
                  </span>{' '}
                  <span className="truncate text-[var(--color-muted-fg)]">
                    {p.description ?? p.planSlug ?? ''}
                  </span>
                  {refundLine(p) && <p className="text-xs text-[var(--color-muted-fg)]">{refundLine(p)}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="font-medium text-[var(--color-fg)]">
                    {formatMoney(p.amount, p.currency)}
                  </span>
                  <StatusBadge status={p.status} />
                  {p.receiptUrl && (
                    <a
                      href={p.receiptUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs underline text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]"
                    >
                      Receipt
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
