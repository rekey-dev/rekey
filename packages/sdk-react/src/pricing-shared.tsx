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
import type { PlanDto, PublicPlanDto, ResolvedPriceDto, TrialEligibilityItemDto } from '@rekey.dev/shared-types';
import { priceFallbackMessage } from '@rekey.dev/shared-types/currency';

/**
 * The plan fields `<PricingTable>` renders, a genuine slice of `PublicPlanDto`
 * (what `billing.getPlans()` returns) rather than a look-alike interface, so a
 * rename in shared-types breaks the build here instead of quietly rendering
 * `undefined`. Pass the `items` of `getPlans()` as they are.
 *
 * `interval` / `kind` / `creditsAmount` stay optional and nullable so a caller
 * can hand-build a plan for a marketing page without inventing billing state.
 */
export type PricingPlan = Pick<PublicPlanDto, 'id' | 'slug' | 'name' | 'isFree' | 'checkout'> & {
  /**
   * The price this buyer would be charged, as the API resolved it, or null for
   * a plan with no flat price. The table renders `price.formatted` and does no
   * arithmetic: which price applies, and how its amount is written, are the
   * API's decisions.
   */
  price: PricingPlanResolvedPrice | null;
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
   * On its own this only labels a plan as having a trial. Whether THIS buyer
   * may start it is a separate question, answered by `trialEligibility` on the
   * grid; without that, the CTA stays the ordinary one, because rendering
   * "Start free" for someone checkout will refuse is the failure the
   * eligibility endpoint exists to prevent.
   */
  trialDays?: number | null | undefined;
  /**
   * Every price the plan sells at, the default one included, as
   * `billing.getPlans()` returns them. Read to decide which providers can take
   * the plan, never to pick the price shown. A plan built by hand lists its
   * one price here too; a free plan lists none.
   */
  prices: readonly PricingPlanPrice[];
};

/**
 * The part of a plan's resolved `price` the table reads. `reason` is
 * `fallback` when the price selected for the buyer cannot be charged and the
 * default price is shown instead; the card then says so.
 */
export type PricingPlanResolvedPrice = Pick<ResolvedPriceDto, 'currency' | 'amount' | 'formatted'> & {
  reason?: ResolvedPriceDto['reason'] | undefined;
  /** With `reason: 'fallback'`: the currency that could not be charged. The note names it. */
  requestedCurrency?: ResolvedPriceDto['requestedCurrency'] | undefined;
};

/** One price on a plan: an integer amount in the minor unit of `currency`. */
export interface PricingPlanPrice {
  currency: string;
  amount: number;
  /** Where the price applies. Empty means wherever the currency is the local one. */
  countries?: readonly string[] | undefined;
}

/**
 * The provider a pricing grid would post, with what its account can charge.
 * `currencies` is the list the API returned: an empty list charges nothing.
 * Left out, the grid cannot judge and treats the provider as able to charge.
 */
export interface SelectedProvider {
  provider: string;
  currencies?: readonly string[] | undefined;
  /** Display name, for the line a plan shows when this provider cannot take it. */
  label?: string | undefined;
  /**
   * True once the buyer changed the picker from the provider it preselected.
   * A preselected provider is not a choice: posting it with a plan that has
   * more than one price would let it decide which price the buyer pays.
   */
  chosen?: boolean | undefined;
}

/**
 * The provider a plan's checkout form posts, or null when it posts none and
 * the API routes the checkout.
 *
 * A plan with one price posts the selected provider when it can charge it. A
 * plan with more than one posts it only when the buyer chose it.
 *
 * @example
 * ```ts
 * postedProvider(pro, { provider: 'stripe', chosen: false }); // null for a plan with an INR price too
 * ```
 */
export function postedProvider(
  plan: Pick<PricingPlan, 'isFree' | 'prices'>,
  selected: SelectedProvider | undefined,
): string | null {
  if (selected === undefined || !providerCanChargePlan(selected, plan)) return null;
  const hasLocalPrices = plan.prices.length > 1;
  return hasLocalPrices && selected.chosen !== true ? null : selected.provider;
}

/**
 * Whether a provider account can charge `currency`: whether its list holds
 * it. An empty list charges nothing. With no list at all there is nothing to
 * judge by, and the answer is yes.
 *
 * @example
 * ```ts
 * providerCanCharge({ provider: 'razorpay', currencies: ['INR'] }, 'USD'); // false
 * providerCanCharge({ provider: 'stripe', currencies: [] }, 'USD'); // false
 * providerCanCharge({ provider: 'stripe' }, 'USD'); // true: no list to judge by
 * ```
 */
export function providerCanCharge(
  provider: { currencies?: readonly string[] | undefined },
  currency: string,
): boolean {
  const listed = provider.currencies;
  if (listed === undefined) return true;
  const wanted = currency.toUpperCase();
  return listed.some((code) => code.toUpperCase() === wanted);
}

/**
 * Whether a provider account can charge a plan at any of its prices. A plan
 * with no price charges nothing.
 *
 * Which price a buyer is charged is the API's decision at checkout, so a
 * provider that can only charge the plan's rupee price is still one this plan
 * can be bought through.
 *
 * @example
 * ```ts
 * const pro = { isFree: false, prices: [{ currency: 'USD', amount: 1900 }, { currency: 'INR', amount: 149900 }] };
 * providerCanChargePlan({ provider: 'razorpay', currencies: ['INR'] }, pro); // true
 * ```
 */
export function providerCanChargePlan(
  provider: { currencies?: readonly string[] | undefined },
  plan: Pick<PricingPlan, 'isFree' | 'prices'>,
): boolean {
  if (plan.isFree || plan.prices.length === 0) return true;
  return plan.prices.some((price) => providerCanCharge(provider, price.currency));
}

/**
 * The price line of a plan card. The amount is `price.formatted`, written by
 * the API, so it reads the same here, in the hosted portal and in the panel.
 * A plan with no flat price reads "Free" when it is free and "Usage based"
 * when it bills by use.
 *
 * @example
 * ```ts
 * priceLabel({ ...pro, kind: 'SUBSCRIPTION', interval: 'MONTH',
 *   price: { currency: 'USD', amount: 1900, formatted: '$19.00' } });
 * // { main: '$19.00', sub: '/month' }
 * ```
 */
export function priceLabel(plan: PricingPlan): { main: string; sub?: string } {
  if (plan.price === null) return { main: plan.isFree ? 'Free' : 'Usage based' };
  const amount = plan.price.formatted;
  if (plan.kind === 'SUBSCRIPTION' && plan.interval) {
    return { main: amount, sub: `/${plan.interval.toLowerCase()}` };
  }
  if (plan.kind === 'CREDIT' && plan.creditsAmount) {
    return { main: amount, sub: `· ${plan.creditsAmount} credits` };
  }
  return { main: amount };
}

/**
 * What the grid needs from one plan's trial answer. A slice of
 * `TrialEligibilityItemDto` (the shape `billing.getTrialEligibility()` and
 * `getTrialEligibility()` return), so field drift in shared-types is a compile
 * error here rather than a silently unlabelled button.
 */
export type PlanTrialEligibility = Pick<
  TrialEligibilityItemDto,
  'planSlug' | 'trialDays' | 'eligible' | 'provider'
>;

/** Trial days to advertise for a plan, or null when there is no trial to offer. */
function trialDaysFor(
  plan: PricingPlan,
  answer: PlanTrialEligibility | undefined,
  posted: string | null,
): number | null {
  // The answer holds for the provider it was resolved against. A form that
  // posts another one starts a checkout the answer says nothing about.
  if (answer?.provider !== undefined && posted !== null && posted !== answer.provider) return null;
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
  /**
   * What a plan's card says when its `price.reason` is `fallback`: the price
   * selected for the buyer cannot be charged, and the default price is shown
   * and will be charged instead. Defaults to one plain sentence naming the
   * price they pay.
   */
  priceFallbackNote?: React.ReactNode;
  /** What a paid plan's card shows in place of its button when `checkout.ready` is false. */
  unavailableLabel?: React.ReactNode;
  /**
   * The provider selected in the picker. Posted as `provider` with each plan
   * it can charge at one of the plan's prices, except that a plan with more
   * than one price posts it only once the buyer has changed the picker
   * (`chosen`). Left off the others so the API routes them, and those plans
   * say so in one line.
   */
  selectedProvider?: SelectedProvider | undefined;
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
  trialEligibility, priceFallbackNote, unavailableLabel = 'Not available right now', selectedProvider,
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
        const price = priceLabel(plan);
        const posted = postedProvider(plan, selectedProvider);
        const formFields = posted !== null ? { ...hiddenFields, provider: posted } : hiddenFields;
        const routedElsewhere = selectedProvider !== undefined && !providerCanChargePlan(selectedProvider, plan);
        const isCurrent = currentPlanSlug != null && plan.slug === currentPlanSlug;
        const isFree = plan.isFree;
        // A free plan applies without a checkout, so only a paid one can be unavailable.
        const isUnavailable = !isFree && !plan.checkout.ready;
        const fellBack = plan.price?.reason === 'fallback';
        const isCredit = plan.kind === 'CREDIT';
        const trialDays = trialDaysFor(plan, trialBySlug.get(plan.slug), posted);
        return (
          <div
            key={plan.id}
            className={cx(
              `rekey-plan${isCurrent ? ' rekey-plan-current' : ''}${isUnavailable ? ' rekey-plan-unavailable' : ''}`,
              'planCard',
            )}
          >
            <div className={cx('rekey-plan-name', 'title')}>{plan.name}</div>
            <div className={cx('rekey-price', 'price')}>
              {price.main}
              {price.sub && <span className="rekey-price-sub"> {price.sub}</span>}
            </div>
            {fellBack && plan.price && (
              <div role="note" className={cx('rekey-subtitle rekey-plan-price-note', 'subtitle')}>
                {priceFallbackNote ??
                  (plan.price.requestedCurrency
                    ? priceFallbackMessage({ requested: { currency: plan.price.requestedCurrency }, charged: plan.price })
                    : `Prices in your local currency are not available yet. You will pay ${plan.price.formatted}.`)}
              </div>
            )}
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
                <span className={cx('rekey-badge', 'badge')}>-</span>
              ) : isUnavailable ? (
                <span className={cx('rekey-badge rekey-plan-unavailable-label', 'badge')}>{unavailableLabel}</span>
              ) : (
                <>
                  <CheckoutFormBody
                    planSlug={plan.slug}
                    {...(checkoutAction ? { action: checkoutAction } : {})}
                    {...(checkoutUrl ? { actionUrl: checkoutUrl } : {})}
                    {...(formFields ? { hiddenFields: formFields } : {})}
                    block
                  >
                    {trialDays !== null
                      ? `Start ${trialDays} day${trialDays === 1 ? '' : 's'} free`
                      : isCredit ? 'Buy' : ctaLabel}
                  </CheckoutFormBody>
                  {routedElsewhere && (
                    <div className={cx('rekey-subtitle rekey-plan-provider-note', 'subtitle')}>
                      {selectedProvider.label ?? selectedProvider.provider} cannot take this plan, so
                      checkout opens with another provider.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
