import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import { THEME_INIT } from '@/components/ThemeToggle';

const fontAkkurat = localFont({
  variable: '--font-akkurat',
  display: 'swap',
  src: [
    { path: '../../public/fonts/Akkurat.ttf', weight: '400', style: 'normal' },
    { path: '../../public/fonts/FontsFree-Net-Akkurat-Bold.ttf', weight: '700', style: 'normal' },
  ],
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
});

const fontFeature = localFont({
  variable: '--font-feature',
  display: 'swap',
  src: [
    { path: '../../public/fonts/FeatureDisplay-Regular.ttf', weight: '400', style: 'normal' },
    { path: '../../public/fonts/FeatureDisplay-Bold.ttf', weight: '700', style: 'normal' },
  ],
  fallback: ['ui-serif', 'Georgia', 'serif'],
});

export const metadata: Metadata = {
  title: 'ReliPay Super Admin',
  description: 'Read-only super-admin dashboard for ReliPay operators.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning className={`${fontAkkurat.variable} ${fontFeature.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-screen text-[var(--color-fg)]">{children}</body>
    </html>
  );
}
