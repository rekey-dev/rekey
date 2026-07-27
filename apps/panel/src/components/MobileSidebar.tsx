'use client';

/**
 * Responsive shell for the global sidebar (WP11).
 *
 * - `md:` and up — renders the sidebar exactly as before (always visible).
 * - Below `md:` — the sidebar hides behind a hamburger in a slim top bar;
 *   tapping it opens a slide-over with a backdrop. Esc / backdrop click /
 *   route change close it, and focus returns to the hamburger trigger.
 *
 * The slide-over is a native `<dialog>` opened with `showModal()` (same
 * approach as Modal/CommandPalette) so focus is contained in the drawer —
 * Tab can't escape into the inert background — and Esc-to-close is free.
 *
 * The server-rendered <Sidebar> element is passed in as a ReactNode so the
 * server-action props (sign-out, switch-workspace) keep working unchanged.
 */

import * as React from 'react';
import { usePathname } from 'next/navigation';

export function MobileSidebar({ sidebar }: { sidebar: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const dialogRef = React.useRef<HTMLDialogElement | null>(null);
  const pathname = usePathname();

  // Close on navigation (link taps inside the drawer).
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Drive the native dialog from `open`: showModal() gives us the focus trap
  // + inert background + Esc. Lock body scroll while open (the native dialog
  // makes the page inert but doesn't stop it scrolling); on close, return
  // focus to the hamburger trigger.
  React.useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        /* already-open or detached — safe to ignore */
      }
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      if (dialog?.open) dialog.close();
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
          className="rounded-md p-1.5 text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
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
          <span className="text-sm font-semibold text-[var(--color-fg)]">Rekey</span>
        </span>
      </div>
      {/* Spacer so page content clears the fixed top bar on mobile. */}
      <div aria-hidden="true" className="md:hidden h-12" />

      {/* Mobile slide-over: native <dialog> anchored to the left edge. The
          ::backdrop replaces the old hand-rolled overlay; clicks on it hit
          the dialog element itself, so target === currentTarget → close.
          Native Esc fires `cancel` → `close` → onClose syncs React state. */}
      <dialog
        id="mobile-sidebar"
        ref={dialogRef}
        aria-label="Navigation"
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpen(false);
        }}
        className="md:hidden z-50 m-0 h-full max-h-none w-auto max-w-[80vw] border-0 bg-transparent p-0 backdrop:bg-black/50 fixed inset-y-0 left-0 outline-none"
      >
        {open && (
          <div className="flex h-full">
            {sidebar}
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setOpen(false)}
              className="mt-3 ml-2 h-8 w-8 self-start rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-fg)] grid place-items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
            >
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}
      </dialog>
    </>
  );
}
