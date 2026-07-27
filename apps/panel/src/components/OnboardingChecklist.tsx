'use client';

/**
 * "Get started" checklist card for new workspaces. The *state* is computed
 * server-side (the applications page derives it from data it already fetches
 * or can fetch cheaply) and passed in as props — this component only owns the
 * dismissal, which persists per-workspace in localStorage (server-side
 * persistence would need a new API endpoint; deliberately skipped).
 *
 * The server doesn't render this at all once every step is done, so the card
 * disappears for good on completion without any client logic.
 *
 * Rendering is gated on mount: localStorage isn't available during SSR, so we
 * render nothing until the client has checked the dismissal flag (avoids a
 * flash-then-hide and a hydration mismatch).
 */

import * as React from 'react';
import Link from 'next/link';
import { Badge } from '@/components/Badge';

export interface OnboardingStep {
  key: string;
  label: string;
  description: string;
  href: string;
  done: boolean;
  /**
   * Optional brand pill next to the label, e.g. "Start here" on the entry
   * step. Shown only while the step is actionable (not `done`).
   */
  pill?: string;
  /**
   * Optional muted hint under the description, e.g. "Requires an application".
   * States a soft prerequisite without disabling the row — the step stays
   * clickable and its `href` routes to the prerequisite. Shown only while the
   * step is actionable (not `done`).
   */
  hint?: string;
}

export function OnboardingChecklist({
  steps,
  storageKey,
}: {
  steps: OnboardingStep[];
  /** Per-workspace dismissal key, e.g. `rekey.onboarding.dismissed.<tenantId>`. */
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

  if (!visible || steps.length === 0) return null;

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <section
      aria-label="Get started checklist"
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">
            Get started
            <span className="ml-1.5 font-normal text-[var(--color-muted-fg)]">
              {doneCount} of {steps.length}
            </span>
          </h2>
          <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
            A few steps to get this workspace production-ready.
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

      <ol className="mt-4 space-y-1">
        {steps.map((step) => (
          <li key={step.key}>
            {step.done ? (
              <div className="flex items-baseline gap-2.5 rounded-md px-2 py-1.5">
                <CheckCircle done />
                <span className="text-sm text-[var(--color-muted-fg)] line-through decoration-[var(--color-border)]">
                  {step.label}
                </span>
              </div>
            ) : (
              <Link
                href={step.href}
                className="group flex items-baseline gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
              >
                <CheckCircle done={false} />
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--color-fg)]">{step.label}</span>
                    {step.pill && <Badge tone="brand">{step.pill}</Badge>}
                  </span>
                  <span className="block text-xs text-[var(--color-muted-fg)]">{step.description}</span>
                  {step.hint && (
                    <span className="mt-0.5 block text-xs text-[var(--color-faint-fg)]">{step.hint}</span>
                  )}
                </span>
                <span
                  aria-hidden="true"
                  className="ml-auto shrink-0 self-center text-xs text-[var(--color-faint-fg)] transition-transform group-hover:translate-x-0.5"
                >
                  →
                </span>
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function CheckCircle({ done }: { done: boolean }): React.JSX.Element {
  if (done) {
    return (
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
        className="shrink-0 self-center text-[var(--color-primary)]"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="m8.5 12.5 2.5 2.5 4.5-5.5" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="shrink-0 self-center text-[var(--color-faint-fg)]"
    >
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}
