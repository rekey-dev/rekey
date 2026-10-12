/**
 * Billing widgets, <PricingTable> + <CheckoutButton>.
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

const READY = { ready: true };
// With no provider connected a free plan reads `ready: false` and still applies.
const FREE: PricingPlan = { id: 'p_free', slug: 'free', name: 'Free', isFree: true, checkout: { ready: false }, price: null, prices: [], kind: 'SUBSCRIPTION' };
const PRO: PricingPlan = {
  id: 'p_pro', slug: 'pro_monthly', name: 'Pro', isFree: false, checkout: READY, kind: 'SUBSCRIPTION', interval: 'MONTH',
  price: { currency: 'USD', amount: 1500, formatted: '$15.00', reason: 'default' },
  prices: [{ currency: 'USD', amount: 1500 }],
};
const CREDIT: PricingPlan = {
  id: 'p_cr', slug: 'pack_100', name: '100 Credits', isFree: false, checkout: READY, kind: 'CREDIT', creditsAmount: 100,
  price: { currency: 'USD', amount: 999, formatted: '$9.99', reason: 'default' },
  prices: [{ currency: 'USD', amount: 999 }],
};

describe('<PricingTable>, org-billing gate', () => {
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

describe('<PricingTable>, price formatting', () => {
  it('shows "Free" as the price for a free plan', () => {
    const { container } = render(<PricingTable plans={[FREE]} checkoutAction={noop} hideFreeCta={false} />);
    // The price slot (not the plan name) reads "Free".
    expect(container.querySelector('.rekey-price')!.textContent).toContain('Free');
  });

  it('does not call a plan with no flat price free when it bills by use', () => {
    const usage: PricingPlan = { ...FREE, id: 'p_use', slug: 'metered', name: 'Metered', isFree: false, kind: 'USAGE', checkout: READY };
    const { container } = render(<PricingTable plans={[usage]} checkoutAction={noop} />);
    expect(container.querySelector('.rekey-price')!.textContent).toBe('Usage based');
  });

  it('shows a subscription price as the API wrote it, with the interval', () => {
    const { container } = render(<PricingTable plans={[PRO]} checkoutAction={noop} />);
    expect(container.querySelector('.rekey-price')!.textContent).toBe('$15.00 /month');
  });

  // The table renders `price.formatted` and computes nothing: an amount and a
  // currency that disagree with the text never change what is shown.
  it.each([
    ['JPY', 1500, '¥1,500'],
    ['HUF', 500000, 'HUF\u00a05,000'],
    ['INR', 149900, '₹1,499.00'],
    ['USD', 1900, 'written by the API'],
  ])('renders the formatted text of a %s price verbatim', (currency, amount, formatted) => {
    const plan: PricingPlan = { ...PRO, kind: 'LICENSE', price: { currency, amount, formatted }, prices: [{ currency, amount }] };
    const { container } = render(<PricingTable plans={[plan]} checkoutAction={noop} />);
    expect(container.querySelector('.rekey-price')!.textContent).toBe(formatted);
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

describe('<PricingTable>: the price resolved for the buyer', () => {
  const PRO_IN_INDIA: PricingPlan = {
    ...PRO,
    price: { currency: 'INR', amount: 149900, formatted: '₹1,499.00', reason: 'country' },
    prices: [...PRO.prices, { currency: 'INR', amount: 149900, countries: ['IN'] }],
  };
  const PRO_FELL_BACK: PricingPlan = {
    ...PRO_IN_INDIA,
    price: { currency: 'USD', amount: 1500, formatted: '$15.00', reason: 'fallback' },
  };
  const STRIPE: ProviderOption[] = [{ provider: 'stripe' }];

  it('shows the resolved price, not the first or the default one in `prices`', () => {
    const { container } = render(<PricingTable plans={[PRO_IN_INDIA]} checkoutAction={noop} />);
    const price = container.querySelector('.rekey-price')!.textContent;
    expect(price).toBe('₹1,499.00 /month');
    expect(container.querySelector('.rekey-plan-price-note')).toBeNull();
  });

  it('posts no currency to checkout', () => {
    const { container } = render(<PricingTable plans={[PRO_IN_INDIA]} checkoutAction={noop} />);
    expect([...container.querySelectorAll('input[type="hidden"]')].map((el) => el.getAttribute('name'))).toEqual([
      'planSlug',
    ]);
  });

  it('tells the buyer when the default price is charged because theirs cannot be', () => {
    const { container } = render(<PricingTable plans={[PRO_FELL_BACK, CREDIT]} checkoutAction={noop} />);
    const notes = container.querySelectorAll('.rekey-plan-price-note');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toBe('Prices in your local currency are not available yet. You will pay $15.00.');
    const named: PricingPlan = { ...PRO_FELL_BACK, price: { ...PRO_FELL_BACK.price!, requestedCurrency: 'INR' } };
    const second = render(<PricingTable plans={[named]} checkoutAction={noop} />);
    expect(second.container.querySelector('.rekey-plan-price-note')!.textContent).toBe(
      'Prices in INR are not available yet. You will pay $15.00.',
    );
    expect(notes[0]!.closest('.rekey-plan')!.textContent).toContain('Pro');
    // Still buyable: the note informs, it does not block.
    expect(within(notes[0]!.closest('.rekey-plan') as HTMLElement).getByRole('button', { name: /choose/i })).not.toBeNull();
  });

  it('takes your own wording for the fallback note', () => {
    const { container } = render(
      <PricingTable plans={[PRO_FELL_BACK]} checkoutAction={noop} priceFallbackNote="We bill in US dollars for now." />,
    );
    expect(container.querySelector('.rekey-plan-price-note')!.textContent).toBe('We bill in US dollars for now.');
  });

  it('shows the note on the table with a provider picker too', () => {
    const { container } = render(<PricingTable plans={[PRO_FELL_BACK]} providers={STRIPE} checkoutAction={noop} />);
    expect(container.querySelector('.rekey-plan-price-note')).not.toBeNull();
    expect(container.querySelector('.rekey-price')!.textContent).toBe('$15.00 /month');
  });
});

describe('<PricingTable>: a plan whose checkout is not ready', () => {
  const UNAVAILABLE: PricingPlan = { ...PRO, checkout: { ready: false } };

  it('shows it as unavailable, with no button and no checkout form', () => {
    const { container } = render(<PricingTable plans={[UNAVAILABLE, CREDIT]} checkoutAction={noop} />);
    const card = container.querySelector('.rekey-plan-unavailable') as HTMLElement;
    expect(card.textContent).toContain('Pro');
    expect(card.textContent).toContain('Not available right now');
    expect(card.querySelector('form')).toBeNull();
    expect(within(card).queryByRole('button')).toBeNull();
    // The price stays on show, and the other plan is still buyable.
    expect(card.querySelector('.rekey-price')!.textContent).toBe('$15.00 /month');
    expect(screen.getByRole('button', { name: 'Buy' })).not.toBeNull();
  });

  it('takes your own label', () => {
    render(<PricingTable plans={[UNAVAILABLE]} checkoutAction={noop} unavailableLabel="Sold out" />);
    expect(screen.queryByText('Sold out')).not.toBeNull();
  });

  it('still marks it as the current plan for the subscriber who holds it', () => {
    const { container } = render(<PricingTable plans={[UNAVAILABLE]} checkoutAction={noop} currentPlanSlug="pro_monthly" />);
    expect(container.textContent).toContain('Current plan');
    expect(container.textContent).not.toContain('Not available right now');
  });

  it('never shows a free plan as unavailable: it applies without a checkout', () => {
    const { container } = render(<PricingTable plans={[FREE]} checkoutAction={noop} hideFreeCta={false} />);
    expect(container.querySelector('.rekey-plan-unavailable')).toBeNull();
    expect(screen.getByRole('button', { name: /choose/i })).not.toBeNull();
  });
});

describe('<PricingTable> trial eligibility', () => {
  // The whole point of the eligibility endpoint: render "Start 14 days free"
  // or "Choose" from the ANSWER, so the buyer finds out at the button rather
  // than at a 409 BILLING_TRIAL_ALREADY_USED after they commit.
  const ELIGIBLE = [{ planSlug: 'pro_monthly', trialDays: 14, eligible: true }];
  const REDEEMED = [{ planSlug: 'pro_monthly', trialDays: 14, eligible: false }];

  it('offers the trial when this buyer is eligible', () => {
    render(<PricingTable plans={[PRO]} checkoutAction={noop} trialEligibility={ELIGIBLE} />);
    expect(screen.getByRole('button', { name: /start 14 days free/i })).not.toBeNull();
  });

  it('shows the ordinary CTA when the buyer has already used their trial', () => {
    // Advertising a trial here is exactly what gets refused at checkout.
    render(<PricingTable plans={[PRO]} checkoutAction={noop} trialEligibility={REDEEMED} />);
    expect(screen.queryByRole('button', { name: /free/i })).toBeNull();
    expect(screen.getByRole('button', { name: /choose/i })).not.toBeNull();
  });

  it('leaves the table unchanged when no eligibility is supplied', () => {
    // Backward compatibility: every existing caller passes nothing, and a plan
    // "having" a trial is not a statement that THIS buyer may start it.
    render(<PricingTable plans={[PRO]} checkoutAction={noop} />);
    expect(screen.getByRole('button', { name: /choose/i })).not.toBeNull();
  });

  it('does not promise a trial from trialDays alone, with no answer for the buyer', () => {
    const withTrial: PricingPlan = { ...PRO, trialDays: 14 };
    render(<PricingTable plans={[withTrial]} checkoutAction={noop} />);
    expect(screen.queryByRole('button', { name: /free/i })).toBeNull();
  });

  it('says "1 day" rather than "1 days"', () => {
    render(
      <PricingTable
        plans={[PRO]}
        checkoutAction={noop}
        trialEligibility={[{ planSlug: 'pro_monthly', trialDays: 1, eligible: true }]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Start 1 day free' })).not.toBeNull();
  });

  it('marks only the plan the answer names', () => {
    const { container } = render(
      <PricingTable plans={[PRO, CREDIT]} checkoutAction={noop} trialEligibility={ELIGIBLE} />,
    );
    expect(screen.getByRole('button', { name: /start 14 days free/i })).not.toBeNull();
    // The credit pack keeps its own CTA; it was not in the answer.
    expect(screen.getByRole('button', { name: 'Buy' })).not.toBeNull();
    // And the trial CTA is still a real checkout form carrying the plan slug.
    const trialInput = container.querySelector('input[name="planSlug"][value="pro_monthly"]');
    expect(trialInput?.closest('form')).not.toBeNull();
  });

  it('still suppresses the CTA for the current plan', () => {
    render(
      <PricingTable
        plans={[PRO]}
        checkoutAction={noop}
        currentPlanSlug="pro_monthly"
        trialEligibility={ELIGIBLE}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/current plan/i)).not.toBeNull();
  });
});

describe('<PricingTable>, current plan + free CTA', () => {
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

describe('<PricingTable>, provider picker wiring', () => {
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

describe('<PricingTable>, no providers (unchanged Server-Component path)', () => {
  it('renders NO provider picker and NO provider field when providers is omitted', () => {
    const { container } = render(<PricingTable plans={[PRO]} checkoutAction={noop} />);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(container.querySelector('input[name="provider"]')).toBeNull();
    // The plan + its upgrade button still render exactly as before.
    expect(screen.getByRole('button', { name: /choose/i })).not.toBeNull();
  });
});

describe('<PricingTable>: a provider is posted only with a plan it can charge', () => {
  const PRO_INR: PricingPlan = {
    id: 'p_inr', slug: 'pro_india', name: 'Pro India', isFree: false, checkout: READY, kind: 'SUBSCRIPTION', interval: 'MONTH',
    price: { currency: 'INR', amount: 149900, formatted: '₹1,499.00', reason: 'default' },
    prices: [{ currency: 'INR', amount: 149900 }],
  };
  const PAYPAL_NO_INR: ProviderOption = { provider: 'paypal', currencies: ['USD', 'EUR'] };
  const RAZORPAY_INR: ProviderOption = { provider: 'razorpay', currencies: ['inr'] };
  const STRIPE_NONE: ProviderOption = { provider: 'stripe', currencies: [] };

  it('leaves `provider` off a plan whose currency the selected provider cannot charge', () => {
    const { container } = render(
      <PricingTable plans={[PRO, PRO_INR]} checkoutAction={noop} providers={[PAYPAL_NO_INR, RAZORPAY_INR]} />,
    );
    expect(providerFieldFor(container, 'pro_monthly')!.value).toBe('paypal');
    expect(providerFieldFor(container, 'pro_india')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: /razorpay/i }));
    expect(providerFieldFor(container, 'pro_monthly')).toBeNull();
    expect(providerFieldFor(container, 'pro_india')!.value).toBe('razorpay');
  });

  it('keeps the other hidden fields on a plan that posts no provider', () => {
    const { container } = render(
      <PricingTable plans={[PRO, PRO_INR]} checkoutAction={noop} providers={[PAYPAL_NO_INR, RAZORPAY_INR]} hiddenFields={{ orgId: 'org_42' }} />,
    );
    const form = container.querySelector('input[name="planSlug"][value="pro_india"]')!.closest('form')!;
    expect((form.querySelector('input[name="orgId"]') as HTMLInputElement).value).toBe('org_42');
    expect(form.querySelector('input[name="provider"]')).toBeNull();
  });

  it('reads an empty currency list as charging nothing, so that provider is not offered', () => {
    const { container } = render(
      <PricingTable plans={[PRO, PRO_INR]} checkoutAction={noop} providers={[STRIPE_NONE, RAZORPAY_INR]} />,
    );
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['razorpay']);
    expect(providerFieldFor(container, 'pro_monthly')).toBeNull();
    expect(providerFieldFor(container, 'pro_india')!.value).toBe('razorpay');
  });

  it('does not judge a provider handed over with no currency list', () => {
    const { container } = render(
      <PricingTable plans={[PRO, PRO_INR]} checkoutAction={noop} providers={[{ provider: 'stripe' }, { provider: 'paypal' }]} />,
    );
    expect(providerFieldFor(container, 'pro_monthly')!.value).toBe('stripe');
    expect(providerFieldFor(container, 'pro_india')!.value).toBe('stripe');
    fireEvent.click(screen.getByRole('radio', { name: /paypal/i }));
    expect(providerFieldFor(container, 'pro_india')!.value).toBe('paypal');
  });

  it('does not offer a provider that can charge none of the plans shown', () => {
    const { container } = render(
      <PricingTable plans={[PRO]} checkoutAction={noop} providers={[RAZORPAY_INR, PAYPAL_NO_INR]} />,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.queryByRole('radio', { name: /razorpay/i })).toBeNull();
    expect(providerFieldFor(container, 'pro_monthly')!.value).toBe('paypal');
  });

  it('shows no picker and posts no provider when none can charge any plan', () => {
    const { container } = render(
      <PricingTable plans={[PRO]} checkoutAction={noop} providers={[RAZORPAY_INR]} />,
    );
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(providerFieldFor(container, 'pro_monthly')).toBeNull();
    expect(screen.getByRole('button', { name: /choose/i })).not.toBeNull();
  });

  it('says so on the card when the selected provider cannot take a plan', () => {
    const { container } = render(
      <PricingTable plans={[PRO, PRO_INR]} checkoutAction={noop} providers={[PAYPAL_NO_INR, RAZORPAY_INR]} />,
    );
    const cardOf = (slug: string): HTMLElement =>
      container.querySelector(`input[name="planSlug"][value="${slug}"]`)!.closest('.rekey-plan') as HTMLElement;
    expect(cardOf('pro_india').textContent).toContain('PayPal cannot take this plan');
    expect(cardOf('pro_monthly').textContent).not.toContain('cannot take this plan');

    fireEvent.click(screen.getByRole('radio', { name: /razorpay/i }));
    expect(cardOf('pro_monthly').textContent).toContain('Razorpay cannot take this plan');
    expect(cardOf('pro_india').textContent).not.toContain('cannot take this plan');
  });
});

describe('<PricingTable>: a plan with more than one price', () => {
  const PRO_BOTH: PricingPlan = {
    ...PRO,
    prices: [
      { currency: 'USD', amount: 1500 },
      { currency: 'INR', amount: 149900 },
    ],
  };
  const CREDIT_AS_SENT: PricingPlan = CREDIT;
  const RAZORPAY_INR: ProviderOption = { provider: 'razorpay', currencies: ['INR'] };
  const STRIPE_USD: ProviderOption = { provider: 'stripe', currencies: ['USD'] };

  it('offers a provider that charges only the local price', () => {
    render(
      <PricingTable plans={[PRO_BOTH]} checkoutAction={noop} providers={[STRIPE_USD, RAZORPAY_INR]} routedProvider="razorpay" />,
    );
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['stripe', 'razorpay']);
    expect((screen.getByRole('radio', { name: /razorpay/i }) as HTMLInputElement).checked).toBe(true);
  });

  it('posts no provider while the picker is on the one it preselected, so the API picks the price', () => {
    const { container } = render(
      <PricingTable plans={[PRO_BOTH, CREDIT_AS_SENT]} checkoutAction={noop} providers={[STRIPE_USD, RAZORPAY_INR]} />,
    );
    expect(providerFieldFor(container, 'pro_monthly')).toBeNull();
    // A plan with one price still carries the preselected provider.
    expect(providerFieldFor(container, 'pack_100')!.value).toBe('stripe');
  });

  it('posts the provider once the buyer changes the picker, and stops when they change it back', () => {
    const { container } = render(
      <PricingTable plans={[PRO_BOTH]} checkoutAction={noop} providers={[RAZORPAY_INR, STRIPE_USD]} routedProvider="razorpay" />,
    );
    expect(providerFieldFor(container, 'pro_monthly')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /stripe/i }));
    expect(providerFieldFor(container, 'pro_monthly')!.value).toBe('stripe');
    fireEvent.click(screen.getByRole('radio', { name: /razorpay/i }));
    expect(providerFieldFor(container, 'pro_monthly')).toBeNull();
  });
});

describe('<PricingTable>: a trial answer holds for the provider it was resolved against', () => {
  const TRIAL_AT_STRIPE = [{ planSlug: 'pro_monthly', trialDays: 14, eligible: true, provider: 'stripe' }];

  it('drops the trial label when the form would post another provider', () => {
    render(
      <PricingTable plans={[PRO]} checkoutAction={noop} providers={PROVIDERS} trialEligibility={TRIAL_AT_STRIPE} />,
    );
    expect(screen.getByRole('button', { name: 'Start 14 days free' })).not.toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /razorpay/i }));
    expect(screen.queryByRole('button', { name: 'Start 14 days free' })).toBeNull();
    expect(screen.getByRole('button', { name: /choose/i })).not.toBeNull();
  });

  it('keeps it when the form posts no provider, or the answer names none', () => {
    const { unmount } = render(<PricingTable plans={[PRO]} checkoutAction={noop} trialEligibility={TRIAL_AT_STRIPE} />);
    expect(screen.getByRole('button', { name: 'Start 14 days free' })).not.toBeNull();
    unmount();
    render(
      <PricingTable
        plans={[PRO]}
        checkoutAction={noop}
        providers={PROVIDERS}
        routedProvider="razorpay"
        trialEligibility={[{ planSlug: 'pro_monthly', trialDays: 14, eligible: true }]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Start 14 days free' })).not.toBeNull();
  });
});

describe('<PricingTable>: routedProvider', () => {
  it('preselects the provider the API routed to, not the first in the list', () => {
    const { container } = render(
      <PricingTable plans={[PRO]} checkoutAction={noop} providers={PROVIDERS} routedProvider="razorpay" />,
    );
    expect((screen.getByRole('radio', { name: /razorpay/i }) as HTMLInputElement).checked).toBe(true);
    expect(providerFieldFor(container, 'pro_monthly')!.value).toBe('razorpay');
  });

  it('falls back to the first provider when the routed one is not offered', () => {
    const { container } = render(
      <PricingTable plans={[PRO]} checkoutAction={noop} providers={PROVIDERS} routedProvider="paypal" />,
    );
    expect(providerFieldFor(container, 'pro_monthly')!.value).toBe('stripe');
  });
});
