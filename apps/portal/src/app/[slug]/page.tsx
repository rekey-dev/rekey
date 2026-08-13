import { isEntitlingStatus } from '@rekey.dev/shared-types';
import * as React from 'react';
import { redirect } from 'next/navigation';
import { cancelCopy } from '@/lib/cancel-copy';
import { getPortalConfig, supportLink } from '@/lib/config';
import { formatMoney, formatPlanPrice } from '@/lib/format';
import { getPortalUser, portalClientFor } from '@/lib/session';
import { cancelSubscriptionAction, checkoutAction } from '@/lib/actions';
import { Banner } from '@/components/banner';
import { Card } from '@/components/card';
import { StatusBadge } from '@/components/status-badge';
import { ConfirmSubmit } from '@/components/confirm-submit';
import { ProviderRadios } from '@/components/provider-radios';

/**
 * Checkout / cancel failures, translated for the merchant's customer.
 *
 * Audience rule from not-found.tsx applies: no error codes, and none of the
 * API's operator `fix` text — "configure a provider in Panel → Billing" is an
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
  PLAN_NOT_FOUND: 'That plan isn’t available any more.',
  PLAN_INACTIVE: 'That plan isn’t available any more.',
  BILLING_ORGANIZATION_REQUIRED:
    'This plan is billed to your team, so a team owner or admin has to start it.',
  BILLING_PROVIDER_SWITCH_BLOCKED:
    'Your current subscription is billed through a different payment provider. It needs to be canceled before you start this one.',
  BILLING_BOUND_PROVIDER_UNAVAILABLE:
    'The payment provider holding your current subscription isn’t available here any more, so a new one can’t be started. Contact support.',
  BILLING_SUBSCRIPTION_SUBJECT_CONFLICT:
    'You already have this plan on another account of yours. It has to be canceled and finish before you can start it here.',
  SUBSCRIPTION_NOT_FOUND: 'We couldn’t find that subscription — it may already be canceled.',
};

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
  // user OWNS or ADMINS a team, they can manage that team's billing here; pick
  // the first such team. Otherwise the plans are read-only (a member can look
  // but only an owner/admin can change the plan).
  let billingOrg: { id: string; name: string } | null = null;
  if (isOrgBilled) {
    // `?limit=100` deliberately: this picks the first team the user can manage,
    // and the default 50-row window could exclude it for someone in many teams.
    // `page.total` says whether even 100 was short.
    const orgs = await client!
      .listOrganizations(session.accessToken, { limit: 100 })
      .then((r) => r.items)
      .catch(() => []);
    const managed = orgs.find((o) => o.role === 'OWNER' || o.role === 'ADMIN');
    if (managed) billingOrg = { id: managed.id, name: managed.name };
  }
  const orgId = billingOrg?.id ?? null;

  const [subscription, plans, providers, payments] = await Promise.all([
    client!.getSubscription(session.accessToken, orgId ? { organizationId: orgId } : undefined),
    config!.billingEnabled ? client!.getPlans().then((r) => r.items) : Promise.resolve([]),
    // Powers the "Pay with…" picker. Public (publishable key, no token). A hiccup
    // here must never break the dashboard — fall back to the auto-routed flow.
    config!.billingEnabled
      ? client!.listBillingProviders().then((r) => r.providers).catch(() => [])
      : Promise.resolve([]),
    // Billing history. Non-critical — never let it break the dashboard.
    config!.billingEnabled
      ? client!
          .listPayments(session.accessToken, 12)
          .then((r) => r.items)
          .catch(() => [])
      : Promise.resolve([]),
  ]);
  const currentPlan = subscription ? plans.find((p) => p.id === subscription.planId) : undefined;
  const canceling = Boolean(subscription?.cancelAt);
  /** Which of the two cancellations this customer is actually about to get. */
  const cancelText = cancelCopy(subscription ?? { status: 'NONE', currentPeriodEnd: null });
  /**
   * When access actually stops. `cancelAt` first, because the two diverge on
   * exactly the path this page used to get wrong: on an immediate cancellation
   * `currentPeriodEnd` is the date the customer had been paid up to, while
   * `cancelAt` is the day they really lose access.
   */
  const endsOn = subscription?.cancelAt ?? subscription?.currentPeriodEnd ?? null;
  // Individual apps: always self-checkout. Org apps: only when we resolved a
  // team the user can manage. Members of org-billed apps get a read-only view.
  const canCheckout = !isOrgBilled || billingOrg !== null;
  // Only offer a choice when there's more than one provider; with one (or none)
  // the server-side geo router picks automatically — keep the current behavior.
  const showProviderPicker = providers.length > 1;

  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const notice = typeof sp.e === 'string' ? sp.e : undefined;
  const checkout = typeof sp.checkout === 'string' ? sp.checkout : undefined;
  const supportHref = supportLink(config!.branding);

  return (
    <div className="space-y-6">
      {checkout === 'success' && <Banner tone="success">Checkout complete — your subscription will activate shortly.</Banner>}
      {checkout === 'canceled' && <Banner tone="info">Checkout canceled.</Banner>}
      {/* Reports what happened, rather than assuming the request was granted:
          the same redirect lands here after an immediate cancellation, where
          "will end at the close of the current period" was simply untrue. */}
      {notice === 'canceled' && (
        <Banner tone="info">
          {canceling && endsOn
            ? `Your subscription will end on ${new Date(endsOn).toLocaleDateString()}.`
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
        {subscription ? (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-3">
              <span className="font-medium text-[var(--color-fg)]">{currentPlan?.name ?? subscription.planId}</span>
              <StatusBadge status={subscription.status} />
            </div>
            {endsOn && (
              <p className="text-[var(--color-muted-fg)]">
                {canceling ? 'Ends' : 'Renews'} on {new Date(endsOn).toLocaleDateString()}
              </p>
            )}
            {isEntitlingStatus(subscription.status) && !canceling && canCheckout && (
              <form action={cancelSubscriptionAction.bind(null, slug, orgId)} className="pt-2">
                <ConfirmSubmit
                  variant="neutral"
                  label={cancelText.label}
                  title="Cancel subscription?"
                  message={cancelText.message}
                  confirmLabel={cancelText.confirmLabel}
                  pendingLabel="Cancelling…"
                />
              </form>
            )}
          </div>
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
              const current = plan.id === subscription?.planId;
              return (
                <li key={plan.id} className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] px-3 py-2">
                  <div className="text-sm">
                    <span className="font-medium text-[var(--color-fg)]">{plan.name}</span>{' '}
                    <span className="text-[var(--color-muted-fg)]">
                      {formatPlanPrice(plan)}
                    </span>
                  </div>
                  {current ? (
                    <span className="text-xs text-[var(--color-muted-fg)]">Current</span>
                  ) : canCheckout ? (
                    <form action={checkoutAction.bind(null, slug, orgId)}>
                      <input type="hidden" name="planSlug" value={plan.slug} />
                      <ConfirmSubmit
                        size="sm"
                        label={subscription ? 'Switch' : 'Subscribe'}
                        title={subscription ? `Switch to ${plan.name}?` : `Subscribe to ${plan.name}?`}
                        message={`This takes you to checkout for ${plan.name} at ${formatPlanPrice(plan)}.`}
                        confirmLabel="Continue to checkout"
                        pendingLabel="Opening checkout…"
                      >
                        {showProviderPicker && <ProviderRadios providers={providers} />}
                      </ConfirmSubmit>
                    </form>
                  ) : null}
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
