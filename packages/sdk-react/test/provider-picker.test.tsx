/**
 * <ProviderPicker> — the "Pay with…" radio-card group.
 *
 * Load-bearing behaviour pinned here:
 *   - one radio per provider, friendly names, a labelled radiogroup (a11y);
 *   - the FIRST provider (the geo router's top pick) is selected by default;
 *   - uncontrolled mode posts the selected `provider` in the form's FormData
 *     with no JS wiring (the checked radio is what submits) — this is what lets
 *     it drop into the existing checkout `<form>`;
 *   - controlled mode (`value` + `onChange`) fires `onChange` with the new id
 *     and does NOT self-update (the parent owns the value).
 *
 * The provider list is always a PROP — the component never fetches it (the
 * providers endpoint rejects public keys), mirroring <PricingTable plans>.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProviderPicker, type ProviderOption } from '../src/provider-picker.js';

const PROVIDERS: ProviderOption[] = [
  { provider: 'stripe', priority: 0, countries: ['US', 'GB'] },
  { provider: 'paypal', priority: 1, countries: ['US'] },
  { provider: 'razorpay', priority: 2, countries: ['IN'] },
];

describe('<ProviderPicker> — rendering + a11y', () => {
  it('renders one radio per provider inside a labelled radiogroup', () => {
    render(<ProviderPicker providers={PROVIDERS} />);
    const group = screen.getByRole('radiogroup');
    expect(group).not.toBeNull();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    // The group is labelled by its visible heading.
    expect(group.getAttribute('aria-labelledby')).toBeTruthy();
  });

  it('shows friendly display names (Stripe / PayPal / Razorpay)', () => {
    const { container } = render(<ProviderPicker providers={PROVIDERS} />);
    expect(container.textContent).toContain('Stripe');
    expect(container.textContent).toContain('PayPal');
    expect(container.textContent).toContain('Razorpay');
  });

  it('renders the default "Pay with" label, and omits it when label={null}', () => {
    const { container, rerender } = render(<ProviderPicker providers={PROVIDERS} />);
    expect(container.textContent).toContain('Pay with');
    rerender(<ProviderPicker providers={PROVIDERS} label={null} />);
    const group = screen.getByRole('radiogroup');
    expect(group.getAttribute('aria-labelledby')).toBeNull();
  });

  it('renders nothing when the providers list is empty', () => {
    const { container } = render(<ProviderPicker providers={[]} />);
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
  });
});

describe('<ProviderPicker> — default selection', () => {
  it('selects the FIRST provider (the geo router top pick) by default', () => {
    render(<ProviderPicker providers={PROVIDERS} />);
    const stripe = screen.getByRole('radio', { name: /stripe/i }) as HTMLInputElement;
    const paypal = screen.getByRole('radio', { name: /paypal/i }) as HTMLInputElement;
    expect(stripe.checked).toBe(true);
    expect(paypal.checked).toBe(false);
  });

  it('honours defaultValue over the first entry (uncontrolled)', () => {
    render(<ProviderPicker providers={PROVIDERS} defaultValue="razorpay" />);
    const razorpay = screen.getByRole('radio', { name: /razorpay/i }) as HTMLInputElement;
    expect(razorpay.checked).toBe(true);
  });
});

describe('<ProviderPicker> — uncontrolled form posting (zero JS)', () => {
  it('posts the default provider in the surrounding form FormData', () => {
    const { container } = render(
      <form>
        <ProviderPicker providers={PROVIDERS} />
      </form>,
    );
    const form = container.querySelector('form')!;
    const data = new FormData(form);
    expect(data.get('provider')).toBe('stripe');
  });

  it('posts the newly-clicked provider after the user selects it', () => {
    const { container } = render(
      <form>
        <ProviderPicker providers={PROVIDERS} />
      </form>,
    );
    const form = container.querySelector('form')!;
    fireEvent.click(screen.getByRole('radio', { name: /paypal/i }));
    expect(new FormData(form).get('provider')).toBe('paypal');
  });

  it('uses a custom field `name` when provided', () => {
    const { container } = render(
      <form>
        <ProviderPicker providers={PROVIDERS} name="payment_provider" />
      </form>,
    );
    const data = new FormData(container.querySelector('form')!);
    expect(data.get('payment_provider')).toBe('stripe');
    expect(data.get('provider')).toBeNull();
  });
});

describe('<ProviderPicker> — controlled mode', () => {
  it('reflects the controlled `value` and fires onChange without self-updating', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ProviderPicker providers={PROVIDERS} value="paypal" onChange={onChange} />,
    );
    const paypal = screen.getByRole('radio', { name: /paypal/i }) as HTMLInputElement;
    const razorpay = screen.getByRole('radio', { name: /razorpay/i }) as HTMLInputElement;
    expect(paypal.checked).toBe(true);

    fireEvent.click(razorpay);
    // onChange fires with the new id…
    expect(onChange).toHaveBeenCalledWith('razorpay');
    // …but the controlled value hasn't changed, so paypal is still checked.
    expect((screen.getByRole('radio', { name: /paypal/i }) as HTMLInputElement).checked).toBe(true);

    // Parent updates the value → razorpay reflects.
    rerender(<ProviderPicker providers={PROVIDERS} value="razorpay" onChange={onChange} />);
    expect((screen.getByRole('radio', { name: /razorpay/i }) as HTMLInputElement).checked).toBe(true);
  });
});
