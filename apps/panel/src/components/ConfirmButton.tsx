'use client';

/**
 * Form submit with a styled confirmation dialog. Wraps a server-action form:
 *
 *   <form action={revoke}>
 *     <ConfirmButton confirm="Revoke this key? This cannot be undone.">Revoke</ConfirmButton>
 *   </form>
 *
 * The trigger opens a native `<dialog>` (top-layer, focus-trapped, Esc-to-close,
 * backdrop-click-to-dismiss). Confirm is a real `type="submit"` inside the
 * parent form, so the server action runs exactly as before — only the
 * confirmation surface changed from `window.confirm` to a styled modal that
 * matches the rest of the panel.
 *
 * For high-stakes deletes that should require typing a phrase, use
 * <TypedConfirmButton> instead.
 */

import * as React from 'react';

export function ConfirmButton({
  confirm,
  children,
  title = 'Are you sure?',
  confirmLabel,
  variant = 'danger',
}: {
  /** Body text explaining what will happen. */
  confirm: string;
  /** Trigger label (and the default confirm-button label). */
  children: React.ReactNode;
  /** Dialog heading. Defaults to "Are you sure?". */
  title?: string;
  /** Confirm-button label. Defaults to `children`. */
  confirmLabel?: React.ReactNode;
  variant?: 'danger' | 'subtle';
}): React.JSX.Element {
  const dialogRef = React.useRef<HTMLDialogElement | null>(null);
  const baseId = React.useId();
  const titleId = `${baseId}-title`;
  const descId = `${baseId}-desc`;

  const triggerCls =
    variant === 'danger'
      ? 'text-xs text-red-600 dark:text-red-400 hover:underline'
      : 'text-xs text-[var(--color-muted-fg)] hover:underline';

  const confirmCls =
    variant === 'danger'
      ? 'rounded-md bg-red-600 hover:bg-red-700 px-3 py-1.5 text-sm font-medium text-white'
      : 'rounded-md bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-3 py-1.5 text-sm font-medium text-white';

  const open = (): void => {
    try {
      dialogRef.current?.showModal();
    } catch {
      /* already open / detached — ignore */
    }
  };
  const close = (): void => dialogRef.current?.close();

  return (
    <>
      <button type="button" className={triggerCls} onClick={open}>
        {children}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 max-w-md w-full text-[var(--color-fg)] backdrop:bg-black/50"
        onClick={(e) => {
          if (e.target === dialogRef.current) close();
        }}
      >
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <p id={descId} className="mt-1 text-sm text-[var(--color-muted-fg)]">
          {confirm}
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]"
          >
            Cancel
          </button>
          {/* Real submit on the parent <form action={…}>. Close first so the
              modal layer doesn't swallow the submit, then let it propagate. */}
          <button type="submit" onClick={close} className={confirmCls}>
            {confirmLabel ?? children}
          </button>
        </div>
      </dialog>
    </>
  );
}
