'use client';

/**
 * Watches the API-key / key-id input within the billing-credentials form
 * and flips the sibling `<select name="mode">` to `live` or `test` based
 * on the prefix (sk_live_, sk_test_, rzp_live_, rzp_test_, …). Resolves
 * UX-AUDIT MEDIUM #23 — first-time operators previously pasted `sk_live`
 * while the mode silently stayed at `test`, storing the key in the wrong
 * mode.
 *
 * Pure progressive enhancement: lookup happens via the parent <form>'s
 * elements collection. Operator can still override the auto-pick.
 */

import * as React from 'react';

/** Input names we'll watch — covers Stripe (apiKey) and Razorpay (keyId). */
const WATCH_NAMES = ['apiKey', 'keyId'];

export function BillingModeAutodetect(): React.JSX.Element | null {
  const ref = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const sentinel = ref.current;
    const form = sentinel?.form;
    if (!form) return;
    const select = form.elements.namedItem('mode');
    if (!(select instanceof HTMLSelectElement)) return;

    const inputs = WATCH_NAMES.map((name) => {
      const el = form.elements.namedItem(name);
      return el instanceof HTMLInputElement ? el : null;
    }).filter((el): el is HTMLInputElement => el !== null);

    const onBlur = (event: Event): void => {
      const input = event.currentTarget as HTMLInputElement;
      const v = input.value.trim().toLowerCase();
      if (v.includes('_live_')) select.value = 'live';
      else if (v.includes('_test_')) select.value = 'test';
    };
    inputs.forEach((el) => el.addEventListener('blur', onBlur));
    return () => {
      inputs.forEach((el) => el.removeEventListener('blur', onBlur));
    };
  }, []);

  // Hidden sentinel input gives us a stable handle to the parent <form>
  // without grabbing it via DOM tree-walking from a sibling. It also
  // keeps this component renderable inline in the form layout.
  return <input ref={ref} type="hidden" name="_billing_mode_autodetect" value="1" />;
}
