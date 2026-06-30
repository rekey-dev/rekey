/**
 * Shared, presentational pieces for the billing widgets.
 *
 * These render helpers carry NO `'use client'` directive and no React state, so
 * they're safe to render from a Server Component. Both the server-friendly
 * `<PricingTable>` (in `billing-components.tsx`) and the interactive,
 * provider-aware variant (`<PricingTableInteractive>`, a client component in
 * `provider-picker.tsx`) import the grid renderer from here — keeping that body
 * in one place without creating an import cycle between the two modules.
 */

import * as React from 'react';
import { useCx } from './theme.js';
import type { FormAction } from './auth-components.js';

/** Minimal plan shape `<PricingTable>` renders — a subset of `PlanDto`. */
export interface PricingPlan {
  id: string;
  slug: string;
  name: string;
  /** Amount in the smallest currency unit (cents/paise). */
  amount: number;
  currency: string;
  /** Billing interval for SUBSCRIPTION plans. */
  interval?: string;
  /** Plan kind — SUBSCRIPTION / CREDIT / LICENSE / USAGE. */
  kind?: string;
  /** Credits granted (CREDIT-kind plans). */
  creditsAmount?: number | null;
  /** Optional marketing description / feature bullets. */
  description?: string;
  features?: string[];
}

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

/** Props the single-plan checkout `<form>` body needs. */
export interface CheckoutFormBodyProps {
  /** The plan slug to check out. Posted as `planSlug` in FormData. */
  planSlug: string;
  /** Server Action that starts checkout (reads `planSlug`) and redirects. */
  action: FormAction;
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
  planSlug, action, hiddenFields, children, variant = 'primary', block = false, disabled = false,
}: CheckoutFormBodyProps): React.JSX.Element {
  const cx = useCx();
  const slot = variant === 'primary' ? 'buttonPrimary' : 'buttonSecondary';
  const klass = cx(
    `relipay-btn relipay-btn-${variant}${block ? ' relipay-btn-block' : ''}`,
    slot,
  );
  return (
    <form action={action} style={block ? { width: '100%' } : undefined}>
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
    <div role="status" className={cx('relipay-alert relipay-alert-info', 'alert')}>
      This app bills per team. Create or switch to a team, then choose a plan.
    </div>
  );
}

/** The pieces of `<PricingTable>` the grid renderer reads. */
export interface PricingGridProps {
  plans: PricingPlan[];
  checkoutAction: FormAction;
  currentPlanSlug?: string | null;
  hiddenFields?: Record<string, string>;
  orgGateBlocking?: boolean;
  orgGate?: React.ReactNode;
  hideFreeCta?: boolean;
  ctaLabel?: string;
}

/**
 * The plan grid itself (no `<Themed>` wrapper — callers provide one). Renders the
 * org-gate when `orgGateBlocking`, otherwise a card per plan with an upgrade
 * button wired to `checkoutAction`. `hiddenFields` rides along on every form, so
 * the interactive variant threads the chosen `provider` through here.
 */
export function PricingGrid({
  plans, checkoutAction, currentPlanSlug = null, hiddenFields,
  orgGateBlocking = false, orgGate, hideFreeCta = true, ctaLabel = 'Choose',
}: PricingGridProps): React.JSX.Element {
  const cx = useCx();

  if (orgGateBlocking) {
    return <>{orgGate ?? <DefaultOrgGate />}</>;
  }

  return (
    <div className={cx('relipay-pricing', 'card')}>
      {plans.map((plan) => {
        const price = formatPrice(plan);
        const isCurrent = currentPlanSlug != null && plan.slug === currentPlanSlug;
        const isFree = plan.amount === 0;
        const isCredit = plan.kind === 'CREDIT';
        return (
          <div
            key={plan.id}
            className={cx(`relipay-plan${isCurrent ? ' relipay-plan-current' : ''}`, 'planCard')}
          >
            <div className={cx('relipay-plan-name', 'title')}>{plan.name}</div>
            <div className={cx('relipay-price', 'price')}>
              {price.main}
              {price.sub && <span className="relipay-price-sub"> {price.sub}</span>}
            </div>
            {plan.description && (
              <div className={cx('relipay-subtitle', 'subtitle')}>{plan.description}</div>
            )}
            {plan.features && plan.features.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: '1.1em', fontSize: '0.8125rem', color: 'var(--relipay-color-text-muted)' }}>
                {plan.features.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            )}
            <div className="relipay-plan-cta">
              {isCurrent ? (
                <span className={cx('relipay-badge relipay-badge-primary', 'badge')}>Current plan</span>
              ) : isFree && hideFreeCta ? (
                <span className={cx('relipay-badge', 'badge')}>—</span>
              ) : (
                <CheckoutFormBody
                  planSlug={plan.slug}
                  action={checkoutAction}
                  {...(hiddenFields ? { hiddenFields } : {})}
                  block
                >
                  {isCredit ? 'Buy' : ctaLabel}
                </CheckoutFormBody>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
