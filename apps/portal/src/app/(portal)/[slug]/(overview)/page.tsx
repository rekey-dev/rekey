import { isEntitlingStatus, type CancelReason } from '@rekey.dev/shared-types';
import * as React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cancelCopy } from '@/lib/cancel-copy';
import { billingOrganization, planReviewPath } from '@/lib/billing-subject';
import { activeOrganizationOf, organizationPath } from '@/lib/organizations';
import { managedElsewhere } from '@/lib/provider-capabilities';
import { getPortalConfig, supportLink } from '@/lib/config';
import { checkoutLocale } from '@/lib/checkout-format';
import {
  PORTAL_TIME_ZONE,
  formatDate,
  formatMoney,
  planPriceBesideName,
  refundLine,
  subscriptionPriceLabel,
} from '@/lib/format';
import { planOffer } from '@/lib/plan-offer';
import { getPortalUser, portalClientFor } from '@/lib/session';
import { redirectWhileTwoFactorOutstanding } from '@/lib/two-factor';
import { redirectWhileProfileOutstanding } from '@/lib/profile-completion';
import { cancelSubscriptionAction } from '@/lib/actions';
import { Banner } from '@/components/banner';
import { CheckoutActivation } from '@/components/checkout-activation';
import { Card } from '@/components/card';
import { StatusBadge } from '@/components/status-badge';
import { ConfirmSubmit } from '@/components/confirm-submit';
import { SubmitButton } from '@/components/submit-button';
import { CreditsCard, EntitlementsCard, UsageCard } from '@/components/account-usage-cards';
import { entitlements, licenses, recentCredits, trialEligibility, usageRemaining } from '@/lib/account-usage';
import { FREE_PLAN_STARTED, freePlanErrorCopy, trialNote } from '@/lib/account-usage-copy';
import { startFreePlanAction } from '@/lib/free-tier-actions';

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
    'The payment provider holding your subscription or unfinished checkout isn’t available here any more, so a new one can’t be started.',
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
  await redirectWhileTwoFactorOutstanding(slug, session.accessToken);
  await redirectWhileProfileOutstanding(slug, session.user, null);

  const config = await getPortalConfig(slug);
  const client = await portalClientFor(slug);
  // client/config are non-null here (layout already resolved the slug).
  const isOrgBilled = config!.billingSubject === 'org';

  // On org-billed apps, the subscription belongs to a team: the active one, or
  // the first the user owns or admins. Only an owner or admin manages its
  // billing here; a member can look.
  const billingOrg = isOrgBilled
    ? await billingOrganization(client!, session.accessToken, activeOrganizationOf(session.user))
    : null;
  const orgId = billingOrg?.id ?? null;

  const subjectOpts = orgId ? { organizationId: orgId } : undefined;
  const [current, live, planPage, payments, features, usage, credits, held, trials] = await Promise.all([
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
      ? client!.getPlans({ limit: 100 }, { accessToken: session.accessToken })
      : Promise.resolve({ items: [], defaultPlanSlug: null }),
    // Billing history. Non-critical, never let it break the dashboard.
    config!.billingEnabled
      ? client!
          .listPayments(session.accessToken, 12)
          .then((r) => r.items)
          .catch(() => [])
      : Promise.resolve([]),
    entitlements(config!, session.accessToken),
    usageRemaining(config!, session.accessToken),
    recentCredits(config!, session.accessToken),
    licenses(config!, session.accessToken, 1),
    // Org-billed trials are answered for the team checkout would bill, so none without one.
    !isOrgBilled || orgId ? trialEligibility(config!, session.accessToken, orgId) : Promise.resolve(new Map()),
  ]);
  const plans = planPage.items;
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
  const canCheckout = !isOrgBilled || billingOrg?.canManage === true;
  // Start appears only on the plan POST /billing/subscribe activates, and only
  // for a customer with no subscription: starting it would add a second one.
  const freeTierPlanId =
    subscriptions.length === 0 ? (plans.find((p) => p.isFree && p.slug === planPage.defaultPlanSlug)?.id ?? null) : null;
  const freeError = typeof sp.free_error === 'string' ? sp.free_error : undefined;

  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const notice = typeof sp.e === 'string' ? sp.e : undefined;
  const checkout = typeof sp.checkout === 'string' ? sp.checkout : undefined;
  const supportHref = supportLink(config!.branding);
  const locale = checkoutLocale((await headers()).get('accept-language'));
  const dateOf = (value: Date | string): string => formatDate(value, locale, PORTAL_TIME_ZONE);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Your account</h1>
      {checkout === 'success' && (
        // A checkout's row stays PENDING until the provider's webhook lands.
        <CheckoutActivation activated={subscriptions.length > 0 && !subscriptions.some((s) => s.status === 'PENDING')} />
      )}
      {checkout === 'canceled' && <Banner tone="info">Checkout canceled.</Banner>}
      {sp.free === FREE_PLAN_STARTED && <Banner tone="success">You are on the free plan.</Banner>}
      {freeError && <Banner tone="error">{freePlanErrorCopy(freeError)}</Banner>}
      {/* Reports what happened, rather than assuming the request was granted:
          the same redirect lands here after an immediate cancellation, where
          "will end at the close of the current period" was simply untrue. */}
      {notice === 'canceled' && (
        <Banner tone="info">
          {canceled?.cancelAt && endsOn
            ? `Your ${canceledPlanName ? `${canceledPlanName} ` : ''}subscription will end on ${dateOf(endsOn)}.`
            : 'Your subscription has been canceled.'}
        </Banner>
      )}
      {error && (
        <Banner tone="error">
          {CHECKOUT_ERR[error] ?? 'Something went wrong. Please try again.'}
          {error === 'BILLING_ORGANIZATION_REQUIRED' && (
            <>
              {' '}
              <a href={organizationPath(slug)} className="underline">
                Choose or create an organization
              </a>
              .
            </>
          )}
          {supportHref && (
            <>
              {' '}
              <a
                href={supportHref}
                className="underline"
                {...(supportHref.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                Contact support
              </a>{' '}
              if you need help.
            </>
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
              const cancelText = cancelCopy(sub, dateOf);
              const subEndsOn = sub.cancelAt ?? sub.currentPeriodEnd ?? null;
              // The subscription's own price, which can differ from the
              // plan's price today and from its default.
              const priceLabel = subscriptionPriceLabel(sub.price, plan);
              return (
                <li key={sub.id} className="space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-[var(--color-fg)]">{plan?.name ?? 'Your plan'}</span>
                    <StatusBadge status={sub.status} />
                  </div>
                  {priceLabel && <p className="text-[var(--color-fg)]">{priceLabel}</p>}
                  {subEndsOn && (
                    <p className="text-[var(--color-muted-fg)]">
                      {subCanceling ? 'Ends' : 'Renews'} on {dateOf(subEndsOn)}
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
                        variant="danger"
                        label={cancelText.label}
                        title={`Cancel ${plan?.name ?? 'this subscription'}?`}
                        message={cancelText.message}
                        confirmLabel={cancelText.confirmLabel}
                        pendingLabel="Canceling…"
                      >
                        <label className="block space-y-1 text-sm">
                          <span className="text-[var(--color-muted-fg)]">Why are you canceling? (optional)</span>
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

      {config!.auth.devices && (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-fg)]">Devices</h2>
          <p className="text-sm text-[var(--color-muted-fg)]">
            See the computers signed in to {config!.branding.displayName || config!.name}, and remove one you no longer use.{' '}
            <a href={`/${slug}/devices`} className="underline hover:text-[var(--color-fg)]">
              Manage devices
            </a>
          </p>
        </Card>
      )}

      <EntitlementsCard
        entitlements={features}
        locale={locale}
        devicesHref={config!.auth.devices ? `/${slug}/devices` : null}
      />
      <UsageCard usage={usage} locale={locale} dateOf={dateOf} />
      <CreditsCard balance={features?.creditBalance ?? null} ledger={credits} locale={locale} dateOf={dateOf} />
      {held !== null && held.length > 0 && (
        <Card>
          <h2 className="mb-2 text-sm font-semibold text-[var(--color-fg)]">Licenses</h2>
          <p className="text-sm text-[var(--color-muted-fg)]">
            See your license keys, their status and when they expire.{' '}
            <a href={`/${slug}/licenses`} className="underline hover:text-[var(--color-fg)]">
              View licenses
            </a>
          </p>
        </Card>
      )}

      {config!.billingEnabled && plans.length === 0 && (
        <Card id="plans">
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Plans</h2>
          <p className="text-sm text-[var(--color-muted-fg)]">No plans are available right now. Please check back soon.</p>
        </Card>
      )}

      {config!.billingEnabled && plans.length > 0 && (
        <Card id="plans">
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Plans</h2>
          {!canCheckout && (
            <p className="mb-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-muted-fg)]">
              Billing for this app is managed at the organization level, and only an owner or
              admin can change the plan. Ask your team owner, or{' '}
              <a href={organizationPath(slug)} className="underline hover:text-[var(--color-fg)]">
                choose another organization
              </a>
              .
            </p>
          )}
          <ul className="space-y-2">
            {plans.map((plan) => {
              const offer = planOffer(plan, { held: heldPlanIds.has(plan.id), canCheckout });
              // A free plan is started, never checked out: there is nothing to pay.
              const sells = offer.kind === 'buy' && !plan.isFree;
              const trial = sells ? trialNote(trials.get(plan.slug)) : null;
              const startsFree = plan.isFree && !heldPlanIds.has(plan.id) && canCheckout && plan.id === freeTierPlanId;
              const priceBeside = planPriceBesideName(plan);
              return (
                <li key={plan.id} className="rounded-md border border-[var(--color-border)] px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm">
                      <span className="font-medium text-[var(--color-fg)]">{plan.name}</span>
                      {priceBeside && (
                        <>
                          {' '}
                          <span className="text-[var(--color-muted-fg)]">{priceBeside}</span>
                        </>
                      )}
                    </div>
                    {offer.kind === 'current' && (
                      <span className="text-xs text-[var(--color-muted-fg)]">Current</span>
                    )}
                    {offer.kind === 'unavailable' && (
                      <span className="text-xs text-[var(--color-muted-fg)]">{offer.reason}</span>
                    )}
                    {/* The price, its currency and the checkout button are on
                        the plan's own page, so nothing is bought from a list. */}
                    {sells && (
                      <a
                        href={planReviewPath(slug, plan.slug)}
                        className="inline-flex min-h-11 items-center rounded-md bg-[var(--color-primary)] px-3 text-xs font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]"
                      >
                        {plan.kind === 'SUBSCRIPTION' ? 'Subscribe' : 'Buy'}
                        <span className="sr-only">{plan.kind === 'SUBSCRIPTION' ? ' to' : ''} {plan.name}</span>
                      </a>
                    )}
                    {startsFree && (
                      <form action={startFreePlanAction.bind(null, slug, orgId)}>
                        <SubmitButton pendingLabel="Starting…" className="text-xs">
                          Start<span className="sr-only"> {plan.name}</span>
                        </SubmitButton>
                      </form>
                    )}
                  </div>
                  {trial && <p className="mt-1 text-xs text-[var(--color-muted-fg)]">{trial}</p>}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {config!.billingEnabled && payments.length > 0 && (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Billing history</h2>
          <table className="w-full table-fixed text-sm">
            <thead className="sr-only">
              <tr>
                <th scope="col">Payment</th>
                <th scope="col">Amount and status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="py-2 pr-3 align-top">
                    <span className="block text-[var(--color-fg)]">{dateOf(p.createdAt)}</span>
                    <span className="block truncate text-[var(--color-muted-fg)]">{p.description ?? p.planSlug ?? ''}</span>
                    {refundLine(p, locale) && <span className="block text-xs text-[var(--color-muted-fg)]">{refundLine(p, locale)}</span>}
                  </td>
                  <td className="w-36 py-2 align-top sm:w-72">
                    <div className="flex flex-col items-end gap-1 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
                      <span className="font-medium tabular-nums text-[var(--color-fg)]">
                        {formatMoney(p.amount, p.currency, locale)}
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
