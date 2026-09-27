/**
 * The 404 for an address no route matches. The portal and the checkout page
 * have separate root layouts, so an unmatched URL belongs to neither and this
 * page supplies its own document.
 */

import './(portal)/globals.css';
import * as React from 'react';
import type { Metadata } from 'next';
import { Card } from '@/components/card';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: false },
};

export default function GlobalNotFound(): React.JSX.Element {
  return (
    <html lang="en">
      <body className="min-h-screen text-[var(--color-fg)]">
        <main className="mx-auto max-w-md px-5 pt-20 pb-10">
          <Card className="text-center">
            <h1 className="text-lg font-semibold text-[var(--color-fg)]">This page isn&apos;t available</h1>
            <p className="mt-3 text-sm text-[var(--color-muted-fg)]">
              The link you followed doesn&apos;t open anything here. Check that you copied the whole address,
              or contact the business you bought from. They can send you a working link.
            </p>
          </Card>
        </main>
      </body>
    </html>
  );
}
