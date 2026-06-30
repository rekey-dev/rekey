'use client';

/**
 * Copy-to-clipboard button. Pairs with any code/text element by passing
 * `value`. Inline by default; `variant="block"` for full-width banners.
 *
 * Tiny piece of state: shows "Copied" for 1.5s after a successful copy.
 * Falls back to no-op on browsers without clipboard API (rare; old IE).
 */

import * as React from 'react';
import { track, AnalyticsEvent } from '@/lib/analytics';

export function CopyButton({
  value,
  label = 'Copy',
  variant = 'inline',
}: {
  value: string;
  label?: string;
  variant?: 'inline' | 'block';
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      track(AnalyticsEvent.CopyClicked, { label });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No-op — secure context required, or user denied.
    }
  }

  const base =
    'inline-flex items-center gap-1.5 rounded-md border text-xs font-medium transition-colors';
  const cls =
    variant === 'block'
      ? `${base} w-full justify-center px-3 py-2 border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-neutral-50 dark:hover:bg-neutral-800`
      : `${base} px-2 py-1 border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-neutral-50 dark:hover:bg-neutral-800`;

  return (
    <button type="button" onClick={copy} className={cls}>
      {copied ? (
        <>
          <svg className="w-3 h-3 text-green-600 dark:text-green-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 111.4-1.4L8.5 12 15.3 5.3a1 1 0 011.4 0z" clipRule="evenodd" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M8 3a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2H8z" />
            <path d="M4 7a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-1H8a4 4 0 01-4-4V7z" />
          </svg>
          {label}
        </>
      )}
    </button>
  );
}
