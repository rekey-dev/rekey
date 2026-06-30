'use client';

/**
 * Success banner for `?saved=…` redirect feedback (WP7).
 *
 * The server-action → `redirect('…?saved=1')` pattern is kept (no toast
 * library, no client state store), but the banner itself is now a small
 * client island that:
 *
 *   1. strips the query param via `router.replace` right after mount, so
 *      refresh / back / copy-paste of the URL doesn't re-show stale success;
 *   2. offers an explicit dismiss (×) button;
 *   3. auto-fades after ~5s (visual fade then unmount). Hovering pauses
 *      nothing — 5s is long enough to read a one-liner.
 */

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

export function SavedBanner({
  message,
  /** Query params to strip after render. Defaults to `['saved']`. */
  params = ['saved'],
}: {
  message: string;
  params?: string[];
}): React.JSX.Element | null {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [visible, setVisible] = React.useState(true);
  const [fading, setFading] = React.useState(false);

  // Strip the success params from the URL without adding a history entry.
  React.useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    let changed = false;
    for (const p of params) {
      if (next.has(p)) {
        next.delete(p);
        changed = true;
      }
    }
    if (changed) {
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-fade after ~5s.
  React.useEffect(() => {
    const fade = setTimeout(() => setFading(true), 5000);
    const gone = setTimeout(() => setVisible(false), 5700);
    return () => {
      clearTimeout(fade);
      clearTimeout(gone);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      aria-live="polite"
      className={`flex items-start justify-between gap-3 rounded border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300 transition-opacity duration-700 ${
        fading ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <p>{message}</p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setVisible(false)}
        className="shrink-0 rounded p-0.5 leading-none text-emerald-700/70 dark:text-emerald-300/70 hover:text-emerald-800 dark:hover:text-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
      >
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
