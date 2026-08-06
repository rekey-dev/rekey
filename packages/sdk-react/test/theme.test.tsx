/**
 * Theming system — the appearance contract every widget exposes.
 *
 * Two mechanisms must keep working or every integrator's branding breaks:
 *   1. `appearance.variables` → inline `--rekey-*` CSS custom properties on the
 *      themed root (so overriding a handful of tokens restyles the whole kit).
 *   2. `appearance.elements[slot]` → an extra className merged onto that slot via
 *      `useCx()` (Clerk's per-element override pattern).
 * Plus: light/dark pinning via `data-rekey-theme`, the once-per-document style
 * injection, and `className` forwarding to the root.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Themed, useCx } from '../src/theme.js';

/** Probe component: renders a node whose className is driven by `useCx`. */
function Probe(): React.JSX.Element {
  const cx = useCx();
  return <button className={cx('rekey-btn rekey-btn-primary', 'buttonPrimary')}>go</button>;
}

function root(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.rekey-root');
  if (!el) throw new Error('no .rekey-root rendered');
  return el as HTMLElement;
}

describe('appearance.variables → CSS custom properties', () => {
  it('maps each variable onto the matching --rekey-* custom property', () => {
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
    expect(style.getPropertyValue('--rekey-color-primary')).toBe('#6d28d9');
    expect(style.getPropertyValue('--rekey-color-background')).toBe('#faf5ff');
    expect(style.getPropertyValue('--rekey-radius')).toBe('8px');
    expect(style.getPropertyValue('--rekey-font')).toBe('Inter, sans-serif');
    expect(style.getPropertyValue('--rekey-spacing')).toBe('10px');
  });

  it('sets no custom properties when no variables are supplied', () => {
    const { container } = render(
      <Themed>
        <Probe />
      </Themed>,
    );
    expect(root(container).style.getPropertyValue('--rekey-color-primary')).toBe('');
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
    expect(btn.classList.contains('rekey-btn')).toBe(true);
    expect(btn.classList.contains('rekey-btn-primary')).toBe(true);
    expect(btn.classList.contains('my-cta')).toBe(true);
  });

  it('attaches elements.root + className to the themed root', () => {
    const { container } = render(
      <Themed appearance={{ elements: { root: 'rooty' } }} className="host-class">
        <Probe />
      </Themed>,
    );
    const el = root(container);
    expect(el.classList.contains('rekey-root')).toBe(true);
    expect(el.classList.contains('rooty')).toBe(true);
    expect(el.classList.contains('host-class')).toBe(true);
  });

  it('does not add stray classes for a slot with no override', () => {
    const { container } = render(
      <Themed appearance={{ elements: {} }}>
        <Probe />
      </Themed>,
    );
    expect(container.querySelector('button')!.className).toBe('rekey-btn rekey-btn-primary');
  });
});

describe('light / dark pinning', () => {
  it('pins dark via the string shorthand → data-rekey-theme="dark"', () => {
    const { container } = render(
      <Themed appearance="dark">
        <Probe />
      </Themed>,
    );
    expect(root(container).getAttribute('data-rekey-theme')).toBe('dark');
  });

  it('pins light via the object form → data-rekey-theme="light"', () => {
    const { container } = render(
      <Themed appearance={{ baseTheme: 'light' }}>
        <Probe />
      </Themed>,
    );
    expect(root(container).getAttribute('data-rekey-theme')).toBe('light');
  });

  it('omits the theme attribute when unset (so the OS preference wins)', () => {
    const { container } = render(
      <Themed>
        <Probe />
      </Themed>,
    );
    expect(root(container).hasAttribute('data-rekey-theme')).toBe(false);
  });
});

describe('stylesheet', () => {
  /**
   * This used to assert one `#rekey-react-styles` in `document.head`, put
   * there by an effect. The effect never runs when the components are
   * rendered server-only — Astro without a client directive got correct
   * markup and no styling — so the sheet is rendered into the tree instead.
   * The contract that changed is where it lives, not whether it is there.
   */
  it('renders the rules with the component, not from an effect', () => {
    const { container } = render(
      <Themed>
        <Probe />
      </Themed>,
    );
    const styles = container.querySelectorAll('style[data-rekey-styles]');
    expect(styles.length).toBe(1);
    expect(styles[0]!.textContent).toContain('--rekey-color-primary');
    // Nothing is appended to the document any more.
    expect(document.head.querySelector('#rekey-react-styles')).toBeNull();
  });

  it('emits one copy per top-level Themed, and none for a nested one', () => {
    const { container } = render(
      <Themed>
        <Themed>
          <Probe />
        </Themed>
      </Themed>,
    );
    expect(container.querySelectorAll('style[data-rekey-styles]').length).toBe(1);
  });
});
