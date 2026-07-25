'use client';

/**
 * "You're ready to go live" card — the OnboardingChecklist's successor state.
 * Shown on the applications page once every onboarding step is complete, with
 * quick links to the go-live touchpoints. Dismissal persists per-workspace in
 * localStorage (same deliberate trade-off as the checklist: no new API
 * endpoint for server-side persistence).
 *
 * Rendering is gated on mount so SSR/hydration never flashes a card the
 * operator already dismissed.
 */

import * as React from 'react';
import Link from 'next/link';

export interface ReadyLink {
  label: string;
  description: string;
  href: string;
}

export function ReadyToGoLive({
  links,
  storageKey,
}: {
  links: ReadyLink[];
  /** Per-workspace dismissal key, e.g. `relipay.ready.dismissed.<tenantId>`. */
  storageKey: string;
}): React.JSX.Element | null {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    try {
      setVisible(localStorage.getItem(storageKey) !== '1');
    } catch {
      setVisible(true);
    }
  }, [storageKey]);

  function dismiss(): void {
    try {
      localStorage.setItem(storageKey, '1');
    } catch {
      /* private mode — dismissal just won't persist */
    }
    setVisible(false);
  }

  if (!visible || links.length === 0) return null;

  return (
    <section
      aria-label="Ready to go live"
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-fg)]">
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-[var(--color-primary)]"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="m8.5 12.5 2.5 2.5 4.5-5.5" />
            </svg>
            You&rsquo;re ready to go live
          </h2>
          <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
            Every setup step is done. A few places worth a final look before real traffic:
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
        >
          Dismiss
        </button>
      </div>

      <ul className="mt-4 space-y-1">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="group flex items-baseline gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-[var(--color-fg)]">{link.label}</span>
                <span className="block text-xs text-[var(--color-muted-fg)]">{link.description}</span>
              </span>
              <span
                aria-hidden="true"
                className="ml-auto shrink-0 self-center text-xs text-[var(--color-faint-fg)] transition-transform group-hover:translate-x-0.5"
              >
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
