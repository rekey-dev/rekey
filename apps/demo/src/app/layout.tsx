import * as React from 'react';
import './globals.css';
import type { Metadata } from 'next';
import localFont from 'next/font/local';

// Brand body face — Akkurat, same as marketing + panel. Self-hosted, swap display.
const fontAkkurat = localFont({
  variable: '--font-akkurat',
  display: 'swap',
  src: [
    { path: '../../public/fonts/Akkurat.ttf', weight: '400', style: 'normal' },
    { path: '../../public/fonts/FontsFree-Net-Akkurat-Bold.ttf', weight: '700', style: 'normal' },
  ],
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
});

export const metadata: Metadata = {
  title: 'ReliPay Demo',
  description: 'Reference Next.js app showing @relipay/node end-to-end',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en" className={fontAkkurat.variable}>
      <body className="min-h-screen text-neutral-900 dark:text-neutral-100">{children}</body>
    </html>
  );
}
