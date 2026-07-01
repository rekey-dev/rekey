'use client';

/**
 * Responsive shell for the global sidebar (WP11).
 *
 * - `md:` and up — renders the sidebar exactly as before (always visible).
 * - Below `md:` — the sidebar hides behind a hamburger in a slim top bar;
 *   tapping it opens a slide-over with a backdrop. Esc / backdrop click /
 *   route change close it, and focus returns to the hamburger trigger.
 *
 * The server-rendered <Sidebar> element is passed in as a ReactNode so the
 * server-action props (sign-out, switch-workspace) keep working unchanged.
 */

import * as React from 'react';
import { usePathname } from 'next/navigation';

export function MobileSidebar({ sidebar }: { sidebar: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const pathname = usePathname();

  // Close on navigation (link taps inside the drawer).
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Esc closes; lock body scroll while open; return focus to the trigger.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      triggerRef.current?.focus();
    };
  }, [open]);

  return (
    <>
      {/* Desktop: unchanged always-visible sidebar. */}
      <div className="hidden md:block shrink-0">{sidebar}</div>

      {/* Mobile: slim top bar with hamburger. */}
      <div className="md:hidden fixed inset-x-0 top-0 z-40 flex h-12 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
        <button
          ref={triggerRef}
          type="button"
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="mobile-sidebar"
          onClick={() => setOpen(true)}
          className="rounded-md p-1.5 text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50"
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <span className="inline-flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="" className="h-6 w-auto" />
          <span className="text-sm font-semibold text-[var(--color-fg)]">ReliPay</span>
        </span>
      </div>
      {/* Spacer so page content clears the fixed top bar on mobile. */}
      <div aria-hidden="true" className="md:hidden h-12" />

      {/* Mobile slide-over. */}
      {open && (
        <div className="md:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Navigation">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
          />
          <div
            id="mobile-sidebar"
            ref={panelRef}
            tabIndex={-1}
            className="absolute inset-y-0 left-0 flex max-w-[80vw] outline-none"
          >
            {sidebar}
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setOpen(false)}
              className="mt-3 ml-2 h-8 w-8 self-start rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-fg)] grid place-items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50"
            >
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
