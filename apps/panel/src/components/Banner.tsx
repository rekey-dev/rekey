import * as React from 'react';

/**
 * Tonal banner primitive — the standard inline feedback strip (form errors,
 * saved confirmations, contextual notices). Consolidates the ad-hoc
 * `rounded border px-3 py-2` strings the page-level banners hand-roll.
 *
 * Tones mirror <Badge>: a soft /10 tint fill + a readable foreground that
 * clears WCAG AA in both themes, plus a /25 border of the same hue so the
 * strip reads as a surface, not a chip.
 *
 * Accessibility: `error` renders with role="alert" (interrupts, announced
 * immediately); the other tones use aria-live="polite" — same convention as
 * FlashBanner.
 */

export type BannerTone = 'success' | 'error' | 'warning' | 'info';

const TONES: Record<BannerTone, string> = {
  success: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  error: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400',
  warning: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  info: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-400',
};

export function Banner({
  tone,
  children,
  className = '',
}: {
  tone: BannerTone;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      aria-live={tone === 'error' ? undefined : 'polite'}
      className={['rounded border px-3 py-2 text-sm', TONES[tone], className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}
