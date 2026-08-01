'use client';

/**
 * Billing widgets — `<PricingTable>` and `<CheckoutButton>`, Clerk-shaped.
 *
 * ── Data + mutation model (same posture as auth/org) ──
 *
 * Plans are public (`billing.getPlans` needs no user token), but checkout is
 * secret-key + user-token guarded, so:
 *
 *   - `<PricingTable>` takes the `plans` array as a PROP — the customer fetches
 *     it server-side (`billing.getPlans()`) and passes it in. It does NOT call
 *     the API from the browser.
 *   - Upgrade / buy is a customer Server Action (reads `planSlug`) wired to
 *     `<form action={…}>`. The action runs `billing.createCheckout` server-side
 *     and redirects to the hosted checkout URL.
 *
 * Org-billing: when `billingSubject === 'org'` and the user isn't inside a team,
 * checkout fails with `BILLING_ORGANIZATION_REQUIRED`. Pass `orgGateBlocking` so
 * the table renders a "team required" gate instead of dead upgrade buttons (the
 * org-scoped subscription is attached by the action via the active-org token).
 *
 * ── Provider choice (optional) ──
 *
 * An Application can enable up to 3 providers; checkout's `provider` is optional
 * (a geo router auto-picks when omitted). Pass a server-fetched `providers` list
 * and `<PricingTable>` renders a `<ProviderPicker>` above the grid and threads the
 * chosen provider into each plan's checkout form. That path needs client state, so
 * it dispatches to an interactive client variant; WITHOUT `providers` the table
 * stays a Server Component exactly as before. The providers endpoint sits at the
 * same trust level as `/plans` (publishable key, no user token), so either side
 * can fetch it — `billing.getProviders()` on the server, `listBillingProviders()`
 * in the browser; see `provider-picker.tsx`.
 */

import * as React from 'react';
import { Themed, type AppearanceProp } from './theme.js';
import { CheckoutFormBody, PricingGrid, type PricingPlan } from './pricing-shared.js';
import { PricingTableInteractive, type ProviderOption } from './provider-picker.js';
import type { FormAction } from './auth-components.js';

export type { PricingPlan } from './pricing-shared.js';

// ---------------------------------------------------------------------------
// <CheckoutButton>
// ---------------------------------------------------------------------------

export interface CheckoutButtonProps {
  /** The plan slug to check out. Posted as `planSlug` in FormData. */
  planSlug: string;
  /** Server Action that starts checkout (reads `planSlug`) and redirects. */
  action: FormAction;
  /** Extra hidden fields appended to the form (e.g. an org id, coupon). */
  hiddenFields?: Record<string, string>;
  children?: React.ReactNode;
  /** Visual variant. */
  variant?: 'primary' | 'secondary';
  /** Render full-width. */
  block?: boolean;
  /** Disable (e.g. when org-billing gate blocks). */
  disabled?: boolean;
  appearance?: AppearanceProp;
  className?: string;
}

/**
 * A single checkout button for one plan (Clerk's `<CheckoutButton>`). Posts the
 * plan slug to your checkout Server Action, which redirects to the hosted
 * checkout. Append the active org id via `hiddenFields` for org-scoped billing.
 *
 * @example
 * ```tsx
 * <CheckoutButton planSlug="pro_monthly" action={checkoutAction}>
 *   Upgrade to Pro
 * </CheckoutButton>
 * ```
 */
export function CheckoutButton(props: CheckoutButtonProps): React.JSX.Element {
  const { appearance, className, block, planSlug, action, hiddenFields, variant, disabled, children } = props;
  return (
    <Themed appearance={appearance} className={className} style={block ? undefined : { display: 'inline-block' }}>
      <CheckoutFormBody
        planSlug={planSlug}
        action={action}
        {...(hiddenFields ? { hiddenFields } : {})}
        {...(variant ? { variant } : {})}
        {...(block ? { block } : {})}
        {...(disabled ? { disabled } : {})}
      >
        {children}
      </CheckoutFormBody>
    </Themed>
  );
}

// ---------------------------------------------------------------------------
// <PricingTable>
// ---------------------------------------------------------------------------

export interface PricingTableProps {
  /** Plans to render — fetch via `billing.getPlans()` server-side and pass here. */
  plans: PricingPlan[];
  /** Server Action that starts checkout for a plan (reads `planSlug`) and redirects. */
  checkoutAction: FormAction;
  /** The slug of the user's current plan — marks it "Current" and disables its button. */
  currentPlanSlug?: string | null;
  /** Extra hidden fields appended to each checkout form (e.g. the active org id). */
  hiddenFields?: Record<string, string>;
  /**
   * When the app bills per-org AND the user isn't inside a team yet, pass `true`
   * to render a "team required" gate instead of upgrade buttons. (Derive from
   * `billingSubject === 'org' && !activeOrgId`.)
   */
  orgGateBlocking?: boolean;
  /** What to render when `orgGateBlocking`. Defaults to a built-in notice. */
  orgGate?: React.ReactNode;
  /** Hide free (amount 0) plans' CTA — they have no checkout. Default true. */
  hideFreeCta?: boolean;
  /** Label for the upgrade CTA. */
  ctaLabel?: string;
  /**
   * The Application's enabled billing providers — fetch with
   * `billing.getProviders()` on the server, or `listBillingProviders()` in the
   * browser (the endpoint accepts the publishable key). When present, a
   * `<ProviderPicker>` renders above the grid and the chosen provider is threaded
   * into every plan's checkout form (posted as `provider`). This makes the table
   * an interactive client component; omit it to keep the table a Server Component.
   */
  providers?: ProviderOption[];
  appearance?: AppearanceProp;
  className?: string;
}

/**
 * Render the Application's plans as a pricing grid with upgrade buttons (Clerk's
 * `<PricingTable>`). Plans come in as a prop (server-fetched); each upgrade posts
 * to your checkout Server Action. Org-scoped when `hiddenFields` carries the
 * active org id, and gated when `orgGateBlocking`.
 *
 * Pass `providers` (server-fetched) to let the user pick a payment provider — the
 * table then renders a `<ProviderPicker>` and threads the choice into checkout.
 * Without `providers`, this stays a Server Component (no client JS).
 *
 * @example
 * ```tsx
 * <PricingTable
 *   plans={plans}                       // billing.getPlans() server-side
 *   providers={providers}               // billing.getProviders() server-side (optional)
 *   currentPlanSlug={isPro ? "pro_monthly" : "free"}
 *   checkoutAction={checkoutAction}     // billing.createCheckout server-side
 *   hiddenFields={activeOrgId ? { orgId: activeOrgId } : undefined}
 *   orgGateBlocking={billingSubject === "org" && !activeOrgId}
 * />
 * ```
 */
export function PricingTable(props: PricingTableProps): React.JSX.Element {
  const {
    providers, appearance, className,
    plans, checkoutAction, currentPlanSlug, hiddenFields,
    orgGateBlocking, orgGate, hideFreeCta, ctaLabel,
  } = props;

  // With a provider list, dispatch to the interactive (client) variant; the
  // selection has to live in React state to thread `provider` into each form.
  if (providers && providers.length > 0) {
    return (
      <PricingTableInteractive
        providers={providers}
        plans={plans}
        checkoutAction={checkoutAction}
        {...(currentPlanSlug !== undefined ? { currentPlanSlug } : {})}
        {...(hiddenFields ? { hiddenFields } : {})}
        {...(orgGateBlocking ? { orgGateBlocking } : {})}
        {...(orgGate !== undefined ? { orgGate } : {})}
        {...(hideFreeCta !== undefined ? { hideFreeCta } : {})}
        {...(ctaLabel !== undefined ? { ctaLabel } : {})}
        {...(appearance !== undefined ? { appearance } : {})}
        {...(className !== undefined ? { className } : {})}
      />
    );
  }

  // No providers → plain Server-Component-friendly grid (unchanged behaviour).
  return (
    <Themed appearance={appearance} className={className}>
      <PricingGrid
        plans={plans}
        checkoutAction={checkoutAction}
        {...(currentPlanSlug !== undefined ? { currentPlanSlug } : {})}
        {...(hiddenFields ? { hiddenFields } : {})}
        {...(orgGateBlocking ? { orgGateBlocking } : {})}
        {...(orgGate !== undefined ? { orgGate } : {})}
        {...(hideFreeCta !== undefined ? { hideFreeCta } : {})}
        {...(ctaLabel !== undefined ? { ctaLabel } : {})}
      />
    </Themed>
  );
}
