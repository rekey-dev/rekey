'use client';

import * as React from 'react';

/**
 * Daily, weekly or monthly active users. All three charts arrive in the one
 * analytics response, so switching is local: no new request against the
 * route's per-minute budget. Each option is still a link, so without
 * JavaScript it navigates, and with it the URL is updated in place so the
 * view stays shareable.
 */
export function MetricSwitch({
  options,
  initial,
  panels,
  aside,
}: {
  options: Array<{ value: string; label: string; href: string }>;
  initial: string;
  panels: Record<string, React.ReactNode>;
  aside?: React.ReactNode;
}): React.JSX.Element {
  const [active, setActive] = React.useState(initial);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="Active users measure" className="flex flex-wrap items-center gap-1.5">
          {options.map((o) => {
            const on = o.value === active;
            return (
              <a
                key={o.value}
                href={o.href}
                aria-current={on ? 'true' : undefined}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  setActive(o.value);
                  window.history.replaceState(window.history.state, '', o.href);
                }}
                className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
                  on
                    ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] font-medium text-[var(--color-fg)]'
                    : 'border-[var(--color-border)] text-[var(--color-muted-fg)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                {o.label}
              </a>
            );
          })}
        </nav>
        {aside}
      </div>
      {panels[active]}
    </>
  );
}
