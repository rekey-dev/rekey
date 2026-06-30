/**
 * Theming system — the appearance contract every widget exposes.
 *
 * Two mechanisms must keep working or every integrator's branding breaks:
 *   1. `appearance.variables` → inline `--relipay-*` CSS custom properties on the
 *      themed root (so overriding a handful of tokens restyles the whole kit).
 *   2. `appearance.elements[slot]` → an extra className merged onto that slot via
 *      `useCx()` (Clerk's per-element override pattern).
 * Plus: light/dark pinning via `data-relipay-theme`, the once-per-document style
 * injection, and `className` forwarding to the root.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Themed, useCx } from '../src/theme.js';

/** Probe component: renders a node whose className is driven by `useCx`. */
function Probe(): React.JSX.Element {
  const cx = useCx();
  return <button className={cx('relipay-btn relipay-btn-primary', 'buttonPrimary')}>go</button>;
}

function root(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.relipay-root');
  if (!el) throw new Error('no .relipay-root rendered');
  return el as HTMLElement;
}

describe('appearance.variables → CSS custom properties', () => {
  it('maps each variable onto the matching --relipay-* custom property', () => {
    const { container } = render(
      <Themed
        appearance={{
          variables: {
            colorPrimary: '#6d28d9',
            colorBackground: '#faf5ff',
            borderRadius: '8px',
            fontFamily: 'Inter, sans-serif',
            spacing: '10px',
          },
        }}
      >
        <Probe />
      </Themed>,
    );
    const style = root(container).style;
    expect(style.getPropertyValue('--relipay-color-primary')).toBe('#6d28d9');
    expect(style.getPropertyValue('--relipay-color-background')).toBe('#faf5ff');
    expect(style.getPropertyValue('--relipay-radius')).toBe('8px');
    expect(style.getPropertyValue('--relipay-font')).toBe('Inter, sans-serif');
    expect(style.getPropertyValue('--relipay-spacing')).toBe('10px');
  });

  it('sets no custom properties when no variables are supplied', () => {
    const { container } = render(
      <Themed>
        <Probe />
      </Themed>,
    );
    expect(root(container).style.getPropertyValue('--relipay-color-primary')).toBe('');
  });
});

describe('appearance.elements → per-slot classNames', () => {
  it('merges the slot override onto the base class for that element', () => {
    const { container } = render(
      <Themed appearance={{ elements: { buttonPrimary: 'my-cta' } }}>
        <Probe />
      </Themed>,
    );
    const btn = container.querySelector('button')!;
    expect(btn.classList.contains('relipay-btn')).toBe(true);
    expect(btn.classList.contains('relipay-btn-primary')).toBe(true);
    expect(btn.classList.contains('my-cta')).toBe(true);
  });

  it('attaches elements.root + className to the themed root', () => {
    const { container } = render(
      <Themed appearance={{ elements: { root: 'rooty' } }} className="host-class">
        <Probe />
      </Themed>,
    );
    const el = root(container);
    expect(el.classList.contains('relipay-root')).toBe(true);
    expect(el.classList.contains('rooty')).toBe(true);
    expect(el.classList.contains('host-class')).toBe(true);
  });

  it('does not add stray classes for a slot with no override', () => {
    const { container } = render(
      <Themed appearance={{ elements: {} }}>
        <Probe />
      </Themed>,
    );
    expect(container.querySelector('button')!.className).toBe('relipay-btn relipay-btn-primary');
  });
});

describe('light / dark pinning', () => {
  it('pins dark via the string shorthand → data-relipay-theme="dark"', () => {
    const { container } = render(
      <Themed appearance="dark">
        <Probe />
      </Themed>,
    );
    expect(root(container).getAttribute('data-relipay-theme')).toBe('dark');
  });

  it('pins light via the object form → data-relipay-theme="light"', () => {
    const { container } = render(
      <Themed appearance={{ baseTheme: 'light' }}>
        <Probe />
      </Themed>,
    );
    expect(root(container).getAttribute('data-relipay-theme')).toBe('light');
  });

  it('omits the theme attribute when unset (so the OS preference wins)', () => {
    const { container } = render(
      <Themed>
        <Probe />
      </Themed>,
    );
    expect(root(container).hasAttribute('data-relipay-theme')).toBe(false);
  });
});

describe('stylesheet injection', () => {
  it('injects the kit stylesheet exactly once per document', () => {
    render(
      <>
        <Themed><Probe /></Themed>
        <Themed><Probe /></Themed>
      </>,
    );
    const styles = document.querySelectorAll('#relipay-react-styles');
    expect(styles.length).toBe(1);
    expect(styles[0]!.textContent).toContain('--relipay-color-primary');
  });
});
