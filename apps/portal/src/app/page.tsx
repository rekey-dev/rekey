/**
 * Root landing for the hosted portal. There's no single app here — each
 * Application's portal lives at /<slug>. Reaching the bare host means a missing
 * slug, so point the visitor at the right shape.
 */

import * as React from 'react';

export default function RootPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-md px-5 pt-20 text-center">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">ReliPay customer portal</h1>
      <p className="mt-2 text-sm text-[var(--color-muted-fg)]">
        Open your provider&apos;s portal link — it includes the application name, like{' '}
        <code className="font-mono">/your-app</code>.
      </p>
    </div>
  );
}
