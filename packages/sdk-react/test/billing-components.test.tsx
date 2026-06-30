/**
 * Billing widgets — <PricingTable> + <CheckoutButton>.
 *
 * The load-bearing behavior here is the org-billing gate: when an app bills
 * per-team and the user has no active team, checkout will fail server-side, so
 * the table MUST render a "team required" notice instead of dead upgrade buttons
 * that lead the user into a wall. We also pin price formatting, the current-plan
 * badge, free-plan CTA suppression, and that the checkout form posts planSlug
 * (+ any org hidden field) to the supplied action.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { PricingTable, CheckoutButton, type PricingPlan } from '../src/billing-components.js';
import type { ProviderOption } from '../src/provider-picker.js';

const noop = vi.fn();

const FREE: PricingPlan = { id: 'p_free', slug: 'free', name: 'Free', amount: 0, currency: 'USD', kind: 'SUBSCRIPTION' };
const PRO: PricingPlan = { id: 'p_pro', slug: 'pro_monthly', name: 'Pro', amount: 1500, currency: 'USD', kind: 'SUBSCRIPTION', interval: 'MONTH' };
const CREDIT: PricingPlan = { id: 'p_cr', slug: 'pack_100', name: '100 Credits', amount: 999, currency: 'USD', kind: 'CREDIT', creditsAmount: 100 };

describe('<PricingTable> — org-billing gate', () => {
  it('renders the team-required notice (not buttons) when orgGateBlocking', () => {
    render(<PricingTable plans={[FREE, PRO]} checkoutAction={noop} orgGateBlocking />);
    // The default gate is a status alert nudging the user to a team.
    const status = screen.getByRole('status');
    expect(status.textContent).toMatch(/team/i);
    // Crucially: NO upgrade/checkout buttons are rendered behind the gate.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Pro')).toBeNull();
  });

  it('renders a custom orgGate node when provided', () => {
    render(
      <PricingTable plans={[PRO]} checkoutAction={noop} orgGateBlocking orgGate={<div>pick a team first</div>} />,
    );
    expect(screen.queryByText('pick a team first')).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders the plans + upgrade buttons when NOT gated', () => {
    render(<PricingTable plans={[FREE, PRO]} checkoutAction={noop} />);
    expect(screen.queryByText('Pro')).not.toBeNull();
    // Pro is a paid plan → it has an upgrade button.
    expect(screen.getByRole('button', { name: /choose/i })).not.toBeNull();
  });
});

describe('<PricingTable> — price formatting', () => {
  it('shows "Free" as the price for a zero-amount plan', () => {
    const { container } = render(<PricingTable plans={[FREE]} checkoutAction={noop} hideFreeCta={false} />);
    // The price slot (not the plan name) reads "Free".
    expect(container.querySelector('.relipay-price')!.textContent).toContain('Free');
  });

  it('formats a subscription price with the currency symbol and interval', () => {
    const { container } = render(<PricingTable plans={[PRO]} checkoutAction={noop} />);
    expect(container.textContent).toContain('$15');
    expect(container.textContent).toContain('/month');
  });

  it('formats a credit pack with the credits sub-label', () => {
    const { container } = render(<PricingTable plans={[CREDIT]} checkoutAction={noop} />);
    expect(container.textContent).toContain('$9.99');
    expect(container.textContent).toContain('100 credits');
  });

  it('labels the credit-pack CTA "Buy" rather than the upgrade label', () => {
    render(<PricingTable plans={[CREDIT]} checkoutAction={noop} />);
    expect(screen.getByRole('button', { name: 'Buy' })).not.toBeNull();
  });
});

describe('<PricingTable> — current plan + free CTA', () => {
  it('marks the current plan and renders no upgrade button for it', () => {
    render(<PricingTable plans={[PRO]} checkoutAction={noop} currentPlanSlug="pro_monthly" />);
    expect(screen.queryByText(/current plan/i)).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('hides the free plan CTA by default (free has no checkout)', () => {
    render(<PricingTable plans={[FREE]} checkoutAction={noop} />);
    // No checkout button for the free plan.
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('<CheckoutButton>', () => {
  it('renders a submit button wired to a form that carries planSlug', () => {
    const { container } = render(<CheckoutButton planSlug="pro_monthly" action={noop} />);
    const form = container.querySelector('form')!;
    const hidden = form.querySelector('input[name="planSlug"]') as HTMLInputElement;
    expect(hidden).not.toBeNull();
    expect(hidden.value).toBe('pro_monthly');
    expect(within(form).getByRole('button').getAttribute('type')).toBe('submit');
  });

  it('appends hidden fields (e.g. the active org id) to the form', () => {
    const { container } = render(
      <CheckoutButton planSlug="pro_monthly" action={noop} hiddenFields={{ orgId: 'org_42' }} />,
    );
    const orgInput = container.querySelector('input[name="orgId"]') as HTMLInputElement;
    expect(orgInput).not.toBeNull();
    expect(orgInput.value).toBe('org_42');
  });

  it('honours the disabled prop (used by the org-gate path)', () => {
    render(<CheckoutButton planSlug="pro_monthly" action={noop} disabled />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('uses custom children as the label', () => {
    render(<CheckoutButton planSlug="pro_monthly" action={noop}>Upgrade to Pro</CheckoutButton>);
    expect(screen.getByRole('button').textContent).toBe('Upgrade to Pro');
  });
});

const PROVIDERS: ProviderOption[] = [
  { provider: 'stripe', priority: 0 },
  { provider: 'razorpay', priority: 1 },
];

/** Read the `provider` hidden input out of a given plan's checkout form. */
function providerFieldFor(container: HTMLElement, planSlug: string): HTMLInputElement | null {
  const planInput = container.querySelector(`input[name="planSlug"][value="${planSlug}"]`);
  const form = planInput?.closest('form');
  return (form?.querySelector('input[name="provider"]') as HTMLInputElement) ?? null;
}

describe('<PricingTable> — provider picker wiring', () => {
  it('renders a <ProviderPicker> above the grid when providers are passed', () => {
    render(<PricingTable plans={[PRO]} checkoutAction={noop} providers={PROVIDERS} />);
    // One radiogroup with one radio per provider.
    expect(screen.getByRole('radiogroup')).not.toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('threads the DEFAULT (first) provider into each plan checkout form', () => {
    const { container } = render(
      <PricingTable plans={[PRO, CREDIT]} checkoutAction={noop} providers={PROVIDERS} />,
    );
    // First provider (stripe) is selected by default → both paid plans carry it.
    expect(providerFieldFor(container, 'pro_monthly')!.value).toBe('stripe');
    expect(providerFieldFor(container, 'pack_100')!.value).toBe('stripe');
  });

  it('updates every plan form to reflect a newly-selected provider', () => {
    const { container } = render(
      <PricingTable plans={[PRO, CREDIT]} checkoutAction={noop} providers={PROVIDERS} />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /razorpay/i }));
    expect(providerFieldFor(container, 'pro_monthly')!.value).toBe('razorpay');
    expect(providerFieldFor(container, 'pack_100')!.value).toBe('razorpay');
  });

  it('preserves existing hiddenFields alongside the provider field', () => {
    const { container } = render(
      <PricingTable
        plans={[PRO]}
        checkoutAction={noop}
        providers={PROVIDERS}
        hiddenFields={{ orgId: 'org_42' }}
      />,
    );
    const form = container.querySelector('input[name="planSlug"][value="pro_monthly"]')!.closest('form')!;
    expect((form.querySelector('input[name="orgId"]') as HTMLInputElement).value).toBe('org_42');
    expect((form.querySelector('input[name="provider"]') as HTMLInputElement).value).toBe('stripe');
  });

  it('shows the team-required gate (and no picker) when providers AND orgGateBlocking', () => {
    render(
      <PricingTable plans={[PRO]} checkoutAction={noop} providers={PROVIDERS} orgGateBlocking />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/team/i);
    // Behind the gate there's nothing to pay with yet → no picker, no buttons.
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('<PricingTable> — no providers (unchanged Server-Component path)', () => {
  it('renders NO provider picker and NO provider field when providers is omitted', () => {
    const { container } = render(<PricingTable plans={[PRO]} checkoutAction={noop} />);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(container.querySelector('input[name="provider"]')).toBeNull();
    // The plan + its upgrade button still render exactly as before.
    expect(screen.getByRole('button', { name: /choose/i })).not.toBeNull();
  });
});
