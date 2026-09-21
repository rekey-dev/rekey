'use client';

/**
 * Shared, presentational pieces for the billing widgets.
 *
 * These render helpers carry NO `'use client'` directive and no React state, so
 * they're safe to render from a Server Component. Both the server-friendly
 * `<PricingTable>` (in `billing-components.tsx`) and the interactive,
 * provider-aware variant (`<PricingTableInteractive>`, a client component in
 * `provider-picker.tsx`) import the grid renderer from here, keeping that body
 * in one place without creating an import cycle between the two modules.
 */

import * as React from 'react';
import { useCx } from './theme.js';
import type { FormAction } from './auth-components.js';
import type { PlanDto, TrialEligibilityItemDto } from '@rekey.dev/shared-types';

/**
 * The plan fields `<PricingTable>` renders, a genuine slice of `PlanDto`
 * rather than a look-alike interface, so a rename in shared-types breaks the
 * build here instead of quietly rendering `undefined` (the same class of bug
 * that made `<OrganizationProfile>` post the wrong id).
 *
 * `interval` / `kind` / `creditsAmount` stay optional and nullable so a caller
 * can hand-build a plan for a marketing page without inventing billing state.
 */
export type PricingPlan = Pick<PlanDto, 'id' | 'slug' | 'name' | 'amount' | 'currency'> & {
  /** Billing interval for SUBSCRIPTION plans. */
  interval?: PlanDto['interval'] | undefined;
  /** Plan kind, SUBSCRIPTION / CREDIT / LICENSE / USAGE. */
  kind?: PlanDto['kind'] | undefined;
  /** Credits granted (CREDIT-kind plans). */
  creditsAmount?: number | null | undefined;
  /** Optional marketing description / feature bullets. */
  description?: string | undefined;
  features?: string[] | undefined;
  /**
   * Free-trial length in days, when this plan offers one.
   *
   * NOT picked from `PlanDto`: the public plan catalogue carries no trial
   * field, so a signed-out pricing page has nothing to read. Supply it from
   * your own copy, or leave it off and let `trialEligibility` carry it, that
   * endpoint reports each plan's real `trialDays` alongside the answer.
   *
   * On its own this only labels a plan as having a trial. Whether THIS buyer
   * may start it is a separate question, answered by `trialEligibility` on the
   * grid; without that, the CTA stays the ordinary one, because rendering
   * "Start free" for someone checkout will refuse is the failure the
   * eligibility endpoint exists to prevent.
   */
  trialDays?: number | null | undefined;
};

/** Format a plan price from minor units. */
export function formatPrice(plan: PricingPlan): { main: string; sub?: string } {
  if (plan.amount === 0) return { main: 'Free' };
  const symbol = currencySymbol(plan.currency);
  const major = (plan.amount / 100).toLocaleString(undefined, {
    minimumFractionDigits: plan.amount % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  const amount = `${symbol}${major}`;
  if (plan.kind === 'SUBSCRIPTION' && plan.interval) {
    return { main: amount, sub: `/${plan.interval.toLowerCase()}` };
  }
  if (plan.kind === 'CREDIT' && plan.creditsAmount) {
    return { main: amount, sub: `· ${plan.creditsAmount} credits` };
  }
  return { main: amount };
}

function currencySymbol(code: string): string {
  switch (code?.toUpperCase()) {
    case 'USD': return '$';
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'INR': return '₹';
    case 'JPY': return '¥';
    default: return `${code} `;
  }
}

/**
 * What the grid needs from one plan's trial answer. A slice of
 * `TrialEligibilityItemDto` (the shape `billing.getTrialEligibility()` and
 * `getTrialEligibility()` return), so field drift in shared-types is a compile
 * error here rather than a silently unlabelled button.
 */
export type PlanTrialEligibility = Pick<
  TrialEligibilityItemDto,
  'planSlug' | 'trialDays' | 'eligible'
>;

/** Trial days to advertise for a plan, or null when there is no trial to offer. */
function trialDaysFor(
  plan: PricingPlan,
  answer: PlanTrialEligibility | undefined,
): number | null {
  // No answer means nobody asked the eligibility endpoint. `trialDays` alone
  // says the plan HAS a trial, never that this buyer may start it, so a CTA
  // promising one would be exactly the "finds out at the 409" flow the endpoint
  // was added to remove.
  if (!answer || !answer.eligible) return null;
  const days = answer.trialDays ?? plan.trialDays ?? null;
  return days !== null && days > 0 ? days : null;
}

/**
 * Prefer the Server Action; otherwise POST to the URL. Same shape the auth
 * components have always used, lifted here so billing behaves identically.
 */
function checkoutFormProps(
  action?: FormAction,
  url?: string,
): { action: FormAction } | { action: string; method: 'post' } | Record<string, never> {
  if (action) return { action };
  if (url) return { action: url, method: 'post' };
  return {};
}

/** Props the single-plan checkout `<form>` body needs. */
export interface CheckoutFormBodyProps {
  /** The plan slug to check out. Posted as `planSlug` in FormData. */
  planSlug: string;
  /** Server Action that starts checkout (reads `planSlug`) and redirects. */
  action?: FormAction | undefined;
  /**
   * Or the URL a plain form POSTs to.
   *
   * A Server Action is Next-only. Everywhere else, Astro, Remix, SvelteKit,
   * an Express app rendering React, a form posts to a route, which is what
   * `<SignIn>` has always accepted via `actionUrl`. The billing components
   * required the action, so they simply could not be used outside Next.
   *
   * Supply one or the other.
   */
  actionUrl?: string | undefined;
  /** Extra hidden fields appended to the form (e.g. an org id, coupon, provider). */
  hiddenFields?: Record<string, string>;
  children?: React.ReactNode;
  /** Visual variant. */
  variant?: 'primary' | 'secondary';
  /** Render full-width. */
  block?: boolean;
  /** Disable (e.g. when org-billing gate blocks). */
  disabled?: boolean;
}

/**
 * The bare `<form action>` + hidden fields + submit button for one plan. Shared
 * by `<CheckoutButton>` and every plan card in the pricing grid.
 */
export function CheckoutFormBody({
  planSlug, action, actionUrl, hiddenFields, children, variant = 'primary', block = false, disabled = false,
}: CheckoutFormBodyProps): React.JSX.Element {
  const cx = useCx();
  const slot = variant === 'primary' ? 'buttonPrimary' : 'buttonSecondary';
  const klass = cx(
    `rekey-btn rekey-btn-${variant}${block ? ' rekey-btn-block' : ''}`,
    slot,
  );
  return (
    <form {...checkoutFormProps(action, actionUrl)} style={block ? { width: '100%' } : undefined}>
      <input type="hidden" name="planSlug" value={planSlug} />
      {hiddenFields &&
        Object.entries(hiddenFields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button type="submit" className={klass} disabled={disabled}>
        {children ?? 'Upgrade'}
      </button>
    </form>
  );
}

/** Default "team required" gate shown when org-billing blocks checkout. */
export function DefaultOrgGate(): React.JSX.Element {
  const cx = useCx();
  return (
    <div role="status" className={cx('rekey-alert rekey-alert-info', 'alert')}>
      This app bills per team. Create or switch to a team, then choose a plan.
    </div>
  );
}

/** The pieces of `<PricingTable>` the grid renderer reads. */
export interface PricingGridProps {
  plans: PricingPlan[];
  /** Server Action that starts checkout. Supply this or `checkoutUrl`. */
  checkoutAction?: FormAction | undefined;
  /** Or the URL a plain form POSTs to, for frameworks without Server Actions. */
  checkoutUrl?: string | undefined;
  currentPlanSlug?: string | null;
  hiddenFields?: Record<string, string>;
  orgGateBlocking?: boolean;
  orgGate?: React.ReactNode;
  hideFreeCta?: boolean;
  ctaLabel?: string;
  /**
   * Per-plan trial answers for the SIGNED-IN buyer, from
   * `GET /billing/trial-eligibility` (`billing.getTrialEligibility()` on the
   * server, `getTrialEligibility()` in the browser). Pass the `items` array.
   *
   * A plan whose answer is `eligible` and carries a positive `trialDays`
   * renders "Start N days free" instead of the ordinary CTA, and every other
   * plan is untouched. Omit this and the grid behaves exactly as before, which
   * is what keeps it a Server Component and keeps existing callers working.
   *
   * Eligibility is per buyer, so this must come from a signed-in read; a
   * signed-out pricing page should leave it off rather than advertise a trial
   * the buyer may not be able to start.
   */
  trialEligibility?: readonly PlanTrialEligibility[] | undefined;
}

/**
 * The plan grid itself (no `<Themed>` wrapper, callers provide one). Renders the
 * org-gate when `orgGateBlocking`, otherwise a card per plan with an upgrade
 * button wired to `checkoutAction`. `hiddenFields` rides along on every form, so
 * the interactive variant threads the chosen `provider` through here.
 */
export function PricingGrid({
  plans, checkoutAction, checkoutUrl, currentPlanSlug = null, hiddenFields,
  orgGateBlocking = false, orgGate, hideFreeCta = true, ctaLabel = 'Choose',
  trialEligibility,
}: PricingGridProps): React.JSX.Element {
  const cx = useCx();

  if (orgGateBlocking) {
    return <>{orgGate ?? <DefaultOrgGate />}</>;
  }

  // Built inline rather than memoised: this component is deliberately
  // hook-light so it can render from a Server Component.
  const trialBySlug = new Map<string, PlanTrialEligibility>(
    (trialEligibility ?? []).map((item) => [item.planSlug, item]),
  );

  return (
    <div className={cx('rekey-pricing', 'card')}>
      {plans.map((plan) => {
        const price = formatPrice(plan);
        const isCurrent = currentPlanSlug != null && plan.slug === currentPlanSlug;
        const isFree = plan.amount === 0;
        const isCredit = plan.kind === 'CREDIT';
        const trialDays = trialDaysFor(plan, trialBySlug.get(plan.slug));
        return (
          <div
            key={plan.id}
            className={cx(`rekey-plan${isCurrent ? ' rekey-plan-current' : ''}`, 'planCard')}
          >
            <div className={cx('rekey-plan-name', 'title')}>{plan.name}</div>
            <div className={cx('rekey-price', 'price')}>
              {price.main}
              {price.sub && <span className="rekey-price-sub"> {price.sub}</span>}
            </div>
            {plan.description && (
              <div className={cx('rekey-subtitle', 'subtitle')}>{plan.description}</div>
            )}
            {plan.features && plan.features.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: '1.1em', fontSize: '0.8125rem', color: 'var(--rekey-color-text-muted)' }}>
                {plan.features.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            )}
            <div className="rekey-plan-cta">
              {isCurrent ? (
                <span className={cx('rekey-badge rekey-badge-primary', 'badge')}>Current plan</span>
              ) : isFree && hideFreeCta ? (
                <span className={cx('rekey-badge', 'badge')}>—</span>
              ) : (
                <CheckoutFormBody
                  planSlug={plan.slug}
                  {...(checkoutAction ? { action: checkoutAction } : {})}
                  {...(checkoutUrl ? { actionUrl: checkoutUrl } : {})}
                  {...(hiddenFields ? { hiddenFields } : {})}
                  block
                >
                  {trialDays !== null
                    ? `Start ${trialDays} day${trialDays === 1 ? '' : 's'} free`
                    : isCredit ? 'Buy' : ctaLabel}
                </CheckoutFormBody>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
