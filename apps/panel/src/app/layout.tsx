import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Suspense } from 'react';
import localFont from 'next/font/local';
import { THEME_INIT } from '@/components/ThemeToggle';
import { Analytics } from '@/components/providers/analytics';
import { TrackFlag } from '@/components/analytics/track-flag';

// Brand faces — same self-hosted fonts as the marketing site (etherlabz brand).
// Akkurat = body/sans, Feature = display serif. Metric-matched fallbacks kill FOUC.
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
  title: 'Rekey Panel',
  description: 'Operator panel for Rekey — auth + billing administration.',
  // The panel is an authenticated application, not a search target — keep it
  // out of search indexes (also see robots.ts, which disallows crawling).
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en" suppressHydrationWarning className={`${fontAkkurat.variable} ${fontFeature.variable}`}>
      <head>
        {/* Set the theme class before paint so there's no light/dark flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-screen text-[var(--color-fg)]">
        {children}
        <Analytics />
        {/* Converts server-action `?e=` success flags into GA4 events. */}
        <Suspense fallback={null}>
          <TrackFlag />
        </Suspense>
      </body>
    </html>
  );
}
