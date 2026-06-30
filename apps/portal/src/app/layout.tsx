import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Billing portal',
  description: 'Manage your subscription, billing history, and account.',
  // Authenticated customer surface — keep it out of search indexes.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body className="min-h-screen text-[var(--color-fg)]">{children}</body>
    </html>
  );
}
