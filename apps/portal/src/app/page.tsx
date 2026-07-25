/**
 * Root landing for the hosted portal. There's no single app here — each
 * Application's portal lives at /<slug>. Reaching the bare host means a missing
 * slug, so point the visitor at the right shape.
 */

import * as React from 'react';

export default function RootPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-md px-5 pt-20 text-center">
      {/* Customers only know the merchant, not ReliPay — keep the heading
          neutral and confine the platform name to a footer-size credit. */}
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Customer portal</h1>
      <p className="mt-2 text-sm text-[var(--color-muted-fg)]">
        Manage your subscription and billing.
      </p>
      <p className="mt-2 text-sm text-[var(--color-muted-fg)]">
        Open the portal link you were given — it includes the application name, like{' '}
        <code className="font-mono">/your-app</code>.
      </p>
      <p className="mt-10 text-xs text-[var(--color-muted-fg)]">Powered by ReliPay</p>
    </div>
  );
}
