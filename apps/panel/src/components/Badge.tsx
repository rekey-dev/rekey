import * as React from 'react';

/**
 * Small status/label pill. Consolidates the ad-hoc badge styling scattered
 * across pages — role chips, verified/pending dots, invite status, email send
 * status — into one tonal primitive.
 *
 * Tones use a soft tint fill + a readable foreground that clears WCAG AA in
 * both themes (the `/10` fill keeps the chip quiet; the text carries the
 * meaning). `dot` adds a leading status dot for state badges.
 *
 * For brand/teal use `tone="brand"` (drives off the --color-primary token so
 * it tracks the theme). `mono` is handy for role names / identifiers.
 */

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]',
  success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  danger: 'bg-red-500/10 text-red-700 dark:text-red-400',
  info: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  brand: 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]',
};

const DOT_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--color-faint-fg)]',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  info: 'bg-sky-500',
  brand: 'bg-[var(--color-primary)]',
};

export function Badge({
  children,
  tone = 'neutral',
  dot = false,
  mono = false,
  className = '',
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
  mono?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        mono ? 'font-mono text-[11px]' : '',
        TONES[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONES[tone]}`} />}
      {children}
    </span>
  );
}
