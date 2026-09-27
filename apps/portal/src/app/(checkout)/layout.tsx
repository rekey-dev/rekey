/**
 * The checkout page's own root layout. Nothing the portal's root layout loads
 * reaches a payment page: no portal stylesheet, and no tag a future change to
 * the portal layout might add. Only this layout's stylesheet and the scripts
 * the page itself renders with the request's nonce.
 */

import './checkout.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Checkout',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function CheckoutRootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--ck-bg)] text-[var(--ck-fg)] antialiased">{children}</body>
    </html>
  );
}
