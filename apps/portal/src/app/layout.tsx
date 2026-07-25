import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  // Neutral default — the [slug] layout's generateMetadata overrides this with
  // the merchant's own name, which is the only brand a customer recognizes.
  title: 'Customer portal',
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
